import type { Express } from "express";
import type { Server } from "node:http";
import { storage } from "./storage";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import Anthropic from "@anthropic-ai/sdk";
import {
  insertTradeSchema,
  updateTradeSchema,
  insertMistakeTagSchema,
  insertTradingStyleSchema,
  insertWeeklyReviewSchema,
  parseScreenshotSchema,
  analyzeRationaleSchema,
  directionEnum,
  sizeUnitEnum,
} from "@shared/schema";
import { normalizeSymbol, pointValueFor } from "@shared/symbols";
import {
  buildInsightsBundle,
  startOfWeek,
  weekStartKey,
} from "@shared/weekly-insights";
import { z } from "zod";

/**
 * Perplexity Sonar — `sonar-pro` supports vision (image_url content blocks) and
 * is OpenAI-chat-completions compatible.
 */
const MODEL = "sonar-pro";

/** Claude reads prices off a chart axis more reliably than sonar-pro. */
const ANTHROPIC_MODEL = "claude-opus-5";

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

Symbol: report the ticker EXACTLY as printed on the screenshot — "MNQU6", not "NQ". Do not roll a micro up to its full-size sibling and do not strip the month/year contract code. The application does that rollup itself, and it needs the contract as written to tell a micro apart from an e-mini: they are the same instrument for grouping but differ tenfold in dollars per point.

ALSO REPORT whether this image is an orders TABLE (many resting orders, one per row) rather than a single chart or a single position. Set looksLikeOrdersTable true only for a multi-row list of orders — a chart, or a log describing one position, is false.

Respond with STRICT JSON only, no prose, no markdown fences:
{"symbol": string|null, "direction": "long"|"short"|null, "entryPrice": number|null, "initialStop": number|null, "initialTarget": number|null, "entryTime": string|null, "size": number|null, "isClosed": boolean, "exitPrice": number|null, "exitTime": string|null, "exitReason": "target"|"stop"|"trailed"|"manual_early"|"manual_late"|"breakeven"|"other"|null, "looksLikeOrdersTable": boolean}

Rules:
- Output ONLY the JSON object. Do not wrap it in markdown code fences, do not add explanations, citations or any prose before or after it.
- entryTime and exitTime must be ISO 8601 strings if a date/time is legible, otherwise null.
- Use null for anything that is not clearly legible or not applicable. Never guess wildly.
- Numbers must be plain JSON numbers (no currency symbols, no thousands separators, no commas).`;

/**
 * Reads an orders table screenshot as MANY resting orders, not one position.
 *
 * SETUP_PROMPT deliberately hunts for the single order that opened a position;
 * this is the opposite job — a venue's open-orders list, every row of which is
 * a trade that could still open. Kept as a separate prompt because merging the
 * two would make both worse: "find the one that matters" and "return all of
 * them" pull in opposite directions.
 */
const ORDERS_PROMPT = `You are reading a screenshot of a trading venue's ORDERS table — a list of resting/open orders that have not been filled yet. Extract EVERY order row you can read.

Common shapes:
(A) Crypto exchange (Binance and similar): columns like Time, Symbol, Type, Side, Price, Amount, Filled, Reduce Only. Side reads "Open Long"/"Open Short" or "Buy"/"Sell". Amount is usually quote notional such as "37,177.47 USDT". This view typically has NO stop loss or take profit — leave them null, do not invent them.
(B) Futures broker / DOM: columns like Symbol, Side, Type, Qty, Remaining Qty, Filled Qty, Limit Price, Stop Price, Take Profit, Stop Loss, Avg Fill Price, Update Time. Qty is contracts. Take Profit maps to initialTarget and Stop Loss to initialStop.

For every row:
- direction: "long" for Buy / Open Long, "short" for Sell / Open Short.
- entryPrice: the limit/entry price for that order (Price, or Limit Price).
- size: the position size as printed.
- sizeUnit: "quote" when the size is a currency amount (e.g. "4,655.18 USDT" — a USD/USDT notional), "base" when it is a contract or coin count (e.g. Qty 2).
- initialStop / initialTarget: only if the table actually shows them; otherwise null.
- entryTime: the row's timestamp as ISO 8601 if legible, otherwise null.
- symbol: the ticker as printed, minus any "Perp" badge.

