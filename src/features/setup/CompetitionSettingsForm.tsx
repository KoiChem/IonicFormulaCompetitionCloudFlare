"use client";

import { useId } from "react";
import type { IonicFormulaGameSettings } from "../../games/ionic-formula/shared/types";

export const DEFAULT_SETTINGS: IonicFormulaGameSettings = { questionCount: 10, timeLimitMinutes: 5, gradingMode: "immediate", mode: "ion", difficulty: "normal", complexEnabled: false, ionAnswer: "random", compoundPrompts: { formula: true, name: true }, compoundAnswer: "random" };

export function settingsSummary(value: IonicFormulaGameSettings): string {
  const mode = value.mode === "ion" ? "イオン" : "化合物";
  const difficulty = value.complexOnly === true ? "錯イオンのみ" : `${value.difficulty === "hard" ? "ややむず" : "やさしめ"}${value.complexEnabled === true ? "・錯イオンあり" : ""}`;
  const prompt = value.mode === "ion" ? "イオン式・イオン名" :
    value.compoundPrompts?.formula && value.compoundPrompts?.name ? "イオン式・イオン名" :
    value.compoundPrompts?.formula ? "イオン式" : "イオン名";
  const answer = value.mode === "ion" ?
    ({ formula: "イオン式", name: "イオン名", random: "式または名" } as const)[value.ionAnswer] :
    ({ formula: "組成式", name: "化合物名", random: "式または名", both: "式と名" } as const)[value.compoundAnswer];
  return `${value.questionCount}問・${value.timeLimitMinutes}分・${value.gradingMode === "deferred" ? "まとめて判定" : "問題毎判定"}・${mode}・${difficulty}・出題 ${prompt}・解答 ${answer}`;
}

type Props = { value: IonicFormulaGameSettings; onChange(value: IonicFormulaGameSettings): void; disabled?: boolean };
function Choice<T extends string | number>({ legend, values, value, label, onChange, disabled }: { legend: string; values: readonly T[]; value: T; label(value: T): string; onChange(value: T): void; disabled?: boolean }) {
  return <fieldset disabled={disabled}><legend>{legend}</legend><div className="choice-grid">{values.map((item) => <button aria-pressed={item === value} className="choice" key={item} onClick={() => onChange(item)} type="button">{label(item)}</button>)}</div></fieldset>;
}
export function CompetitionSettingsForm({ value, onChange, disabled }: Props) {
  const tooltipId = useId();
  const complexOnly = value.complexOnly === true;
  const update = <K extends keyof IonicFormulaGameSettings>(key: K, next: IonicFormulaGameSettings[K]) => onChange({ ...value, [key]: next });
  return <div className="settings-form">
    <div className="settings-group">
    <Choice legend="問題数" values={[5, 10, 15] as const} value={value.questionCount} label={(n) => `${n}問`} onChange={(n) => update("questionCount", n)} disabled={disabled} />
    <Choice legend="制限時間" values={[3,4,5,6,7,8,9,10] as const} value={value.timeLimitMinutes} label={(n) => `${n}分`} onChange={(n) => update("timeLimitMinutes", n)} disabled={disabled} />
    <Choice legend="判定方式" values={["immediate", "deferred"] as const} value={value.gradingMode ?? "immediate"} label={(mode) => mode === "immediate" ? "問題毎判定" : "まとめて判定"} onChange={(mode) => update("gradingMode", mode)} disabled={disabled} />
    <p className="settings-hint">{value.gradingMode === "deferred" ? "最後に提出して採点します" : "答えるたびに正誤がわかります"}</p>
    </div>
    <div className="settings-group">
    <Choice legend="出題" values={["ion", "compound"] as const} value={value.mode} label={(n) => n === "ion" ? "イオン" : "化合物"} onChange={(n) => update("mode", n)} disabled={disabled} />
    <fieldset disabled={disabled} className="difficulty-with-complex"><legend>難易度</legend><div className="difficulty-controls"><div className="choice-grid">{(["normal", "hard"] as const).map(level => <button type="button" className="choice" key={level} aria-pressed={!complexOnly && value.difficulty === level} onClick={() => onChange({ ...value, difficulty: level, complexOnly: false })}>{level === "normal" ? "やさしめ" : "ややむず"}</button>)}<span className="complex-only-option"><button type="button" className="choice" aria-pressed={complexOnly} aria-describedby={tooltipId} onClick={() => update("complexOnly", true)}>錯のみ</button><span id={tooltipId} role="tooltip" className="complex-only-tooltip">難易度・出題ON/OFF設定にかかわらず、すべての錯イオン教材から出題</span></span></div><button type="button" disabled={complexOnly} className="choice complex-toggle" aria-pressed={complexOnly || value.complexEnabled === true} onClick={() => update("complexEnabled", value.complexEnabled !== true)}>錯イオン<span className="complex-toggle-state">{complexOnly || value.complexEnabled === true ? "ON" : "OFF"}</span></button></div></fieldset>
    {value.mode === "ion" ? <Choice legend="答え方" values={["formula", "name", "random"] as const} value={value.ionAnswer} label={(n) => ({ formula: "イオン式", name: "イオン名", random: "式 or 名" })[n]} onChange={(n) => update("ionAnswer", n)} disabled={disabled} /> : <><fieldset disabled={disabled}><legend>化合物の出題</legend><div className="choice-grid">{(["formula", "name"] as const).map((key) => <button type="button" className="choice" aria-pressed={value.compoundPrompts[key]} key={key} onClick={() => { const next = { ...value.compoundPrompts, [key]: !value.compoundPrompts[key] }; if (next.formula || next.name) update("compoundPrompts", next); }}>{key === "formula" ? "イオン式" : "イオン名"}</button>)}</div></fieldset><Choice legend="答え方" values={["formula", "name", "random", "both"] as const} value={value.compoundAnswer} label={(n) => ({ formula: "組成式", name: "化合物名", random: "式 or 名", both: "式 ＆ 名" })[n]} onChange={(n) => update("compoundAnswer", n)} disabled={disabled} /></>}
    </div>
    <p className="settings-summary" aria-live="polite">{settingsSummary(value)}</p>
  </div>;
}
