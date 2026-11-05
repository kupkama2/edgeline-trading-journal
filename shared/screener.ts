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
  /** Why the coin could not be measured, when it could not. */
  error: string | null;
  /** How many bars each series had: the evidence behind a "—". */
  bars: { "1h": number; "1d": number };
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
}

export const DEFAULT_SCREENER_SETTINGS: ScreenerSettings = {
  minVolume: 5_000_000,
  rvolMin: 1.5,
  stopLookback: 10,
  riskDollars: 250,
  oiJumpMin: 0.15,
};

export function readScreenerSettings(raw: unknown): ScreenerSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (k: keyof ScreenerSettings, min: number, max: number) => {
    const v = Number(o[k]);
    return Number.isFinite(v) && v >= min && v <= max ? v : DEFAULT_SCREENER_SETTINGS[k];
  };
  return {
    minVolume: n("minVolume", 0, 1e12),
    rvolMin: n("rvolMin", 0.1, 100),
    stopLookback: Math.round(n("stopLookback", 2, 200)),
    riskDollars: n("riskDollars", 1, 1e9),
    oiJumpMin: n("oiJumpMin", 0, 10),
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

/** One timeframe's numbers on a ratio series. */
export function tfMetrics(series: { t: number; r: number; v: number }[], tf: Timeframe): TfMetrics {
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
    rvol = m != null && m > 0 ? recent / m : null;
  }

  return { rs, accel, breakout, rvol, breakoutLevel };
}

/** Every timeframe on a coin's two series against BTC's. */
export function coinMetrics(
  alt: { "1h": ScreenerCandle[]; "1d": ScreenerCandle[] },
  btc: { "1h": ScreenerCandle[]; "1d": ScreenerCandle[] },
): Record<Timeframe, TfMetrics> {
  const hourly = ratioSeries(alt["1h"], btc["1h"]);
  const daily = ratioSeries(alt["1d"], btc["1d"]);
  const out = {} as Record<Timeframe, TfMetrics>;
  for (const tf of TIMEFRAMES) out[tf] = tfMetrics(TF_SPEC[tf].base === "1h" ? hourly : daily, tf);
  return out;
}

const EMPTY_TF: TfMetrics = { rs: null, accel: null, breakout: null, rvol: null, breakoutLevel: null };
export const emptyMetrics = (): Record<Timeframe, TfMetrics> =>
  Object.fromEntries(TIMEFRAMES.map((tf) => [tf, { ...EMPTY_TF }])) as Record<Timeframe, TfMetrics>;

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
  const fundings = rows.map((r) => r.fundingAnnual).filter((x): x is number => x != null).sort((a, b) => a - b);
  const fundingTop = quantile(fundings, 0.9);
  const thresholds = {} as Record<Timeframe, { top: number | null; bottom: number | null }>;
  for (const tf of TIMEFRAMES) {
    const xs = rows.map((r) => r.tf[tf].rs).filter((x): x is number => x != null).sort((a, b) => a - b);
    thresholds[tf] = { top: quantile(xs, 0.9), bottom: quantile(xs, 0.1) };
  }
  return rows.map((r) => {
    const rsUp = (r.tf["1D"].rs ?? r.tf["4h"].rs ?? 0) > 0;
    const leverageDriven =
      rsUp && fundingTop != null && r.fundingAnnual != null && r.fundingAnnual >= fundingTop && fundings.length >= 10 && r.oiChange != null && r.oiChange >= settings.oiJumpMin;
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
    return { ...r, leverageDriven, flags };
  });
}

/** Funding per hour, as the venue states it, to a yearly rate. Hyperliquid settles funding every hour. */
export const annualizeFunding = (hourly: number) => hourly * 24 * 365;

/* ------------------------------- the exit planner ------------------------------- */

export interface ExitPlan {
  /** The lowest low of the last N candles on the timeframe. */
  structureStop: number | null;
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
  const slice = candles.slice(-need);
  const structureStop = slice.length >= Math.min(need, L) && slice.length > 0 ? Math.min(...slice.map((c) => c.l)) : null;
  const stopDistance = structureStop != null && mark != null && mark > 0 ? (mark - structureStop) / mark : null;
  const size = stopDistance != null && stopDistance > 0 && mark != null ? settings.riskDollars / (mark - structureStop!) : null;
  return {
    structureStop,
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
