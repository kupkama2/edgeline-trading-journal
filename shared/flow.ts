/**
 * Order flow and positioning beyond Hyperliquid's own numbers, and the
 * anomalies a run turns up. Pure; the reads are in server/flow.ts.
 *
 * Binance (through the owner's relay, since the server's IP has been
 * banned by Binance before):
 *   klines           taker-buy volume per bar → CVD, the running sum of
 *                    taker buys minus taker sells
 *   futures/data     global long/short account ratio, top-trader position
 *                    ratio, open-interest history
 *   premiumIndex     every symbol's mark and last funding in one read
 *
 * Hyperliquid's liquidation map: the largest accounts on its public
 * leaderboard, each one's positions and liquidation prices, summed into
 * bands around the mark — where forced selling or buying would land.
 */

/* ------------------------------- symbols ------------------------------- */

/** Hyperliquid's coin to Binance's USDT perp. The k-prefixed thousand-units are Binance's 1000-prefixed ones, quoted on the same scale. */
export function binanceSymbolFor(coin: string): string {
  const m = /^k([A-Z0-9]+)$/.exec(coin);
  return m ? `1000${m[1]}USDT` : `${coin.toUpperCase()}USDT`;
}

/**
 * The Binance contract that is the same coin: the plain or 1000-prefixed
 * USDT perp whose mark agrees with Hyperliquid's within 15% once scaled.
 * A ticker can name a different token on each venue; one whose price
 * disagrees by more than that is not the same coin, and its flow would
 * be someone else's, so it gets none.
 */
export function matchBinance(coin: string, hlMark: number | null, premium: Map<string, { mark: number; funding: number }>): { symbol: string; scale: number } | null {
  const k = /^k([A-Z0-9]+)$/.exec(coin);
  const name = (k ? k[1] : coin).toUpperCase();
  const candidates = k ? [{ symbol: `1000${name}USDT`, scale: 1 }] : [{ symbol: `${name}USDT`, scale: 1 }, { symbol: `1000${name}USDT`, scale: 1000 }];
  for (const c of candidates) {
    const p = premium.get(c.symbol);
    if (!p) continue;
    if (hlMark == null || !(hlMark > 0)) return c;
    if (Math.abs(p.mark / c.scale / hlMark - 1) <= 0.15) return c;
  }
  return null;
}

/* ------------------------------- Binance readings ------------------------------- */

export interface FlowBar {
  t: number;
  c: number;
  v: number;
  /** Taker-buy volume, base units. */
  buy: number;
}

