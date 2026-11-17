/**
 * The day's bias for the markets the session is traded around: BTC and
 * ETH, the stock indices the venue lists, and the metals.
 *
 * Read from each market's daily candles (shared/bias.ts). The candles are
 * the ones the screener's run stored, where the run read the market; a
 * market it did not read (the builder books off, or the market under the
 * volume line) is asked of the venue directly, daily bars only, and kept
 * for a quarter of an hour. So the panel does not depend on the screener's
 * settings, and opening the page does not start a run.
 */
import { dailyBias, type DailyBias } from "@shared/bias";
import { parseScreenerCandles, type ScreenerCandle } from "@shared/screener";
import { benchmarkLabel, isMetal, pickIndexBenchmarks } from "@shared/sectors";
import { hlInfo } from "./hyperliquid";
import { latestScreenerRun, measuredSeries, storedSeries } from "./screener";

const DAY_MS = 86400_000;
const KEEP_MS = 15 * 60_000;
/** Asked for when the run read none of its kind: the venue's most traded index and metal markets. */
const FALLBACK = { indices: ["xyz:SP500", "xyz:XYZ100"], metals: ["xyz:GOLD", "xyz:SILVER"] };

export interface BiasMarket {
  coin: string;
  label: string;
  group: "Crypto" | "TradFi" | "Metals";
  /** Null when the market's candles could not be had, with the reason. */
  bias: DailyBias | null;
  error: string | null;
}

export interface BiasBoard {
  at: string;
  markets: BiasMarket[];
}

const asked = new Map<string, { at: number; daily: ScreenerCandle[] }>();

async function dailyOf(coin: string, to: number, askVenue: boolean): Promise<ScreenerCandle[]> {
  const stored = measuredSeries(await storedSeries(coin), to)["1d"];
  // Fresh enough to speak for today: its last bar is today's or yesterday's.
  if (stored.length >= 6 && to - stored[stored.length - 1].t < 2 * DAY_MS) return stored;
  const hit = asked.get(coin);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.daily;
  // A visitor's look reads what is stored and nothing else.
  if (!askVenue) return hit?.daily ?? stored;
  const now = Date.now();
  const raw = await hlInfo({ type: "candleSnapshot", req: { coin, interval: "1d", startTime: now - 120 * DAY_MS, endTime: now } }, 20_000, { lane: "background" });
  const daily = parseScreenerCandles(raw);
  asked.set(coin, { at: now, daily });
  return daily;
}

const metalName = (coin: string) => {
  const n = coin.slice(coin.indexOf(":") + 1).toUpperCase();
  return n.charAt(0) + n.slice(1).toLowerCase();
};

let board: { at: number; runId: number | null; value: BiasBoard } | null = null;

export async function biasBoard(opts: { askVenue?: boolean } = {}): Promise<BiasBoard> {
  const askVenue = opts.askVenue !== false;
  const run = await latestScreenerRun();
  if (board && Date.now() - board.at < KEEP_MS && board.runId === (run?.id ?? null)) return board.value;
  const rows = (run?.rows ?? []).filter((r) => !r.error);
  const picks = pickIndexBenchmarks(rows.map((r) => ({ coin: r.coin, volume: r.volume24h })));
  const indices = [picks.main, picks.other].filter((c): c is string => !!c);
  const metals = rows
    .filter((r) => isMetal(r.coin))
    .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
    .slice(0, 3)
    .map((r) => r.coin);
  const list: { coin: string; label: string; group: BiasMarket["group"] }[] = [
    { coin: "BTC", label: "BTC", group: "Crypto" },
    { coin: "ETH", label: "ETH", group: "Crypto" },
    ...(indices.length ? indices : FALLBACK.indices).map((coin) => ({ coin, label: benchmarkLabel(coin), group: "TradFi" as const })),
    ...(metals.length ? metals : FALLBACK.metals).map((coin) => ({ coin, label: metalName(coin), group: "Metals" as const })),
  ];
  const to = Date.now();
  const markets: BiasMarket[] = [];
  // One after another: the ones asked of the venue share its request allowance with everything else.
  for (const m of list) {
    try {
      const daily = await dailyOf(m.coin, to, askVenue);
      const bias = dailyBias(daily);
      markets.push({ ...m, bias, error: bias ? null : "Too few daily candles to read a bias from" });
    } catch (err: any) {
      markets.push({ ...m, bias: null, error: String(err?.message ?? err).slice(0, 140) });
    }
  }
  const value = { at: new Date(to).toISOString(), markets };
  // Only a full read is kept: a visitor's partial one must not stand in for the owner's.
  if (askVenue) board = { at: Date.now(), runId: run?.id ?? null, value };
  return value;
}
