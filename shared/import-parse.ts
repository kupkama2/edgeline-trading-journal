/**
 * Batch import — turn a pasted order log into pending trades.
 *
 * The point is pre-loading trades that are *waiting to be filled*, so you can
 * see how many positions could open and then walk them one by one adding
 * rationale. A pending trade therefore needs only a symbol, a direction, a
 * limit entry and a time; stop and target stay optional until it actually fills.
 *
 * Three paste shapes are recognised, because they carry genuinely different
 * information:
 *
 *   BINANCE_ORDERS   the open-orders table. Has entry, has no stop/target.
 *   BINANCE_OTOCO    the Take Profit / Stop Loss dialog for ONE order. Order A
 *                    is the entry, B the take profit, C the stop — so unlike
 *                    the orders table this one does carry a full plan.
 *   FUTURES_ORDERS   a futures broker's working-orders table (TradingView and
 *                    most DOMs export this shape). Carries TP and SL columns.
 *
 * Everything here is pure so the client can preview a paste instantly without a
 * round trip, and the server can re-validate the same way on commit.
 */

export type ImportSource =
  | "binance-orders"
  | "binance-otoco"
  | "futures-orders";

export interface ImportCandidate {
  symbol: string;
  direction: "long" | "short";
  /** The size as the venue reported it — interpret with `sizeUnit`. */
  size: number | null;
  /**
   * 'base' for futures contracts, 'quote' for the USD(T) notional crypto venues
   * report. Kept rather than converted: notional is how a crypto position is
   * actually decided, so the number entered should be the number shown.
   */
  sizeUnit: "base" | "quote";
  entryPrice: number;
  initialStop: number | null;
  initialTarget: number | null;
  /** ISO 8601. Falls back to the paste time when the venue omits one. */
  entryTime: string | null;
  source: ImportSource;
  /** The line(s) this came from, so the preview can show what it matched. */
  raw: string;
  /** Non-fatal notes for the preview — conversions, missing fields. */
  warnings: string[];
}

export interface ImportResult {
  candidates: ImportCandidate[];
  /** Lines that looked like data but could not be parsed. */
  rejected: { raw: string; reason: string }[];
}

/* ------------------------------- helpers ------------------------------- */

/**
 * Numbers arrive with thousands separators and trailing currency: "65,109.40",
 * "37,177.47 USDT". Returns null rather than NaN so callers branch on absence
 * instead of accidentally arithmetic-ing a NaN through every metric.
 */
