import type { Express } from "express";
import type { Server } from "node:http";
import { storage } from "./storage";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import {
  insertTradeSchema,
  updateTradeSchema,
  insertMistakeTagSchema,
  insertWeeklyReviewSchema,
  parseScreenshotSchema,
  analyzeRationaleSchema,
} from "@shared/schema";
import { normalizeSymbol } from "@shared/symbols";
import { z } from "zod";

/**
 * Perplexity Sonar — `sonar-pro` supports vision (image_url content blocks) and
 * is OpenAI-chat-completions compatible.
 */
const MODEL = "sonar-pro";

const SETUP_PROMPT = `You are reading a screenshot to fill in a new trade's setup. The screenshot will be EITHER of two things — figure out which one it is first.

(A) A TradingView-style chart with a plotted long/short position tool.
- The entry price, stop-loss price, and take-profit price are almost always printed as exact numeric labels on the RIGHT-HAND price axis (the right edge of the chart), each sitting next to its own coloured horizontal line. Read those right-axis numeric labels directly for entryPrice/initialStop/initialTarget — they are far more reliable than estimating off gridlines.
- Direction from colour/position: if the blue entry marker/line has its shaded zone extending UPWARD from the entry price (blue is up), the trade is a LONG. If the blue marker/zone extends DOWNWARD from entry (blue is down), the trade is a SHORT. Cross-check with the standard convention where the profit zone is green and the loss zone is red/pink — green above entry confirms long, green below entry confirms short.
- Also look for the ticker/symbol label and any position size / quantity readout on the chart.

(B) A broker order log / order history table with columns such as Symbol, Side, Type, Qty, Remaining Qty, Filled Qty, Limit Price, Stop Price, Take Profit, Stop Loss, Avg Fill Price, Status, Update Time, Order ID, Expiry.
- Find the order that OPENED the position: the row with Status "Filled" whose Type is a plain entry type ("Limit", "Market", "Stop") — NOT a "Stop Loss" or "Take Profit" type row. If several symbols/trades appear, use the entry order that is chronologically most recent (latest Update Time) unless context makes another one clearly intended.
- direction: "long" if that entry order's Side is "Buy", "short" if "Sell".
- entryPrice: that entry order's Avg Fill Price (fall back to its Limit Price, then Stop Price, if Avg Fill Price is blank).
- size: that entry order's Filled Qty (fall back to Qty).
- entryTime: that entry order's Update Time.
- initialStop: the Stop Price (or Stop Loss column) of the "Stop Loss" type row tied to the same symbol/entry — use it even if that row's Status is "Filled" (it still reflects the ORIGINAL planned stop) or "Cancelled".
- initialTarget: the Limit Price (or Take Profit column) of the "Take Profit" type row tied to the same symbol/entry — use it even if its Status is "Cancelled" (a cancelled take-profit still tells you the original target).

CLOSED-TRADE DETECTION (applies to both A and B): decide whether the screenshot shows a trade that is ALREADY FINISHED, i.e. an exit is visible — not just a plan.
- In a broker order log (B), the position is CLOSED whenever a closing fill is visible. Concretely: if the "Stop Loss" row OR the "Take Profit" row tied to the entry has Status "Filled", the trade is closed — that filled protective order IS the exit. A second plain entry-type row on the same symbol with the OPPOSITE Side, Filled for the same quantity, also closes it. Note the double duty here: a Filled "Stop Loss" row supplies BOTH initialStop (the planned stop level) AND the exit (isClosed true, exitPrice = its Avg Fill Price, falling back to Stop Price / Limit Price; exitTime = its Update Time). Rows with Status "Cancelled" or "Working" do NOT close the trade.
- On a chart (A), the position is closed when BOTH an entry marker AND an exit/close marker are drawn (e.g. a completed position tool showing where the trade was closed, a "closed" P&L readout, or an explicit exit label/arrow at a later bar). A plain position tool showing only entry + stop + target with no exit marker is NOT closed.
- If it is closed, also set exitReason to the best fit: "target" (closed at/near the take-profit), "stop" (closed at/near the stop loss), "breakeven" (closed at/near entry), "trailed" (closed at a trailed stop between entry and target), "manual_early" (closed in profit well before target), "manual_late" (closed after giving back a large part of the move), or "other" if you cannot tell.
- If NOTHING in the image shows an exit, set isClosed to false and leave exitPrice, exitTime and exitReason null. Never invent an exit.

Symbol normalization (applies to both A and B): report the CANONICAL ROOT instrument, not the specific dated contract. Micro and full-size futures on the same underlying are the same instrument: MNQ = NQ (Micro E-mini Nasdaq-100), MES = ES (Micro E-mini S&P 500). Also strip any trailing month/year contract code (a single letter from FGHJKMNQUVXZ followed by 1-2 digits) before applying that mapping — e.g. "MNQU6" -> "NQ", "ESZ5" -> "ES", "MNQ" -> "NQ". For any symbol/ticker that isn't a recognized futures alias (stocks, crypto, forex, etc.), just return it as printed.

Respond with STRICT JSON only, no prose, no markdown fences:
{"symbol": string|null, "direction": "long"|"short"|null, "entryPrice": number|null, "initialStop": number|null, "initialTarget": number|null, "entryTime": string|null, "size": number|null, "isClosed": boolean, "exitPrice": number|null, "exitTime": string|null, "exitReason": "target"|"stop"|"trailed"|"manual_early"|"manual_late"|"breakeven"|"other"|null}

Rules:
- Output ONLY the JSON object. Do not wrap it in markdown code fences, do not add explanations, citations or any prose before or after it.
- entryTime and exitTime must be ISO 8601 strings if a date/time is legible, otherwise null.
- Use null for anything that is not clearly legible or not applicable. Never guess wildly.
- Numbers must be plain JSON numbers (no currency symbols, no thousands separators, no commas).`;

