/**
 * The relative-strength screener's arithmetic: alts against BTC, on candles.
 *
 * Everything here is pure and runs on arrays the server fetched, so the
 * numbers can be checked by hand against the candles and tested without a
 * venue. Two series per coin are enough: hourly bars for the short
 * timeframes and daily bars for the long ones. A "timeframe" is a rolling
 * window of L base bars — 4h is the last four hourly bars, 1W the last
 * seven daily — which keeps every derived timeframe exactly the data it
 * was derived from, with no alignment to argue about.
 *
 * Definitions, so the table can be audited:
 *
 *   ratio       alt close ÷ BTC close, on bars with the same timestamp
 *   RS change   ratio[last] ÷ ratio[last − L] − 1
 *   accel       the last L-bar change against the mean L-bar change over the
 *               previous W blocks of L bars (the "longer window"); ↑ when it
 *               is clearly above the mean, ↓ when clearly below, → between
 *   breakout    ratio[last] is the highest of the last 20 block closes
 *               (block closes sampled every L bars back from the last bar)
 *   RVOL        volume of the last L bars ÷ mean volume of the previous 20
 *               blocks of L bars
 *
 * A timeframe short of bars answers null, never a made-up number; the row
 * shows "—" there and stays in the table.
 */

export interface ScreenerCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Timeframe = "1h" | "4h" | "12h" | "1D" | "1W" | "1M";
export const TIMEFRAMES: Timeframe[] = ["1h", "4h", "12h", "1D", "1W", "1M"];

/** Which fetched series a timeframe runs on, how many base bars make one block, and the acceleration window in blocks. */
export const TF_SPEC: Record<Timeframe, { base: "1h" | "1d"; bars: number; accelBlocks: number; label: string }> = {
  "1h": { base: "1h", bars: 1, accelBlocks: 24, label: "last hour vs the mean hour of the past day" },
  "4h": { base: "1h", bars: 4, accelBlocks: 30, label: "last 4h vs the mean 4h of the past 5 days" },
  "12h": { base: "1h", bars: 12, accelBlocks: 20, label: "last 12h vs the mean 12h of the past 10 days" },
  "1D": { base: "1d", bars: 1, accelBlocks: 20, label: "last day vs the mean day of the past 20 days" },
  "1W": { base: "1d", bars: 7, accelBlocks: 12, label: "last week vs the mean week of the past 12 weeks" },
  "1M": { base: "1d", bars: 30, accelBlocks: 6, label: "last 30 days vs the mean 30 days of the past 180" },
};

/** The chart window per timeframe, in ms: what the spaghetti chart shows. */
export const CHART_WINDOW_MS: Record<Timeframe, number> = {
  "1h": 48 * 3600_000,
  "4h": 10 * 86400_000,
  "12h": 30 * 86400_000,
  "1D": 90 * 86400_000,
  "1W": 365 * 86400_000,
  "1M": Number.POSITIVE_INFINITY,
};

export const BREAKOUT_PERIODS = 20;
export const RVOL_PERIODS = 20;
/** Fewer prior blocks than this and the breakout and RVOL answer null. */
const MIN_PRIOR_BLOCKS = 5;

export type Accel = "up" | "steady" | "down";

export interface TfMetrics {
  /** % change of the RS ratio over the timeframe, as a fraction (0.05 = +5%). */
  rs: number | null;
  accel: Accel | null;
  breakout: boolean | null;
  rvol: number | null;
  /** The 20-block high of the ratio before the last block: the level a breakout is measured against. */
  breakoutLevel: number | null;
}

export interface TfFlags {
  /** Top 10% of the universe by RS change on this timeframe, and accelerating. */
  movingFast: boolean;
  /** Moving fast, volume-confirmed, and not leverage-driven. */
  candidate: boolean;
  /** Bottom 10% by RS change: rotation out. */
  weakest: boolean;
  /** RVOL at or above the setting. */
  volumeConfirmed: boolean;
}

export interface ScreenerRow {
  coin: string;
  /** What its strength is measured against: a stock or an index against the venue's broad stock index. Absent means BTC. */
  benchmark?: string;
  /** Added by hand from the search: read whatever its volume. */
  pinned?: boolean;
  /** The venue's mark price at the run. */
  mark: number | null;
  /** 24h notional volume in USD. */
  volume24h: number | null;
  /** Current funding, annualized (0.1 = 10% a year). */
  fundingAnnual: number | null;
  /** Current funding as the venue gives it, per hour. */
  fundingHourly: number | null;
  openInterest: number | null;
  /** Open interest against the previous snapshot, as a fraction; null without one. */
  oiChange: number | null;
  /** RS up, funding in the top decile of the universe and OI up ≥ 15%. */
  leverageDriven: boolean;
  tf: Record<Timeframe, TfMetrics>;
  flags: Record<Timeframe, TfFlags>;
  /** Price readings per timeframe (RSI, trend, ATR, highs), and RS against ETH and the alt basket. */
  price: Record<Timeframe, PriceReadings>;
  /** The readings as +1/0/−1 and their sum, with any divergence, per timeframe. */
  signals: Record<Timeframe, Signals>;
  /** Open interest against price from the hourly snapshots, the premium, and funding's place in the universe. */
  positioning: Positioning | null;
  /** Binance's order flow and positioning for the same coin, read through the relay; null without one. */
  flow?: FlowReadings | null;
  /** Taker flow on Binance's spot book, read by the server itself; null when the coin has no spot pair there. */
  spot?: SpotFlow | null;
  /** What Hyperliquid's largest accounts hold in it, net. */
  top?: TopAccounts | null;
  /** Strength beyond the ratio: beta to BTC, what it keeps on BTC's red hours, its rank and the rank a week ago. */
  strength?: Strength | null;
  /** Where Hyperliquid's largest accounts would be liquidated, in bands around the mark. */
  liq?: LiqMap | null;
  /** Why the coin could not be measured, when it could not. */
  error: string | null;
  /** How many bars each series had: the evidence behind a "—". */
  bars: { "1h": number; "1d": number };
  /** RSI's recent peak and trough per timeframe, for the divergence read; dropped once the signals are made. */
  rsiPeak?: Record<Timeframe, number | null>;
  rsiTrough?: Record<Timeframe, number | null>;
}

