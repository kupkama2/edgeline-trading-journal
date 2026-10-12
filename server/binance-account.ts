/**
 * Reading a Binance Futures account — the half that talks to the venue.
 *
 * Binance has no public-by-address record the way Hyperliquid does; an
 * account's history is behind a key. So the sync holds a key, read-only by
 * rule (shared/binance-account.ts says which permissions are refused), sealed
 * at rest (secrets.ts) and opened only here, for the length of one request.
 *
 * Every signed call builds its query once and signs exactly those bytes:
 * Binance verifies the signature over the query string it receives, so the
 * string signed and the string sent have to be the same object.
 *
 * Hosts are overridable for the same reason the market-data client's are —
 * so the whole path runs against a stub where the venue cannot be reached.
 * In production the futures host is fapi.binance.com, which answers 451 to a
 * US IP: the service is deployed in Frankfurt for exactly this (render.yaml).
 */
import { createHmac } from "node:crypto";
import { fetch as undiciFetch } from "undici";
import {
  baseAssetOf,
  fillsFromUserTrades,
  keyRefusal,
  levelsFromOpenOrders,
  parseOpenOrders,
  parsePositions,
  parseRestrictions,
  parseUserTrades,
  signedQuery,
  symbolsFromIncome,
  type BinanceUserTrade,
  type KeyRestrictions,
} from "@shared/binance-account";
import { tradesFromFills } from "@shared/hyperliquid";
import { egressFor } from "./egress";
import { ensureCatalogue } from "./outcomes";
import { open } from "./secrets";
import { storageFor } from "./storage";
import { emptySync, writeVenueTrades, type AccountSync, type SyncSummary } from "./venue-sync";

const SPOT = (process.env.BINANCE_BASE || "https://api.binance.com").replace(/\/+$/, "");
const FUTURES = (process.env.BINANCE_FUTURES_BASE || "https://fapi.binance.com").replace(/\/+$/, "");

/** How far back the first sync reads closed positions. Open ones are read regardless. */
const LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
/** A thousand fills a page; thirty pages a symbol before it is called too much for one sync. */
const PAGE = 1000;
const MAX_PAGES = 30;

export interface Creds {
  key: string;
  secret: string;
}

