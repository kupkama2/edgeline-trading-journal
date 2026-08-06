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
 * offset, so they are read as LOCAL time. This matters beyond display: the
 * daily calendar, the hour-of-day breakdown and the CSV importer all bucket by
 * the local clock, and a paste read as UTC would put an evening scalp on the
 * wrong day and in the wrong session for anyone west of Greenwich.
 */
export function parseVenueTime(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +(s ?? "0")).toISOString();
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

  // Split on the "Order A/B/C" markers. Two things that are not order blocks
  // survive that split and must be dropped:
  //   · the dialog's own explainer ("If order A is filled partially or fully…"),
  //     which mentions an order but lists no Side;
  //   · everything pasted ABOVE the dialog — an orders table, say — which lands
  //     in the leading fragment and does have a "Side" column header.
  // A real block therefore both starts at its marker and carries a Side line.
  const blocks = text
    .split(/(?=Order\s*[ABC]\b)/i)
    .filter((b) => /^\s*Order\s*[ABC]\b/i.test(b) && /\bSide\b/i.test(b));
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
  // Scoped to the dialog's own blocks, not the whole paste: when an orders
  // table sits above it, a whole-text scan lifts the FIRST ticker in the table
  // and the dialog then claims to describe a different order than it does.
  const symbol = cleanSymbol(find(/\b([A-Z0-9]{2,}USDT?)\b/, blocks.join("\n")) ?? "");
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
 * One half of a bracket, listed as its own row.
 *
 * A working-orders table shows a bracketed trade as THREE rows: the parent
 * entry, then an inactive Take Profit child and an inactive Stop Loss child,
 * both on the opposite side. They are one intention, and counting them as three
 * trades is what made a single order look like a batch.
 */
interface ProtectiveLeg {
  symbol: string;
  kind: "stop" | "target";
  /** The leg's side — always opposite the entry it protects. */
  direction: "long" | "short";
  price: number;
}

/** Reads the Type column: a leg names itself there, an entry never does. */
function legKind(type: string): "stop" | "target" | null {
  const s = type.toLowerCase();
  if (/take\s*profit|^tp\b/.test(s)) return "target";
  if (/stop\s*loss|^stop\b|^sl\b/.test(s)) return "stop";
  return null;
}

function parseFuturesLeg(cols: string[]): ProtectiveLeg | null {
  const kind = legKind(cols[2] ?? "");
  if (!kind) return null;
  const direction = directionFrom(cols[1] ?? "");
  if (!direction) return null;
  // A profit leg prices off Limit, a stop leg off Stop — take whichever the row
  // actually filled in rather than assuming which column it lands in.
  const price = parseNum(cols[6]) ?? parseNum(cols[7]);
  if (price == null) return null;
  return { symbol: cleanSymbol(cols[0] ?? ""), kind, direction, price };
}

/**
 * Futures broker working orders:
 *   Symbol | Side | Type | Qty | Remaining | Filled | Limit | Stop | TP | SL | Avg | Time
 * Empty middle columns are normal, so this indexes positionally rather than
 * trying to infer meaning from the values.
 */
