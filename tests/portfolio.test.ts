import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import {
  parseEvmNative,
  parseEvmTokens,
  parseLlamaPrices,
  parseSolBalance,
  parseSplBalances,
  parseSpotBalances,
  parseVaultDetails,
  parseVaultEquities,
  spotPrices,
  totalsOf,
  validAddress,
  withCost,
} from "../shared/portfolio";

/**
 * The portfolio: each source's answer read the way the venue shapes it,
 * the totals, and the routes against one fake standing in for Hyperliquid,
 * Blockscout, the Solana RPC and DefiLlama — owner-only, an address that
 * fails is a line in the errors and the rest still shows.
 */
const HL = "0x" + "ab".repeat(20);
const VAULT = "0x" + "cd".repeat(20);
const EVM = "0x" + "ef".repeat(20);
const SOL = "So1anaWa11etAddre55xxxxxxxxxxxxxxxxxxxxxxx".slice(0, 43).replace(/[0OIl]/g, "x");
const MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

const vaultDetails = {
  name: "Growi HF",
  vaultAddress: VAULT,
  apr: 0.42,
  portfolio: [["month", { accountValueHistory: [[1, "1000000"], [2, "1100000"], [3, "1200000"]], pnlHistory: [] }]],
  followerState: { user: HL, vaultEquity: "12500.5", pnl: "2500.5", allTimePnl: "3100", daysFollowing: 40, vaultEntryTime: 1700000000000, lockupUntil: 1700345600000 },
};

