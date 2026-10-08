"use client";
import { useEffect, useRef, useState } from "react";
import type { FormulaCharge, FormulaEntry } from "../shared/types";
import { alternateCaseLetter, classifyBracketFlick, classifyCaseFlick, shouldHandleFormulaLetterClick } from "./formula-keyboard-gesture";

// Layout and case-flick thresholds follow IonicFormula js/app.js and
// js/formula-keyboard-gesture.js (source checkout reviewed 2026-10-02).
const ROWS = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
const NUMBERS = ["1", "2", "3", "4", "5", "6", "7", "8", "(", ")"];
export const FORMULA_TOKENS = [...new Set([...ROWS.join(""), ...ROWS.join("").toLowerCase(), ...NUMBERS, "[", "]"])] as const;
export const CHARGE_OPTIONS: readonly FormulaCharge[] = (["+", "-"] as const).flatMap(sign => (sign === "+" ? [1, 2, 3] : [1, 2, 3, 4]).map(magnitude => ({ sign, magnitude, source: "chargeButton" as const })));
const CHARGES = CHARGE_OPTIONS;

export function FormulaKeyboard({ value, onChange, onSubmit = () => {}, showSubmit = true, submitEnabled = showSubmit, disabled, kind = "ion", resetKey }: { value: FormulaEntry; onChange(value: FormulaEntry): void; onSubmit?(): void; showSubmit?: boolean; submitEnabled?: boolean; disabled?: boolean; kind?: "ion" | "compound"; resetKey?: string }) {
  const [uppercase, setUppercase] = useState(true);
  const pointer = useRef<{ id: number; x: number; y: number; letter: string; uppercase: boolean; bracket: boolean; button: HTMLButtonElement } | null>(null);
  const swipeStart = useRef<number | null>(null);
  useEffect(() => { setUppercase(true); pointer.current = null; }, [resetKey]);
  const insert = (token: string) => {
    const tokens = [...value.tokens]; tokens.splice(value.cursor, 0, token);
    onChange({ ...value, tokens, cursor: value.cursor + 1 });
  };
  const backspace = () => {
    if (value.cursor === value.tokens.length && value.charge) { onChange({ ...value, charge: null }); return; }
    if (value.cursor === 0) return;
    const tokens = [...value.tokens]; tokens.splice(value.cursor - 1, 1);
    onChange({ ...value, tokens, cursor: value.cursor - 1 });
  };
  const bracketValue = (character: string) => uppercase ? character : character === "(" ? "[" : "]";
  const alternateBracket = (character: string) => ({ "(": "[", ")": "]", "[": "(", "]": ")" })[character]!;
  const actionFor = (current: NonNullable<typeof pointer.current>, x: number, y: number) => current.bracket
    ? classifyBracketFlick(x - current.x, y - current.y)
    : classifyCaseFlick(x - current.x, y - current.y, current.uppercase);
  const letter = (character: string, bracket = false) => <button key={character} type="button" disabled={disabled} aria-label={bracket ? `${bracketValue(character)}。シフトで括弧を切り替え、上下フリックで別の括弧を入力` : undefined}
    onPointerDown={event => { if (!event.isPrimary || event.button !== 0 || disabled) return; event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, letter: bracket ? bracketValue(character) : character, uppercase, bracket, button: event.currentTarget }; }}
    onPointerMove={event => { const current = pointer.current; if (!current || current.id !== event.pointerId) return; event.currentTarget.classList.toggle("is-case-flick-ready", actionFor(current, event.clientX, event.clientY) === "alternate"); }}
    onPointerUp={event => { const current = pointer.current; if (!current || current.id !== event.pointerId) return; const action = actionFor(current, event.clientX, event.clientY); current.button.classList.remove("is-case-flick-ready"); pointer.current = null; event.preventDefault(); if (disabled || action === "cancel") return; insert(action === "alternate" ? (current.bracket ? alternateBracket(current.letter) : alternateCaseLetter(current.letter, current.uppercase)) : (current.bracket || current.uppercase ? current.letter : current.letter.toLowerCase())); }}
    onPointerCancel={event => { if (pointer.current?.id === event.pointerId) pointer.current.button.classList.remove("is-case-flick-ready"); pointer.current = null; }}
    onLostPointerCapture={() => { pointer.current?.button.classList.remove("is-case-flick-ready"); pointer.current = null; }}
    onClick={event => { const native = event.nativeEvent as MouseEvent & { pointerType?: string }; if (shouldHandleFormulaLetterClick(native.detail, native.pointerType)) insert(bracket ? bracketValue(character) : uppercase ? character : character.toLowerCase()); }}
    onKeyDown={event => { if (bracket && event.shiftKey && ["Enter", " "].includes(event.key)) { event.preventDefault(); if (!disabled && !event.repeat) insert(alternateBracket(bracketValue(character))); } }}>{bracket ? bracketValue(character) : uppercase ? character : character.toLowerCase()}</button>;
  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.key === "Enter" && submitEnabled) { event.preventDefault(); onSubmit(); return; }
    if (event.key === "Backspace") { event.preventDefault(); backspace(); return; }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); onChange({ ...value, cursor: Math.max(0, Math.min(value.tokens.length, value.cursor + (event.key === "ArrowLeft" ? -1 : 1))) }); return; }
    if (/^[A-Za-z1-8()[\]]$/u.test(event.key)) { event.preventDefault(); insert(event.key); }
  };
  return <div className={`formula-entry formula-keyboard ${kind === "ion" ? "ion-entry" : "compound-entry"}`}>
    <div className={`formula-composer ${showSubmit ? "" : "without-submit"}`}><div role="textbox" tabIndex={0} inputMode="none" className="formula-render" aria-label={kind === "ion" ? "イオン式" : "組成式"} onKeyDown={keyDown} onTouchStart={event => { swipeStart.current = event.changedTouches[0]?.clientX ?? null; }} onTouchEnd={event => { const end = event.changedTouches[0]?.clientX; if (swipeStart.current != null && end != null && Math.abs(end - swipeStart.current) >= 30) onChange({ ...value, cursor: Math.max(0, Math.min(value.tokens.length, value.cursor + (end < swipeStart.current ? 1 : -1))) }); swipeStart.current = null; }}>{value.tokens.length === 0 && !value.charge ? <span className="formula-placeholder" aria-hidden="true">{kind === "ion" ? "イオン式" : "組成式"}</span> : null}{value.tokens.map((token, index) => <span key={index}>{value.cursor === index && <i className="formula-caret" />}{/^\d+$/u.test(token) ? <sub>{token}</sub> : token}</span>)}{value.tokens.length + (value.charge ? 1 : 0) > 0 && value.cursor === value.tokens.length && <i className="formula-caret" />}{value.charge && <sup className="formula-charge">{value.charge.magnitude === 1 ? "" : value.charge.magnitude}{value.charge.sign === "+" ? "＋" : "−"}</sup>}</div>{showSubmit && <button type="button" className="answer-submit" aria-label="解答をチェック" disabled={disabled || value.tokens.length === 0 || (kind === "ion" && !value.charge)} onClick={onSubmit}>チェック</button>}</div>
    <div className="key-row number-keys">{NUMBERS.map(token => token === "(" || token === ")" ? letter(token, true) : <button type="button" key={token} disabled={disabled} onClick={() => insert(token)}>{token}</button>)}</div>
    <div className="letter-keys" aria-label="化学式キーボード。大文字表示では下フリック、小文字表示では上フリックで反対の文字を入力できます">
      <div className="key-row">{[...ROWS[0]].map(character => letter(character))}</div>
      <div className="key-row">{[...ROWS[1]].map(character => letter(character))}</div>
      <div className="key-row"><button type="button" disabled={disabled} aria-label={uppercase ? "小文字に切り替える" : "大文字に切り替える"} aria-pressed={uppercase} onClick={() => setUppercase(!uppercase)}>⇧</button>{[...ROWS[2]].map(character => letter(character))}<button type="button" disabled={disabled} aria-label="1文字削除" onClick={backspace}>⌫</button></div>
    </div>
    <div className="keyboard-controls">{kind === "ion" && CHARGES.map(charge => <button type="button" key={`${charge.magnitude}${charge.sign}`} disabled={disabled} aria-label={`電荷 ${charge.magnitude}${charge.sign}`} onClick={() => onChange({ ...value, charge })}>{charge.magnitude === 1 ? "" : charge.magnitude}{charge.sign === "+" ? "＋" : "−"}</button>)}<button type="button" disabled={disabled} aria-label="カーソルを左へ" onClick={() => onChange({ ...value, cursor: Math.max(0, value.cursor - 1) })}>←</button><button type="button" disabled={disabled} aria-label="カーソルを右へ" onClick={() => onChange({ ...value, cursor: Math.min(value.tokens.length, value.cursor + 1) })}>→</button><button type="button" disabled={disabled} onClick={() => onChange({ tokens: [], cursor: 0, charge: null })}>クリア</button></div>
  </div>;
}
