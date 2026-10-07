import { afterEach, describe, expect, it } from "vitest";
import { apiRequest, createApiTestContext, SETTINGS } from "./helpers";
import { createApiHandlers } from "../../src/platform/http";

const contexts: ReturnType<typeof createApiTestContext>[] = [];
function setup() {
  const context = createApiTestContext(); contexts.push(context);
  let identity: { id: string; email: string } | null = { id: "master", email: "MASTER@example.com" };
  const api = createApiHandlers({ ...context.dependencies, serverConfig: { masterTeacherEmail: "master@example.com", teacherAllowedEmails: ["teacher@example.com"] }, teacherIdentity: { getVerifiedIdentity: async () => identity } });
  const change = (email: string, enabled: boolean, expectedRevision: number, requestId = crypto.randomUUID()) => api.teacherAllowlist(apiRequest("/api/teacher/allowlist", { method: "POST", json: { email, enabled, expectedRevision, requestId } }));
  return { context, api, change, as: (value: typeof identity) => { identity = value; } };
}
afterEach(() => { for (const context of contexts.splice(0)) context.close(); });
describe("master teacher allowlist", () => {
  it("requires verified master identity and hides addresses from ordinary teachers", async () => {
    const s = setup();
    s.as(null); expect((await s.api.teacherAllowlist(apiRequest("/api/teacher/allowlist"))).status).toBe(401);
    s.as({ id: "other", email: "teacher@example.com" });
    expect((await s.api.teacherAllowlist(apiRequest("/api/teacher/allowlist", { headers: { "x-user-email": "master@example.com" } }))).status).toBe(403);
    expect((await s.api.teacherSession(apiRequest("/api/teacher/session"))).status).toBe(403);
  });
  it("grants normalized emails, then revokes access including owned rooms", async () => {
    const s = setup(); expect((await s.change(" Teacher@Example.com ", true, 0)).status).toBe(200);
    s.as({ id: "teacher-1", email: "teacher@example.com" });
    const session = await s.api.teacherSession(apiRequest("/api/teacher/session")); expect(await session.json()).toEqual({ role: "teacher", email: "teacher@example.com" });
    const created = await s.api.createClassRoom(apiRequest("/api/class-rooms", { method: "POST", json: { requestId: crypto.randomUUID(), settings: SETTINGS } }));
    expect(created.status).toBe(201); const body = await created.json() as { room: { id: string } };
    s.as({ id: "master", email: "master@example.com" }); expect((await s.change("teacher@example.com", false, 1)).status).toBe(200);
    s.as({ id: "teacher-1", email: "teacher@example.com" });
    expect((await s.api.state(apiRequest(`/api/rooms/${body.room.id}/state`), { id: body.room.id })).status).toBe(403);
    expect((await s.api.teacherSession(apiRequest("/api/teacher/session"))).status).toBe(403);
  });
  it("rejects stale concurrent edits and safely handles retry without overwriting newer changes", async () => {
    const s = setup(); const key = crypto.randomUUID();
    expect((await s.change("a@example.com", true, 0, key)).status).toBe(200);
    expect((await s.change("a@example.com", true, 0, key)).status).toBe(200);
    expect((await s.change("b@example.com", true, 0)).status).toBe(409);
    expect((await s.change("b@example.com", true, 1, key)).status).toBe(409);
    expect((await s.change("b@example.com", true, 1)).status).toBe(200);
    expect((await s.change("a@example.com", true, 0, key)).status).toBe(409);
    const list = await s.api.teacherAllowlist(apiRequest("/api/teacher/allowlist")); expect((await list.json() as { emails: string[] }).emails).toEqual(["a@example.com", "b@example.com"]);
  });
  it("rejects invalid email, master edits and cross-origin mutations", async () => {
    const s = setup();
    expect((await s.change("bad", true, 0)).status).toBe(400);
    expect((await s.change("master@example.com", false, 0)).status).toBe(400);
    expect((await s.api.teacherAllowlist(apiRequest("/api/teacher/allowlist", { method: "POST", headers: { origin: "https://evil.example" }, json: { email: "a@example.com", enabled: true, expectedRevision: 0, requestId: crypto.randomUUID() } }))).status).toBe(403);
    const responses = await Promise.all([s.change("a@example.com", true, 0), s.change("b@example.com", true, 0)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  });
});

describe("mate creation setting authority", () => {
  it("allows master to change the setting and rejects ordinary teachers", async () => {
    const context = createApiTestContext(); contexts.push(context);
    let email = "teacher@example.com";
    const api = createApiHandlers({ ...context.dependencies,
      serverConfig: { teacherAllowedEmails: [], masterTeacherEmail: "master@example.com" },
      teacherIdentity: { getVerifiedIdentity: async () => ({ id: email, email }) },
    });
    email = "master@example.com";
    const granted = await api.teacherAllowlist(apiRequest("/api/teacher/allowlist", { method: "POST", json: { email: "teacher@example.com", enabled: true, expectedRevision: 0, requestId: crypto.randomUUID() } }));
    expect(granted.status).toBe(200);
    email = "teacher@example.com";
    expect((await api.teacherSiteSettings(apiRequest("/api/teacher/site-settings", { method: "PATCH", json: { enabled: false, expectedRevision: 0, requestId: crypto.randomUUID() } }))).status).toBe(403);
    email = "master@example.com";
    const changed = await api.teacherSiteSettings(apiRequest("/api/teacher/site-settings", { method: "PATCH", json: { enabled: false, expectedRevision: 0, requestId: crypto.randomUUID() } }));
    expect(changed.status).toBe(200);
    expect((await changed.json() as { enabled: boolean }).enabled).toBe(false);
  });
});
