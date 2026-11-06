import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import {
  binanceSymbolFor,
  deltaRatio,
  findAnomalies,
  flowReadings,
  liqMapOf,
  matchBinance,
  parseFlowKlines,
  parseLeaderboard,
  parsePremiumIndex,
  parseRatio,
} from "../shared/flow";
import { parseAiRead } from "../server/screener-ai";

/**
 * Binance flow through the relay, Hyperliquid's liquidation map, the gaps
 * between the venues, the anomalies a run turns up, and the AI's read of
 * it — the arithmetic by hand, then a whole run against a fake relay
 * answering Binance, a fake leaderboard and a fake Claude.
 */
const HOUR = 3600_000;

describe("the flow arithmetic", () => {
  it("maps Hyperliquid's coins to the Binance contract that is the same coin", () => {
    expect(binanceSymbolFor("SOL")).toBe("SOLUSDT");
    expect(binanceSymbolFor("kPEPE")).toBe("1000PEPEUSDT");
    const premium = new Map([
      ["SOLUSDT", { mark: 151, funding: 0 }],
      ["1000PEPEUSDT", { mark: 0.0102, funding: 0 }],
      ["1000BONKUSDT", { mark: 0.021, funding: 0 }],
      ["PUMPUSDT", { mark: 0.5, funding: 0 }],
    ]);
    expect(matchBinance("SOL", 150, premium)).toEqual({ symbol: "SOLUSDT", scale: 1 });
    expect(matchBinance("kPEPE", 0.01, premium)).toEqual({ symbol: "1000PEPEUSDT", scale: 1 });
    // Listed plainly on Hyperliquid, only per thousand on Binance: matched, and its price scaled.
    expect(matchBinance("BONK", 0.000021, premium)).toEqual({ symbol: "1000BONKUSDT", scale: 1000 });
    // Same ticker, ten times the price: another token.
    expect(matchBinance("PUMP", 0.05, premium)).toBeNull();
    expect(matchBinance("NOPE", 1, premium)).toBeNull();
  });

  it("reads taker delta off klines as a share of volume", () => {
    const k = parseFlowKlines([
      [1, "1", "1", "1", "1", "100", 2, "100", 10, "70", "70", "0"],
      [2, "1", "1", "1", "1", "100", 3, "100", 10, "40", "40", "0"],
      ["x"],
    ]);
    expect(k).toHaveLength(2);
    // (2·70 − 100) + (2·40 − 100) = 40 − 20 = 20, over 200 traded
    expect(deltaRatio(k, 2)).toBeCloseTo(0.1, 12);
    expect(deltaRatio(k, 1)).toBeCloseTo(-0.2, 12);
  });

  it("puts the venues side by side: basis, funding annualised on each venue's own interval", () => {
    const klines = Array.from({ length: 30 }, (_, i) => ({ t: i * HOUR, c: 100 + i, v: 10, buy: 6 }));
    const f = flowReadings({
      symbol: "SOLUSDT",
      klines,
      accounts: parseRatio(Array.from({ length: 30 }, (_, i) => ({ longShortRatio: String(1 + i * 0.1), longAccount: "0.6", timestamp: i * HOUR }))),
      top: [],
      oi: Array.from({ length: 30 }, (_, i) => ({ t: i * HOUR, oi: 1000 + i * 10 })),
      hlMark: 101,
      hlFundingHourly: 0.0001,
      bn: { mark: 100, funding: 0.0001 },
      bnIntervalHours: 4,
    });
    expect(f.basis).toBeCloseTo(0.01, 12);
    expect(f.fundingHl).toBeCloseTo(0.0001 * 24 * 365, 12);
    expect(f.fundingBn).toBeCloseTo(0.0001 * 6 * 365, 12);
    expect(f.fundingSpread).toBeCloseTo(0.0001 * 18 * 365, 12);
    expect(f.cvd24h).toBeCloseTo(0.2, 12);
    expect(f.px24h).toBeCloseTo(129 / 105 - 1, 12);
    expect(f.lsAccounts).toBeCloseTo(3.9, 12);
    expect(f.lsAccounts24h).toBeCloseTo(3.9 / 1.5 - 1, 12);
    expect(f.oi24h).toBeCloseTo(1290 / 1050 - 1, 12);
  });

  it("sums liquidations into bands: longs below the mark, shorts above, the wrong side left out", () => {
    const m = liqMapOf(
      100,
      [
        { szi: 10, liquidationPx: 95 },
        { szi: 5, liquidationPx: 95.2 },
        { szi: -4, liquidationPx: 103 },
        { szi: 2, liquidationPx: 101 }, // a long "liquidating" above the mark: a stale read, out
        { szi: -1, liquidationPx: null },
        { szi: 3, liquidationPx: 60 }, // beyond 25%: out
      ],
      4,
    );
    expect(m.bands.map((b) => [b.at.toFixed(2), b.usd])).toEqual([
      ["-0.05", 1500],
      ["0.03", 400],
    ]);
    expect(m.nearestLong).toMatchObject({ usd: 1500 });
    expect(m.nearestShort?.price).toBeCloseTo(103, 9);
    expect(m.longUsd10).toBe(1500);
    expect(parseLeaderboard({ leaderboardRows: [{ ethAddress: "0x" + "a".repeat(40), accountValue: "5" }, { ethAddress: "0x" + "b".repeat(40), accountValue: "50" }, { ethAddress: "junk" }] }, 1)).toEqual(["0x" + "b".repeat(40)]);
    expect(parsePremiumIndex([{ symbol: "SOLUSDT", markPrice: "150", lastFundingRate: "0.0001" }]).get("SOLUSDT")).toEqual({ mark: 150, funding: 0.0001 });
  });

  it("flags price up on net selling, a funding gap, venues disagreeing, a liquidation magnet", () => {
    const flow = (o: object) => ({ symbol: "X", cvd4h: 0, cvd24h: 0, px24h: 0, lsAccounts: 1.2, lsAccounts24h: 0, lsTop: 1.1, lsTop24h: 0, oi24h: 0, basis: 0, fundingHl: 0.1, fundingBn: 0.1, fundingSpread: 0, cvdSeries: [], lsSeries: [], ...o });
    const quiet = Array.from({ length: 18 }, (_, i) => ({ coin: `Q${i}`, oi24hHl: 0.01 * (i % 5), px24h: 0, flow: flow({ lsAccounts: 1 + i * 0.01 }), liq: null, divergence: null }));
    const a = findAnomalies([
      ...quiet,
      { coin: "SOL", oi24hHl: 0.4, px24h: 0.05, flow: flow({ cvd24h: -0.1, px24h: 0.05, fundingHl: 0.8, fundingBn: 0.1, fundingSpread: 0.7, oi24h: -0.08 }), liq: liqMapOf(100, [{ szi: -50000, liquidationPx: 102 }], 3), divergence: null },
    ]);
    const kinds = a.filter((x) => x.coin === "SOL").map((x) => x.kind).sort();
    expect(kinds).toEqual(["cvd-divergence", "funding-gap", "liq-magnet", "oi-surge", "venues-disagree"]);
    expect(a[0].severity).toBe(3);
    expect(a.filter((x) => x.coin.startsWith("Q"))).toEqual([]);
  });

  it("reads the AI's JSON however it is wrapped, and drops what is not in the shape", () => {
    const r = parseAiRead('Here you go:\n```json\n{"regime":"Alts lead.","tips":[{"coin":"SOL","stance":"moon","horizon":"days","thesis":"t","agree":["a",3],"disagree":[],"invalidation":"i","confidence":"high"},{"stance":"long"}],"anomalies":[{"coin":"X","note":"n"}]}\n```');
    expect(r).toMatchObject({ regime: "Alts lead.", tips: [{ coin: "SOL", stance: "watch", agree: ["a"], confidence: "high" }], anomalies: [{ coin: "X", note: "n" }] });
    expect(parseAiRead("no json here")).toBeNull();
  });
});

