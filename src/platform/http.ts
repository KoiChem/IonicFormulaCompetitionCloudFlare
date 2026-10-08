import { questionProfileCatalog, validateQuestionProfileShape } from "../games/ionic-formula/shared/question-profile";
import { readQuestionProfile, readRoomQuestionProfile, updateQuestionProfile } from "../persistence/question-profiles";
import { CHEMISTRY_CONTENT_VERSION } from "../games/ionic-formula/shared/complex-policy";
import "./server-only";

import { effectiveRoomState } from "../competition-core/state-machine";
import type { RoomState } from "../competition-core/types";
import { PUBLIC_CONFIG } from "../config/public";
import { type ServerConfig } from "../config/server";
import { generateQuestionSet, validateGameSettings, validateQuestionProfile } from "../games/ionic-formula/server/question-generator";
import { EVALUATOR_VERSION } from "../games/ionic-formula/shared/answer-evaluator";
import type {
  AnswerFieldId,
  FormulaEntry,
  InternalQuestion,
  IonicFormulaGameSettings,
  PublicQuestion,
} from "../games/ionic-formula/shared/types";
import { applyPlayerAction } from "../persistence/actions";
import { cleanupExpired } from "../persistence/cleanup";
import {
  PersistenceConflictError,
  loadCommandReceipt,
  type PersistenceDatabase,
  type PreparedSql,
} from "../persistence/db";
import { joinRoom, removeParticipant as removeParticipantCommand, renameParticipant as renameParticipantCommand } from "../persistence/participants";
import { finalizeRoom, interruptRoom as interruptRoomCommand, loadAuthorizedResult } from "../persistence/results";
import { cancelRoom as cancelRoomCommand, createRoom, startRoom } from "../persistence/rooms";
import { updateRoomSettingsCommand, updateSiteSettingsCommand } from "../persistence/settings";
import { prepareV2Room, loadV2Manifest, loadV2RoomPhase, markV2Ready, cancelV2Preparation } from "../persistence/v2-manifest";
import { applyV2Operations, takeOverV2Writer } from "../persistence/v2-operations";
import { collectV2Room, maybeFinalizeV2Room } from "../persistence/v2-results";
import { decodeDisplayAnswer } from "./result-answer";
import type { V2Operation } from "../competition-core/v2-operations";
import {
  hashParticipantToken,
  identifyParticipant,
  ParticipantAuthorizationError,
  readParticipantBearerToken,
  requireParticipant,
} from "./participant-auth";
import {
  requireTeacher,
  requireVerifiedTeacher,
  normalizeTeacherEmail,
  TeacherIdentityError,
  unavailableTeacherIdentityProvider,
  type TeacherIdentity,
  type TeacherIdentityProvider,
} from "./teacher-identity";

const MAX_BODY_BYTES = 4_096;
const MAX_OPERATION_BODY_BYTES = 128 * 1024;
const MAX_ANSWER_LENGTH = 128;
const LAZY_CLEANUP_LIMIT = 25;
const JOIN_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export type RouteParameters = { readonly id: string };

export type ApiDependencies = {
  readonly database: PersistenceDatabase;
  readonly teacherIdentity: TeacherIdentityProvider;
  readonly serverConfig: ServerConfig;
  readonly now: () => number;
  readonly random: () => number;
  readonly randomUUID: () => string;
  /** Trusted gateway context, never populated from client JSON. */
  readonly skipLazyCleanup?: boolean;
  readonly snapshotRoom?: RoomRow;
  readonly snapshotParticipant?: Awaited<ReturnType<typeof identifyParticipant>>;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ParsedBody = {
  readonly value: Record<string, unknown>;
  readonly bodyHash: string;
};

export type RoomRow = {
  readonly id: string;
  readonly public_id: string;
  readonly join_code: string;
  readonly kind: "class" | "mate";
  readonly owner_teacher_id: string | null;
  readonly mate_host_id: string | null;
  readonly settings_json: string;
  readonly game_version: string;
  readonly v2_phase?: RoomState | null;
  readonly state: RoomState;
  readonly revision: number;
  readonly max_score: number;
  readonly created_at_ms: number;
  readonly start_at_ms: number | null;
  readonly deadline_at_ms: number | null;
  readonly expires_at_ms: number;
  readonly ended_at_ms: number | null;
  readonly end_reason: "normal" | "interrupted";
};

type ParticipantRow = {
  readonly joined_order: number;
  readonly id: string;
  readonly nickname: string;
  readonly status: "ACTIVE" | "FINISHED" | "REMOVED";
  readonly current_ordinal: number;
  readonly correct_count: number;
  readonly resolved_question_count: number;
  readonly revision: number;
  readonly elapsed_cs: number;
  readonly accepted_elapsed_ms: number;
  readonly wait_credit_ms: number;
  readonly timing_source: string;
};

function responseHeaders(): HeadersInit {
  return {
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
}

export function jsonResponse(value: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(responseHeaders());
  if (extraHeaders) new Headers(extraHeaders).forEach((headerValue, name) => headers.set(name, headerValue));
  return new Response(JSON.stringify(value), { status, headers });
}

function publicError(error: unknown): { status: number; code: string; message: string; retryAfter?: string } {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.retryAfterSeconds ? { retryAfter: String(error.retryAfterSeconds) } : {}),
    };
  }
  if (error instanceof PersistenceConflictError) {
    const status = [400, 401, 403, 404, 409, 410, 429, 503].includes(error.status) ? error.status : 409;
    const messages: Partial<Record<typeof error.code, string>> = {
      capacity: "定員に達しました",
      active_room_exists: "終了していないメイトマッチがあります",
      database_conflict: "保存が競合しました。同じ requestId で再試行してください",
      deadline: "制限時間を過ぎています",
      expired: "このルームの閲覧期限は終了しました",
      invalid_state: "現在の状態では操作できません",
      mate_disabled: "メイトマッチは現在利用できません",
      not_authorized: "この情報を閲覧する権限がありません",
      not_found: "ルームが見つかりません",
      participant_not_found: "参加者が見つかりません",
      not_ready: "まだ開始できません",
      rate_limited: "短時間に作成できる回数を超えました",
      request_id_reused: "requestId が別の操作で使用されています",
      stale_participant_revision: "別の画面で状態が更新されました",
      stale_room_revision: "ルームの状態が更新されました",
      stale_question_profile: "出題設定が更新されました。最新の設定を読み直してください",
    };
    return {
      status,
      code: error.code,
      message: messages[error.code] ?? "要求を処理できません",
      ...(error.retryAfterSeconds ? { retryAfter: String(error.retryAfterSeconds) } : {}),
    };
  }
  if (error instanceof TeacherIdentityError || error instanceof ParticipantAuthorizationError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return { status: 400, code: "invalid_request", message: "入力内容を確認してください" };
  }
  if (
    typeof error === "object" && error !== null &&
    /(?:constraint|unique)/iu.test([
      String((error as { code?: unknown }).code ?? ""),
      String((error as { message?: unknown }).message ?? ""),
    ].join(" "))
  ) {
    return { status: 409, code: "conflict", message: "同じ内容がすでに使用されています" };
  }
  return { status: 503, code: "service_unavailable", message: "サービスを利用できません" };
}

export async function safe(handler: () => Promise<Response>, propagateSqlErrors=false): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if(propagateSqlErrors&&typeof (error as {code?:unknown})?.code==='string'&&/^[A-Z0-9]{5}$/.test((error as {code:string}).code))throw error;
    const mapped = publicError(error);
    if (mapped.status >= 500 || error instanceof TypeError || error instanceof RangeError) {
      // No error messages or bound data: only failure type and source frames.
      const candidate = error as { name?: unknown; code?: unknown; stack?: unknown };
      console.error(JSON.stringify({ event: 'handler_failed',
        category: typeof candidate?.name === 'string' ? candidate.name : 'Unknown',
        code: typeof candidate?.code === 'string' && /^[A-Z0-9]{5}$/.test(candidate.code) ? candidate.code : undefined,
        frames: typeof candidate?.stack === 'string' ? candidate.stack.split('\n').filter(line => /^\s+at\s/.test(line)).slice(0, 3).map(line => line.slice(0, 240)) : undefined }));
    }
    return jsonResponse(
      { error: { code: mapped.code, message: mapped.message } },
      mapped.status,
      mapped.retryAfter ? { "retry-after": mapped.retryAfter } : undefined,
    );
  }
}

