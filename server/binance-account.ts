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
import { loggableError } from "./errors";
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
import { marketsSeen, tradesFromFills } from "@shared/hyperliquid";
import { tradingKeyRefusal } from "@shared/terminal";
import { egressFor } from "./egress";
import { ensureCatalogue } from "./outcomes";
import { open } from "./secrets";
import { storageFor } from "./storage";
import { emptySync, writeVenueTrades, type AccountSync, type SyncSummary } from "./venue-sync";

/*
 * The key's permissions are asked of the SPOT host's /sapi API, which is a
 * different service from market data. BINANCE_BASE may point the market
 * reads at a mirror (data-api.binance.vision), which has no /sapi at all, so
 * the account host is its own setting and defaults to the real one.
 */
const SAPI = (process.env.BINANCE_SAPI_BASE || process.env.BINANCE_BASE || "https://api.binance.com").replace(/\/+$/, "");
const FUTURES = (process.env.BINANCE_FUTURES_BASE || "https://fapi.binance.com").replace(/\/+$/, "");
/*
 * The futures testnet is its own venue with its own keys and play money.
 * Overridable because Binance has moved it before (testnet.binancefuture.com
 * → the "demo trading" host); the terminal's status page says which host it
 * is talking to, so a move shows up as a sentence rather than a mystery.
 */
const TESTNET = (process.env.BINANCE_TESTNET_FUTURES_BASE || "https://testnet.binancefuture.com").replace(/\/+$/, "");

export type BinanceEnv = "live" | "testnet";
/** The futures host an account's key belongs to. */
export const futuresBase = (env: string | null | undefined): string => (env === "testnet" ? TESTNET : FUTURES);

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back a sync reads positions that have closed. */
const LOOKBACK_MS = 90 * DAY_MS;
/**
 * How far back it reads a symbol with a position open NOW — further, because
 * the entry of a long-held position is the fill most worth having, and
 * Binance keeps about six months of a symbol's fills.
 */
const OPEN_LOOKBACK_MS = 180 * DAY_MS;
/** Binance caps a time-filtered userTrades or income query at seven days. */
const WINDOW_MS = 7 * DAY_MS;
/** Below this, a window that still comes back full is split no further. */
const MIN_WINDOW_MS = 60 * 60 * 1000;
const PAGE = 1000;

/**
 * A refusal from the venue, with Binance's own code kept: "-2015" or a 429
 * is a diagnosis the sync acts on, not just text to print.
 */
export class BinanceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
  ) {
    super(message);
  }
  /** Binance is limiting this server's IP; asking again now makes it worse. */
  get rateLimited() {
    return this.status === 429 || this.status === 418;
  }
}

/** What a known code means for the person reading it. */
function adviceFor(code: number | null, path: string): string {
  if (code === -2015)
    return path.startsWith("/fapi")
      ? " The key was refused by the futures API. A key made before the futures account was opened cannot read it — make a new read-only key. If the key is limited to trusted IPs, the server's IP must be on its list."
      : " If the key is limited to trusted IPs, the server's IP must be on its list.";
  if (code === -1021) return " The server's clock and Binance's disagree; try again in a minute.";
  return "";
}

export interface Creds {
  key: string;
  secret: string;
}

/**
 * One signed request, any method. Every parameter rides in the query string
 * — Binance accepts that for POST and DELETE as well as GET — so the bytes
 * signed and the bytes sent are the same string whatever the verb.
 */
