import type { IonicFormulaGameSettings } from "../../games/ionic-formula/shared/types";

export type HistoryCandidate = {
  roomId: string;
  role: "teacher" | "participant";
  kind?: "class" | "mate";
  createdAtMs?: number;
  expiresAtMs?: number;
  settings?: IonicFormulaGameSettings;
};
const INDEX_KEY = "ionic-formula-competition:history:v1";
const PREFIX = "ionic-formula-competition:";
const validRoomId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function discoverHistoryCandidates(storage: Pick<Storage, "length" | "key" | "getItem">): HistoryCandidate[] {
  const rooms = new Map<string, HistoryCandidate>();
  const add = (candidate: HistoryCandidate) => {
    if (!validRoomId(candidate.roomId)) return;
    const key = `${candidate.role}:${candidate.roomId}`;
    rooms.set(key, { ...candidate, ...rooms.get(key) });
  };
  try {
    const saved = JSON.parse(storage.getItem(INDEX_KEY) ?? "[]") as unknown;
    if (Array.isArray(saved)) for (const item of saved.slice(-200)) {
      if (item && typeof item === "object" && "roomId" in item && "role" in item && (item.role === "teacher" || item.role === "participant") && validRoomId(item.roomId)) {
        const saved = item as HistoryCandidate;
        add({ roomId: saved.roomId, role: saved.role,
          ...(saved.kind === "class" || saved.kind === "mate" ? { kind: saved.kind } : {}),
          ...(typeof saved.createdAtMs === "number" && Number.isFinite(saved.createdAtMs) ? { createdAtMs: saved.createdAtMs } : {}),
          ...(typeof saved.expiresAtMs === "number" && Number.isFinite(saved.expiresAtMs) ? { expiresAtMs: saved.expiresAtMs } : {}),
          ...(saved.settings && typeof saved.settings === "object" ? { settings: saved.settings } : {}),
        });
      }
    }
  } catch { /* older or damaged index */ }
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key) continue;
      if (key.startsWith(`${PREFIX}room:`)) {
        const roomId = key.slice(`${PREFIX}room:`.length);
        try { const credential = JSON.parse(storage.getItem(key) ?? "null"); if (typeof credential?.token === "string" && typeof credential?.participantId === "string") add({ roomId, role: "participant" }); } catch { /* bad credential */ }
      }
      if (key.startsWith(`${PREFIX}meta:`)) {
        const roomId = key.slice(`${PREFIX}meta:`.length);
        try { const meta = JSON.parse(storage.getItem(key) ?? "null"); if (typeof meta?.joinCode === "string" && meta.host !== true) add({ roomId, role: "teacher" }); } catch { /* bad metadata */ }
      }
    }
  } catch { /* private browsing may forbid storage */ }
  return [...rooms.values()].slice(-200);
}

export function rememberHistoryRoom(storage: Storage, candidate: HistoryCandidate): void {
  try {
    const previous = discoverHistoryCandidates(storage).filter(item => item.roomId !== candidate.roomId || item.role !== candidate.role);
    storage.setItem(INDEX_KEY, JSON.stringify([...previous, candidate].slice(-200)));
  } catch { /* history must never block joining or creation */ }
}
