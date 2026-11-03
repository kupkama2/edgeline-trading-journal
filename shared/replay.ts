/**
 * A trade replayed bar by bar.
 *
 * The chart shows the whole path at once, with the levels where they ended
 * up. The replay shows it the way it was lived: the tape advancing one bar
 * at a time, the stop and the target where they WERE at that moment, and a
 * pause on each thing the trader did — a stop moved, a piece taken off, an
 * add, the exit — with the mark and the R at the time. The record for a
 * trade sent from or tracked by the terminal is the pinned idea and its
 * moves; for any other trade it is the stop log, the fills and the exit.
 * Both read into the same list, so every trade can be replayed.
 */
import { parseExtraTargets } from "./schema";
import { parseStopMoves } from "./stops";
import { ideaOf, rAt, type TerminalRef } from "./terminal";

export type ReplayKind = "entry" | "stop" | "target" | "partial" | "add" | "exit" | "plan-hit";

export interface ReplayEvent {
  /** ms */
  at: number;
  kind: ReplayKind;
  /** One line, in the trader's words. */
  text: string;
  /** The price the event happened at, for a mark on the bar. */
  price: number | null;
  /** The open R at that price against the original risk, when there is one. */
  r: number | null;
  /** The stop in force AFTER this event, and the targets. */
  stop: number | null;
  targets: number[];
}

/** A trade as the replay needs it: the columns, the fills, and the terminal ref when there is one. */
export interface ReplayTrade {
  direction: string;
  status: string;
  entryPrice: number;
  entryTime: string;
  size: number;
  initialStop?: number | null;
  initialTarget?: number | null;
  extraTargets?: string | null;
  stopMoves?: string | null;
  riskAmount?: number | null;
  exitPrice?: number | null;
  exitTime?: string | null;
  exitReason?: string | null;
  fills?: { kind: string; price: number; size: number; time: string; note?: string | null }[];
}

const ms = (iso: string) => new Date(iso).getTime();
const fmt = (n: number | null | undefined) => (n == null ? "—" : String(Number(n.toFixed(8))));
const fmtR = (r: number | null) => (r == null ? "" : ` (${r >= 0 ? "+" : ""}${r.toFixed(2)}R)`);

/**
 * Everything that happened on the trade, in time order, each with the levels
 * in force once it had happened. The entry comes first with the plan's
 * levels; a stop or target move changes them; a partial, an add and the
 * exit leave them.
 */