async function resultSafe(handler: (requestId: string, setProtocolVersion: (version: number) => void) => Promise<Response>, operation: "results" | "result-summary"): Promise<Response> {
  const requestId = crypto.randomUUID();
  let protocolVersion: number | undefined;
  try { return await handler(requestId, version => { protocolVersion = version; }); }
  catch (error) {
    if (error instanceof ApiError || error instanceof PersistenceConflictError
      || error instanceof TeacherIdentityError || error instanceof ParticipantAuthorizationError) {
      const mapped = publicError(error);
      return jsonResponse({ error: { code: mapped.code, message: mapped.message } }, mapped.status,
        mapped.retryAfter ? { "retry-after": mapped.retryAfter } : undefined);
    }
    console.error(JSON.stringify({ event: "result_build_failed", operation, requestId, protocolVersion,
      category: error instanceof Error ? error.name : "Unknown" }));
    return jsonResponse({ error: { code: "result_build_failed", message: "結果の表示を準備できませんでした。再試行してください", requestId } },
      500, { "x-request-id": requestId });
  }
}

export function assertSameOriginMutation(request: Request): void {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin !== requestUrl.origin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError(403, "origin_forbidden", "別のサイトからの操作は受け付けません");
  }
  if (request.headers.get("x-competition-csrf") !== "1") {
    throw new ApiError(403, "csrf_forbidden", "操作の確認情報がありません");
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readMutationBody(request: Request, maxBodyBytes = MAX_BODY_BYTES): Promise<ParsedBody> {
  assertSameOriginMutation(request);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "JSONで送信してください");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maxBodyBytes)) {
    throw new ApiError(413, "body_too_large", "送信内容が大きすぎます");
  }
  if (!request.body) throw new ApiError(400, "invalid_json", "JSONを読み取れません");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    bytesRead += chunk.byteLength;
    if (bytesRead > maxBodyBytes) {
      await reader.cancel("body too large");
      throw new ApiError(413, "body_too_large", "送信内容が大きすぎます");
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "JSONを読み取れません");
  }
  if (!isRecord(value)) throw new ApiError(400, "invalid_request", "JSONオブジェクトが必要です");
  return { value, bodyHash: await sha256(text) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new ApiError(400, "invalid_request", "受け付けていない項目があります");
  }
}

export function stringValue(value: unknown, name: string, maximum = 128): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new ApiError(400, "invalid_request", `${name}が不正です`);
  }
  return value;
}

const FORMULA_TOKEN = /^(?:[A-Za-z]|[A-Z][a-z]?|\d+|[()[\]])$/u;

function formulaEntryValue(value: unknown): FormulaEntry {
  if (!isRecord(value)) throw new ApiError(400, "invalid_request", "回答が不正です");
  assertKeys(value, ["tokens", "cursor", "charge"]);
  if (
    !Array.isArray(value.tokens)
    || value.tokens.length < 1
    || value.tokens.length > 64
    || value.tokens.some((token) => typeof token !== "string" || !FORMULA_TOKEN.test(token))
    || value.tokens.join("").length > MAX_ANSWER_LENGTH
  ) {
    throw new ApiError(400, "invalid_request", "回答が不正です");
  }
  if (!Number.isSafeInteger(value.cursor) || (value.cursor as number) < 0 || (value.cursor as number) > value.tokens.length) {
    throw new ApiError(400, "invalid_request", "回答が不正です");
  }
  let charge: FormulaEntry["charge"] = null;
  if (value.charge !== null) {
    if (!isRecord(value.charge)) throw new ApiError(400, "invalid_request", "回答が不正です");
    assertKeys(value.charge, ["magnitude", "sign", "source"]);
    if (
      !Number.isSafeInteger(value.charge.magnitude)
      || (value.charge.magnitude as number) < 1
      || (value.charge.magnitude as number) > 9
      || (value.charge.sign !== "+" && value.charge.sign !== "-")
      || value.charge.source !== "chargeButton"
    ) {
      throw new ApiError(400, "invalid_request", "回答が不正です");
    }
    charge = {
      magnitude: value.charge.magnitude as number,
      sign: value.charge.sign,
      source: "chargeButton",
    };
  }
  return { tokens: [...value.tokens] as string[], cursor: value.cursor as number, charge };
}

export function integerValue(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ApiError(400, "invalid_request", `${name}が不正です`);
  }
  return value as number;
}

export function requestId(value: unknown): string {
  const id = stringValue(value, "requestId", 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(id)) throw new ApiError(400, "invalid_request", "requestIdが不正です");
  return id;
}

function parseSettings(value: unknown): IonicFormulaGameSettings {
  if (!isRecord(value)) throw new ApiError(400, "invalid_settings", "競技設定が不正です");
  assertKeys(value, [
    "questionCount", "timeLimitMinutes", "mode", "difficulty", "ionAnswer",
    "compoundPrompts", "compoundAnswer", "gradingMode", "complexEnabled", "complexOnly", "chemistryContentVersion",
  ]);
  if (!isRecord(value.compoundPrompts)) throw new ApiError(400, "invalid_settings", "出題形式が不正です");
  assertKeys(value.compoundPrompts, ["formula", "name"]);
  if (typeof value.compoundPrompts.formula !== "boolean" || typeof value.compoundPrompts.name !== "boolean") {
    throw new ApiError(400, "invalid_settings", "出題形式が不正です");
  }
  const settings = { ...value, gradingMode: value.gradingMode ?? "immediate", complexEnabled: value.complexEnabled === undefined ? false : value.complexEnabled,
    chemistryContentVersion: value.chemistryContentVersion === undefined ? CHEMISTRY_CONTENT_VERSION : value.chemistryContentVersion } as IonicFormulaGameSettings;
  try {
    validateGameSettings(settings);
  } catch {
    throw new ApiError(400, "invalid_settings", "競技設定が不正です");
  }
  return settings;
}

export function normalizeNickname(value: unknown): { nickname: string; nicknameKey: string } {
  if (typeof value !== "string") throw new ApiError(400, "invalid_nickname", "ニックネームを入力してください");
  const nickname = value.trim();
  const length = Array.from(nickname).length;
  if (length < 1 || length > 16 || /[\u0000-\u001f\u007f-\u009f]/u.test(nickname)) {
    throw new ApiError(400, "invalid_nickname", "ニックネームは1〜16文字で入力してください");
  }
  return { nickname, nicknameKey: nickname.normalize("NFKC").toLocaleLowerCase("ja-JP") };
}

function joinCode(random: () => number): string {
  return Array.from({ length: 6 }, () => {
    const index = Math.min(JOIN_CODE_ALPHABET.length - 1, Math.floor(random() * JOIN_CODE_ALPHABET.length));
    return JOIN_CODE_ALPHABET[index];
  }).join("");
}

async function loadRoom(database: PersistenceDatabase, externalId: string): Promise<RoomRow> {
  if (!externalId || externalId.length > 128) throw new ApiError(404, "not_found", "ルームが見つかりません");
  const room = await database.prepare(`
    SELECT id, public_id, join_code, kind, owner_teacher_id, mate_host_id,
      settings_json, game_version, state, revision, max_score, created_at_ms, start_at_ms, deadline_at_ms, expires_at_ms, ended_at_ms, end_reason,
      (SELECT state FROM v2_room_manifests WHERE room_id = rooms.id) AS v2_phase
    FROM rooms WHERE public_id = ? OR id = ?
  `).bind(externalId, externalId).first<RoomRow>();
  if (!room) throw new ApiError(404, "not_found", "ルームが見つかりません");
  return room;
}

function requireUnexpired(room: RoomRow, nowMs: number): void {
  if (room.expires_at_ms <= nowMs) {
    throw new ApiError(410, "expired", "このルームの閲覧期限は終了しました");
  }
}

function stateOf(room: RoomRow, nowMs: number): RoomState {
  if (room.game_version === "2") {
    if (room.state === "CANCELLED" || room.state === "EXPIRED") return room.state;
    if (room.v2_phase === "PREPARING" || room.v2_phase === "COLLECTING" || room.v2_phase === "FINISHED") return room.v2_phase;
    if ((room.v2_phase === "COUNTDOWN" || room.state === "COUNTDOWN") && room.start_at_ms != null && nowMs >= room.start_at_ms) return "RUNNING";
    return room.v2_phase ?? room.state;
  }
  return effectiveRoomState({
    storedState: room.state,
    startAtMs: room.start_at_ms,
    deadlineAtMs: room.deadline_at_ms,
  }, nowMs);
}

