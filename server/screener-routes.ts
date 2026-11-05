/**
 * The screener's routes: the latest run for the table, lines for the
 * chart, a coin for the drawer, the settings, a refresh, and the news a
 * click asks for. Everything but the cron hook sits behind the login
 * (registerRoutes runs after the /api guard); the cron hook is registered
 * in index.ts ahead of the guard and takes its own token instead.
 */
import type { Express, Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  COOLDOWN_MS,
  latestScreenerRun,
  refreshAllowed,
  runScreener,
  saveScreenerSettings,
  screenerSettings,
  screenerStatus,
  storedSeries,
} from "./screener";
import { screenerStore } from "./storage";
import {
  blockCandles,
  CHART_WINDOW_MS,
  exitPlan,
  ratioSeries,
  rebasedLine,
  TF_SPEC,
  TIMEFRAMES,
  type ScreenerCandle,
  type Timeframe,
} from "@shared/screener";

const tfParam = (v: unknown): Timeframe => (TIMEFRAMES.includes(v as Timeframe) ? (v as Timeframe) : "4h");
const COIN = /^[A-Za-z0-9:_-]{1,24}$/;

export function registerScreenerRoutes(app: Express): void {
  /** The latest run, the settings and whether a refresh may be asked for. */
  app.get("/api/screener", async (_req, res) => {
    const [run, settings] = await Promise.all([latestScreenerRun(), screenerSettings()]);
    res.json({ run, settings, status: screenerStatus(run?.at), cooldownMs: COOLDOWN_MS });
  });

  /** A refresh now: starts the run and answers at once; the page hears "screener" when it lands. */
  app.post("/api/screener/run", async (_req, res) => {
    const latest = await screenerStore.latestRun();
    const allowed = refreshAllowed(latest?.at);
    if (!allowed.ok) {
      return res.status(429).json({ message: allowed.retryAt ? "Refreshed less than five minutes ago." : "A run is on.", retryAt: allowed.retryAt, status: screenerStatus(latest?.at) });
    }
    runScreener({ force: true }).catch(() => {});
    res.json({ started: true, status: screenerStatus(latest?.at) });
  });

  app.get("/api/screener/settings", async (_req, res) => res.json(await screenerSettings()));
  app.put("/api/screener/settings", async (req, res) => {
    const body = z.object({ minVolume: z.number().optional(), rvolMin: z.number().optional(), stopLookback: z.number().optional(), riskDollars: z.number().optional(), oiJumpMin: z.number().optional() }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "Invalid settings", issues: body.error.issues });
    res.json(await saveScreenerSettings(body.data));
  });

  /** The lines: each coin's RS ratio rebased to 0% at the window's start, on the timeframe's base series. */
  app.get("/api/screener/series", async (req, res) => {
    const tf = tfParam(req.query.tf);
    const coins = String(req.query.coins ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter((c) => COIN.test(c) && c !== "BTC")
      .slice(0, 40);
    const base = TF_SPEC[tf].base;
    const btc = await storedSeries("BTC");
    const bodies = await screenerStore.seriesFor(coins, base);
    const now = Math.max(0, ...btc[base].map((c) => c.t));
    const lines: Record<string, { t: number; pct: number }[]> = {};
    for (const coin of coins) {
      const raw = bodies.get(coin);
      if (!raw) continue;
      let alt: ScreenerCandle[] = [];
      try {
        alt = JSON.parse(raw);
      } catch {
        continue;
      }
      lines[coin] = rebasedLine(ratioSeries(alt, btc[base]), CHART_WINDOW_MS[tf], now);
    }
    res.json({ tf, now, lines });
  });

  /** One coin for the drawer: price and ratio on the timeframe, volume, the exit plan, and the funding/OI history. */
  app.get("/api/screener/coin/:coin", async (req, res) => {
    const coin = String(req.params.coin);
    if (!COIN.test(coin)) return res.status(400).json({ message: "No such coin" });
    const tf = tfParam(req.query.tf);
    const [run, settings, alt, btc] = await Promise.all([latestScreenerRun(), screenerSettings(), storedSeries(coin), storedSeries("BTC")]);
    const row = run?.rows.find((r) => r.coin === coin) ?? null;
    const base = TF_SPEC[tf].base;
    const L = TF_SPEC[tf].bars;
    const ratio = ratioSeries(alt[base], btc[base]);
    // Blocks counted back from the last bar, like the metrics: the newest block ends on the newest bar.
    const blocks: { t: number; r: number; v: number }[] = [];
    for (let end = ratio.length - 1; end >= 0; end -= L) {
      const from = Math.max(0, end - L + 1);
      const b = ratio.slice(from, end + 1);
      blocks.unshift({ t: b[0].t, r: b[b.length - 1].r, v: b.reduce((s, x) => s + x.v, 0) });
      if (from === 0) break;
    }
    const metrics = row?.tf[tf] ?? { rs: null, accel: null, breakout: null, rvol: null, breakoutLevel: null };
    const riskDollars = Number(req.query.risk);
    const plan = exitPlan(alt[base], tf, row?.mark ?? alt[base][alt[base].length - 1]?.c ?? null, metrics, ratio[ratio.length - 1]?.r ?? null, {
      stopLookback: settings.stopLookback,
      riskDollars: Number.isFinite(riskDollars) && riskDollars > 0 ? riskDollars : settings.riskDollars,
    });
    // The arithmetic behind the timeframe's RS change, so it can be checked against the candles by hand.
    const btcAt = new Map(btc[base].map((c) => [c.t, c]));
    const aligned = alt[base].filter((c) => btcAt.has(c.t) && c.c > 0 && btcAt.get(c.t)!.c > 0);
    const nowBar = aligned[aligned.length - 1];
    const thenBar = aligned[aligned.length - 1 - L];
    const audit =
      nowBar && thenBar
        ? {
            tf,
            lookbackBars: L,
            base,
            now: { t: nowBar.t, alt: nowBar.c, btc: btcAt.get(nowBar.t)!.c, ratio: nowBar.c / btcAt.get(nowBar.t)!.c },
            then: { t: thenBar.t, alt: thenBar.c, btc: btcAt.get(thenBar.t)!.c, ratio: thenBar.c / btcAt.get(thenBar.t)!.c },
            rs: nowBar.c / btcAt.get(nowBar.t)!.c / (thenBar.c / btcAt.get(thenBar.t)!.c) - 1,
          }
        : null;
    const since = new Date(Date.now() - 60 * 86400_000).toISOString();
    res.json({
      audit,
      stopLookback: settings.stopLookback,
      coin,
      tf,
      row,
      price: blockCandles(alt[base], tf),
      ratio: blocks,
      plan,
      snapshots: await screenerStore.snapshotsFor(coin, since),
    });
  });

  /** The news, only when asked: links always; a read with web search when a key is set. */
  app.post("/api/screener/news/:coin", async (req: Request, res: Response) => {
    const coin = String(req.params.coin);
    if (!COIN.test(coin)) return res.status(400).json({ message: "No such coin" });
    const ticker = coin.replace(/^k/, "").toUpperCase();
    const links = [
      { label: "CoinGecko", url: `https://www.coingecko.com/en/search?query=${encodeURIComponent(ticker)}` },
      { label: `X: $${ticker}`, url: `https://x.com/search?q=${encodeURIComponent("$" + ticker)}&f=live` },
      { label: "Unlocks (DefiLlama)", url: "https://defillama.com/unlocks" },
    ];
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.json({ coin, links, summary: null, sources: [], reason: "No ANTHROPIC_API_KEY on the server." });
    try {
      const out = await newsRead(key, ticker);
      res.json({ coin, links, ...out });
    } catch (err: any) {
      res.json({ coin, links, summary: null, sources: [], reason: String(err?.message ?? err).slice(0, 200) });
    }
  });
}

/* ------------------------------- the news read ------------------------------- */

let client: Anthropic | undefined;

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
    for (const c of (b as any).citations ?? []) if (c?.type === "web_search_result_location" && typeof c.url === "string") sources.set(c.url, c.title ?? null);
  }
  const summary = text
    .split(/\n+/)
    .map((l) => l.replace(/^\s*[-•*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  return { summary, sources: Array.from(sources, ([url, title]) => ({ url, title })), reason: null };
}