export interface ScreenerSettings {
  /** Minimum 24h notional volume, USD. */
  minVolume: number;
  /** RVOL at or above this is volume-confirmed. */
  rvolMin: number;
  /** Candles for the structure stop: the lowest low of the last N. */
  stopLookback: number;
  /** The exit planner's default risk, USD. */
  riskDollars: number;
  /** The OI jump that, with top-decile funding, reads as leverage-driven. */
  oiJumpMin: number;
  /** Coins searched for and added by hand: read in every run whatever their volume. */
  pinned: string[];
  /** Read the builder books too (stocks, indices, commodities, companies not yet listed, as "xyz:XYZ100"). */
  builderBooks: boolean;
  /** Their own volume line, USD: these markets are thinner than the crypto ones, and a pre-IPO market thinner still. */
  minVolumeBooks: number;
}

type NumericSetting = Exclude<keyof ScreenerSettings, "pinned" | "builderBooks">;
export const PIN_LIMIT = 30;
const PIN_NAME = /^[A-Za-z0-9:_-]{1,24}$/;

export const DEFAULT_SCREENER_SETTINGS: ScreenerSettings = {
  minVolume: 5_000_000,
  rvolMin: 1.5,
  stopLookback: 10,
  riskDollars: 250,
  oiJumpMin: 0.15,
  pinned: [],
  builderBooks: true,
  minVolumeBooks: 250_000,
};

export function readScreenerSettings(raw: unknown): ScreenerSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (k: NumericSetting, min: number, max: number) => {
    const v = Number(o[k]);
    return Number.isFinite(v) && v >= min && v <= max ? v : DEFAULT_SCREENER_SETTINGS[k];
  };
  return {
    minVolume: n("minVolume", 0, 1e12),
    rvolMin: n("rvolMin", 0.1, 100),
    stopLookback: Math.round(n("stopLookback", 2, 200)),
    riskDollars: n("riskDollars", 1, 1e9),
    oiJumpMin: n("oiJumpMin", 0, 10),
    minVolumeBooks: n("minVolumeBooks", 0, 1e12),
    pinned: Array.isArray(o.pinned) ? Array.from(new Set(o.pinned.filter((c): c is string => typeof c === "string" && PIN_NAME.test(c)))).slice(0, PIN_LIMIT) : [],
    builderBooks: typeof o.builderBooks === "boolean" ? o.builderBooks : DEFAULT_SCREENER_SETTINGS.builderBooks,
  };
}

