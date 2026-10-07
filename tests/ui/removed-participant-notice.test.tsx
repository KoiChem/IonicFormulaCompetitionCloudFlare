import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RemovedParticipantNotice } from "../../src/features/lobby/RemovedParticipantNotice";

describe("removed participant notice", () => {
  it("offers explicit re-entry when the room is waiting", () => {
    const html = renderToStaticMarkup(createElement(RemovedParticipantNotice, { roomState: "WAITING", canRejoin: true, onRejoin: () => {} }));
    expect(html).toContain("参加を断られました");
    expect(html).toContain("ホストがロビーからあなたのエントリーを削除しました。もう一度エントリーしますか？");
    expect(html).toContain("再度エントリーする");
    expect(html).toContain("エントリーせずにホームへ");
  });

  it("shows reception closed without a re-entry action", () => {
    const html = renderToStaticMarkup(createElement(RemovedParticipantNotice, { roomState: "RUNNING", canRejoin: false, onRejoin: () => {} }));
    expect(html).toContain("参加受付は終了しました");
    expect(html).not.toContain("再度エントリーする");
    expect(html).toContain("ホームへ戻る");
  });
});
