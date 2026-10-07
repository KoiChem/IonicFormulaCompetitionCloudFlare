import { appPath } from '../../web/routing';
"use client";
import { useEffect, useState } from "react";
import { formatCentiseconds } from "../play/clock";
import { teacherTopRank, topRankingRows } from "./ranking-visibility";
import type { FormulaEntry, QuestionPrompt } from "../../games/ionic-formula/shared/types";
import type { IonicFormulaGameSettings } from "../../games/ionic-formula/shared/types";
import { rememberHistoryRoom } from "./history-index";
import { settingsSummary } from "../setup/CompetitionSettingsForm";
import { PodiumPlace } from "./PodiumPlace";

type Ranking = { rank: number; nickname: string; correctCount: number; elapsedCs: number; finishReason: string; finalSyncUnconfirmed?: boolean };
type ReviewField = { id: "formula" | "name"; state: "correct" | "incorrect" | "passed" | "unanswered"; correctAnswer: string; correctFormulaCore?: string | null; correctFormulaCharge?: number | null; lastAnswer: string | null; lastAnswerEntry?: FormulaEntry | null; answerDisplayUnavailable?: boolean; lastAnswerCorrect: boolean | null; attemptCount?: number };
type ReviewQuestion = { id: string; ordinal: number; prompt: QuestionPrompt; fields: ReviewField[] };
export function Formula({ value, charge }: { value: string; charge?: number | null }) {
  return <span className="formula" aria-label={`${value}${charge ? `${Math.abs(charge) === 1 ? "" : Math.abs(charge)}${charge > 0 ? "+" : "-"}` : ""}`}>{value.split(/(\d+)/u).map((part, index) => /^\d+$/u.test(part) ? <sub key={index}>{part}</sub> : <span key={index}>{part}</span>)}{charge ? <sup>{Math.abs(charge) === 1 ? "" : Math.abs(charge)}{charge > 0 ? "+" : "−"}</sup> : null}</span>;
}
function Answer({ field }: { field: ReviewField }) {
  if (field.id === "name") return <>{field.correctAnswer}</>;
  if (field.correctFormulaCore && field.correctFormulaCharge) return <Formula value={field.correctFormulaCore} charge={field.correctFormulaCharge}/>;
  return <Formula value={field.correctAnswer}/>;
}
function Verdict({ field }: { field: ReviewField }) {
  if (field.state === "correct") return <strong className="verdict correct">○ 正解</strong>;
  if (field.lastAnswerCorrect === false) return <strong className="verdict incorrect">× 不正解</strong>;
  if (field.state === "passed") return <strong className="verdict passed">パス</strong>;
  return <strong className="verdict unanswered">未回答</strong>;
}
function DeferredFieldResult({ field }: { field: ReviewField }) {
  if (field.answerDisplayUnavailable) return <div className="review-field"><p><Answer field={field}/> <Verdict field={field}/></p><p>解答の表示を取得できませんでした</p></div>;
  if (field.state === "unanswered") return <div className="review-field"><p><Answer field={field}/> <strong className="verdict incorrect">未解答</strong></p></div>;
  return <div className="review-field"><p><Answer field={field}/> <Verdict field={field}/></p>
    {field.state === "incorrect" && <p className="submitted-answer">あなたの解答：{field.lastAnswerEntry && field.id === "formula"
      ? <Formula value={field.lastAnswerEntry.tokens.join("")} charge={field.lastAnswerEntry.charge ? field.lastAnswerEntry.charge.magnitude * (field.lastAnswerEntry.charge.sign === "+" ? 1 : -1) : null}/>
      : field.lastAnswer ?? "未解答"}</p>}
  </div>;
}
function ImmediateFieldResult({ field, interrupted }: { field: ReviewField; interrupted: boolean }) {
  return <div className="review-field"><p><Answer field={field}/> <Verdict field={field}/>
    {field.state === "passed" && field.lastAnswerCorrect === false ? <small>パス</small>
      : field.state === "unanswered" ? <small>{interrupted ? "中断時未回答" : "時間切れ"}</small> : null}</p>{field.answerDisplayUnavailable && <p>解答の表示を取得できませんでした</p>}</div>;
}
export function Results({ data }: { data: { room?: { id?: string; kind: "class" | "mate"; endReason?: "normal" | "interrupted"; createdAtMs?: number; expiresAtMs?: number; settings?: IonicFormulaGameSettings }; ranking?: Ranking[]; own?: { rank?: number; correctCount?: number; elapsedCs?: number; waitCreditMs?: number; finishReason?: string; timingSource?: string; finalSyncUnconfirmed?: boolean }; questions?: ReviewQuestion[]; aggregate?: { averageCorrectCount: number; perfectCount: number; completedCount: number } } }) {
  const ranking = data.ranking ?? [];
  const [allVisible, setAllVisible] = useState(false);
  useEffect(() => {
    const room = data.room;
    if (!room?.id || !room.settings) return;
    rememberHistoryRoom(localStorage, { roomId: room.id, role: data.own ? "participant" : "teacher", kind: room.kind,
      createdAtMs: room.createdAtMs, expiresAtMs: room.expiresAtMs, settings: room.settings });
  }, [data]);
  const classParticipant = data.room?.kind === "class" && !!data.own;
  const classTeacher = data.room?.kind === "class" && !!data.aggregate && !data.own;
  const hostRankingLayout = classTeacher || data.room?.kind === "mate";
  const boundary = classParticipant ? 3 : teacherTopRank(ranking.length);
  const visibleRanking = classParticipant || (classTeacher && !allVisible) ? topRankingRows(ranking, boundary) : ranking;
  const reasonLabel = (reason: string) => reason === "completed" ? "完了" : reason === "submitted" ? "提出" : reason === "interrupted" ? "中断" : "時間切れ";
  return <main className="page-shell results-page"><section className="panel wide"><p className="eyebrow">RESULTS</p><h1>{data.room?.endReason === "interrupted" ? "中断時の結果" : "最終結果"}</h1>{data.room?.settings && <p className="settings-summary">{settingsSummary(data.room.settings)}</p>}
    {(classParticipant || classTeacher) && <h2>{classTeacher && allVisible ? "全成績" : `上位${boundary}位`}</h2>}
    <div className="ranking-cards" id="results-ranking">{visibleRanking.map((row, index) => <article className="ranking-card" key={`${row.nickname}-${index}`}><PodiumPlace rank={row.rank} name={row.nickname} className={hostRankingLayout ? "host-ranking-place" : ""}
      trailing={hostRankingLayout ? <span className="host-ranking-score"><strong>正解 {row.correctCount}</strong><strong>{formatCentiseconds(row.elapsedCs)}</strong></span> : null}>
      {hostRankingLayout ? <>{reasonLabel(row.finishReason)}{row.finalSyncUnconfirmed ? "・最終同期未確認" : ""}</> : <>正解 {row.correctCount}　{formatCentiseconds(row.elapsedCs)}　{reasonLabel(row.finishReason)}{row.finalSyncUnconfirmed ? "・最終同期未確認" : ""}</>}
    </PodiumPlace></article>)}</div>
    {classTeacher && topRankingRows(ranking, boundary).length < ranking.length ? <button type="button" className="secondary-button" aria-controls="results-ranking" aria-expanded={allVisible} onClick={() => setAllVisible(value => !value)}>{allVisible ? "全成績を閉じる" : "全成績を表示"}</button> : null}
    {classParticipant && data.own && <section className="own-result"><h2>あなたの結果</h2><PodiumPlace rank={data.own.rank ?? 0}>正解 {data.own.correctCount}　時間 {formatCentiseconds(data.own.elapsedCs ?? 0)}　{reasonLabel(data.own.finishReason ?? "timeout")}{data.own.finalSyncUnconfirmed ? "・最終同期未確認" : ""}</PodiumPlace></section>}
    {data.questions && <section><h2>あなたの問題別結果</h2><ol className="review-list">{data.questions.map(question => <li key={question.id} className="review-card">{question.prompt.kind === "compoundIons" ? <><h3>第{question.ordinal + 1}問</h3><p className="review-prompt">問題：{question.prompt.values.map((item, index) => <span key={index}>{index > 0 ? " ＋ " : ""}{item.type === "formula" ? <Formula value={item.value} charge={item.charge}/> : item.value}</span>)}</p></> : <h3 className="review-prompt">第{String(question.ordinal + 1).replace(/[0-9]/g, digit => "０１２３４５６７８９"[Number(digit)])}問：{question.prompt.values.map((item, index) => <span key={index}>{item.type === "formula" ? <Formula value={item.value} charge={item.charge}/> : item.value}</span>)}</h3>}{question.fields.map(field => data.room?.settings?.gradingMode === "deferred"
      ? <DeferredFieldResult key={field.id} field={field}/>
      : <ImmediateFieldResult key={field.id} field={field} interrupted={data.room?.endReason === "interrupted"}/>)}</li>)}</ol></section>}{data.aggregate && <section><h2>クラス集計</h2><p>平均 {Number(data.aggregate.averageCorrectCount).toFixed(1)}点／満点 {data.aggregate.perfectCount}人／完了 {data.aggregate.completedCount}人</p></section>}<p>この結果は、このブラウザから閲覧期限まで再確認できます。</p><a className="secondary-link" href={appPath("/history")}>過去の結果</a><a className="primary-link" href={appPath("/")}>ホームへ戻る</a></section></main>;
}
