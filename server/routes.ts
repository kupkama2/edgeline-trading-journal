import type { Express } from "express";
import type { Server } from "node:http";
import { storageFor } from "./storage";
// Deliberately unscoped, and the one exception that proves the rule: the
// allowlist is consulted before there is an account to scope to. It holds no
// trade data, so the isolation guarantee is untouched.
import { invitations } from "./storage";
import { envAllowlist } from "./auth";

/**
 * The account's storage for this request.
 *
 * Every handler goes through here rather than a module-level singleton, which
 * is what makes cross-account reads impossible to write: there is no storage
 * object in this file that isn't tied to the signed-in user. requireUser has
 * already run (see setupAuth), so a missing id is a wiring bug, not a request
 * a visitor can make — hence the throw rather than a 401.
 */
function store(req: { userId?: number }) {
  if (!req.userId) throw new Error("no account on request — auth middleware missing");
  return storageFor(req.userId);
}
import { ProxyAgent, fetch as undiciFetch } from "undici";
import Anthropic from "@anthropic-ai/sdk";
import {
  insertTradeSchema,
  updateTradeSchema,
  insertMistakeTagSchema,
  insertTradingStyleSchema,
  insertWeeklyReviewSchema,
  upsertDailyNoteSchema,
  addTradeImageSchema,
  addFillSchema,
  upsertAccountSettingsSchema,
  parseScreenshotSchema,
  analyzeRationaleSchema,
  directionEnum,
  sizeUnitEnum,
} from "@shared/schema";
import {
  contractFor,
  lastPointValueFor,
  looksLikeFuturesContract,
  normalizeSymbol,
  splitTypedSymbol,
  pointValueFor,
} from "@shared/symbols";
import {
  ORDERS_PROMPT,
  RATIONALE_PROMPT,
  SETUP_PROMPT,
  WEEKLY_INSIGHTS_PROMPT,
  outcomePrompt,
} from "./prompts";
import { tradesToCsv } from "@shared/csv";
import { validateFill } from "@shared/fills";
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
  app.get("/api/trades", async (req, res) => {
    res.json(await store(req).listTrades());
  });

  app.get("/api/trades/:id", async (req, res) => {
    const t = await store(req).getTrade(Number(req.params.id));
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
    //
    // Three sources, in order: what the request said (the entry card lets you
    // set the size of a contract the table has never heard of), what the table
    // knows, then what this symbol was worth last time it was logged. That
    // last one is why a nano contract only has to be explained once.
    //
    // The instrument and the contract are separated here. When the client
    // sends both it has already decided (the entry card lets you say a nano
    // listing belongs to "BTC"); otherwise the contract is whatever was typed
    // and the instrument is its rollup.
    const body = parsed.data.trade;
    const typed = (body.contract || body.symbol).trim().toUpperCase();
    const isContract = Boolean(contractFor(typed)) || looksLikeFuturesContract(typed);
    const remembered = lastPointValueFor(typed, await store(req).listTrades());
    const trade = {
      ...body,
      pointValue: body.pointValue ?? pointValueFor(typed, remembered),
      symbol: body.contract ? body.symbol.trim().toUpperCase() : normalizeSymbol(typed),
      // Nothing to record for a stock or a spot pair — there is no contract to
      // tell apart from the instrument.
      contract: isContract ? typed : null,
    };
    res.status(201).json(
      await store(req).createTrade(trade, parsed.data.mistakeTagIds ?? []),
    );
  });

  app.patch("/api/trades/:id", async (req, res) => {
    const parsed = tradeUpdateBodySchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid trade", issues: parsed.error.issues });
    // The merged row is needed twice below — for the point value and for the
    // stop/target rule — because a PATCH carries only what changed.
    const existing = await store(req).getTrade(Number(req.params.id));
    if (!existing) return res.status(404).json({ message: "Trade not found" });

    /*
     * An edited symbol is split into instrument and contract exactly the way
     * creation splits it, because the edit form now sends what the trader
     * actually typed ("MBTZ6") rather than the rollup it used to show ("BTC").
     * Without re-splitting here, changing MBTZ6 to BTCUSDT would leave the old
     * contract attached to the new instrument.
     *
     * Point value must still NOT be re-derived from an UNCHANGED instrument.
     * Legacy rows, and any trade whose contract was never recorded, still read
     * back as the bare root; deriving from that would silently promote a micro
     * to its full-size sibling — 2 to 20, a tenfold jump in every dollar
     * figure, from merely opening a trade and saving it. Comparing normalized
     * roots separates the two cases: a genuine instrument change (NQ to ES)
     * re-derives, an unchanged one keeps what was stored.
     */
    const typedEdit = parsed.data.trade.symbol?.trim().toUpperCase();
    const nextSymbol = typedEdit ? normalizeSymbol(typedEdit) : undefined;
    const instrumentChanged = nextSymbol != null && nextSymbol !== existing.symbol;
    const split = typedEdit ? splitTypedSymbol(typedEdit) : null;

    const trade = typedEdit
      ? {
          ...parsed.data.trade,
          ...(parsed.data.trade.pointValue != null
            ? {}
            : instrumentChanged
              ? { pointValue: pointValueFor(typedEdit) }
              : {}),
          symbol: split!.symbol,
          // A spot pair clears it, a contract sets it, and a round-trip of the
          // same text leaves the stored value exactly as it was.
          contract: split!.contract,
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

    const updated = await store(req).updateTrade(
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
        await store(req).createTrade(
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
    await store(req).deleteTrade(Number(req.params.id));
    res.status(204).end();
  });

  /* ------------------------------ trade fills ------------------------------ */
  /*
   * Scaling events on a running trade. The shared validator enforces the two
   * rules that keep the model honest: fills only on open trades, and a partial
   * may never flatten the position — the last piece is the exit, and it
   * belongs in the close flow where the reason and the path get recorded.
   */
  app.post("/api/trades/:id/fills", async (req, res) => {
    const parsed = addFillSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid fill", issues: parsed.error.issues });
    const trade = await store(req).getTrade(Number(req.params.id));
    if (!trade) return res.status(404).json({ message: "Trade not found" });

    const problem = validateFill(trade, parsed.data);
    if (problem) return res.status(400).json({ message: problem });

    const fill = await store(req).addFill(trade.id, {
      ...parsed.data,
      time: parsed.data.time ?? new Date().toISOString(),
    });
    res.status(201).json(fill);
  });

  app.delete("/api/fills/:id", async (req, res) => {
    await store(req).deleteFill(Number(req.params.id));
    res.status(204).end();
  });

  /* ----------------------------- trade images ----------------------------- */
  /*
   * Images live in their own table and their own endpoints so the trade list
   * never carries payloads. GET here is the only place full image data leaves
   * the server, and it is always scoped to one trade someone is looking at.
   */
  app.get("/api/trades/:id/images", async (req, res) => {
    res.json(await store(req).listTradeImages(Number(req.params.id)));
  });

  app.post("/api/trades/:id/images", async (req, res) => {
    const parsed = addTradeImageSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid image", issues: parsed.error.issues });
    const tradeId = Number(req.params.id);
    if (!(await store(req).getTrade(tradeId)))
      return res.status(404).json({ message: "Trade not found" });
    // A dozen shots tell a trade's whole story; an unbounded gallery is how a
    // free-tier database quietly fills with near-duplicates.
    if ((await store(req).listTradeImages(tradeId)).length >= 12)
      return res.status(400).json({ message: "This trade already has 12 screenshots — delete one first." });
    res
      .status(201)
      .json(await store(req).addTradeImage(tradeId, parsed.data.kind ?? "other", parsed.data.data));
  });

  /** Storage awareness: what the screenshots cost, against the 512 MB tier. */
  app.get("/api/storage-usage", async (req, res) => {
    res.json(await store(req).imageUsage());
  });

  app.delete("/api/images/:id", async (req, res) => {
    await store(req).deleteTradeImage(Number(req.params.id));
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
  app.get("/api/export.csv", async (req, res) => {
    const [trades, tags, styles] = await Promise.all([
      store(req).listTrades(),
      store(req).listMistakeTags(),
      store(req).listTradingStyles(),
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
        await store(req).createTrade(
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
  app.get("/api/styles", async (req, res) => {
    res.json(await store(req).listTradingStyles());
  });

  app.post("/api/styles", async (req, res) => {
    const parsed = insertTradingStyleSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid style", issues: parsed.error.issues });
    res.status(201).json(await store(req).createTradingStyle(parsed.data));
  });

  app.patch("/api/styles/:id", async (req, res) => {
    const parsed = insertTradingStyleSchema.partial().safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid style", issues: parsed.error.issues });
    const updated = await store(req).updateTradingStyle(Number(req.params.id), parsed.data);
    if (!updated) return res.status(404).json({ message: "Style not found" });
    res.json(updated);
  });

  app.delete("/api/styles/:id", async (req, res) => {
    await store(req).deleteTradingStyle(Number(req.params.id));
    res.status(204).end();
  });

  /* ---------------------------- mistake tags ---------------------------- */
  /* -------------------------- account settings -------------------------- */

  app.get("/api/account-settings", async (req, res) => {
    res.json(await store(req).listAccountSettings());
  });

  app.put("/api/account-settings", async (req, res) => {
    const parsed = upsertAccountSettingsSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid account settings", issues: parsed.error.issues });
    res.json(await store(req).upsertAccountSettings(parsed.data));
  });

  app.get("/api/mistake-tags", async (req, res) => {
    res.json(await store(req).listMistakeTags());
  });

  app.post("/api/mistake-tags", async (req, res) => {
    const parsed = insertMistakeTagSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid tag", issues: parsed.error.issues });
    res.status(201).json(await store(req).createMistakeTag(parsed.data));
  });

  app.patch("/api/mistake-tags/:id", async (req, res) => {
    const parsed = insertMistakeTagSchema.partial().safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid tag", issues: parsed.error.issues });
    const updated = await store(req).updateMistakeTag(Number(req.params.id), parsed.data);
    if (!updated) return res.status(404).json({ message: "Tag not found" });
    res.json(updated);
  });

  app.delete("/api/mistake-tags/:id", async (req, res) => {
    await store(req).deleteMistakeTag(Number(req.params.id));
    res.status(204).end();
  });

  /* --------------------------- weekly reviews --------------------------- */
  app.get("/api/weekly-reviews", async (req, res) => {
    res.json(await store(req).listWeeklyReviews());
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

    const existing = (await store(req).listWeeklyReviews()).find(
      (r) => r.weekStart === key,
    );
    if (existing?.insights && !force) {
      return res.json({ ok: true, cached: true, weekStart: key, insights: JSON.parse(existing.insights) });
    }

    const [trades, tags, notes] = await Promise.all([
      store(req).listTrades(),
      store(req).listMistakeTags(),
      store(req).listDailyNotes(),
    ]);
    const bundle = buildInsightsBundle(trades, tags, weekDate, notes);

    // Without any writing there is nothing for this to read — per-trade
    // reflections and end-of-day reviews both count. Saying so beats spending
    // a model call to produce a paraphrase of the stats.
    if (bundle.reflectionCount === 0 && bundle.dayNotes.length === 0) {
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

      await store(req).upsertWeeklyInsights(key, JSON.stringify(insights));
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
    res.status(201).json(await store(req).createWeeklyReview(parsed.data));
  });

  /* ---------------------------- daily notes ----------------------------- */
  // The list is returned whole: notes are one text per day and the client
  // renders a calendar over them, so per-day fetches would just be N trips.
  app.get("/api/daily-notes", async (req, res) => {
    res.json(await store(req).listDailyNotes());
  });

  app.put("/api/daily-notes/:day", async (req, res) => {
    const day = req.params.day;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
      return res.status(400).json({ message: "Day must be yyyy-MM-dd" });
    const parsed = upsertDailyNoteSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid note", issues: parsed.error.issues });
    res.json(await store(req).upsertDailyNote(day, parsed.data.body));
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

  /* ------------------------------ members ------------------------------ */

  /**
   * Who may sign in. Owner only — everyone else gets a 404 rather than a 403,
   * so the endpoint does not confirm it exists to someone who may not use it.
   */
  function ownerOnly(req: any, res: any): boolean {
    if (req.account?.isOwner) return true;
    res.status(404).json({ message: "Not found" });
    return false;
  }

  app.get("/api/members", async (req, res) => {
    if (!ownerOnly(req, res)) return;
    const [accountsList, invited] = await Promise.all([
      invitations.members(),
      invitations.list(),
    ]);
    const joined = new Set(accountsList.map((u) => u.email.trim().toLowerCase()));
    res.json({
      members: accountsList.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        picture: u.picture,
        isOwner: u.isOwner,
        lastLoginAt: u.lastLoginAt,
      })),
      // Invited but never signed in. Shown separately because "invited" and
      // "using it" are different states and conflating them hides whether the
      // person ever actually got in.
      pending: invited.filter((i) => !joined.has(i.email)).map((i) => i.email),
      /** Env-var entries can't be removed from in here; the UI says so. */
      fromEnv: envAllowlist(),
    });
  });

  app.post("/api/members", async (req, res) => {
    if (!ownerOnly(req, res)) return;
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    // Deliberately loose: Google decides what a real address is, and a typo
    // here costs nothing — an invite nobody can use is inert.
    if (!email || !email.includes("@") || email.length > 320) {
      return res.status(400).json({ message: "That does not look like an email address" });
    }
    const row = await invitations.add(email, req.userId ?? null);
    res.json({ ok: true, email: row?.email ?? email });
  });

  app.delete("/api/members/:email", async (req, res) => {
    if (!ownerOnly(req, res)) return;
    const email = String(req.params.email ?? "").trim().toLowerCase();
    const owner = req.account?.email?.trim().toLowerCase();
    // Removing yourself would lock you out of your own journal, and the owner
    // is allowed by OWNER_EMAIL anyway, so this could only ever confuse.
    if (email && email === owner) {
      return res.status(400).json({ message: "You cannot remove your own access" });
    }
    await invitations.remove(email);
    res.json({ ok: true });
  });

  return httpServer;
}
