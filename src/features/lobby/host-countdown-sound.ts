import { useEffect, useRef, type RefObject } from "react";
import { countdownSeconds } from "../play/useRoomSync";
import { playCountdownTick, savedSoundLevel } from "../play/audio-feedback";

export class CountdownSoundGate {
  private startAtMs: number | null = null;
  private lastSecond: number | null = null;

  observe(startAtMs: number, second: number, visible: boolean): boolean {
    if (this.startAtMs !== startAtMs) {
      this.startAtMs = startAtMs;
      this.lastSecond = null;
    }
    if (this.lastSecond === second) return false;
    this.lastSecond = second;
    return visible && second >= 1 && second <= 5;
  }
}

export function useHostCountdownSound(active: boolean, startAtMs: number | null | undefined, clockRef: RefObject<{ serverNowMs(now: number): number | null } | null>, fallbackServerNow: number | undefined) {
  const gate = useRef(new CountdownSoundGate());
  useEffect(() => {
    if (!active || startAtMs == null) return;
    const sample = () => {
      const now = clockRef.current?.serverNowMs(performance.now()) ?? fallbackServerNow;
      if (now == null) return;
      const second = countdownSeconds(startAtMs, now);
      if (gate.current.observe(startAtMs, second, !document.hidden)) playCountdownTick(savedSoundLevel());
    };
    sample();
    const timer = window.setInterval(sample, 100);
    return () => window.clearInterval(timer);
  }, [active, startAtMs, clockRef, fallbackServerNow]);
}