function outcomePrompt(ctx: {
  symbol?: string;
  direction?: string;
  entryPrice?: number;
  initialStop?: number;
  initialTarget?: number;
}) {
  return `You are reading a TradingView-style chart screenshot taken AFTER a trade closed. It shows the full price path following the entry.

When prices are printed as exact numeric labels on the RIGHT-HAND price axis (the right edge of the chart) next to their coloured lines, read those labels directly for the clearest, most exact values — they are more reliable than estimating off gridlines or candle wicks.

The trade's ORIGINAL plan was:
- symbol: ${ctx.symbol ?? "unknown"}
- direction: ${ctx.direction ?? "unknown"}
- entry price: ${ctx.entryPrice ?? "unknown"}
- original stop loss: ${ctx.initialStop ?? "unknown"}
- original target: ${ctx.initialTarget ?? "unknown"}

Determine, from the visible price path AFTER entry:
1. mae — the worst price reached against the position (lowest low for a long, highest high for a short).
2. mfe — the best price reached in favour of the position (highest high for a long, lowest low for a short).
3. noManagementOutcome — if the ORIGINAL stop and target levels above had been left untouched, which level would price have crossed FIRST? "target_first", "stop_first", or "undetermined" if the visible path never reaches either level or it is not legible.

Respond with STRICT JSON only, no prose, no markdown fences:
{"mae": number|null, "mfe": number|null, "noManagementOutcome": "target_first"|"stop_first"|"undetermined"|null}

Numbers must be plain JSON numbers. Use null when a value is not legible.`;
}

const RATIONALE_PROMPT = `You are a trading journal assistant. A trader jotted a quick, shorthand comment explaining WHY they took a trade — they typed fast and did not bother with full sentences or proper labeling.

Common shorthand you should recognize and expand: VAH / VAL / POC (volume profile Value Area High / Low / Point of Control), fib retracement levels written as bare numbers like "786", ".786", "618" (meaning the 78.6% / 61.8% Fibonacci retracement), "retest", "reject"/"rejection", OB (order block), FVG (fair value gap), liquidity sweep/grab, breakout, breakdown, EMA/VWAP bounce or reject, trendline break, supply/demand zone, higher-high/higher-low (HH/HL) or lower-high/lower-low (LH/LL) structure, news/FOMC, open range, gap fill.

Turn the comment into a short list of clean, standardized setup tags (Title Case, 2-5 words each) that capture the trader's stated reasoning — do not invent reasoning that isn't implied by the comment, and do not add generic tags like "Trade" or "Setup". If the comment contains no recognizable setup language, return an empty list rather than guessing.

Comment: "{{TEXT}}"

Respond with STRICT JSON only, no prose, no markdown fences:
{"tags": string[]}`;

