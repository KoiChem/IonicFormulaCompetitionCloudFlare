import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
const nameKeyboard = readFileSync(new URL("../../src/games/ionic-formula/client/NameKeyboard.tsx", import.meta.url), "utf8");
describe("responsive and keyboard acceptance", () => {
  it("keeps controls touch-sized and constrains narrow layouts", () => { expect(css).toContain("min-height: 48px"); expect(css).toContain("overflow-x: hidden"); expect(css).toContain("max-width: 420px"); });
  it("supports reduced motion and visible keyboard focus", () => { expect(css).toContain("prefers-reduced-motion"); expect(css).toContain(":focus-visible"); });
  it("does not submit the name field while IME composition is active", () => { expect(nameKeyboard).toContain("!composing.current"); expect(nameKeyboard).toContain("onCompositionStart"); });
  it("uses the original fixed-row name layouts and full-width play surface", () => {
    expect(css).toContain("grid-template-columns: repeat(5,minmax(0,1fr)) minmax(52px,1.35fr)");
    expect(css).toContain("grid-template-columns: repeat(4,minmax(0,1fr)) minmax(53px,1.35fr) minmax(40px,1fr) minmax(48px,1.2fr)");
    expect(css).toContain("width: 100%");
    expect(css).toContain("height: 57px");
  });
});