/** `/fapi/v1/klines`: `[openTime, o, h, l, c, volume, closeTime, quoteVol, trades, takerBuyBase, takerBuyQuote, _]`. */
export function parseFlowKlines(json: unknown): FlowBar[] {
  if (!Array.isArray(json)) return [];
  const out: FlowBar[] = [];
  for (const k of json as any[]) {
    if (!Array.isArray(k)) continue;
    const t = Number(k[0]);
    const c = Number(k[4]);
    const v = Number(k[5]);
    const buy = Number(k[9]);
    if ([t, c, v, buy].every(Number.isFinite)) out.push({ t, c, v, buy });
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface RatioPoint {
  t: number;
  ratio: number;
  long: number | null;
}

/** `/futures/data/*LongShort*Ratio`: `[{ longShortRatio, longAccount|longPosition, timestamp }]`. */
export function parseRatio(json: unknown): RatioPoint[] {
  if (!Array.isArray(json)) return [];
  return (json as any[])
    .map((r) => ({ t: Number(r?.timestamp), ratio: Number(r?.longShortRatio), long: r?.longAccount != null ? Number(r.longAccount) : r?.longPosition != null ? Number(r.longPosition) : null }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.ratio))
    .sort((a, b) => a.t - b.t);
}

/** `/futures/data/openInterestHist`: `[{ sumOpenInterest, sumOpenInterestValue, timestamp }]`. */
export function parseOiHist(json: unknown): { t: number; oi: number; usd: number | null }[] {
  if (!Array.isArray(json)) return [];
  return (json as any[])
    .map((r) => ({ t: Number(r?.timestamp), oi: Number(r?.sumOpenInterest), usd: r?.sumOpenInterestValue != null ? Number(r.sumOpenInterestValue) : null }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.oi))
    .sort((a, b) => a.t - b.t);
}

/** `/fapi/v1/premiumIndex` with no symbol: every perp's mark and last funding rate. */
export function parsePremiumIndex(json: unknown): Map<string, { mark: number; funding: number }> {
  const out = new Map<string, { mark: number; funding: number }>();
  if (!Array.isArray(json)) return out;
  for (const r of json as any[]) {
    const mark = Number(r?.markPrice);
    const funding = Number(r?.lastFundingRate);
    if (typeof r?.symbol === "string" && Number.isFinite(mark) && mark > 0) out.set(r.symbol, { mark, funding: Number.isFinite(funding) ? funding : 0 });
  }
  return out;
}

/** `/fapi/v1/fundingInfo`: only the symbols whose funding interval is not the usual eight hours. */
export function parseFundingInfo(json: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(json)) return out;
  for (const r of json as any[]) {
    const h = Number(r?.fundingIntervalHours);
    if (typeof r?.symbol === "string" && h > 0) out.set(r.symbol, h);
  }
  return out;
}

/** `/api/v3/ticker/price` with no symbol: every spot pair's last price. */
export function parseSpotPrices(json: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(json)) return out;
  for (const r of json as any[]) {
    const p = Number(r?.price);
    if (typeof r?.symbol === "string" && Number.isFinite(p) && p > 0) out.set(r.symbol, p);
  }
  return out;
}

/**
 * The Binance spot pair that is the same coin, as matchBinance does for the
 * perp: the USDT pair whose price agrees with Hyperliquid's mark within 15%.
 * Hyperliquid's k-prefixed coins are a thousand of the token, so the plain
 * spot pair is compared at a thousandth of the mark (kPEPE against PEPEUSDT),
 * and a 1000-prefixed spot pair (1000SATS) at the mark itself.
 */
export function matchSpot(coin: string, hlMark: number | null, prices: Map<string, number>): { symbol: string; scale: number } | null {
  if (coin.includes(":")) return null;
  const k = /^k([A-Z0-9]+)$/.exec(coin);
  const name = (k ? k[1] : coin).toUpperCase();
  // `scale`: how many of the spot pair's units one Hyperliquid unit is.
  const candidates = k
    ? [{ symbol: `${name}USDT`, scale: 1000 }, { symbol: `1000${name}USDT`, scale: 1 }]
    : [{ symbol: `${name}USDT`, scale: 1 }, { symbol: `1000${name}USDT`, scale: 0.001 }];
  for (const c of candidates) {
    const p = prices.get(c.symbol);
    if (p == null) continue;
    if (hlMark == null || !(hlMark > 0)) return c;
    if (Math.abs((p * c.scale) / hlMark - 1) <= 0.15) return c;
  }
  return null;
}

/** Taker buys minus taker sells over the last `bars`, as a share of the volume traded: +0.1 is ten percent more buying than selling. */
export function deltaRatio(bars: FlowBar[], n: number): number | null {
  const tail = bars.slice(-n);
  if (tail.length < Math.min(n, 2)) return null;
  const v = tail.reduce((s, b) => s + b.v, 0);
  if (!(v > 0)) return null;
  return tail.reduce((s, b) => s + (2 * b.buy - b.v), 0) / v;
}

/** The running sum of taker delta, for the drawer's line. */
export function cvdLine(bars: FlowBar[]): { t: number; cvd: number }[] {
  let run = 0;
  return bars.map((b) => {
    run += 2 * b.buy - b.v;
    return { t: b.t, cvd: run };
  });
}

