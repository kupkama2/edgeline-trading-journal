/**
 * A broker's closed-position card, turned into the fields that close a trade.
 *
 * The exchange already knows everything about how a trade ended — the average
 * fill it got out at, the exact second, the realised PnL — and re-typing that
 * from a screenshot is both the most tedious part of journalling and the part
 * where the numbers quietly drift from what actually happened. So the card is
 * pasted and read.
 *
 * Everything here is pure: model JSON in, trade fields out. The reading is the
 * model's job; deciding what may be WRITTEN from it is this file's, and that
 * is the part worth testing, because the model will occasionally hand back a
 * confident number for a card that is not the trade you think it is.
 *
 * Two rules keep it from being worse than typing:
 *
 *   It never silently rewrites the entry. A close card prints the entry price
 *   too, and it is the exchange's average — which is the RIGHT number, but
 *   changing an entry changes 1R and therefore every R this trade has ever
 *   contributed. Offered, never applied.
 *
 *   It refuses a card for a different instrument. Pasting the wrong screenshot
 *   is one keystroke away, and a BTC close written onto an ETH trade is not a
 *   typo you would spot later.
 */

/** What the model is asked to read off the card. */
export interface CloseCard {
  symbol: string | null;
  direction: "long" | "short" | null;
  /** Average close price — what the position actually got out at. */
  exitPrice: number | null;
  /** Naive local time, "YYYY-MM-DDTHH:mm", the way the card prints it. */
  exitTime: string | null;
  entryPrice: number | null;
  entryTime: string | null;
  /** Size closed, in base units (the "Closed Vol" column). */
  size: number | null;
  realizedPnl: number | null;
  /** As printed — USDT, BNFCR, USDC. Not assumed to be dollars. */
  pnlCurrency: string | null;
  roiPercent: number | null;
  leverage: number | null;
  /** False when the card shows a position that is still running. */
  isClosed: boolean | null;
}

const nOrNull = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  // Thousands separators and a currency suffix are how these are printed:
  // "79,604.89", "-86.4764 BNFCR", "150x".
  const m = /-?\d[\d,]*\.?\d*/.exec(v.replace(/\s/g, ""));
  if (!m) return null;
  const num = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(num) ? num : null;
};

const sOrNull = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};

/**
 * A timestamp as the app stores naive local time: "YYYY-MM-DDTHH:mm".
 *
 * The card prints the exchange's rendering of YOUR local clock, so it is read
 * as local and never shifted — the whole journal reads naive stamps that way,
 * and a trade that moved two hours because it went through a UTC conversion on
 * the way in would land in the wrong session bucket forever.
 *
 * MM/DD/YYYY is Binance's English format and is what a day above twelve
 * disambiguates. When both halves could be a month there is nothing in the
 * string to decide it, so the exchange's own convention is followed rather
 * than guessed at per-card.
 */
