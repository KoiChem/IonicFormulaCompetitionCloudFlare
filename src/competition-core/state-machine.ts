import type { RoomState, TimedRoomState } from "./types";

export function effectiveRoomState(room: TimedRoomState, nowMs: number): RoomState {
  if (room.storedState === "CANCELLED" || room.storedState === "EXPIRED") {
    return room.storedState;
  }
  if (room.storedState === "FINISHED") return "FINISHED";

  if (
    (room.storedState === "COUNTDOWN" || room.storedState === "RUNNING")
    && room.deadlineAtMs != null
    && nowMs >= room.deadlineAtMs
  ) {
    return "FINISHED";
  }
  if (
    room.storedState === "COUNTDOWN"
    && room.startAtMs != null
    && nowMs >= room.startAtMs
  ) {
    return "RUNNING";
  }
  return room.storedState;
}
