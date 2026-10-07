import { describe, expect, it } from "vitest";

import { beginPendingJoin, completePendingJoin, loadPendingJoin, clearPendingJoin } from "../../src/features/setup/join-draft";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("pending join", () => {
  it("persists one exact request across a second click and reload without replacing the active credential", () => {
    const local = storage();
    local.setItem("ionic-formula-competition:room:room-1", JSON.stringify({ token: "old-token", participantId: "old-id" }));
    const first = beginPendingJoin(local, "room-1", "名前", () => "new-token", () => "request-1");
    const repeat = beginPendingJoin(local, "room-1", "変更した名前", () => "other-token", () => "request-2");
    expect(repeat).toEqual(first);
    expect(loadPendingJoin(local, "room-1")).toEqual(first);
    expect(JSON.parse(local.getItem("ionic-formula-competition:room:room-1")!)).toEqual({ token: "old-token", participantId: "old-id" });

    expect(completePendingJoin(local, "room-1", first, "new-id")).toBe(true);
    expect(JSON.parse(local.getItem("ionic-formula-competition:room:room-1")!)).toEqual({ token: "new-token", participantId: "new-id" });
    expect(loadPendingJoin(local, "room-1")).toBeNull();
    expect(completePendingJoin(local, "room-1", first, "late-id")).toBe(false);
  });

  it("keeps other rooms and permits a fresh request after a definitive failure", () => {
    const local = storage();
    beginPendingJoin(local, "room-1", "A", () => "token-1", () => "request-1");
    beginPendingJoin(local, "room-2", "B", () => "token-2", () => "request-2");
    clearPendingJoin(local, "room-1");
    expect(loadPendingJoin(local, "room-1")).toBeNull();
    expect(loadPendingJoin(local, "room-2")?.nickname).toBe("B");
  });
});
