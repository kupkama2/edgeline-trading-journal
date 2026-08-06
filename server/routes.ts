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
  upsertDailyNoteSchema,
  parseScreenshotSchema,
  analyzeRationaleSchema,
  directionEnum,
  sizeUnitEnum,
} from "@shared/schema";
import { normalizeSymbol, pointValueFor } from "@shared/symbols";
import {
  ORDERS_PROMPT,
  RATIONALE_PROMPT,
  SETUP_PROMPT,
  WEEKLY_INSIGHTS_PROMPT,
  outcomePrompt,
} from "./prompts";
import { tradesToCsv } from "@shared/csv";
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

/**
 * Rows confirmed in the CSV import preview.
 *
 * Unlike the paste importer these land as history rather than resting orders,
 * so an entry time is required — a backfilled trade with no timestamp would sit
 * on today's calendar and quietly corrupt every time-of-day breakdown.
 */
const csvImportBodySchema = z.object({
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
        exitPrice: z.number().nullable().optional(),
        entryTime: z.string().min(1),
        exitTime: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(5000),
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

  /**
   * The whole journal as one CSV, metrics already computed.
   *
   * No set of built-in reports anticipates every question, and the answer to
   * that is not more reports — it is handing over the data in a form a
   * spreadsheet or a notebook can chew on. Derived columns are written out
   * rather than left to the reader, because recreating R from size unit,
   * contract point value and direction in a spreadsheet formula is exactly
   * where an analysis quietly goes wrong.
   */
  app.get("/api/export.csv", async (_req, res) => {
    const [trades, tags, styles] = await Promise.all([
      storage.listTrades(),
      storage.listMistakeTags(),
      storage.listTradingStyles(),
    ]);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="edgeline-${stamp}.csv"`);
    res.send(tradesToCsv(trades, tags, styles));
  });

  /**
   * Backfill history from a broker's CSV.
   *
   * The client parses the file and previews it, then sends rows — the same
   * arrangement as the paste importer, so what was confirmed on screen is what
   * lands. Rows arrive as CLOSED trades when they carry an exit and open ones
   * otherwise, since a history export is by definition trades that already
   * happened.
   */
  app.post("/api/trades/import-csv", async (req, res) => {
    const parsed = csvImportBodySchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid import", issues: parsed.error.issues });

    const created = [];
    for (const c of parsed.data.trades) {
      const closed = c.exitPrice != null;
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
            entryTime: c.entryTime,
            exitPrice: c.exitPrice ?? null,
            exitTime: c.exitTime ?? c.entryTime,
            // An imported row has no stop unless the broker exported one, and
            // R is undefined without it. That is recorded honestly as an
            // "other" exit rather than guessed at from the P&L sign.
            status: closed ? "closed" : "open",
            exitReason: closed ? "other" : null,
            notes: c.notes ?? null,
          },
          [],
        ),
      );
    }
    res.status(201).json({ imported: created.length });
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

  /* ---------------------------- daily notes ----------------------------- */
  // The list is returned whole: notes are one text per day and the client
  // renders a calendar over them, so per-day fetches would just be N trips.
  app.get("/api/daily-notes", async (_req, res) => {
    res.json(await storage.listDailyNotes());
  });

  app.put("/api/daily-notes/:day", async (req, res) => {
    const day = req.params.day;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
      return res.status(400).json({ message: "Day must be yyyy-MM-dd" });
    const parsed = upsertDailyNoteSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid note", issues: parsed.error.issues });
    res.json(await storage.upsertDailyNote(day, parsed.data.body));
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
            // Deliberately NOT normalised: /api/trades/import derives pointValue
            // from the ticker as written, and "MNQU6" folded to "NQ" here would
            // price a micro at $20 a point instead of $2. Roll-up happens on
            // commit, where the raw string is still available.
            symbol: o.symbol ? String(o.symbol).trim().toUpperCase() : null,
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
