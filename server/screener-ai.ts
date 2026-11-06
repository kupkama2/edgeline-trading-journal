/**
 * The AI's read of a screener run: the coins worth a look, each with what
 * agrees and what disagrees across relative strength, momentum, open
 * interest, Binance's taker flow and positioning, funding on both venues
 * and where liquidations sit — and the anomalies the run found — handed
 * to Claude once, after each scheduled run (twice a day) or when the
 * owner asks (at most every half hour). It reads the numbers it is given
 * and nothing else: no news, no prices it was not shown.
 *
 * Only on the server with ANTHROPIC_API_KEY set. The answer is stored and
 * pushed to open pages; a failure is stored too, so the page can say why.
 */
import Anthropic from "@anthropic-ai/sdk";
import { notifyAll } from "./events";
import { screenerAiStore } from "./storage";
import type { ScreenerRun } from "./screener";
import type { ScreenerRow, Timeframe } from "@shared/screener";

export const AI_MODEL = process.env.SCREENER_AI_MODEL || "claude-opus-5-5";
export const AI_COOLDOWN_MS = 30 * 60_000;

export interface AiTip {
  coin: string;
  stance: "long" | "short" | "watch" | "avoid";
  horizon: string;
  thesis: string;
  agree: string[];
  disagree: string[];
  invalidation: string;
  confidence: "low" | "medium" | "high";
}

export interface AiRead {
  regime: string;
  tips: AiTip[];
  anomalies: { coin: string; note: string }[];
}

let running: Promise<void> | null = null;
let lastStartedAt = 0;

export const aiStatus = () => ({ running: !!running, nextAllowedAt: lastStartedAt ? new Date(lastStartedAt + AI_COOLDOWN_MS).toISOString() : null, enabled: !!process.env.ANTHROPIC_API_KEY, model: AI_MODEL });

const r2 = (x: number | null | undefined, d = 3) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

/** One coin, compactly: the numbers the read works from. */
function coinDigest(r: ScreenerRow) {
  const tf = (t: Timeframe) => ({
    rs: r2(r.tf[t]?.rs),
    accel: r.tf[t]?.accel ?? null,
    rsi: r2(r.price?.[t]?.rsi, 0),
    trend: r.price?.[t]?.ema ?? null,
    score: r.signals?.[t]?.score ?? null,
    div: r.signals?.[t]?.divergence ?? null,
  });
  const f = r.flow;
  const l = r.liq;
  return {
    coin: r.coin,
    flags: { candidate4h: r.flags["4h"].candidate, candidate1D: r.flags["1D"].candidate, fast4h: r.flags["4h"].movingFast, weak1D: r.flags["1D"].weakest, leverageDriven: r.leverageDriven },
    "1h": tf("1h"),
    "4h": tf("4h"),
    "1D": tf("1D"),
    "1W": { rs: r2(r.tf["1W"]?.rs) },
    rsVsEth1D: r2(r.price?.["1D"]?.rsEth),
    rsVsBasket1D: r2(r.price?.["1D"]?.rsBasket),
    rvol4h: r2(r.tf["4h"]?.rvol, 2),
    hl: { oi1h: r2(r.positioning?.oi1h), oi4h: r2(r.positioning?.oi4h), oi24h: r2(r.positioning?.oi1d), px24h: r2(r.positioning?.px1d), oiRead: r.positioning?.read ?? null, fundingAnnual: r2(r.fundingAnnual), fundingPctile: r2(r.positioning?.fundingPct, 2), premium: r2(r.positioning?.premium, 4) },
    binance: f
      ? { cvd4h: r2(f.cvd4h), cvd24h: r2(f.cvd24h), px24h: r2(f.px24h), accountsLS: r2(f.lsAccounts, 2), accountsLS24h: r2(f.lsAccounts24h), topPositionsLS: r2(f.lsTop, 2), topLS24h: r2(f.lsTop24h), oi24h: r2(f.oi24h), fundingAnnual: r2(f.fundingBn), basisHlVsBn: r2(f.basis, 4) }
      : null,
    liquidations: l ? { nearestLongs: l.nearestLong ? { at: r2(l.nearestLong.at), usd: Math.round(l.nearestLong.usd) } : null, nearestShorts: l.nearestShort ? { at: r2(l.nearestShort.at), usd: Math.round(l.nearestShort.usd) } : null, longsWithin10pct: Math.round(l.longUsd10), shortsWithin10pct: Math.round(l.shortUsd10) } : null,
  };
}

/** The coins worth the read: candidates, the strongest and weakest by agreement, and every coin with a notable anomaly — at most thirty. */
export function digestOf(run: ScreenerRun) {
  const rows = run.rows.filter((r) => !r.error);
  const byScore = [...rows].sort((a, b) => (b.signals?.["1D"]?.score ?? 0) - (a.signals?.["1D"]?.score ?? 0));
  const pick = new Map<string, ScreenerRow>();
  for (const r of rows) if (r.flags["4h"].candidate || r.flags["1D"].candidate) pick.set(r.coin, r);
  for (const r of byScore.slice(0, 8)) pick.set(r.coin, r);
  for (const r of byScore.slice(-6)) pick.set(r.coin, r);
  for (const a of run.anomalies.filter((a) => a.severity >= 2)) {
    const r = rows.find((x) => x.coin === a.coin);
    if (r) pick.set(r.coin, r);
  }
  return {
    at: run.at,
    barsTo: new Date(run.barsTo).toISOString(),
    universe: run.universe,
    breadth: r2(run.breadth, 2),
    btc: { d1: r2(run.btc?.d1), w1: r2(run.btc?.w1) },
    binanceFlow: run.flowStatus?.source === "relay" ? `read for ${run.flowStatus.coins} coins` : "not available this run",
    anomalies: run.anomalies.slice(0, 40).map((a) => ({ coin: a.coin, severity: a.severity, kind: a.kind, text: a.text })),
    coins: Array.from(pick.values()).slice(0, 30).map(coinDigest),
  };
}

