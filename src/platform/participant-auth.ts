import type { PersistenceDatabase } from "../persistence/db";

export type ParticipantIdentity = {
  readonly participantId: string;
  readonly tokenHash: string;
  readonly status: "ACTIVE" | "FINISHED" | "REMOVED";
  readonly nickname: string;
};

export class ParticipantAuthorizationError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: "participant_authentication_required" | "participant_forbidden",
    message: string,
  ) {
    super(message);
    this.name = "ParticipantAuthorizationError";
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function createParticipantToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function readParticipantBearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    throw new ParticipantAuthorizationError(
      401,
      "participant_authentication_required",
      "参加者トークンが必要です",
    );
  }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization);
  if (!match) {
    throw new ParticipantAuthorizationError(403, "participant_forbidden", "参加者トークンが不正です");
  }
  return match[1];
}

export async function hashParticipantToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function identifyParticipant(
  database: PersistenceDatabase,
  request: Request,
  roomId: string,
): Promise<ParticipantIdentity> {
  const token = readParticipantBearerToken(request);
  const tokenHash = await hashParticipantToken(token);
  const participant = await database.prepare(`
    SELECT id, status, nickname FROM participants
    WHERE room_id = ? AND token_hash = ?
  `).bind(roomId, tokenHash).first<{ id: string; status: ParticipantIdentity["status"]; nickname: string }>();
  if (!participant) {
    throw new ParticipantAuthorizationError(403, "participant_forbidden", "参加者として確認できません");
  }
  const claimedId = request.headers.get("x-participant-id");
  if (claimedId && claimedId !== participant.id) {
    throw new ParticipantAuthorizationError(403, "participant_forbidden", "別の参加者の情報は取得できません");
  }
  return { participantId: participant.id, tokenHash, status: participant.status, nickname: participant.nickname };
}

export async function requireParticipant(database: PersistenceDatabase, request: Request, roomId: string): Promise<ParticipantIdentity> {
  const participant = await identifyParticipant(database, request, roomId);
  if (participant.status === "REMOVED") {
    throw new ParticipantAuthorizationError(403, "participant_forbidden", "参加者として確認できません");
  }
  return participant;
}
