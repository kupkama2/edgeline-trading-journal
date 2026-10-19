/**
 * What the setup reader hands back, made safe to apply.
 *
 * The model answers in JSON and the JSON is applied to a form, field by field,
 * by code that trusts it. Everything between those two is here: a size unit
 * that is one of the two the journal knows; scale-out targets that are
 * positive numbers, not the first target again, and few enough to fit the
 * form; a resting order that cannot also be closed; a realised P&L that is a
 * number. Anything else is dropped — a blank the trader fills in, rather than
 * a wrong value they have to notice.
 */
import type { SetupParseResult } from "./schema";

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** How many scale-out levels the entry form has room for beyond the first target. */
export const MAX_EXTRA_TARGETS = 3;

export function normalizeSetupRead(json: Record<string, unknown> | null | undefined): SetupParseResult {
  const j: Record<string, unknown> = json && typeof json === "object" ? json : {};
  const initialTarget = num(j.initialTarget);
  /*
   * The sign of the size is the venue's own statement of direction — Binance
   * prints a short's size negative — and it outranks whatever word the model
   * chose, because the word is an inference and the sign is a fact read off
   * the row. The size itself is always positive in the journal.
   */
  const rawSize = num(j.size);
  const said = j.direction === "long" || j.direction === "short" ? j.direction : null;
  const direction = rawSize != null && rawSize < 0 ? "short" : said;
  const size = rawSize != null ? Math.abs(rawSize) : null;

  /*
   * Scale-outs: unique, positive, not the first target, in the order the
   * venue listed them (the prompt asks for nearest first), capped at what the
   * form can hold. When no first target came back, the nearest scale-out IS
   * the first target — the reader was told as much, but the rule is cheap to
   * keep here too.
   */
  const extrasIn = Array.isArray(j.extraTargets) ? j.extraTargets : [];
  const seen = new Set<number>();
  const extras: number[] = [];
  for (const e of extrasIn) {
    const x = num(e);
    if (x == null || x <= 0 || x === initialTarget || seen.has(x)) continue;
    seen.add(x);
    extras.push(x);
  }
  // A target on the wrong side of the entry is not a target; it goes. The
  // rest are ordered by distance from the entry in the profit direction —
  // the order the partials would fill in — whatever order the venue listed.
  const entry = num(j.entryPrice);
  const sideOk = (p: number) =>
    entry == null || direction == null || (direction === "long" ? p > entry : p < entry);
  const ladder = extras.filter(sideOk);
  if (direction) ladder.sort((a, b) => (direction === "long" ? a - b : b - a));
  let target = initialTarget != null && sideOk(initialTarget) ? initialTarget : null;
  if (target == null && ladder.length) target = ladder.shift()!;
  const extraTargets = ladder.slice(0, MAX_EXTRA_TARGETS);

  const isResting = j.isResting === true;
  // A screenshot only counts as a closed trade if a usable exit price came
  // back with it — and a resting order has not even opened.
  const exitPrice = num(j.exitPrice);
  const isClosed = !isResting && j.isClosed === true && exitPrice != null;

  const reasons = ["target", "stop", "trailed", "breakeven", "discretion", "other"] as const;
  const exitReason = reasons.find((r) => r === j.exitReason) ?? null;

  return {
    looksLikeOrdersTable: j.looksLikeOrdersTable === true,
    looksLikePositionsTab: j.looksLikePositionsTab === true,
    symbol: typeof j.symbol === "string" && j.symbol.trim() ? j.symbol.trim() : null,
    direction,
    entryPrice: entry,
    // A stop on the PROFIT side of the entry is not a stop — it is a misread
    // target, or the wrong number in the TP/SL column — and as the R
    // denominator it would be wrong on every figure the trade produces.
    initialStop: (() => {
      const st = num(j.initialStop);
      if (st == null || entry == null || direction == null) return st;
      return (direction === "long" ? st < entry : st > entry) ? st : null;
    })(),
    initialTarget: target,
    extraTargets: extraTargets.length ? extraTargets : null,
    entryTime: typeof j.entryTime === "string" && j.entryTime ? j.entryTime : null,
    size,
    sizeUnit: j.sizeUnit === "quote" ? "quote" : j.sizeUnit === "base" ? "base" : null,
    isResting,
    isClosed,
    exitPrice: isClosed ? exitPrice : null,
    exitTime: isClosed && typeof j.exitTime === "string" && j.exitTime ? j.exitTime : null,
    exitReason: isClosed ? exitReason : null,
    realizedPnl: isClosed ? num(j.realizedPnl) : null,
  };
}

/**
 * The fees a venue's NET P&L implies, when the gross is known.
 *
 * A position-history card prints the realised P&L after fees and funding and
 * never the fees themselves. With the entry, the exit and the size in base
 * units, the gross is arithmetic, and the difference is what the venue took.
 * Only offered when the answer is plausible — not negative, and no more than
 * a venue could have charged on what was traded — because a size read in
 * the wrong unit would otherwise produce a confident, enormous fee.
 */
export function impliedFees(t: {
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  size: number;
  realizedPnl: number;
}): number | null {
  const gross = (t.exitPrice - t.entryPrice) * t.size * (t.direction === "long" ? 1 : -1);
  const fees = gross - t.realizedPnl;
  if (!Number.isFinite(fees) || fees < 0) return null;
  // Fees are a few basis points of what was traded each way, funding a few
  // more a day. Two percent of the round-trip notional is far beyond either;
  // past it the size was read in the wrong unit, not charged by the venue.
  const notional = t.size * (t.entryPrice + t.exitPrice);
  if (fees > Math.max(1, notional * 0.02)) return null;
  return Math.round(fees * 100) / 100;
}
