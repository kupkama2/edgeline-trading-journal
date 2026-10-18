/**
 * The venue's week against the journal's.
 *
 * A screenshot of the venue's history — Binance's Position History cards,
 * Hyperliquid's Trade History — is the record of what actually happened,
 * and the journal is the record of what was written down. Laid side by
 * side, every position falls into one of four places:
 *
 *   matches       logged, and the journal agrees with the venue
 *   close-it      logged, but the journal still has it open
 *   exit-differs  logged and closed, at a different exit
 *   not-logged    the venue has it and the journal does not
 *
 * and anything the journal has for that account in the same stretch that
 * the venue does not is listed as well, because a trade logged on the
 * wrong account, or twice, is the same kind of gap seen from the other
 * side.
 *
 * Matching is the claim's rule (shared/claim.ts) loosened for a
 * screenshot: same market, same side, and the entries within two hours —
 * or, where the screenshot shows no times, within half a percent of each
 * other. A screenshot rounds and crops; it is a reading of the record,
 * not the record, so nothing here writes anything by itself.
 */
import type { TradeWithTags } from "./schema";
import { CLAIM_PRICE_PCT, CLAIM_TIME_MS } from "./claim";
import { toInstant } from "./import-parse";

export interface VenuePosition {
  /** As printed: "STRKUSDT", "WTIOIL xyz", "xyz:WTIOIL". */
  symbol: string;
  direction: "long" | "short";
  entryPrice: number | null;
  exitPrice: number | null;
  size: number | null;
  sizeUnit: "base" | "quote" | null;
  /** ISO instants. */
  entryTime: string | null;
  exitTime: string | null;
  /** Net of fees and funding, as the venue prints it. */
  realizedPnl: number | null;
  closed: boolean;
}

export type Verdict = "matches" | "close-it" | "exit-differs" | "not-logged";

export interface ReconRow {
  venue: VenuePosition;
  trade: TradeWithTags | null;
  verdict: Verdict;
  /** Relative difference between the two exits, for exit-differs. */
  exitDrift: number | null;
}

/** Two exits this close are the same exit, printed with different rounding. */
export const EXIT_SAME_PCT = 0.002;

const QUOTES = ["USDT", "USDC", "FDUSD", "BUSD", "USD"];

/**
 * The market a printed symbol names, in the journal's terms.
 *
 * "STRKUSDT Perp" is STRK; "xyz:WTIOIL" and "WTIOIL xyz" (Hyperliquid's
 * builder-book badge) are WTIOIL; "BTC-PERP" is BTC. Only enough to compare
 * a screenshot's spelling with a journal symbol, which is always the base.
 */
export function marketOf(raw: string): string {
  let s = raw.toUpperCase().replace(/[-_ ]PERP(ETUAL)?\b/g, " ").replace(/\bPERP(ETUAL)?\b/g, " ").trim();
  if (s.includes(":")) s = s.split(":").pop()!;
  s = s.split(/\s+/)[0] ?? s;
  s = s.replace(/-USD[CT]?$|\/USD[CT]?$/, "");
  // Only dollar quotes are stripped, so a one-letter base is safe: WUSDT is W.
  for (const q of QUOTES) if (s.length > q.length && s.endsWith(q)) return s.slice(0, -q.length);
  return s;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(/,/g, ""))) ? Number(v.replace(/,/g, "")) : null;

/**
 * A history table of FILLS walked into positions.
 *
 * Hyperliquid prints each fill with its own direction — "Open Long",
 * "Close Long", "Open Short" — so the walk needs no running ledger to know
 * what a row did: opens add to the side's position, closes take from it,
 * and the position is finished when it is back to nothing. Sizes are in
 * the coin. Rows are walked oldest first whatever order they were printed.
 */
