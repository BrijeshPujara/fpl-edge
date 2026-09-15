/**
 * `Promise.all` over a list, but only `limit` at a time.
 *
 * For fan-out to the FPL API, which throttles a burst: a league page wants one
 * history per manager, fifty at once is a burst, and six at a time is not.
 * Results keep the input order. `fn` should handle its own failures — one
 * rejection rejects the whole call, exactly as `Promise.all` would.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    },
  );

  await Promise.all(workers);
  return results;
}
