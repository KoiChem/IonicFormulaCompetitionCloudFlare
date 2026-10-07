import { apiFetch } from '../../src/web/api';
import { appPath } from '../../src/web/routing';
"use client";
import { useEffect, useState } from "react";
import { discoverHistoryCandidates, rememberHistoryRoom, type HistoryCandidate } from "../../src/features/results/history-index";
import { loadCredential } from "../../src/features/play/useRoomSync";
import { settingsSummary } from "../../src/features/setup/CompetitionSettingsForm";
import type { IonicFormulaGameSettings } from "../../src/games/ionic-formula/shared/types";

type Summary = { room: { id: string; kind: "class" | "mate"; settings: IonicFormulaGameSettings; createdAtMs: number; endedAtMs: number; expiresAtMs: number; endReason: "normal" | "interrupted" }; own?: { rank: number; correctCount: number } };
type Row = { candidate: HistoryCandidate; summary?: Summary; message?: string };

export default function HistoryPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const run = async () => {
      const candidates = discoverHistoryCandidates(localStorage);
      const next: Row[] = [];
      for (let offset = 0; offset < candidates.length; offset += 4) {
        const batch = await Promise.all(candidates.slice(offset, offset + 4).map(async candidate => {
          const token = candidate.role === "participant" ? loadCredential(candidate.roomId)?.token : undefined;
          if (candidate.role === "participant" && !token) return { candidate, message: "このブラウザに参加資格がありません" } as Row;
          try {
            const response = await apiFetch(`/api/rooms/${encodeURIComponent(candidate.roomId)}/result-summary`, { cache: "no-store", headers: token ? { authorization: `Bearer ${token}` } : undefined });
            if (response.ok) {
              const summary = await response.json() as Summary;
              rememberHistoryRoom(localStorage, { ...candidate, kind: summary.room.kind, createdAtMs: summary.room.createdAtMs, expiresAtMs: summary.room.expiresAtMs, settings: summary.room.settings });
              return { candidate, summary } as Row;
            }
            if (response.status === 409) return { candidate, message: "競技中・結果確定待ち" } as Row;
            if (response.status === 410 || response.status === 404) return { candidate, message: "閲覧期限が切れました" } as Row;
            if (response.status === 403) return { candidate, message: candidate.role === "teacher" ? "教員認証を確認してください" : "参加資格を確認できません" } as Row;
            return { candidate, message: "結果を取得できません。再試行してください" } as Row;
          } catch { return { candidate, message: "通信できません。再試行してください" } as Row; }
        }));
        next.push(...batch);
      }
      if (active) { setRows(next.sort((a, b) => (b.summary?.room.createdAtMs ?? b.candidate.createdAtMs ?? 0) - (a.summary?.room.createdAtMs ?? a.candidate.createdAtMs ?? 0))); setLoading(false); }
    };
    void run();
    return () => { active = false; };
  }, [retry]);
  const render = (role: HistoryCandidate["role"]) => rows.filter(row => row.candidate.role === role).map(row => <li key={`${role}:${row.candidate.roomId}`} className="review-card">
    {row.summary ? <><strong>{row.summary.room.kind === "class" ? "クラスコンペ" : "メイトマッチ"}・{new Date(row.summary.room.createdAtMs).toLocaleString("ja-JP")}</strong>
      <p>{settingsSummary(row.summary.room.settings)}</p><p>{row.summary.room.endReason === "interrupted" ? "中断終了" : "終了"}{row.summary.own ? `・${row.summary.own.rank}位・正解${row.summary.own.correctCount}` : ""}</p>
      <p>閲覧期限：{new Date(row.summary.room.expiresAtMs).toLocaleString("ja-JP")}</p>
      <a className="secondary-link" href={appPath(`/history/${encodeURIComponent(row.candidate.roomId)}?role=${role}`)}>結果を見る</a></> : <><strong>{row.candidate.kind === "class" ? "クラスコンペ" : row.candidate.kind === "mate" ? "メイトマッチ" : "競技"}{row.candidate.createdAtMs ? `・${new Date(row.candidate.createdAtMs).toLocaleString("ja-JP")}` : ""}</strong><p>{row.message}</p></>}
  </li>);
  return <main className="page-shell"><section className="panel wide"><h1>過去の結果</h1><p>このブラウザで参加・作成した競技を、閲覧期限内に確認できます。</p>
    {loading ? <p role="status">結果を確認しています…</p> : <>{rows.length === 0 && <p>閲覧できる結果はありません。</p>}
      <h2>参加した競技</h2><ul className="review-list">{render("participant")}</ul>
      <h2>主催した競技</h2><ul className="review-list">{render("teacher")}</ul>
      <button type="button" className="secondary-button" onClick={() => { setLoading(true); setRetry(value => value + 1); }}>再確認する</button></>}
    <p><a href={appPath("/")}>ホームへ戻る</a></p></section></main>;
}