Rules:
- Return EVERY data row. Do not skip duplicates — two rows on the same symbol at different prices are two separate orders.
- Ignore header rows, totals, and any row that is clearly a filled/closed position rather than a resting order.
- Output ONLY this JSON object, no prose and no markdown fences:
{"orders": [{"symbol": string|null, "direction": "long"|"short"|null, "size": number|null, "sizeUnit": "base"|"quote"|null, "entryPrice": number|null, "initialStop": number|null, "initialTarget": number|null, "entryTime": string|null}]}
- Numbers must be plain JSON numbers: no currency symbols, no thousands separators.
- If you cannot read a field, use null rather than guessing.
- If the image is not an orders table at all, return {"orders": []}.`;

/**
 * Reads a week of written reflections against the week's numbers.
 *
 * The value here is the cross-reference, not the summary: the trader already
 * knows what they wrote and can already see the stats. What neither shows on its
 * own is whether the story in the notes matches the record — hence the explicit
 * instruction to report where they disagree, and the ban on inventing a pattern
 * from a single trade.
 */
const WEEKLY_INSIGHTS_PROMPT = `You are reviewing one week of a trader's journal. You get two things: their own written reflections on individual trades, and the computed statistics for the same week.

The reflections are where they wrote what they would have done differently, or what the "perfect version" of the trade looked like. Those are self-diagnoses. The statistics are the record. Your job is to find what is TRUE ACROSS the week — not to summarise trade by trade, which they can already read.

Produce four things:

1. themes — recurring ideas that appear in MULTIPLE reflections. A theme needs at least two trades behind it; one trade is an anecdote, not a pattern. For each, give the theme in the trader's own vocabulary where possible, how many trades it appeared in, and up to two short verbatim fragments as evidence. If nothing recurs, return an empty list rather than padding it.

2. focus — the single most correctable pattern to work on next week, and one sentence on why that one. Prefer a pattern that is both frequent AND expensive over one that is merely annoying. Exactly one.

3. oneChange — one concrete, checkable action for next week. It must be something they could verify they did or did not do ("wait for a 5m close beyond the level before entering"), not an attitude ("be more patient").

4. contradictions — places the reflections and the numbers DISAGREE. This is the most valuable output. Examples: notes repeatedly blame exiting too early while the capture ratio is high; notes describe good discipline while the same demon fired five times; notes never mention size while the losses cluster in the largest positions. If there is no genuine disagreement, return an empty list — do not manufacture one.

Rules:
- Ground every claim in the data you were given. Never infer trades, prices, or events that are not present.
- A negative totalDeltaR means their management LOST money versus leaving the trade alone; positive means it gained.
- Do not moralise, and do not give generic trading advice. Say only what this week's evidence supports.
- Write in second person, plainly, no preamble.
- Output ONLY this JSON object, no prose and no markdown fences:
{"themes": [{"theme": string, "occurrences": number, "evidence": [string]}], "focus": {"name": string, "why": string}, "oneChange": string, "contradictions": [string]}