describe("reading each source", () => {
  it("Hyperliquid vaults, spot and prices", () => {
    expect(parseVaultEquities([{ vaultAddress: VAULT.toUpperCase().replace("0X", "0x"), equity: "12500.5" }, { vaultAddress: "junk" }])).toEqual([{ vaultAddress: VAULT, equity: 12500.5, lockedUntil: null }]);
    expect(parseVaultDetails(vaultDetails)).toMatchObject({ name: "Growi HF", apr: 0.42, equity: 12500.5, pnl: 2500.5, allTimePnl: 3100, daysFollowing: 40, history: [[1, 1000000], [2, 1100000], [3, 1200000]] });
    expect(parseSpotBalances({ balances: [{ coin: "HYPE", total: "100", entryNtl: "2500" }, { coin: "PURR", total: "0", entryNtl: "0" }, { coin: "USDC", total: "50.5", entryNtl: "0" }] })).toEqual([
      { coin: "HYPE", total: 100, entryNtl: 2500 },
      { coin: "USDC", total: 50.5, entryNtl: 0 },
    ]);
    const px = spotPrices([
      { tokens: [{ name: "USDC", index: 0 }, { name: "PURR", index: 1 }, { name: "HYPE", index: 150 }], universe: [{ name: "PURR/USDC", tokens: [1, 0], index: 0 }, { name: "@107", tokens: [150, 0], index: 107 }] },
      [{ coin: "PURR/USDC", midPx: "0.2" }, { coin: "@107", midPx: "31.5" }],
    ]);
    expect(px.get("HYPE")).toBe(31.5);
    expect(px.get("PURR")).toBe(0.2);
    expect(px.get("USDC")).toBe(1);
  });

  it("EVM balances with prices, junk without", () => {
    expect(parseEvmNative({ coin_balance: "1500000000000000000", exchange_rate: "3000" })).toEqual({ amount: 1.5, price: 3000 });
    const t = parseEvmTokens([
      { token: { address_hash: "0xAAA", symbol: "USDC", decimals: "6", exchange_rate: "1", type: "ERC-20" }, value: "2500000000" },
      { token: { address_hash: "0xBBB", symbol: "SCAM", decimals: "18", exchange_rate: null, type: "ERC-20" }, value: "1000000000000000000000" },
      { token: { address_hash: "0xCCC", symbol: "NFT", type: "ERC-721" }, value: "1" },
    ]);
    expect(t).toEqual([
      { contract: "0xaaa", symbol: "USDC", amount: 2500, price: 1 },
      { contract: "0xbbb", symbol: "SCAM", amount: 1000, price: null },
    ]);
  });

  it("Solana balances and DefiLlama prices", () => {
    expect(parseSolBalance({ result: { value: 2_500_000_000 } })).toBe(2.5);
    const spl = parseSplBalances({ result: { value: [{ account: { data: { parsed: { info: { mint: MINT, tokenAmount: { uiAmount: 400 } } } } } }, { account: { data: { parsed: { info: { mint: MINT, tokenAmount: { uiAmount: 100 } } } } } }] } });
    expect(spl).toEqual([{ mint: MINT, amount: 500 }]);
    expect(parseLlamaPrices({ coins: { [`solana:${MINT}`]: { price: 0.8, symbol: "JUP" } } }).get(`solana:${MINT}`)).toEqual({ price: 0.8, symbol: "JUP" });
  });

  it("totals: vault equity, HL account value (perp P&L inside it), spot and wallets; P&L only where a source states it", () => {
    const pos = (o: any) => ({ key: o.asset, chain: "", address: "a", label: null, cost: null, costFrom: null, pnl: null, pnlPct: null, price: null, ...o });
    const read = {
      vaults: [{ equity: 12500, pnl: 2500 } as any],
      accounts: [{ address: HL, label: null, accountValue: 5000, withdrawable: 2000 }],
      positions: [
        pos({ source: "hl-perp", asset: "BTC", amount: 0.1, value: 10000, pnl: 300 }),
        withCost(pos({ source: "hl-spot", asset: "HYPE", amount: 100, value: 3150 }), 2500, "venue"),
        pos({ source: "evm", asset: "ETH", amount: 1.5, value: 4500 }),
      ],
    };
    const t = totalsOf(read);
    // 12,500 vault + 5,000 account (the perp's notional is not added) + 3,150 spot + 4,500 wallet
    expect(t.value).toBe(25150);
    // 2,500 vault + 300 perp + 650 spot; the wallet ETH has no cost, so no P&L
    expect(t.pnl).toBe(3450);
    expect(t.valueWithCost).toBe(12500 + 3150);
    expect(validAddress("evm", EVM)).toBe(true);
    expect(validAddress("evm", "0x123")).toBe(false);
    expect(validAddress("solana", MINT)).toBe(true);
  });
});

/* ------------------------------- the routes ------------------------------- */

