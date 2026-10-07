export function normalizeJoinCode(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidJoinCode(value: string): boolean {
  return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/u.test(normalizeJoinCode(value));
}
