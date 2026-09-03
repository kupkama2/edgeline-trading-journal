/**
 * Run a batch of async jobs a few at a time, and keep every result.
 *
 * Both venue readers need this: the archive fetches a day-file per day of
 * a window, the bucket listing probes one folder per perp. Sequential was
 * the original for the archive — thirty day-files at half a second each is
 * fifteen seconds of "Loading the price path…" — and unbounded parallelism
 * is how a public bucket starts answering 503 to a journal.
 *
 * Results come back settled and IN INPUT ORDER, never thrown, so a caller
 * that stops at the first missing file can still do so by walking the array;
 * the pool does not know which failure is a hole and which is a nuisance.
 */
export async function settleAll<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  return out;
}