const changeOf = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null && b !== 0 ? a / b - 1 : null);

export interface FlowReadings {
  symbol: string;
  /** Taker delta as a share of volume over the last 4 and 24 hours, and the last week. */
  cvd4h: number | null;
  cvd24h: number | null;
  cvd7d?: number | null;
  /** Binance price change over the same 24 hours, to read the delta against. */
  px24h: number | null;
  /** Global long/short account ratio now, and its change over 24 hours. */
  lsAccounts: number | null;
  lsAccounts24h: number | null;
  /** Top traders' long/short position ratio now, and its change. */
  lsTop: number | null;
  lsTop24h: number | null;
  /** Binance open interest over 24 hours. */
  oi24h: number | null;
  /** Hyperliquid's mark against Binance's, minus one. */
  basis: number | null;
  /** Funding annualised on each venue, and Hyperliquid's minus Binance's. */
  fundingHl: number | null;
  fundingBn: number | null;
  fundingSpread: number | null;
  /** The last week of CVD and the account ratio, hourly, for the drawer. */
  cvdSeries: { t: number; cvd: number }[];
  lsSeries: { t: number; ratio: number }[];
}

export function flowReadings(input: {
  symbol: string;
  klines: FlowBar[];
  accounts: RatioPoint[];
  top: RatioPoint[];
  oi: { t: number; oi: number }[];
  hlMark: number | null;
  hlFundingHourly: number | null;
  bn: { mark: number; funding: number } | null;
  bnIntervalHours: number;
}): FlowReadings {
  const k = input.klines;
  const last = k[k.length - 1];
  const dayAgo = k[k.length - 25];
  const acc = input.accounts;
  const top = input.top;
  const oi = input.oi;
  const fundingBn = input.bn ? input.bn.funding * (24 / input.bnIntervalHours) * 365 : null;
  const fundingHl = input.hlFundingHourly != null ? input.hlFundingHourly * 24 * 365 : null;
  return {
    symbol: input.symbol,
    cvd4h: deltaRatio(k, 4),
    cvd24h: deltaRatio(k, 24),
    cvd7d: deltaRatio(k, 168),
    px24h: last && dayAgo ? changeOf(last.c, dayAgo.c) : null,
    lsAccounts: acc.length ? acc[acc.length - 1].ratio : null,
    lsAccounts24h: acc.length > 24 ? changeOf(acc[acc.length - 1].ratio, acc[acc.length - 25].ratio) : null,
    lsTop: top.length ? top[top.length - 1].ratio : null,
    lsTop24h: top.length > 24 ? changeOf(top[top.length - 1].ratio, top[top.length - 25].ratio) : null,
    oi24h: oi.length > 24 ? changeOf(oi[oi.length - 1].oi, oi[oi.length - 25].oi) : null,
    basis: input.hlMark != null && input.bn ? input.hlMark / input.bn.mark - 1 : null,
    fundingHl,
    fundingBn,
    fundingSpread: fundingHl != null && fundingBn != null ? fundingHl - fundingBn : null,
    cvdSeries: cvdLine(k.slice(-168)),
    lsSeries: acc.slice(-168).map((a) => ({ t: a.t, ratio: a.ratio })),
  };
}

/**
 * Taker flow on Binance's spot book for the same coin, read by the server
 * itself off Binance's public market-data mirror: no relay, no key. Spot
 * buying is the stronger kind — it is paid for in full — so it stands on
 * its own beside the perp's flow, and the two are compared.
 */
export interface SpotFlow {
  symbol: string;
  cvd4h: number | null;
  cvd24h: number | null;
  cvd7d: number | null;
  px24h: number | null;
  /** The last week of spot CVD, hourly, for the drawer. */
  cvdSeries: { t: number; cvd: number }[];
}

