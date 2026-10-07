import { describe, it } from "vitest";

import { createParticipantToken } from "../../src/platform/participant-auth";
import type { InternalQuestion } from "../../src/games/ionic-formula/shared/types";
import {
  SETTINGS,
  apiRequest,
  createApiTestContext,
  createClassRoom,
  createMateRoom,
} from "../api/helpers";

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

const loadIt = process.env.RUN_LOAD === "1" ? it : it.skip;

describe("50-player class competition load profile", () => {
loadIt("completes 15 compound questions with both answer fields", async () => {
  const players = 50;
  const questionCount = 15;
  const answer = "both";
  const test = createApiTestContext();
  const latenciesMs: number[] = [];
  let serverErrors = 0;
  let unhandledCompetitionErrors = 0;

  try {
  const settings = {
    ...SETTINGS,
    questionCount: 15 as const,
    mode: "compound" as const,
    compoundPrompts: { formula: true, name: true },
    compoundAnswer: "both" as const,
  };
  const created = await createClassRoom(test, crypto.randomUUID(), settings);
  if (created.response.status !== 201) throw new Error(`class creation failed: ${created.response.status}`);
  const roomId = created.body.room.id;

  const participants = await Promise.all(Array.from({ length: players }, async (_, index) => {
    const token = createParticipantToken();
    const response = await test.handlers.joinRoom(apiRequest(`/api/rooms/${roomId}/join`, {
      method: "POST",
      token,
      json: { requestId: `join-${index}`, nickname: `負荷${String(index + 1).padStart(2, "0")}` },
    }), { id: roomId });
    if (response.status >= 500) serverErrors += 1;
    if (response.status !== 201) throw new Error(`participant ${index} join failed: ${response.status}`);
    return { token, body: await json(response) };
  }));

  const overflow = await test.handlers.joinRoom(apiRequest(`/api/rooms/${roomId}/join`, {
    method: "POST",
    token: createParticipantToken(),
    json: { requestId: "join-overflow", nickname: "43人目" },
  }), { id: roomId });
  if (overflow.status !== 409) throw new Error(`43rd participant was not rejected: ${overflow.status}`);

  const start = await test.handlers.startRoom(apiRequest(`/api/rooms/${roomId}/start`, {
    method: "POST",
    json: { requestId: "start-load", expectedRevision: players },
  }), { id: roomId });
  if (start.status !== 200) throw new Error(`start failed: ${start.status}`);
  const schedule = await json(start);
  test.setNow(schedule.startAtMs + 1);

  const questionRows = test.database.sqlite.prepare(`
    SELECT question_id, answer_snapshot_json FROM room_questions ORDER BY ordinal
  `).all() as Array<{ question_id: string; answer_snapshot_json: string }>;
  const answers = new Map(questionRows.map((row) => {
    const question = JSON.parse(row.answer_snapshot_json) as InternalQuestion;
    if (question.answer.type !== "both") throw new Error("load question does not have both answer fields");
    return [row.question_id, {
      formula: question.answer.formula.canonical,
      name: question.answer.name.canonical,
    }];
  }));

  await Promise.all(participants.map(async ({ token }, playerIndex) => {
    for (let ordinal = 0; ordinal < questionCount; ordinal += 1) {
      for (const fieldId of ["formula", "name"] as const) {
        const stateResponse = await test.handlers.state(apiRequest(`/api/rooms/${roomId}/state`, { token }), { id: roomId });
        if (stateResponse.status >= 500) serverErrors += 1;
        if (stateResponse.status !== 200) {
          unhandledCompetitionErrors += 1;
          throw new Error(`state failed for player ${playerIndex}: ${stateResponse.status}`);
        }
        const state = await json(stateResponse);
        const expected = answers.get(state.question.id)?.[fieldId];
        if (!expected) throw new Error(`missing ${fieldId} answer for ${state.question.id}`);
        const startedAt = performance.now();
        const actionResponse = await test.handlers.actions(apiRequest(`/api/rooms/${roomId}/actions`, {
          method: "POST",
          token,
          json: {
            requestId: `answer-${playerIndex}-${ordinal}-${fieldId}`,
            questionId: state.question.id,
            expectedParticipantRevision: state.participant.revision,
            clientElapsedMs: ordinal * 100 + (fieldId === "formula" ? 1 : 2),
            action: { type: "answer", fieldId, value: expected },
          },
        }), { id: roomId });
        latenciesMs.push(performance.now() - startedAt);
        if (actionResponse.status >= 500) serverErrors += 1;
        if (actionResponse.status !== 200) {
          unhandledCompetitionErrors += 1;
          throw new Error(`action failed for player ${playerIndex}/${ordinal}/${fieldId}: ${actionResponse.status} ${JSON.stringify(await json(actionResponse))}`);
        }
        const actionResult = await json(actionResponse);
        if (actionResult.correct !== true) throw new Error(`canonical ${fieldId} answer was rejected`);
      }
    }
  }));

  const mate = await createMateRoom(test, { creationKey: createParticipantToken(), nickname: "ホスト" });
  if (mate.response.status !== 201) throw new Error(`mate creation failed: ${mate.response.status}`);
  const mateAttempts = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const response = await test.handlers.joinRoom(apiRequest(`/api/rooms/${mate.body.room.id}/join`, {
      method: "POST",
      token: createParticipantToken(),
      json: { requestId: `mate-join-${index}`, nickname: `メイト${index}` },
    }), { id: mate.body.room.id });
    return response.status;
  }));
  if (mateAttempts.filter((status) => status === 201).length !== 3 || mateAttempts.filter((status) => status === 409).length !== 1) {
    throw new Error(`mate capacity mismatch: ${mateAttempts.join(",")}`);
  }

  const summary = test.database.sqlite.prepare(`
    SELECT COUNT(*) AS participants,
      SUM(CASE WHEN correct_count = 30 THEN 1 ELSE 0 END) AS full_scores,
      SUM(CASE WHEN status = 'FINISHED' THEN 1 ELSE 0 END) AS finished
    FROM participants WHERE room_id = (SELECT id FROM rooms WHERE public_id = ?)
  `).get(roomId) as { participants: number; full_scores: number; finished: number };
  const correctFields = test.database.sqlite.prepare(`
    SELECT COUNT(*) AS count FROM participant_fields
    WHERE room_id = (SELECT id FROM rooms WHERE public_id = ?) AND state = 'correct'
  `).get(roomId) as { count: number };
  const room = test.database.sqlite.prepare("SELECT state FROM rooms WHERE public_id = ?").get(roomId) as { state: string };
  if (JSON.stringify(summary) !== JSON.stringify({ participants: 50, full_scores: 50, finished: 50 })) {
    throw new Error(`participant invariant failed: ${JSON.stringify(summary)}`);
  }
  if (correctFields.count !== 50 * 15 * 2) throw new Error(`field invariant failed: ${correctFields.count}`);
  if (room.state !== "FINISHED") throw new Error(`room not finalized: ${room.state}`);
  if (serverErrors !== 0 || unhandledCompetitionErrors !== 0) {
    throw new Error(`unexpected errors: 5xx=${serverErrors}, competition=${unhandledCompetitionErrors}`);
  }

  const metrics = test.database.metrics();
  console.log(JSON.stringify({
    profile: { players, questions: questionCount, answer },
    correctness: { serverErrors, unhandledCompetitionErrors, ...summary, correctFields: correctFields.count },
    latencyMs: { samples: latenciesMs.length, p95: Number(percentile95(latenciesMs).toFixed(2)) },
    d1Operations: metrics,
    limitation: "Local SQLite/D1-compatible harness; not production Sites or remote D1 evidence",
  }, null, 2));
  } finally {
    test.close();
  }
});
});