type AllowlistRow = { emails_json: string; revision: number; last_request_id: string | null; last_body_hash: string | null };
async function readTeacherAllowlist(database: PersistenceDatabase): Promise<AllowlistRow> {
  return await database.prepare("SELECT emails_json, revision, last_request_id, last_body_hash FROM teacher_allowlist WHERE id = 1").first<AllowlistRow>()
    ?? { emails_json: "[]", revision: 0, last_request_id: null, last_body_hash: null };
}
async function requireApplicationTeacher(dependencies: ApiDependencies, request: Request): Promise<TeacherIdentity> {
  const master = dependencies.serverConfig.masterTeacherEmail;
  if (!master) return requireTeacher(request, dependencies.teacherIdentity, dependencies.serverConfig.teacherAllowedEmails);
  const identity = await requireVerifiedTeacher(request, dependencies.teacherIdentity);
  if (identity.email === master) return identity;
  const list = await readTeacherAllowlist(dependencies.database);
  if (!(JSON.parse(list.emails_json) as string[]).includes(identity.email)) {
    throw new TeacherIdentityError(403, "teacher_forbidden", "教員として許可されていません");
  }
  return identity;
}

async function authorizeTeacherOwner(
  dependencies: ApiDependencies,
  request: Request,
  room: RoomRow,
): Promise<TeacherIdentity> {
  const teacher = await requireApplicationTeacher(dependencies, request);
  if (room.kind !== "class" || room.owner_teacher_id !== teacher.id) {
    throw new ApiError(403, "room_owner_forbidden", "このルームを操作する権限がありません");
  }
  return teacher;
}

async function authorizeRoomOwner(
  dependencies: ApiDependencies,
  request: Request,
  room: RoomRow,
): Promise<{ kind: "teacher"; id: string } | { kind: "participant"; id: string }> {
  if (request.headers.has("authorization")) {
    const participant = await requireParticipant(dependencies.database, request, room.id);
    if (room.kind !== "mate" || room.mate_host_id !== participant.participantId) {
      throw new ApiError(403, "room_owner_forbidden", "このルームを操作する権限がありません");
    }
    return { kind: "participant", id: participant.participantId };
  }
  const teacher = await authorizeTeacherOwner(dependencies, request, room);
  return { kind: "teacher", id: teacher.id };
}

async function readMateEnabled(database: PersistenceDatabase): Promise<{ enabled: boolean; revision: number }> {
  const row = await database.prepare(
    "SELECT mate_match_enabled, revision FROM site_settings WHERE id = 1",
  ).first<{ mate_match_enabled: number; revision: number }>();
  return row ? { enabled: row.mate_match_enabled === 1, revision: row.revision } : { enabled: true, revision: 0 };
}

async function tryFinalize(database: PersistenceDatabase, room: RoomRow, nowMs: number): Promise<void> {
  if (room.game_version === "2") {
    if (room.v2_phase === "COUNTDOWN" || room.v2_phase === "COLLECTING" || room.v2_phase === "FINISHED")
      await maybeFinalizeV2Room(database, { roomId: room.id, nowMs });
    return;
  }
  const effective = stateOf(room, nowMs);
  if (effective !== "FINISHED" || room.state === "FINISHED") return;
  try {
    await finalizeRoom(database, {
      roomId: room.id,
      requestId: `deadline-${room.deadline_at_ms ?? nowMs}`,
      bodyHash: `deadline-${room.deadline_at_ms ?? nowMs}`,
      nowMs,
    });
  } catch (error) {
    if (!(error instanceof PersistenceConflictError && error.code === "invalid_state")) throw error;
  }
}

async function participantState(database: PersistenceDatabase, room: RoomRow, participantId: string, nowMs: number) {
  const participant = await database.prepare(`
    SELECT id, nickname, status, joined_order, current_ordinal, correct_count, resolved_question_count,
      revision, elapsed_cs, accepted_elapsed_ms, wait_credit_ms, timing_source
    FROM participants WHERE room_id = ? AND id = ? AND status != 'REMOVED'
  `).bind(room.id, participantId).first<ParticipantRow>();
  if (!participant) throw new ApiError(403, "participant_forbidden", "参加者として確認できません");

  let question: PublicQuestion | null = null;
  if (room.game_version !== "2" && stateOf(room, nowMs) === "RUNNING" && participant.status === "ACTIVE") {
    const row = await database.prepare(`
      SELECT public_payload_json FROM room_questions
      WHERE room_id = ? AND ordinal = ?
    `).bind(room.id, participant.current_ordinal).first<{ public_payload_json: string }>();
    if (row) {
      const publicQuestion = JSON.parse(row.public_payload_json) as PublicQuestion;
      const { results: resolved } = await database.prepare(`
        SELECT field_id, state FROM participant_fields
        WHERE room_id = ? AND participant_id = ? AND question_id = ?
        ORDER BY field_id
      `).bind(room.id, participant.id, publicQuestion.id).all<{ field_id: AnswerFieldId; state: "pending" | "correct" | "passed" | "unanswered" }>();
      question = {
        ...publicQuestion,
        progress: { resolvedFieldIds: resolved.filter(field => field.state === "correct" || field.state === "passed").map(field => field.field_id), fieldStates: Object.fromEntries(resolved.map(field => [field.field_id, field.state])) },
      };
    }
  }
  return {
    participant: {
      id: participant.id,
      joinedOrder: participant.joined_order,
      nickname: participant.nickname,
      status: participant.status,
      currentOrdinal: participant.current_ordinal,
      correctCount: participant.correct_count,
      resolvedQuestionCount: participant.resolved_question_count,
      advancedQuestionCount: participant.resolved_question_count,
      revision: participant.revision,
      elapsedCs: participant.elapsed_cs,
      rawElapsedMs: participant.accepted_elapsed_ms,
      waitCreditMs: participant.wait_credit_ms,
      timingSource: participant.timing_source,
    },
    question,
  };
}

async function teacherProgress(database: PersistenceDatabase, roomId: string) {
  const { results } = await database.prepare(`
    SELECT id, nickname, status, joined_order, current_ordinal, correct_count, resolved_question_count,
      revision, elapsed_cs, timing_source, COALESCE(v.answered_count, 0) AS answered_count,
      v.finished_elapsed_ms
    FROM participants p LEFT JOIN v2_participant_progress v ON v.room_id = p.room_id AND v.participant_id = p.id
    WHERE p.room_id = ? AND p.status != 'REMOVED' ORDER BY p.joined_order
  `).bind(roomId).all<ParticipantRow & { answered_count: number; finished_elapsed_ms: number | null }>();
  return results.map((participant) => ({
    id: participant.id,
    joinedOrder: participant.joined_order,
    nickname: participant.nickname,
    status: participant.status,
    currentOrdinal: participant.current_ordinal,
    correctCount: participant.correct_count,
    resolvedQuestionCount: participant.resolved_question_count,
    advancedQuestionCount: participant.resolved_question_count,
    revision: participant.revision,
    elapsedCs: participant.elapsed_cs,
    timingSource: participant.timing_source,
    answeredCount: participant.answered_count,
    submitted: participant.finished_elapsed_ms != null,
  }));
}

function roomView(room: RoomRow, nowMs: number) {
  return {
    id: room.public_id,
    playProtocolVersion: room.game_version === "2" ? 2 : 1,
    gradingMode: (JSON.parse(room.settings_json) as IonicFormulaGameSettings).gradingMode ?? "immediate",
    kind: room.kind,
    state: stateOf(room, nowMs),
    revision: room.revision,
    settings: JSON.parse(room.settings_json) as unknown,
    maxScore: room.max_score,
    createdAtMs: room.created_at_ms,
    startAtMs: room.start_at_ms,
    deadlineAtMs: room.deadline_at_ms,
    expiresAtMs: room.expires_at_ms,
    endedAtMs: room.ended_at_ms,
    endReason: room.end_reason,
  };
}

function correctAnswer(question: InternalQuestion, fieldId: AnswerFieldId): string {
  const specification = question.answer.type === "both" ? question.answer[fieldId] : question.answer;
  return specification.canonical;
}

