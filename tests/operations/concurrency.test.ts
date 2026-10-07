import { afterEach, describe, expect, it } from "vitest";

import { applyPlayerAction } from "../../src/persistence/actions";
import type { PersistenceDatabase, PreparedSql } from "../../src/persistence/db";
import { finalizeRoom } from "../../src/persistence/results";
import { createRoom, startRoom } from "../../src/persistence/rooms";
import { joinRoom } from "../../src/persistence/participants";
import { updateSiteSettingsCommand } from "../../src/persistence/settings";
import {
  SETTINGS,
  apiRequest,
  createApiTestContext,
  createClassRoom,
  joinClassRoom,
} from "../api/helpers";
import { QUESTION, SqliteD1, classRoomInput, joinInput, mateRoomInput, scalar } from "../persistence/helpers";

const databases: SqliteD1[] = [];
const contexts: ReturnType<typeof createApiTestContext>[] = [];
afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
  contexts.splice(0).forEach((context) => context.close());
});

describe("completion and deadline races", () => {
  it("returns the committed last action while other participants are still running", async () => {
    const test = createApiTestContext();
    contexts.push(test);
    const created = await createClassRoom(test, crypto.randomUUID(), { ...SETTINGS, questionCount: 5 });
    const first = await joinClassRoom(test, created.body.room.id, "先着");
    await joinClassRoom(test, created.body.room.id, "継続中");
    const start = await test.handlers.startRoom(apiRequest(`/api/rooms/${created.body.room.id}/start`, {
      method: "POST",
      json: { requestId: crypto.randomUUID(), expectedRevision: 2 },
    }), { id: created.body.room.id });
    const schedule = await start.json() as { startAtMs: number };
    test.setNow(schedule.startAtMs + 1);

    let finalResponse: Response | null = null;
    for (let ordinal = 0; ordinal < 5; ordinal += 1) {
      const state = await test.handlers.state(apiRequest(`/api/rooms/${created.body.room.id}/state`, {
        token: first.token,
      }), { id: created.body.room.id });
      const current = await state.json() as { participant: { revision: number }; question: { id: string } };
      finalResponse = await test.handlers.actions(apiRequest(`/api/rooms/${created.body.room.id}/actions`, {
        method: "POST",
        token: first.token,
        json: {
          requestId: `pass-${ordinal}`,
          questionId: current.question.id,
          expectedParticipantRevision: current.participant.revision,
          clientElapsedMs: ordinal + 1,
          action: { type: "pass", fieldId: "formula" },
        },
      }), { id: created.body.room.id });
    }

    expect(finalResponse?.status).toBe(200);
    expect(await finalResponse?.json()).toMatchObject({ code: "accepted", finished: true });
    expect(test.database.sqlite.prepare("SELECT state FROM rooms").get()).toEqual({ state: "COUNTDOWN" });
  });

  it("preserves a mate-disabled diagnostic across a concurrent disable-enable change", async () => {
    const inner = new SqliteD1();
    databases.push(inner);
    await updateSiteSettingsCommand(inner, {
      teacherId: "teacher", requestId: "initial", bodyHash: "initial",
      expectedRevision: 0, enabled: true, nowMs: 1_000,
    });
    let changed = false;
    const database: PersistenceDatabase = {
      prepare(query: string): PreparedSql { return inner.prepare(query); },
      async batch(statements: readonly PreparedSql[]) {
        if (!changed) {
          changed = true;
          inner.sqlite.prepare("UPDATE site_settings SET mate_match_enabled = 0, revision = revision + 1").run();
          const result = await inner.batch(statements as Parameters<SqliteD1["batch"]>[0]);
          inner.sqlite.prepare("UPDATE site_settings SET mate_match_enabled = 1, revision = revision + 1").run();
          return result;
        }
        return inner.batch(statements as Parameters<SqliteD1["batch"]>[0]);
      },
    };

    await expect(createRoom(database, mateRoomInput({
      requestId: "concurrent-setting",
      bodyHash: "concurrent-setting",
    }))).rejects.toMatchObject({ code: "mate_disabled", status: 403 });
    expect(await scalar(inner, "SELECT COUNT(*) FROM rooms")).toBe(0);
  });

  it("repeats the last-answer versus deadline finalization race without partial state", async () => {
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const database = new SqliteD1();
      databases.push(database);
      await createRoom(database, classRoomInput({
        roomId: `room-${iteration}`,
        publicId: `public-${iteration}`,
        joinCode: `RAC${String(iteration).padStart(3, "0")}`,
        actorKeyHash: `teacher-${iteration}`,
        requestId: `create-${iteration}`,
      }));
      await joinRoom(database, joinInput(0, { roomId: `room-${iteration}` }));
      await startRoom(database, {
        roomId: `room-${iteration}`,
        requestId: "start",
        bodyHash: "start",
        expectedRoomRevision: 1,
        nowMs: 2_000,
        startAtMs: 3_000,
        deadlineAtMs: 4_000,
        questions: [QUESTION],
      });
      database.setNow(3_999);
      const barrier = database.pauseNextBatch();
      const action = applyPlayerAction(database, {
        roomId: `room-${iteration}`,
        participantId: "p-0",
        requestId: "last-answer",
        bodyHash: "last-answer",
        questionId: QUESTION.id,
        expectedParticipantRevision: 0,
        clientElapsedMs: 999,
        serverNowMs: 3_999,
        action: { type: "answer", fieldId: "formula", value: "Na+" },
      });
      await barrier.reached;
      database.setNow(4_000);
      const finalization = finalizeRoom(database, {
        roomId: `room-${iteration}`,
        requestId: "deadline",
        bodyHash: "deadline",
        nowMs: 4_000,
      });
      barrier.release();
      await Promise.allSettled([action, finalization]);

      expect(await scalar(database, "SELECT COUNT(*) FROM final_results")).toBe(1);
      expect(await scalar(database, "SELECT COUNT(*) FROM command_receipts WHERE request_id IN ('last-answer', 'deadline')"))
        .toBeGreaterThanOrEqual(1);
      expect(await scalar(database, "SELECT correct_count FROM participants WHERE id = 'p-0'"))
        .toBe(await scalar(database, "SELECT correct_count FROM final_results WHERE participant_id = 'p-0'"));
    }
  });
});
