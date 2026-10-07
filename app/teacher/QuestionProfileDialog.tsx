"use client";
import { useEffect, useRef, useState } from "react";
import { fetchJsonWithTimeout, patchJson } from "../../src/features/play/useRoomSync";
import type { QuestionProfile, CatalogItem, ItemDifficulty } from "../../src/games/ionic-formula/shared/question-profile";
import { QuestionDifficultyToggle, itemDifficultyLabels } from "./QuestionDifficultyToggle";
type Snapshot = { profile: QuestionProfile; revision: number; catalog: { ions: CatalogItem[]; compounds: CatalogItem[] } };
const modes = ["ion", "compound"] as const;
const difficulties = ["normal", "hard"] as const;
const difficultyLabels = itemDifficultyLabels;
const categoryLabels: Record<string, string> = { ionSimple: "単原子イオン", ionPolyatomic: "多原子イオン", ionVariableOx: "酸化数を表すイオン", simple11: "単原子イオン・1対1", simpleRatio: "単原子イオン・異なる比率", polyatomic: "多原子イオンを含む", variableOx: "酸化数を表す化合物" };
export function itemDifficulty(item: Pick<CatalogItem, "id" | "defaultDifficulty">, overrides: Record<string, ItemDifficulty>) { return overrides[item.id] ?? item.defaultDifficulty; }
function candidateEnabled(item: Pick<CatalogItem, "id" | "defaultDifficulty" | "category">, overrides: Record<string, ItemDifficulty>, mode: "ion" | "compound", level: "normal" | "hard", weights: Record<string, number> | null) {
  const membership = itemDifficulty(item, overrides);
  return (membership === level || membership === "both") && (weights ? (weights[item.category] ?? 0) > 0 : !(mode === "compound" && level === "hard" && item.category === "simple11" && !Object.hasOwn(overrides, item.id)));
}
export function profileCandidateCounts(items: Pick<CatalogItem, "id" | "defaultDifficulty" | "category" | "complex">[], overrides: Record<string, ItemDifficulty>, mode: "ion" | "compound", level: "normal" | "hard", weights: Record<string, number> | null) {
  const eligible = items.filter(item => item.complex ? [level, "both"].includes(itemDifficulty(item, overrides)) : candidateEnabled(item, overrides, mode, level, weights));
  return { ordinary: eligible.filter(item => !item.complex).length, complex: eligible.filter(item => item.complex).length };
}
export function complexCountPreview(percent: number) { return [5, 10, 15].map(count => Math.ceil(count * percent / 100)); }
export function QuestionProfileDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<QuestionProfile | null>(null);
  const [tab, setTab] = useState<"ratio" | "ion" | "compound">("ratio");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [complexFilter, setComplexFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const pending = useRef<{ profile: QuestionProfile; expectedRevision: number; requestId: string } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const dirty = !!draft && !!snapshot && JSON.stringify(draft) !== JSON.stringify(snapshot.profile);
  async function load() {
    setBusy(true); setMessage("設定を読み込んでいます…");
    try { const value = await fetchJsonWithTimeout("/api/teacher/question-profile", { cache: "no-store" }, 10000) as Snapshot; setSnapshot(value); setDraft(structuredClone(value.profile)); pending.current = null; setUncertain(false); setConflict(false); setMessage(""); }
    catch (error) { setMessage(error instanceof Error ? error.message : "設定を取得できませんでした"); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal(); void load();
    return () => { previous?.focus(); };
  }, []);
  function close() { if (busy) return; if ((!dirty && !uncertain) || window.confirm(uncertain ? "保存結果を確認できていません。閉じますか？" : "変更を破棄して閉じますか？")) onClose(); }
  function edit(update: (value: QuestionProfile) => void) { if (!draft || busy || uncertain) return; const next = structuredClone(draft); update(next); setDraft(next); pending.current = null; setMessage(""); }
  async function save() {
    if (!draft || !snapshot || busy || conflict) return;
    pending.current ??= { profile: structuredClone(draft), expectedRevision: snapshot.revision, requestId: crypto.randomUUID() };
    setBusy(true); setMessage("保存しています…");
    try { await patchJson("/api/teacher/question-profile", pending.current); pending.current = null; setUncertain(false); onClose(); }
    catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 409) { setConflict(true); setUncertain(false); pending.current = null; setMessage("別の操作で設定が更新されました。変更内容を確認し、最新の設定を読み直してください。"); }
      else if (!status || status >= 500) { setUncertain(true); setMessage("保存結果を確認できませんでした。同じ内容で保存を再試行するか、最新の設定を読み直してください。"); }
      else { pending.current = null; setMessage(error instanceof Error ? error.message : "保存できませんでした"); }
    } finally { setBusy(false); }
  }
  const catalog = snapshot ? (tab === "compound" ? snapshot.catalog.compounds : snapshot.catalog.ions) : [];
  const assignments = draft ? (tab === "compound" ? draft.compoundDifficulties : draft.ionDifficulties) : {};
  return <dialog ref={dialog} className="question-profile-dialog" aria-labelledby="question-profile-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2 id="question-profile-title">難易度調整</h2><p>保存後に新しく作成するルームに反映されます。</p><nav aria-label="調整項目">{(["ratio", "ion", "compound"] as const).map((value, index) => <button type="button" key={value} aria-pressed={tab === value} onClick={() => { setTab(value); setSearch(""); setFilter("all"); }}>{["割合", "イオン", "化合物"][index]}</button>)}</nav></header>
    <div className="question-profile-scroll" aria-busy={busy}>
      {message && <p role="status">{message}</p>}
      {(!snapshot || conflict || uncertain) && <button type="button" disabled={busy} onClick={() => { if (!dirty || window.confirm("変更内容を破棄して最新の設定を読み直しますか？")) void load(); }}>最新の設定を読み直す</button>}
      {draft && snapshot && <fieldset disabled={busy || uncertain || conflict}>
        {tab === "ratio" ? <><p>錯イオンを含む問題を有効にした場合の割合です。端数は切り上げるため、少ない問題数では指定割合を上回ります。</p><div className="question-profile-rule-grid">{modes.flatMap(mode => difficulties.map(difficulty => {
          const rule = draft.rules[mode][difficulty];
          const complexLabel = mode === "ion" ? "錯イオン" : "錯イオンを含む問題";
          const items = (mode === "ion" ? snapshot.catalog.ions : snapshot.catalog.compounds).filter(item => !item.complex);
          const categories = [...new Set(items.map(item => item.category))];
          const overrides = mode === "ion" ? draft.ionDifficulties : draft.compoundDifficulties;
          const candidateCounts = profileCandidateCounts(mode === "ion" ? snapshot.catalog.ions : snapshot.catalog.compounds, overrides, mode, difficulty, rule.categoryWeights);
          const weights = categories.map(category => rule.categoryWeights !== null ? (rule.categoryWeights[category] ?? 0) : items.filter(item => item.category === category && candidateEnabled(item, overrides, mode, difficulty, null)).length);
          const total = weights.reduce((sum, weight) => sum + weight, 0);
          return <section className="question-profile-rule" key={`${mode}-${difficulty}`}><h3>{mode === "ion" ? "イオン" : "化合物"}・{difficultyLabels[difficulty]}</h3><label>{complexLabel}の割合（%）<input type="number" min={difficulty === "hard" ? 20 : 0} max={100} value={rule.complexPercent} onChange={event => edit(value => { value.rules[mode][difficulty].complexPercent = Math.max(difficulty === "hard" ? 20 : 0, Math.min(100, Number(event.target.value))); })} /></label>{difficulty === "hard" && <p>ややむずは20%以上です。</p>}<p>5 / 10 / 15問での該当問題数：{complexCountPreview(rule.complexPercent).join(" / ")}問</p><p>候補数：通常 {candidateCounts.ordinary}項目 / {complexLabel} {candidateCounts.complex}項目（解答方式によって実際の候補数は変わる場合があります）</p><p>追加問題OFFでは通常の候補が15項目以上必要です。ONで必要な候補数（通常 / {complexLabel}）：{[5, 10, 15].map(count => { const complex = Math.ceil(count * rule.complexPercent / 100); return `${count}問：${count - complex} / ${complex}${candidateCounts.ordinary < count - complex || candidateCounts.complex < complex ? "（不足）" : ""}`; }).join("、")}</p><h4>通常の問題のカテゴリ配分</h4><p>{rule.categoryWeights === null ? "各項目を均等に抽選します。" : "重みの比率でカテゴリを抽選します。"} {complexLabel}の割合は上の設定で調整します。</p>{categories.map((category, index) => <label className="question-profile-weight" key={category}>{categoryLabels[category] ?? category}<input type="number" min={0} max={10000} step={1} aria-label={`${mode === "ion" ? "イオン" : "化合物"} ${difficultyLabels[difficulty]} ${categoryLabels[category] ?? category}の重み`} value={weights[index]} onChange={event => edit(value => { const target = value.rules[mode][difficulty]; target.categoryWeights ??= Object.fromEntries(categories.map((key, i) => [key, weights[i]])); target.categoryWeights[category] = Math.max(0, Math.min(10000, Number(event.target.value))); })} /><span>{total ? (weights[index] / total * 100).toFixed(1) : "0.0"}%</span></label>)}<button type="button" onClick={() => edit(value => { value.rules[mode][difficulty].categoryWeights = null; })}>各項目を均等に戻す</button></section>;
        }))}</div></> : <><div className="question-profile-filters"><label>名称・化学式で検索<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label><label>難易度<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">すべて</option>{Object.entries(difficultyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>種類<select value={complexFilter} onChange={event => setComplexFilter(event.target.value)}><option value="all">すべて</option><option value="ordinary">通常</option><option value="complex">{tab === "compound" ? "錯イオンを含む" : "錯イオン"}</option></select></label></div><p>「出題しない」の項目は選択対象から除外されます。</p>{catalog.filter(item => (!search || `${item.name} ${item.formula}`.toLowerCase().includes(search.toLowerCase())) && (filter === "all" || itemDifficulty(item, assignments) === filter) && (complexFilter === "all" || item.complex === (complexFilter === "complex"))).map(item => <div className="question-profile-item" key={item.id}><span><strong>{item.formula}</strong> {item.name}<small>{categoryLabels[item.category] ?? item.category}{item.complex ? (tab === "compound" ? "・錯イオンを含む" : "・錯イオン") : ""}</small></span><QuestionDifficultyToggle name={item.name} value={itemDifficulty(item, assignments)} disabled={busy || uncertain || conflict} onChange={difficulty => edit(value => { (tab === "compound" ? value.compoundDifficulties : value.ionDifficulties)[item.id] = difficulty; })} /></div>)}</>}
      </fieldset>}
    </div><footer><button type="button" disabled={busy} onClick={close}>キャンセル</button><button type="button" disabled={busy || !draft || !snapshot || conflict || (!dirty && !uncertain)} onClick={() => void save()}>{uncertain ? "同じ内容で保存を再試行" : "保存"}</button></footer>
  </dialog>;
}
