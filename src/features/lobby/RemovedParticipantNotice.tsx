import { appPath } from '../../web/routing';
"use client";

export function RemovedParticipantNotice({ roomState, canRejoin, onRejoin }: { roomState: string; canRejoin: boolean; onRejoin(): void }) {
  const status = roomState === "CANCELLED" ? "このルームは終了しました。"
    : roomState === "EXPIRED" ? "このルームの閲覧期限は終了しました。"
      : roomState === "FINISHED" ? "競技は終了しました。"
        : "参加受付は終了しました。";
  return <main className="page-shell"><section className="panel"><h1>参加を断られました</h1>
    <p>ホストがロビーからあなたのエントリーを削除しました。もう一度エントリーしますか？</p>
    {canRejoin ? <button type="button" className="primary-action" onClick={onRejoin}>再度エントリーする</button> : <p role="status">{status}</p>}
    <a className="primary-link" href={appPath("/")}>{canRejoin ? "エントリーせずにホームへ" : "ホームへ戻る"}</a>
  </section></main>;
}
