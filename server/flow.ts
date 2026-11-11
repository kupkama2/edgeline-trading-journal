/**
 * The reads behind shared/flow.ts, done once per screener run.
 *
 * Binance flow goes through the owner's relay, never from this server:
 * Binance has banned the server's shared IP before, and the relay asks
 * from the owner's own machine. Four public reads per coin — an hour's
 * klines for a week (CVD), the global account ratio, the top traders'
 * position ratio and open-interest history for two days — plus every
 * symbol's mark and funding in one read. Binance allows 1000 of these
 * data reads per five minutes per IP; the pass keeps to FLOW_PER_MIN
 * (150 by default), so a hundred coins take under three minutes. With no
 * relay connected, or an older copy that cannot make public reads, the
 * pass says so and the run goes on without it.
 *
 * The liquidation map reads Hyperliquid's public leaderboard for its
 * largest accounts and each one's positions (2 weight apiece), paced
 * under the venue's budget.
 */
import { fetch as undiciFetch } from "undici";
import { egressFor } from "./egress";
import { hlInfo } from "./hyperliquid";
import { publicRelayFor, relayPublic } from "./relay";
import { accounts as accountStore } from "./storage";
import { parseClearinghouseState } from "@shared/hyperliquid";
import {
  binanceSymbolFor,
  flowReadings,
  matchBinance,
  liqMapOf,
  parseFlowKlines,
  parseFundingInfo,
  parseLeaderboard,
  parseOiHist,
  parsePremiumIndex,
  parseRatio,
  type FlowReadings,
  type LiqMap,
} from "@shared/flow";

const FLOW_PER_MIN = Number(process.env.FLOW_PER_MIN ?? "150");
const LIQ_ACCOUNTS = Number(process.env.LIQ_ACCOUNTS ?? "300");
const LIQ_PER_MIN = Number(process.env.LIQ_PER_MIN ?? "200");
const LIQ_GIVE_UP_AFTER = 12;
const STATS_BASE = (process.env.HL_STATS_BASE || "https://stats-data.hyperliquid.xyz").replace(/\/+$/, "");

export interface FlowStatus {
  source: "relay" | "none";
  /** The relay's account, when one did the reads. */
  account: string | null;
  /** A relay is connected but is an older copy without public reads: download the new one. */
  outdated: boolean;
  coins: number;
  failed: number;
  /** Coins whose Binance namesake trades at a different price: another token, so no flow. */
  mismatched?: string[];
  error: string | null;
}

export interface LiqStatus {
  accounts: number;
  failed: number;
  error: string | null;
}

/** A request pacer: at most `perMin` a minute, spaced evenly. */
function pacer(perMin: number) {
  const gap = perMin > 0 ? 60_000 / perMin : 0;
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + gap;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
}

/* ------------------------------- Binance flow ------------------------------- */

export async function readBinanceFlow(
  coins: { coin: string; mark: number | null; fundingHourly: number | null }[],
  onProgress?: (done: number, total: number) => void,
  /**
   * Hyperliquid's marks and funding as they are NOW, read just before
   * Binance's. The marks handed in are from the start of the run, minutes
   * (ten, on a first read) before this pass, and the basis between the two
   * venues is measured to a third of a percent: an alt that moved in
   * between read as a gap between venues.
   */
  marksNow?: () => Promise<Map<string, { mark: number | null; funding: number | null }>>,
): Promise<{ status: FlowStatus; byCoin: Map<string, FlowReadings> }> {
  const byCoin = new Map<string, FlowReadings>();
  const owner = await accountStore.owner().catch(() => undefined);
  const relay = owner ? publicRelayFor(owner.id) : { account: null, outdated: false };
  const status: FlowStatus = { source: "none", account: null, outdated: relay.outdated, coins: 0, failed: 0, error: null };
  if (!owner || !relay.account) {
    status.error = relay.outdated ? "The relay running is an older copy that cannot read market data. Download the new relay file and restart it." : "No relay connected. Start the relay on your machine and the next run reads Binance's flow through it.";
    return { status, byCoin };
  }
  status.source = "relay";
  status.account = relay.account;
  const wait = pacer(FLOW_PER_MIN);
  const get = async (path: string, params: Record<string, string | number> = {}) => {
    await wait();
    const r = await relayPublic(owner.id, relay.account!, path, params);
    if (r.status !== 200) throw new Error(`Binance ${path} → HTTP ${r.status} ${r.body.slice(0, 100)}`);
    return JSON.parse(r.body) as unknown;
  };
  let premium: Map<string, { mark: number; funding: number }>;
  let intervals = new Map<string, number>();
  try {
    const fresh = marksNow ? await marksNow().catch(() => null) : null;
    if (fresh) coins = coins.map((c) => ({ ...c, mark: fresh.get(c.coin)?.mark ?? c.mark, fundingHourly: fresh.get(c.coin)?.funding ?? c.fundingHourly }));
    premium = parsePremiumIndex(await get("/fapi/v1/premiumIndex"));
    intervals = parseFundingInfo(await get("/fapi/v1/fundingInfo").catch(() => []));
  } catch (err: any) {
    status.error = String(err?.message ?? err).slice(0, 200);
    return { status, byCoin };
  }
  // Only the coins Binance lists as the same coin: a USDT perp whose price agrees with Hyperliquid's.
  const listed = coins.map((c) => ({ ...c, match: matchBinance(c.coin, c.mark, premium) })).filter((c) => c.match);
  status.mismatched = coins.filter((c) => !matchBinance(c.coin, c.mark, premium) && (premium.has(binanceSymbolFor(c.coin)) || premium.has(`1000${c.coin.toUpperCase()}USDT`))).map((c) => c.coin);
  let done = 0;
  for (const c of listed) {
    const { symbol, scale } = c.match!;
    try {
      const [klines, accounts, top, oi] = [
        parseFlowKlines(await get("/fapi/v1/klines", { symbol, interval: "1h", limit: 168 })),
        parseRatio(await get("/futures/data/globalLongShortAccountRatio", { symbol, period: "1h", limit: 48 })),
        parseRatio(await get("/futures/data/topLongShortPositionRatio", { symbol, period: "1h", limit: 48 })),
        parseOiHist(await get("/futures/data/openInterestHist", { symbol, period: "1h", limit: 48 })),
      ];
      const bn = premium.get(symbol);
      byCoin.set(c.coin, flowReadings({ symbol, klines, accounts, top, oi, hlMark: c.mark, hlFundingHourly: c.fundingHourly, bn: bn ? { mark: bn.mark / scale, funding: bn.funding } : null, bnIntervalHours: intervals.get(symbol) ?? 8 }));
      status.coins++;
    } catch (err: any) {
      status.failed++;
      if (!status.error) status.error = `${c.coin}: ${String(err?.message ?? err).slice(0, 160)}`;
      // A relay that went away mid-pass: stop asking it.
      if (/relay (went away|is not connected|did not answer)/.test(String(err?.message))) break;
    }
    onProgress?.(++done, listed.length);
  }
  return { status, byCoin };
}