export function replayEvents(t: ReplayTrade, ref: TerminalRef | null): ReplayEvent[] {
  const idea = ref ? ideaOf(t, ref) : null;
  const entry = idea?.entry ?? t.entryPrice;
  const riskStop = idea?.stop ?? t.initialStop ?? null;
  const r = (price: number | null) => (price == null ? null : rAt(price, t.entryPrice, riskStop, t.direction));
  let stop = idea?.stop ?? t.initialStop ?? null;
  let targets = idea ? [...idea.targets] : [t.initialTarget, ...parseExtraTargets(t.extraTargets)].filter((x): x is number => x != null);
  const out: ReplayEvent[] = [];
  const entryAt = ms(t.entryTime);
  const rr = stop != null && targets[0] != null && Math.abs(entry - stop) > 0 ? Math.abs(targets[0] - entry) / Math.abs(entry - stop) : null;
  out.push({
    at: entryAt,
    kind: "entry",
    text: `In: ${t.direction} ${fmt(t.size)} at ${fmt(t.entryPrice)} — stop ${fmt(stop)}, target ${fmt(targets[0] ?? null)}${rr != null ? ` (${rr.toFixed(1)}R)` : ""}`,
    price: t.entryPrice,
    r: 0,
    stop,
    targets: [...targets],
  });

  // The moves: the terminal's own record where there is one, the stop log otherwise.
  type Raw = { at: number; kind: "stop" | "target"; from: number | null; to: number | null; mark: number | null; r: number | null };
  const raw: Raw[] = [];
  if (ref?.moves?.length) {
    for (const m of ref.moves) {
      if (m.kind !== "stop" && m.kind !== "target") continue;
      if (m.to == null) continue;
      raw.push({ at: ms(m.at), kind: m.kind, from: m.from ?? null, to: m.to, mark: m.mark ?? null, r: m.r ?? null });
    }
  } else {
    let prev = stop;
    for (const m of parseStopMoves(t.stopMoves)) {
      raw.push({ at: ms(m.at), kind: "stop", from: prev, to: m.price, mark: null, r: null });
      prev = m.price;
    }
  }
  raw.sort((a, b) => a.at - b.at);
  const fills = [...(t.fills ?? [])].map((f) => ({ ...f, atMs: ms(f.time) })).sort((a, b) => a.atMs - b.atMs);
  const hits: { at: number; text: string; price: number | null }[] = [];
  const w = ref?.planWatch;
  if (w?.stopHitAt) hits.push({ at: ms(w.stopHitAt), text: `Tape reached the original stop ${fmt(w.stopHitPrice)}`, price: w.stopHitPrice ?? null });
  if (w?.targetHitAt) hits.push({ at: ms(w.targetHitAt), text: `Tape reached the original target ${fmt(w.targetHitPrice)}`, price: w.targetHitPrice ?? null });

  // Merge the three in time, applying each to the levels as it goes.
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < raw.length || j < fills.length || k < hits.length) {
    const a = raw[i]?.at ?? Infinity;
    const b = fills[j]?.atMs ?? Infinity;
    const c = hits[k]?.at ?? Infinity;
    if (a <= b && a <= c) {
      const m = raw[i++];
      if (m.kind === "stop") {
        stop = m.to;
        const be = Math.abs((m.to ?? NaN) - entry) < 1e-9;
        out.push({ at: m.at, kind: "stop", text: `Stop ${fmt(m.from)} → ${fmt(m.to)}${be ? " (breakeven)" : ""}${m.mark != null ? ` · mark ${fmt(m.mark)}` : ""}${fmtR(m.r)}`, price: m.mark, r: m.r, stop, targets: [...targets] });
      } else {
        targets = m.to != null ? [m.to, ...targets.slice(1)] : targets.slice(1);
        out.push({ at: m.at, kind: "target", text: `Target ${fmt(m.from)} → ${fmt(m.to)}${m.mark != null ? ` · mark ${fmt(m.mark)}` : ""}${fmtR(m.r)}`, price: m.mark, r: m.r, stop, targets: [...targets] });
      }
    } else if (b <= c) {
      const f = fills[j++];
      const fr = r(f.price);
      const add = f.kind === "add";
      out.push({ at: f.atMs, kind: add ? "add" : "partial", text: `${add ? "Added" : "Took off"} ${fmt(f.size)} at ${fmt(f.price)}${fmtR(fr)}`, price: f.price, r: fr, stop, targets: [...targets] });
    } else {
      const h = hits[k++];
      out.push({ at: h.at, kind: "plan-hit", text: h.text, price: h.price, r: r(h.price), stop, targets: [...targets] });
    }
  }

  if (t.status === "closed" && t.exitPrice != null && t.exitTime) {
    const xr = r(t.exitPrice);
    out.push({ at: ms(t.exitTime), kind: "exit", text: `Out at ${fmt(t.exitPrice)}${t.exitReason ? ` — ${t.exitReason}` : ""}${fmtR(xr)}`, price: t.exitPrice, r: xr, stop, targets: [...targets] });
  }
  // The exit last among anything stamped the same instant.
  const rank = (e: ReplayEvent) => (e.kind === "exit" ? 2 : e.kind === "entry" ? 0 : 1);
  return out.sort((a, b) => a.at - b.at || rank(a) - rank(b));
}

/** The levels in force at an instant: those of the last event at or before it, the plan's before the entry. */
export function levelsAt(events: ReplayEvent[], atMs: number): { stop: number | null; targets: number[]; inTrade: boolean; done: boolean } {
  let last: ReplayEvent | null = null;
  for (const e of events) {
    if (e.at > atMs) break;
    last = e;
  }
  const first = events[0] ?? null;
  if (!last) return { stop: first?.stop ?? null, targets: first?.targets ?? [], inTrade: false, done: false };
  return { stop: last.stop, targets: last.targets, inTrade: last.kind !== "exit", done: last.kind === "exit" };
}

/** The events that fall inside a bar: after the previous bar's instant, up to and including this one's end. */
export function eventsInBar(events: ReplayEvent[], prevEndMs: number, endMs: number): ReplayEvent[] {
  return events.filter((e) => e.at > prevEndMs && e.at <= endMs);
}