Here is the week:
{{BUNDLE}}`;

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

/** Confirmed import candidates. Stop and target stay optional — these land as pending. */
const importBodySchema = z.object({
  styleId: z.number().int().nullable().optional(),
  trades: z
    .array(
      z.object({
        symbol: z.string().min(1),
        direction: directionEnum,
        size: z.number().positive(),
        sizeUnit: sizeUnitEnum.optional(),
        entryPrice: z.number(),
        initialStop: z.number().nullable().optional(),
        initialTarget: z.number().nullable().optional(),
        entryTime: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

/* ----------------------- Perplexity Sonar transport ----------------------- */
/**
 * The app talks to the Perplexity chat-completions API through ONE of three
 * paths, depending on where it is running. All three POST the exact same body to
 * `<base>/chat/completions` — only the base URL and the auth header differ.
 *
 *  1. STANDARD (local dev, Vercel, anywhere outside Perplexity Computer). Set
 *     `PERPLEXITY_API_KEY` and we hit the real API directly with
 *     `Authorization: Bearer <key>`. Takes precedence over the two paths below,
 *     which are inert outside Perplexity's own platform.
 *
 *  2. PERPLEXITY COMPUTER PRODUCTION (published site). The user's custom
 *     credential is injected as two env vars.
 *     `CUSTOM_CRED_API_PERPLEXITY_AI_URL` is a proxy endpoint that forwards to
 *     the real Perplexity API with the secret key attached server-side; we
 *     authenticate to *it* with `x-api-key`. There is no outbound HTTPS proxy in
 *     production, so a plain direct request is correct.
 *
 *  3. PERPLEXITY COMPUTER DEV SANDBOX
 *     (`api_credentials=["custom-cred:api.perplexity.ai"]`). No custom-cred env
 *     vars are set, so we hit `https://api.perplexity.ai` directly and the
 *     sandbox's HTTPS_PROXY transparently injects the `Authorization: Bearer
 *     <key>` header. Node's built-in `fetch` does NOT honour HTTPS_PROXY, so we
 *     must route through undici's ProxyAgent explicitly — otherwise the request
 *     bypasses the proxy and 401s.
 */
const PPLX_API_KEY = process.env.PERPLEXITY_API_KEY;
const PPLX_PROXY_URL = process.env.CUSTOM_CRED_API_PERPLEXITY_AI_URL;
const PPLX_PROXY_TOKEN = process.env.CUSTOM_CRED_API_PERPLEXITY_AI_TOKEN;
const PPLX_BASE = (
  PPLX_API_KEY ? "https://api.perplexity.ai" : PPLX_PROXY_URL || "https://api.perplexity.ai"
).replace(/\/+$/, "");

/** Lazily-built dispatcher for the dev sandbox's credential-injecting proxy. */
let proxyDispatcher: ProxyAgent | undefined;
function sandboxDispatcher(): ProxyAgent | undefined {
  // Only relevant when we're calling api.perplexity.ai directly (dev sandbox).
  // A direct API key authenticates on its own, so never proxy in that case.
  if (PPLX_API_KEY || PPLX_PROXY_URL) return undefined;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return undefined;
  if (!proxyDispatcher) proxyDispatcher = new ProxyAgent(proxy);
  return proxyDispatcher;
}

/* ---------------------------- Anthropic transport ---------------------------- */
/**
 * Preferred provider when ANTHROPIC_API_KEY is set. Claude is markedly better
 * at reading exact prices off a chart's right-hand axis, which is the whole
 * job of SETUP_PROMPT.
 */
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

let anthropicClient: Anthropic | undefined;
function anthropic(): Anthropic {
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  return anthropicClient;
}

async function callAnthropic(
  systemPrompt: string,
  image?: { mediaType: string; data: string },
) {
  const content: Anthropic.ContentBlockParam[] = [];
  if (image) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
        data: image.data,
      },
    });
  }
  content.push({ type: "text", text: systemPrompt });

  const res = await anthropic().messages.create({
    model: ANTHROPIC_MODEL,
    // Thinking is on by default and shares this budget with the reply, so keep
    // headroom even though the reply itself is a small JSON object.
    max_tokens: 8192,
    output_config: { effort: "low" },
    messages: [{ role: "user", content }],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text.trim()) throw new Error("Anthropic API returned no text content");
  return text;
}

/** True when a Perplexity call could actually authenticate. */
function perplexityAvailable(): boolean {
  return Boolean(PPLX_API_KEY || PPLX_PROXY_URL || sandboxDispatcher());
}

/**
 * Anthropic first when its key is present — Claude reads prices off a chart
 * axis more reliably — but never at the cost of the feature working.
 *
 * A configured provider can fail for reasons that have nothing to do with the
 * screenshot: an exhausted credit balance, an expired key, a transient 5xx. In
 * that situation the other provider is right there and funded, so preferring
 * one must not mean depending on it. Any Anthropic failure therefore falls
 * through to Perplexity when Perplexity is usable.
 *
 * If there is no fallback configured the original error is rethrown untouched,
 * because a message like "credit balance is too low" is precisely what the
 * caller needs to see.
 */
async function callLLM(systemPrompt: string, image?: { mediaType: string; data: string }) {
  if (!ANTHROPIC_API_KEY) return callPerplexity(systemPrompt, image);

  try {
    return await callAnthropic(systemPrompt, image);
  } catch (err: any) {
    if (!perplexityAvailable()) throw err;
    console.warn(
      `[ai] Anthropic failed, falling back to Perplexity: ${err?.message ?? err}`,
    );
    return await callPerplexity(systemPrompt, image);
  }
}

async function callPerplexity(systemPrompt: string, image?: { mediaType: string; data: string }) {
  const content: any[] = [];
  if (image) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    });
  }
  content.push({ type: "text", text: systemPrompt });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (PPLX_API_KEY) {
    headers["Authorization"] = `Bearer ${PPLX_API_KEY}`;
  } else if (PPLX_PROXY_URL) {
    // Production credential proxy expects x-api-key; it attaches the real key.
    headers["x-api-key"] = PPLX_PROXY_TOKEN ?? "";
  } else if (!sandboxDispatcher()) {
    throw new Error(
      "No AI credentials configured. Set ANTHROPIC_API_KEY (recommended) or PERPLEXITY_API_KEY in .env.",
    );
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
    // Derive the point value from the symbol AS TYPED, before normalization
    // collapses "MNQU6" into "NQ" — that collapse is what keeps the stats
    // merged, and it is also what would otherwise lose the $2-vs-$20 distinction.
    const trade = {
      ...parsed.data.trade,
      pointValue: parsed.data.trade.pointValue ?? pointValueFor(parsed.data.trade.symbol),
      symbol: normalizeSymbol(parsed.data.trade.symbol),
    };
    res.status(201).json(
      await storage.createTrade(trade, parsed.data.mistakeTagIds ?? []),
    );
  });

  app.patch("/api/trades/:id", async (req, res) => {
    const parsed = tradeUpdateBodySchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid trade", issues: parsed.error.issues });
    // The merged row is needed twice below — for the point value and for the
    // stop/target rule — because a PATCH carries only what changed.
    const existing = await storage.getTrade(Number(req.params.id));
    if (!existing) return res.status(404).json({ message: "Trade not found" });

    /*
     * Point value must NOT be re-derived from an unchanged symbol.
     *
     * Only the normalized root is stored, so an MNQ trade reads back as "NQ".
     * The edit form round-trips that stored value, and deriving from it would
     * silently promote a micro to its full-size sibling — 2 → 20, a tenfold
     * jump in every dollar figure, from merely opening a trade and saving it.
     *
     * Comparing normalized roots distinguishes the two cases exactly: a genuine
     * instrument change (NQ → ES) differs and re-derives, while the ambiguous
     * MNQ/NQ round-trip does not and keeps what was stored at creation.
     */
    const nextSymbol = parsed.data.trade.symbol
      ? normalizeSymbol(parsed.data.trade.symbol)
      : undefined;
    const instrumentChanged = nextSymbol != null && nextSymbol !== existing.symbol;

    const trade = parsed.data.trade.symbol
      ? {
          ...parsed.data.trade,
          ...(parsed.data.trade.pointValue != null
            ? {}
            : instrumentChanged
              ? { pointValue: pointValueFor(parsed.data.trade.symbol) }
              : {}),
          symbol: nextSymbol!,
        }
      : parsed.data.trade;

    const merged = { ...existing, ...trade };
    if ((merged.status ?? "open") !== "pending") {
      const missing = (["initialStop", "initialTarget"] as const).filter(
        (f) => merged[f] == null,
      );
      if (missing.length) {
        return res.status(400).json({
          message:
            "A trade needs a stop and a target once it is open — 1R is measured entry-to-stop.",
          issues: missing.map((f) => ({ path: ["trade", f], message: `${f} is required` })),
        });
      }
    }

    const updated = await storage.updateTrade(
      Number(req.params.id),
      trade,
      parsed.data.mistakeTagIds,
    );
    if (!updated) return res.status(404).json({ message: "Trade not found" });
    res.json(updated);
  });

  /**
   * Batch import of resting orders pasted from a venue. Parsing is shared with
   * the client (shared/import-parse.ts) so the preview the user confirmed is
   * exactly what gets re-derived here — the client sends candidates, never raw
   * text it has already interpreted differently.
   */
  app.post("/api/trades/import", async (req, res) => {
    const parsed = importBodySchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid import", issues: parsed.error.issues });

    const now = new Date().toISOString();
    const created = [];
    for (const c of parsed.data.trades) {
      created.push(
        await storage.createTrade(
          {
            styleId: parsed.data.styleId ?? null,
            symbol: normalizeSymbol(c.symbol),
            pointValue: pointValueFor(c.symbol),
            direction: c.direction,
            size: c.size,
            sizeUnit: c.sizeUnit ?? "base",
            entryPrice: c.entryPrice,
            initialStop: c.initialStop ?? null,
            initialTarget: c.initialTarget ?? null,
            entryTime: c.entryTime ?? now,
            status: "pending",
          },
          [],
        ),
      );
    }
    res.status(201).json({ imported: created.length, trades: created });
  });

  app.delete("/api/trades/:id", async (req, res) => {
    await storage.deleteTrade(Number(req.params.id));
    res.status(204).end();
  });

  /* --------------------------- trading styles --------------------------- */
  app.get("/api/styles", async (_req, res) => {
    res.json(await storage.listTradingStyles());
  });

  app.post("/api/styles", async (req, res) => {
    const parsed = insertTradingStyleSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid style", issues: parsed.error.issues });
    res.status(201).json(await storage.createTradingStyle(parsed.data));
  });

  app.patch("/api/styles/:id", async (req, res) => {
    const parsed = insertTradingStyleSchema.partial().safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid style", issues: parsed.error.issues });
    const updated = await storage.updateTradingStyle(Number(req.params.id), parsed.data);
    if (!updated) return res.status(404).json({ message: "Style not found" });
    res.json(updated);
  });

  app.delete("/api/styles/:id", async (req, res) => {
    await storage.deleteTradingStyle(Number(req.params.id));
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

  /**
   * Generate (or return) the week's insights.
   *
   * The bundle is rebuilt server-side from stored trades rather than accepted
   * from the client — the analysis is only worth anything if it reflects the
   * record, not a payload someone assembled. Results are persisted per week so
   * this costs one model call a week rather than one per page load.
   */
  app.post("/api/weekly-insights", async (req, res) => {
    const weekStartInput =
      typeof req.body?.weekStart === "string" ? req.body.weekStart : undefined;
    const force = req.body?.force === true;

    const weekDate = weekStartInput
      ? startOfWeek(new Date(`${weekStartInput}T00:00:00`))
      : startOfWeek();
    const key = weekStartKey(weekDate);

    const existing = (await storage.listWeeklyReviews()).find(
      (r) => r.weekStart === key,
    );
    if (existing?.insights && !force) {
      return res.json({ ok: true, cached: true, weekStart: key, insights: JSON.parse(existing.insights) });
    }

    const [trades, tags] = await Promise.all([
      storage.listTrades(),
      storage.listMistakeTags(),
    ]);
    const bundle = buildInsightsBundle(trades, tags, weekDate);

    // Without written reflections there is nothing for this to read. Saying so
    // beats spending a model call to produce a paraphrase of the stats.
    if (bundle.reflectionCount === 0) {
      return res.json({
        ok: false,
        weekStart: key,
        bundle,
        message:
          bundle.closedCount === 0
            ? "No closed trades this week yet."
            : "No notes on this week's trades. Write what you'd have done differently and this gets something to work with.",
      });
    }

    try {
      const text = await callLLM(
        WEEKLY_INSIGHTS_PROMPT.replace("{{BUNDLE}}", JSON.stringify(bundle, null, 1)),
      );
      const insights = extractJson(text);

      await storage.upsertWeeklyInsights(key, JSON.stringify(insights));
      res.json({ ok: true, cached: false, weekStart: key, bundle, insights });
    } catch (err: any) {
      console.error("weekly-insights failed:", err?.message || err);
      res.status(502).json({
        ok: false,
        weekStart: key,
        bundle,
        message: "Could not generate insights right now.",
        detail: String(err?.message || err),
      });
    }
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
      const prompt =
        kind === "setup"
          ? SETUP_PROMPT
          : kind === "orders"
            ? ORDERS_PROMPT
            : outcomePrompt(context ?? {});
      const text = await callLLM(prompt, { mediaType, data });
      const json = extractJson(text);

      if (kind === "orders") {
        // Drop rows the model couldn't read the essentials of rather than
        // surfacing half-rows the user then has to spot and delete.
        const rows = Array.isArray(json?.orders) ? json.orders : [];
        const usable = rows
          .filter(
            (o: any) =>
              o &&
              typeof o.entryPrice === "number" &&
              (o.direction === "long" || o.direction === "short"),
          )
          .map((o: any) => ({
            ...o,
            symbol: o.symbol ? normalizeSymbol(o.symbol) : null,
            sizeUnit: o.sizeUnit === "quote" ? "quote" : "base",
          }));
        return res.json({
          ok: true,
          kind,
          result: { orders: usable, skipped: rows.length - usable.length },
        });
      }

      if (kind === "setup") {
        /*
         * Deliberately NOT normalized here. The contract as written ("MNQU6")
         * is what tells a micro apart from an e-mini — $2 a point versus $20 —
         * and the point value is derived from it when the trade is saved.
         * Rolling it up to "NQ" at this point discards that and silently
         * multiplies every dollar figure on a micro trade by ten. The rollup
         * still happens, on the way into the database.
         */
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
