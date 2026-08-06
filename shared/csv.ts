/**
 * CSV in and out.
 *
 * Out: every trade with its derived metrics already computed, so the file is
 * analysable in a spreadsheet or a notebook without reimplementing R. The point
 * of a journal is the questions you ask of it later, and no set of built-in
 * reports anticipates all of them.
 *
 * In: a broker's trade history, to backfill the trading you did before this
 * existed. Deliberately forgiving about column names — every venue spells the
 * same eight ideas differently, and a header the importer doesn't know is worth
 * a warning, not a refusal.
 */
import type { Trade, TradeWithTags, MistakeTag } from "./schema";
import { computeMetrics } from "./metrics";
import { parseNum } from "./import-parse";
import { dayKey } from "./daily";

/* ------------------------------- writing ------------------------------- */

/** RFC 4180: quote anything containing a comma, quote or newline; double inner quotes. */
function cell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map(cell).join(",")).join("\n");
}

const EXPORT_COLUMNS = [
  "id", "date", "time", "symbol", "direction", "status",
  "size", "sizeUnit", "pointValue",
  "entryPrice", "initialStop", "initialTarget", "exitPrice",
  "entryTime", "exitTime", "exitReason", "cancelReason",
  "riskDollars", "actualR", "actualPnL",
  "potentialR", "managementDeltaR", "captureRatio",
  "maeR", "mfeR",
  "style", "mistakes", "setups", "rationale", "notes",
] as const;

/**
 * One row per trade, metrics included.
 *
 * Derived columns are written out rather than left to the reader: `actualR`
 * depends on size unit, contract point value and direction, and a spreadsheet
 * formula recreating that is exactly where an analysis quietly goes wrong.
 */
export function tradesToCsv(
  trades: TradeWithTags[],
  tags: MistakeTag[],
  styles: { id: number; name: string }[] = [],
): string {
  const tagNames = Object.fromEntries(tags.map((t) => [t.id, t.name]));
  const styleNames = Object.fromEntries(styles.map((s) => [s.id, s.name]));

  const rows: (string | number | null | undefined)[][] = [[...EXPORT_COLUMNS]];

  for (const t of trades) {
    const m = computeMetrics(t);
    const entered = new Date(t.entryTime);
    const valid = !isNaN(entered.getTime());

    rows.push([
      t.id,
      // LOCAL date and hour, not UTC: these are the convenience columns you
      // group by in a spreadsheet, and they must agree with the calendar and
      // the hour-of-day breakdown, both of which use the local clock. The raw
      // ISO instants are still exported below for anything that needs them.
      valid ? localDate(entered) : "",
      valid ? localTime(entered) : "",
      t.symbol,
      t.direction,
      t.status,
      t.size,
      t.sizeUnit,
      t.pointValue,
      t.entryPrice,
      t.initialStop,
      t.initialTarget,
      t.exitPrice,
      t.entryTime,
      t.exitTime,
      t.exitReason,
      t.cancelReason,
      round(m.riskDollars),
      round(m.actualR, 4),
      round(m.actualPnL),
      round(m.potentialR, 4),
      round(m.managementDeltaR, 4),
      round(m.captureRatio, 4),
      round(m.maeR, 4),
      round(m.mfeR, 4),
      t.styleId != null ? (styleNames[t.styleId] ?? "") : "",
      t.mistakeTagIds.map((id) => tagNames[id]).filter(Boolean).join("; "),
      setupsOf(t),
      t.rationale,
      t.notes,
    ]);
  }

  return rows.map((r) => r.map(cell).join(",")).join("\n");
}

// The date column reuses the calendar's own key so a CSV grouped by `date`
// always matches what the daily page shows for the same day.
const localDate = dayKey;

function localTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function round(v: number | null | undefined, dp = 2): number | null {
  if (v == null || !isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function setupsOf(t: Trade): string {
  if (!t.rationaleTags) return "";
  try {
    const parsed = JSON.parse(t.rationaleTags);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string").join("; ") : "";
  } catch {
    return "";
  }
}

/* ------------------------------- reading ------------------------------- */

/**
 * Split one CSV line, honouring quoted fields.
 *
 * Hand-rolled because the alternative is a dependency for eighty lines, and
 * the shape is fixed: a quote inside a quoted field is written doubled.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Which of our fields a header names.
 *
 * Every venue spells these differently, so match on a normalised header rather
 * than an exact string. Order matters: the first pattern that matches wins, so
 * the more specific ones ("entry price") are listed before the looser ones
 * ("price") that would otherwise swallow them.
 */
const HEADER_PATTERNS: [RegExp, string][] = [
  [/^(symbol|instrument|ticker|contract|market|pair)$/, "symbol"],
  [/^(side|direction|type|b\/s|buy.?sell|action)$/, "direction"],
  [/^(qty|quantity|size|contracts|amount|volume|filled.?qty)$/, "size"],
  [/(entry|open|fill|avg).*(price|fill)|^price$/, "entryPrice"],
  [/(exit|close|closing).*(price)|^close$/, "exitPrice"],
  [/(stop.?loss|initial.?stop|^stop$|sl)/, "initialStop"],
  [/(take.?profit|target|^tp$)/, "initialTarget"],
  [/(entry|open|trade).*(time|date)|^(time|date|datetime|timestamp)$/, "entryTime"],
  [/(exit|close|closing).*(time|date)/, "exitTime"],
  [/^(pnl|p&l|profit|realized|realised|net.?pnl|gross.?pnl)/, "pnl"],
  [/^(note|notes|comment|comments|remark)/, "notes"],
];

export function mapHeaders(headers: string[]): Record<number, string> {
  const map: Record<number, string> = {};
  const taken = new Set<string>();

  headers.forEach((h, i) => {
    const norm = h.toLowerCase().replace(/[_\-.]/g, " ").replace(/\s+/g, " ").trim();
    for (const [re, field] of HEADER_PATTERNS) {
      // One source column per field: a file with both "Time" and "Entry Time"
      // must not have the second silently overwrite the first.
      if (taken.has(field)) continue;
      if (re.test(norm)) {
        map[i] = field;
        taken.add(field);
        return;
      }
    }
  });

  return map;
}

export interface CsvTradeRow {
  symbol: string;
  direction: "long" | "short";
  size: number;
  entryPrice: number;
  initialStop: number | null;
  initialTarget: number | null;
  exitPrice: number | null;
  entryTime: string;
  exitTime: string | null;
  notes: string | null;
  /** Which line of the file this came from, so a warning can point at it. */
  line: number;
}

export interface CsvParseResult {
  rows: CsvTradeRow[];
  /** Columns present in the file that nothing was mapped to. */
  unmapped: string[];
  /** Lines that could not be turned into a trade, with why. */
  skipped: { line: number; reason: string }[];
  /** Fields the file has no column for at all — what the import will lack. */
  missingFields: string[];
}

// Number cleaning is shared with the paste importer — both read the same
// venue formats ("37,177.47 USDT"), and two copies of that regex WILL drift.
const num = parseNum;

function toIso(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  // "2026-08-05 21:30:51" and friends: no zone, so read as local rather than
  // silently shifting a morning trade into the previous evening.
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) {
    const [, y, mo, d, h, mi, sec] = m;
    return new Date(+y, +mo - 1, +d, +h, +mi, +(sec ?? 0)).toISOString();
  }
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const REQUIRED = ["symbol", "direction", "size", "entryPrice"];

/**
 * Read a broker CSV into trades.
 *
 * A row survives if it has the four things a trade cannot exist without.
 * Everything else is optional and reported: importing a history with no stops
 * is legitimate — you get a P&L record with no R — but the preview must say so
 * rather than let it be discovered later in a broken statistic.
 */
export function parseTradeCsv(text: string): CsvParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) {
    return { rows: [], unmapped: [], skipped: [], missingFields: REQUIRED };
  }

  const headers = splitCsvLine(lines[0]);
  const map = mapHeaders(headers);
  const mapped = new Set(Object.values(map));

  const unmapped = headers.filter((_, i) => !map[i]).filter((h) => h !== "");
  const missingFields = [
    ...REQUIRED.filter((f) => !mapped.has(f)),
    ...["initialStop", "exitPrice", "entryTime"].filter((f) => !mapped.has(f)),
  ];

  const rows: CsvTradeRow[] = [];
  const skipped: { line: number; reason: string }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const get = (field: string): string | undefined => {
      const idx = Object.keys(map).find((k) => map[Number(k)] === field);
      return idx == null ? undefined : cols[Number(idx)];
    };

    const symbol = (get("symbol") ?? "").trim().toUpperCase();
    const rawSide = (get("direction") ?? "").toLowerCase();
    const direction = /short|sell/.test(rawSide)
      ? "short"
      : /long|buy/.test(rawSide)
        ? "long"
        : null;
    const size = num(get("size"));
    const entryPrice = num(get("entryPrice"));

    if (!symbol) {
      skipped.push({ line: i + 1, reason: "no symbol" });
      continue;
    }
    if (!direction) {
      skipped.push({ line: i + 1, reason: `could not read a side from "${rawSide}"` });
      continue;
    }
    if (size == null || size <= 0) {
      skipped.push({ line: i + 1, reason: "no usable size" });
      continue;
    }
    if (entryPrice == null) {
      skipped.push({ line: i + 1, reason: "no entry price" });
      continue;
    }

    rows.push({
      symbol,
      direction,
      size,
      entryPrice,
      initialStop: num(get("initialStop")),
      initialTarget: num(get("initialTarget")),
      exitPrice: num(get("exitPrice")),
      // No timestamp is survivable — the import stamps it — but it costs every
      // time-of-day breakdown, which the preview warns about.
      entryTime: toIso(get("entryTime")) ?? new Date().toISOString(),
      exitTime: toIso(get("exitTime")),
      notes: (get("notes") ?? "").trim() || null,
      line: i + 1,
    });
  }

  return { rows, unmapped, skipped, missingFields };
}
