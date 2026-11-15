/**
 * Sigil Core: a fund's holdings, read from the table its portfolio tracker
 * exports each morning, and what changed since the export before.
 *
 * The export is a semicolon-separated file. Reading it and comparing two of
 * them is arithmetic and is all here, with no model in it: the same file
 * gives the same answer every time. What changed is judged on the AMOUNT
 * held, never on dollars — a price moves the dollars, only a trade moves
 * the amount.
 *
 *   added     in this export, not in the one before
 *   removed   in the one before, not in this
 *   resized   in both, and the amount moved by more than a tenth
 *   dust      one that appeared or went while worth under twelve dollars:
 *             the tracker folds anything under ten into one row, so a
 *             position crossing that line is not a trade
 *
 * The streaks are what the page is for: a name sized the same way on two
 * or more updates running is the fund building or leaving a position.
 */
import { fmtAmount } from "./metrics";

export interface SigilPosition {
  name: string;
  symbol: string;
  amount: number;
  priceUsd: number | null;
  totalUsd: number;
  roi24h: number | null;
  share: number | null;
}

export interface SigilSnapshot {
  /** The UTC date in the file's name. */
  asOf: string;
  capturedAt: string;
  portfolioValueUsd: number;
  positionCount: number;
  dustTotalUsd: number;
  positions: SigilPosition[];
  source: string;
}

export interface SigilMove {
  name: string;
  symbol: string;
  amount: number;
  totalUsd: number;
}
export interface SigilResize {
  name: string;
  symbol: string;
  from: number;
  to: number;
  /** Signed, one decimal. */
  pct: number;
  totalUsd: number;
}
export interface SigilDust {
  name: string;
  symbol: string;
  direction: "in" | "out";
}

export interface SigilChange {
  date: string;
  status: "ok" | "baseline";
  portfolioValueUsd: number;
  positionCount: number;
  added: SigilMove[];
  removed: SigilMove[];
  resized: SigilResize[];
  dust: SigilDust[];
  notes?: string[];
  source: string;
  /** The date of the snapshot this one was compared with. */
  against?: string | null;
  /** One line of interpretation, written by a model: a reading, not a fact. */
  aiRead?: string | null;
}

export interface SigilAsset {
  tldr?: string | null;
  kind?: string | null;
  segment?: string | null;
  eco?: string | null;
  chain?: string | null;
  slug?: string | null;
  ca?: string | null;
  link?: string | null;
  /** The owner's own remark: an open question, a correction. */
  note?: string | null;
  /** Set when the owner wrote the entry by hand, so a re-read does not overwrite it. */
  edited?: boolean;
  /** Set when a model proposed a label that is not one of the known ones. */
  flagged?: string | null;
}

export const SIGIL_SEGMENTS = ["Stablecoin", "Yield & RWA", "Liquid staking", "L1 / L2", "Perps & exchanges", "DeFi", "AI", "DePIN", "Privacy", "Launchpad", "Memecoin", "Prediction & gaming", "Infrastructure", "Equity", "Private", "Fiat"] as const;
export const SIGIL_KINDS = ["token", "stock", "private", "stable", "lp-or-derivative", "fiat"] as const;
export const SIGIL_ECOS = [
  "Solana", "Ethereum", "Base", "Hyperliquid", "Robinhood Chain", "Arc", "BNB Chain", "Arbitrum", "Optimism", "Polygon", "zkSync", "World Chain", "MegaETH",
  "Bitcoin", "Zcash", "NEAR", "Cosmos", "Polkadot", "Bittensor", "Energy Web", "Aleo", "Celestia", "Multichain", "Equities", "Private deals", "Fiat", "Unknown",
] as const;
export const SIGIL_SLUGS = ["sol", "eth", "base", "optimism", "arb", "matic", "bsc", "zksync", "hyperevm", "worldchain", "robinhood", "arc"] as const;