export function positionsFromFills(
  rows: { symbol: string; dir: string; price: number; size: number; time: string | null; closedPnl: number | null }[],
): VenuePosition[] {
  const sorted = rows
    .filter((r) => r.symbol && r.price > 0 && r.size > 0 && /\b(open|close)\b/i.test(r.dir) && /\b(long|short)\b/i.test(r.dir))
    .slice()
    .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
  const out: VenuePosition[] = [];
  const live = new Map<string, { p: VenuePosition; held: number; inCost: number; inSz: number; outCost: number; outSz: number; pnl: number }>();
  for (const r of sorted) {
    const side: "long" | "short" = /\bshort\b/i.test(r.dir) ? "short" : "long";
    const key = `${marketOf(r.symbol)}:${side}`;
    const opening = /\bopen\b/i.test(r.dir);
    let cur = live.get(key);
    if (opening) {
      if (!cur) {
        cur = {
          p: { symbol: r.symbol, direction: side, entryPrice: null, exitPrice: null, size: 0, sizeUnit: "base", entryTime: r.time, exitTime: null, realizedPnl: null, closed: false },
          held: 0, inCost: 0, inSz: 0, outCost: 0, outSz: 0, pnl: 0,
        };
        live.set(key, cur);
      }
      cur.held += r.size;
      cur.inCost += r.price * r.size;
      cur.inSz += r.size;
      cur.p.size = cur.inSz;
      cur.p.entryPrice = cur.inCost / cur.inSz;
      continue;
    }
    // A close with nothing open in this record closed a position opened
    // before it; there is no entry to pair it with, so it is left out.
    if (!cur) continue;
    const take = Math.min(r.size, cur.held);
    cur.held -= take;
    cur.outCost += r.price * take;
    cur.outSz += take;
    cur.pnl += r.closedPnl ?? 0;
    cur.p.exitPrice = cur.outCost / cur.outSz;
    cur.p.exitTime = r.time;
    cur.p.realizedPnl = cur.pnl;
    if (cur.held <= cur.inSz * 1e-9) {
      cur.p.closed = true;
      out.push(cur.p);
      live.delete(key);
    }
  }
  // Still open at the end of the screenshot.
  for (const cur of Array.from(live.values())) out.push({ ...cur.p, exitPrice: null, exitTime: null, realizedPnl: null, closed: false });
  return out.sort((a, b) => (a.entryTime ?? "").localeCompare(b.entryTime ?? ""));
}

/**
 * What the model read off the screenshot, made into positions. Times are
 * the venue's wall clock and are read as this browser's local time.
 */
export function readHistory(json: unknown): VenuePosition[] {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const dir = (v: unknown): "long" | "short" | null => {
    const s = String(v ?? "").toLowerCase();
    return /\bshort\b/.test(s) ? "short" : /\blong\b/.test(s) ? "long" : null;
  };
  const positions: VenuePosition[] = [];
  for (const p of Array.isArray(j.positions) ? (j.positions as Record<string, unknown>[]) : []) {
    const direction = dir(p?.direction);
    const symbol = typeof p?.symbol === "string" ? p.symbol.trim() : "";
    if (!direction || !symbol) continue;
    const exitPrice = num(p.exitPrice);
    positions.push({
      symbol,
      direction,
      entryPrice: num(p.entryPrice),
      exitPrice,
      size: num(p.size) != null ? Math.abs(num(p.size)!) : null,
      sizeUnit: p.sizeUnit === "quote" ? "quote" : p.sizeUnit === "base" ? "base" : null,
      entryTime: toInstant(typeof p.entryTime === "string" ? p.entryTime : null),
      exitTime: toInstant(typeof p.exitTime === "string" ? p.exitTime : null),
      realizedPnl: num(p.realizedPnl),
      closed: p.closed === false ? false : exitPrice != null,
    });
  }
  const fills = (Array.isArray(j.fills) ? (j.fills as Record<string, unknown>[]) : [])
    .map((f) => ({
      symbol: typeof f?.symbol === "string" ? f.symbol.trim() : "",
      dir: typeof f?.dir === "string" ? f.dir : "",
      price: num(f?.price) ?? 0,
      size: Math.abs(num(f?.size) ?? 0),
      time: toInstant(typeof f?.time === "string" ? f.time : null),
      closedPnl: num(f?.closedPnl),
    }));
  return [...positions, ...positionsFromFills(fills)];
}

