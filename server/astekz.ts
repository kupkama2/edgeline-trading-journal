/**
 * The Astekz portfolio, read once a day.
 *
 * The public page's widget carries its own list of holdings, and prices it
 * from CoinGecko in the browser. The server fetches that widget, reads the
 * list as text (shared/astekz.ts), asks CoinGecko the same prices, and
 * keeps the day. One good read a day is kept; a read that fails leaves the
 * last good one standing and is remembered, so the page can say how old
 * what it shows is and why.
 *
 * The read is tried on the server's clock once the day (UTC) has none, and
 * again no sooner than an hour after a failure. ASTEKZ=off turns it off.
 */
import type { Express, Request, Response } from "express";
import { adminOnly } from "./admin";
import { astekzStore } from "./storage";
import { notifyAll } from "./events";
import { parseLlamaPrices } from "@shared/portfolio";
import { astekzChanges, astekzCoinIds, astekzExchangePairs, exchangeKey, parseAstekzWidget, parseExchangeLast, parseSimplePrices, valueAstekz, type AstekzSnapshot } from "@shared/astekz";

const WIDGET_URL = process.env.ASTEKZ_WIDGET_URL || "https://astekz.co.uk/portfolio-widget/index.html?embed=1";
export const ASTEKZ_PAGE = "https://astekz.co.uk/portfolio";
const COINGECKO = (process.env.COINGECKO_BASE || "https://api.coingecko.com").replace(/\/+$/, "");
const LLAMA = (process.env.LLAMA_BASE || "https://coins.llama.fi").replace(/\/+$/, "");
const RETRY_MS = 60 * 60_000;
export const astekzEnabled = (): boolean => (process.env.ASTEKZ ?? "on").toLowerCase() !== "off";

async function get(url: string, as: "text" | "json"): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { Accept: as === "json" ? "application/json" : "text/html", "User-Agent": "Mozilla/5.0 (compatible; portfolio-reader)" } });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return as === "json" ? res.json() : res.text();
}

/** Read the page and price it, now. Throws with the reason when it cannot. */
export async function readAstekz(now = Date.now()): Promise<AstekzSnapshot> {
  const config = parseAstekzWidget(await get(WIDGET_URL, "text"));
  const ids = astekzCoinIds(config);
  const prices = ids.length ? await get(`${COINGECKO}/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd&precision=full`, "json").then(parseSimplePrices, () => new Map<string, number>()) : new Map<string, number>();
  // CoinGecko turns a busy shared address away: what it did not answer is asked of DefiLlama, which lists the same coins by the same ids.
  const missing = ids.filter((id) => !prices.has(id));
  if (missing.length) {
    const raw = await get(`${LLAMA}/prices/current/${missing.map((id) => `coingecko:${id}`).join(",")}`, "json").catch(() => null);
    parseLlamaPrices(raw).forEach((v, k) => prices.set(k.replace(/^coingecko:/, ""), v.price));
  }
  // The last trade on the exchange the page prefers; when it cannot be had, the coin's own price is the page's next choice too.
  for (const s of astekzExchangePairs(config)) {
    const last = await get(`${COINGECKO}/api/v3/exchanges/${s.exchange}/tickers?coin_ids=${encodeURIComponent(s.coinId!)}`, "json")
      .then((raw) => parseExchangeLast(raw, s))
      .catch(() => null);
    if (last != null) prices.set(exchangeKey(s), last);
  }
  return valueAstekz(config, prices, new Date(now).toISOString());
}

let reading: Promise<{ ok: boolean; error: string | null }> | null = null;

/** Read and keep today's snapshot; a failure is recorded and nothing stored is touched. One at a time. */
export function refreshAstekz(now = Date.now()): Promise<{ ok: boolean; error: string | null }> {
  if (reading) return reading;
  reading = (async () => {
    const at = new Date(now).toISOString();
    try {
      const snap = await readAstekz(now);
      await astekzStore.save(at.slice(0, 10), at, JSON.stringify(snap));
      await astekzStore.tried(at, null);
      return { ok: true, error: null };
    } catch (err: any) {
      const error = String(err?.message ?? err).slice(0, 240);
      console.error(`[astekz] ${error}`);
      await astekzStore.tried(at, error).catch(() => {});
      return { ok: false, error };
    } finally {
      reading = null;
      notifyAll("sigil");
    }
  })();
  return reading;
}

/** The clock's tick: a read when today has none, and not within the hour of the last attempt. */
export async function astekzTick(now = Date.now()): Promise<boolean> {
  if (!astekzEnabled() || reading) return false;
  const today = new Date(now).toISOString().slice(0, 10);
  const days = await astekzStore.all(1);
  if (days[0]?.day === today) return false;
  const status = await astekzStore.status();
  if (status && now - new Date(status.triedAt).getTime() < RETRY_MS) return false;
  void refreshAstekz(now);
  return true;
}

export async function astekzState(now = Date.now()) {
  const rows = await astekzStore.all();
  const days = rows
    .map((r) => {
      try {
        return { day: r.day, snap: JSON.parse(r.body) as AstekzSnapshot };
      } catch {
        return null;
      }
    })
    .filter((d): d is { day: string; snap: AstekzSnapshot } => !!d);
  const latest = days[days.length - 1] ?? null;
  const status = await astekzStore.status();
  return {
    enabled: astekzEnabled(),
    page: ASTEKZ_PAGE,
    latest: latest ? { day: latest.day, ...latest.snap } : null,
    history: days.map((d) => ({ date: d.day, valueUsd: d.snap.totalUsd, progressPct: d.snap.progressPct, pnlPct: d.snap.pnlPct, cashPct: d.snap.cashPct })),
    changes: astekzChanges(days),
    /** The last attempt, when it failed: what is shown is then older than it should be. */
    failed: status?.error ? { at: status.triedAt, error: status.error } : null,
    reading: !!reading,
    stale: latest ? now - new Date(latest.snap.at).getTime() > 36 * 3600_000 : false,
  };
}

export function registerAstekzRoutes(app: Express): void {
  app.use("/api/astekz", adminOnly);
  app.get("/api/astekz", async (_req: Request, res: Response) => {
    // The page being opened is as good a moment as the clock's: a day with no read gets one.
    await astekzTick().catch(() => false);
    res.json(await astekzState());
  });
  /** Read it again now, whatever today already has. Answered when the read is done. */
  app.post("/api/astekz/refresh", async (_req: Request, res: Response) => {
    if (!astekzEnabled()) return res.status(400).json({ message: "The Astekz read is switched off on the server." });
    const r = await refreshAstekz();
    if (!r.ok) return res.status(502).json({ message: `The read failed: ${r.error}` });
    res.json(await astekzState());
  });
}
