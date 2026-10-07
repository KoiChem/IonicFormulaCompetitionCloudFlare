import { joinQrPath } from "../setup/join-qr";
"use client";
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { RoomView, ParticipantState } from "../play/useRoomSync";
import { settingsSummary } from "../setup/CompetitionSettingsForm";
import type { IonicFormulaGameSettings } from "../../games/ionic-formula/shared/types";
import { primeAudio, savedSoundLevel } from "../play/audio-feedback";
import { LobbyName } from "./LobbyName";

export function Lobby({ room, participants = [], joinCode, canStart, onStart, onRemove, ownerParticipantId, busy }: { room: RoomView; participants?: ParticipantState[]; joinCode?: string; canStart: boolean; onStart?(): void; onRemove?(participant: ParticipantState): void; ownerParticipantId?: string; busy?: boolean }) {
  const [joinUrl, setJoinUrl] = useState(joinQrPath(room.id, joinCode ?? ""));
  useEffect(() => setJoinUrl(`${location.origin}${joinQrPath(room.id, joinCode ?? "")}`), [room.id, joinCode]);
  const settings = room.settings as IonicFormulaGameSettings;
  return <section className={`panel lobby-panel ${room.kind === "class" ? "class-lobby" : "mate-lobby"}`} aria-label="競技への招待と参加者一覧">
    {joinCode ? <div className="join-share"><div className="code"><span>参加コード</span><strong>{joinCode}</strong></div><QRCodeSVG value={joinUrl} size={420} level="M" marginSize={2} role="img" aria-label={`参加用QRコード ${joinUrl}`} /><a href={joinUrl}>{joinUrl}</a></div> : null}
    <div className="lobby-settings settings-summary"><p>競技設定：{settingsSummary(settings)}</p>{onStart ? <button type="button" className="primary-action" disabled={!canStart || busy} onClick={() => { primeAudio(savedSoundLevel()); onStart(); }}>{busy ? "処理を確認中…" : room.playProtocolVersion === 2 ? "問題を準備して開始" : "5秒後に開始"}</button> : null}</div>
    <p className="participant-count"><strong>{participants.length}人</strong>が参加中</p>
    {participants.length ? <ul className="participant-list">{participants.map((p) => <li key={p.id}><LobbyName nickname={p.nickname}/>{onRemove && p.id !== ownerParticipantId ? <button type="button" className="remove-action" disabled={busy} onClick={() => onRemove(p)} aria-label={`${p.nickname}さんを参加者から除外`} title="参加者から除外"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2m3 0-1 13H7L6 7m4 4v6m4-6v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg></button> : null}</li>)}</ul> : <p className="empty-roster">参加者が表示されるまでお待ちください。</p>}
  </section>;
}
