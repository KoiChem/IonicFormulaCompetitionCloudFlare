import { describe, expect, it } from 'vitest';
import { colorForRunner, runnerPalette } from '../../src/features/lobby/host-race-colors';

const reference = ['#ef0000', '#f56b00', '#fca000', '#ffcd00', '#fff500', '#d8de00', '#9ec700', '#4dae0f', '#009824', '#009b71', '#009e9f', '#01a1c5', '#00a3e8', '#008dcf', '#0073b6', '#01519a', '#000c7a', '#6c087c', '#a1017f', '#cb0080', '#f00183', '#ee0070', '#ef005b', '#ef003b'];

describe('room runner colors', () => {
  it('uses the exact 24 sampled colors without modifying their shades', () => {
    expect(runnerPalette).toEqual(reference);
  });
  it('visits all colors in widely spaced steps and repeats after 24 lifetime joins', () => {
    for (const room of ['room-a', 'room-b', '57c0bb6b-78b3-4a89-90ee-99e86b0b4a41']) {
      const colors = Array.from({ length: 72 }, (_, index) => colorForRunner(room, index + 1));
      expect(new Set(colors.slice(0, 24)).size).toBe(24);
      expect([...colors.slice(0, 24)].sort()).toEqual([...reference].sort());
      for (let i = 1; i < colors.length; i++) {
        const step = (reference.indexOf(colors[i]) - reference.indexOf(colors[i - 1]) + 24) % 24;
        expect([7, 17]).toContain(step);
        if (i >= 24) expect(colors[i]).toBe(colors[i - 24]);
      }
    }
  });
  it('varies room starts while reproducing identities through rank changes and reloads', () => {
    const rooms = Array.from({ length: 500 }, (_, index) => `random-room-${index}`);
    expect(new Set(rooms.map(room => colorForRunner(room, 1))).size).toBe(24);
    const original = [1, 2, 3, 4].map(order => colorForRunner('room-a', order));
    expect([4, 2].map(order => colorForRunner('room-a', order))).toEqual([original[3], original[1]]);
    expect([1, 2, 3, 4].map(order => colorForRunner('room-a', order))).toEqual(original);
    expect(colorForRunner('room-a', 1)).not.toBe(colorForRunner('room-b', 1));
  });
  it('falls back to the first identity for invalid join orders', () => {
    for (const order of [0, -1, NaN, Infinity, 1.5]) expect(colorForRunner('room-a', order)).toBe(colorForRunner('room-a', 1));
  });
});
