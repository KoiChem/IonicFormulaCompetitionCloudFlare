import { describe, expect, it } from "vitest";
import { prepareNicknameRequest } from "../../src/features/lobby/nickname-request";

describe("nickname save retry", () => {
  it("reuses the exact body after an uncertain response", () => {
    const first = prepareNicknameRequest(null, 3, "新しい名前", () => "first");
    expect(prepareNicknameRequest(first, 3, "新しい名前", () => "second")).toEqual(first);
  });

  it("starts a new command if the draft changes", () => {
    const first = prepareNicknameRequest(null, 3, "新しい名前", () => "first");
    expect(prepareNicknameRequest(first, 3, "別の名前", () => "second")).toEqual({
      requestId: "second", expectedParticipantRevision: 3, nickname: "別の名前",
    });
  });
});
