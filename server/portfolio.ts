/**
 * The portfolio's reads: every address the owner follows, read from its
 * source without a key, put together in shared/portfolio.ts, and kept a
 * minute so a page that re-renders does not read the chain again. One
 * address failing is one line in `errors`; the rest still show.
 *
 * Hosts are overridable (HYPERLIQUID_BASE, PORTFOLIO_EVM_BASE,
 * SOLANA_RPC, LLAMA_BASE) so the tests can stand a fake in for each.
 */
import { createHash } from "node:crypto";
import { fetch as undiciFetch } from "undici";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { egressFor } from "./egress";
import { hlInfo, HlHttpError } from "./hyperliquid";
import { portfolioStore } from "./storage";
import { adminOnly } from "./admin";
import {
  EVM_CHAINS,
  parseAccountValue,
  parseEvmNative,
  parseEvmTokens,
  parseLlamaPrices,
  parseSolBalance,
  parseSplBalances,
  parseSpotBalances,
  parseVaultDetails,
  parseVaultEquities,
  positionKey,
  spotPrices,
  totalsOf,
  validAddress,
  withCost,
  withOwnPnl,
  type AddressKind,
  type PortfolioAddress,
  type PortfolioRead,
  type Position,
  type VaultHolding,
} from "@shared/portfolio";
import { parseClearinghouseState } from "@shared/hyperliquid";

