import { PUBLIC_CONFIG } from "../config/public";
import type {
  AcceptElapsedInput,
  AcceptedElapsed,
  RejectedElapsed,
} from "./types";

export function toCentiseconds(elapsedMs: number): number {
  return Math.floor(elapsedMs / 10);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function acceptElapsed(
  input: AcceptElapsedInput,
): AcceptedElapsed | RejectedElapsed {
  if (input.serverNowMs < input.startAtMs) {
    return { accepted: false, reason: "not_started" };
  }
  if (input.serverNowMs >= input.deadlineAtMs) {
    return { accepted: false, reason: "deadline" };
  }

  const limitMs = input.deadlineAtMs - input.startAtMs;
  const authoritativeElapsedMs = clamp(
    input.serverNowMs - input.startAtMs,
    0,
    limitMs,
  );
  const fallbackElapsedMs = clamp(
    authoritativeElapsedMs,
    input.previousAcceptedElapsedMs,
    limitMs,
  );
  const aheadToleranceMs = input.aheadToleranceMs
    ?? PUBLIC_CONFIG.timingToleranceMs.aheadOfServer;
  const behindToleranceMs = input.behindToleranceMs
    ?? PUBLIC_CONFIG.timingToleranceMs.behindServer;
  const clientElapsedMs = input.clientElapsedMs;
  const validClientTime = input.previousTimingSource === "client"
    && typeof clientElapsedMs === "number"
    && Number.isFinite(clientElapsedMs)
    && clientElapsedMs >= input.previousAcceptedElapsedMs
    && clientElapsedMs >= 0
    && clientElapsedMs <= limitMs
    && clientElapsedMs - authoritativeElapsedMs <= aheadToleranceMs
    && authoritativeElapsedMs - clientElapsedMs <= behindToleranceMs;
  const acceptedElapsedMs = validClientTime ? clientElapsedMs : fallbackElapsedMs;
  const timingSource = validClientTime ? "client" : "server_fallback";

  return {
    accepted: true,
    acceptedElapsedMs,
    elapsedCs: toCentiseconds(acceptedElapsedMs),
    timingSource,
  };
}