export function toNaiveLocal(raw: unknown): string | null {
  const s = sOrNull(raw);
  if (!s) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}`;

  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[T ]+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (slashed) {
    let [, a, b, y, hh, mm] = slashed;
    // A first component above twelve can only be a day.
    const [month, day] = Number(a) > 12 ? [b, a] : [a, b];
    const pad = (x: string) => x.padStart(2, "0");
    return `${y}-${pad(month)}-${pad(day)}T${pad(hh)}:${mm}`;
  }
  return null;
}

/** Coerce whatever the model returned into the shape above. */
export function normalizeCloseCard(raw: any): CloseCard {
  const dir = sOrNull(raw?.direction)?.toLowerCase() ?? "";
  return {
    symbol: sOrNull(raw?.symbol)?.toUpperCase() ?? null,
    direction: dir.includes("short") ? "short" : dir.includes("long") ? "long" : null,
    exitPrice: nOrNull(raw?.exitPrice),
    exitTime: toNaiveLocal(raw?.exitTime),
    entryPrice: nOrNull(raw?.entryPrice),
    entryTime: toNaiveLocal(raw?.entryTime),
    size: nOrNull(raw?.size),
    realizedPnl: nOrNull(raw?.realizedPnl),
    pnlCurrency: sOrNull(raw?.pnlCurrency)?.toUpperCase() ?? null,
    roiPercent: nOrNull(raw?.roiPercent),
    leverage: nOrNull(raw?.leverage),
    isClosed: typeof raw?.isClosed === "boolean" ? raw.isClosed : null,
  };
}

/** Longest first, so USDT is peeled before USD. */
const QUOTES = ["FDUSD", "BUSD", "TUSD", "USDT", "USDC", "USD"];

export interface CardVerdict {
  /** Fields safe to write straight onto the trade. */
  apply: {
    exitPrice?: number;
    exitTime?: string;
    size?: number;
    direction?: "long" | "short";
  };
  /**
   * Things the card says that contradict the trade, or that would rewrite
   * history if applied. Shown, never applied.
   */
  warnings: string[];
  /** True when there is enough to close the trade with. */
  usable: boolean;
}

/**
 * What may be written onto THIS trade from THIS card.
 *
 * The exit price and time are the point of the exercise and go straight on.
 * Everything else is checked against what the trade already says, and a
 * disagreement is reported rather than resolved: the card can be the wrong
 * screenshot, and the failure mode of guessing is a trade whose numbers no
 * longer describe anything that happened.
 */
export function closeFromCard(
  card: CloseCard,
  trade: { symbol: string; direction: string; entryPrice: number; size: number },
): CardVerdict {
  const warnings: string[] = [];
  const apply: CardVerdict["apply"] = {};

  /*
   * The pair, allowing for the card printing BTCUSDT where the journal keeps
   * BTC — the same instrument written two ways is not a disagreement.
   *
   * Matched by stripping a QUOTE, not by prefix. W, S and T are all real
   * coins, and "does WIFUSDT start with W" is true — which would have waved
   * through a card for an entirely different instrument on exactly the
   * tickers where a mix-up is easiest.
   */
  if (card.symbol) {
    const onCard = card.symbol.replace(/[^A-Z0-9]/g, "");
    const mine = trade.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const base = QUOTES.reduce(
      (s, q) => (s.length > q.length && s.endsWith(q) ? s.slice(0, -q.length) : s),
      onCard,
    );
    if (base !== mine) warnings.push(`The card is ${card.symbol}, this trade is ${trade.symbol}.`);
  }

  if (card.direction && card.direction !== trade.direction) {
    warnings.push(`The card is a ${card.direction}, this trade is a ${trade.direction}.`);
  }

  if (card.isClosed === false) {
    warnings.push("The card shows a position that is still open.");
  }

  if (card.exitPrice != null) apply.exitPrice = card.exitPrice;
  if (card.exitTime) apply.exitTime = card.exitTime;

  /*
   * Size only when it disagrees by enough to matter, because it is the field
   * most likely to be read off the wrong column — "Closed Vol" and "Max OI"
   * sit next to each other and mean different things on a scaled position.
   */
  if (card.size != null && card.size > 0) {
    const drift = Math.abs(card.size - trade.size) / Math.max(trade.size, 1e-9);
    if (drift > 0.005) {
      warnings.push(
        `The card closed ${card.size}, this trade is logged as ${trade.size}. Left as it was.`,
      );
    }
  }

  /*
   * The entry is offered as a warning rather than applied. It is the
   * exchange's own average and probably better than what was typed — but it
   * is the denominator of every R this trade contributes, and moving it
   * silently would restate history from a screenshot.
   */
  if (card.entryPrice != null) {
    const drift = Math.abs(card.entryPrice - trade.entryPrice) / Math.max(trade.entryPrice, 1e-9);
    if (drift > 0.001) {
      warnings.push(
        `The card's entry is ${card.entryPrice}, this trade says ${trade.entryPrice}. Not changed — it decides 1R.`,
      );
    }
  }

  return { apply, warnings, usable: apply.exitPrice != null };
}
