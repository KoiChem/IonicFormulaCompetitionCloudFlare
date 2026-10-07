export type PendingJoin = { token: string; requestId: string; nickname: string };

export const joinDraftKey = (roomId: string) => `ionic-formula-competition:join-draft:${roomId}`;
export const reentryNicknameKey = (roomId: string) => `ionic-formula-competition:reentry-nickname:${roomId}`;

export function loadPendingJoin(storage: Storage, roomId: string): PendingJoin | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(joinDraftKey(roomId)) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const draft = value as Record<string, unknown>;
    if (typeof draft.token !== "string" || typeof draft.requestId !== "string" || typeof draft.nickname !== "string") return null;
    return { token: draft.token, requestId: draft.requestId, nickname: draft.nickname };
  } catch { return null; }
}

export function beginPendingJoin(
  storage: Storage, roomId: string, nickname: string,
  makeToken: () => string, makeRequestId: () => string,
): PendingJoin {
  const existing = loadPendingJoin(storage, roomId);
  if (existing) return existing;
  const draft = { token: makeToken(), requestId: makeRequestId(), nickname };
  storage.setItem(joinDraftKey(roomId), JSON.stringify(draft));
  return draft;
}

export function clearPendingJoin(storage: Storage, roomId: string): void {
  storage.removeItem(joinDraftKey(roomId));
}

export function completePendingJoin(storage: Storage, roomId: string, draft: PendingJoin, participantId: string): boolean {
  const current = loadPendingJoin(storage, roomId);
  if (!current || current.token !== draft.token || current.requestId !== draft.requestId || current.nickname !== draft.nickname) return false;
  storage.setItem(`ionic-formula-competition:room:${roomId}`, JSON.stringify({ token: draft.token, participantId }));
  clearPendingJoin(storage, roomId);
  return true;
}

export function clearPreviousParticipantSession(storage: Storage, roomId: string): void {
  for (const key of ["pending-action", "feedback-shown", "wait-credit", "wait-observation"]) {
    storage.removeItem(`ionic-formula-competition:${key}:${roomId}`);
  }
}