/** Several screenshots of one week, merged: the same position read twice is one. */
export function mergePositions(a: VenuePosition[], b: VenuePosition[]): VenuePosition[] {
  const key = (p: VenuePosition) =>
    `${marketOf(p.symbol)}|${p.direction}|${p.entryTime ?? ""}|${p.entryPrice ?? ""}|${p.exitPrice ?? ""}`;
  const seen = new Map<string, VenuePosition>();
  for (const p of [...a, ...b]) if (!seen.has(key(p))) seen.set(key(p), p);
  return Array.from(seen.values()).sort((x, y) => (x.entryTime ?? "").localeCompare(y.entryTime ?? ""));
}

const near = (a: number, b: number, pct: number) => Math.abs(a - b) <= Math.abs(b) * pct;

function matchScore(v: VenuePosition, t: TradeWithTags): number | null {
  if (t.status === "cancelled" || t.status === "pending" || t.scalp) return null;
  if (t.direction !== v.direction) return null;
  if (marketOf(t.symbol) !== marketOf(v.symbol)) return null;
  const tv = v.entryTime ? Date.parse(v.entryTime) : NaN;
  const tt = Date.parse(t.entryTime);
  if (Number.isFinite(tv) && Number.isFinite(tt)) {
    const dt = Math.abs(tv - tt);
    return dt <= CLAIM_TIME_MS ? dt : null;
  }
  // No time on the screenshot: the entry price has to carry the match alone.
  if (v.entryPrice != null && near(t.entryPrice, v.entryPrice, CLAIM_PRICE_PCT)) {
    return Math.abs(t.entryPrice - v.entryPrice) / v.entryPrice;
  }
  return null;
}

export function reconcile(
  venue: VenuePosition[],
  journal: ReadonlyArray<TradeWithTags>,
  opts: { account?: string | null } = {},
): { rows: ReconRow[]; journalOnly: TradeWithTags[] } {
  const acct = opts.account?.trim().toLowerCase() || null;
  const pool = journal.filter((t) => !acct || (t.account ?? "").trim().toLowerCase() === acct);
  const used = new Set<number>();
  const rows: ReconRow[] = [];

  // Closest pairs first, so a near-perfect match is never taken by a worse one.
  const pairs: { vi: number; t: TradeWithTags; score: number }[] = [];
  venue.forEach((v, vi) => {
    for (const t of pool) {
      const score = matchScore(v, t);
      if (score != null) pairs.push({ vi, t, score });
    }
  });
  pairs.sort((a, b) => a.score - b.score);
  const matchOf = new Map<number, TradeWithTags>();
  for (const p of pairs) {
    if (matchOf.has(p.vi) || used.has(p.t.id)) continue;
    matchOf.set(p.vi, p.t);
    used.add(p.t.id);
  }

  venue.forEach((v, vi) => {
    const t = matchOf.get(vi) ?? null;
    if (!t) return rows.push({ venue: v, trade: null, verdict: "not-logged", exitDrift: null });
    if (v.closed && t.status !== "closed") return rows.push({ venue: v, trade: t, verdict: "close-it", exitDrift: null });
    if (v.closed && t.exitPrice != null && v.exitPrice != null && !near(t.exitPrice, v.exitPrice, EXIT_SAME_PCT)) {
      return rows.push({
        venue: v,
        trade: t,
        verdict: "exit-differs",
        exitDrift: Math.abs(t.exitPrice - v.exitPrice) / v.exitPrice,
      });
    }
    rows.push({ venue: v, trade: t, verdict: "matches", exitDrift: null });
  });

  /*
   * The journal's side: trades on the same account, in the stretch the
   * screenshot covers (a day either side, for times read off a crop), that
   * nothing on the venue's list matched.
   */
  const times = venue.flatMap((v) => [v.entryTime, v.exitTime]).filter((x): x is string => !!x).map(Date.parse);
  const journalOnly =
    acct && times.length
      ? pool.filter((t) => {
          if (used.has(t.id) || t.status === "cancelled" || t.status === "pending" || t.scalp) return false;
          const at = Date.parse(t.entryTime);
          return at >= Math.min(...times) - 86_400_000 && at <= Math.max(...times) + 86_400_000;
        })
      : [];

  return { rows, journalOnly };
}