const DB = process.env.DATABASE_URL;
let fake: Server;
let app: Server;
let base = "";
let failBase = false;
/** Hyperliquid refusing every wallet read with a rate limit, and how often it was asked. */
let limitHl = false;
let limitedAsks = 0;

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
          if (limitHl && q.type !== "allMids" && q.type !== "spotMetaAndAssetCtxs") {
            limitedAsks++;
            return json({ error: "rate limited" }, 429);
          }
          switch (q.type) {
            case "clearinghouseState":
              return json({ marginSummary: { accountValue: "5000" }, withdrawable: "2000", assetPositions: [{ position: { coin: "BTC", szi: "0.1", entryPx: "97000", liquidationPx: "80000", unrealizedPnl: "300", leverage: { type: "cross", value: 5 } } }] });
            case "spotClearinghouseState":
              return json({ balances: [{ coin: "HYPE", token: 150, total: "100", hold: "0", entryNtl: "2500" }, { coin: "USDC", token: 0, total: "50", hold: "0", entryNtl: "0" }] });
            case "userVaultEquities":
              return json([{ vaultAddress: VAULT, equity: "12500.5" }]);
            case "vaultDetails":
              return json(vaultDetails);
            case "allMids":
              return json({ BTC: "100000" });
            case "spotMetaAndAssetCtxs":
              return json([{ tokens: [{ name: "USDC", index: 0 }, { name: "HYPE", index: 150 }], universe: [{ name: "@107", tokens: [150, 0], index: 107 }] }, [{ coin: "@107", midPx: "31.5" }]]);
            default:
              return json([]);
          }
        }
        if (u.pathname.startsWith("/api/v2/addresses/")) {
          const chain = u.searchParams.get("chain");
          if (chain === "base" && failBase) return json({ message: "boom" }, 500);
          if (chain !== "eth" && chain !== "base") return json({ message: "Not found" }, 404);
          if (u.pathname.endsWith("/token-balances")) {
            return json(chain === "eth" ? [{ token: { address_hash: "0xAAA", symbol: "USDC", decimals: "6", exchange_rate: "1", type: "ERC-20" }, value: "2500000000" }, { token: { address_hash: "0xBBB", symbol: "SCAM", decimals: "18", exchange_rate: null, type: "ERC-20" }, value: "1000000000000000000000" }] : []);
          }
          return json({ coin_balance: chain === "eth" ? "1500000000000000000" : "0", exchange_rate: "3000" });
        }
        if (u.pathname === "/solana") {
          const q = JSON.parse(body || "{}");
          if (q.method === "getBalance") return json({ result: { value: 2_000_000_000 } });
          return json({ result: { value: [{ account: { data: { parsed: { info: { mint: MINT, tokenAmount: { uiAmount: 500 } } } } } }] } });
        }
        if (u.pathname.startsWith("/llama/prices/current/")) return json({ coins: { "coingecko:solana": { price: 150, symbol: "SOL" }, [`solana:${MINT}`]: { price: 0.8, symbol: "JUP" } } });
        return json({}, 404);
      });
    });
    fake.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(fake.address() as any).port}`));
  });
}

beforeAll(async () => {
  if (!DB) return;
  const f = await startFake();
  process.env.HYPERLIQUID_BASE = f;
  process.env.PORTFOLIO_EVM_BASE = f;
  process.env.SOLANA_RPC = `${f}/solana`;
  process.env.LLAMA_BASE = `${f}/llama`;
  const { initSchema, accounts } = await import("../server/storage");
  const { registerRoutes } = await import("../server/routes");
  await initSchema();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const me = await accounts.create({ googleSub: `pf-${stamp}`, email: `pf-${stamp}@x.test` });
  const ex = express();
  ex.use(express.json());
  ex.use((req, _res, next) => {
    (req as any).userId = me.id;
    (req as any).account = { id: me.id, email: me.email, isOwner: req.headers["x-not-owner"] !== "1" };
    next();
  });
  app = createServer(ex);
  await registerRoutes(app, ex);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as any).port}`;
}, 60_000);

afterAll(async () => {
  if (app) await new Promise((r) => app.close(r));
  if (fake) await new Promise((r) => fake.close(r));
});

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

