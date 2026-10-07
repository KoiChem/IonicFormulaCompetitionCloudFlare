import { describe, expect, it } from "vitest";
import { isValidJoinCode, normalizeJoinCode } from "../../src/features/setup/join-code";

describe("joining by code", () => {
  it("normalizes the code passed from the home screen", () => {
    expect(normalizeJoinCode(" ab2345 ")).toBe("AB2345");
  });
  it("requires six normalized code characters", () => {
    expect(isValidJoinCode(" ab2345 ")).toBe(true);
    expect(isValidJoinCode("abc")).toBe(false);
  });
});
