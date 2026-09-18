/**
 * Three words and a press of Enter.
 *
 * A scalp is in and out inside a minute, and the reason a day of them never
 * reaches the journal is that the entry form asks for four prices it does
 * not have. This asks for what a scalp actually knows: the ticker, what it
 * made, and — the number that earns its keep — what it risked.
 *
 *     btc 100 50      made $100 on BTC, risked $50, so +2.0R
 *     btc 100         the same, at whatever this book normally risks
 *     -45 sol         a loser, ticker either side of the number
 *     btc 100 r50     the risk said out loud, when the line looks ambiguous
 *     btc 100 50 chased it into the close
 *
 * The order is positional and the rule is one sentence: the result first,
 * the risk second. A risk is never negative, which is what catches the two
 * being typed the wrong way round; anything else is caught by the line of
 * plain English the form shows before you commit.
 */
import { fmtMoney } from "./metrics";

export interface ScalpDraft {
  symbol: string;
  /** Net, as it hit the account. */
  netPnl: number;
  /** Dollars at risk, or null when neither the line nor the book said. */
  riskAmount: number | null;
  /** Where the risk came from, for the line that says so before you commit. */
  riskFrom: "typed" | "default" | null;
  direction: "long" | "short";
  note: string | null;
}

export type ScalpParse =
  | { ok: true; scalp: ScalpDraft }
  | { ok: false; hint: string };

export interface ScalpContext {
  /** The last ticker logged, so a bare number is another of the same. */
  lastSymbol?: string | null;
  /** What this book normally risks. */
  defaultRisk?: number | null;
}

/** What a ticker may look like: a letter, then letters, digits or a separator. */
const TICKER = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** "$1,250.50" and "1250.5" are the same number; "abc" is not one. */
function asNumber(raw: string): number | null {
  const t = raw.replace(/[$,]/g, "");
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** "r50", "r$50", "risk50" — the risk, said out loud. */
function asExplicitRisk(raw: string): number | null {
  const m = /^(?:r|risk)[:=]?\$?([\d.,]+)$/i.exec(raw.trim());
  return m ? asNumber(m[1]) : null;
}

export function parseScalpLine(raw: string, ctx: ScalpContext = {}): ScalpParse {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { ok: false, hint: "A ticker and what it made." };

  let symbol: string | null = null;
  let netPnl: number | null = null;
  let typedRisk: number | null = null;
  let direction: "long" | "short" = "long";
  const rest: string[] = [];

  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if (low === "short" || low === "long") {
      direction = low as "long" | "short";
      continue;
    }
    const explicit = asExplicitRisk(tok);
    if (explicit != null && netPnl != null && typedRisk == null) {
      typedRisk = explicit;
      continue;
    }
    const n = asNumber(tok);
    if (n != null) {
      // The result first, the risk second. A third number is prose.
      if (netPnl == null) netPnl = n;
      else if (typedRisk == null) typedRisk = n;
      else rest.push(tok);
      continue;
    }
    // Only something shaped like a ticker may become one. A token like
    // "-25sol", which is what two lines run together look like, is prose —
    // and a line with no ticker is refused rather than logged under a
    // symbol nobody typed.
    if (symbol == null && TICKER.test(tok)) symbol = tok;
    else rest.push(tok);
  }

  if (netPnl == null) return { ok: false, hint: "What did it make? Try “btc 100”." };
  const ticker = (symbol ?? ctx.lastSymbol ?? "").trim();
  if (!ticker) return { ok: false, hint: "Which ticker? Try “btc 100”." };
  if (typedRisk != null && typedRisk <= 0) {
    return { ok: false, hint: "Risk is what you stood to lose, so it is never negative." };
  }

  const fallback = ctx.defaultRisk != null && ctx.defaultRisk > 0 ? ctx.defaultRisk : null;
  const riskAmount = typedRisk ?? fallback;

  return {
    ok: true,
    scalp: {
      symbol: ticker.toUpperCase(),
      netPnl,
      riskAmount,
      riskFrom: riskAmount == null ? null : typedRisk != null ? "typed" : "default",
      direction,
      note: rest.length ? rest.join(" ") : null,
    },
  };
}

/** R on a scalp: what it made over what it risked. Null without a risk. */
export function scalpR(s: Pick<ScalpDraft, "netPnl" | "riskAmount">): number | null {
  return s.riskAmount != null && s.riskAmount > 0 ? s.netPnl / s.riskAmount : null;
}

/**
 * The line the form shows before you press Enter — the safety net for the
 * two numbers going in the wrong order, and the place a defaulted risk
 * admits that it was defaulted.
 */
export function describeScalp(s: ScalpDraft): string {
  const r = scalpR(s);
  const head = `${s.symbol}${s.direction === "short" ? " short" : ""} ${fmtMoney(s.netPnl)}`;
  if (s.riskAmount == null) return `${head}, no risk set, so money only`;
  const from = s.riskFrom === "default" ? " (your default)" : "";
  const rTxt = r == null ? "" : `, so ${r > 0 ? "+" : ""}${r.toFixed(2)}R`;
  return `${head}, risked $${s.riskAmount}${from}${rTxt}`;
}
