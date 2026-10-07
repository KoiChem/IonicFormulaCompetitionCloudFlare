import { appPath, parseRoute } from '../../web/routing';
import { isValidJoinCode, normalizeJoinCode } from './join-code';
export type JoinQrTarget = { code: string } | { roomId: string };

export function parseJoinQr(value: string, origin: string, base: string): JoinQrTarget | null {
  if (isValidJoinCode(value)) return { code: normalizeJoinCode(value) };
  try {
    const url = new URL(value.trim());
    if (url.origin !== origin || url.pathname !== base || url.username || url.password || url.search) return null;
    const route = parseRoute(url.hash);
    const match = /^\/join(?:\/([A-Za-z0-9_-]{1,128}))?$/u.exec(route.path);
    if (!match) return null;
    const params = new URLSearchParams(route.search);
    const codes = params.getAll('code');
    if (codes.length) return codes.length === 1 && isValidJoinCode(codes[0]) ? { code: normalizeJoinCode(codes[0]) } : null;
    return match[1] ? { roomId: match[1] } : null;
  } catch { return null; }
}

export function joinQrPath(roomId: string, code: string, base?: string): string {
  return appPath(`/join/${encodeURIComponent(roomId)}?code=${encodeURIComponent(normalizeJoinCode(code))}`, base);
}
