import { afterEach, describe, expect, it } from "vitest";

import { createApiHandlers } from "../../src/platform/http";
import { createParticipantToken, hashParticipantToken } from "../../src/platform/participant-auth";
import { requireTeacher, unavailableTeacherIdentityProvider } from "../../src/platform/teacher-identity";
import { apiRequest, createApiTestContext, createClassRoom, joinClassRoom, SETTINGS } from "./helpers";

const contexts: ReturnType<typeof createApiTestContext>[] = [];
afterEach(() => contexts.splice(0).forEach((context) => context.close()));

function context(options: Parameters<typeof createApiTestContext>[0] = {}) {
  const value = createApiTestContext(options);
  contexts.push(value);
  return value;
}

describe("teacher authorization", () => {
  it("does not trust client-supplied Sites identity headers without a verified adapter", async () => {
    const request = apiRequest("/api/class-rooms", {
      headers: {
        "oai-authenticated-user-id": "forged-teacher",
        "oai-authenticated-user-email": "teacher@example.com",
      },
    });
    await expect(requireTeacher(request, unavailableTeacherIdentityProvider, ["teacher@example.com"]))
      .rejects.toMatchObject({ status: 503, code: "identity_unavailable" });
  });

  it("returns 401 when no verified Sites identity exists", async () => {
    const test = context({ teacher: null });
    const response = await test.handlers.createClassRoom(apiRequest("/api/class-rooms", {
      method: "POST",
      json: { requestId: crypto.randomUUID(), settings: SETTINGS },
    }));
    expect(response.status).toBe(401);
  });

  it("returns 403 when a verified email is outside the normalized allowlist", async () => {
    const test = context({ teacher: { id: "teacher-1", email: "outsider@example.com" } });
    const response = await test.handlers.createClassRoom(apiRequest("/api/class-rooms", {
      method: "POST",
      json: { requestId: crypto.randomUUID(), settings: SETTINGS },
    }));
    expect(response.status).toBe(403);
  });

  it("normalizes the verified email before allowlist comparison", async () => {
    const test = context({ teacher: { id: "teacher-1", email: " Teacher@Example.COM " } });
    const response = await test.handlers.createClassRoom(apiRequest("/api/class-rooms", {
      method: "POST",
      json: { requestId: crypto.randomUUID(), settings: SETTINGS },
    }));
    expect(response.status).toBe(201);
  });

  it("forbids an allowed teacher from mutating another teacher's room", async () => {
    const owner = context();
    const { body } = await createClassRoom(owner);
    const otherHandlers = createApiHandlers({
      ...owner.dependencies,
      teacherIdentity: { getVerifiedIdentity: async () => ({ id: "teacher-2", email: "teacher2@example.com" }) },
      serverConfig: { teacherAllowedEmails: ["teacher2@example.com"] },
    });
    const response = await otherHandlers.updateRoomSettings(
      apiRequest(`/api/rooms/${body.room.id}/settings`, {
        method: "PATCH",
        json: { requestId: crypto.randomUUID(), expectedRevision: 0, settings: SETTINGS },
      }),
      { id: body.room.id },
    );
    expect(response.status).toBe(403);
  });
});

describe("participant authorization and request protections", () => {
  it("does not accept a participant id without its bearer token", async () => {
    const test = context();
    const { body } = await createClassRoom(test);
    const joined = await joinClassRoom(test, body.room.id);
    const response = await test.handlers.actions(
      apiRequest(`/api/rooms/${body.room.id}/actions`, {
        method: "POST",
        json: {
          participantId: joined.body.participant.id,
          requestId: crypto.randomUUID(),
          questionId: "question-1",
          expectedParticipantRevision: 0,
          clientElapsedMs: 1,
          action: { type: "pass", fieldId: "formula" },
        },
      }),
      { id: body.room.id },
    );
    expect(response.status).toBe(401);
  });

  it("rejects another participant's bearer token", async () => {
    const test = context();
    const { body } = await createClassRoom(test);
    const joined = await joinClassRoom(test, body.room.id);
    const otherToken = createParticipantToken();
    const response = await test.handlers.state(
      apiRequest(`/api/rooms/${body.room.id}/state`, {
        token: otherToken,
        headers: { "x-participant-id": joined.body.participant.id },
      }),
      { id: body.room.id },
    );
    expect(response.status).toBe(403);
  });

  it("stores only the SHA-256 participant token hash", async () => {
    const test = context();
    const { body } = await createClassRoom(test);
    const joined = await joinClassRoom(test, body.room.id);
    const stored = test.database.sqlite.prepare("SELECT token_hash FROM participants WHERE id = ?")
      .get(joined.body.participant.id) as { token_hash: string };
    expect(stored.token_hash).toBe(await hashParticipantToken(joined.token));
    expect(stored.token_hash).not.toContain(joined.token);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects cross-origin mutations", async () => {
    const test = context();
    const request = apiRequest("/api/class-rooms", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      json: { requestId: crypto.randomUUID(), settings: SETTINGS },
    });
    expect((await test.handlers.createClassRoom(request)).status).toBe(403);
  });

  it("requires JSON, a CSRF header, and a body no larger than 4 KiB", async () => {
    const test = context();
    const noCsrf = new Request("https://competition.example/api/class-rooms", {
      method: "POST",
      headers: { origin: "https://competition.example", "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), settings: SETTINGS }),
    });
    expect((await test.handlers.createClassRoom(noCsrf)).status).toBe(403);

    const wrongType = new Request("https://competition.example/api/class-rooms", {
      method: "POST",
      headers: { origin: "https://competition.example", "x-competition-csrf": "1", "content-type": "text/plain" },
      body: "{}",
    });
    expect((await test.handlers.createClassRoom(wrongType)).status).toBe(415);

    const tooLarge = apiRequest("/api/class-rooms", {
      method: "POST",
      json: { requestId: crypto.randomUUID(), settings: SETTINGS, padding: "x".repeat(4_096) },
    });
    expect((await test.handlers.createClassRoom(tooLarge)).status).toBe(413);
  });
});
