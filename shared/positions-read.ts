/**
 * A venue's Positions tab, read as the open trades it lists.
 *
 * Several positions opened together are often one idea — bullish on crypto,
 * so BTC and a few higher-beta coins — and logging them one screenshot at a
 * time is the friction that gets them skipped. So the whole tab is read at
 * once, a row per position, and each row is put through the same rules as a
 * single position read (shared/setup-read.ts): a negative size is a short,
 * a stop or target on the wrong side of the entry is dropped, the size keeps
 * the unit it was printed in.
 *
 * Binance shows a stop in either of two columns — "TP/SL for position"
 * (protecting the whole position) and "TP/SL" (an order resting on it) —
 * and both are read. The position-level one is preferred; where the two
 * disagree the row says so rather than choosing silently.
 */
import { normalizeSetupRead } from "./setup-read";

export interface PositionRow {
  /** As printed, minus the Perp and leverage badges: "BTCUSDC". */
  symbol: string;
  direction: "long" | "short";
  size: number;
  sizeUnit: "base" | "quote";
  entryPrice: number;
  initialStop: number | null;
  initialTarget: number | null;
  leverage: number | null;
  warnings: string[];
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() && !/^-+$/.test(v.trim())) {
    const n = Number(v.replace(/[, ]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export function readPositionsTable(json: unknown): PositionRow[] {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const rows = Array.isArray(j.positions) ? (j.positions as Record<string, unknown>[]) : [];
  const out: PositionRow[] = [];
  for (const r of rows) {
    const symbol = typeof r?.symbol === "string" ? r.symbol.replace(/\bperp(etual)?\b/gi, "").trim().toUpperCase() : "";
    if (!symbol) continue;
    const posTp = num(r.positionTp);
    const posSl = num(r.positionSl);
    const ordTp = num(r.orderTp);
    const ordSl = num(r.orderSl);
    /*
     * The side: a word when the screen has one, otherwise the size's sign —
     * the venue prints a short's size negative, so an unsigned size with no
     * word beside it is a long. Said on the row, because it is a reading.
     */
    const word = typeof r.direction === "string" && /short|long/i.test(r.direction) ? (/short/i.test(r.direction) ? "short" : "long") : null;
    const signed = num(r.size);
    const inferred = !word && signed != null && signed > 0;
    const read = normalizeSetupRead({
      symbol,
      direction: word ?? (inferred ? "long" : null),
      entryPrice: num(r.entryPrice),
      size: num(r.size),
      sizeUnit: r.sizeUnit,
      initialStop: posSl ?? ordSl,
      initialTarget: posTp ?? ordTp,
    });
    if (!read.direction || read.entryPrice == null || read.size == null || read.size <= 0) continue;
    const warnings: string[] = inferred ? ["Side read from the size: positive is a long on this venue."] : [];
    if (posSl != null && ordSl != null && posSl !== ordSl)
      warnings.push(`Two stops on the screen (${posSl} for the position, ${ordSl} on an order) — the position's is used.`);
    const rawStop = posSl ?? ordSl;
    if (rawStop != null && read.initialStop == null)
      warnings.push(`The stop ${rawStop} is on the profit side of the entry, so it was left out.`);
    if (read.initialStop == null && rawStop == null) warnings.push("No stop on the screen — add the one you used.");
    out.push({
      symbol,
      direction: read.direction,
      size: read.size,
      sizeUnit: read.sizeUnit ?? "quote",
      entryPrice: read.entryPrice,
      initialStop: read.initialStop,
      initialTarget: read.initialTarget,
      leverage: num(r.leverage),
      warnings,
    });
  }
  return out;
}