/* ------------------------------- the liquidation map ------------------------------- */

export async function readLiqMap(
  coins: { coin: string; mark: number | null }[],
  onProgress?: (done: number, total: number) => void,
  /** The mids as they are once the accounts are read: the bands are a percent wide, and the marks handed in are from the start of the run. */
  midsNow?: () => Promise<Map<string, number>>,
): Promise<{ status: LiqStatus; byCoin: Map<string, LiqMap> }> {
  const byCoin = new Map<string, LiqMap>();
  const status: LiqStatus = { accounts: 0, failed: 0, error: null };
  let addresses: string[] = [];
  try {
    const url = `${STATS_BASE}/Mainnet/leaderboard`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60_000);
    try {
      const res = await undiciFetch(url, { headers: { accept: "application/json" }, signal: ctl.signal, dispatcher: egressFor(url) } as any);
      if (!res.ok) throw new Error(`leaderboard → HTTP ${res.status}`);
      addresses = parseLeaderboard(await res.json(), LIQ_ACCOUNTS);
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    status.error = String(err?.message ?? err).slice(0, 200);
    return { status, byCoin };
  }
  const wanted = new Map(coins.filter((c) => c.mark != null && c.mark > 0).map((c) => [c.coin, c.mark!]));
  const positions = new Map<string, { szi: number; liquidationPx: number | null }[]>();
  const holders = new Map<string, Set<string>>();
  const wait = pacer(LIQ_PER_MIN);
  let done = 0;
  let failedInARow = 0;
  for (const a of addresses) {
    await wait();
    try {
      for (const p of parseClearinghouseState(await hlInfo({ type: "clearinghouseState", user: a }, 12_000, { lane: "background" }))) {
        if (!wanted.has(p.coin)) continue;
        if (!positions.has(p.coin)) positions.set(p.coin, []);
        positions.get(p.coin)!.push({ szi: p.szi, liquidationPx: p.liquidationPx });
        if (!holders.has(p.coin)) holders.set(p.coin, new Set());
        holders.get(p.coin)!.add(a);
      }
      status.accounts++;
      failedInARow = 0;
    } catch {
      status.failed++;
      // A venue that has stopped answering: three hundred timeouts would hold the run, and the next hour's, for an hour.
      if (++failedInARow >= LIQ_GIVE_UP_AFTER) {
        status.error = `Hyperliquid stopped answering after ${status.accounts} accounts; the map is from those.`;
        break;
      }
    }
    onProgress?.(++done, addresses.length);
  }
  // Only with something to place: an empty leaderboard asks nothing more of the venue.
  const mids = midsNow && positions.size ? await midsNow().catch(() => null) : null;
  for (const [coin, list] of Array.from(positions)) byCoin.set(coin, liqMapOf(mids?.get(coin) ?? wanted.get(coin)!, list, holders.get(coin)?.size ?? 0));
  return { status, byCoin };
}
