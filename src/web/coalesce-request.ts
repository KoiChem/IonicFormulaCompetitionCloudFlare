export function coalesceRequest<T>(run: () => Promise<T>): (fresh?: boolean) => Promise<T> {
  let pending: Promise<T> | undefined;
  let trailing: Promise<T> | undefined;
  const fetch = (fresh = false): Promise<T> => {
    // An event/mutation can invalidate a snapshot already being fetched. Share
    // ordinary reads, but preserve one subsequent read for those invalidations.
    if (pending && fresh) {
      return trailing ??= pending.catch(() => {}).then(() => {
        trailing = undefined;
        return fetch();
      });
    }
    if (!pending) pending = run().finally(() => { pending = undefined; });
    return pending;
  };
  return fetch;
}
