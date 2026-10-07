const HUE_SLOTS = 42;
const HUE_STEP = 17; // Coprime with 42: visits every hue, with ~146° between neighbors.
const MIN_CHANNEL = 16;
const MIN_CHANNEL_VARIANTS = 25;
const MAX_CHANNEL = 96;
const MAX_CHANNEL_VARIANTS = 49;
const SHADE_VARIANTS = MIN_CHANNEL_VARIANTS * MAX_CHANNEL_VARIANTS;
const INITIAL_SHADE = (132 - MAX_CHANNEL) * MIN_CHANNEL_VARIANTS + (21 - MIN_CHANNEL);

function colorAtHue(hue: number, min: number, max: number): string {
  const sector = hue / 60;
  const rising = min + (max - min) * (sector % 1);
  const falling = max - (max - min) * (sector % 1);
  const channels = [
    [max, rising, min], [falling, max, min], [min, max, rising],
    [min, falling, max], [rising, min, max], [max, min, falling],
  ][Math.floor(sector)];
  return '#' + channels.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('');
}

export const runnerPalette = Array.from({ length: HUE_SLOTS }, (_, slot) => colorAtHue(slot * 360 / HUE_SLOTS, 21, 132));

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
  const cycle = Math.floor((order - 1) / HUE_SLOTS);
  if (cycle === 0) return runnerPalette[slot];

  // Removed participants keep their slots. Continue the hue spacing for replacements,
  // varying RGB extrema per 42 lifetime joins so colors do not repeat after one class.
  // All 1,225 shades are dark and chromatic; 51,450 distinct slots before repetition.
  const shade = (INITIAL_SHADE + cycle % SHADE_VARIANTS) % SHADE_VARIANTS;
  const min = MIN_CHANNEL + shade % MIN_CHANNEL_VARIANTS;
  const max = MAX_CHANNEL + Math.floor(shade / MIN_CHANNEL_VARIANTS);
  return colorAtHue(slot * 360 / HUE_SLOTS, min, max);
}
