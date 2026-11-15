/**
 * One line per trade: a save waits for the save before it on the same
 * trade, and for nothing else. A save that fails does not hold up the next.
 */
const lines = new Map<number, Promise<unknown>>();

export function inTradeOrder<T>(id: number, run: () => Promise<T>): Promise<T> {
  const before = lines.get(id) ?? Promise.resolve();
  const mine = before.then(run, run);
  const tail = mine.catch(() => undefined);
  lines.set(id, tail);
  void tail.then(() => {
    if (lines.get(id) === tail) lines.delete(id);
  });
  return mine;
}