const SOLANA_RPC = (process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com").replace(/\/+$/, "");
const LLAMA = (process.env.LLAMA_BASE || "https://coins.llama.fi").replace(/\/+$/, "");
/** In tests every chain is one fake host, told apart by a ?chain= parameter. */
const EVM_BASE = process.env.PORTFOLIO_EVM_BASE?.replace(/\/+$/, "") || null;

const CACHE_MS = 60_000;
const SNAPSHOT_EVERY_MS = 60 * 60_000;

async function getJson(url: string, init: { method?: string; body?: unknown } = {}, timeoutMs = 15_000): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await undiciFetch(url, {
      method: init.method ?? "GET",
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: ctl.signal,
      dispatcher: egressFor(url),
    } as any);
    if (!res.ok) throw new Error(`${new URL(url).host} → HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const evmUrl = (chain: (typeof EVM_CHAINS)[number], path: string) => (EVM_BASE ? `${EVM_BASE}${path}${path.includes("?") ? "&" : "?"}chain=${chain.id}` : `${chain.host}${path}`);

/* ------------------------------- one address ------------------------------- */

type Part = { positions: Position[]; vaults: VaultHolding[]; accounts: PortfolioRead["accounts"]; errors: PortfolioRead["errors"] };

/**
 * The last answer the venue gave to each question, kept for a day. When a
 * read is refused — a rate limit, a timeout — the page shows the earlier
 * answer with a note saying how old it is, instead of a wallet at $0.
 */
const lastGood = new Map<string, { at: number; value: unknown }>();
const KEEP_MS = 24 * 60 * 60_000;

/** Any read, with the last answer standing in when this one fails. Every source goes through here, so one chain down for an hour is a note, not a hole in the total. */
async function kept<T>(key: string, where: string, a: PortfolioAddress, out: Part, read: () => Promise<T>): Promise<T> {
  try {
    const value = await read();
    lastGood.set(key, { at: Date.now(), value });
    return value;
  } catch (err: any) {
    const was = lastGood.get(key);
    const limited = err instanceof HlHttpError && err.status === 429;
    const why = limited ? "Hyperliquid is limiting requests from the server" : String(err?.message ?? err);
    if (was && Date.now() - was.at < KEEP_MS) {
      const mins = Math.max(1, Math.round((Date.now() - was.at) / 60_000));
      out.errors.push({ address: a.address, where, message: `${why}; showing the read from ${mins} min ago`, stale: true });
      return was.value as T;
    }
    throw new Error(limited ? `${why}. Try Refresh in a minute.` : why);
  }
}

const hlKept = (body: Record<string, unknown>, where: string, a: PortfolioAddress, out: Part): Promise<unknown> => kept(JSON.stringify(body), where, a, out, () => hlInfo(body));

async function readHyperliquid(a: PortfolioAddress, costs: Map<string, number>, prices: () => Promise<Map<string, number>>): Promise<Part> {
  const out: Part = { positions: [], vaults: [], accounts: [], errors: [] };
  const user = a.address.toLowerCase();
  const [state, spot, equities] = await Promise.allSettled([
    hlKept({ type: "clearinghouseState", user }, "Hyperliquid perps", a, out),
    hlKept({ type: "spotClearinghouseState", user }, "Hyperliquid spot", a, out),
    hlKept({ type: "userVaultEquities", user }, "Hyperliquid vaults", a, out),
  ]);
  if (state.status === "fulfilled") {
    const acct = parseAccountValue(state.value);
    out.accounts.push({ address: a.address, label: a.label, ...acct });
    const mids = (await hlInfo({ type: "allMids" }).catch(() => ({}))) as Record<string, string>;
    for (const p of parseClearinghouseState(state.value)) {
      const mark = Number(mids[p.coin]);
      const price = Number.isFinite(mark) && mark > 0 ? mark : null;
      const notional = price != null ? Math.abs(p.szi) * price : Math.abs(p.szi) * p.entryPx;
      out.positions.push({
        key: positionKey("hyperliquid", a.address, "perp", p.coin),
        source: "hl-perp",
        chain: "Hyperliquid perp",
        address: a.address,
        label: a.label,
        asset: p.coin,
        amount: p.szi,
        price,
        value: notional,
        cost: null,
        costFrom: null,
        pnl: p.unrealizedPnl,
        pnlPct: p.entryPx > 0 ? p.unrealizedPnl / (Math.abs(p.szi) * p.entryPx) : null,
        entryPx: p.entryPx,
        liquidationPx: p.liquidationPx,
        leverage: p.leverage || null,
        margin: p.leverage ? notional / p.leverage : null,
      });
    }
  } else out.errors.push({ address: a.address, where: "Hyperliquid perps", message: String(state.reason?.message ?? state.reason) });

  if (spot.status === "fulfilled") {
    const balances = parseSpotBalances(spot.value);
    const px = balances.some((b) => b.coin !== "USDC") ? await prices() : new Map([["USDC", 1]]);
    for (const b of balances) {
      const price = px.get(b.coin) ?? null;
      const key = positionKey("hyperliquid", a.address, "spot", b.coin);
      const base: Position = {
        key,
        source: "hl-spot",
        chain: "Hyperliquid spot",
        address: a.address,
        label: a.label,
        asset: b.coin,
        amount: b.total,
        price,
        value: price != null ? b.total * price : null,
        cost: null,
        costFrom: null,
        pnl: null,
        pnlPct: null,
      };
      // The venue's cost when it has one (USDC has none worth showing); the owner's otherwise.
      const own = costs.get(key);
      out.positions.push(own != null ? withCost(base, own, "owner") : b.coin !== "USDC" && b.entryNtl != null && b.entryNtl > 0 ? withCost(base, b.entryNtl, "venue") : base);
    }
  } else out.errors.push({ address: a.address, where: "Hyperliquid spot", message: String(spot.reason?.message ?? spot.reason) });

  if (equities.status === "fulfilled") {
    for (const v of parseVaultEquities(equities.value)) {
      try {
        const d = parseVaultDetails(await hlKept({ type: "vaultDetails", vaultAddress: v.vaultAddress, user }, `vault ${v.vaultAddress.slice(0, 8)}…`, a, out));
        out.vaults.push({
          key: positionKey("hyperliquid", a.address, "vault", v.vaultAddress),
          vaultAddress: v.vaultAddress,
          name: d?.name ?? v.vaultAddress,
          address: a.address,
          label: a.label,
          equity: d?.equity ?? v.equity,
          pnl: d?.pnl ?? null,
          allTimePnl: d?.allTimePnl ?? null,
          daysFollowing: d?.daysFollowing ?? null,
          enteredAt: d?.enteredAt ?? null,
          lockedUntil: d?.lockedUntil ?? v.lockedUntil,
          apr: d?.apr ?? null,
          history: d?.history ?? [],
        });
      } catch (err: any) {
        out.vaults.push({ key: positionKey("hyperliquid", a.address, "vault", v.vaultAddress), vaultAddress: v.vaultAddress, name: v.vaultAddress, address: a.address, label: a.label, equity: v.equity, pnl: null, allTimePnl: null, daysFollowing: null, enteredAt: null, lockedUntil: v.lockedUntil, apr: null, history: [] });
        out.errors.push({ address: a.address, where: `vault ${v.vaultAddress.slice(0, 8)}…`, message: String(err?.message ?? err) });
      }
    }
  } else out.errors.push({ address: a.address, where: "Hyperliquid vaults", message: String(equities.reason?.message ?? equities.reason) });
  return out;
}

async function readEvm(a: PortfolioAddress, costs: Map<string, number>): Promise<Part> {
  const out: Part = { positions: [], vaults: [], accounts: [], errors: [] };
  await Promise.all(
    EVM_CHAINS.map(async (chain) => {
      try {
        const [native, tokens] = await kept(`evm:${a.address}:${chain.id}`, chain.name, a, out, () =>
          Promise.all([getJson(evmUrl(chain, `/api/v2/addresses/${a.address}`)).catch((e) => (String(e?.message).includes("404") ? {} : Promise.reject(e))), getJson(evmUrl(chain, `/api/v2/addresses/${a.address}/token-balances`)).catch((e) => (String(e?.message).includes("404") ? [] : Promise.reject(e)))]),
        );
        const n = parseEvmNative(native);
        const rows: { asset: string; id: string; amount: number; price: number | null }[] = [];
        if (n.amount > 0) rows.push({ asset: chain.native, id: "native", amount: n.amount, price: n.price });
        for (const t of parseEvmTokens(tokens)) rows.push({ asset: t.symbol, id: t.contract, amount: t.amount, price: t.price });
        for (const r of rows) {
          const key = positionKey("evm", a.address, chain.id, r.id);
          const base: Position = { key, source: "evm", chain: chain.name, address: a.address, label: a.label, asset: r.asset, amount: r.amount, price: r.price, value: r.price != null ? r.amount * r.price : null, cost: null, costFrom: null, pnl: null, pnlPct: null };
          const own = costs.get(key);
          out.positions.push(own != null ? withCost(base, own, "owner") : base);
        }
      } catch (err: any) {
        out.errors.push({ address: a.address, where: chain.name, message: String(err?.message ?? err) });
      }
    }),
  );
  return out;
}

async function readSolana(a: PortfolioAddress, costs: Map<string, number>): Promise<Part> {
  const out: Part = { positions: [], vaults: [], accounts: [], errors: [] };
  try {
    const rpc = (method: string, params: unknown[]) => getJson(SOLANA_RPC, { method: "POST", body: { jsonrpc: "2.0", id: 1, method, params } });
    const [bal, spl] = await kept(`solana:${a.address}`, "Solana", a, out, () =>
      Promise.all([
        rpc("getBalance", [a.address]),
        rpc("getTokenAccountsByOwner", [a.address, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }]),
      ]),
    );
    const sol = parseSolBalance(bal);
    const tokens = parseSplBalances(spl);
    const ids = ["coingecko:solana", ...tokens.map((t) => `solana:${t.mint}`)];
    const prices = new Map<string, { price: number; symbol: string | null }>();
    for (let i = 0; i < ids.length; i += 80) {
      const batch = ids.slice(i, i + 80);
      // A price read that fails is an error on the read, with the last prices standing in when there are some:
      // swallowed, every Solana holding read as worth nothing and the hourly chart recorded the dip.
      const raw = await kept(`llama:${batch.join(",")}`, "Solana prices", a, out, () => getJson(`${LLAMA}/prices/current/${batch.join(",")}`)).catch((err: any) => {
        out.errors.push({ address: a.address, where: "Solana prices", message: String(err?.message ?? err) });
        return {};
      });
      parseLlamaPrices(raw).forEach((v, k) => prices.set(k, v));
    }
    const rows = [
      ...(sol > 0 ? [{ id: "native", asset: "SOL", amount: sol, price: prices.get("coingecko:solana")?.price ?? null }] : []),
      ...tokens.map((t) => {
        const p = prices.get(`solana:${t.mint}`);
        return { id: t.mint, asset: p?.symbol ?? `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`, amount: t.amount, price: p?.price ?? null };
      }),
    ];
    for (const r of rows) {
      const key = positionKey("solana", a.address, "solana", r.id);
      const base: Position = { key, source: "solana", chain: "Solana", address: a.address, label: a.label, asset: r.asset, amount: r.amount, price: r.price, value: r.price != null ? r.amount * r.price : null, cost: null, costFrom: null, pnl: null, pnlPct: null };
      const own = costs.get(key);
      out.positions.push(own != null ? withCost(base, own, "owner") : base);
    }
  } catch (err: any) {
    out.errors.push({ address: a.address, where: "Solana", message: String(err?.message ?? err) });
  }
  return out;
}

/* ------------------------------- the whole ------------------------------- */

const cache = new Map<number, { at: number; read: PortfolioRead }>();

export function forgetPortfolio(userId: number): void {
  cache.delete(userId);
}

/**
 * What a total is a total of: the addresses followed and the rows hidden.
 * Two snapshots with the same answer differ by the market; with different
 * ones, by a wallet added or a holding hidden, which is not a gain or a loss.
 */
export const compositionOf = (r: Pick<PortfolioRead, "addresses" | "hidden">): string =>
  createHash("sha1")
    .update(JSON.stringify([r.addresses.map((a) => `${a.kind}:${a.address}`).sort(), [...r.hidden].sort()]))
    .digest("hex")
    .slice(0, 12);

/**
 * The change over the last day: against the snapshot nearest 24 hours back
 * (within 12 hours of it), and only when it is a total of the same things.
 */
export function dayChange(now: { value: number; sig: string }, history: { at: string; value: number; sig: string | null }[], nowMs = Date.now()): { change: number | null; why: string | null } {
  const target = nowMs - 24 * 3600_000;
  const near = history
    .map((h) => ({ ...h, gap: Math.abs(new Date(h.at).getTime() - target) }))
    .filter((h) => h.gap <= 12 * 3600_000 && new Date(h.at).getTime() <= nowMs - 12 * 3600_000)
    .sort((a, b) => a.gap - b.gap)[0];
  if (!near) return { change: null, why: "24h change once a day of snapshots exists" };
  if (near.sig && near.sig !== now.sig) return { change: null, why: "no 24h change: an address or a hidden row changed since yesterday" };
  return { change: now.value - near.value, why: null };
}

export async function readPortfolio(userId: number, opts: { fresh?: boolean } = {}): Promise<PortfolioRead> {
  const hit = cache.get(userId);
  if (hit && !opts.fresh && Date.now() - hit.at < CACHE_MS) return hit.read;
  const [rows, costs, hidden, pnls] = await Promise.all([portfolioStore.addresses(userId), portfolioStore.costs(userId), portfolioStore.hidden(userId), portfolioStore.pnls(userId)]);
  const addresses: PortfolioAddress[] = rows.map((r) => ({ id: r.id, kind: r.kind as AddressKind, address: r.address, label: r.label }));
  // Spot prices are read once per portfolio, and only when a Hyperliquid spot balance needs them.
  let spot: Promise<Map<string, number>> | null = null;
  // The same rule as the balances: the last prices stand in for a refused read, and with none to stand in it is an error, not silence.
  const priceNotes: Part = { positions: [], vaults: [], accounts: [], errors: [] };
  const firstHl = addresses.find((a) => a.kind === "hyperliquid");
  const prices = () =>
    (spot ??= kept("hl:spotMeta", "Hyperliquid spot prices", firstHl ?? addresses[0], priceNotes, () => hlInfo({ type: "spotMetaAndAssetCtxs" }))
      .then(spotPrices)
      .catch((err: any) => {
        priceNotes.errors.push({ address: (firstHl ?? addresses[0]).address, where: "Hyperliquid spot prices", message: String(err?.message ?? err) });
        return new Map([["USDC", 1]]);
      }));
  const parts = await Promise.all(
    addresses.map((a) => (a.kind === "hyperliquid" ? readHyperliquid(a, costs, prices) : a.kind === "evm" ? readEvm(a, costs) : readSolana(a, costs))),
  );
  // The owner's own P&L, where typed in, over the source's; never on an open perp.
  const positions = parts.flatMap((p) => p.positions).map((p) => (p.source !== "hl-perp" && pnls.has(p.key) ? withOwnPnl(p, pnls.get(p.key)!, p.value) : p));
  const vaults = parts.flatMap((p) => p.vaults).map((v) => (pnls.has(v.key) ? withOwnPnl(v, pnls.get(v.key)!, v.equity) : v));
  const accounts = parts.flatMap((p) => p.accounts);
  const read: PortfolioRead = {
    at: new Date().toISOString(),
    addresses,
    positions,
    vaults,
    accounts,
    // What the owner hid is not counted; dust is, being real if small.
    totals: totalsOf({ positions: positions.filter((p) => !hidden.has(p.key)), vaults: vaults.filter((v) => !hidden.has(v.key)), accounts }),
    hidden: Array.from(hidden),
    errors: [...parts.flatMap((p) => p.errors), ...priceNotes.errors],
  };
  cache.set(userId, { at: Date.now(), read });
  // The value over time: a row an hour at most, from whichever read comes first —
  // and only from a whole read: a wallet that could not be read would chart as a drop to zero.
  if (addresses.length && read.errors.every((e) => e.stale)) {
    const last = await portfolioStore.lastSnapshotAt(userId);
    if (!last || Date.now() - new Date(last).getTime() >= SNAPSHOT_EVERY_MS) {
      await portfolioStore.snapshot(userId, read.at, read.totals.value, read.totals.pnl, JSON.stringify({ ...read.totals.byKind, sig: compositionOf(read) })).catch(() => {});
    }
  }
  return read;
}

/* ------------------------------- the routes ------------------------------- */

const addSchema = z.object({ kind: z.enum(["hyperliquid", "evm", "solana"]), address: z.string().trim().min(1).max(64), label: z.string().trim().max(40).optional().nullable() });

export function registerPortfolioRoutes(app: Express): void {
  app.use("/api/portfolio", adminOnly);
  const uid = (req: Request) => req.userId!;

  app.get("/api/portfolio", async (req: Request, res: Response) => {
    const read = await readPortfolio(uid(req), { fresh: req.query.fresh === "1" });
    const since = new Date(Date.now() - 90 * 86400_000).toISOString();
    const history = await portfolioStore.history(uid(req), since);
    const day = dayChange({ value: read.totals.value, sig: compositionOf(read) }, history);
    res.json({ ...read, history: history.map(({ at, value, pnl }) => ({ at, value, pnl })), change24: day.change, change24Why: day.why });
  });

  app.post("/api/portfolio/addresses", async (req: Request, res: Response) => {
    const body = addSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "Invalid address", issues: body.error.issues });
    const { kind, address, label } = body.data;
    if (!validAddress(kind, address)) return res.status(400).json({ message: kind === "solana" ? "That is not a Solana address." : "That is not a 0x address of 40 hex characters." });
    const made = await portfolioStore.addAddress(uid(req), kind, kind === "solana" ? address : address.toLowerCase(), label || null);
    if (!made) return res.status(409).json({ message: "Already followed." });
    forgetPortfolio(uid(req));
    res.status(201).json(made);
  });

  app.patch("/api/portfolio/addresses/:id", async (req: Request, res: Response) => {
    const label = z.object({ label: z.string().trim().max(40).nullable() }).safeParse(req.body);
    if (!label.success) return res.status(400).json({ message: "Invalid label" });
    await portfolioStore.updateLabel(uid(req), Number(req.params.id), label.data.label || null);
    forgetPortfolio(uid(req));
    res.json({ ok: true });
  });

  app.delete("/api/portfolio/addresses/:id", async (req: Request, res: Response) => {
    await portfolioStore.removeAddress(uid(req), Number(req.params.id));
    forgetPortfolio(uid(req));
    res.json({ ok: true });
  });

  /** Hide a holding or a vault from the page and the totals, or show it again. Open perps are not hidden: they are risk on. */
  app.put("/api/portfolio/hidden", async (req: Request, res: Response) => {
    const body = z.object({ key: z.string().min(3).max(200), hidden: z.boolean() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "Invalid request" });
    if (body.data.key.includes(":perp:")) return res.status(400).json({ message: "An open perp is not hidden." });
    await portfolioStore.setHidden(uid(req), body.data.key, body.data.hidden);
    forgetPortfolio(uid(req));
    res.json({ ok: true });
  });

  /** The owner's own P&L for a holding or a vault; null goes back to the source's. */
  app.put("/api/portfolio/pnl", async (req: Request, res: Response) => {
    const body = z.object({ key: z.string().min(3).max(200), pnl: z.number().finite().nullable() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "Invalid P&L" });
    if (body.data.key.includes(":perp:")) return res.status(400).json({ message: "An open perp's P&L is the venue's live figure." });
    await portfolioStore.setPnl(uid(req), body.data.key, body.data.pnl);
    forgetPortfolio(uid(req));
    res.json({ ok: true });
  });

  /** What a wallet token cost, entered by the owner; null clears it. */
  app.put("/api/portfolio/cost", async (req: Request, res: Response) => {
    const body = z.object({ key: z.string().min(3).max(200), cost: z.number().nonnegative().nullable() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "Invalid cost" });
    await portfolioStore.setCost(uid(req), body.data.key, body.data.cost);
    forgetPortfolio(uid(req));
    res.json({ ok: true });
  });
}
