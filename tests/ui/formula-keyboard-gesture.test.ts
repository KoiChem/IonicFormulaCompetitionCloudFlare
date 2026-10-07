import { describe, expect, it } from "vitest";

import {
  alternateCaseLetter,
  classifyCaseFlick,
  shouldHandleFormulaLetterClick,
} from "../../src/games/ionic-formula/client/formula-keyboard-gesture";

describe("formula keyboard pointer gestures", () => {
  it("classifies taps and only the intended vertical case flick", () => {
    expect(classifyCaseFlick(0, 0, true)).toBe("tap");
    expect(classifyCaseFlick(0, 20, true)).toBe("alternate");
    expect(classifyCaseFlick(0, -20, true)).toBe("cancel");
    expect(classifyCaseFlick(20, 20, true)).toBe("cancel");
    expect(classifyCaseFlick(0, -20, false)).toBe("alternate");
    expect(alternateCaseLetter("M", true)).toBe("m");
    expect(alternateCaseLetter("M", false)).toBe("M");
  });

  it("permanently ignores pointer-generated compatibility clicks", () => {
    expect(shouldHandleFormulaLetterClick(1, "touch")).toBe(false);
    expect(shouldHandleFormulaLetterClick(1, "pen")).toBe(false);
    expect(shouldHandleFormulaLetterClick(1, "mouse")).toBe(false);
    expect(shouldHandleFormulaLetterClick(0, "touch")).toBe(false);
    expect(shouldHandleFormulaLetterClick(0, "")).toBe(true);
  });
});