async function participantQuestionResults(
  database: PersistenceDatabase,
  roomId: string,
  participantId: string,
  protocolVersion = 1,
  requestId?: string,
) {
  const fieldSource = protocolVersion === 2
    ? "v2_final_fields f"
    : "participant_fields f";
  const fieldColumns = protocolVersion === 2
    ? "0 AS attempt_count, f.answer_json AS last_answer_json, CASE WHEN f.state = 'correct' THEN 1 WHEN f.state = 'incorrect' THEN 0 ELSE NULL END AS last_answer_correct"
    : "f.attempt_count, f.last_answer_json, f.last_answer_correct";
  const { results } = await database.prepare(`
    SELECT q.question_id, q.ordinal, q.public_payload_json, q.answer_snapshot_json,
      f.field_id, f.state, ${fieldColumns}
    FROM room_questions q
    JOIN ${fieldSource} ON f.room_id = q.room_id AND f.question_id = q.question_id
    WHERE q.room_id = ? AND f.participant_id = ?
    ORDER BY q.ordinal, json_extract(q.field_spec_json, '$[0].id') != f.field_id, f.field_id
  `).bind(roomId, participantId).all<{
    question_id: string;
    ordinal: number;
    public_payload_json: string;
    answer_snapshot_json: string;
    field_id: AnswerFieldId;
    state: "correct" | "incorrect" | "passed" | "unanswered";
    attempt_count: number;
    last_answer_json: string | null;
    last_answer_correct: number | null;
  }>();
  const questions = new Map<string, {
    id: string;
    ordinal: number;
    prompt: PublicQuestion["prompt"];
    fields: Array<{ id: AnswerFieldId; state: string; correctAnswer: string; correctFormulaCore: string | null; correctFormulaCharge: number | null; lastAnswer: string | null; lastAnswerEntry: FormulaEntry | null; answerDisplayUnavailable?: true; lastAnswerCorrect: boolean | null; attemptCount: number }>;
  }>();
  let unavailableCount = 0;
  for (const row of results) {
    const internal = JSON.parse(row.answer_snapshot_json) as InternalQuestion;
    const publicQuestion = JSON.parse(row.public_payload_json) as PublicQuestion;
    const question = questions.get(row.question_id) ?? {
      id: row.question_id,
      ordinal: row.ordinal,
      prompt: publicQuestion.prompt,
      fields: [],
    };
    const displayAnswer = decodeDisplayAnswer(row.last_answer_json);
    if (displayAnswer.answerDisplayUnavailable) unavailableCount += 1;
    question.fields.push({
      id: row.field_id,
      state: row.state,
      correctAnswer: correctAnswer(internal, row.field_id),
      correctFormulaCore: row.field_id === "formula" && internal.ionCharge != null ? internal.ionFormula ?? null : null,
      correctFormulaCharge: row.field_id === "formula" ? internal.ionCharge ?? null : null,
      ...displayAnswer,
      lastAnswerCorrect: row.last_answer_correct === null ? null : row.last_answer_correct === 1,
      attemptCount: row.attempt_count,
    });
    questions.set(row.question_id, question);
  }
  if (unavailableCount) console.warn(JSON.stringify({ event: "result_answer_unavailable", requestId,
    protocolVersion, unavailableCount }));
  return [...questions.values()];
}

async function teacherResultAggregate(database: PersistenceDatabase, room: RoomRow) {
  const fieldTable = room.game_version === "2" ? "v2_final_fields" : "participant_fields";
  const totals = await database.prepare(`
    SELECT COUNT(*) AS participant_count,
      COALESCE(AVG(correct_count), 0) AS average_correct_count,
      COALESCE(SUM(CASE WHEN correct_count = ? THEN 1 ELSE 0 END), 0) AS perfect_count,
      COALESCE(SUM(CASE WHEN finish_reason = 'completed' THEN 1 ELSE 0 END), 0) AS completed_count
    FROM final_results WHERE room_id = ?
  `).bind(room.max_score, room.id).first<{
    participant_count: number;
    average_correct_count: number;
    perfect_count: number;
    completed_count: number;
  }>();
  const participantCount = Number(totals?.participant_count ?? 0);
  const { results: rows } = await database.prepare(`
    SELECT q.question_id, q.ordinal, q.answer_snapshot_json, f.field_id,
      SUM(CASE WHEN f.state = 'correct' THEN 1 ELSE 0 END) AS correct_count,
      SUM(CASE WHEN f.state = 'passed' THEN 1 ELSE 0 END) AS passed_count,
      SUM(CASE WHEN f.state = 'unanswered' THEN 1 ELSE 0 END) AS unanswered_count
    FROM room_questions q
    JOIN ${fieldTable} f ON f.room_id = q.room_id AND f.question_id = q.question_id
    WHERE q.room_id = ?
    GROUP BY q.question_id, q.ordinal, q.answer_snapshot_json, f.field_id
    ORDER BY q.ordinal, f.field_id
  `).bind(room.id).all<{
    question_id: string;
    ordinal: number;
    answer_snapshot_json: string;
    field_id: AnswerFieldId;
    correct_count: number;
    passed_count: number;
    unanswered_count: number;
  }>();
  const questions = new Map<string, {
    id: string;
    ordinal: number;
    fields: Array<{
      id: AnswerFieldId;
      correctAnswer: string;
      correctCount: number;
      passedCount: number;
      unansweredCount: number;
      correctRate: number;
    }>;
  }>();
  for (const row of rows) {
    const internal = JSON.parse(row.answer_snapshot_json) as InternalQuestion;
    const question = questions.get(row.question_id) ?? { id: row.question_id, ordinal: row.ordinal, fields: [] };
    const fieldCorrectCount = Number(row.correct_count);
    question.fields.push({
      id: row.field_id,
      correctAnswer: correctAnswer(internal, row.field_id),
      correctCount: fieldCorrectCount,
      passedCount: Number(row.passed_count),
      unansweredCount: Number(row.unanswered_count),
      correctRate: participantCount ? fieldCorrectCount / participantCount : 0,
    });
    questions.set(row.question_id, question);
  }
  return {
    participantCount,
    averageCorrectCount: Number(totals?.average_correct_count ?? 0),
    perfectCount: Number(totals?.perfect_count ?? 0),
    completedCount: Number(totals?.completed_count ?? 0),
    questions: [...questions.values()],
  };
}

