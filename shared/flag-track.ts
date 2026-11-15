/**
 * Did the screener's flags work.
 *
 * Every run writes down which coins it flagged — the first time in a day
 * each one is, so a coin flagged for twelve hours running is one entry and
 * not twelve copies of the same bet. Afterwards each entry is priced a
 * day, three days and a week on, against BTC over the same span, since
 * the screener's whole claim is relative: a flagged coin "worked" when it
 * beat BTC. "Weakest" is kept as the control: if the flags mean anything,
 * it should lose to BTC where the others beat it.
 */
import { trackCalls, type PricePoint } from "./ai-track";

export const FLAG_KINDS = [
  { id: "candidate-4h", label: "Candidate · 4h" },
  { id: "candidate-1D", label: "Candidate · 1D" },
  { id: "score-1D", label: "Score ≥ 4 · 1D" },
  { id: "rating", label: "Rating ≥ 90" },
  { id: "weakest-1D", label: "Weakest · 1D (should lose)" },
] as const;
export type FlagKind = (typeof FLAG_KINDS)[number]["id"];

export const FLAG_HORIZONS = ["24h", "3d", "1w"] as const;
export type FlagHorizon = (typeof FLAG_HORIZONS)[number];

/** A coin is written down again for a kind only after this long without it. */
export const FLAG_REPEAT_MS = 24 * 3600_000;
export const SCORE_FLAG_MIN = 4;
export const RATING_FLAG_MIN = 90;

export interface FlagCell {
  /** Entries priced at this horizon, against BTC. */
  n: number;
  /** Of those, how many beat BTC. */
  beat: number;
  /** The mean move against BTC, and the mean price move, as fractions. */
  avgRs: number | null;
  avg: number | null;
}

export interface FlagTrack {
  since: string;
  entries: number;
  kinds: { id: FlagKind; label: string; logged: number; cells: Record<FlagHorizon, FlagCell> }[];
}

/** What a run flags, from its rows: the kinds each coin qualifies for now. */
export function flagsOf(row: {
  coin: string;
  error: string | null;
  flags: Record<string, { candidate: boolean; weakest: boolean }>;
  signals?: Record<string, { score: number }>;
  strength?: { rating: number | null } | null;
}): FlagKind[] {
  if (row.error) return [];
  const out: FlagKind[] = [];
  if (row.flags["4h"]?.candidate) out.push("candidate-4h");
  if (row.flags["1D"]?.candidate) out.push("candidate-1D");
  if ((row.signals?.["1D"]?.score ?? 0) >= SCORE_FLAG_MIN) out.push("score-1D");
  if ((row.strength?.rating ?? 0) >= RATING_FLAG_MIN) out.push("rating");
  if (row.flags["1D"]?.weakest) out.push("weakest-1D");
  return out;
}

export function summarizeFlags(log: { at: string; coin: string; kind: string }[], series: Map<string, PricePoint[]>, now: number, since: string): FlagTrack {
  const kinds = FLAG_KINDS.map((k) => {
    const mine = log.filter((e) => e.kind === k.id);
    // Each entry priced as a call made at its own moment: the same pricing the AI read's calls get.
    const calls = trackCalls(mine.map((e, i) => ({ id: i, at: e.at, tips: [{ coin: e.coin, stance: "long" as const }] })), series, now);
    const cells = {} as Record<FlagHorizon, FlagCell>;
    for (const h of FLAG_HORIZONS) {
      const moves = calls.map((c) => c.moves[h]).filter((m): m is NonNullable<typeof m> => m != null && m.rs != null);
      cells[h] = {
        n: moves.length,
        beat: moves.filter((m) => m.rs! > 0).length,
        avgRs: moves.length ? moves.reduce((s, m) => s + m.rs!, 0) / moves.length : null,
        avg: moves.length ? moves.reduce((s, m) => s + m.ret, 0) / moves.length : null,
      };
    }
    return { id: k.id, label: k.label, logged: mine.length, cells };
  });
  return { since, entries: log.length, kinds };
}