export function spotFlowOf(symbol: string, klines: FlowBar[]): SpotFlow {
  const last = klines[klines.length - 1];
  const dayAgo = klines[klines.length - 25];
  return {
    symbol,
    cvd4h: deltaRatio(klines, 4),
    cvd24h: deltaRatio(klines, 24),
    cvd7d: deltaRatio(klines, 168),
    px24h: last && dayAgo ? changeOf(last.c, dayAgo.c) : null,
    cvdSeries: cvdLine(klines.slice(-168)),
  };
}

/** The taker-flow window a timeframe is read on: a week of hourly bars is what there is, so the long timeframes share it. */
export const CVD_WINDOW = { "1h": "4h", "4h": "4h", "12h": "24h", "1D": "24h", "1W": "7d", "1M": "7d" } as const;
export type CvdWindow = "4h" | "24h" | "7d";

export interface CvdRead {
  value: number;
  window: CvdWindow;
  /** Which book it was read from: the perp through the relay when there is one, else spot. */
  source: "perp" | "spot";
  symbol: string;
}

/** The taker flow for a timeframe: the perp's when the relay read it, the spot book's when not; null with neither. */
export function cvdFor(flow: FlowReadings | null | undefined, spot: SpotFlow | null | undefined, tf: keyof typeof CVD_WINDOW): CvdRead | null {
  const window = CVD_WINDOW[tf];
  const pick = (f: { cvd4h: number | null; cvd24h: number | null; cvd7d?: number | null } | null | undefined) => (f ? (window === "4h" ? f.cvd4h : window === "24h" ? f.cvd24h : (f.cvd7d ?? null)) : null);
  const perp = pick(flow);
  if (perp != null) return { value: perp, window, source: "perp", symbol: flow!.symbol };
  const s = pick(spot);
  if (s != null) return { value: s, window, source: "spot", symbol: spot!.symbol };
  return null;
}

/* ------------------------------- the largest accounts ------------------------------- */

/**
 * What Hyperliquid's largest accounts hold in a coin, summed from the same
 * positions the liquidation map reads: notional long and short, how many
 * accounts on each side, and the net as a share of the two (+1 all long,
 * −1 all short). `netWas` is the same a day earlier, from that day's run.
 */
export interface TopAccounts {
  longUsd: number;
  shortUsd: number;
  longs: number;
  shorts: number;
  net: number | null;
  netWas?: number | null;
}

export function topAccountsOf(mark: number, positions: { szi: number }[]): TopAccounts {
  let longUsd = 0;
  let shortUsd = 0;
  let longs = 0;
  let shorts = 0;
  for (const p of positions) {
    if (p.szi > 0) {
      longUsd += p.szi * mark;
      longs++;
    } else if (p.szi < 0) {
      shortUsd += -p.szi * mark;
      shorts++;
    }
  }
  const gross = longUsd + shortUsd;
  return { longUsd, shortUsd, longs, shorts, net: gross > 0 ? (longUsd - shortUsd) / gross : null };
}

/* ------------------------------- the liquidation map ------------------------------- */

/** The stats leaderboard: `{ leaderboardRows: [{ ethAddress, accountValue }] }`, the largest accounts first. */
export function parseLeaderboard(json: unknown, top: number): string[] {
  const rows = (json as any)?.leaderboardRows;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r: any) => ({ a: String(r?.ethAddress ?? "").toLowerCase(), v: Number(r?.accountValue) }))
    .filter((r) => /^0x[0-9a-f]{40}$/.test(r.a) && Number.isFinite(r.v))
    .sort((x, y) => y.v - x.v)
    .slice(0, top)
    .map((r) => r.a);
}

export interface LiqBand {
  /** The band's middle, as a share away from the mark: −0.05 is five percent below. */
  at: number;
  price: number;
  /** Notional that would be liquidated there, USD: longs below the mark, shorts above. */
  usd: number;
}

