import { describe, it } from "vitest";
import { createParticipantToken } from "../../src/platform/participant-auth";
import type { InternalQuestion } from "../../src/games/ionic-formula/shared/types";
import { apiRequest, createApiTestContext, createClassRoom, SETTINGS } from "../api/helpers";

const loadIt = process.env.RUN_LOAD === "1" ? it : it.skip;

describe("protocol v2 50-player load profile", () => {
  for (const gradingMode of ["immediate", "deferred"] as const) {
    loadIt(`${gradingMode}: 15 compound questions and two fields`, async () => {
      const test = createApiTestContext();
      try {
        const settings = { ...SETTINGS, questionCount: 15 as const, mode: "compound" as const,
          compoundPrompts: { formula: true, name: true }, compoundAnswer: "both" as const, gradingMode };
        const created = await createClassRoom(test, crypto.randomUUID(), settings);
        if (created.response.status !== 201) throw new Error(`create: ${created.response.status}`);
        const roomId = created.body.room.id;
        const players = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
          const token = createParticipantToken();
          const response = await test.handlers.joinRoom(apiRequest(`/api/rooms/${roomId}/join`, { method: "POST", token,
            json: { requestId: `v2-join-${index}`, nickname: `負荷${index + 1}` } }), { id: roomId });
          if (response.status !== 201) throw new Error(`join ${index}: ${response.status}`);
          return token;
        }));
        const start = await test.handlers.startRoom(apiRequest(`/api/rooms/${roomId}/start`, { method: "POST",
          json: { requestId: "v2-start-load", expectedRevision: 50 } }), { id: roomId });
        if (start.status !== 200) throw new Error(`start: ${start.status}`);
        const manifest = await (await test.handlers.manifest(apiRequest(`/api/rooms/${roomId}/manifest`, { token: players[0] }), { id: roomId })).json() as
          { manifestId: string; evaluatorVersion: string; preparationGeneration: number };
        const readyBody = { manifestId: manifest.manifestId, evaluatorVersion: manifest.evaluatorVersion,
          preparationGeneration: manifest.preparationGeneration };
        const ready = await Promise.all(players.map(token => test.handlers.ready(apiRequest(`/api/rooms/${roomId}/ready`, {
          method: "POST", token, json: readyBody,
        }), { id: roomId })));
        if (ready.some(response => response.status !== 200)) throw new Error("preparation failed");
        const room = test.database.sqlite.prepare("SELECT start_at_ms FROM rooms WHERE public_id = ?").get(roomId) as { start_at_ms: number };
        test.setNow(room.start_at_ms + 3000);
        const questions = (test.database.sqlite.prepare(`SELECT answer_snapshot_json FROM room_questions
          WHERE room_id = (SELECT id FROM rooms WHERE public_id = ?) ORDER BY ordinal`).all(roomId) as Array<{ answer_snapshot_json: string }>)
          .map(row => JSON.parse(row.answer_snapshot_json) as InternalQuestion);
        const timings: number[] = [];
        await Promise.all(players.map(async (token, playerIndex) => {
          const operations: Array<Record<string, unknown>> = [];
          let elapsedMs = 1;
          for (const question of questions) {
            if (question.answer.type !== "both") throw new Error("expected two-field question");
            for (const fieldId of ["formula", "name"] as const) {
              operations.push({ seq: operations.length + 1, operationId: `v2-${playerIndex}-${question.ordinal}-${fieldId}`,
                type: gradingMode === "immediate" ? "answer" : "draft", questionId: question.id, fieldId,
                value: question.answer[fieldId].canonical, elapsedMs, ...(gradingMode === "deferred" ? { editedElapsedMs: elapsedMs } : {}) });
              elapsedMs += 1;
            }
          }
          operations.push({ seq: operations.length + 1, operationId: `v2-${playerIndex}-finish`, type: "finish",
            reason: gradingMode === "immediate" ? "completed" : "submitted", elapsedMs });
          const begun = performance.now();
          const response = await test.handlers.operations(apiRequest(`/api/rooms/${roomId}/operations`, {
            method: "POST", token,
            json: { requestId: `v2-batch-${playerIndex}`, writerEpoch: 1,
              manifestId: manifest.manifestId, evaluatorVersion: manifest.evaluatorVersion, operations },
          }), { id: roomId });
          timings.push(performance.now() - begun);
          if (response.status !== 200) throw new Error(`operations ${playerIndex}: ${response.status} ${JSON.stringify(await response.json())}`);
        }));
        const row = test.database.sqlite.prepare(`SELECT COUNT(*) AS players, SUM(correct_count) AS score
          FROM final_results WHERE room_id = (SELECT id FROM rooms WHERE public_id = ?)`).get(roomId) as { players: number; score: number };
        if (row.players !== 50 || row.score !== 50 * 30) throw new Error(`incorrect final rows: ${JSON.stringify(row)}`);
        const sorted = timings.sort((a, b) => a - b);
        console.log(JSON.stringify({ mode: gradingMode, profile: "50 players, 15 questions, 2 fields",
          submitRequests: 50, p95SubmitMs: Number(sorted[Math.ceil(sorted.length * .95) - 1].toFixed(2)),
          d1Operations: test.database.metrics() }));
      } finally { test.close(); }
    }, 120000);
  }
});