function parseFuturesRow(cols: string[], raw: string): ImportCandidate | null {
  if (cols.length < 10) return null;
  // A protective leg is not an order to enter anything, and its Limit Price
  // would otherwise be read as an entry — inventing a trade at the take profit.
  if (legKind(cols[2] ?? "")) return null;
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

/**
 * Prices from the same venue should be byte-identical, but they arrive via OCR
 * and float parsing, so match on a relative epsilon rather than equality.
 */
function samePrice(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale > 0 && Math.abs(a - b) / scale < 1e-6;
}

/**
 * Do two candidates describe the same resting order?
 *
 * Limit price and side are the identity: they are the two things every view of
 * an order agrees on, and neither is editable in the preview, so the answer does
 * not change while the user is typing. Symbols are compared only when both sides
 * know one — the OTOCO dialog never names its instrument, which is precisely the
 * case this exists to serve.
 *
 * Two genuinely distinct orders resting at the same side and the same price to
 * within 1e-6 would be folded together. That is close enough to exact equality
 * that treating them as one order is the better guess: a ladder is built from
 * different prices, and a venue that shows one price twice is showing one order.
 */
function sameOrder(a: ImportCandidate, b: ImportCandidate): boolean {
  if (a.direction !== b.direction) return false;
  if (!samePrice(a.entryPrice, b.entryPrice)) return false;
  return !a.symbol || !b.symbol || a.symbol === b.symbol;
}

/**
 * Drop warnings the row has since outgrown.
 *
 * Warnings say what was missing at parse time, and a row acquires the missing
 * pieces two ways: matched from another screen, or typed in by hand. Either way
 * "No stop or target in this view" must stop being shown, or the preview keeps
 * nagging about a field the user is looking straight at.
 *
 * Only *absence* warnings are pruned — the ones this module writes as "No …".
 * A note that merely mentions a stop ("Stop and target matched from a binance
 * otoco paste") is a result, not a complaint, and has to survive the row
 * acquiring the very field it is reporting on.
 */
export function pruneWarnings(c: ImportCandidate): string[] {
  // One warning can name two fields ("No stop or target in this view"), so it
  // only goes away once EVERY field it names has arrived — filling the stop
  // alone must not silence the half of it that is still true.
  const fields: [RegExp, boolean][] = [
    [/\bstop\b/i, c.initialStop != null],
    [/\btarget\b|take.profit/i, c.initialTarget != null],
    [/\bsymbol\b/i, Boolean(c.symbol)],
  ];

  return c.warnings.filter((w) => {
    if (!/^\s*No\b/i.test(w)) return true;
    const named = fields.filter(([re]) => re.test(w));
    return named.length === 0 || !named.every(([, present]) => present);
  });
}

/** Fill everything `keep` is missing from `extra`, changing nothing it has. */
function absorb(keep: ImportCandidate, extra: ImportCandidate): ImportCandidate {
  const gainedStop = keep.initialStop == null && extra.initialStop != null;
  const gainedTarget = keep.initialTarget == null && extra.initialTarget != null;
  // Size and its unit travel together: a quote notional inherited as "base"
  // would silently turn $37,177 of BTC into 37,177 coins.
  const gainedSize = keep.size == null && extra.size != null;

  const merged: ImportCandidate = {
    ...keep,
    symbol: keep.symbol || extra.symbol,
    size: keep.size ?? extra.size,
    sizeUnit: gainedSize ? extra.sizeUnit : keep.sizeUnit,
    initialStop: keep.initialStop ?? extra.initialStop,
    initialTarget: keep.initialTarget ?? extra.initialTarget,
    entryTime: keep.entryTime ?? extra.entryTime,
    warnings: keep.warnings,
  };

  // Re-derived against the union rather than carrying forward a "no stop" note
  // that the merge has just made untrue.
  merged.warnings = pruneWarnings(merged);
  if (gainedStop || gainedTarget) {
    const what = gainedStop && gainedTarget ? "Stop and target" : gainedStop ? "Stop" : "Target";
    merged.warnings.push(`${what} matched from a ${extra.source.replace("-", " ")} paste.`);
  }
  return merged;
}

/**
 * Collapse several views of the same order into one row.
 *
 * A venue splits one intention across two screens: the orders table lists the
 * entry and no protective levels, while the Take Profit / Stop Loss dialog shows
 * the stop and the target but never names the instrument. Pasting or scanning
 * both should describe one trade, not two. The same fold also absorbs a table
 * that was scanned twice, so dropping a second screenshot never duplicates the
 * orders already listed.
 *
 * Earlier candidates win every field they have: what you pasted first is the
 * list, and later screens only fill its gaps.
 */
export function mergeCandidates(candidates: ImportCandidate[]): {
  rows: ImportCandidate[];
  merged: number;
} {
  const rows: ImportCandidate[] = [];
  let merged = 0;

  for (const c of candidates) {
    const at = rows.findIndex((r) => sameOrder(r, c));
    if (at === -1) {
      rows.push({ ...c });
      continue;
    }
    rows[at] = absorb(rows[at], c);
    merged += 1;
  }

  // A bracket that found nothing to attach to is the one failure worth naming:
  // it was pasted to complete another row, and left alone it would import as a
  // symbol-less trade of its own. Recognised by shape rather than by source, so
  // it holds for a scanned dialog as well as a pasted one — and a bracket that
  // DID match has taken the instrument's name from the row it merged with, which
  // is exactly why the missing symbol is the reliable tell.
  const stranded = (r: ImportCandidate) =>
    !r.symbol && (r.initialStop != null || r.initialTarget != null);

  return {
    rows: rows.map((r) =>
      candidates.length > 1 && stranded(r)
        ? {
            ...r,
            warnings: [
              ...r.warnings,
              `No resting order here at ${r.entryPrice} — check the entry price, or name the symbol to import this on its own.`,
            ],
          }
        : r,
    ),
    merged,
  };
}

/**
 * Discard rows that are really the bracket of another row in the same set.
 *
 * The text parser spots these from the Type column, but a screenshot arrives as
 * plain rows with no Type at all — a vision model reading a working-orders table
 * hands back the parent AND its two "Inactive" children, and three rows on one
 * instrument then look like a batch of three trades instead of the single
 * bracketed order they are.
 *
 * A leg is recognised by what it is: an order to EXIT at a level some other
 * order is already protecting itself with. So it sits on the opposite side, at
 * exactly that order's stop or target, and carries no protection of its own —
 * an exit needs none. All three must hold, which leaves a genuine
 * stop-and-reverse entry alone as long as it was logged with its own bracket.
 */
export function dropBracketLegs(rows: ImportCandidate[]): ImportCandidate[] {
  return rows.filter((leg) => {
    if (leg.initialStop != null || leg.initialTarget != null) return true;
    return !rows.some(
      (parent) =>
        parent !== leg &&
        parent.symbol === leg.symbol &&
        parent.direction !== leg.direction &&
        ((parent.initialStop != null && samePrice(parent.initialStop, leg.entryPrice)) ||
          (parent.initialTarget != null && samePrice(parent.initialTarget, leg.entryPrice))),
    );
  });
}

/**
 * A stable identity for a preview row, so manual edits stay attached to the
 * order they were typed against. Array position cannot do this job: pasting a
 * second screen re-parses and re-merges, and every index after a folded row
 * shifts by one — moving a hand-typed stop onto somebody else's trade.
 */
export function candidateKey(c: Pick<ImportCandidate, "direction" | "entryPrice">): string {
  return `${c.direction}@${c.entryPrice}`;
}

export function parseImport(text: string): ImportResult {
  const candidates: ImportCandidate[] = [];
  const legs: ProtectiveLeg[] = [];
  const rejected: { raw: string; reason: string }[] = [];

  for (const line of text.split(/\r?\n/)) {
    if (isNoise(line)) continue;
    const cols = splitColumns(line);
    if (cols.length < 4) continue;

    // Bracket children are collected, never listed. They are half of a trade
    // that is already in the table, not a trade of their own.
    const leg = parseFuturesLeg(cols);
    if (leg) {
      legs.push(leg);
      continue;
    }

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

  /*
   * Attach each bracket child to the entry it protects: same instrument,
   * opposite side (a short is protected by buys), and missing that level.
   *
   * Most of the time this changes nothing — a working-orders table prints the
   * same numbers in the parent's own Take Profit / Stop Loss columns, so the
   * children are pure duplicates and simply disappear. The fold matters for the
   * venues that leave the parent's columns blank and put the levels only in the
   * child rows, where dropping them would lose the trade's risk entirely.
   */
  for (const leg of legs) {
    const parent = candidates.find(
      (c) =>
        c.symbol === leg.symbol &&
        c.direction !== leg.direction &&
        (leg.kind === "stop" ? c.initialStop == null : c.initialTarget == null),
    );
    if (!parent) continue;
    if (leg.kind === "stop") parent.initialStop = leg.price;
    else parent.initialTarget = leg.price;
    parent.warnings = pruneWarnings(parent);
  }

  /*
   * Both shapes can appear in one paste — an orders table with the Take Profit /
   * Stop Loss dialog for one of its rows appended underneath — so parse for both
   * rather than returning on the first match. (Returning early on the dialog
   * silently dropped every table row pasted above it.)
   *
   * The dialog goes last on purpose: mergeCandidates keeps the earlier row, and
   * the table row is the better keeper — it names the instrument, knows when the
   * order was placed, and its `raw` is the one line the preview can show back.
   * The dialog's own lines are label/value pairs, too narrow to be mistaken for
   * table rows, so the loop above skipped them without complaint. (One dialog
   * per paste: two would share a single Order A/B/C scan and interleave.)
   */
  const otoco = parseOtoco(text);
  if (otoco) candidates.push(otoco);

  return { candidates, rejected };
}
