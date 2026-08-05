import type { Express } from "express";
import type { Server } from "node:http";
import { storage } from "./storage";
import Anthropic from "@anthropic-ai/sdk";
import {
  insertTradeSchema,
  updateTradeSchema,
  insertMistakeTagSchema,
  insertWeeklyReviewSchema,
  parseScreenshotSchema,
} from "@shared/schema";
import { z } from "zod";

const MODEL = "claude_sonnet_4_6";

const SETUP_PROMPT = `You are reading a TradingView-style chart screenshot taken at the moment a trade was opened.
Extract the trade plan. Look for: the ticker/symbol label, a long or short position tool (green profit zone above entry = long, below = short), the entry line, the stop-loss line, the take-profit/target line, price axis labels, and any position size / quantity readout.

Respond with STRICT JSON only, no prose, no markdown fences:
{"symbol": string|null, "direction": "long"|"short"|null, "entryPrice": number|null, "initialStop": number|null, "initialTarget": number|null, "entryTime": string|null, "size": number|null}

Rules:
- entryTime must be an ISO 8601 string if a date/time is legible, otherwise null.
- Use null for anything that is not clearly legible. Never guess wildly.
- Numbers must be plain JSON numbers (no currency symbols, no thousands separators).`;

function outcomePrompt(ctx: {
  symbol?: string;
  direction?: string;
  entryPrice?: number;
  initialStop?: number;
  initialTarget?: number;
}) {
  return `You are reading a TradingView-style chart screenshot taken AFTER a trade closed. It shows the full price path following the entry.

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
    res.status(201).json(
      await storage.createTrade(parsed.data.trade, parsed.data.mistakeTagIds ?? []),
    );
  });

  app.patch("/api/trades/:id", async (req, res) => {
    const parsed = tradeUpdateBodySchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ message: "Invalid trade", issues: parsed.error.issues });
    const updated = await storage.updateTrade(
      Number(req.params.id),
      parsed.data.trade,
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
      const client = new Anthropic();
      const message = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType as any, data },
              },
              {
                type: "text",
                text: kind === "setup" ? SETUP_PROMPT : outcomePrompt(context ?? {}),
              },
            ],
          },
        ],
      });

      const text = message.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");

      const json = extractJson(text);
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

  return httpServer;
}
