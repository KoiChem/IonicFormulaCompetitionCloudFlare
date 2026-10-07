import { afterEach, describe, expect, it } from "vitest";
import { apiRequest, createApiTestContext, createClassRoom, joinClassRoom } from "./helpers";

const contexts: ReturnType<typeof createApiTestContext>[] = [];
afterEach(() => contexts.splice(0).forEach(context => context.close()));

describe("lobby nickname", () => {
  it("rejects a save after the start countdown begins", async () => {
    const ctx = createApiTestContext(); contexts.push(ctx);
    const room = (await createClassRoom(ctx)).body.room.id;
    const joined = await joinClassRoom(ctx, room, "保存済み");
    const start = await ctx.handlers.startRoom(apiRequest(`/api/rooms/${room}/start`, { method: "POST", json: { requestId: "start-1", expectedRevision: 1 } }), { id: room });
    expect(start.status).toBe(200);
    const rename = await ctx.handlers.nickname(apiRequest(`/api/rooms/${room}/nickname`, { method: "PATCH", token: joined.token, json: { requestId: "rename-after-start", expectedParticipantRevision: 0, nickname: "編集中" } }), { id: room });
    expect(rename.status).toBe(409);
    const state = await ctx.handlers.state(apiRequest(`/api/rooms/${room}/state`, { token: joined.token }), { id: room });
    expect(((await state.json()) as { participant: { nickname: string } }).participant.nickname).toBe("保存済み");
  });

  it("keeps the saved name when the start follows the save", async () => {
    const ctx = createApiTestContext(); contexts.push(ctx);
    const room = (await createClassRoom(ctx)).body.room.id;
    const joined = await joinClassRoom(ctx, room, "前");
    const rename = await ctx.handlers.nickname(apiRequest(`/api/rooms/${room}/nickname`, { method: "PATCH", token: joined.token, json: { requestId: "rename-before-start", expectedParticipantRevision: 0, nickname: "後" } }), { id: room });
    expect(rename.status).toBe(200);
    const start = await ctx.handlers.startRoom(apiRequest(`/api/rooms/${room}/start`, { method: "POST", json: { requestId: "start-2", expectedRevision: 1 } }), { id: room });
    expect(start.status).toBe(200);
    const state = await ctx.handlers.state(apiRequest(`/api/rooms/${room}/state`, { token: joined.token }), { id: room });
    expect(((await state.json()) as { participant: { nickname: string } }).participant.nickname).toBe("後");
  });

  it("rejects a normalized duplicate nickname", async () => {
    const ctx = createApiTestContext(); contexts.push(ctx);
    const room = (await createClassRoom(ctx)).body.room.id;
    const alice = await joinClassRoom(ctx, room, "Ａlice");
    const bob = await joinClassRoom(ctx, room, "Bob");
    expect(alice.response.status).toBe(201);
    const rename = await ctx.handlers.nickname(apiRequest(`/api/rooms/${room}/nickname`, { method: "PATCH", token: bob.token, json: { requestId: "duplicate", expectedParticipantRevision: 0, nickname: "alice" } }), { id: room });
    expect(rename.status).toBe(409);
  });
  it("does not let a participant from another room rename this room's member", async () => {
    const ctx = createApiTestContext(); contexts.push(ctx);
    const firstRoom = (await createClassRoom(ctx)).body.room.id;
    await joinClassRoom(ctx, firstRoom, "本人");
    const secondRoom = (await createClassRoom(ctx)).body.room.id;
    const outsider = await joinClassRoom(ctx, secondRoom, "別室");
    const rename = await ctx.handlers.nickname(apiRequest(`/api/rooms/${firstRoom}/nickname`, { method: "PATCH", token: outsider.token, json: { requestId: "outsider", expectedParticipantRevision: 0, nickname: "乗っ取り" } }), { id: firstRoom });
    expect(rename.status).toBe(403);
  });
  it("saves the participant's new name before room start and replays the request", async () => {
    const ctx = createApiTestContext(); contexts.push(ctx);
    const room = (await createClassRoom(ctx)).body.room.id;
    const joined = await joinClassRoom(ctx, room, "前の名前");
    const request = apiRequest(`/api/rooms/${room}/nickname`, { method: "PATCH", token: joined.token, json: { requestId: "rename-1", expectedParticipantRevision: 0, nickname: "新しい名前" } });
    const first = await ctx.handlers.nickname(request, { id: room });
    expect(first.status).toBe(200);
    const state = await ctx.handlers.state(apiRequest(`/api/rooms/${room}/state`, { token: joined.token }), { id: room });
    expect(((await state.json()) as { participant: { nickname: string } }).participant.nickname).toBe("新しい名前");
    const replay = await ctx.handlers.nickname(apiRequest(`/api/rooms/${room}/nickname`, { method: "PATCH", token: joined.token, json: { requestId: "rename-1", expectedParticipantRevision: 0, nickname: "新しい名前" } }), { id: room });
    expect(replay.status).toBe(200);
  });
});