async function signedGet(base: string, path: string, params: Record<string, string | number | undefined>, creds: Creds): Promise<unknown> {
  const q = signedQuery(params, Date.now());
  const signature = createHmac("sha256", creds.secret).update(q).digest("hex");
  const url = `${base}${path}?${q}&signature=${signature}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await undiciFetch(url, {
      headers: { "X-MBX-APIKEY": creds.key, accept: "application/json" },
      signal: ctl.signal,
      dispatcher: egressFor(base),
    } as any);
    const host = new URL(base).hostname;
    if (!res.ok) {
      // The venue's own message is the useful part: "-2015 Invalid API-key,
      // IP, or permissions" is a diagnosis, "401" is a shrug.
      let said = "";
      try {
        const j: any = await res.json();
        said = j?.msg ? ` — ${String(j.msg)}` : "";
      } catch {
        /* no body worth reading */
      }
      throw new Error(`${host} → HTTP ${res.status} on ${path}${said}`);
    }
    try {
      return await res.json();
    } catch (err: any) {
      throw new Error(`${host} → unreadable reply on ${path} (${String(err?.message ?? err)})`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ the key ------------------------------ */

/**
 * What a key may do, asked of the venue itself before the key is kept.
 *
 * The permission check is on the spot host; a key with futures reading alone
 * still answers it. Failing to REACH the check is failing the check: a key
 * whose permissions cannot be confirmed is not stored, and the error says
 * which host would not answer so the fix is obvious.
 */
export async function fetchRestrictions(creds: Creds): Promise<KeyRestrictions> {
  return parseRestrictions(await signedGet(SPOT, "/sapi/v1/account/apiRestrictions", {}, creds));
}

export async function verifyKey(creds: Creds): Promise<{ ok: true; restrictions: KeyRestrictions } | { ok: false; reason: string }> {
  let restrictions: KeyRestrictions;
  try {
    restrictions = await fetchRestrictions(creds);
  } catch (err: any) {
    return { ok: false, reason: `Could not confirm what this key may do: ${String(err?.message ?? err)}` };
  }
  const refusal = keyRefusal(restrictions);
  return refusal ? { ok: false, reason: refusal } : { ok: true, restrictions };
}

/* ------------------------------ the reads ------------------------------ */

export async function fetchPositions(creds: Creds) {
  return parsePositions(await signedGet(FUTURES, "/fapi/v2/positionRisk", {}, creds));
}

export async function fetchOpenOrders(creds: Creds) {
  return parseOpenOrders(await signedGet(FUTURES, "/fapi/v1/openOrders", {}, creds));
}

/** Symbols that realised a P&L inside the lookback — the closed trades to go and read. */
export async function fetchClosedSymbols(creds: Creds, since: number): Promise<string[]> {
  const seen = new Set<string>();
  let start = since;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows: any = await signedGet(
      FUTURES,
      "/fapi/v1/income",
      { incomeType: "REALIZED_PNL", startTime: start, limit: PAGE },
      creds,
    );
    for (const s of symbolsFromIncome(rows)) seen.add(s);
    if (!Array.isArray(rows) || rows.length < PAGE) break;
    const last = Number(rows[rows.length - 1]?.time);
    if (!Number.isFinite(last) || last <= start) break;
    start = last + 1;
  }
  return Array.from(seen);
}

/**
 * Every fill on one symbol, walked forward by id.
 *
 * Forward from the first id rather than back from now, because fromId is the
 * one way to page userTrades without the seven-day window the time filters
 * impose. The cost is that a symbol with more history than MAX_PAGES holds is
 * read from the beginning and cut short of the present — and a window that
 * does not reach the present cannot be reconciled with the venue's open
 * position, so the symbol is set aside rather than half-written. `truncated`
 * says so, so the sync can report it instead of swallowing it.
 */
export async function fetchUserTrades(creds: Creds, symbol: string): Promise<{ rows: BinanceUserTrade[]; truncated: boolean }> {
  const rows: BinanceUserTrade[] = [];
  let fromId = 1;
  for (let page = 0; page < MAX_PAGES; page++) {
    const got = parseUserTrades(await signedGet(FUTURES, "/fapi/v1/userTrades", { symbol, fromId, limit: PAGE }, creds));
    rows.push(...got);
    if (got.length < PAGE) return { rows, truncated: false };
    fromId = got[got.length - 1].id + 1;
  }
  return { rows, truncated: true };
}

/* ------------------------------ the sync ------------------------------ */

/**
 * Sync every account of one user that holds a Binance key.
 *
 * The symbols to read are the union of what closed something in the lookback
 * and what is open now: a position opened before the lookback with nothing
 * realised yet would be invisible to the income record and is the one most
 * worth having. Per symbol the fills are reconciled against the venue's open
 * position before anything is reconstructed from them — see
 * fillsFromUserTrades for why — and then written exactly as Hyperliquid's are.
 */
export async function syncBinance(userId: number, onlyAccount?: string): Promise<SyncSummary> {
  const store = storageFor(userId);
  const accounts = (await store.listAccountSettings()).filter(
    (a) => a.binanceKey && a.binanceSecret && (!onlyAccount || a.name === onlyAccount),
  );
  if (accounts.length === 0) {
    return {
      accounts: [],
      message: "No account holds a Binance API key yet — add a read-only one in Settings, next to the account's fees.",
    };
  }

  const cat = await ensureCatalogue().catch(() => []);
  const out: AccountSync[] = [];
  for (const acct of accounts) {
    const row = emptySync(acct.name);
    try {
      const secret = open(acct.binanceSecret);
      if (!secret) {
        throw new Error(
          "The stored key could not be opened — the server's SESSION_SECRET has changed since it was saved. Save the key again.",
        );
      }
      const creds: Creds = { key: acct.binanceKey!, secret };

      const positions = await fetchPositions(creds);
      const closedSymbols = await fetchClosedSymbols(creds, Date.now() - LOOKBACK_MS);
      const openSymbols = Array.from(positions.entries())
        .filter(([, p]) => Math.abs(p.amt) > 1e-9)
        .map(([s]) => s);
      const symbols = Array.from(new Set([...closedSymbols, ...openSymbols]));

      const allRows: BinanceUserTrade[] = [];
      const truncated: string[] = [];
      for (const symbol of symbols) {
        const { rows, truncated: cut } = await fetchUserTrades(creds, symbol);
        if (cut) {
          truncated.push(symbol);
          continue;
        }
        allRows.push(...rows);
      }
      row.fills = allRows.length;

      const { fills, unreconstructable } = fillsFromUserTrades(allRows, positions);
      const read = tradesFromFills(fills, "binance");
      row.unreconstructed =
        unreconstructable.reduce((n, u) => n + u.fills, 0) +
        read.unreconstructed.reduce((n, u) => n + u.fills, 0);
      if (truncated.length) {
        row.error = `More history than one sync reads on ${truncated.join(", ")} — those were left alone.`;
      }

      const orders = await fetchOpenOrders(creds).catch(() => []);
      await writeVenueTrades(store, row, read.trades, {
        symbolOf: (s) => baseAssetOf(s, cat),
        levelsFor: (t) => levelsFromOpenOrders(t, orders),
      });
    } catch (err: any) {
      row.error = String(err?.message ?? err);
    }
    out.push(row);
  }
  return { accounts: out };
}