const SYSTEM = `You are a crypto derivatives analyst reading a relative-strength screener for a discretionary trader on Hyperliquid perpetuals.

You get, per coin: relative strength against BTC (rs, as a fraction: 0.05 = +5%) and its acceleration per timeframe, RSI, trend (2 = above its 20 and 50 averages, 0 = below both), an agreement score of seven readings, divergences, open interest on Hyperliquid and Binance, Hyperliquid's read of OI against price, funding on both venues (annualised fractions) and its percentile, Binance taker flow as CVD (net taker buying as a share of volume), Binance long/short ratios for all accounts and for top traders' positions, the basis between the venues, and where Hyperliquid's largest accounts would be liquidated (fraction from the mark and USD). Also the breadth of the alt tape, BTC's own move, and the anomalies the screener flagged.

Your job: say where several independent readings point the same way, and where they conflict. Rules:
- Use only the numbers given. Never mention news, events or prices you were not shown.
- A good long has relative strength rising with taker buying, open interest growing with price (new longs), funding not crowded, and room before short liquidations above. A good short is the mirror. Flag traps: price up on net taker selling, OI up with top-decile funding, a crowd long while top traders are short.
- Every tip names the readings that agree and the ones that disagree, and an invalidation in plain terms (a relative-strength break, a flow flip, a level from the liquidation bands).
- Be brief and concrete. No disclaimers.

Answer with JSON only, in exactly this shape:
{"regime": "two or three sentences on the tape: breadth, BTC, where flow is going",
 "tips": [{"coin": "SOL", "stance": "long|short|watch|avoid", "horizon": "hours|1-3 days|week", "thesis": "one sentence", "agree": ["reading that supports it"], "disagree": ["reading against it"], "invalidation": "what would prove it wrong", "confidence": "low|medium|high"}],
 "anomalies": [{"coin": "XYZ", "note": "one sentence on why this anomaly matters or does not"}]}
At most 8 tips and 6 anomaly notes, the strongest first.`;

/** The JSON object in a reply, however it is wrapped. */
export function parseAiRead(text: string): AiRead | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(text.slice(start, end + 1));
    const stances = new Set(["long", "short", "watch", "avoid"]);
    const conf = new Set(["low", "medium", "high"]);
    const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s) => typeof s === "string").map((s) => s.slice(0, 200)).slice(0, 6) : []);
    return {
      regime: typeof j.regime === "string" ? j.regime.slice(0, 800) : "",
      tips: (Array.isArray(j.tips) ? j.tips : []).slice(0, 8).map((t: any) => ({
        coin: String(t?.coin ?? "").slice(0, 24),
        stance: stances.has(t?.stance) ? t.stance : "watch",
        horizon: String(t?.horizon ?? "").slice(0, 30),
        thesis: String(t?.thesis ?? "").slice(0, 300),
        agree: strs(t?.agree),
        disagree: strs(t?.disagree),
        invalidation: String(t?.invalidation ?? "").slice(0, 300),
        confidence: conf.has(t?.confidence) ? t.confidence : "low",
      })).filter((t: AiTip) => t.coin),
      anomalies: (Array.isArray(j.anomalies) ? j.anomalies : []).slice(0, 6).map((a: any) => ({ coin: String(a?.coin ?? "").slice(0, 24), note: String(a?.note ?? "").slice(0, 300) })).filter((a: { coin: string }) => a.coin),
    };
  } catch {
    return null;
  }
}

let client: Anthropic | undefined;

/** Read a run with Claude and store the answer (or why there is none). One at a time. */
export function analyzeRun(run: ScreenerRun): Promise<void> {
  if (running) return running;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Promise.resolve();
  lastStartedAt = Date.now();
  running = (async () => {
    const at = new Date().toISOString();
    try {
      if (!client) client = new Anthropic({ apiKey: key });
      const res = await client.messages.create({
        model: AI_MODEL,
        max_tokens: 8000,
        thinking: { type: "adaptive" },
        system: SYSTEM,
        messages: [{ role: "user", content: `Screener run:\n${JSON.stringify(digestOf(run))}` }],
      } as any);
      const text = (res as any).content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      const read = parseAiRead(text);
      await screenerAiStore.save({ at, runId: run.id, model: AI_MODEL, body: read ? JSON.stringify(read) : null, error: read ? null : `The reply was not the JSON asked for: ${text.slice(0, 200)}` });
    } catch (err: any) {
      await screenerAiStore.save({ at, runId: run.id, model: AI_MODEL, body: null, error: String(err?.message ?? err).slice(0, 300) }).catch(() => {});
    } finally {
      running = null;
      notifyAll("screener");
    }
  })();
  return running;
}

export async function latestAiRead(): Promise<{ at: string; runId: number | null; model: string | null; read: AiRead | null; error: string | null } | null> {
  const r = await screenerAiStore.latest();
  if (!r) return null;
  let read: AiRead | null = null;
  try {
    read = r.body ? (JSON.parse(r.body) as AiRead) : null;
  } catch {
    read = null;
  }
  return { at: r.at, runId: r.runId, model: r.model, read, error: r.error };
}
