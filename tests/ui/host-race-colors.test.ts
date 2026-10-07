import { describe, expect, it } from 'vitest';
import { colorForRunner } from '../../src/features/lobby/host-race-colors';

function rgb(color: string) { return color.slice(1).match(/../g)!.map(channel => parseInt(channel, 16)); }
function hue(color: string) {
  const [r, g, b] = rgb(color), max = Math.max(r, g, b), min = Math.min(r, g, b), range = max - min;
  return ((max === r ? (g - b) / range : max === g ? (b - r) / range + 2 : (r - g) / range + 4) * 60 + 360) % 360;
}
function hueDistance(a: string, b: string) {
  const difference = Math.abs(hue(a) - hue(b));
  return Math.min(difference, 360 - difference);
}
function luminance(color: string) {
  const channels = rgb(color).map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

describe('room runner colors', () => {
  it('separates neighboring join orders even across replacement-join palette boundaries', () => {
    for (const room of ['room-a', 'room-b', '57c0bb6b-78b3-4a89-90ee-99e86b0b4a41']) {
      const colors = Array.from({ length: 200 }, (_, index) => colorForRunner(room, index + 1));
      for (const [gap, minimum] of [[1, 143], [2, 66], [3, 74]]) {
        for (let index = gap; index < colors.length; index++) {
          expect(hueDistance(colors[index], colors[index - gap])).toBeGreaterThan(minimum);
        }
      }
    }
  });
  it('keeps colored strokes visible on the pale race background', () => {
    const background = luminance('#f4faf7');
    for (let order = 1; order <= 2000; order++) {
      expect((background + 0.05) / (luminance(colorForRunner('room-a', order)) + 0.05)).toBeGreaterThan(3);
    }
  });
  it('varies the first color across rooms while reproducing it on every reload', () => {
    const rooms = Array.from({ length: 500 }, (_, index) => `random-room-${index}`);
    const first = rooms.map(room => colorForRunner(room, 1));
    expect(new Set(first).size).toBe(42);
    expect(rooms.map(room => colorForRunner(room, 1))).toEqual(first);
  });
  it('assigns distinct colors to all 42 class participants, including identical ID hash buckets', () => {
    const colors = Array.from({ length: 42 }, (_, index) => colorForRunner('room-a', index + 1));
    expect(new Set(colors).size).toBe(42);
  });
  it('keeps colors fixed through rank changes, removed participants and reloads', () => {
    const original = [1, 2, 3, 4].map(order => colorForRunner('room-a', order));
    expect([4, 2].map(order => colorForRunner('room-a', order))).toEqual([original[3], original[1]]);
    expect(colorForRunner('room-a', 5)).not.toBe(original[1]);
    expect([1, 2, 3, 4].map(order => colorForRunner('room-a', order))).toEqual(original);
  });
  it('shuffles the palette independently for each random room ID', () => {
    const colors = (room: string) => Array.from({ length: 42 }, (_, index) => colorForRunner(room, index + 1));
    expect(colors('room-a')).not.toEqual(colors('room-b'));
    expect([...colors('room-a')].sort()).toEqual([...colors('room-b')].sort());
  });
  it('does not recycle occupied colors when removals allow more than 42 lifetime joins', () => {
    const colors = Array.from({ length: 10000 }, (_, index) => colorForRunner('room-a', index + 1));
    expect(new Set(colors).size).toBe(10000);
    for (const color of colors) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });
});
