/** Built-in Edge DB URL is direct. Reuse its credentials only on the project's
 * verified transaction pooler, avoiding a physical DB connection per isolate. */
export function transactionPoolerUrl(directUrl: string, projectRef: string, poolerHost: string): string {
  const url = new URL(directUrl);
  if (url.hostname !== `db.${projectRef}.supabase.co` || url.username !== 'postgres') {
    throw new Error('Unexpected built-in database topology');
  }
  url.hostname = poolerHost;
  url.port = '6543';
  url.username = `postgres.${projectRef}`;
  return url.toString();
}