function splitDataUrl(image: string): { mediaType: string; data: string } {
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(image.trim());
  if (m) return { mediaType: m[1], data: m[2] };
  return { mediaType: "image/png", data: image.trim() };
}

function extractJson(text: string): any {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Model returned no JSON object");
  return JSON.parse(raw.slice(start, end + 1));
}

const tradeBodySchema = z.object({
  trade: insertTradeSchema,
  mistakeTagIds: z.array(z.number()).optional(),
});

const tradeUpdateBodySchema = z.object({
  trade: updateTradeSchema,
  mistakeTagIds: z.array(z.number()).optional(),
});

/* ----------------------- Perplexity Sonar transport ----------------------- */
/**
 * The app talks to the Perplexity chat-completions API through ONE of two paths,
 * depending on where it is running. Both end up POSTing the exact same body to
 * `<base>/chat/completions` — only the base URL and the auth header differ.
 *
 *  1. PRODUCTION (published site). The user's custom credential is injected as
 *     two env vars. `CUSTOM_CRED_API_PERPLEXITY_AI_URL` is a proxy endpoint that
 *     forwards to the real Perplexity API with the secret key attached
 *     server-side; we authenticate to *it* with `x-api-key`. There is no
 *     outbound HTTPS proxy in production, so a plain direct request is correct.
 *
 *  2. DEV SANDBOX (`api_credentials=["custom-cred:api.perplexity.ai"]`). No
 *     custom-cred env vars are set, so we hit `https://api.perplexity.ai`
 *     directly and the sandbox's HTTPS_PROXY transparently injects the
 *     `Authorization: Bearer <key>` header. Node's built-in `fetch` does NOT
 *     honour HTTPS_PROXY, so we must route through undici's ProxyAgent
 *     explicitly — otherwise the request bypasses the proxy and 401s.
 */
const PPLX_PROXY_URL = process.env.CUSTOM_CRED_API_PERPLEXITY_AI_URL;
const PPLX_PROXY_TOKEN = process.env.CUSTOM_CRED_API_PERPLEXITY_AI_TOKEN;
const PPLX_BASE = (PPLX_PROXY_URL || "https://api.perplexity.ai").replace(/\/+$/, "");

/** Lazily-built dispatcher for the dev sandbox's credential-injecting proxy. */
let proxyDispatcher: ProxyAgent | undefined;
function sandboxDispatcher(): ProxyAgent | undefined {
  // Only relevant when we're calling api.perplexity.ai directly (dev sandbox).
  if (PPLX_PROXY_URL) return undefined;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return undefined;
  if (!proxyDispatcher) proxyDispatcher = new ProxyAgent(proxy);
  return proxyDispatcher;
}

