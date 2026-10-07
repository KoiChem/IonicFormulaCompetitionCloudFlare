"use client";

export function ParticipantSyncStatus({ text, action, onAction, disabled = false }: {
  text: string; action?: string; onAction?: () => void; disabled?: boolean;
}) {
  return <div className="play-status participant-sync-status" role="status" aria-live="polite">
    <span>{text}</span>
    {action && onAction && <button type="button" disabled={disabled} onClick={onAction}>{action}</button>}
  </div>;
}
