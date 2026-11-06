/**
 * The screener's routes: the latest run for the table, lines for the
 * chart, a coin for the drawer, the settings, a refresh, and the news a
 * click asks for. Everything but the cron hook sits behind the login
 * (registerRoutes runs after the /api guard); the cron hook is registered
 * in index.ts ahead of the guard and takes its own token instead.
 *
 * The run and the series are served from memory (server/screener.ts
 * keeps them); the only query a page view makes is for the settings.
 */
import type { Express, Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  COOLDOWN_MS,
  latestScreenerRun,
  measuredSeries,
  refreshAllowed,
  runScreener,
  saveScreenerSettings,
  screenerSettings,
  screenerStatus,
  storedSeries,
} from "./screener";
import { screenerStore } from "./storage";
import { blockCandles, CHART_WINDOW_MS, exitPlan, NOT_AN_ALT, ratioSeries, rebasedLine, TF_SPEC, TIMEFRAMES, type Timeframe } from "@shared/screener";

const fmtUsd = (x: number | null | undefined) => {
  if (x == null || !Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  return a >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : a >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${(x / 1e3).toFixed(0)}K` : `$${x.toFixed(0)}`;
};

const tfParam = (v: unknown): Timeframe => (TIMEFRAMES.includes(v as Timeframe) ? (v as Timeframe) : "4h");
const COIN = /^[A-Za-z0-9:_-]{1,24}$/;

export function registerScreenerRoutes(app: Express): void {
  /** The latest run, the settings and whether a refresh may be asked for. */
  app.get("/api/screener", async (_req, res) => {
    const [run, settings] = await Promise.all([latestScreenerRun(), screenerSettings()]);
    res.json({ run, settings, status: screenerStatus(run?.at), cooldownMs: COOLDOWN_MS });
  });

  /** Just the status, for the progress line while a run is on: no query, a few hundred bytes. */
  app.get("/api/screener/status", async (_req, res) => {
    const run = await latestScreenerRun();
    res.json(screenerStatus(run?.at));
  });

  /** A refresh now: starts the run and answers at once; the page hears "screener" when it lands. */
  app.post("/api/screener/run", async (_req, res) => {
    const run = await latestScreenerRun();
    const allowed = refreshAllowed(run?.at);
    if (!allowed.ok) {
      return res.status(429).json({ message: allowed.retryAt ? "Refreshed less than five minutes ago." : "A run is on.", retryAt: allowed.retryAt, status: screenerStatus(run?.at) });
    }
    runScreener({ force: true }).catch(() => {});
    res.json({ started: true, status: screenerStatus(run?.at) });
  });

  app.get("/api/screener/settings", async (_req, res) => res.json(await screenerSettings()));
  app.put("/api/screener/settings", async (req, res) => {
    const body = z.object({ minVolume: z.number().optional(), rvolMin: z.number().optional(), stopLookback: z.number().optional(), riskDollars: z.number().optional(), oiJumpMin: z.number().optional() }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "Invalid settings", issues: body.error.issues });
    res.json(await saveScreenerSettings(body.data));
  });

  /** The lines: each coin's RS ratio rebased to 0% at the window's start, on the timeframe's base series as measured. */
  app.get("/api/screener/series", async (req, res) => {
    const tf = tfParam(req.query.tf);
    const coins = String(req.query.coins ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter((c) => COIN.test(c) && c !== "BTC")
      .slice(0, 40);
    const base = TF_SPEC[tf].base;
    const run = await latestScreenerRun();
    const to = run?.barsTo ?? Date.now();
    const btc = measuredSeries(await storedSeries("BTC"), to);
    const now = Math.max(0, ...btc[base].map((c) => c.t));
    const lines: Record<string, { t: number; pct: number }[]> = {};
    for (const coin of coins) {
      const alt = measuredSeries(await storedSeries(coin), to);
      if (alt[base].length === 0) continue;
      lines[coin] = rebasedLine(ratioSeries(alt[base], btc[base]), CHART_WINDOW_MS[tf], now);
    }
    res.json({ tf, now, lines });
  });

  /** Why a coin is or is not in the table: typed into the search box and found nowhere. */
  app.get("/api/screener/lookup/:coin", async (req, res) => {
    const asked = String(req.params.coin).trim();
    if (!COIN.test(asked)) return res.status(400).json({ message: "No such coin" });
    const [run, settings, snap] = await Promise.all([latestScreenerRun(), screenerSettings(), screenerStore.latestSnapshot()]);
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const row = run?.rows.find((r) => same(r.coin, asked)) ?? null;
    if (row) return res.json({ asked, coin: row.coin, where: "table", reason: row.error ? `In the table, but its last read failed: ${row.error}` : "In the table." });
    if (NOT_AN_ALT.test(asked)) return res.json({ asked, coin: asked.toUpperCase(), where: "excluded", reason: "BTC and the dollar-pegged coins are not alts; the screener measures the rest against BTC." });
    const listed = snap?.coins.find((c) => same(c.coin, asked)) ?? null;
    if (listed) {
      const under = (listed.volume ?? 0) < settings.minVolume;
      return res.json({
        asked,
        coin: listed.coin,
        where: under ? "under-volume" : "not-read",
        volume: listed.volume,
        minVolume: settings.minVolume,
        reason: under
          ? `Listed on Hyperliquid, but its 24h volume at the last run was ${fmtUsd(listed.volume)}, under the ${fmtUsd(settings.minVolume)} line. Lower the line in the settings and refresh.`
          : `Listed on Hyperliquid with ${fmtUsd(listed.volume)} of 24h volume, but not in the last run — it was listed after the run started, or was delisted. Refresh.`,
      });
    }
    return res.json({
      asked,
      coin: null,
      where: "not-listed",
      reason: snap
        ? `Not on Hyperliquid's perp list at the last run (${new Date(snap.at).toISOString().slice(0, 16).replace("T", " ")}Z). Tokens often trade under another name — Lighter is LIT.`
        : "No run yet; refresh first.",
    });
  });

  /** One coin for the drawer: price and ratio on the timeframe, volume, the exit plan, the arithmetic, and the funding/OI history. */
  app.get("/api/screener/coin/:coin", async (req, res) => {
    const coin = String(req.params.coin);
    if (!COIN.test(coin)) return res.status(400).json({ message: "No such coin" });
    const tf = tfParam(req.query.tf);
    const [run, settings, altStored, btcStored] = await Promise.all([latestScreenerRun(), screenerSettings(), storedSeries(coin), storedSeries("BTC")]);
    const to = run?.barsTo ?? Date.now();
    const alt = measuredSeries(altStored, to);
    const btc = measuredSeries(btcStored, to);
    const row = run?.rows.find((r) => r.coin === coin) ?? null;
    const base = TF_SPEC[tf].base;
    const L = TF_SPEC[tf].bars;
    const ratio = ratioSeries(alt[base], btc[base]);
    // Blocks counted back from the last bar, like the metrics: the newest block ends on the newest bar.
    const blocks: { t: number; r: number; v: number }[] = [];
    for (let end = ratio.length - 1; end - L + 1 >= 0; end -= L) {
      const b = ratio.slice(end - L + 1, end + 1);
      blocks.push({ t: b[0].t, r: b[b.length - 1].r, v: b.reduce((s, x) => s + x.v, 0) });
    }
    blocks.reverse();
    const metrics = row?.tf[tf] ?? { rs: null, accel: null, breakout: null, rvol: null, breakoutLevel: null };
    const mark = row?.mark ?? alt[base][alt[base].length - 1]?.c ?? null;
    const plan = exitPlan(alt[base], tf, mark, metrics, ratio[ratio.length - 1]?.r ?? null, settings);
    // The arithmetic behind the timeframe's RS change, so it can be checked against the candles by hand.
    const nowI = ratio.length - 1;
    const thenI = nowI - L;
    const closeAt = (series: typeof alt, t: number) => series[base].find((c) => c.t === t)?.c ?? null;
    const audit =
      nowI >= 0 && thenI >= 0
        ? {
            tf,
            lookbackBars: L,
            base,
            now: { t: ratio[nowI].t, alt: closeAt(alt, ratio[nowI].t), btc: closeAt(btc, ratio[nowI].t), ratio: ratio[nowI].r },
            then: { t: ratio[thenI].t, alt: closeAt(alt, ratio[thenI].t), btc: closeAt(btc, ratio[thenI].t), ratio: ratio[thenI].r },
            rs: ratio[nowI].r / ratio[thenI].r - 1,
          }
        : null;
    const since = new Date(Date.now() - 60 * 86400_000).toISOString();
    res.json({
      coin,
      tf,
      barsTo: to,
      row,
      mark,
      stopLookback: settings.stopLookback,
      price: blockCandles(alt[base], tf),
      ratio: blocks,
      plan,
      audit,
      snapshots: await screenerStore.snapshotsFor(coin, since),
    });
  });

  /** The news, only when asked: links always; a read with web search when a key is set, remembered an hour per ticker. */
  app.post("/api/screener/news/:coin", async (req: Request, res: Response) => {
    const coin = String(req.params.coin);
    if (!COIN.test(coin)) return res.status(400).json({ message: "No such coin" });
    const ticker = coin.replace(/^k/, "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    const links = [
      { label: "CoinGecko", url: `https://www.coingecko.com/en/search?query=${encodeURIComponent(ticker)}` },
      { label: `X: $${ticker}`, url: `https://x.com/search?q=${encodeURIComponent("$" + ticker)}&f=live` },
      { label: "Unlocks (DefiLlama)", url: "https://defillama.com/unlocks" },
    ];
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.json({ coin, links, summary: null, sources: [], reason: "No ANTHROPIC_API_KEY on the server." });
    const hit = newsCache.get(ticker);
    if (hit && Date.now() - hit.at < NEWS_TTL_MS) return res.json({ coin, links, ...hit.out, cached: true });
    try {
      const out = await newsRead(key, ticker);
      newsCache.set(ticker, { at: Date.now(), out });
      res.json({ coin, links, ...out });
    } catch (err: any) {
      res.json({ coin, links, summary: null, sources: [], reason: String(err?.message ?? err).slice(0, 200) });
    }
  });
}

