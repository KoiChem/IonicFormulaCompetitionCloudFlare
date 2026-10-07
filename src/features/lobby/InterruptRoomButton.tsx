"use client";
import { useRef, useState } from "react";
import { ConfirmDialog } from "../setup/ConfirmDialog";

export function InterruptRoomButton({ busy, onInterrupt }: { busy: boolean; onInterrupt(): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); };
  const confirm = async () => { setError(""); try { await onInterrupt(); close(); } catch (reason: any) { setError(reason.message ?? "中断できませんでした"); close(); } };
  return <><button ref={trigger} type="button" className="secondary-button" disabled={busy} onClick={() => { setError(""); setOpen(true); }}>中断</button>
    {error && <p role="alert" className="error">{error}</p>}
    <ConfirmDialog open={open} title="競技を中断しますか？" description="その時点の成績で結果を確定します。この競技は再開できません。" cancelLabel="戻る" confirmLabel="中断して結果を表示" busy={busy} onClose={close} onConfirm={() => { void confirm(); }}/></>;
}