export interface LiqMap {
  mark: number;
  accounts: number;
  bands: LiqBand[];
  /** The heaviest band within ten percent on each side. */
  nearestLong: LiqBand | null;
  nearestShort: LiqBand | null;
  /** All the liquidation notional within ten percent, each side. */
  longUsd10: number;
  shortUsd10: number;
}

export const LIQ_STEP = 0.01;
export const LIQ_SPAN = 0.25;

/**
 * Positions summed into one-percent bands around the mark. A long is
 * liquidated below the mark, a short above; a liquidation price on the
 * wrong side of the mark (a position already past it, or a stale read) is
 * left out.
 */
export function liqMapOf(mark: number, positions: { szi: number; liquidationPx: number | null }[], accounts: number): LiqMap {
  const bands = new Map<number, number>();
  for (const p of positions) {
    if (p.liquidationPx == null || !(p.liquidationPx > 0)) continue;
    const at = p.liquidationPx / mark - 1;
    if (p.szi > 0 && at >= 0) continue;
    if (p.szi < 0 && at <= 0) continue;
    if (Math.abs(at) > LIQ_SPAN) continue;
    // Never band zero: it belongs to neither side, so the liquidations nearest the mark — the ones that matter
    // most — fell out of both sides' totals. Inside half a step, a long goes to the first band below, a short to the first above.
    const nearest = Math.round(at / LIQ_STEP);
    const band = nearest === 0 ? (p.szi > 0 ? -1 : 1) : nearest;
    bands.set(band, (bands.get(band) ?? 0) + Math.abs(p.szi) * mark);
  }
  const list: LiqBand[] = Array.from(bands, ([b, usd]) => ({ at: b * LIQ_STEP, price: mark * (1 + b * LIQ_STEP), usd })).sort((a, b) => a.at - b.at);
  const within = (side: "long" | "short") => list.filter((b) => (side === "long" ? b.at < 0 : b.at > 0) && Math.abs(b.at) <= 0.1);
  const heaviest = (xs: LiqBand[]) => (xs.length ? xs.reduce((m, b) => (b.usd > m.usd ? b : m)) : null);
  return {
    mark,
    accounts,
    bands: list,
    nearestLong: heaviest(within("long")),
    nearestShort: heaviest(within("short")),
    longUsd10: within("long").reduce((s, b) => s + b.usd, 0),
    shortUsd10: within("short").reduce((s, b) => s + b.usd, 0),
  };
}

/* ------------------------------- anomalies ------------------------------- */

export type AnomalyKind =
  | "oi-surge"
  | "oi-flush"
  | "funding-gap"
  | "basis"
  | "cvd-divergence"
  | "crowded-long"
  | "crowded-short"
  | "whales-vs-crowd"
  | "liq-magnet"
  | "venues-disagree"
  | "rsi-divergence"
  | "spot-led"
  | "perp-led"
  | "whales-flip";

export interface Anomaly {
  coin: string;
  kind: AnomalyKind;
  /** 1 worth a look, 2 notable, 3 rare. */
  severity: 1 | 2 | 3;
  text: string;
}

export interface AnomalyInput {
  coin: string;
  oi24hHl: number | null;
  px24h: number | null;
  flow: FlowReadings | null;
  liq: LiqMap | null;
  divergence: "bearish" | "bullish" | null;
  spot?: SpotFlow | null;
  top?: TopAccounts | null;
}

const pctl = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};
const pctText = (x: number, d = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`;
const usdText = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1e3)}K`);

/**
 * What stands out in a run, against the universe: each rule fires on the
 * tails of its own reading, so a quiet day turns up little and a wild one
 * a lot — which is itself the point.
 */
