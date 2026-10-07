import { appPath } from '../../web/routing';
"use client";

import { formatCentiseconds } from "../play/clock";
import type { ResultLoadState } from "./result-loader";

const reasonLabel = (reason: string) => reason === "completed" ? "完了" : reason === "submitted" ? "提出" : reason === "interrupted" ? "中断" : "時間切れ";

export function ResultLoadPanel({ state, retry, history = false }: { state: ResultLoadState; retry(): void; history?: boolean }) {
  const own = state.summary?.own;
  const status = state.status === "offline" ? "通信が戻ると結果を再取得します"
    : state.status === "loading" ? "結果を集計しています…"
    : state.status === "retrying" ? "結果を再取得しています…"
    : state.error || "結果を読み込んでいます…";
  return <main className="page-shell"><section className="panel">
    <h1>{history ? "過去の結果" : "結果を確認中"}</h1>
    {own && <section className="own-result"><h2>あなたの結果</h2><p>{own.rank}位　正解 {own.correctCount}　時間 {formatCentiseconds(own.elapsedCs ?? 0)}　{reasonLabel(own.finishReason ?? "timeout")}</p><p>{state.status === "failed" ? "問題別結果はまだ取得できません" : "問題別結果を再取得しています"}</p></section>}
    <p role={state.status === "failed" ? "alert" : "status"}>{status}</p>
    {state.requestId && state.status === "failed" && <p>確認用ID：<code>{state.requestId}</code></p>}
    {state.canRetry && <button type="button" onClick={retry}>結果を再取得</button>}
    <p><a href={appPath(history ? "/history" : "/")}>{history ? "一覧へ戻る" : "ホームへ戻る"}</a></p>
  </section></main>;
}
