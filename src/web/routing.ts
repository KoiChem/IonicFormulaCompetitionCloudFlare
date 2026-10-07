export function appPath(path: string, base = import.meta.env?.BASE_URL ?? '/IonicFormulaCompetition/'): string {
  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\\]/u.test(path)) throw new Error('Invalid app route');
  return `${base.endsWith('/') ? base : `${base}/`}#${path}`;
}
export function parseRoute(hash: string) {
  const input = hash.startsWith('#/') ? hash.slice(1) : '/';
  const queryAt = input.indexOf('?');
  return { path: queryAt < 0 ? input : input.slice(0, queryAt), search: queryAt < 0 ? '' : input.slice(queryAt) };
}
export const routeSearch = () => parseRoute(window.location.hash).search;
