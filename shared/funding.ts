/**
 * What a perp position paid, or was paid, to stay open.
 *
 * A perpetual has no expiry, so it is tethered to spot by funding: every
 * hour on Hyperliquid, every eight on Binance, longs pay shorts when the rate
 * is positive and shorts pay longs when it is negative. Over a thirty-hour
 * swing that is several payments, and the journal's net P&L ignored every
 * one of them — a trade could book +$40 and have handed $15 of it back to
 * the other side of the book without a line saying so.
 *
 * This is an ESTIMATE, and labelled one everywhere it appears: the venue's
 * rate history times the position's notional at each settlement the hold
 * spanned. The venue charges on the mark price and the live position size;
 * this uses the entry price and the opening size. For the trades a person
 * logs by hand that is the best the record supports, and it is within a
 * few percent of the truth on any trade that was not scaled in and out
 * violently. A number this close beats a blank, as long as it says what it
 * is.
 */

export interface FundingEvent {
  /** Epoch ms of the settlement. */
  time: number;
  /** The rate per settlement, as a fraction: 0.0001 is one basis point. */
  rate: number;
}

export interface FundingEstimate {
  /** Net as it hit the account: positive received, negative paid. */
  funding: number;
  /** Settlements the hold spanned. Zero means the estimate rests on nothing. */
  events: number;
}

/**
 * Sum the settlements the hold was open across.
 *
 * Open BEFORE a settlement and still open AT it is what gets charged, so the
 * entry is strict and the exit inclusive. A long pays the rate; a short is
 * paid it; a negative rate flips both.
 */
export function estimateFunding(
  t: { direction: string; notional: number; entryMs: number; exitMs: number },
  events: FundingEvent[],
): FundingEstimate {
  const long = t.direction !== "short";
  let funding = 0;
  let n = 0;
  for (const e of events) {
    if (!(e.time > t.entryMs && e.time <= t.exitMs)) continue;
    if (!Number.isFinite(e.rate)) continue;
    const paidByLongs = e.rate * t.notional;
    funding += long ? -paidByLongs : paidByLongs;
    n += 1;
  }
  return { funding, events: n };
}

/**
 * Binance's archive writes funding as CSV, one row per settlement:
 * `calc_time,funding_interval_hours,last_funding_rate`. A header line is
 * present in the newer files and absent in the older ones, which is why the
 * first field is read as a number rather than trusted to be one.
 */
export function parseBinanceFundingCsv(csv: string): FundingEvent[] {
  const out: FundingEvent[] = [];
  for (const line of csv.split("\n")) {
    const f = line.trim().split(",");
    if (f.length < 3) continue;
    const time = Number(f[0]);
    const rate = Number(f[2]);
    if (!Number.isFinite(time) || !Number.isFinite(rate)) continue;
    out.push({ time, rate });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** The month files a hold spans, as "YYYY-MM", oldest first. */
export function fundingMonths(entryMs: number, exitMs: number): string[] {
  const out: string[] = [];
  const d = new Date(entryMs);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  const end = new Date(exitMs);
  const endKey = end.getUTCFullYear() * 12 + end.getUTCMonth();
  while (y * 12 + m <= endKey) {
    out.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    m += 1;
    if (m === 12) {
      m = 0;
      y += 1;
    }
  }
  return out;
}
