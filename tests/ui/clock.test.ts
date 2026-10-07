import { describe, expect, it } from "vitest";

import { CompetitionClock, chooseBestClockSample, formatCentiseconds } from "../../src/features/play/clock";

describe("competition clock", () => {
  it("uses the server sample with the lowest round-trip time", () => {
    const sample = chooseBestClockSample([
      { sentAt: 100, receivedAt: 180, serverNow: 1_000 },
      { sentAt: 200, receivedAt: 220, serverNow: 1_110 },
      { sentAt: 300, receivedAt: 350, serverNow: 1_220 },
    ]);
    expect(sample.roundTripMs).toBe(20);
    expect(sample.serverAtPerformanceOriginMs).toBe(900);
  });

  it("formats elapsed time at centisecond precision", () => {
    expect(formatCentiseconds(1_347)).toBe("00:13.47");
  });

  it("never moves behind a confirmed elapsed time after resync", () => {
    const clock = new CompetitionClock(10_000);
    clock.synchronize({ sentAt: 100, receivedAt: 120, serverNow: 10_110 });
    expect(clock.elapsedMs(2_000)).toBe(2_000);
    clock.confirm(2_500);
    clock.synchronize({ sentAt: 3_000, receivedAt: 3_020, serverNow: 11_010 });
    expect(clock.elapsedMs(3_020)).toBe(2_500);
  });

  it("marks the clock unsynchronized while returning from the background", () => {
    const clock = new CompetitionClock(10_000);
    clock.synchronize({ sentAt: 100, receivedAt: 120, serverNow: 10_110 });
    clock.requireResync();
    expect(clock.isSynchronized).toBe(false);
    expect(clock.captureElapsedMs(1_000)).toBeNull();
  });
});

it('removes uneven Edge processing delay from the clock offset',()=>{
 const sample=chooseBestClockSample([{sentAt:100,receivedAt:2300,serverNow:12000,
  serverTiming:{receivedAtMs:10100,sentAtMs:12100}}]);
 expect(sample.serverAtPerformanceOriginMs).toBe(9900);
 expect(sample.roundTripMs).toBe(200);
});
