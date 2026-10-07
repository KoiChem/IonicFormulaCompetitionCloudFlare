export type RecoveryDestination = "room" | "results" | "none";

export function recoveryDestination(state: string): RecoveryDestination {
  if (["WAITING", "PREPARING", "COUNTDOWN", "RUNNING", "COLLECTING"].includes(state)) return "room";
  if (state === "FINISHED") return "results";
  return "none";
}

export function shouldWarnBeforeLeaving(state: string | undefined): boolean {
  return state === "PREPARING" || state === "COUNTDOWN" || state === "RUNNING" || state === "COLLECTING";
}