/** Under this, a position that appears or goes is the tracker's ten-dollar bucket, not a trade. */
export const DUST_USD = 12;
/** An amount has to move by more than this share to count as resized. */
export const RESIZE_MIN = 0.1;
export const HISTORY_KEEP = 120;
export const UNVERIFIED = "(unverified)";

const HEADER = ["Asset", "Amount", "Price [USD]", "Price [BTC]", "Total [USD]", "Total [BTC]", "ROI 24h", "Share"];
const FILE_STAMP = /_(\d{4}-\d{2}-\d{2})T(\d{2})_(\d{2})_(\d{2}(?:\.\d+)?)Z\.csv$/i;

export class SigilRefused extends Error {}

const num = (s: string | undefined): number | null => {
  const t = (s ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/** When an export was taken, from its file name: "…_2026-11-15T10_40_12.929Z.csv". Null when the name carries no time. */
export function capturedAtOf(filename: string): string | null {
  const m = FILE_STAMP.exec(filename.trim());
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
  return Number.isFinite(new Date(iso).getTime()) ? iso : null;
}

/** The day an export belongs to: the date in Prague when it was taken. */
export function pragueDay(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Read an export. Throws SigilRefused, in words the page can show, for
 * anything that is not one: the wrong header, a name with no time in it, a
 * row that cannot be read.
 */
export function parseCrypkitCsv(text: string, filename: string): SigilSnapshot {
  const capturedAt = capturedAtOf(filename);
  if (!capturedAt) throw new SigilRefused("The file's name carries no time. A Crypkit export is named like Crypkit_portfolio-table_2026-11-15T10_40_12.929Z.csv.");
  // The file opens with a byte-order mark, which would otherwise be part of the first column's name.
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const head = (lines[0] ?? "").split(";").map((h) => h.trim());
  if (head.length !== HEADER.length || HEADER.some((h, i) => head[i] !== h)) throw new SigilRefused("This is not a Crypkit portfolio table: its first line should be Asset;Amount;Price [USD];Price [BTC];Total [USD];Total [BTC];ROI 24h;Share.");

  const positions: SigilPosition[] = [];
  let dustTotalUsd = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(";");
    if (cells.length !== HEADER.length) throw new SigilRefused(`Line ${i + 1} has ${cells.length} columns where ${HEADER.length} were expected.`);
    const name = cells[0].trim();
    const total = num(cells[4]);
    if (total == null) throw new SigilRefused(`Line ${i + 1} (${name || "no name"}) has no total.`);
    // Everything under ten dollars, as one row: a sum, not a position.
    if (name.startsWith("Other Assets")) {
      dustTotalUsd = total;
      continue;
    }
    const raw = cells[1].trim();
    const cut = raw.lastIndexOf(" ");
    const amount = cut > 0 ? num(raw.slice(0, cut)) : null;
    const symbol = cut > 0 ? raw.slice(cut + 1).trim() : "";
    if (amount == null || !symbol) throw new SigilRefused(`Line ${i + 1} (${name || "no name"}) has an amount that cannot be read: "${raw}".`);
    positions.push({ name, symbol, amount, priceUsd: num(cells[2]), totalUsd: total, roi24h: num(cells[6]), share: num(cells[7]) });
  }
  if (positions.length === 0) throw new SigilRefused("The file has no positions in it.");
  const value = positions.reduce((s, p) => s + p.totalUsd, 0) + dustTotalUsd;
  return { asOf: capturedAt.slice(0, 10), capturedAt, portfolioValueUsd: round2(value), positionCount: positions.length, dustTotalUsd, positions, source: "csv-export" };
}

/** Positions by symbol; two rows that share one are told apart by name as well. */
function keyed(ps: SigilPosition[]): Map<string, SigilPosition> {
  const count = new Map<string, number>();
  for (const p of ps) count.set(p.symbol, (count.get(p.symbol) ?? 0) + 1);
  const out = new Map<string, SigilPosition>();
  for (const p of ps) out.set(count.get(p.symbol)! > 1 ? `${p.name}|${p.symbol}` : p.symbol, p);
  return out;
}

const dayNumber = (d: string) => Math.round(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86400_000);

/**
 * What changed between two snapshots, filed under `day`. With no earlier
 * snapshot the day is a baseline: there is nothing to compare it with.
 * Throws when the counts do not add up, which would mean a position was
 * neither kept, added, removed nor dust.
 */
export function diffSnapshots(prev: SigilSnapshot | null, next: SigilSnapshot, day: string, prevDay?: string | null): SigilChange {
  const base = { date: day, portfolioValueUsd: next.portfolioValueUsd, positionCount: next.positionCount, source: next.source };
  if (!prev) return { ...base, status: "baseline", added: [], removed: [], resized: [], dust: [], against: null };

  const P = keyed(prev.positions);
  const T = keyed(next.positions);
  const added: SigilMove[] = [];
  const removed: SigilMove[] = [];
  const resized: SigilResize[] = [];
  const dust: SigilDust[] = [];
  T.forEach((p, k) => {
    const q = P.get(k);
    if (!q) {
      if (p.totalUsd < DUST_USD) dust.push({ name: p.name, symbol: p.symbol, direction: "in" });
      else added.push({ name: p.name, symbol: p.symbol, amount: p.amount, totalUsd: p.totalUsd });
    } else if (q.amount && Math.abs(p.amount - q.amount) / Math.abs(q.amount) > RESIZE_MIN) {
      resized.push({ name: p.name, symbol: p.symbol, from: q.amount, to: p.amount, pct: Math.round(((p.amount - q.amount) / q.amount) * 1000) / 10, totalUsd: p.totalUsd });
    }
  });
  P.forEach((q, k) => {
    if (T.has(k)) return;
    if (q.totalUsd < DUST_USD) dust.push({ name: q.name, symbol: q.symbol, direction: "out" });
    else removed.push({ name: q.name, symbol: q.symbol, amount: q.amount, totalUsd: q.totalUsd });
  });

  const dustIn = dust.filter((d) => d.direction === "in").length;
  const dustOut = dust.length - dustIn;
  const expected = prev.positions.length - removed.length + added.length - dustOut + dustIn;
  if (expected !== next.positions.length) throw new Error(`The comparison does not add up: ${prev.positions.length} before, ${removed.length} removed, ${added.length} added, ${dustOut} dust out, ${dustIn} dust in should leave ${expected}, and the file has ${next.positions.length}.`);

  const from = prevDay ?? prev.asOf;
  const gap = dayNumber(day) - dayNumber(from);
  const notes = gap > 1 ? [`Previous snapshot was ${from}: this diff spans ${gap} days, so resizes are cumulative.`] : [];
  return { ...base, status: "ok", added, removed, resized, dust, ...(notes.length ? { notes } : {}), against: from };
}

/* --------------------------------- reading -------------------------------- */

export interface SigilMover {
  name: string;
  symbol: string;
  roi24h: number;
  totalUsd: number;
}

/** The three that rose most and the three that fell most over the day, whatever their size. */
export function sigilMovers(positions: SigilPosition[], n = 3): { up: SigilMover[]; down: SigilMover[] } {
  const mv = positions.filter((p): p is SigilPosition & { roi24h: number } => p.roi24h != null).map((p) => ({ name: p.name, symbol: p.symbol, roi24h: p.roi24h, totalUsd: p.totalUsd }));
  const asc = mv.slice().sort((a, b) => a.roi24h - b.roi24h);
  return { down: asc.slice(0, n).filter((m) => m.roi24h < 0), up: asc.slice(-n).reverse().filter((m) => m.roi24h > 0) };
}

export interface SigilGroup {
  key: string;
  valueUsd: number;
  /** The day's move of the group as a whole, weighted by value; null when no position in it has one. */
  roi24h: number | null;
  count: number;
}

export const segmentOf = (a: SigilAsset | undefined) => a?.segment?.trim() || "Uncategorized";
export const ecoOf = (a: SigilAsset | undefined) => a?.eco?.trim() || "Unknown";

/** Value and the day's move by segment or by ecosystem, largest first. */
export function sigilGroups(positions: SigilPosition[], assets: Record<string, SigilAsset>, by: "segment" | "eco"): SigilGroup[] {
  const m = new Map<string, { value: number; now: number; before: number; count: number }>();
  for (const p of positions) {
    const a = assets[p.symbol];
    const key = by === "segment" ? segmentOf(a) : ecoOf(a);
    const g = m.get(key) ?? { value: 0, now: 0, before: 0, count: 0 };
    g.value += p.totalUsd;
    g.count++;
    if (p.roi24h != null && p.roi24h > -100) {
      g.now += p.totalUsd;
      g.before += p.totalUsd / (1 + p.roi24h / 100);
    }
    m.set(key, g);
  }
  return Array.from(m.entries())
    .map(([key, g]) => ({ key, valueUsd: g.value, roi24h: g.before > 0 ? (g.now / g.before - 1) * 100 : null, count: g.count }))
    .sort((a, b) => b.valueUsd - a.valueUsd);
}

export interface SigilStreak {
  name: string;
  symbol: string;
  direction: "up" | "down";
  /** The resizes that make the streak, oldest first, in percent. */
  steps: { date: string; pct: number }[];
  /** The amount before the first step and after the last. */
  from: number;
  to: number;
  /** The whole move, in percent of the amount it started from. */
  totalPct: number;
  /** Whether the streak reaches the latest update, or ended before it. */
  live: boolean;
  /** How the streak ended, when it did: the position was closed, or opened. */
  ended?: "removed" | null;
}

/**
 * Names sized the same way on two or more updates running.
 *
 * An update that does not touch a name ends its run: "consecutive" means
 * one update after another, with no quiet one between. A position opened
 * and then added to is a streak up from the opening; one cut and then
 * closed is a streak down that ends in the close. Dust is not a trade and
 * counts as an update that did not touch the name.
 */
export function sigilStreaks(changes: SigilChange[], minSteps = 2): SigilStreak[] {
  const ordered = changes.filter((c) => c.status === "ok").slice().sort((a, b) => a.date.localeCompare(b.date));
  type Run = { name: string; symbol: string; dir: 1 | -1; steps: { date: string; pct: number }[]; from: number; to: number; last: number; ended?: "removed" };
  const open = new Map<string, Run>();
  const done: Run[] = [];
  const close = (k: string) => {
    const r = open.get(k);
    if (r) done.push(r);
    open.delete(k);
  };
  ordered.forEach((c, i) => {
    const touched = new Set<string>();
    const step = (name: string, symbol: string, pct: number, from: number, to: number, ended?: "removed") => {
      const k = `${name}|${symbol}`;
      touched.add(k);
      const dir = pct >= 0 ? 1 : -1;
      const r = open.get(k);
      if (r && r.dir === dir && r.last === i - 1) {
        r.steps.push({ date: c.date, pct });
        r.to = to;
        r.last = i;
        if (ended) r.ended = ended;
      } else {
        close(k);
        open.set(k, { name, symbol, dir, steps: [{ date: c.date, pct }], from, to, last: i, ...(ended ? { ended } : {}) });
      }
      if (ended) close(k);
    };
    for (const a of c.added) step(a.name, a.symbol, 100, 0, a.amount);
    for (const r of c.resized) step(r.name, r.symbol, r.pct, r.from, r.to);
    for (const r of c.removed) step(r.name, r.symbol, -100, r.amount, 0, "removed");
    // A name this update left alone is no longer on a run.
    Array.from(open.keys()).forEach((k) => {
      if (!touched.has(k) && open.get(k)!.last < i) close(k);
    });
  });
  const lastIndex = ordered.length - 1;
  const all = [...done, ...Array.from(open.values())];
  return all
    .filter((r) => r.steps.length >= minSteps)
    .map((r) => ({
      name: r.name,
      symbol: r.symbol,
      direction: r.dir > 0 ? ("up" as const) : ("down" as const),
      steps: r.steps,
      from: r.from,
      to: r.to,
      totalPct: r.from > 0 ? Math.round((r.to / r.from - 1) * 1000) / 10 : 100,
      live: r.last === lastIndex && !r.ended,
      ended: r.ended ?? null,
    }))
    .sort((a, b) => Number(b.live) - Number(a.live) || b.steps[b.steps.length - 1].date.localeCompare(a.steps[a.steps.length - 1].date) || b.steps.length - a.steps.length);
}

/* --------------------------------- report --------------------------------- */

const whole = (n: number) => Math.round(n).toLocaleString("en-US");
const amountText = (n: number) => (Math.abs(n) >= 1000 ? whole(n) : Math.abs(n) >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toLocaleString("en-US", { maximumSignificantDigits: 4 }));
const signed = (n: number, d = 1) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}%`;
const usd = (n: number) => fmtAmount(n, 0);

export const changeCount = (c: SigilChange) => c.added.length + c.removed.length + c.resized.length;
export const isQuiet = (c: SigilChange) => changeCount(c) === 0 && c.dust.length === 0;

/** The day's report, a line per kind of change: what the page shows after an upload and on each day's card. */
export function sigilReport(change: SigilChange, opts: { previousValueUsd?: number | null; movers?: { up: SigilMover[]; down: SigilMover[] } } = {}): string[] {
  const n = changeCount(change);
  const lines = [`Sigil Core — ${change.date}: ${change.status === "baseline" ? "first snapshot" : n === 0 ? "quiet day" : `${n} change${n === 1 ? "" : "s"}`}`];
  for (const a of change.added) lines.push(`ADDED ${a.name} (${a.symbol}) ${amountText(a.amount)} · ${usd(a.totalUsd)}`);
  for (const r of change.removed) lines.push(`REMOVED ${r.name} (${r.symbol}) ${amountText(r.amount)} · ${usd(r.totalUsd)}`);
  for (const r of change.resized) lines.push(`RESIZED ${r.name} (${r.symbol}) ${amountText(r.from)} → ${amountText(r.to)} (${signed(r.pct)}) · ${usd(r.totalUsd)}`);
  const dustIn = change.dust.filter((d) => d.direction === "in").map((d) => d.name);
  const dustOut = change.dust.filter((d) => d.direction === "out").map((d) => d.name);
  if (dustIn.length) lines.push(`DUST in: ${dustIn.join(", ")}`);
  if (dustOut.length) lines.push(`DUST out: ${dustOut.join(", ")}`);
  const prev = opts.previousValueUsd;
  const gap = change.against ? dayNumber(change.date) - dayNumber(change.against) : 0;
  const versus = prev && prev > 0 && change.against ? ` (${signed((change.portfolioValueUsd / prev - 1) * 100, 2)} vs ${change.against.slice(5)}${gap > 1 ? `, ${gap}-day gap` : ""})` : "";
  lines.push(`Portfolio ${usd(change.portfolioValueUsd)}${versus} · ${change.positionCount} positions`);
  const mv = opts.movers;
  const one = (m: SigilMover) => `${m.name} ${signed(m.roi24h)} (${usd(m.totalUsd)})`;
  if (mv?.up.length) lines.push(`Up:   ${mv.up.map(one).join(" · ")}`);
  if (mv?.down.length) lines.push(`Down: ${mv.down.map(one).join(" · ")}`);
  return lines;
}

/** Whether a description says the asset's identity is not confirmed. */
export const isUnverified = (a: SigilAsset | undefined) => !!a?.tldr && a.tldr.includes(UNVERIFIED);
/** Whether an asset still needs describing: no entry, or no segment or ecosystem. */
export const needsEnriching = (a: SigilAsset | undefined) => !a || !a.segment?.trim() || !a.eco?.trim();

/** Add or replace a day's point in the value history, oldest first, keeping the newest 120. */
export function withHistoryPoint<T extends { date: string }>(points: T[], point: T, keep = HISTORY_KEEP): T[] {
  return [...points.filter((p) => p.date !== point.date), point].sort((a, b) => a.date.localeCompare(b.date)).slice(-keep);
}
