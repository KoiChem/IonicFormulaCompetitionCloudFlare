// Clockwise samples from the approved reference; keep their original shades.
export const runnerPalette = [
  '#ef0000', '#f56b00', '#fca000', '#ffcd00', '#fff500', '#d8de00',
  '#9ec700', '#4dae0f', '#009824', '#009b71', '#009e9f', '#01a1c5',
  '#00a3e8', '#008dcf', '#0073b6', '#01519a', '#000c7a', '#6c087c',
  '#a1017f', '#cb0080', '#f00183', '#ee0070', '#ef005b', '#ef003b',
];
const HUE_SLOTS = runnerPalette.length;
const HUE_STEP = 7; // Coprime with 24: spaced neighbors visit every sample before repeating.

function roomSeed(roomId: string): number {
  let seed = 2166136261;
  for (const char of roomId) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return (seed >>> 0) || 1;
}

function nextSeed(seed: number): number {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return seed >>> 0;
}

/** Random room UUID fixes the starting hue and direction; joinedOrder fixes identity. */
export function colorForRunner(roomId: string, joinedOrder: number): string {
  const order = Number.isSafeInteger(joinedOrder) && joinedOrder > 0 ? joinedOrder : 1;
  const seed = nextSeed(roomSeed(roomId));
  const start = Math.floor(seed / 4294967296 * HUE_SLOTS);
  const direction = (nextSeed(seed) & 1) === 0 ? 1 : -1;
  const slot = (start + direction * ((order - 1) % HUE_SLOTS) * HUE_STEP % HUE_SLOTS + HUE_SLOTS) % HUE_SLOTS;
  return runnerPalette[slot];
}