export function findAnomalies(rows: AnomalyInput[]): Anomaly[] {
  const out: Anomaly[] = [];
  const oi = rows.map((r) => r.oi24hHl).filter((x): x is number => x != null);
  const oiHi = pctl(oi, 0.95);
  const oiLo = pctl(oi, 0.05);
  const ls = rows.map((r) => r.flow?.lsAccounts).filter((x): x is number => x != null);
  const lsHi = pctl(ls, 0.95);
  const lsLo = pctl(ls, 0.05);
  const liqs = rows.map((r) => Math.max(r.liq?.nearestLong?.usd ?? 0, r.liq?.nearestShort?.usd ?? 0)).filter((x) => x > 0);
  const liqHi = pctl(liqs, 0.9);

  for (const r of rows) {
    const f = r.flow;
    if (r.oi24hHl != null && oiHi != null && r.oi24hHl >= oiHi && r.oi24hHl > 0.1) {
      out.push({ coin: r.coin, kind: "oi-surge", severity: r.oi24hHl > 0.3 ? 3 : 2, text: `Open interest ${pctText(r.oi24hHl)} on Hyperliquid in 24h with price ${r.px24h != null ? pctText(r.px24h) : "flat"}: new positions piling in.` });
    }
    if (r.oi24hHl != null && oiLo != null && r.oi24hHl <= oiLo && r.oi24hHl < -0.1) {
      out.push({ coin: r.coin, kind: "oi-flush", severity: r.oi24hHl < -0.25 ? 3 : 2, text: `Open interest ${pctText(r.oi24hHl)} in 24h: positions closed or liquidated.` });
    }
    if (f?.fundingSpread != null && Math.abs(f.fundingSpread) >= 0.25) {
      out.push({ coin: r.coin, kind: "funding-gap", severity: Math.abs(f.fundingSpread) >= 0.6 ? 3 : 2, text: `Funding ${pctText(f.fundingHl ?? 0, 0)}/yr on Hyperliquid against ${pctText(f.fundingBn ?? 0, 0)}/yr on Binance: ${f.fundingSpread > 0 ? "longs pay more on Hyperliquid" : "shorts pay more on Hyperliquid"}.` });
    }
    if (f?.basis != null && Math.abs(f.basis) >= 0.003) {
      out.push({ coin: r.coin, kind: "basis", severity: Math.abs(f.basis) >= 0.01 ? 3 : 1, text: `Hyperliquid trades ${pctText(f.basis, 2)} against Binance's mark.` });
    }
    if (f?.cvd24h != null && f.px24h != null) {
      if (f.px24h > 0.02 && f.cvd24h < -0.03) out.push({ coin: r.coin, kind: "cvd-divergence", severity: f.cvd24h < -0.08 ? 3 : 2, text: `Price ${pctText(f.px24h)} in 24h on net taker selling (${pctText(f.cvd24h)} of volume): the rise is not being bought by takers — short covering, or passive bids absorbing.` });
      if (f.px24h < -0.02 && f.cvd24h > 0.03) out.push({ coin: r.coin, kind: "cvd-divergence", severity: f.cvd24h > 0.08 ? 3 : 2, text: `Price ${pctText(f.px24h)} in 24h on net taker buying (${pctText(f.cvd24h)} of volume): buyers are being absorbed, or longs are catching a falling knife.` });
    }
    if (f?.lsAccounts != null && lsHi != null && f.lsAccounts >= lsHi && f.lsAccounts > 2) out.push({ coin: r.coin, kind: "crowded-long", severity: f.lsAccounts > 3 ? 2 : 1, text: `${f.lsAccounts.toFixed(2)} Binance accounts long for every one short: a crowded long.` });
    if (f?.lsAccounts != null && lsLo != null && f.lsAccounts <= lsLo && f.lsAccounts < 0.9) out.push({ coin: r.coin, kind: "crowded-short", severity: f.lsAccounts < 0.7 ? 2 : 1, text: `Only ${f.lsAccounts.toFixed(2)} Binance accounts long per short: crowded short, squeeze fuel.` });
    if (f?.lsTop != null && f.lsAccounts != null && ((f.lsTop < 0.9 && f.lsAccounts > 1.5) || (f.lsTop > 1.5 && f.lsAccounts < 0.9))) {
      out.push({ coin: r.coin, kind: "whales-vs-crowd", severity: 2, text: `Top traders ${f.lsTop < 1 ? "net short" : "net long"} (position ratio ${f.lsTop.toFixed(2)}) while the crowd is ${f.lsAccounts > 1 ? "long" : "short"} (accounts ${f.lsAccounts.toFixed(2)}).` });
    }
    const liq = r.liq;
    const near = liq ? [liq.nearestLong, liq.nearestShort].filter((b): b is LiqBand => !!b && Math.abs(b.at) <= 0.04).sort((a, b) => b.usd - a.usd)[0] : null;
    if (near && liqHi != null && near.usd >= liqHi && near.usd >= 250_000) {
      out.push({ coin: r.coin, kind: "liq-magnet", severity: near.usd >= 2_000_000 ? 3 : 2, text: `${usdText(near.usd)} of Hyperliquid ${near.at < 0 ? "longs" : "shorts"} liquidate around ${near.price.toPrecision(5)} (${pctText(near.at)} from the mark).` });
    }
    if (f?.oi24h != null && r.oi24hHl != null && Math.abs(f.oi24h) > 0.05 && Math.abs(r.oi24hHl) > 0.05 && Math.sign(f.oi24h) !== Math.sign(r.oi24hHl)) {
      out.push({ coin: r.coin, kind: "venues-disagree", severity: 2, text: `Open interest ${pctText(r.oi24hHl)} on Hyperliquid but ${pctText(f.oi24h)} on Binance over 24h: the venues disagree on who is positioning.` });
    }
    // Spot against perp: who is doing the buying. Only with both books read.
    const s = r.spot;
    // The price move from whichever book has it: Hyperliquid's needs a day-old snapshot, which a server that slept may not have.
    const px = r.px24h ?? f?.px24h ?? s?.px24h ?? null;
    if (s?.cvd24h != null && f?.cvd24h != null && px != null && px > 0.02) {
      if (s.cvd24h > 0.03 && f.cvd24h < s.cvd24h - 0.04) out.push({ coin: r.coin, kind: "spot-led", severity: 2, text: `Price ${pctText(px)} in 24h with spot takers net buying (${pctText(s.cvd24h)} of volume) ahead of the perp (${pctText(f.cvd24h)}): the rise is being paid for on spot.` });
      if (f.cvd24h > 0.03 && s.cvd24h < -0.03) out.push({ coin: r.coin, kind: "perp-led", severity: 2, text: `Price ${pctText(px)} in 24h on perp buying (${pctText(f.cvd24h)} of volume) while spot takers sell (${pctText(s.cvd24h)}): leverage is doing the lifting.` });
    }
    // The largest accounts changing sides in a day: a third of the way across, with real size behind it.
    const t = r.top;
    if (t?.net != null && t.netWas != null && Math.abs(t.net - t.netWas) >= 0.35 && t.longUsd + t.shortUsd >= 1_000_000) {
      out.push({ coin: r.coin, kind: "whales-flip", severity: Math.abs(t.net - t.netWas) >= 0.6 ? 3 : 2, text: `Hyperliquid's largest accounts moved from ${pctText(t.netWas, 0)} to ${pctText(t.net, 0)} net in a day (long minus short, as a share of what they hold in it): now ${usdText(t.longUsd)} long, ${usdText(t.shortUsd)} short.` });
    }
    if (r.divergence) out.push({ coin: r.coin, kind: "rsi-divergence", severity: 1, text: r.divergence === "bearish" ? "Price at a 20-day high that RS or RSI does not confirm." : "Price at a 20-day low while RS or RSI holds up." });
  }
  return out.sort((a, b) => b.severity - a.severity || a.coin.localeCompare(b.coin));
}
