import { appPath } from '../../web/routing';
"use client";
import { useRef, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

export function ReturnHomeButton({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); };
  return <><button ref={trigger} type="button" className="secondary-button" disabled={disabled} onClick={() => setOpen(true)}>ホームへ戻る</button>
    <ConfirmDialog open={open} title="ホームに戻りますか？" description="入力中の設定は保存されません。" cancelLabel="戻らない" confirmLabel="ホームへ戻る" onClose={close} onConfirm={() => { location.href = appPath("/"); }}/></>;
}
