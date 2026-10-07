"use client";
import { useEffect, useRef, useState } from "react";
import { patchJson } from "../play/useRoomSync";
import { prepareNicknameRequest, type NicknameRequest } from "./nickname-request";
import { saveNickname } from "../setup/saved-nickname";

export function NicknameEditor({ roomId, token, nickname, revision, onSaved }: {
  roomId: string;
  token: string;
  nickname: string;
  revision: number;
  onSaved(): Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(nickname);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<NicknameRequest | null>(null);
  useEffect(() => { if (!editing) setDraft(nickname); }, [nickname, editing]);
  useEffect(() => { saveNickname(localStorage, nickname); }, [nickname]);
  useEffect(() => {
    if (pending.current && revision > pending.current.expectedParticipantRevision
      && nickname === pending.current.nickname.trim()) {
      pending.current = null;
      setEditing(false);
      setError("");
    }
  }, [nickname, revision]);
  const save = async () => {
    setBusy(true); setError("");
    const body = prepareNicknameRequest(pending.current, revision, draft);
    pending.current = body;
    try {
      await patchJson(`/api/rooms/${encodeURIComponent(roomId)}/nickname`, body, { token });
      saveNickname(localStorage, body.nickname);
      pending.current = null;
      setEditing(false);
    } catch (reason: any) {
      if (typeof reason.status === "number" && reason.status < 500 && reason.status !== 408 && reason.status !== 429 && reason.code !== "database_conflict") pending.current = null;
      setError(reason.code === "conflict" ? "同じ名前の参加者がいます。別の名前を入力してください" : reason.status === 409 ? "開始したため名前を変更できなかったか、別の画面で更新されました" : reason.message);
    } finally { setBusy(false); void onSaved().catch(() => {}); }
  };
  return <div className="nickname-editor"><p>登録名：{nickname}</p>{editing ? <><label htmlFor="lobby-nickname">名前を変更</label><input id="lobby-nickname" value={draft} maxLength={16} disabled={busy} onChange={event => setDraft(event.target.value)} /><div className="nickname-actions"><button type="button" disabled={busy || !draft.trim()} onClick={() => void save()}>保存</button><button type="button" disabled={busy} onClick={() => { pending.current = null; setEditing(false); setDraft(nickname); setError(""); }}>キャンセル</button></div></> : <button type="button" onClick={() => { setDraft(nickname); setEditing(true); }}>名前を変更</button>}{error && <p role="alert" className="error">{error}</p>}</div>;
}