/** Read `candleSnapshot` with volume: `[{ t, T, s, i, o, c, h, l, v, n }]`, prices as strings. */
export function parseScreenerCandles(json: unknown): ScreenerCandle[] {
  if (!Array.isArray(json)) return [];
  const out: ScreenerCandle[] = [];
  for (const k of json as Array<Record<string, unknown>>) {
    const t = Number(k?.t);
    const o = Number(k?.o);
    const h = Number(k?.h);
    const l = Number(k?.l);
    const c = Number(k?.c);
    const v = Number(k?.v);
    if (![t, o, h, l, c].every(Number.isFinite)) continue;
    out.push({ t, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The ratio series: alt close over BTC close on bars that share a timestamp, with the alt's volume carried along. */
export function ratioSeries(alt: ScreenerCandle[], btc: ScreenerCandle[]): { t: number; r: number; v: number }[] {
  const btcAt = new Map<number, number>();
  for (const b of btc) if (b.c > 0) btcAt.set(b.t, b.c);
  const out: { t: number; r: number; v: number }[] = [];
  for (const a of alt) {
    const bc = btcAt.get(a.t);
    if (bc == null || !(a.c > 0)) continue;
    out.push({ t: a.t, r: a.c / bc, v: a.v });
  }
  return out;
}

/** The last value over the value L entries back, minus one; null when the series is short. */
function changeOver(values: number[], L: number, end = values.length - 1): number | null {
  const i = end - L;
  if (i < 0 || end < 0) return null;
  const a = values[i];
  const b = values[end];
  if (!(a > 0) || !(b > 0)) return null;
  return b / a - 1;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const stdev = (xs: number[]) => {
  const m = mean(xs);
  if (m == null || xs.length < 2) return null;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

/**
 * One timeframe's numbers on a ratio series. `partial` is how much of the
 * last bar has elapsed (1 for a complete bar): the daily series ends on
 * today's bar built from the hours so far, and RVOL's recent block is
 * scaled by the elapsed fraction so a day seven hours old is not read as
 * a quiet day.
 */
export function tfMetrics(series: { t: number; r: number; v: number }[], tf: Timeframe, partial = 1): TfMetrics {
  const { bars: L, accelBlocks } = TF_SPEC[tf];
  const r = series.map((x) => x.r);
  const v = series.map((x) => x.v);
  const last = r.length - 1;
  const rs = changeOver(r, L);

  // Acceleration: the last block's change against the mean of the W blocks before it.
  let accel: Accel | null = null;
  if (rs != null) {
    const prior: number[] = [];
    for (let k = 1; k <= accelBlocks; k++) {
      const ch = changeOver(r, L, last - k * L);
      if (ch == null) break;
      prior.push(ch);
    }
    if (prior.length >= MIN_PRIOR_BLOCKS) {
      const m = mean(prior)!;
      const sd = stdev(prior) ?? 0;
      // "Clearly": beyond a quarter of the blocks' own spread, and at least a tenth of the mean's size.
      const band = Math.max(0.25 * sd, 0.1 * Math.abs(m));
      accel = rs > m + band ? "up" : rs < m - band ? "down" : "steady";
    }
  }

  // Breakout: the last close against the highest of the previous 20 block closes.
  let breakout: boolean | null = null;
  let breakoutLevel: number | null = null;
  if (last >= 0) {
    const closes: number[] = [];
    for (let k = 1; k <= BREAKOUT_PERIODS; k++) {
      const i = last - k * L;
      if (i < 0) break;
      closes.push(r[i]);
    }
    if (closes.length >= MIN_PRIOR_BLOCKS) {
      breakoutLevel = Math.max(...closes);
      breakout = r[last] > breakoutLevel;
    }
  }

  // RVOL: the last L bars' volume against the mean of the previous 20 blocks of L bars.
  let rvol: number | null = null;
  if (last + 1 >= L) {
    const sum = (from: number, to: number) => v.slice(from, to + 1).reduce((s, x) => s + x, 0);
    const recent = sum(last - L + 1, last);
    const blocks: number[] = [];
    for (let k = 1; k <= RVOL_PERIODS; k++) {
      const to = last - k * L;
      const from = to - L + 1;
      if (from < 0) break;
      blocks.push(sum(from, to));
    }
    const m = blocks.length >= MIN_PRIOR_BLOCKS ? mean(blocks) : null;
    // The recent block against the share of a block that has elapsed.
    const elapsed = (L - 1 + Math.min(1, Math.max(0.05, partial))) / L;
    rvol = m != null && m > 0 ? recent / (m * elapsed) : null;
  }

  return { rs, accel, breakout, rvol, breakoutLevel };
}

/** Every timeframe on a coin's two series against BTC's. */
export function coinMetrics(
  alt: { "1h": ScreenerCandle[]; "1d": ScreenerCandle[] },
  btc: { "1h": ScreenerCandle[]; "1d": ScreenerCandle[] },
  /** How much of the last daily bar has elapsed (today's hours so far ÷ 24). */
  dayPartial = 1,
): Record<Timeframe, TfMetrics> {
  const hourly = ratioSeries(alt["1h"], btc["1h"]);
  const daily = ratioSeries(alt["1d"], btc["1d"]);
  const out = {} as Record<Timeframe, TfMetrics>;
  for (const tf of TIMEFRAMES) out[tf] = TF_SPEC[tf].base === "1h" ? tfMetrics(hourly, tf) : tfMetrics(daily, tf, dayPartial);
  return out;
}

/* ------------------------------- the series, kept between runs ------------------------------- */

export const HOUR_MS = 3600_000;
export const DAY_MS = 86400_000;

/** Bars that have closed by `now`: the one still forming is left out, so every coin is measured at the same instant. */
export function completeBars(candles: ScreenerCandle[], barMs: number, now: number): ScreenerCandle[] {
  return candles.filter((c) => c.t + barMs <= now);
}

/** Newer bars laid over older ones: a bar with the same timestamp is replaced, the result sorted and trimmed to the window. */
export function mergeBars(stored: ScreenerCandle[], fresh: ScreenerCandle[], keepFrom: number): ScreenerCandle[] {
  const byT = new Map<number, ScreenerCandle>();
  for (const c of stored) if (c.t >= keepFrom) byT.set(c.t, c);
  for (const c of fresh) if (c.t >= keepFrom) byT.set(c.t, c);
  return Array.from(byT.values()).sort((a, b) => a.t - b.t);
}

/** Hourly bars folded into UTC days, the last day as far as the hours go. */
export function daysFromHours(hours: ScreenerCandle[]): ScreenerCandle[] {
  const out: ScreenerCandle[] = [];
  for (const b of hours) {
    const day = Math.floor(b.t / DAY_MS) * DAY_MS;
    const cur = out[out.length - 1];
    if (cur && cur.t === day) {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    } else out.push({ t: day, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}

/**
 * The daily series without asking the venue for it again: the stored
 * completed days, then every day the hourly bars cover in full — the
 * last twenty-nine or so, today's partial one included. Null when there
 * is no stored series or its days end before the hours begin, in which
 * case the venue has to be asked.
 */
export function deriveDaily(storedDays: ScreenerCandle[], hours: ScreenerCandle[], keepFrom: number): ScreenerCandle[] | null {
  if (hours.length === 0 || storedDays.length === 0) return null;
  const fromHours = daysFromHours(hours);
  // The hours usually begin mid-day: that first day is partial on the left and is not used.
  const full = hours[0].t % DAY_MS === 0 ? fromHours : fromHours.slice(1);
  const firstFullDay = full[0]?.t;
  if (firstFullDay == null) return null;
  const kept = storedDays.filter((d) => d.t < firstFullDay && d.t >= keepFrom);
  const last = kept[kept.length - 1];
  // A gap the hours cannot bridge: the store is too old.
  if (!last || last.t + DAY_MS < firstFullDay) return null;
  /*
   * The store's own last bar was the day still forming when it was
   * written. Normally the hours rebuild it; when the hours begin after it
   * (a coin not read for a month), it would be kept as a finished day with
   * part of its range and volume. The venue is asked instead.
   */
  if (last.t === storedDays[storedDays.length - 1].t) return null;
  return [...kept, ...full];
}

const EMPTY_TF: TfMetrics = { rs: null, accel: null, breakout: null, rvol: null, breakoutLevel: null };
export const emptyMetrics = (): Record<Timeframe, TfMetrics> =>
  Object.fromEntries(TIMEFRAMES.map((tf) => [tf, { ...EMPTY_TF }])) as Record<Timeframe, TfMetrics>;

const NO_PRICE: PriceReadings = { rsi: null, ema: null, atrPct: null, offHigh: null, priceHigh20: null, priceLow20: null, rsEth: null, rsBasket: null, alpha: null, efficiency: null };
export const emptyPrice = (): Record<Timeframe, PriceReadings> =>
  Object.fromEntries(TIMEFRAMES.map((tf) => [tf, { ...NO_PRICE }])) as Record<Timeframe, PriceReadings>;
const NO_SIGNALS: Signals = { rs: 0, accel: 0, rsi: 0, trend: 0, momentum: 0, alpha: 0, resilience: 0, oi: 0, funding: 0, cvd: 0, score: 0, divergence: null };
export const emptySignals = (): Record<Timeframe, Signals> =>
  Object.fromEntries(TIMEFRAMES.map((tf) => [tf, { ...NO_SIGNALS }])) as Record<Timeframe, Signals>;

const NO_FLAGS: TfFlags = { movingFast: false, candidate: false, weakest: false, volumeConfirmed: false };
export const emptyFlags = (): Record<Timeframe, TfFlags> =>
  Object.fromEntries(TIMEFRAMES.map((tf) => [tf, { ...NO_FLAGS }])) as Record<Timeframe, TfFlags>;

/** The value at a quantile of a sorted ascending list (nearest-rank). */
export function quantile(sortedAsc: number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1));
  return sortedAsc[i];
}

/**
 * The flags, which need the whole universe: a coin is "moving fast" against
 * the others, not against itself. Leverage-driven is decided here too,
 * since the funding decile is a property of the universe.
 */
export function flagRows(rows: ScreenerRow[], settings: Pick<ScreenerSettings, "rvolMin" | "oiJumpMin">): ScreenerRow[] {
  /*
   * Crypto is ranked against crypto, and the other markets against each
   * other. A stock index moves a tenth as much as an alt: ranked together,
   * no index would ever be "moving fast" and every one would sit in the
   * middle of the ratings, while the funding decile would be the alts'.
   */
  // And within the other markets, by what they are measured against: a rank among stocks measured against
  // the stock index, and another among the metals, oils and currencies measured against BTC.
  const groupOf = (r: ScreenerRow) => (assetClassOf(r.coin) === "crypto" ? "crypto" : benchmarkKindOf(r.coin));
  const groups = new Map<string, ScreenerRow[]>();
  for (const r of rows) groups.set(groupOf(r), [...(groups.get(groupOf(r)) ?? []), r]);
  if (groups.size <= 1) return flagGroup(rows, settings);
  const done = new Map<string, ScreenerRow>();
  groups.forEach((g) => {
    for (const r of flagGroup(g, settings)) done.set(r.coin, r);
  });
  return rows.map((r) => done.get(r.coin)!);
}

function flagGroup(rows: ScreenerRow[], settings: Pick<ScreenerSettings, "rvolMin" | "oiJumpMin">): ScreenerRow[] {
  const fundings = rows.map((r) => r.fundingAnnual).filter((x): x is number => x != null).sort((a, b) => a - b);
  const fundingTop = quantile(fundings, 0.9);
  const thresholds = {} as Record<Timeframe, { top: number | null; bottom: number | null }>;
  for (const tf of TIMEFRAMES) {
    const xs = rows.map((r) => r.tf[tf].rs).filter((x): x is number => x != null).sort((a, b) => a - b);
    thresholds[tf] = { top: quantile(xs, 0.9), bottom: quantile(xs, 0.1) };
  }
  const ratingNow = rsRatings(rows.map((r) => ({ coin: r.coin, rs: { "1D": r.tf["1D"].rs, "1W": r.tf["1W"].rs, "1M": r.tf["1M"].rs } })));
  const ratingWas = rsRatings(rows.map((r) => ({ coin: r.coin, rs: r.strength?.rsWeekAgo ?? { "1D": null, "1W": null, "1M": null } })));
  return rows.map((r) => {
    const rsUp = (r.tf["1D"].rs ?? r.tf["4h"].rs ?? 0) > 0;
    const leverageDriven =
      rsUp && fundingTop != null && r.fundingAnnual != null && r.fundingAnnual >= fundingTop && fundings.length >= 10 && r.oiChange != null && r.oiChange >= settings.oiJumpMin;
    // Funding's place in the universe, 0..1, onto the positioning; the signals read crowding off it.
    const fundingPct = r.fundingAnnual != null && fundings.length >= 10 ? fundings.filter((f) => f <= r.fundingAnnual!).length / fundings.length : null;
    const positioning = r.positioning ? { ...r.positioning, fundingPct } : null;
    // The rank, which is a place in the universe: now, and where the same arithmetic put it a week ago.
    const strength: Strength | null = r.strength ? { ...r.strength, rating: ratingNow.get(r.coin) ?? null, ratingWas: ratingWas.get(r.coin) ?? null } : null;
    const signals = emptySignals();
    for (const tf of TIMEFRAMES) {
      signals[tf] = signalsOf(r.tf[tf], r.price?.[tf] ?? { ...NO_PRICE }, positioning, r.rsiPeak?.[tf] ?? null, r.rsiTrough?.[tf] ?? null, r.flow ?? null, { cvd: cvdFor(r.flow, r.spot, tf)?.value ?? null, capture: strength?.capture ?? null });
    }
    const flags = emptyFlags();
    for (const tf of TIMEFRAMES) {
      const m = r.tf[tf];
      const { top, bottom } = thresholds[tf];
      const volumeConfirmed = m.rvol != null && m.rvol >= settings.rvolMin;
      const movingFast = m.rs != null && top != null && m.rs >= top && m.rs > 0 && m.accel === "up";
      flags[tf] = {
        movingFast,
        volumeConfirmed,
        candidate: movingFast && volumeConfirmed && !leverageDriven,
        weakest: m.rs != null && bottom != null && m.rs <= bottom && m.rs < 0,
      };
    }
    const { rsiPeak: _p, rsiTrough: _t, ...rest } = r;
    return { ...rest, leverageDriven, flags, positioning, signals, ...(strength ? { strength } : {}) };
  });
}

/** Funding per hour, as the venue states it, to a yearly rate. Hyperliquid settles funding every hour. */
export const annualizeFunding = (hourly: number) => hourly * 24 * 365;

/* ------------------------------- the exit planner ------------------------------- */

export interface ExitPlan {
  /** The lowest low of the last N candles on the timeframe; null when fewer than N exist. */
  structureStop: number | null;
  /** How many candles the stop was read from. */
  stopCandles: number;
  /** Distance from the mark to the stop, as a fraction of the mark. */
  stopDistance: number | null;
  /** The ratio level a breakout was measured against; a close back under it is the RS invalidation. */
  rsInvalidation: number | null;
  /** The ratio now, to show against the invalidation. */
  ratioNow: number | null;
  /** Position size in coin for the risk given, and its notional. */
  size: number | null;
  notional: number | null;
}

/**
 * Where to get out, before going in: the structure stop and the size that
 * puts exactly the risk on it. Candles are the base series blocked to the
 * timeframe (the last N blocks of L bars), lows taken across each block.
 */
export function exitPlan(
  candles: ScreenerCandle[],
  tf: Timeframe,
  mark: number | null,
  metrics: TfMetrics,
  ratioNow: number | null,
  settings: Pick<ScreenerSettings, "stopLookback" | "riskDollars">,
): ExitPlan {
  const L = TF_SPEC[tf].bars;
  const need = settings.stopLookback * L;
  const slice = candles.length >= need ? candles.slice(-need) : [];
  const structureStop = slice.length > 0 ? Math.min(...slice.map((c) => c.l)) : null;
  const stopDistance = structureStop != null && mark != null && mark > 0 ? (mark - structureStop) / mark : null;
  const size = stopDistance != null && stopDistance > 0 && mark != null ? settings.riskDollars / (mark - structureStop!) : null;
  return {
    structureStop,
    stopCandles: slice.length ? settings.stopLookback : 0,
    stopDistance,
    rsInvalidation: metrics.breakoutLevel,
    ratioNow,
    size,
    notional: size != null && mark != null ? size * mark : null,
  };
}

/** Block a base series into timeframe candles (the last bar's block may be partial), for the drawer's charts. */
export function blockCandles(candles: ScreenerCandle[], tf: Timeframe): ScreenerCandle[] {
  const L = TF_SPEC[tf].bars;
  if (L === 1) return candles;
  const out: ScreenerCandle[] = [];
  // Blocks counted back from the last bar, so the newest block ends on the newest bar.
  const start = candles.length % L;
  for (let i = start; i + L <= candles.length; i += L) {
    const b = candles.slice(i, i + L);
    out.push({ t: b[0].t, o: b[0].o, h: Math.max(...b.map((c) => c.h)), l: Math.min(...b.map((c) => c.l)), c: b[b.length - 1].c, v: b.reduce((s, c) => s + c.v, 0) });
  }
  return out;
}

/** The RS ratio rebased to 0% at the first bar inside the window, for one line of the spaghetti chart. */
export function rebasedLine(series: { t: number; r: number }[], windowMs: number, now: number): { t: number; pct: number }[] {
  const from = Number.isFinite(windowMs) ? now - windowMs : -Infinity;
  const inWindow = series.filter((x) => x.t >= from);
  const base = inWindow[0]?.r;
  if (!(base > 0)) return [];
  return inWindow.map((x) => ({ t: x.t, pct: x.r / base - 1 }));
}

/** Coins that are not alts: BTC itself, and the dollar-pegged ones. */
export const NOT_AN_ALT = /^(BTC|USDC|USDT|USDE|USDH|USD1|USDD|USDS|USR|DAI|FDUSD|PYUSD|TUSD|BUSD|USDP|GUSD|XAUT)$/i;

/* ------------------------------- the other readings ------------------------------- */

import { cvdFor, type FlowReadings, type LiqMap, type SpotFlow, type TopAccounts } from "./flow";
import { assetClassOf, benchmarkKindOf } from "./sectors";

/**
 * Price readings on a timeframe's blocks, so the table can say whether
 * price agrees with relative strength. Blocks are the closes sampled
 * every L base bars back from the last bar, as the RS arithmetic does.
 */
export interface PriceReadings {
  /** RSI 14 on the block closes. */
  rsi: number | null;
  /** Where price sits against its 20 and 50 block averages: 2 above both, 1 between, 0 below both. */
  ema: 0 | 1 | 2 | null;
  /** 14-block average true range as a share of price. */
  atrPct: number | null;
  /** How far price is under its 20-block high, as a share (0 = at the high). */
  offHigh: number | null;
  /** The last close is above every one of the previous 20 block closes. */
  priceHigh20: boolean | null;
  /** The last close is below every one of the previous 20 block closes. */
  priceLow20: boolean | null;
  /** RS change against ETH and against the volume-weighted alt basket, like `rs` against BTC. */
  rsEth: number | null;
  rsBasket: number | null;
  /**
   * The move over the timeframe with the coin's BTC beta taken out: its own
   * return minus beta times BTC's. A high-beta alt beats BTC on every green
   * day; this is what is left when that is paid for.
   */
  alpha?: number | null;
  /** Net move over the last 20 blocks as a share of the path travelled, signed: +1 a straight line up, near 0 chop. */
  efficiency?: number | null;
}

/** The closes, highs and lows of the last N blocks of L bars, newest last. */
export function blocksOf(candles: ScreenerCandle[], L: number, n: number): { c: number[]; h: number[]; l: number[] } {
  const c: number[] = [];
  const h: number[] = [];
  const l: number[] = [];
  for (let end = candles.length - 1, k = 0; end - L + 1 >= 0 && k < n; end -= L, k++) {
    const b = candles.slice(end - L + 1, end + 1);
    c.unshift(b[b.length - 1].c);
    h.unshift(Math.max(...b.map((x) => x.h)));
    l.unshift(Math.min(...b.map((x) => x.l)));
  }
  return { c, h, l };
}

/** Wilder's RSI over `period` on a series of closes; null short of period + 1 values. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(0, d)) / period;
    loss = (loss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

/** The exponential average of a series, the last value; null short of `period` values. */
export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function priceReadings(
  candles: ScreenerCandle[],
  tf: Timeframe,
  rsEth: number | null,
  rsBasket: number | null,
): PriceReadings {
  const L = TF_SPEC[tf].bars;
  const { c, h, l } = blocksOf(candles, L, 80);
  const last = c.length - 1;
  const out: PriceReadings = { rsi: null, ema: null, atrPct: null, offHigh: null, priceHigh20: null, priceLow20: null, rsEth, rsBasket, alpha: null, efficiency: efficiencyOf(c) };
  if (last < 0) return out;
  out.rsi = rsi(c, 14);
  const e20 = ema(c, 20);
  const e50 = ema(c, 50);
  if (e20 != null && e50 != null) out.ema = c[last] > e20 && c[last] > e50 ? 2 : c[last] < e20 && c[last] < e50 ? 0 : 1;
  if (c.length >= 15) {
    let tr = 0;
    for (let i = c.length - 14; i < c.length; i++) tr += Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    out.atrPct = c[last] > 0 ? tr / 14 / c[last] : null;
  }
  if (c.length >= 21) {
    const prev = c.slice(last - 20, last);
    const high = Math.max(...prev);
    const low = Math.min(...prev);
    out.priceHigh20 = c[last] > high;
    out.priceLow20 = c[last] < low;
    out.offHigh = high > 0 ? Math.max(0, (Math.max(high, c[last]) - c[last]) / Math.max(high, c[last])) : null;
  }
  return out;
}

/**
 * Positioning from the hourly snapshots: how open interest moved against
 * price, and what that says. Price up with OI up is new longs; price up
 * with OI down is short covering; price down with OI up is new shorts;
 * price down with OI down is longs leaving.
 */
export type OiRead = "new-longs" | "short-covering" | "new-shorts" | "longs-out" | null;

export interface Positioning {
  oi1h: number | null;
  oi4h: number | null;
  oi1d: number | null;
  /** Price change over the day the OI change is measured on. */
  px1d: number | null;
  read: OiRead;
  /** Mark over oracle, minus one: the perp's premium. */
  premium: number | null;
  /** Where this coin's funding sits in the universe, 0..1. */
  fundingPct: number | null;
}

export function oiRead(px: number | null, oi: number | null, minMove = 0.005): OiRead {
  if (px == null || oi == null) return null;
  if (Math.abs(px) < minMove || Math.abs(oi) < minMove) return null;
  if (px > 0) return oi > 0 ? "new-longs" : "short-covering";
  return oi > 0 ? "new-shorts" : "longs-out";
}

/**
 * The readings that agree or disagree, each as +1, 0 or −1, and what they
 * add up to. Relative strength against BTC, its acceleration, price
 * momentum, trend, the open-interest read and crowding by funding. The
 * divergences are the cases worth a second look: price at a new high
 * that relative strength or momentum does not confirm, and the mirror.
 */
export interface Signals {
  rs: -1 | 0 | 1;
  accel: -1 | 0 | 1;
  rsi: -1 | 0 | 1;
  trend: -1 | 0 | 1;
  /**
   * The four above as one vote. They are four views of the same thing — a
   * coin that is going up — and summed apiece they made a score of four out
   * of a rally before positioning or flow had said anything. Two or more
   * net agreeing is +1, two or more against −1.
   */
  momentum: -1 | 0 | 1;
  /** The move with BTC's beta taken out: the coin's own strength. */
  alpha: -1 | 0 | 1;
  /** What it does on BTC's green hours against its red ones: holds and leads +1, gives back more than it gains −1. */
  resilience: -1 | 0 | 1;
  oi: -1 | 0 | 1;
  funding: -1 | 0 | 1;
  /** Taker flow over the timeframe's window: net buying +1, net selling −1. */
  cvd: -1 | 0 | 1;
  /** momentum + alpha + resilience + oi + funding + cvd: six independent votes. */
  score: number;
  /** Price at a 20-block high while RS or RSI lags; or price at a low while they do not confirm. */
  divergence: "bearish" | "bullish" | null;
}

export function signalsOf(
  m: TfMetrics,
  p: PriceReadings,
  pos: Positioning | null,
  rsiPrevPeak: number | null,
  rsiPrevTrough: number | null,
  flow: FlowReadings | null = null,
  /** The taker flow for this timeframe's window (perp, else spot) and the capture spread; without them, the 24h perp flow and no vote. */
  more: { cvd?: number | null; capture?: number | null } = {},
): Signals {
  const sgn = (x: number | null, band = 0): -1 | 0 | 1 => (x == null ? 0 : x > band ? 1 : x < -band ? -1 : 0);
  const rs = sgn(m.rs, 0.002);
  const accel: -1 | 0 | 1 = m.accel === "up" ? 1 : m.accel === "down" ? -1 : 0;
  const rsiS: -1 | 0 | 1 = p.rsi == null ? 0 : p.rsi > 55 ? 1 : p.rsi < 45 ? -1 : 0;
  const trend: -1 | 0 | 1 = p.ema == null ? 0 : p.ema === 2 ? 1 : p.ema === 0 ? -1 : 0;
  const oi: -1 | 0 | 1 = pos?.read === "new-longs" ? 1 : pos?.read === "new-shorts" || pos?.read === "longs-out" ? -1 : 0;
  // Crowded longs (top decile funding) weigh against; crowded shorts (bottom decile) for.
  const funding: -1 | 0 | 1 = pos?.fundingPct == null ? 0 : pos.fundingPct >= 0.9 ? -1 : pos.fundingPct <= 0.1 ? 1 : 0;
  let divergence: Signals["divergence"] = null;
  if (p.priceHigh20 && (m.breakout === false || (p.rsi != null && rsiPrevPeak != null && p.rsi < rsiPrevPeak))) divergence = "bearish";
  if (p.priceLow20 && (m.rs != null && m.rs > 0 ? true : p.rsi != null && rsiPrevTrough != null && p.rsi > rsiPrevTrough)) divergence = "bullish";
  const flowNow = more.cvd !== undefined ? more.cvd : (flow?.cvd24h ?? null);
  const cvd: -1 | 0 | 1 = flowNow == null ? 0 : flowNow > 0.02 ? 1 : flowNow < -0.02 ? -1 : 0;
  const sum = rs + accel + rsiS + trend;
  const momentum: -1 | 0 | 1 = sum >= 2 ? 1 : sum <= -2 ? -1 : 0;
  const alpha = sgn(p.alpha ?? null, 0.003);
  const resilience = sgn(more.capture ?? null, CAPTURE_BAND);
  return { rs, accel, rsi: rsiS, trend, momentum, alpha, resilience, oi, funding, cvd, score: momentum + alpha + resilience + oi + funding + cvd, divergence };
}

/** RSI's highest and lowest over blocks 2..20 back, to compare the one now against. */
export function rsiExtremes(candles: ScreenerCandle[], tf: Timeframe): { peak: number | null; trough: number | null } {
  const L = TF_SPEC[tf].bars;
  const { c } = blocksOf(candles, L, 80);
  let peak: number | null = null;
  let trough: number | null = null;
  for (let back = 2; back <= 20; back++) {
    const r = rsi(c.slice(0, c.length - back), 14);
    if (r == null) break;
    peak = peak == null ? r : Math.max(peak, r);
    trough = trough == null ? r : Math.min(trough, r);
  }
  return { peak, trough };
}

/**
 * The alt basket: every alt's close as a share of its own first close,
 * weighted by 24h volume, summed per timestamp. One series per base, the
 * same shape as a coin's, so a coin's RS against the basket is the same
 * arithmetic as against BTC.
 */
export function basketSeries(alts: { candles: ScreenerCandle[]; weight: number }[]): ScreenerCandle[] {
  // Each coin as its value against its own first close, by time.
  const coins = alts
    .filter((a) => a.weight > 0)
    .map((a) => {
      const first = a.candles.find((c) => c.c > 0)?.c;
      return first ? { w: a.weight, v: new Map(a.candles.filter((c) => c.c > 0).map((c) => [c.t, c.c / first])) } : null;
    })
    .filter((x): x is { w: number; v: Map<number, number> } => x !== null);
  const weightAt = new Map<number, number>();
  for (const c of coins) c.v.forEach((_v, t) => weightAt.set(t, (weightAt.get(t) ?? 0) + c.w));
  // Only timestamps most of the basket has, so a thin early history does not swing the index.
  const full = Math.max(...Array.from(weightAt.values()), 0);
  const times = Array.from(weightAt.entries())
    .filter(([, w]) => w >= full * 0.6)
    .map(([t]) => t)
    .sort((a, b) => a - b);
  /*
   * Chain-linked: each step is the move of the coins present at both ends
   * of it. Averaging the levels outright made the index jump on the day a
   * coin with a shorter history joined — it came in at 1.0 whatever level
   * the rest stood at — and every coin's RS against the basket jumped with
   * it. With every coin present throughout, this is the same average.
   */
  const out: ScreenerCandle[] = [];
  let level = 1;
  let prev: number | null = null;
  for (const t of times) {
    if (prev != null) {
      let now = 0;
      let then = 0;
      for (const c of coins) {
        const a = c.v.get(prev);
        const b = c.v.get(t);
        if (a == null || b == null) continue;
        then += c.w * a;
        now += c.w * b;
      }
      if (then > 0) level *= now / then;
    } else {
      // The first step's level is the average itself, so a basket of coins that all start together reads as before.
      let v = 0;
      let w = 0;
      for (const c of coins) {
        const a = c.v.get(t);
        if (a == null) continue;
        v += c.w * a;
        w += c.w;
      }
      level = w > 0 ? v / w : 1;
    }
    out.push({ t, o: level, h: level, l: level, c: level, v: 0 });
    prev = t;
  }
  return out;
}

/** The share of alts whose BTC ratio is above its own 20-day average: the breadth of the tape. */
export function breadthOf(ratios: { t: number; r: number }[][]): number | null {
  let above = 0;
  let n = 0;
  for (const r of ratios) {
    if (r.length < 21) continue;
    const last = r[r.length - 1].r;
    const avg = r.slice(-21, -1).reduce((s, x) => s + x.r, 0) / 20;
    n++;
    if (last > avg) above++;
  }
  return n ? above / n : null;
}

/* ------------------------------- strength beyond the ratio ------------------------------- */

/**
 * The ratio against BTC says a coin beat BTC; it does not say why. An alt
 * with a beta of two beats BTC on every green day and loses to it on every
 * red one, and on a green week it tops the table having shown nothing.
 * These readings take that apart, all from the hourly bars already stored:
 *
 *   beta         the slope of the coin's hourly returns on BTC's, 30 days
 *   alpha        the coin's move over a timeframe minus beta × BTC's
 *   capture      over the last 14 days of hours: the coin's summed return
 *                on BTC's up hours over BTC's own (up capture), the same
 *                on BTC's down hours (down capture), and up minus down —
 *                positive is a coin that gains more on the green hours
 *                than it gives back on the red, whatever its beta
 *   rating       1–99: the coin's percentile in the universe by RS change,
 *                blended over 1D, 1W and 1M, and the same a week ago
 *   efficiency   net move over 20 blocks ÷ the path travelled, signed
 */
export interface Strength {
  beta: number | null;
  upCapture: number | null;
  downCapture: number | null;
  /** upCapture − downCapture. */
  capture: number | null;
  /** RS change on 1D, 1W and 1M as it stood seven daily bars ago: what the old rating is ranked from. */
  rsWeekAgo: { "1D": number | null; "1W": number | null; "1M": number | null };
  rating: number | null;
  ratingWas: number | null;
  /** The coin's share of all the venue's 24h volume, and the same about a week ago. */
  volShare: number | null;
  volShareWas: number | null;
}

/** The capture spread a coin has to clear to count as holding up, or as giving back. */
export const CAPTURE_BAND = 0.15;
export const CAPTURE_HOURS = 14 * 24;
const MIN_RETURNS = 72;

/** Returns of the two series over the same consecutive bars: a pair only where both have this bar and the one before. */
export function pairedReturns(alt: ScreenerCandle[], btc: ScreenerCandle[]): { a: number; b: number }[] {
  const btcAt = new Map<number, number>();
  for (const x of btc) if (x.c > 0) btcAt.set(x.t, x.c);
  const out: { a: number; b: number }[] = [];
  for (let i = 1; i < alt.length; i++) {
    const a0 = alt[i - 1];
    const a1 = alt[i];
    const b0 = btcAt.get(a0.t);
    const b1 = btcAt.get(a1.t);
    if (b0 == null || b1 == null || !(a0.c > 0) || !(a1.c > 0)) continue;
    out.push({ a: a1.c / a0.c - 1, b: b1 / b0 - 1 });
  }
  return out;
}

/** The slope of the coin's returns on BTC's; null on fewer than three days of hours or a BTC that did not move. */
export function betaOf(pairs: { a: number; b: number }[]): number | null {
  if (pairs.length < MIN_RETURNS) return null;
  const ma = pairs.reduce((s, x) => s + x.a, 0) / pairs.length;
  const mb = pairs.reduce((s, x) => s + x.b, 0) / pairs.length;
  let cov = 0;
  let varB = 0;
  for (const x of pairs) {
    cov += (x.a - ma) * (x.b - mb);
    varB += (x.b - mb) ** 2;
  }
  return varB > 0 ? cov / varB : null;
}

/** Up and down capture over the last `hours` pairs; null on a side BTC barely had. */
export function captureOf(pairs: { a: number; b: number }[], hours = CAPTURE_HOURS): { up: number | null; down: number | null; spread: number | null } {
  const tail = pairs.slice(-hours);
  if (tail.length < MIN_RETURNS) return { up: null, down: null, spread: null };
  let upA = 0;
  let upB = 0;
  let nUp = 0;
  let downA = 0;
  let downB = 0;
  let nDown = 0;
  for (const x of tail) {
    if (x.b > 0) {
      upA += x.a;
      upB += x.b;
      nUp++;
    } else if (x.b < 0) {
      downA += x.a;
      downB += x.b;
      nDown++;
    }
  }
  const up = nUp >= 12 && upB > 0.005 ? upA / upB : null;
  const down = nDown >= 12 && downB < -0.005 ? downA / downB : null;
  return { up, down, spread: up != null && down != null ? up - down : null };
}

/** The coin's move over the last L bars with beta × BTC's taken out, on bars both series have. */
export function alphaOver(alt: ScreenerCandle[], btc: ScreenerCandle[], L: number, beta: number | null): number | null {
  if (beta == null) return null;
  const btcAt = new Map<number, number>();
  for (const x of btc) if (x.c > 0) btcAt.set(x.t, x.c);
  const both = alt.filter((x) => x.c > 0 && btcAt.has(x.t));
  const last = both.length - 1;
  if (last - L < 0) return null;
  const a = both[last].c / both[last - L].c - 1;
  const b = btcAt.get(both[last].t)! / btcAt.get(both[last - L].t)! - 1;
  return a - beta * b;
}

/** Kaufman's efficiency over the last `n` steps of a close series, signed by the direction of the net move. */
export function efficiencyOf(closes: number[], n = 20): number | null {
  if (closes.length < n + 1) return null;
  const tail = closes.slice(-(n + 1));
  let path = 0;
  for (let i = 1; i < tail.length; i++) path += Math.abs(tail[i] - tail[i - 1]);
  return path > 0 ? (tail[tail.length - 1] - tail[0]) / path : 0;
}

/** RS change on the daily timeframes as it stood `back` daily bars ago. */
export function rsBack(daily: { t: number; r: number; v: number }[], back = 7): Strength["rsWeekAgo"] {
  const then = daily.slice(0, Math.max(0, daily.length - back));
  return { "1D": tfMetrics(then, "1D").rs, "1W": tfMetrics(then, "1W").rs, "1M": tfMetrics(then, "1M").rs };
}

export const RATING_WEIGHTS = { "1D": 0.3, "1W": 0.4, "1M": 0.3 } as const;

/**
 * The 1–99 rating: each coin's percentile in the universe by RS change on
 * 1D, 1W and 1M, blended 30/40/30. A timeframe the coin has no number on is
 * left out and the others reweighted; a coin with none has no rating. Ranks
 * need company: under ten coins on a timeframe, that timeframe is not used.
 */
export function rsRatings(rows: { coin: string; rs: { "1D": number | null; "1W": number | null; "1M": number | null } }[]): Map<string, number> {
  const out = new Map<string, number>();
  const pct = {} as Record<keyof typeof RATING_WEIGHTS, Map<string, number>>;
  for (const tf of Object.keys(RATING_WEIGHTS) as (keyof typeof RATING_WEIGHTS)[]) {
    const have = rows.filter((r) => r.rs[tf] != null);
    const m = new Map<string, number>();
    if (have.length >= 10) {
      const sorted = have.map((r) => r.rs[tf]!).sort((a, b) => a - b);
      // The share of the universe at or below it, counting itself once: the top coin is 1, the bottom 1/n.
      for (const r of have) {
        let below = 0;
        for (const v of sorted) if (v <= r.rs[tf]!) below++;
        m.set(r.coin, below / sorted.length);
      }
    }
    pct[tf] = m;
  }
  for (const r of rows) {
    let w = 0;
    let v = 0;
    for (const tf of Object.keys(RATING_WEIGHTS) as (keyof typeof RATING_WEIGHTS)[]) {
      const p = pct[tf].get(r.coin);
      if (p == null) continue;
      w += RATING_WEIGHTS[tf];
      v += RATING_WEIGHTS[tf] * p;
    }
    if (w > 0) out.set(r.coin, Math.max(1, Math.min(99, Math.round((v / w) * 99))));
  }
  return out;
}

/** Everything in Strength a coin's own series can say; the rating and the volume share are the universe's to add. */
export function strengthOf(alt: { "1h": ScreenerCandle[]; "1d": ScreenerCandle[] }, btc: { "1h": ScreenerCandle[]; "1d": ScreenerCandle[] }): Strength {
  const pairs = pairedReturns(alt["1h"], btc["1h"]);
  const cap = captureOf(pairs);
  return {
    beta: betaOf(pairs),
    upCapture: cap.up,
    downCapture: cap.down,
    capture: cap.spread,
    rsWeekAgo: rsBack(ratioSeries(alt["1d"], btc["1d"])),
    rating: null,
    ratingWas: null,
    volShare: null,
    volShareWas: null,
  };
}

/* ------------------------------- sectors ------------------------------- */

export interface SectorRow {
  sector: string;
  coins: number;
  /** The median RS change of its coins on the timeframe. */
  rs: number | null;
  /** The share of its coins beating BTC on the timeframe. */
  breadth: number | null;
  /** Its strongest coin on the timeframe. */
  leader: string | null;
  leaderRs: number | null;
}

/** The universe grouped by sector on a timeframe, strongest first. A group of one or two is a coin, not a sector, and is left out. */
export function sectorTable(rows: Pick<ScreenerRow, "coin" | "tf" | "error">[], tf: Timeframe, sectorOf: (coin: string) => string | null, minCoins = 3): SectorRow[] {
  const groups = new Map<string, { coin: string; rs: number }[]>();
  for (const r of rows) {
    const rs = r.tf[tf]?.rs;
    const sector = sectorOf(r.coin);
    if (r.error || rs == null || !sector) continue;
    groups.set(sector, [...(groups.get(sector) ?? []), { coin: r.coin, rs }]);
  }
  const out: SectorRow[] = [];
  for (const [sector, list] of Array.from(groups)) {
    if (list.length < minCoins) continue;
    const sorted = list.slice().sort((a, b) => a.rs - b.rs);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid].rs : (sorted[mid - 1].rs + sorted[mid].rs) / 2;
    const top = sorted[sorted.length - 1];
    out.push({ sector, coins: list.length, rs: median, breadth: list.filter((x) => x.rs > 0).length / list.length, leader: top.coin, leaderRs: top.rs });
  }
  return out.sort((a, b) => (b.rs ?? 0) - (a.rs ?? 0));
}
