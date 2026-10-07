import type { ServerConfig } from "../../src/config/server";
import type { IonicFormulaGameSettings } from "../../src/games/ionic-formula/shared/types";
import type { TeacherIdentityProvider } from "../../src/platform/teacher-identity";
import { createApiHandlers, type ApiDependencies } from "../../src/platform/http";
import { createParticipantToken } from "../../src/platform/participant-auth";
import { SqliteD1 } from "../persistence/helpers";

export const ORIGIN = "https://competition.example";

export function apiRequest(
  path: string,
  init: RequestInit & { json?: unknown; token?: string } = {},
) {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    if (!headers.has("origin")) headers.set("origin", ORIGIN);
    headers.set("x-competition-csrf", "1");
  }
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  return new Request(`${ORIGIN}${path}`, {
    ...init,
    headers,
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
}

export function createApiTestContext(options: {
  teacher?: { id: string; email: string } | null;
  allowedEmails?: readonly string[];
  nowMs?: number;
} = {}) {
  const database = new SqliteD1();
  let nowMs = options.nowMs ?? 1_000;
  let randomState = 0x1234_5678;
  database.setNow(nowMs);
  const teacherIdentity: TeacherIdentityProvider = {
    getVerifiedIdentity: async () => options.teacher === undefined
      ? { id: "teacher-1", email: "TEACHER@example.com" }
      : options.teacher,
  };
  const serverConfig: ServerConfig = {
    teacherAllowedEmails: options.allowedEmails ?? ["teacher@example.com"],
  };
  const dependencies: ApiDependencies = {
    database,
    teacherIdentity,
    serverConfig,
    now: () => nowMs,
    random: () => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
      return randomState / 0x1_0000_0000;
    },
    randomUUID: () => crypto.randomUUID(),
  };
  return {
    database,
    dependencies,
    handlers: createApiHandlers(dependencies),
    setNow(value: number) {
      nowMs = value;
      database.setNow(value);
    },
    close() { database.close(); },
  };
}

export const SETTINGS = {
  questionCount: 5,
  timeLimitMinutes: 3,
  mode: "ion",
  difficulty: "normal",
  ionAnswer: "formula",
  compoundPrompts: { formula: true, name: false },
  compoundAnswer: "formula",
} as const;

export async function createClassRoom(
  context: ReturnType<typeof createApiTestContext>,
  requestId = crypto.randomUUID(),
  settings: IonicFormulaGameSettings = SETTINGS,
) {
  const response = await context.handlers.createClassRoom(apiRequest("/api/class-rooms", {
    method: "POST",
    json: { requestId, settings },
  }));
  const body = await response.json() as { room: { id: string; revision: number } };
  return { response, body };
}

export async function joinClassRoom(
  context: ReturnType<typeof createApiTestContext>,
  roomId: string,
  nickname = "参加者",
) {
  const token = createParticipantToken();
  const response = await context.handlers.joinRoom(
    apiRequest(`/api/rooms/${roomId}/join`, {
      method: "POST",
      token,
      json: { requestId: crypto.randomUUID(), nickname },
    }),
    { id: roomId },
  );
  return { token, response, body: await response.json() as { participant: { id: string } } };
}

export async function createMateRoom(
  context: ReturnType<typeof createApiTestContext>,
  options: {
    requestId?: string;
    creationKey?: string;
    token?: string;
    nickname?: string;
    settings?: IonicFormulaGameSettings;
  } = {},
) {
  const requestId = options.requestId ?? crypto.randomUUID();
  const creationKey = options.creationKey ?? createParticipantToken();
  const token = options.token ?? createParticipantToken();
  const nickname = options.nickname ?? "ホスト";
  const response = await context.handlers.createMateRoom(apiRequest("/api/mate-rooms", {
    method: "POST",
    token,
    headers: { "x-creation-key": creationKey },
    json: { requestId, nickname, settings: options.settings ?? SETTINGS },
  }));
  return {
    requestId,
    creationKey,
    token,
    response,
    body: await response.json() as { room: { id: string }; participant: { id: string } },
  };
}

export async function startAndFinishByPassing(
  context: ReturnType<typeof createApiTestContext>,
  roomId: string,
  token: string,
  expectedRoomRevision = 1,
) {
  const start = await context.handlers.startRoom(apiRequest(`/api/rooms/${roomId}/start`, {
    method: "POST",
    json: { requestId: crypto.randomUUID(), expectedRevision: expectedRoomRevision },
  }), { id: roomId });
  const started = await start.json() as { startAtMs: number };
  context.setNow(started.startAtMs + 1);
  let lastAction: Record<string, unknown> | null = null;
  for (let index = 0; index < SETTINGS.questionCount; index += 1) {
    const stateResponse = await context.handlers.state(
      apiRequest(`/api/rooms/${roomId}/state`, { token }),
      { id: roomId },
    );
    const state = await stateResponse.json() as { participant: { revision: number }; question: { id: string } };
    const actionResponse = await context.handlers.actions(apiRequest(`/api/rooms/${roomId}/actions`, {
      method: "POST",
      token,
      json: {
        requestId: crypto.randomUUID(),
        questionId: state.question.id,
        expectedParticipantRevision: state.participant.revision,
        clientElapsedMs: index + 1,
        action: { type: "pass", fieldId: "formula" },
      },
    }), { id: roomId });
    lastAction = await actionResponse.json() as Record<string, unknown>;
  }
  return lastAction;
}