export async function signedCall(
  method: "GET" | "POST" | "PUT" | "DELETE",
  base: string,
  path: string,
  params: Record<string, string | number | undefined>,
  creds: Creds,
): Promise<unknown> {
  const q = signedQuery(params, Date.now());
  const signature = createHmac("sha256", creds.secret).update(q).digest("hex");
  const url = `${base}${path}?${q}&signature=${signature}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await undiciFetch(url, {
      method,
      headers: { "X-MBX-APIKEY": creds.key, accept: "application/json" },
      signal: ctl.signal,
      dispatcher: egressFor(base),
    } as any);
    const host = new URL(base).hostname;
    if (!res.ok) {
      // The venue's own message is the useful part: "-2015 Invalid API-key,
      // IP, or permissions" is a diagnosis, "401" is a shrug.
      let said = "";
      let code: number | null = null;
      try {
        const j: any = await res.json();
        said = j?.msg ? ` — ${String(j.msg)}` : "";
        code = typeof j?.code === "number" ? j.code : null;
      } catch {
        /* no body worth reading */
      }
      throw new BinanceError(
        `${host} → HTTP ${res.status} on ${path}${code != null ? ` (${code})` : ""}${said}.${adviceFor(code, path)}`,
        res.status,
        code,
      );
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

const signedGet = (base: string, path: string, params: Record<string, string | number | undefined>, creds: Creds) =>
  signedCall("GET", base, path, params, creds);

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
  return parseRestrictions(await signedGet(SAPI, "/sapi/v1/account/apiRestrictions", {}, creds));
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

/**
 * A key that will TRADE, checked before it is kept.
 *
 * Live: the venue's own word on the key's permissions, held to the trading
 * rules — futures on, money movement off, locked to an IP. Testnet: there is
 * no permissions endpoint and nothing to steal, so the check is that the
 * key can read its own futures balance on the testnet host, which is also
 * the check that it IS a testnet key rather than a live one pasted in the
 * wrong box.
 */
export async function verifyTradingKey(
  creds: Creds,
  env: BinanceEnv,
): Promise<{ ok: true; restrictions: KeyRestrictions | null } | { ok: false; reason: string }> {
  if (env === "testnet") {
    try {
      await signedGet(TESTNET, "/fapi/v2/balance", {}, creds);
      return { ok: true, restrictions: null };
    } catch (err: any) {
      return { ok: false, reason: `The testnet did not accept this key: ${String(err?.message ?? err)}` };
    }
  }
  let restrictions: KeyRestrictions;
  try {
    restrictions = await fetchRestrictions(creds);
  } catch (err: any) {
    return { ok: false, reason: `Could not confirm what this key may do: ${String(err?.message ?? err)}` };
  }
  const refusal = tradingKeyRefusal(restrictions);
  return refusal ? { ok: false, reason: refusal } : { ok: true, restrictions };
}

/* ------------------------------ the reads ------------------------------ */

export async function fetchPositions(creds: Creds, base = FUTURES) {
  return parsePositions(await signedGet(base, "/fapi/v2/positionRisk", {}, creds));
}

export async function fetchOpenOrders(creds: Creds, base = FUTURES) {
  return parseOpenOrders(await signedGet(base, "/fapi/v1/openOrders", {}, creds));
}

/** [from, to) cut into consecutive windows no longer than Binance allows. */
export function windows(from: number, to: number, size = WINDOW_MS): [number, number][] {
  const out: [number, number][] = [];
  for (let a = from; a < to; a += size) out.push([a, Math.min(a + size, to) - 1]);
  return out;
}

/**
 * Every row a time-filtered endpoint holds for [start, end], however many.
 *
 * Asked in explicit windows, because a query with only a start time is not
 * documented to reach past seven days, and a first page from three months
 * ago that comes back short would end the read with eleven weeks unseen. A
 * window that comes back FULL is split in half and each half asked again —
 * which does not depend on which thousand of the window's rows the venue
 * chose to return, oldest or newest.
 */
async function readWindow<T>(
  ask: (start: number, end: number) => Promise<T[]>,
  start: number,
  end: number,
): Promise<{ rows: T[]; truncated: boolean }> {
  const got = await ask(start, end);
  if (got.length < PAGE) return { rows: got, truncated: false };
  if (end - start <= MIN_WINDOW_MS) return { rows: got, truncated: true };
  const mid = start + Math.floor((end - start) / 2);
  const a = await readWindow(ask, start, mid);
  const b = await readWindow(ask, mid + 1, end);
  return { rows: [...a.rows, ...b.rows], truncated: a.truncated || b.truncated };
}

/** Symbols that realised a P&L inside the lookback — the closed trades to go and read. */
export async function fetchClosedSymbols(creds: Creds, since: number, now = Date.now(), base = FUTURES): Promise<string[]> {
  const seen = new Set<string>();
  for (const [start, end] of windows(since, now)) {
    const { rows } = await readWindow(
      async (a, b) => {
        const got: any = await signedGet(
          base,
          "/fapi/v1/income",
          { incomeType: "REALIZED_PNL", startTime: a, endTime: b, limit: PAGE },
          creds,
        );
        return Array.isArray(got) ? got : [];
      },
      start,
      end,
    );
    for (const s of symbolsFromIncome(rows)) seen.add(s);
  }
  return Array.from(seen);
}

/**
 * Every fill on one symbol since `since`, in seven-day windows.
 *
 * `truncated` is a window so busy that even an hour of it holds more than a
 * page; that symbol's record has a hole in it, and a record with a hole
 * cannot be reconciled with the venue's open position, so the sync sets it
 * aside and says so rather than writing half of it.
 */
export async function fetchUserTrades(
  creds: Creds,
  symbol: string,
  since: number,
  now = Date.now(),
  base = FUTURES,
): Promise<{ rows: BinanceUserTrade[]; truncated: boolean }> {
  const byId = new Map<number, BinanceUserTrade>();
  let truncated = false;
  for (const [start, end] of windows(since, now)) {
    const got = await readWindow(
      async (a, b) =>
        parseUserTrades(
          await signedGet(base, "/fapi/v1/userTrades", { symbol, startTime: a, endTime: b, limit: PAGE }, creds),
        ),
      start,
      end,
    );
    truncated ||= got.truncated;
    for (const r of got.rows) byId.set(r.id, r);
  }
  return { rows: Array.from(byId.values()).sort((a, b) => a.time - b.time || a.id - b.id), truncated };
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
      const base = futuresBase(acct.binanceEnv);
      row.source = `…${acct.binanceKey!.slice(-4)}${acct.binanceEnv === "testnet" ? " (testnet)" : ""}`;

      const now = Date.now();
      const positions = await fetchPositions(creds, base);
      const closedSymbols = await fetchClosedSymbols(creds, now - LOOKBACK_MS, now, base);
      const openSymbols = Array.from(positions.entries())
        .filter(([, p]) => Math.abs(p.amt) > 1e-9)
        .map(([s]) => s);
      const symbols = Array.from(new Set([...closedSymbols, ...openSymbols]));
      const isOpen = new Set(openSymbols);

      /*
       * One symbol at a time, each on its own. A symbol the venue will not
       * answer for — delisted inside the window, renamed, settled — is
       * skipped and named, and the rest are still read: one bad market
       * used to cost the whole account its sync. Being rate-limited is
       * different: every later request would be refused too, and asking
       * again makes the ban longer, so the read stops there and what was
       * read in full is still written.
       */
      const allRows: BinanceUserTrade[] = [];
      const truncated: string[] = [];
      const skipped: string[] = [];
      let limited = false;
      for (const symbol of symbols) {
        if (limited) {
          skipped.push(symbol);
          continue;
        }
        try {
          const since = now - (isOpen.has(symbol) ? OPEN_LOOKBACK_MS : LOOKBACK_MS);
          const { rows, truncated: cut } = await fetchUserTrades(creds, symbol, since, now, base);
          if (cut) {
            truncated.push(symbol);
            continue;
          }
          allRows.push(...rows);
        } catch (err: any) {
          if (err instanceof BinanceError && err.rateLimited) limited = true;
          skipped.push(symbol);
        }
      }
      row.fills = allRows.length;

      const { fills, unreconstructable } = fillsFromUserTrades(allRows, positions);
      const read = tradesFromFills(fills, "binance");
      row.unreconstructed =
        unreconstructable.reduce((n, u) => n + u.fills, 0) +
        read.unreconstructed.reduce((n, u) => n + u.fills, 0);
      row.markets = marketsSeen(
        allRows.map((r) => ({ coin: r.symbol, time: r.time })),
        read,
        unreconstructable.map((u) => ({ coin: u.symbol, fills: u.fills })),
      );
      const problems: string[] = [];
      if (limited)
        problems.push(`Binance is rate-limiting this server, so the read stopped early — sync again in a few minutes for ${skipped.join(", ")}.`);
      else if (skipped.length) problems.push(`Binance would not answer for ${skipped.join(", ")}, so those were skipped.`);
      if (truncated.length) problems.push(`Too many fills in an hour to read whole on ${truncated.join(", ")} — those were left alone.`);
      const hedged = unreconstructable.filter((u) => u.reason === "hedge-mode").map((u) => u.symbol);
      if (hedged.length)
        problems.push(`${hedged.join(", ")} ${hedged.length === 1 ? "was" : "were"} traded in hedge mode, which the sync cannot read as single positions — log those by hand.`);
      if (problems.length) row.error = problems.join(" ");

      const orders = await fetchOpenOrders(creds, base).catch(() => []);
      await writeVenueTrades(store, row, read.trades, {
        symbolOf: (s) => baseAssetOf(s, cat),
        levelsFor: (t) => levelsFromOpenOrders(t, orders),
      });
    } catch (err: any) {
      row.error = loggableError(err);
    }
    out.push(row);
  }
  return { accounts: out };
}
