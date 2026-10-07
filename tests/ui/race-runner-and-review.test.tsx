import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HostRace, Runner } from "../../src/features/lobby/HostRace";
import { runnerPalette, colorForRunner } from "../../src/features/lobby/host-race-colors";
import { DeferredReviewQuestion } from "../../src/features/play/DeferredReviewQuestion";
import { readFileSync } from "node:fs";

describe("host runner", () => {
  it("rests after confirmed deferred submission without sweat or celebration", () => {
    const html = renderToStaticMarkup(createElement(HostRace, {
      roomId: "test-room",
      participants: [{ id: "writer", nickname: "入力者", status: "PLAYING", currentOrdinal: 0, correctCount: 0, answeredCount: 8, resolvedQuestionCount: 0, revision: 0, elapsedCs: null, timingSource: null, submitted: true }],
      mode: "deferred", maxScore: 10, active: true, pace: 0, remainingText: "01:23", interruptButton: null,
    }));
    expect(html).toContain("runner-rest-head");
    expect(html).toContain("runner-rest-body");
    for (const limb of ["right-arm", "left-arm", "right-leg", "left-leg"]) expect(html).toContain(`runner-rest-${limb}`);
    expect(html).toContain("runner-rest-sleep");
    expect(html).toContain("💤");
    expect(html).not.toContain("runner-sweat-drop");
    expect(html).not.toContain("is-celebrating");
  });
  it("animates sleep only while normal host motion is active", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.runner-rest-sleep\s*\{[^}]*animation:rest-sleep-sway 4\.5s/);
    expect(css).toMatch(/\.host-race\.is-light \.runner-rest-sleep\s*\{\s*animation:none/);
    expect(css).toMatch(/\.host-race:not\(\.is-light\):not\(\.is-initial\) \.runner-rest-sleep \{ animation-duration:4\.5s!important; \}/);
    const stopped = renderToStaticMarkup(createElement(Runner, { id: "rest", goal: false, stopped: true, rest: true }));
    expect(stopped).toContain("is-stopped");
  });
  it("follows the reclining reference's horizontal torso, raised far knee and head-supporting arm", () => {
    const html = renderToStaticMarkup(createElement(Runner, { id: "rest", goal: false, stopped: false, rest: true }));
    expect(html).toContain('viewBox="-38 -44 76 68"');
    expect(html).toContain('class="runner-rest-body runner-rest-torso" d="M-13 -9 L-1 -9 L7 -15"');
    expect(html).toContain('class="runner-rest-right-leg" d="M-15 -9 L-24 -18 L-25 -7"');
    expect(html).toContain('class="runner-rest-left-leg" d="M-14 -9 L-19 -4 L-33 -6"');
    expect(html).toContain('class="runner-rest-left-arm" d="M4 -12 L9 -4 L16 -9 L19 -8"');
    expect(html).toContain('class="runner-rest-right-arm" d="M4 -13 L-1 -16 L-13 -13"');
    expect(html).toContain('class="runner-rest-head runner-head" cx="16" cy="-24" r="12"');
  });
  it("draws a right-facing sprint with speed lines behind the runner", () => {
    const markup = renderToStaticMarkup(createElement(Runner, { id: "runner-1", goal: false, stopped: false, dash: true }));
    expect(markup).toContain("runner-dash-head");
    expect(markup).toContain("runner-dash-speed");
    expect(markup).not.toContain("runner-sweat-drop");
  });
  it("uses a solid head and three reusable sweat drops while running", () => {
    const markup = renderToStaticMarkup(createElement(Runner, { id: "runner-1", goal: false, stopped: false }));
    expect(markup).toContain('class="runner-head"');
    expect(markup.match(/class="runner-sweat-drop"/g)).toHaveLength(3);
    expect(markup).toContain('class="runner-sweat"');
    expect(markup).not.toContain("runner-joy-rays");
  });
  it("uses a raised-arm, bent-leg pose with short rays after a confirmed goal", () => {
    const markup = renderToStaticMarkup(createElement(Runner, { id: "runner-1", goal: true, stopped: false }));
    expect(markup).toContain('class="runner-goal-arm-left"');
    expect(markup).toContain('class="runner-goal-arm-right"');
    expect(markup).toContain('class="runner-goal-kicked-leg"');
    expect(markup).toContain('class="runner-joy-rays"');
    expect(markup.match(/class="runner-joy-ray runner-joy-ray-/g)).toHaveLength(5);
    expect(markup).not.toContain('class="runner-leg runner-leg-left"');
    expect(markup).not.toContain('class="runner-sweat"');
  });
  it("keeps both waving arm strokes clear of the filled head throughout the motion", () => {
    const markup = renderToStaticMarkup(createElement(Runner, { id: "runner-1", goal: true, stopped: false }));
    expect(markup).toContain('viewBox="-36 -68 72 102"');
    expect(markup).toContain('d="M0 -17 L-16.8 -16.3 L-27.945 -24.887"');
    expect(markup).toContain('d="M1 -17 L17.8 -16.3 L28.945 -24.887"');
    const distanceToSegment = (a: [number, number], b: [number, number]) => {
      const vx = b[0] - a[0], vy = b[1] - a[1];
      const along = Math.max(0, Math.min(1, ((-a[0]) * vx + (-43 - a[1]) * vy) / (vx * vx + vy * vy)));
      return Math.hypot(a[0] + along * vx, a[1] + along * vy + 43);
    };
    for (const side of [-1, 1]) for (let step = 0; step <= 200; step += 1) {
      const angle = side * (20 - step / 10) * Math.PI / 180;
      const shoulder: [number, number] = [side === -1 ? 0 : 1, -17];
      const rotate = ([x, y]: [number, number]): [number, number] => {
        const dx = x - shoulder[0], dy = y - shoulder[1];
        return [shoulder[0] + dx * Math.cos(angle) - dy * Math.sin(angle), shoulder[1] + dx * Math.sin(angle) + dy * Math.cos(angle)];
      };
      const elbow = rotate([side === -1 ? -16.8 : 17.8, -16.3]);
      const hand = rotate([side === -1 ? -27.945 : 28.945, -24.887]);
      expect(Math.min(distanceToSegment(shoulder, elbow), distanceToSegment(elbow, hand))).toBeGreaterThan(21);
      expect(hand[0]).toBeGreaterThan(-34);
      expect(hand[0]).toBeLessThan(34);
    }
    const upper = Math.hypot(16.8, 0.7), lower = Math.hypot(11.145, 8.587);
    expect(upper / Math.hypot(24, 1)).toBeCloseTo(0.7, 2);
    expect(lower / Math.hypot(2, 20)).toBeCloseTo(0.7, 2);
    const elbowAngle = Math.acos((16.8 * -11.145 + -0.7 * -8.587) / (upper * lower)) * 180 / Math.PI;
    expect(elbowAngle).toBeCloseTo(140, 0);
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.runner-goal-arm-left,\.runner-goal-arm-right\s*\{[^}]*goal-wave \.6s/);
    expect(css).toMatch(/\.runner-goal-kicked-leg\s*\{[^}]*goal-kick 1\.2s/);
  });
  it("shows a compact header and a celebrating full-score runner", () => {
    const html = renderToStaticMarkup(createElement(HostRace, {
      roomId: "test-room",
      participants: [{ id: "winner", nickname: "優勝者", status: "PLAYING", currentOrdinal: 0, correctCount: 10, answeredCount: 10, resolvedQuestionCount: 10, revision: 0, elapsedCs: null, timingSource: null }],
      mode: "immediate", maxScore: 10, active: true, pace: 0,
      remainingText: "01:23", interruptButton: createElement("button", null, "中断"),
    }));
    expect(html).toContain("暫定順位");
    expect(html).toContain("残り");
    expect(html).toContain("01:23");
    expect(html).toContain("中断");
    expect(html).toContain("軽量表示");
    expect(html).toContain("is-celebrating");
    expect(html).not.toContain("順位・参加者");
  });
  it("keeps a deferred full-input runner running", () => {
    const html = renderToStaticMarkup(createElement(HostRace, {
      roomId: "test-room",
      participants: [{ id: "writer", nickname: "入力者", status: "PLAYING", currentOrdinal: 0, correctCount: 0, answeredCount: 10, resolvedQuestionCount: 0, revision: 0, elapsedCs: null, timingSource: null }],
      mode: "deferred", maxScore: 10, active: true, pace: 0, remainingText: "01:23", interruptButton: null,
    }));
    expect(html).not.toContain("is-celebrating");
    expect(html).not.toContain("is-goal");
  });
  it("uses the persistent join slot even when score order and participant order change", () => {
    const participant = (id: string, joinedOrder: number, correctCount: number) => ({ id, joinedOrder, nickname: id, status: "ACTIVE", currentOrdinal: 0, correctCount, resolvedQuestionCount: 0, revision: 0, elapsedCs: null, timingSource: null });
    const html = renderToStaticMarkup(createElement(HostRace, {
      roomId: "test-room", participants: [participant("b", 2, 4), participant("a", 1, 0)],
      mode: "immediate", maxScore: 5, active: true, pace: 0, remainingText: "01:23", interruptButton: null,
    }));
    const colors = [...html.matchAll(/style="color:([^;]+);/g)].map(match => match[1]);
    expect(colors).toEqual([colorForRunner("test-room", 2), colorForRunner("test-room", 1)]);
  });
  it("has at least eighteen stable dark runner colors", () => {
    expect(new Set(runnerPalette).size).toBeGreaterThanOrEqual(18);
    expect(colorForRunner("test-room", 1)).toBe(colorForRunner("test-room", 1));
  });
});

describe("deferred review", () => {
  it("places the question and answer on consecutive lines with formatted charges", () => {
    const html = renderToStaticMarkup(createElement(DeferredReviewQuestion, {
      number: 1,
      prompt: { kind: "ionFormula", values: [{ type: "formula", value: "Na", charge: 1 }] },
      fields: [{ id: "name", value: "ナトリウムイオン" }],
      disabled: false,
      onSelect: () => {},
    }));
    expect(html).toMatch(/第１問：.*Na.*<sup>\+<\/sup>/);
    expect(html).toContain("解答：ナトリウムイオン");
    expect(html).not.toContain("問題：");
  });
  it("labels both answers and preserves unanswered fields", () => {
    const html = renderToStaticMarkup(createElement(DeferredReviewQuestion, {
      number: 2,
      prompt: { kind: "compoundIons", values: [{ type: "formula", value: "Na", charge: 1 }, { type: "formula", value: "Cl", charge: -1 }] },
      fields: [{ id: "formula", value: undefined }, { id: "name", value: "塩化ナトリウム" }],
      disabled: false,
      onSelect: () => {},
    }));
    expect(html).toContain("解答：未解答");
    expect(html).toContain("名称：塩化ナトリウム");
  });
});