export function createApiHandlers(dependencies: ApiDependencies) {
  const publicConfig = (request: Request) => safe(async () => {
    const mate = await readMateEnabled(dependencies.database);
    return jsonResponse({
      ...PUBLIC_CONFIG,
      mateMatchEnabled: mate.enabled,
    });
  });

  const joinInfo = (request: Request) => safe(async () => {
    const search = new URL(request.url).searchParams;
    const rawCode = search.get("code");
    const rawPublicId = search.get("publicId");
    if ((rawCode === null) === (rawPublicId === null)) {
      throw new ApiError(400, "invalid_room_lookup", "参加先を確認してください");
    }
    const code = rawCode?.trim().toUpperCase() ?? null;
    const publicId = rawPublicId?.trim() ?? null;
    if (code !== null && !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/u.test(code)) {
      throw new ApiError(400, "invalid_join_code", "参加コードを確認してください");
    }
    if (publicId !== null && !/^[A-Za-z0-9_-]{1,128}$/u.test(publicId)) {
      throw new ApiError(400, "invalid_public_id", "参加先を確認してください");
    }
    const nowMs = dependencies.now();
    const room = await dependencies.database.prepare(`
      SELECT id, public_id, join_code, kind, owner_teacher_id, mate_host_id,
        settings_json, game_version, state, revision, max_score, start_at_ms, deadline_at_ms, expires_at_ms,
        (SELECT state FROM v2_room_manifests WHERE room_id = rooms.id) AS v2_phase
      FROM rooms WHERE (${code === null ? "public_id" : "join_code"}) = ?
    `).bind(publicId ?? code).first<RoomRow>();
    if (!room) throw new ApiError(404, "not_found", "ルームが見つかりません");
    requireUnexpired(room, nowMs);
    const count = await dependencies.database.prepare(
      "SELECT COUNT(*) AS count FROM participants WHERE room_id = ? AND status != 'REMOVED'",
    ).bind(room.id).first<{ count: number }>();
    return jsonResponse({
      room: {
        id: room.public_id,
        kind: room.kind,
        state: stateOf(room, nowMs),
        settings: JSON.parse(room.settings_json) as unknown,
      },
      participantCount: Number(count?.count ?? 0),
      capacity: room.kind === "class" ? (dependencies.database.classCompetitionCapacity ?? PUBLIC_CONFIG.participantLimits.classCompetition) : PUBLIC_CONFIG.participantLimits.mateMatch,
    });
  });

  const createClassRoom = (request: Request) => safe(async () => {
    const teacher = await requireApplicationTeacher(dependencies, request);
    const { value, bodyHash } = await readMutationBody(request);
    assertKeys(value, ["requestId", "settings"]);
    const idempotencyKey = requestId(value.requestId);
    const requestedV2 = isRecord(value.settings) && value.settings.gradingMode !== undefined;
    const settings = parseSettings(value.settings);
    const questionProfile = await readQuestionProfile(dependencies.database);
    const validated = validateGameSettings(settings, questionProfile.profile);
    const nowMs = dependencies.now();
    if (!dependencies.skipLazyCleanup) await cleanupExpired(dependencies.database, { nowMs, limit: LAZY_CLEANUP_LIMIT });
    const created = await createRoom(dependencies.database, {
      roomId: dependencies.randomUUID(),
      publicId: dependencies.randomUUID(),
      joinCode: joinCode(dependencies.random),
      kind: "class",
      ownerTeacherId: teacher.id,
      settings,
      gameId: "ionic-formula",
      gameVersion: requestedV2 ? "2" : "1",
      datasetVersion: CHEMISTRY_CONTENT_VERSION,
      questionProfile,
      maxScore: validated.maxScore,
      actorKeyHash: await sha256(`teacher:${teacher.id}`),
      requestId: idempotencyKey,
      bodyHash,
      nowMs,
      expiresAtMs: nowMs + PUBLIC_CONFIG.waitingRoomLifetimeMs,
    });
    return jsonResponse({ room: { id: created.publicId, joinCode: created.joinCode, kind: created.kind, state: created.state, revision: created.revision } }, 201);
  });

  const createMateRoom = (request: Request) => safe(async () => {
    const { value, bodyHash } = await readMutationBody(request);
    assertKeys(value, ["requestId", "settings", "nickname"]);
    const creationKey = request.headers.get("x-creation-key") ?? "";
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(creationKey)) {
      throw new ApiError(401, "creation_credential_required", "作成資格が必要です");
    }
    const token = readParticipantBearerToken(request);
    const tokenHash = await hashParticipantToken(token);
    const credentialBoundBodyHash = await sha256(`${bodyHash}:${tokenHash}`);
    const nickname = normalizeNickname(value.nickname);
    const requestedV2 = isRecord(value.settings) && value.settings.gradingMode !== undefined;
    const settings = parseSettings(value.settings);
    const questionProfile = await readQuestionProfile(dependencies.database);
    const validated = validateGameSettings(settings, questionProfile.profile);
    const nowMs = dependencies.now();
    if (!dependencies.skipLazyCleanup) await cleanupExpired(dependencies.database, { nowMs, limit: LAZY_CLEANUP_LIMIT });
    const hostId = dependencies.randomUUID();
    const created = await createRoom(dependencies.database, {
      roomId: dependencies.randomUUID(),
      publicId: dependencies.randomUUID(),
      joinCode: joinCode(dependencies.random),
      kind: "mate",
      ownerTeacherId: null,
      settings,
      gameId: "ionic-formula",
      gameVersion: requestedV2 ? "2" : "1",
      datasetVersion: CHEMISTRY_CONTENT_VERSION,
      questionProfile,
      maxScore: validated.maxScore,
      actorKeyHash: await sha256(`creator:${creationKey}`),
      requestId: requestId(value.requestId),
      bodyHash: credentialBoundBodyHash,
      nowMs,
      expiresAtMs: nowMs + PUBLIC_CONFIG.waitingRoomLifetimeMs,
      host: { participantId: hostId, tokenHash, ...nickname },
    });
    return jsonResponse({
      room: { id: created.publicId, joinCode: created.joinCode, kind: created.kind, state: created.state, revision: created.revision },
      participant: created.hostParticipant,
    }, 201);
  });

  const join = (request: Request, parameters: RouteParameters) => safe(async () => {
    const { value, bodyHash } = await readMutationBody(request);
    assertKeys(value, ["requestId", "nickname"]);
    const room = await loadRoom(dependencies.database, parameters.id);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    const token = readParticipantBearerToken(request);
    const tokenHash = await hashParticipantToken(token);
    const nickname = normalizeNickname(value.nickname);
    const joined = await joinRoom(dependencies.database, {
      roomId: room.id,
      participantId: dependencies.randomUUID(),
      tokenHash,
      ...nickname,
      requestId: requestId(value.requestId),
      bodyHash,
      nowMs,
    });
    return jsonResponse({
      participant: {
        id: joined.participantId,
        nickname: nickname.nickname,
        joinedOrder: joined.joinedOrder,
        revision: joined.participantRevision,
      },
    }, 201);
  });

  const nickname = (request: Request, parameters: RouteParameters) => safe(async () => {
    assertSameOriginMutation(request);
    const room = await loadRoom(dependencies.database, parameters.id);
    const participant = await requireParticipant(dependencies.database, request, room.id);
    const { value, bodyHash } = await readMutationBody(request);
    assertKeys(value, ["requestId", "expectedParticipantRevision", "nickname"]);
    const normalized = normalizeNickname(value.nickname);
    const result = await renameParticipantCommand(dependencies.database, {
      roomId: room.id,
      participantId: participant.participantId,
      requestId: requestId(value.requestId),
      bodyHash,
      expectedParticipantRevision: integerValue(value.expectedParticipantRevision, "expectedParticipantRevision"),
      ...normalized,
      nowMs: dependencies.now(),
    });
    return jsonResponse({ participant: result });
  });

  const updateRoomSettings = (request: Request, parameters: RouteParameters) => safe(async () => {
    const { value, bodyHash } = await readMutationBody(request);
    assertKeys(value, ["requestId", "expectedRevision", "settings"]);
    const idempotencyKey = requestId(value.requestId);
    const room = await loadRoom(dependencies.database, parameters.id);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    const owner = await authorizeRoomOwner(dependencies, request, room);
    const expectedRevision = integerValue(value.expectedRevision, "expectedRevision");
    const settings = parseSettings(value.settings);
    const questionProfile = await readRoomQuestionProfile(dependencies.database, room.id);
    const validated = validateGameSettings(settings, questionProfile);
    const result = await updateRoomSettingsCommand(dependencies.database, {
      roomId: room.id,
      actorId: `${owner.kind}:${owner.id}`,
      requestId: idempotencyKey,
      bodyHash,
      expectedRevision,
      settings,
      maxScore: validated.maxScore,
      nowMs,
    });
    return jsonResponse({ room: { id: room.public_id, ...result } });
  });

  const start = (request: Request, parameters: RouteParameters) => safe(async () => {
    const { value, bodyHash } = await readMutationBody(request);
    assertKeys(value, ["requestId", "expectedRevision"]);
    const room = await loadRoom(dependencies.database, parameters.id);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    await authorizeRoomOwner(dependencies, request, room);
    const replay=await loadCommandReceipt<Record<string,unknown>>(dependencies.database,room.id,room.game_version==='2'?`v2-prepare:${room.id}`:`room:${room.id}`,requestId(value.requestId),bodyHash);
    if(replay)return jsonResponse(room.game_version==='2'?replay:{state:replay.state,roomRevision:replay.roomRevision,startAtMs:replay.startAtMs,deadlineAtMs:replay.deadlineAtMs});
    const settings = parseSettings(JSON.parse(room.settings_json) as unknown);
    const questionProfile = await readRoomQuestionProfile(dependencies.database, room.id);
    if (room.game_version === "2") {
      return jsonResponse(await prepareV2Room(dependencies.database, {
        roomId: room.id, requestId: requestId(value.requestId), bodyHash,
        expectedRoomRevision: integerValue(value.expectedRevision, "expectedRevision"), nowMs:dependencies.now(),clock:dependencies.now,
        manifestId: dependencies.randomUUID(), evaluatorVersion: EVALUATOR_VERSION,
        gradingMode: settings.gradingMode ?? "immediate", questions: generateQuestionSet(settings, dependencies.random, questionProfile),
      }));
    }
    const questions=generateQuestionSet(settings,dependencies.random,questionProfile);
    const scheduledAt=dependencies.now();
    const startAtMs = scheduledAt + PUBLIC_CONFIG.countdownSeconds * 1_000;
    const started = await startRoom(dependencies.database, {
      roomId: room.id,
      requestId: requestId(value.requestId),
      bodyHash,
      expectedRoomRevision: integerValue(value.expectedRevision, "expectedRevision"),
      nowMs:scheduledAt,clock:dependencies.now,
      startAtMs,
      deadlineAtMs: startAtMs + settings.timeLimitMinutes * 60_000,
      questions,
    });
    return jsonResponse({
      state: started.state,
      roomRevision: started.roomRevision,
      startAtMs: started.startAtMs,
      deadlineAtMs: started.deadlineAtMs,
    });
  });

  const startStatus = (request: Request, parameters: RouteParameters) => safe(async () => {
    const key = new URL(request.url).searchParams.get("requestId");
    if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) throw new ApiError(400, "invalid_request", "開始要求を確認してください");
    const room = await loadRoom(dependencies.database, parameters.id);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    await authorizeRoomOwner(dependencies, request, room);
    const actor = room.game_version === "2" ? `v2-prepare:${room.id}` : `room:${room.id}`;
    const receipt = await dependencies.database.prepare(`SELECT result_json, processed_at_ms FROM command_receipts
      WHERE room_id=? AND actor_id=? AND request_id=? AND expires_at_ms>?`)
      .bind(room.id, actor, key, nowMs).first<{result_json:string;processed_at_ms:number}>();
    const phase = room.game_version === "2" ? await loadV2RoomPhase(dependencies.database, room.id, nowMs) : null;
    const stored = receipt ? JSON.parse(receipt.result_json) : null;
    return jsonResponse({requestId:key, receipt: receipt ? {protocolVersion:room.game_version === "2" ? 2 : 1,
      roomRevision:stored.roomRevision, ...(stored.manifestId ? {manifestId:stored.manifestId,preparationGeneration:stored.preparationGeneration} : {}), processedAtMs:receipt.processed_at_ms} : null,
      room:{state:stateOf(room,nowMs),revision:room.revision,startAtMs:room.start_at_ms,expiresAtMs:room.expires_at_ms,
        manifestId:phase?.manifestId??null,preparationGeneration:phase?.preparationGeneration??null,preparationTimedOut:phase?.preparationTimedOut??false}, serverNow:nowMs});
  });

  const manifest = (request: Request, parameters: RouteParameters) => safe(async () => {
    const room = dependencies.snapshotRoom ?? await loadRoom(dependencies.database, parameters.id);
    requireUnexpired(room, dependencies.now());
    if (room.game_version !== "2") throw new ApiError(404, "not_found", "問題の準備情報がありません");
    const participant = await requireParticipant(dependencies.database, request, room.id);
    return jsonResponse(await loadV2Manifest(dependencies.database, room.id, participant.participantId));
  });

  const ready = (request: Request, parameters: RouteParameters) => safe(async () => {
    const room = await loadRoom(dependencies.database, parameters.id);
    requireUnexpired(room, dependencies.now());
    if (room.game_version !== "2") throw new ApiError(404, "not_found", "準備情報がありません");
    const participant = await requireParticipant(dependencies.database, request, room.id);
    const { value } = await readMutationBody(request);
    assertKeys(value, ["manifestId", "preparationGeneration", "evaluatorVersion"]);
    return jsonResponse(await markV2Ready(dependencies.database, {
      roomId: room.id, participantId: participant.participantId,
      manifestId: stringValue(value.manifestId, "manifestId", 128),
      evaluatorVersion: stringValue(value.evaluatorVersion, "evaluatorVersion", 128),
      preparationGeneration: integerValue(value.preparationGeneration, "preparationGeneration", 1),
      nowMs: dependencies.now(),clock:dependencies.now,
    }));
  });

  const cancelPreparation = (request: Request, parameters: RouteParameters) => safe(async () => {
    const room = await loadRoom(dependencies.database, parameters.id);
    requireUnexpired(room, dependencies.now());
    if (room.game_version !== "2") throw new ApiError(404, "not_found", "準備情報がありません");
    await authorizeRoomOwner(dependencies, request, room);
    const { value } = await readMutationBody(request);
    assertKeys(value, ["expectedRevision"]);
    return jsonResponse(await cancelV2Preparation(dependencies.database, {
      roomId: room.id, expectedRoomRevision: integerValue(value.expectedRevision, "expectedRevision"), nowMs: dependencies.now(),
    }));
  });

  const operations = (request: Request, parameters: RouteParameters) => safe(async () => {
    const room = await loadRoom(dependencies.database, parameters.id);
    requireUnexpired(room, dependencies.now());
    if (room.game_version !== "2") throw new ApiError(404, "not_found", "保存先がありません");
    const participant = await requireParticipant(dependencies.database, request, room.id);
    const { value } = await readMutationBody(request, MAX_OPERATION_BODY_BYTES);
    assertKeys(value, ["requestId", "writerEpoch", "manifestId", "evaluatorVersion", "operations"]);
    if (!Array.isArray(value.operations)) throw new ApiError(400, "invalid_request", "解答記録が不正です");
    const response = await applyV2Operations(dependencies.database, {
      roomId: room.id, participantId: participant.participantId, requestId: requestId(value.requestId),
      writerEpoch: integerValue(value.writerEpoch, "writerEpoch"),
      manifestId: stringValue(value.manifestId, "manifestId", 128),
      evaluatorVersion: stringValue(value.evaluatorVersion, "evaluatorVersion", 128),
      operations: value.operations as V2Operation[], nowMs: dependencies.now(),
    });
    await maybeFinalizeV2Room(dependencies.database, { roomId: room.id, nowMs: dependencies.now() });
    return jsonResponse(response);
  });

  const writer = (request: Request, parameters: RouteParameters) => safe(async () => {
    const room = await loadRoom(dependencies.database, parameters.id);
    requireUnexpired(room, dependencies.now());
    if (room.game_version !== "2") throw new ApiError(404, "not_found", "書き手情報がありません");
    const participant = await requireParticipant(dependencies.database, request, room.id);
    const { value } = await readMutationBody(request);
    assertKeys(value, ["expectedEpoch"]);
    return jsonResponse(await takeOverV2Writer(dependencies.database, room.id, participant.participantId,
      integerValue(value.expectedEpoch, "expectedEpoch", 1)));
  });

  const cancel = (request: Request, parameters: RouteParameters) => safe(async () => {
    const { value, bodyHash } = await readMutationBody(request);
    assertKeys(value, ["requestId", "expectedRevision"]);
    const room = await loadRoom(dependencies.database, parameters.id);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    await authorizeRoomOwner(dependencies, request, room);
    return jsonResponse(await cancelRoomCommand(dependencies.database, {
      roomId: room.id,
      requestId: requestId(value.requestId),
      bodyHash,
      expectedRoomRevision: integerValue(value.expectedRevision, "expectedRevision"),
      nowMs,
    }));
  });

  const interrupt = (request: Request, parameters: RouteParameters) => safe(async () => {
    const { value, bodyHash } = await readMutationBody(request);
    assertKeys(value, ["requestId", "expectedRevision"]);
    let room = await loadRoom(dependencies.database, parameters.id);
    requireUnexpired(room, dependencies.now());
    if (request.headers.has("authorization")) throw new ApiError(403, "room_owner_forbidden", "作成教員だけが中断できます");
    await authorizeTeacherOwner(dependencies, request, room);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    await tryFinalize(dependencies.database, room, nowMs);
    room = await loadRoom(dependencies.database, room.id);
    if (room.game_version === "2") return jsonResponse(await collectV2Room(dependencies.database, { roomId: room.id, nowMs, interrupted: true }));
    return jsonResponse(await interruptRoomCommand(dependencies.database, {
      roomId: room.id,
      requestId: requestId(value.requestId),
      bodyHash,
      expectedRoomRevision: integerValue(value.expectedRevision, "expectedRevision"),
      nowMs,
    }));
  });

  const removeParticipant = (request: Request, parameters: RouteParameters) => safe(async () => {
    const { value, bodyHash } = await readMutationBody(request);
    assertKeys(value, [
      "requestId",
      "participantId",
      "expectedRoomRevision",
      "expectedParticipantRevision",
    ]);
    const room = await loadRoom(dependencies.database, parameters.id);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    const owner = await authorizeRoomOwner(dependencies, request, room);
    const result = await removeParticipantCommand(dependencies.database, {
      roomId: room.id,
      actorId: `${owner.kind}:${owner.id}`,
      targetParticipantId: stringValue(value.participantId, "participantId"),
      requestId: requestId(value.requestId),
      bodyHash,
      expectedRoomRevision: integerValue(value.expectedRoomRevision, "expectedRoomRevision"),
      expectedParticipantRevision: integerValue(value.expectedParticipantRevision, "expectedParticipantRevision"),
      nowMs,
    });
    return jsonResponse({
      roomRevision: result.roomRevision,
      participant: {
        id: result.participantId,
        status: result.participantStatus,
        revision: result.participantRevision,
      },
    });
  });

  const actions = (request: Request, parameters: RouteParameters) => safe(async () => {
    assertSameOriginMutation(request);
    const room = await loadRoom(dependencies.database, parameters.id);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    const participant = await requireParticipant(dependencies.database, request, room.id);
    const { value, bodyHash } = await readMutationBody(request);
    assertKeys(value, ["requestId", "questionId", "expectedParticipantRevision", "clientElapsedMs", "waitCredit", "action"]);
    if (!isRecord(value.action)) throw new ApiError(400, "invalid_action", "操作内容が不正です");
    let action: { type: "pass"; fieldId: AnswerFieldId } | { type: "answer"; fieldId: AnswerFieldId; value: string | FormulaEntry };
    if (value.action.type === "pass") {
      if (value.action.fieldId === undefined) {
        const replay = await loadCommandReceipt(dependencies.database, room.id, participant.participantId, requestId(value.requestId), bodyHash);
        if (replay) return jsonResponse(replay);
        throw new ApiError(400, "invalid_action", "アプリを更新して、パスする欄を指定してください");
      }
      assertKeys(value.action, ["type", "fieldId"]);
      if (value.action.fieldId !== "formula" && value.action.fieldId !== "name") throw new ApiError(400, "invalid_action", "パスする欄を指定してください");
      action = { type: "pass", fieldId: value.action.fieldId };
    } else if (value.action.type === "answer") {
      assertKeys(value.action, ["type", "fieldId", "value"]);
      if (value.action.fieldId !== "formula" && value.action.fieldId !== "name") {
        throw new ApiError(400, "invalid_action", "回答欄が不正です");
      }
      action = {
        type: "answer",
        fieldId: value.action.fieldId,
        value: value.action.fieldId === "formula" && isRecord(value.action.value)
          ? formulaEntryValue(value.action.value)
          : stringValue(value.action.value, "回答", MAX_ANSWER_LENGTH),
      };
    } else {
      throw new ApiError(400, "invalid_action", "操作内容が不正です");
    }
    const clientElapsedMs = value.clientElapsedMs === null
      ? null
      : integerValue(value.clientElapsedMs, "clientElapsedMs");
    let waitCredit: { sourceRequestId: string; waitMs: number } | undefined;
    if (isRecord(value.waitCredit)) {
      const source = value.waitCredit.sourceRequestId;
      const waitMs = value.waitCredit.waitMs;
      if (typeof source === "string" && source.length > 0 && source.length <= 128
        && /^[A-Za-z0-9_-]+$/u.test(source) && Number.isSafeInteger(waitMs) && (waitMs as number) >= 0) {
        waitCredit = { sourceRequestId: source, waitMs: waitMs as number };
      }
    }
    const result = await applyPlayerAction(dependencies.database, {
      roomId: room.id,
      participantId: participant.participantId,
      requestId: requestId(value.requestId),
      bodyHash,
      questionId: stringValue(value.questionId, "questionId"),
      expectedParticipantRevision: integerValue(value.expectedParticipantRevision, "expectedParticipantRevision"),
      clientElapsedMs,
      waitCredit,
      serverNowMs: nowMs,
      action,
    });
    if (result.finished) {
      const latest = await loadRoom(dependencies.database, room.id);
      try {
        await finalizeRoom(dependencies.database, {
          roomId: room.id,
          requestId: `all-finished-${result.participantRevision}`,
          bodyHash: `all-finished-${result.participantRevision}`,
          nowMs,
        });
      } catch (error) {
        if (!(
          error instanceof PersistenceConflictError
          && (error.code === "invalid_state" || error.code === "stale_room_revision")
        )) throw error;
      }
      void latest;
    }
    return jsonResponse(result);
  });

  const state = (request: Request, parameters: RouteParameters) => safe(async () => {
    let room = dependencies.snapshotRoom ?? await loadRoom(dependencies.database, parameters.id);
    const nowMs = dependencies.now();
    if (room.expires_at_ms <= nowMs) {
      if(!dependencies.snapshotRoom) if (!dependencies.skipLazyCleanup) await cleanupExpired(dependencies.database, { nowMs, limit: LAZY_CLEANUP_LIMIT });
      throw new ApiError(410, "expired", "このルームの閲覧期限は終了しました");
    }
    if(!dependencies.snapshotRoom) if (!dependencies.skipLazyCleanup) await cleanupExpired(dependencies.database, { nowMs, limit: LAZY_CLEANUP_LIMIT });
    requireUnexpired(room, nowMs);
    if(!dependencies.snapshotRoom) {
      await tryFinalize(dependencies.database, room, nowMs);
      room = await loadRoom(dependencies.database, room.id);
    }
    const v2Phase = room.game_version === "2" ? await loadV2RoomPhase(dependencies.database, room.id, nowMs) : null;
    const v2Preparation = v2Phase?.state === "PREPARING"
      ? (await dependencies.database.prepare(`SELECT p.nickname, v.ready_generation FROM participants p
          LEFT JOIN v2_participant_progress v ON v.room_id = p.room_id AND v.participant_id = p.id
          WHERE p.room_id = ? AND p.status = 'ACTIVE' ORDER BY p.joined_order`)
          .bind(room.id).all<{ nickname: string; ready_generation: number | null }>()).results
      : null;
    const v2 = v2Phase ? { ...v2Phase,
      readyCount: v2Preparation?.filter(p => p.ready_generation === v2Phase.preparationGeneration).length ?? null,
      participantCount: v2Preparation?.length ?? null,
      notReadyNicknames: v2Preparation?.filter(p => p.ready_generation !== v2Phase.preparationGeneration).map(p => p.nickname) ?? [],
    } : undefined;
    if (request.headers.has("authorization")) {
      const identity = dependencies.snapshotParticipant ?? await identifyParticipant(dependencies.database, request, room.id);
      if (identity.status === "REMOVED") {
        const roomState = stateOf(room, nowMs);
        return jsonResponse({ error: {
          code: "participant_removed",
          message: "ホストがロビーからあなたのエントリーを削除しました。",
          nickname: identity.nickname,
          roomState,
          canRejoin: roomState === "WAITING",
        } }, 403);
      }
      const own = await participantState(dependencies.database, room, identity.participantId, nowMs);
      const participants = room.kind === "mate" && room.mate_host_id === identity.participantId
        ? await teacherProgress(dependencies.database, room.id)
        : undefined;
      return jsonResponse({
        serverNow: nowMs,
        room: roomView(room, nowMs),
        ...(v2 ? { v2 } : {}),
        ...own,
        ...(participants ? { participants } : {}),
      });
    }
    await authorizeTeacherOwner(dependencies, request, room);
    return jsonResponse({ serverNow: nowMs, room: roomView(room, nowMs), ...(v2 ? { v2 } : {}), participants: await teacherProgress(dependencies.database, room.id) });
  });

  const results = (request: Request, parameters: RouteParameters) => resultSafe(async (requestId, setProtocolVersion) => {
    let room = await loadRoom(dependencies.database, parameters.id);
    setProtocolVersion(room.game_version === "2" ? 2 : 1);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    await tryFinalize(dependencies.database, room, nowMs);
    room = await loadRoom(dependencies.database, room.id);
    if (stateOf(room, nowMs) !== "FINISHED") throw new ApiError(409, "results_not_ready", "結果はまだ確定していません");
    const { results: rankingRows } = await dependencies.database.prepare(`
      SELECT p.nickname, f.correct_count, f.elapsed_cs, f.rank, f.finish_reason,
        v.finished_elapsed_ms, v.boundary_ack_at_ms, v.finish_reason AS v2_finish_reason
      FROM final_results f JOIN participants p ON p.room_id = f.room_id AND p.id = f.participant_id
      LEFT JOIN v2_participant_progress v ON v.room_id = f.room_id AND v.participant_id = f.participant_id
      WHERE f.room_id = ? ORDER BY f.rank, p.joined_order
    `).bind(room.id).all<{
      nickname: string; correct_count: number; elapsed_cs: number;
      rank: number; finish_reason: string; v2_finish_reason: string | null; finished_elapsed_ms: number | null; boundary_ack_at_ms: number | null;
    }>();
    const ranking = rankingRows.map((row) => ({
      nickname: row.nickname,
      correctCount: row.correct_count,
      elapsedCs: row.elapsed_cs,
      rank: row.rank,
      finishReason: room.game_version === "2" && row.v2_finish_reason === "submitted" ? "submitted" : row.finish_reason,
      ...(room.game_version === "2" ? { finalSyncUnconfirmed: row.finished_elapsed_ms == null && row.boundary_ack_at_ms == null } : {}),
    }));
    if (request.headers.has("authorization")) {
      const identity = await requireParticipant(dependencies.database, request, room.id);
      const own = await loadAuthorizedResult(dependencies.database, {
        roomId: room.id,
        participantId: identity.participantId,
        tokenHash: identity.tokenHash,
        nowMs,
      });
      const ownProgress = room.game_version === "2" ? await dependencies.database.prepare(`SELECT finished_elapsed_ms, boundary_ack_at_ms, finish_reason
        FROM v2_participant_progress WHERE room_id = ? AND participant_id = ?`)
        .bind(room.id, identity.participantId).first<{ finished_elapsed_ms: number | null; boundary_ack_at_ms: number | null; finish_reason: string | null }>() : null;
      return jsonResponse({
        room: roomView(room, nowMs),
        ranking: room.kind === "class" ? ranking.filter((row) => row.rank <= 3) : ranking,
        own: { ...own, ...(ownProgress ? { finalSyncUnconfirmed: ownProgress.finished_elapsed_ms == null && ownProgress.boundary_ack_at_ms == null,
          finishReason: ownProgress.finish_reason === "submitted" ? "submitted" : own.finishReason } : {}) },
        questions: await participantQuestionResults(dependencies.database, room.id, identity.participantId, room.game_version === "2" ? 2 : 1, requestId),
      });
    }
    await authorizeTeacherOwner(dependencies, request, room);
    return jsonResponse({
      room: roomView(room, nowMs),
      ranking,
      aggregate: await teacherResultAggregate(dependencies.database, room),
    });
  }, "results");

  const resultSummary = (request: Request, parameters: RouteParameters) => resultSafe(async (_requestId, setProtocolVersion) => {
    let room = await loadRoom(dependencies.database, parameters.id);
    setProtocolVersion(room.game_version === "2" ? 2 : 1);
    const nowMs = dependencies.now();
    requireUnexpired(room, nowMs);
    await tryFinalize(dependencies.database, room, nowMs);
    room = await loadRoom(dependencies.database, room.id);
    if (stateOf(room, nowMs) !== "FINISHED") throw new ApiError(409, "results_not_ready", "結果はまだ確定していません");
    if (request.headers.has("authorization")) {
      const identity = await requireParticipant(dependencies.database, request, room.id);
      const own = await loadAuthorizedResult(dependencies.database, {
        roomId: room.id, participantId: identity.participantId, tokenHash: identity.tokenHash, nowMs,
      });
      const progress = room.game_version === "2" ? await dependencies.database.prepare(`SELECT finished_elapsed_ms, boundary_ack_at_ms, finish_reason
        FROM v2_participant_progress WHERE room_id = ? AND participant_id = ?`)
        .bind(room.id, identity.participantId).first<{ finished_elapsed_ms: number | null; boundary_ack_at_ms: number | null; finish_reason: string | null }>() : null;
      return jsonResponse({ room: roomView(room, nowMs), own: { ...own,
        ...(progress ? { finalSyncUnconfirmed: progress.finished_elapsed_ms == null && progress.boundary_ack_at_ms == null,
          finishReason: progress.finish_reason === "submitted" ? "submitted" : own.finishReason } : {}) } });
    }
    await authorizeTeacherOwner(dependencies, request, room);
    return jsonResponse({ room: roomView(room, nowMs) });
  }, "result-summary");

  const teacherQuestionProfile = (request: Request) => safe(async () => {
    const teacher = await requireApplicationTeacher(dependencies, request);
    if (!dependencies.serverConfig.masterTeacherEmail || teacher.email !== dependencies.serverConfig.masterTeacherEmail) {
      throw new ApiError(403, "master_required", "管理者教員のみ操作できます");
    }
    const catalog = questionProfileCatalog();
    if (request.method === "GET") return jsonResponse({ ...await readQuestionProfile(dependencies.database), catalog });
    if (request.method !== "PATCH") throw new ApiError(405, "method_not_allowed", "この操作は利用できません");
    const { value, bodyHash } = await readMutationBody(request);
    assertKeys(value, ["requestId", "profile", "expectedRevision"]);
    let profile;
    try { profile = validateQuestionProfileShape(value.profile); validateQuestionProfile(profile); }
    catch (error) { throw new ApiError(400, "invalid_question_profile", error instanceof Error ? error.message : "出題設定を確認してください"); }
    const saved = await updateQuestionProfile(dependencies.database, {
      teacherId: teacher.id, requestId: requestId(value.requestId), bodyHash,
      expectedRevision: integerValue(value.expectedRevision, "expectedRevision"), profile, nowMs: dependencies.now(),
    });
    return jsonResponse({ ...saved, catalog });
  });

  const teacherSiteSettings = (request: Request) => safe(async () => {
    const teacher = await requireApplicationTeacher(dependencies, request);
    const nowMs = dependencies.now();
    if (!dependencies.skipLazyCleanup) await cleanupExpired(dependencies.database, { nowMs, limit: LAZY_CLEANUP_LIMIT });
    if (request.method === "GET") return jsonResponse(await readMateEnabled(dependencies.database));
    if (!dependencies.serverConfig.masterTeacherEmail || teacher.email !== dependencies.serverConfig.masterTeacherEmail) {
      throw new ApiError(403, "master_required", "マスター教員のみ操作できます");
    }
    const { value, bodyHash } = await readMutationBody(request);
    assertKeys(value, ["requestId", "enabled", "expectedRevision"]);
    if (typeof value.enabled !== "boolean") throw new ApiError(400, "invalid_request", "enabledが不正です");
    return jsonResponse(await updateSiteSettingsCommand(dependencies.database, {
      teacherId: teacher.id,
      requestId: requestId(value.requestId),
      bodyHash,
      expectedRevision: integerValue(value.expectedRevision, "expectedRevision"),
      enabled: value.enabled,
      nowMs,
    }));
  });

  const teacherSession = (request: Request) => safe(async () => {
    const teacher = await requireApplicationTeacher(dependencies, request);
    return jsonResponse({ email: teacher.email, role: teacher.email === dependencies.serverConfig.masterTeacherEmail ? "master" : "teacher" });
  });

  const teacherAllowlist = (request: Request) => safe(async () => {
    const teacher = await requireVerifiedTeacher(request, dependencies.teacherIdentity);
    const master = dependencies.serverConfig.masterTeacherEmail;
    if (!master || teacher.email !== master) throw new ApiError(403, "master_required", "マスター教員のみ操作できます");
    let current = await readTeacherAllowlist(dependencies.database);
    const view = (row: AllowlistRow) => ({ masterEmail: master, emails: JSON.parse(row.emails_json) as string[], revision: row.revision });
    if (request.method === "GET") return jsonResponse(view(current));
    const { value, bodyHash } = await readMutationBody(request);
    assertKeys(value, ["email", "enabled", "expectedRevision", "requestId"]);
    const key = requestId(value.requestId);
    const expected = integerValue(value.expectedRevision, "expectedRevision");
    if (typeof value.email !== "string" || typeof value.enabled !== "boolean") throw new ApiError(400, "invalid_request", "メールアドレスと操作を指定してください");
    const email = normalizeTeacherEmail(value.email);
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "invalid_email", "メールアドレスを確認してください");
    if (email === master) throw new ApiError(400, "master_fixed", "マスター教員はこの画面では変更できません");
    if (current.last_request_id === key) {
      if (current.last_body_hash !== bodyHash) throw new ApiError(409, "request_id_reused", "操作IDが再利用されています");
      return jsonResponse(view(current));
    }
    if (current.revision !== expected) throw new ApiError(409, "stale_allowlist", "一覧が更新されました。再読み込みしてから操作してください");
    const emails = new Set<string>(JSON.parse(current.emails_json));
    if (value.enabled) emails.add(email); else emails.delete(email);
    if (emails.size > 100) throw new ApiError(400, "allowlist_limit", "許可教員は100件まで登録できます");
    const result = await dependencies.database.batch([
      dependencies.database.prepare("INSERT OR IGNORE INTO teacher_allowlist (id) VALUES (1)"),
      dependencies.database.prepare("UPDATE teacher_allowlist SET emails_json = ?, revision = revision + 1, last_request_id = ?, last_body_hash = ? WHERE id = 1 AND revision = ?")
        .bind(JSON.stringify([...emails].sort()), key, bodyHash, expected),
    ]);
    current = await readTeacherAllowlist(dependencies.database);
    if (!result[1]?.meta.changes && !(current.last_request_id === key && current.last_body_hash === bodyHash)) throw new ApiError(409, "stale_allowlist", "一覧が更新されました。再読み込みしてから操作してください");
    return jsonResponse(view(current));
  });

  return {
    teacherQuestionProfile,
    teacherSession,
    teacherAllowlist,
    publicConfig,
    joinInfo,
    createClassRoom,
    createMateRoom,
    joinRoom: join,
    nickname,
    updateRoomSettings,
    startRoom: start,
    startStatus,
    manifest,
    ready,
    cancelPreparation,
    operations,
    writer,
    cancelRoom: cancel,
    interruptRoom: interrupt,
    removeParticipant,
    actions,
    state,
    results,
    resultSummary,
    teacherSiteSettings,
  };
}

export type CompetitionApiHandlers = ReturnType<typeof createApiHandlers>;
