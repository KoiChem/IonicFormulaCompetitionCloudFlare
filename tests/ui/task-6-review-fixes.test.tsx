import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ions from "../../src/games/ionic-formula/data/ions.json";
import compounds from "../../src/games/ionic-formula/data/compounds.json";
import { CHARGE_OPTIONS, FORMULA_TOKENS, FormulaKeyboard } from "../../src/games/ionic-formula/client/FormulaKeyboard";
import { createFormulaEntry } from "../../src/games/ionic-formula/client/formula-entry";
import { Lobby } from "../../src/features/lobby/Lobby";
import {
  DEFAULT_SETTINGS,
  CompetitionSettingsForm,
  settingsSummary,
} from "../../src/features/setup/CompetitionSettingsForm";
import {
  chooseFreshSnapshot,
  countdownSeconds,
  remainingSeconds,
} from "../../src/features/play/useRoomSync";

const room = {
  id: "stable-public-id", kind: "mate" as const, state: "WAITING" as const,
  revision: 4, settings: DEFAULT_SETTINGS, maxScore: 10,
  startAtMs: null, deadlineAtMs: null, expiresAtMs: 99_999,
};

describe("Task 6 review fixes", () => {
  it("can enter every formula token and ion charge present in the vendored curriculum", () => {
    const available = new Set<string>(FORMULA_TOKENS);
    for (const item of [...ions, ...compounds]) {
      if (!item.formula) continue;
      const tokens = [...item.formula];
      expect(tokens.every((token) => available.has(token)), item.formula).toBe(true);
    }
    expect(CHARGE_OPTIONS.map(({ magnitude, sign }) => `${magnitude}${sign}`)).toEqual([
      "1+", "2+", "3+", "1-", "2-", "3-", "4-",
    ]);
    expect(CHARGE_OPTIONS.every((charge) => charge.source === "chargeButton")).toBe(true);
  });

  it("renders all charge controls without embedding curriculum answers", () => {
    const html = renderToStaticMarkup(createElement(FormulaKeyboard, {
      value: createFormulaEntry(), onChange: () => {},
    }));
    expect(html).toContain("2+");
    expect(html).toContain("3−");
    expect(html).not.toContain("硫酸");
    expect(html).toContain("formula-composer");
    expect(html).toContain("解答をチェック");
    expect(html).toContain("formula-placeholder");
  });

  it("rejects participant snapshots that arrive out of order even when room revision is unchanged", () => {
    const current = { room: { revision: 4 }, participant: { revision: 8 } };
    expect(chooseFreshSnapshot(current, { room: { revision: 4 }, participant: { revision: 7 } }, 2, 1)).toBe(current);
    expect(chooseFreshSnapshot(current, { room: { revision: 4 }, participant: { revision: 9 } }, 2, 1)?.participant?.revision).toBe(9);
    expect(chooseFreshSnapshot(current, { room: { revision: 4 }, participant: { revision: 8 } }, 2, 3)).not.toBe(current);
  });

  it("derives a continuously changing countdown and remaining play time", () => {
    expect(countdownSeconds(10_000, 5_001)).toBe(5);
    expect(countdownSeconds(10_000, 9_001)).toBe(1);
    expect(remainingSeconds(310_000, 10_001)).toBe(300);
    expect(remainingSeconds(310_000, 309_999)).toBe(1);
  });

  it("uses random defaults and exposes compound prompt toggles and shared settings summaries", () => {
    expect(DEFAULT_SETTINGS.ionAnswer).toBe("random");
    expect(DEFAULT_SETTINGS.compoundAnswer).toBe("random");
    expect(settingsSummary({ ...DEFAULT_SETTINGS, mode: "compound", compoundAnswer: "both" })).toBe("10問・5分・問題毎判定・化合物・やさしめ・出題 イオン式・イオン名・解答 式と名");
    const html = renderToStaticMarkup(createElement(CompetitionSettingsForm, {
      value: { ...DEFAULT_SETTINGS, mode: "compound" }, onChange: () => {},
    }));
    expect(html).toContain("化合物の出題");
    expect(html).toContain("イオン式");
    expect(html).toContain("イオン名");
  });

  it("renders a real local QR image, lobby settings, and owner removal controls", () => {
    const html = renderToStaticMarkup(createElement(Lobby, {
      room, joinCode: "ABC234", canStart: true, onStart: () => {}, onRemove: () => {},
      ownerParticipantId: "host",
      participants: [
        { id: "host", nickname: "ホスト", status: "ACTIVE", currentOrdinal: 0, correctCount: 0, resolvedQuestionCount: 0, revision: 0, elapsedCs: null, timingSource: null },
        { id: "guest", nickname: "ゲスト", status: "ACTIVE", currentOrdinal: 0, correctCount: 0, resolvedQuestionCount: 0, revision: 2, elapsedCs: null, timingSource: null },
      ],
    }));
    expect(html).toContain("<svg");
    expect(html).toContain("aria-label=\"参加用QRコード");
    expect(html).not.toContain("qr-placeholder");
    expect(html).toContain("10問・5分・問題毎判定・イオン・やさしめ・出題 イオン式・イオン名・解答 式または名");
    expect(html).toContain("ゲストさんを参加者から除外");
    expect(html).not.toContain("ホストさんを参加者から除外");
  });

  it("wires join info, settings PATCH, removal, and persistent pending actions in components", () => {
    const join = readFileSync(new URL("../../app/join/[publicId]/page.tsx", import.meta.url), "utf8");
    const roomScreen = readFileSync(new URL("../../src/features/lobby/RoomScreen.tsx", import.meta.url), "utf8");
    const player = readFileSync(new URL("../../src/features/play/CompetitionPlayer.tsx", import.meta.url), "utf8");
    expect(join).toContain("/api/join-info?publicId=");
    expect(join).toContain("participantCount");
    expect(join).toContain("capacity");
    expect(roomScreen).toContain("patchJson");
    expect(roomScreen).toContain("/settings");
    expect(roomScreen).toContain("/remove");
    expect(player).toContain("sessionStorage");
    expect(player).toContain("playerReducer");
  });
});
