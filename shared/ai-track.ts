/**
 * How the AI read's calls did. Each tip is priced from the screener's
 * hourly snapshots: at the read, then four hours, a day and three days on,
 * and now. A long is right when the price rose, a short when it fell, and
 * an "avoid" is scored as a short — the question being whether the coins
 * it warned off would have paid to short. "Watch" is a setup still
 * forming: its move is shown, not scored.
 *
 * The move against BTC over the same span is kept beside the price move,
 * since the screener ranks coins by relative strength.
 */

export type CallStance = "long" | "short" | "watch" | "avoid";
export const DIRECTION: Record<CallStance, 1 | -1 | 0> = { long: 1, short: -1, avoid: -1, watch: 0 };

export const TRACK_HORIZONS = [
  { id: "4h", ms: 4 * 3600_000 },
  { id: "24h", ms: 24 * 3600_000 },
  { id: "3d", ms: 72 * 3600_000 },
  { id: "1w", ms: 7 * 24 * 3600_000 },
] as const;
export type TrackKey = (typeof TRACK_HORIZONS)[number]["id"] | "now";
export const TRACK_KEYS: TrackKey[] = ["4h", "24h", "3d", "1w", "now"];

/** A snapshot is hourly: a price this close to the moment stands for it. */
const TOLERANCE_MS = 2 * 3600_000;
/** "Now" only from a recent snapshot: a coin gone from the venue has no now. */
const NOW_FRESH_MS = 3 * 3600_000;

export interface PricePoint {
  at: number;
  mark: number;
}

export interface CallMove {
  at: string;
  px: number;
  /** The price move since the call, as a fraction. */
  ret: number;
  /** The move against BTC over the same span, as a fraction; null without BTC's price at both ends. */
  rs: number | null;
  /** The move in the call's direction: positive is right. Null for a watch. */
  score: number | null;
}

export interface TrackedCall {
  readId: number;
  readAt: string;
  coin: string;
  stance: CallStance;
  confidence: string;
  horizon: string;
  entry: { at: string; px: number } | null;
  moves: Record<TrackKey, CallMove | null>;
}

export interface TrackCell {
  /** Calls with a price at this horizon. */
  n: number;
  /** Of those, how many moved the call's way (for a watch: how many rose). */
  hits: number;
  /** The mean move in the call's direction (for a watch: the mean price move). */
  avg: number | null;
  /** The same against BTC. */
  avgRs: number | null;
}

/** The last price at or before `t`, else the first after it, within the tolerance: where a call starts. */
export function priceAtStart(points: PricePoint[], t: number): PricePoint | null {
  let before: PricePoint | null = null;
  for (const p of points) {
    if (p.at <= t) before = p;
    else {
      if (before && t - before.at <= TOLERANCE_MS) return before;
      return p.at - t <= TOLERANCE_MS ? p : null;
    }
  }
  return before && t - before.at <= TOLERANCE_MS ? before : null;
}

/** The first price at or after `t`, within the tolerance: where a horizon ends. Null while it is still ahead. */
export function priceAfter(points: PricePoint[], t: number): PricePoint | null {
  for (const p of points) if (p.at >= t) return p.at - t <= TOLERANCE_MS ? p : null;
  return null;
}

/** BTC's price at a moment already priced for the coin: the snapshot at the same instant, or the nearest within the tolerance. */
function btcAt(btc: PricePoint[], t: number): number | null {
  let best: PricePoint | null = null;
  for (const p of btc) if (Math.abs(p.at - t) <= TOLERANCE_MS && (!best || Math.abs(p.at - t) < Math.abs(best.at - t))) best = p;
  return best?.mark ?? null;
}

export function trackCalls(
  reads: { id: number; at: string; tips: { coin: string; stance: CallStance; confidence?: string; horizon?: string }[] }[],
  series: Map<string, PricePoint[]>,
  now: number,
): TrackedCall[] {
  const btc = series.get("BTC") ?? [];
  const out: TrackedCall[] = [];
  for (const r of reads) {
    const t0 = new Date(r.at).getTime();
    for (const tip of r.tips) {
      const pts = series.get(tip.coin) ?? [];
      const start = priceAtStart(pts, t0);
      const moves = { "4h": null, "24h": null, "3d": null, "1w": null, now: null } as Record<TrackKey, CallMove | null>;
      if (start) {
        const b0 = btcAt(btc, start.at);
        const move = (p: PricePoint): CallMove => {
          const ret = p.mark / start.mark - 1;
          const b1 = btcAt(btc, p.at);
          const rs = b0 && b1 ? (1 + ret) / (b1 / b0) - 1 : null;
          const dir = DIRECTION[tip.stance];
          return { at: new Date(p.at).toISOString(), px: p.mark, ret, rs, score: dir === 0 ? null : dir * ret };
        };
        for (const h of TRACK_HORIZONS) {
          if (t0 + h.ms > now) continue;
          const p = priceAfter(pts, t0 + h.ms);
          if (p) moves[h.id] = move(p);
        }
        const last = pts[pts.length - 1];
        if (last && last.at > start.at && now - last.at <= NOW_FRESH_MS) moves.now = move(last);
      }
      out.push({
        readId: r.id,
        readAt: r.at,
        coin: tip.coin,
        stance: tip.stance,
        confidence: tip.confidence ?? "",
        horizon: tip.horizon ?? "",
        entry: start ? { at: new Date(start.at).toISOString(), px: start.mark } : null,
        moves,
      });
    }
  }
  return out;
}

/** Per stance and horizon: how many calls, how many went the call's way, and the mean move in its direction. */
export function summarizeCalls(calls: TrackedCall[]): Record<CallStance, Record<TrackKey, TrackCell>> {
  const empty = (): Record<TrackKey, TrackCell> => Object.fromEntries(TRACK_KEYS.map((k) => [k, { n: 0, hits: 0, avg: null, avgRs: null }])) as Record<TrackKey, TrackCell>;
  const out: Record<CallStance, Record<TrackKey, TrackCell>> = { long: empty(), short: empty(), avoid: empty(), watch: empty() };
  for (const stance of Object.keys(out) as CallStance[]) {
    const dir = DIRECTION[stance] || 1;
    for (const k of TRACK_KEYS) {
      const ms = calls.filter((c) => c.stance === stance && c.moves[k]).map((c) => c.moves[k]!);
      if (!ms.length) continue;
      const signed = ms.map((m) => dir * m.ret);
      const rs = ms.filter((m) => m.rs != null).map((m) => dir * m.rs!);
      out[stance][k] = {
        n: ms.length,
        hits: signed.filter((x) => x > 0).length,
        avg: signed.reduce((s, x) => s + x, 0) / signed.length,
        avgRs: rs.length ? rs.reduce((s, x) => s + x, 0) / rs.length : null,
      };
    }
  }
  return out;
}
