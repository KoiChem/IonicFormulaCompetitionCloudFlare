"use client";
import { useEffect, useRef } from "react";

export function ConfirmDialog({ open, title, description, cancelLabel, confirmLabel, busy = false, onClose, onConfirm }: {
  open: boolean; title: string; description: string; cancelLabel: string; confirmLabel: string;
  busy?: boolean; onClose(): void; onConfirm(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const safeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) { dialog.showModal(); safeRef.current?.focus(); }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={dialogRef} className="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-description"
    onCancel={(event) => { if (busy) event.preventDefault(); else onClose(); }}
    onClick={(event) => { if (event.target === dialogRef.current && !busy) onClose(); }}>
    <h2 id="confirm-title">{title}</h2><p id="confirm-description">{description}</p>
    <div className="confirm-actions"><button ref={safeRef} type="button" disabled={busy} onClick={onClose}>{cancelLabel}</button><button type="button" className="primary-action" disabled={busy} onClick={onConfirm}>{busy ? "処理中…" : confirmLabel}</button></div>
  </dialog>;
}
