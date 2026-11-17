/**
 * One market's fills in the order they happened.
 *
 * The venue stamps a fill to the millisecond, and one order sweeping the
 * book (a stop going off, a market order) is many fills with the same stamp.
 * Their ids say nothing about which came first. What does is the position
 * the venue records before each: every fill starts where the last one left
 * it. So fills sharing a stamp are chained by that, and the id only breaks
 * a tie the chain cannot.
 *
 * Read by id, the fill that took a position to flat could land in the
 * middle of its own order, and the trade looked closed with most of its
 * size unaccounted for.
 */
export interface OrderedFill {
  time: number;
  tid: number;
  side: string;
  sz: number;
  startPosition: number;
}

const afterOf = (f: OrderedFill) => f.startPosition + (f.side === "B" ? f.sz : -f.sz);
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 1e-9, Math.abs(b) * 1e-9);

/** Fills of ONE market, oldest first, same-stamp fills chained by the venue's own position count. */
export function inVenueOrder<F extends OrderedFill>(fills: F[]): F[] {
  const sorted = [...fills].sort((a, b) => a.time - b.time || a.tid - b.tid);
  const out: F[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].time === sorted[i].time) j++;
    if (j - i === 1) {
      out.push(sorted[i]);
    } else {
      const left = sorted.slice(i, j);
      let expected: number | null = out.length ? afterOf(out[out.length - 1]) : null;
      while (left.length) {
        let k = expected == null ? -1 : left.findIndex((f) => near(f.startPosition, expected!));
        // No fill continues from the last: start from the one no other fill here leads into.
        if (k < 0) k = left.findIndex((f) => !left.some((g) => g !== f && near(afterOf(g), f.startPosition)));
        if (k < 0) k = 0;
        const [f] = left.splice(k, 1);
        out.push(f);
        expected = afterOf(f);
      }
    }
    i = j;
  }
  return out;
}
