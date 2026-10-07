"use client";
import { useRef, useState } from "react";
import { ConfirmDialog } from "../setup/ConfirmDialog";

export function EndRoomButton({ busy, onEnd }: { busy: boolean; onEnd(): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); };
  const confirm = async () => { setError(""); try { await onEnd(); } catch (reason: any) { setError(reason.message ?? "終了できませんでした"); close(); } };
  return <><button ref={trigger} type="button" className="secondary-button" disabled={busy} onClick={() => { setError(""); setOpen(true); }}>終了</button>
    {error && <p role="alert" className="error">{error}</p>}
    <ConfirmDialog open={open} title="このルームを終了しますか？" description="参加者は参加・開始できなくなります。成績と順位は作成されません。" cancelLabel="戻る" confirmLabel="終了する" busy={busy} onClose={close} onConfirm={() => { void confirm(); }}/></>;
}