export function parseNum(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Venue timestamps are "2026-08-05 21:30:51" in the viewer's local zone with no
 * offset. Treating that as UTC is a deliberate, documented choice: the app
 * stores ISO strings and a wrong-by-hours entry time is far less damaging than
 * refusing the import outright. The preview surfaces it as a warning.
 */
export function parseVenueTime(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}Z`;
}

/** Browser copies are tab-separated; hand-pasted text degrades to run of spaces. */
function splitColumns(line: string): string[] {
  const byTab = line.split("\t");
  if (byTab.length > 1) return byTab.map((c) => c.trim());
  return line.trim().split(/\s{2,}/).map((c) => c.trim());
}

/**
 * Binance appends a "Perp" badge to the instrument and futures symbols can pick
 * up a leading exchange/qty badge ("500 ESU6"). Strip both to the ticker.
 */
function cleanSymbol(raw: string): string {
  return raw
    .replace(/\bperp(etual)?\b/gi, "")
    .replace(/^\d+\s+/, "")
    .trim()
    .toUpperCase();
}

function directionFrom(raw: string): "long" | "short" | null {
  const s = raw.toLowerCase();
  // "Open Long" / "Open Short" (Binance) and "Buy" / "Sell" (futures brokers).
  if (/\bshort\b/.test(s) || /\bsell\b/.test(s)) return "short";
  if (/\blong\b/.test(s) || /\bbuy\b/.test(s)) return "long";
  return null;
}

/* --------------------------- Binance OTOCO --------------------------- */

/**
 * The OTOCO dialog is label/value prose rather than a table, and it describes a
 * single order: A is the entry, B the take profit, C the stop. Both legs are
 * "Stop Price" rows — they are told apart by which order block they sit in.
 */
function parseOtoco(text: string): ImportCandidate | null {
  if (!/order\s*a/i.test(text) || !/(take profit|stop market)/i.test(text)) {
    return null;
  }

  // Split on the "Order A/B/C" markers. The dialog's own explainer sentence
  // ("If order A is filled partially or fully…") also matches, so a real order
  // block is identified by carrying a Side line — the prose never does.
  const blocks = text
    .split(/(?=Order\s*[ABC]\b)/i)
    .filter((b) => /\bSide\b/i.test(b));
  const find = (label: RegExp, within: string) => {
    const m = label.exec(within);
    return m ? m[1] : null;
  };

  const blockFor = (letter: string) =>
    blocks.find((b) => new RegExp(`Order\\s*${letter}\\b`, "i").test(b)) ?? "";

  const a = blockFor("A");
  const b = blockFor("B");
  const c = blockFor("C");
  if (!a) return null;

  const entryPrice = parseNum(find(/\bPrice\s*[:\s]\s*([\d.,]+)/i, a));
  const side = find(/\bSide\s*[:\s]*\s*(Buy|Sell)/i, a);
  const notional = parseNum(find(/\bAmount\s*[:\s]*\s*([\d.,]+)/i, a));
  if (entryPrice == null || !side) return null;

  const direction = directionFrom(side);
  if (!direction) return null;

  // B is the profit leg, C the stop leg; both report "Stop Price".
  const target = parseNum(find(/\bStop Price\s*[:\s]*\s*([\d.,]+)/i, b));
  const stop = parseNum(find(/\bStop Price\s*[:\s]*\s*([\d.,]+)/i, c));

  const warnings: string[] = [];

  // The dialog names no instrument, so the symbol is only recoverable if the
  // paste happened to include it. The preview asks for it when it is missing
  // rather than inventing one.
  const symbol = cleanSymbol(find(/\b([A-Z0-9]{2,}USDT?)\b/, text) ?? "");
  if (!symbol) warnings.push("No symbol in this dialog — choose one before importing.");
  if (stop == null) warnings.push("No stop leg (Order C) found.");
  if (target == null) warnings.push("No take-profit leg (Order B) found.");

  return {
    symbol,
    direction,
    size: notional,
    sizeUnit: "quote",
    entryPrice,
    initialStop: stop,
    initialTarget: target,
    entryTime: null,
    source: "binance-otoco",
    raw: text.trim(),
    warnings,
  };
}

/* ------------------------------ tables ------------------------------ */

/**
 * Binance open orders:
 *   Time | Symbol | Type | Side | Price | Amount | Filled | Reduce Only
 * No stop or target exists in this view, which is exactly why pending trades
 * must be loggable without them.
 */
function parseBinanceRow(cols: string[], raw: string): ImportCandidate | null {
  if (cols.length < 5) return null;
  const time = parseVenueTime(cols[0]);
  if (!time) return null;

  const direction = directionFrom(cols[3] ?? "");
  const entryPrice = parseNum(cols[4]);
  if (!direction || entryPrice == null) return null;

  // Binance reports the order in quote notional ("37,177.47 USDT"), which is
  // how the position was actually sized — so it is kept verbatim.
  const notional = parseNum(cols[5]);
  const warnings: string[] = [
    "No stop or target in this view — add them when it fills.",
  ];

  return {
    symbol: cleanSymbol(cols[1] ?? ""),
    direction,
    size: notional,
    sizeUnit: "quote",
    entryPrice,
    initialStop: null,
    initialTarget: null,
    entryTime: time,
    source: "binance-orders",
    raw,
    warnings,
  };
}

/**
 * Futures broker working orders:
 *   Symbol | Side | Type | Qty | Remaining | Filled | Limit | Stop | TP | SL | Avg | Time
 * Empty middle columns are normal, so this indexes positionally rather than
 * trying to infer meaning from the values.
 */
function parseFuturesRow(cols: string[], raw: string): ImportCandidate | null {
  if (cols.length < 10) return null;
  const direction = directionFrom(cols[1] ?? "");
  if (!direction) return null;

  const entryPrice = parseNum(cols[6]);
  if (entryPrice == null) return null;

  const size = parseNum(cols[3]);
  const target = parseNum(cols[8]);
  const stop = parseNum(cols[9]);
  const time = parseVenueTime(cols.slice(10).join(" "));

  const warnings: string[] = [];
  if (stop == null) warnings.push("No stop loss found in the paste.");
  if (time == null) warnings.push("No timestamp found — will use import time.");

  return {
    symbol: cleanSymbol(cols[0] ?? ""),
    direction,
    size,
    sizeUnit: "base", // futures Qty is contracts
    entryPrice,
    initialStop: stop,
    initialTarget: target,
    entryTime: time,
    source: "futures-orders",
    raw,
    warnings,
  };
}

/* ------------------------------ entry point ------------------------------ */

/** Header rows and Binance's stray "Perp" badge lines carry no data. */
function isNoise(line: string): boolean {
  const s = line.trim();
  if (!s) return true;
  if (/^perp(etual)?$/i.test(s)) return true;
  // A header row: several known column names, no digits worth parsing.
  return /\b(time|symbol|side|type|price|amount|filled|qty|stop loss|take profit)\b/i.test(s) &&
    !/\d{4}-\d{2}-\d{2}/.test(s) &&
    !/\d+[.,]\d/.test(s);
}

export function parseImport(text: string): ImportResult {
  const candidates: ImportCandidate[] = [];
  const rejected: { raw: string; reason: string }[] = [];

  // The OTOCO dialog describes one order across many lines, so try it whole
  // before falling back to line-by-line table parsing.
  const otoco = parseOtoco(text);
  if (otoco) return { candidates: [otoco], rejected };

  for (const line of text.split(/\r?\n/)) {
    if (isNoise(line)) continue;
    const cols = splitColumns(line);
    if (cols.length < 4) continue;

    const parsed = parseBinanceRow(cols, line) ?? parseFuturesRow(cols, line);
    if (parsed) {
      if (!parsed.symbol || parsed.symbol === "UNKNOWN") {
        rejected.push({ raw: line, reason: "Could not read a symbol" });
        continue;
      }
      candidates.push(parsed);
    } else {
      rejected.push({ raw: line, reason: "Did not match a known order format" });
    }
  }

  return { candidates, rejected };
}