/* ------------------------------- the news read ------------------------------- */

let client: Anthropic | undefined;
const NEWS_TTL_MS = 60 * 60_000;
const newsCache = new Map<string, { at: number; out: Awaited<ReturnType<typeof newsRead>> }>();

/** Three bullets on the last seven days and any unlock ahead, with the pages they came from. */
async function newsRead(apiKey: string, ticker: string): Promise<{ summary: string[]; sources: { url: string; title: string | null }[]; reason: null }> {
  if (!client) client = new Anthropic({ apiKey });
  const today = new Date().toISOString().slice(0, 10);
  const res = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 2048,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
    messages: [
      {
        role: "user",
        content: `Today is ${today}. Search the web for news about the crypto token "${ticker}" from the last 7 days, and for any upcoming token unlock or emission event for it. Then answer with exactly three bullet points, each one sentence, plain text, no headings: the most important news of the week, the second most important, and any upcoming unlock (date and size) or "No unlock found". Say nothing you did not find.`,
      },
    ],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const sources = new Map<string, string | null>();
  for (const b of res.content) {
    if (b.type !== "text") continue;
    for (const c of (b as any).citations ?? []) {
      if (c?.type === "web_search_result_location" && typeof c.url === "string" && /^https?:\/\//i.test(c.url)) sources.set(c.url, typeof c.title === "string" ? c.title.slice(0, 120) : null);
    }
  }
  const summary = text
    .split(/\n+/)
    .map((l) => l.replace(/^\s*[-•*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  return { summary, sources: Array.from(sources, ([url, title]) => ({ url, title })), reason: null };
}
