import { afterEach, expect, it } from "vitest";
import { apiRequest, createApiTestContext, createClassRoom, joinClassRoom } from "./helpers";

const contexts: ReturnType<typeof createApiTestContext>[] = [];
afterEach(() => contexts.splice(0).forEach(value => value.close()));

it("exposes only an authorized, minimal finalized result summary", async () => {
  const test = createApiTestContext(); contexts.push(test);
  const room = await createClassRoom(test);
  const id = room.body.room.id;
  const joined = await joinClassRoom(test, id);
  const summary = (token?: string) => test.handlers.resultSummary(apiRequest(`/api/rooms/${id}/result-summary`, token ? { token } : {}), { id });
  expect((await summary(joined.token)).status).toBe(409);
  const start = await test.handlers.startRoom(apiRequest(`/api/rooms/${id}/start`, { method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 1 } }), { id });
  const schedule = await start.json() as { startAtMs: number };
  test.setNow(schedule.startAtMs + 1_000);
  const interrupted = await test.handlers.interruptRoom(apiRequest(`/api/rooms/${id}/interrupt`, { method: "POST", json: { requestId: crypto.randomUUID(), expectedRevision: 2 } }), { id });
  expect(interrupted.status).toBe(200);
  const own = await (await summary(joined.token)).json() as Record<string, any>;
  expect(own.room).toMatchObject({ id, kind: "class", endReason: "interrupted" });
  expect(own.own).toMatchObject({ rank: 1, correctCount: 0 });
  expect(own).not.toHaveProperty("ranking");
  expect(own).not.toHaveProperty("questions");
  const teacher = await (await summary()).json() as Record<string, unknown>;
  expect(teacher).not.toHaveProperty("own");
  expect(teacher).not.toHaveProperty("ranking");
  expect(teacher).not.toHaveProperty("questions");
  const alien = await summary("invalid-token");
  expect(alien.status).toBe(403);
});