/* ------------------------------- a whole run ------------------------------- */

const DB = process.env.DATABASE_URL;
let fake: Server;
let app: Server;
let base = "";
let relay: WebSocket | null = null;
const relayAsked: { path: string; params: any; public: boolean }[] = [];
let claudeAsked: any = null;
const WHALE_A = "0x" + "1".repeat(40);
const WHALE_B = "0x" + "2".repeat(40);

const closeOf = (coin: string, i: number, iv: string) => {
  const base = { BTC: 60000, SOL: 150, ETH: 3000, kPEPE: 0.01, HYPE: 30 }[coin] ?? 1;
  return base * (1 + (iv === "1h" ? (i % 2000) * 0.0001 : (i % 2000) * 0.001));
};

function startFake(): Promise<string> {
  return new Promise((resolve) => {
    fake = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const json = (o: unknown, status = 200) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(o));
        };
        const u = new URL(req.url ?? "/", "http://x");
        if (u.pathname === "/info") {
          const q = JSON.parse(body || "{}");
          if (q.type === "metaAndAssetCtxs") {
            const names = ["BTC", "SOL", "ETH", "kPEPE", "HYPE"];
            const hour = Math.floor(Date.now() / HOUR);
            return json([{ universe: names.map((name) => ({ name, szDecimals: 2 })) }, names.map((n) => ({ funding: "0.0001", openInterest: "1000", dayNtlVlm: "50000000", markPx: String(closeOf(n, hour, "1h")), oraclePx: String(closeOf(n, hour, "1h")) }))]);
          }
          if (q.type === "candleSnapshot") {
            const { coin, interval, startTime, endTime } = q.req;
            const step = interval === "1h" ? HOUR : 24 * HOUR;
            const out = [];
            for (let t = Math.ceil(startTime / step) * step; t <= endTime; t += step) {
              const c = closeOf(coin, Math.floor(t / step), interval);
              out.push({ t, T: t + step - 1, s: coin, i: interval, o: String(c), h: String(c * 1.01), l: String(c * 0.99), c: String(c), v: "100", n: 1 });
            }
            return json(out);
          }
          if (q.type === "clearinghouseState") {
            const sol = closeOf("SOL", Math.floor(Date.now() / HOUR), "1h");
            if (q.user === WHALE_A) return json({ assetPositions: [{ position: { coin: "SOL", szi: "-20000", entryPx: String(sol), liquidationPx: String(sol * 1.02), unrealizedPnl: "0", leverage: { value: 20 } } }] });
            if (q.user === WHALE_B) return json({ assetPositions: [{ position: { coin: "SOL", szi: "8000", entryPx: String(sol), liquidationPx: String(sol * 0.93), unrealizedPnl: "0", leverage: { value: 10 } } }, { position: { coin: "ETH", szi: "100", entryPx: "3000", liquidationPx: "2500", unrealizedPnl: "0", leverage: { value: 5 } } }] });
            return json({ assetPositions: [] });
          }
          return json([]);
        }
        if (u.pathname === "/Mainnet/leaderboard") return json({ leaderboardRows: [{ ethAddress: WHALE_A, accountValue: "9000000" }, { ethAddress: WHALE_B, accountValue: "5000000" }] });
        if (u.pathname === "/v1/messages") {
          claudeAsked = JSON.parse(body || "{}");
          const read = { regime: "Breadth is thin; SOL leads on price but takers are selling into it.", tips: [{ coin: "SOL", stance: "watch", horizon: "1-3 days", thesis: "Relative strength without taker buying.", agree: ["RS up on 4h and 1D"], disagree: ["CVD −20% of volume over 24h", "funding top decile"], invalidation: "A close back under the 4h RS breakout", confidence: "medium" }], anomalies: [{ coin: "SOL", note: "Price up on net selling." }] };
          return json({ id: "msg_1", type: "message", role: "assistant", model: claudeAsked.model, content: [{ type: "text", text: JSON.stringify(read) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
        }
        return json({}, 404);
      });
    });
    fake.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(fake.address() as any).port}`));
  });
}

/** Binance as the relay would read it, by path. SOL rises on net taker selling; ETH is plain; kPEPE is listed as 1000PEPEUSDT; HYPE is not on Binance. */
function binance(path: string, p: any): { status: number; body: unknown } {
  const hourNow = Math.floor(Date.now() / HOUR) * HOUR;
  if (path === "/fapi/v1/premiumIndex")
    return {
      status: 200,
      body: [
        { symbol: "SOLUSDT", markPrice: String(closeOf("SOL", hourNow / HOUR, "1h") / 1.004), lastFundingRate: "0.00001" },
        { symbol: "ETHUSDT", markPrice: String(closeOf("ETH", hourNow / HOUR, "1h")), lastFundingRate: "0.0001" },
        { symbol: "1000PEPEUSDT", markPrice: String(closeOf("kPEPE", hourNow / HOUR, "1h")), lastFundingRate: "0.0001" },
        // A namesake that is another token: HYPE on Binance at a tenth of Hyperliquid's price.
        { symbol: "HYPEUSDT", markPrice: String(closeOf("HYPE", hourNow / HOUR, "1h") / 10), lastFundingRate: "0.0001" },
      ],
    };
  if (path === "/fapi/v1/fundingInfo") return { status: 200, body: [] };
  if (path === "/fapi/v1/klines") {
    const rows = Array.from({ length: p.limit }, (_, i) => {
      const t = hourNow - (p.limit - 1 - i) * HOUR;
      const c = p.symbol === "SOLUSDT" ? 150 * (1 + i * 0.002) : 100;
      const buy = p.symbol === "SOLUSDT" ? 40 : 50;
      return [t, String(c), String(c), String(c), String(c), "100", t + HOUR - 1, "0", 10, String(buy), "0", "0"];
    });
    return { status: 200, body: rows };
  }
  if (path.includes("LongShort")) return { status: 200, body: Array.from({ length: p.limit }, (_, i) => ({ symbol: p.symbol, longShortRatio: path.includes("top") ? "0.8" : "2.4", longAccount: "0.7", timestamp: hourNow - (p.limit - 1 - i) * HOUR })) };
  if (path === "/futures/data/openInterestHist") return { status: 200, body: Array.from({ length: p.limit }, (_, i) => ({ symbol: p.symbol, sumOpenInterest: String(p.symbol === "SOLUSDT" ? 1000 - i * 5 : 1000), sumOpenInterestValue: "1", timestamp: hourNow - (p.limit - 1 - i) * HOUR })) };
  return { status: 400, body: { code: -1121, msg: "Invalid symbol." } };
}

function fakeRelay(token: string, features: string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/relay/ws?token=${encodeURIComponent(token)}`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "hello", env: "live", canTrade: false, keyHint: "relaykey", features }));
      setTimeout(() => resolve(ws), 150);
    });
    ws.on("message", (data) => {
      const m = JSON.parse(String(data));
      if (m.t !== "req") return;
      relayAsked.push({ path: m.path, params: m.params, public: !!m.public });
      const r = binance(m.path, m.params ?? {});
      ws.send(JSON.stringify({ t: "res", id: m.id, status: r.status, body: JSON.stringify(r.body) }));
    });
    ws.on("error", reject);
  });
}