describe.skipIf(!DB)("the portfolio", () => {
  it("does not exist for anyone but the owner", async () => {
    expect((await send("GET", "/api/portfolio", undefined, { "x-not-owner": "1" })).status).toBe(404);
  });

  it("follows addresses, refuses a malformed one and a repeat", async () => {
    expect((await send("POST", "/api/portfolio/addresses", { kind: "evm", address: "0x123" })).status).toBe(400);
    expect((await send("POST", "/api/portfolio/addresses", { kind: "hyperliquid", address: HL.toUpperCase().replace("0X", "0x"), label: "Main" })).status).toBe(201);
    expect((await send("POST", "/api/portfolio/addresses", { kind: "hyperliquid", address: HL })).status).toBe(409);
    expect((await send("POST", "/api/portfolio/addresses", { kind: "evm", address: EVM, label: "Ledger" })).status).toBe(201);
    expect((await send("POST", "/api/portfolio/addresses", { kind: "solana", address: MINT, label: "Phantom" })).status).toBe(201);
  });

  it("reads vaults, perps, spot and wallets with their P&L, and the totals", async () => {
    const p = await (await send("GET", "/api/portfolio?fresh=1")).json();
    expect(p.errors).toEqual([]);
    expect(p.vaults).toMatchObject([{ name: "Growi HF", equity: 12500.5, pnl: 2500.5, allTimePnl: 3100, daysFollowing: 40, apr: 0.42, label: "Main" }]);
    const perp = p.positions.find((x: any) => x.source === "hl-perp");
    expect(perp).toMatchObject({ asset: "BTC", amount: 0.1, entryPx: 97000, price: 100000, value: 10000, pnl: 300, leverage: 5, liquidationPx: 80000 });
    const hype = p.positions.find((x: any) => x.asset === "HYPE");
    expect(hype).toMatchObject({ source: "hl-spot", amount: 100, price: 31.5, value: 3150, cost: 2500, costFrom: "venue", pnl: 650 });
    const eth = p.positions.find((x: any) => x.source === "evm" && x.asset === "ETH");
    expect(eth).toMatchObject({ chain: "Ethereum", amount: 1.5, price: 3000, value: 4500, pnl: null });
    expect(p.positions.find((x: any) => x.asset === "SCAM")).toMatchObject({ value: null });
    expect(p.positions.find((x: any) => x.source === "solana" && x.asset === "SOL")).toMatchObject({ amount: 2, value: 300 });
    expect(p.positions.find((x: any) => x.asset === "JUP")).toMatchObject({ amount: 500, value: 400 });
    // 12,500.5 vault + 5,000 account + 3,150 + 50 spot + 4,500 + 2,500 EVM + 300 + 400 Solana
    expect(p.totals.value).toBeCloseTo(12500.5 + 5000 + 3200 + 7000 + 700, 6);
    expect(p.totals.pnl).toBeCloseTo(2500.5 + 300 + 650, 6);
    expect(p.history.length).toBe(1);
  });

  it("hides a holding or a vault from the totals and shows it again; an open perp is not hidden", async () => {
    const all = 12500.5 + 5000 + 3200 + 7000 + 700;
    const hype = `hyperliquid:${HL}:spot:HYPE`;
    const vault = `hyperliquid:${HL}:vault:${VAULT}`;
    expect((await send("PUT", "/api/portfolio/hidden", { key: hype, hidden: true })).status).toBe(200);
    expect((await send("PUT", "/api/portfolio/hidden", { key: vault, hidden: true })).status).toBe(200);
    expect((await send("PUT", "/api/portfolio/hidden", { key: `hyperliquid:${HL}:perp:BTC`, hidden: true })).status).toBe(400);
    let p = await (await send("GET", "/api/portfolio")).json();
    expect(p.hidden.sort()).toEqual([hype, vault].sort());
    // Still in the read, so the page can show them on request; out of the totals.
    expect(p.positions.some((x: any) => x.key === hype)).toBe(true);
    expect(p.totals.value).toBeCloseTo(all - 3150 - 12500.5, 6);
    expect(p.totals.pnl).toBeCloseTo(300, 6);
    await send("PUT", "/api/portfolio/hidden", { key: hype, hidden: false });
    await send("PUT", "/api/portfolio/hidden", { key: vault, hidden: false });
    p = await (await send("GET", "/api/portfolio")).json();
    expect(p.hidden).toEqual([]);
    expect(p.totals.value).toBeCloseTo(all, 6);
  });

  it("takes the owner's own P&L for a holding or a vault over the source's, into the totals; blank goes back; never a perp", async () => {
    const hype = `hyperliquid:${HL}:spot:HYPE`;
    const vault = `hyperliquid:${HL}:vault:${VAULT}`;
    expect((await send("PUT", "/api/portfolio/pnl", { key: hype, pnl: 1150 })).status).toBe(200);
    expect((await send("PUT", "/api/portfolio/pnl", { key: vault, pnl: -500 })).status).toBe(200);
    expect((await send("PUT", "/api/portfolio/pnl", { key: `hyperliquid:${HL}:perp:BTC`, pnl: 1 })).status).toBe(400);
    let p = await (await send("GET", "/api/portfolio")).json();
    // HYPE is worth 3,150: a P&L of 1,150 means it cost 2,000, so +57.5%.
    expect(p.positions.find((x: any) => x.key === hype)).toMatchObject({ pnl: 1150, pnlFrom: "owner", pnlPct: 0.575 });
    expect(p.vaults[0]).toMatchObject({ pnl: -500, pnlFrom: "owner" });
    expect(p.totals.pnl).toBeCloseTo(-500 + 300 + 1150, 6);
    await send("PUT", "/api/portfolio/pnl", { key: hype, pnl: null });
    await send("PUT", "/api/portfolio/pnl", { key: vault, pnl: null });
    p = await (await send("GET", "/api/portfolio")).json();
    expect(p.positions.find((x: any) => x.key === hype)).toMatchObject({ pnl: 650 });
    expect(p.positions.find((x: any) => x.key === hype).pnlFrom).toBeUndefined();
    expect(p.totals.pnl).toBeCloseTo(2500.5 + 300 + 650, 6);
  });

  it("a rate limit is asked again, then answered with the earlier read and a note, and charts nothing", async () => {
    limitHl = true;
    limitedAsks = 0;
    const p = await (await send("GET", "/api/portfolio?fresh=1")).json();
    limitHl = false;
    // Each of the four wallet questions was tried three times: once, then twice more after a wait.
    expect(limitedAsks).toBe(12);
    expect(p.errors.length).toBe(4);
    for (const e of p.errors) expect(e).toMatchObject({ address: HL, stale: true, message: expect.stringMatching(/limiting requests.*showing the read from \d+ min ago/) });
    expect(p.vaults).toMatchObject([{ name: "Growi HF", equity: 12500.5 }]);
    expect(p.totals.value).toBeCloseTo(12500.5 + 5000 + 3200 + 7000 + 700, 6);
  });

  it("takes a cost for a wallet token and shows its P&L; one chain failing is a line, not the page", async () => {
    const key = `evm:${EVM}:eth:native`;
    expect((await send("PUT", "/api/portfolio/cost", { key, cost: 3000 })).status).toBe(200);
    failBase = true;
    const p = await (await send("GET", "/api/portfolio")).json();
    expect(p.positions.find((x: any) => x.key === key)).toMatchObject({ cost: 3000, costFrom: "owner", pnl: 1500, pnlPct: 0.5 });
    expect(p.errors).toEqual([{ address: EVM, where: "Base", message: expect.stringMatching(/HTTP 500/) }]);
    expect(p.vaults).toHaveLength(1);
    // Cleared, it goes back to no P&L.
    await send("PUT", "/api/portfolio/cost", { key, cost: null });
    const q = await (await send("GET", "/api/portfolio")).json();
    expect(q.positions.find((x: any) => x.key === key).pnl).toBeNull();
    // Stop following: gone from the read.
    const id = q.addresses.find((a: any) => a.kind === "solana").id;
    await send("DELETE", `/api/portfolio/addresses/${id}`);
    const r = await (await send("GET", "/api/portfolio")).json();
    expect(r.positions.some((x: any) => x.source === "solana")).toBe(false);
    failBase = false;
  });
});

describe("dust", () => {
  it("is a spot or wallet holding under $5 or without a price; never a perp", async () => {
    const { isDust } = await import("../shared/portfolio");
    expect(isDust({ source: "evm", value: 4.99 })).toBe(true);
    expect(isDust({ source: "solana", value: null })).toBe(true);
    expect(isDust({ source: "hl-spot", value: 5 })).toBe(false);
    expect(isDust({ source: "hl-perp", value: 1 })).toBe(false);
  });
});
