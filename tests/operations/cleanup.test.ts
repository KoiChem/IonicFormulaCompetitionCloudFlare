import { afterEach, describe, expect, it } from "vitest";

import { createApiHandlers } from "../../src/platform/http";
import { PUBLIC_CONFIG } from "../../src/config/public";
import { cleanupExpired } from "../../src/persistence/cleanup";
import { createRoom } from "../../src/persistence/rooms";
import {
  apiRequest,
  createApiTestContext,
  createClassRoom,
  joinClassRoom,
  startAndFinishByPassing,
} from "../api/helpers";
import { SqliteD1, classRoomInput, scalar } from "../persistence/helpers";

const databases: SqliteD1[] = [];
const contexts: ReturnType<typeof createApiTestContext>[] = [];

afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
  contexts.splice(0).forEach((context) => context.close());
});

describe("bounded expiry cleanup", () => {
  it("bounds room and site-setting receipt deletion independently", async () => {
    const database = new SqliteD1();
    databases.push(database);
    for (let index = 0; index < 3; index += 1) {
      await createRoom(database, classRoomInput({
        roomId: `expired-${index}`,
        publicId: `expired-public-${index}`,
        joinCode: `EXP00${index}`,
        actorKeyHash: `teacher-${index}`,
        requestId: `create-${index}`,
        expiresAtMs: 2_000,
      }));
      database.sqlite.prepare(`
        INSERT INTO site_setting_receipts
          (teacher_id, request_id, body_hash, result_json, processed_at_ms, expires_at_ms)
        VALUES (?, ?, 'body', '{}', 1, 2000)
      `).run(`teacher-${index}`, `setting-${index}`);
    }
    database.sqlite.prepare(`
      INSERT INTO site_setting_receipts
        (teacher_id, request_id, body_hash, result_json, processed_at_ms, expires_at_ms)
      VALUES ('live', 'live', 'body', '{}', 1, 4000)
    `).run();

    expect(await cleanupExpired(database, { nowMs: 3_000, limit: 2 }))
      .toEqual({ deletedRooms: 2, deletedSiteSettingReceipts: 2 });
    expect(await scalar(database, "SELECT COUNT(*) FROM rooms WHERE expires_at_ms <= 3000")).toBe(1);
    expect(await scalar(database, "SELECT COUNT(*) FROM site_setting_receipts WHERE expires_at_ms <= 3000")).toBe(1);

    expect(await cleanupExpired(database, { nowMs: 3_000, limit: 2 }))
      .toEqual({ deletedRooms: 1, deletedSiteSettingReceipts: 1 });
    expect(await scalar(database, "SELECT COUNT(*) FROM site_setting_receipts")).toBe(1);
  });

  it("keeps a class result until one millisecond before seven days, then rejects and purges it", async () => {
    const test = createApiTestContext();
    contexts.push(test);
    const created = await createClassRoom(test);
    const joined = await joinClassRoom(test, created.body.room.id);
    await startAndFinishByPassing(test, created.body.room.id, joined.token);
    const stored = test.database.sqlite.prepare(
      "SELECT id, ended_at_ms, expires_at_ms FROM rooms WHERE public_id = ?",
    ).get(created.body.room.id) as { id: string; ended_at_ms: number; expires_at_ms: number };
    expect(stored.expires_at_ms - stored.ended_at_ms).toBe(PUBLIC_CONFIG.retentionMs.classCompetition);

    test.setNow(stored.expires_at_ms - 1);
    expect((await test.handlers.results(
      apiRequest(`/api/rooms/${created.body.room.id}/results`, { token: joined.token }),
      { id: created.body.room.id },
    )).status).toBe(200);

    test.setNow(stored.expires_at_ms);
    expect((await test.handlers.state(
      apiRequest(`/api/rooms/${created.body.room.id}/state`, { token: joined.token }),
      { id: created.body.room.id },
    )).status).toBe(410);
    for (const table of [
      "rooms", "participants", "room_questions", "participant_fields",
      "command_receipts", "operation_attempts", "creation_receipts", "final_results",
    ]) {
      expect(await scalar(test.database, `SELECT COUNT(*) FROM ${table}`), table).toBe(0);
    }
  });

  it("runs bounded cleanup from creation, state, and teacher-screen request paths", async () => {
    const test = createApiTestContext();
    contexts.push(test);

    const first = await createClassRoom(test);
    test.database.sqlite.prepare("UPDATE rooms SET expires_at_ms = 1001 WHERE public_id = ?")
      .run(first.body.room.id);
    test.setNow(1_001);
    await createClassRoom(test);
    expect(test.database.sqlite.prepare("SELECT COUNT(*) AS count FROM rooms WHERE public_id = ?")
      .get(first.body.room.id)).toEqual({ count: 0 });

    const live = await createClassRoom(test);
    await createRoom(test.database, classRoomInput({
      roomId: "state-expired",
      publicId: "state-expired-public",
      joinCode: "EXP234",
      actorKeyHash: "expired-state-owner",
      requestId: "expired-state-create",
      expiresAtMs: 1_001,
    }));
    expect((await test.handlers.state(
      apiRequest(`/api/rooms/${live.body.room.id}/state`),
      { id: live.body.room.id },
    )).status).toBe(200);
    expect(await scalar(test.database, "SELECT COUNT(*) FROM rooms WHERE id = 'state-expired'")).toBe(0);

    test.database.sqlite.prepare(`
      INSERT INTO site_setting_receipts
        (teacher_id, request_id, body_hash, result_json, processed_at_ms, expires_at_ms)
      VALUES ('teacher-1', 'expired-setting', 'body', '{}', 1, 1001)
    `).run();
    expect((await test.handlers.teacherSiteSettings(apiRequest("/api/teacher/site-settings"))).status).toBe(200);
    expect(await scalar(test.database, "SELECT COUNT(*) FROM site_setting_receipts WHERE request_id = 'expired-setting'"))
      .toBe(0);
  });

  it("keeps site-settings mutation cleanup bounded", async () => {
    const test = createApiTestContext();
    contexts.push(test);
    for (let index = 0; index < 30; index += 1) {
      test.database.sqlite.prepare(`
        INSERT INTO site_setting_receipts
          (teacher_id, request_id, body_hash, result_json, processed_at_ms, expires_at_ms)
        VALUES (?, ?, 'body', '{}', 1, 1000)
      `).run(`old-${index}`, `old-${index}`);
    }
    test.setNow(1_001);
    const handlers = createApiHandlers({ ...test.dependencies, serverConfig: { teacherAllowedEmails: ["teacher@example.com"], masterTeacherEmail: "teacher@example.com" } });
    const response = await handlers.teacherSiteSettings(apiRequest("/api/teacher/site-settings", {
      method: "POST",
      json: { requestId: "bounded-settings", enabled: false, expectedRevision: 0 },
    }));
    expect(response.status).toBe(200);
    expect(await scalar(test.database, "SELECT COUNT(*) FROM site_setting_receipts WHERE expires_at_ms <= 1001"))
      .toBe(5);
  });
});