let relayToken = "";

beforeAll(async () => {
  if (!DB) return;
  const f = await startFake();
  process.env.HYPERLIQUID_BASE = f;
  process.env.HL_STATS_BASE = f;
  process.env.ANTHROPIC_BASE_URL = f;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.SCREENER_CLOCK_MS = "0";
  process.env.SCREENER_WEIGHT_PER_MIN = "100000";
  process.env.FLOW_PER_MIN = "100000";
  process.env.LIQ_PER_MIN = "100000";
  const { initSchema, accounts, screenerStore } = await import("../server/storage");
  const { registerRoutes } = await import("../server/routes");
  await initSchema();
  await screenerStore.clearAll();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  // The flow pass reads through the owner's relay: act as the owner.
  const owner = (await accounts.owner()) ?? (await accounts.create({ googleSub: `fl-${stamp}`, email: `fl-${stamp}@x.test`, isOwner: true }));
  const ex = express();
  ex.use(express.json());
  ex.use((req, _res, next) => {
    (req as any).userId = owner.id;
    (req as any).account = { id: owner.id, email: owner.email, isOwner: true };
    next();
  });
  app = createServer(ex);
  await registerRoutes(app, ex);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as any).port}`;
  const r = await fetch(`${base}/api/account-settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Flow relay ${stamp}`, feeMode: "percent", makerFee: 0, takerFee: 0, relay: true }) });
  relayToken = (await r.json()).relayToken;
}, 60_000);

afterAll(async () => {
  relay?.close();
  if (app) {
    app.closeAllConnections?.();
    await new Promise((r) => app.close(r));
  }
  if (fake) await new Promise((r) => fake.close(r));
});

describe.skipIf(!DB)("a run with the flow, the map and the read", () => {
  it("says to update a relay that cannot make public reads", async () => {
    relay = await fakeRelay(relayToken, []);
    const { runScreener } = await import("../server/screener");
    const run = await runScreener({ force: true });
    expect(run.flowStatus).toMatchObject({ source: "none", outdated: true });
    expect(run.flowStatus!.error).toMatch(/older copy/);
    expect(relayAsked).toEqual([]);
    relay.close();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("reads Binance through the relay, maps liquidations, and flags what stands out", async () => {
    relay = await fakeRelay(relayToken, ["public"]);
    const { runScreener } = await import("../server/screener");
    const run = await runScreener({ force: true });
    // Every read went through the relay as a public one.
    expect(relayAsked.length).toBeGreaterThan(5);
    expect(relayAsked.every((a) => a.public)).toBe(true);
    expect(relayAsked.some((a) => a.params?.symbol === "1000PEPEUSDT")).toBe(true);
    expect(run.flowStatus).toMatchObject({ source: "relay", coins: 3, failed: 0 });

    const sol = run.rows.find((r) => r.coin === "SOL")!;
    // 40 of every 100 traded were taker buys: (80 − 100) / 100.
    expect(sol.flow!.cvd24h).toBeCloseTo(-0.2, 9);
    expect(sol.flow!.px24h).toBeGreaterThan(0.02);
    expect(sol.flow!.lsAccounts).toBe(2.4);
    expect(sol.flow!.lsTop).toBe(0.8);
    expect(sol.flow!.basis).toBeCloseTo(0.004, 6);
    expect(sol.signals["1D"].cvd).toBe(-1);
    // HYPE's Binance namesake trades at a tenth of the price: another token, so no flow, and the status says so.
    expect(run.rows.find((r) => r.coin === "HYPE")!.flow).toBeNull();
    expect(run.flowStatus!.mismatched).toEqual(["HYPE"]);

    // The map: the short whale's $3M at +2%, the long whale's at −7%.
    expect(run.liqStatus).toMatchObject({ accounts: 2, failed: 0 });
    expect(sol.liq!.nearestShort!.at).toBeCloseTo(0.02, 9);
    expect(sol.liq!.nearestLong!.at).toBeCloseTo(-0.07, 9);
    expect(sol.liq!.accounts).toBe(2);

    const solA = run.anomalies.filter((a) => a.coin === "SOL").map((a) => a.kind);
    expect(solA).toEqual(expect.arrayContaining(["cvd-divergence", "funding-gap", "whales-vs-crowd", "basis"]));
  });

  it("reads the run with Claude when asked, and stores the answer for the page", async () => {
    const asked = await fetch(`${base}/api/screener/ai`, { method: "POST" });
    expect(asked.status).toBe(200);
    let got: any = null;
    for (let i = 0; i < 40 && !got?.latest; i++) {
      await new Promise((r) => setTimeout(r, 100));
      got = await (await fetch(`${base}/api/screener/ai`)).json();
    }
    expect(got.latest.read.tips[0]).toMatchObject({ coin: "SOL", stance: "watch", confidence: "medium" });
    expect(got.latest.error).toBeNull();
    // What Claude was given: the coin with its Binance flow and the anomalies, nothing else.
    const digest = JSON.parse(claudeAsked.messages[0].content.replace(/^Screener run:\n/, ""));
    expect(digest.coins.find((c: any) => c.coin === "SOL").binance.cvd24h).toBeCloseTo(-0.2, 3);
    expect(digest.anomalies.length).toBeGreaterThan(0);
    expect(claudeAsked.thinking).toEqual({ type: "adaptive" });
    // Asked again at once: refused, the half-hour has not passed.
    expect((await fetch(`${base}/api/screener/ai`, { method: "POST" })).status).toBe(429);
  });
});