async function callLLM(systemPrompt: string, image?: { mediaType: string; data: string }) {
  const content: any[] = [];
  if (image) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    });
  }
  content.push({ type: "text", text: systemPrompt });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (PPLX_PROXY_URL) {
    // Production credential proxy expects x-api-key; it attaches the real key.
    headers["x-api-key"] = PPLX_PROXY_TOKEN ?? "";
  }

  const res = await undiciFetch(`${PPLX_BASE}/chat/completions`, {
    method: "POST",
    headers,
    dispatcher: sandboxDispatcher(),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: image ? 1024 : 256,
      // These prompts are pure vision/text extraction — web search adds latency,
      // cost and citation noise, and can bleed into the JSON output.
      disable_search: true,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Perplexity API ${res.status}: ${body.slice(0, 300)}`);
  }

  const json: any = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Perplexity API returned no message content");
  }
  return text;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  /* ------------------------------- trades ------------------------------- */
  app.get("/api/trades", async (_req, res) => {
    res.json(await storage.listTrades());
  });

  app.get("/api/trades/:id", async (req, res) => {
    const t = await storage.getTrade(Number(req.params.id));
    if (!t) return res.status(404).json({ message: "Trade not found" });
    res.json(t);
  });

  app.post("/api/trades", async (req, res) => {
    const parsed = tradeBodySchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid trade", issues: parsed.error.issues });
    const trade = { ...parsed.data.trade, symbol: normalizeSymbol(parsed.data.trade.symbol) };
    res.status(201).json(
      await storage.createTrade(trade, parsed.data.mistakeTagIds ?? []),
    );
  });

  app.patch("/api/trades/:id", async (req, res) => {
    const parsed = tradeUpdateBodySchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid trade", issues: parsed.error.issues });
    const trade = parsed.data.trade.symbol
      ? { ...parsed.data.trade, symbol: normalizeSymbol(parsed.data.trade.symbol) }
      : parsed.data.trade;
    const updated = await storage.updateTrade(
      Number(req.params.id),
      trade,
      parsed.data.mistakeTagIds,
    );
    if (!updated) return res.status(404).json({ message: "Trade not found" });
    res.json(updated);
  });

  app.delete("/api/trades/:id", async (req, res) => {
    await storage.deleteTrade(Number(req.params.id));
    res.status(204).end();
  });

  /* ---------------------------- mistake tags ---------------------------- */
  app.get("/api/mistake-tags", async (_req, res) => {
    res.json(await storage.listMistakeTags());
  });

  app.post("/api/mistake-tags", async (req, res) => {
    const parsed = insertMistakeTagSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid tag", issues: parsed.error.issues });
    res.status(201).json(await storage.createMistakeTag(parsed.data));
  });

  app.patch("/api/mistake-tags/:id", async (req, res) => {
    const parsed = insertMistakeTagSchema.partial().safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid tag", issues: parsed.error.issues });
    const updated = await storage.updateMistakeTag(Number(req.params.id), parsed.data);
    if (!updated) return res.status(404).json({ message: "Tag not found" });
    res.json(updated);
  });

  app.delete("/api/mistake-tags/:id", async (req, res) => {
    await storage.deleteMistakeTag(Number(req.params.id));
    res.status(204).end();
  });

  /* --------------------------- weekly reviews --------------------------- */
  app.get("/api/weekly-reviews", async (_req, res) => {
    res.json(await storage.listWeeklyReviews());
  });

  app.post("/api/weekly-reviews", async (req, res) => {
    const parsed = insertWeeklyReviewSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid review", issues: parsed.error.issues });
    res.status(201).json(await storage.createWeeklyReview(parsed.data));
  });

  /* ------------------------ AI screenshot parsing ----------------------- */
  app.post("/api/parse-screenshot", async (req, res) => {
    const parsed = parseScreenshotSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });

    const { image, kind, context } = parsed.data;
    const { mediaType, data } = splitDataUrl(image);

    try {
      const text = await callLLM(
        kind === "setup" ? SETUP_PROMPT : outcomePrompt(context ?? {}),
        { mediaType, data },
      );
      const json = extractJson(text);
      if (kind === "setup") {
        if (json.symbol) json.symbol = normalizeSymbol(json.symbol);
        // A screenshot only counts as a closed trade if a usable exit price came
        // back with it — otherwise fall back to the normal open-trade flow.
        if (json.isClosed !== true || typeof json.exitPrice !== "number") {
          json.isClosed = false;
          json.exitPrice = null;
          json.exitTime = null;
          json.exitReason = null;
        }
      }
      res.json({ ok: true, kind, result: json });
    } catch (err: any) {
      console.error("parse-screenshot failed:", err?.message || err);
      res.status(502).json({
        ok: false,
        message:
          "Could not read that screenshot automatically. Enter the values manually.",
        detail: String(err?.message || err),
      });
    }
  });

  /* ------------------------ AI rationale tagging ------------------------ */
  app.post("/api/analyze-rationale", async (req, res) => {
    const parsed = analyzeRationaleSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });

    try {
      const prompt = RATIONALE_PROMPT.replace("{{TEXT}}", parsed.data.text.slice(0, 500));
      const text = await callLLM(prompt);
      const json = extractJson(text);
      const tags = Array.isArray(json.tags) ? json.tags.filter((t: any) => typeof t === "string") : [];
      res.json({ ok: true, tags });
    } catch (err: any) {
      console.error("analyze-rationale failed:", err?.message || err);
      res.status(502).json({ ok: false, tags: [], message: "Could not analyze that comment." });
    }
  });

  return httpServer;
}
