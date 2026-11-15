/**
 * The chat's routes: the owner's alone, like the screener's. The answer to
 * a message is a stream of server-sent events on the POST itself — the
 * model's thinking, its tool calls and its text as they happen — and the
 * conversation is stored only once a turn has finished.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { adminOnly } from "./admin";
import { chatStore } from "./storage";
import { availableModels, bubblesOf, CHAT_EFFORTS, chatEnabled, ChatRefused, DEFAULT_CHAT_MODEL, runChat, type ChatEvent } from "./chat";

/** One turn at a time per person: a second message while the first is being answered would fork the conversation. */
const busy = new Set<number>();

export function registerChatRoutes(app: Express): void {
  app.use("/api/chat", adminOnly);

  /** What the page needs to draw itself: whether a key is set, the models to choose from, and the conversations so far. */
  app.get("/api/chat", async (req: Request, res: Response) => {
    const [models, threads] = await Promise.all([availableModels(), chatStore.threads(req.userId!)]);
    res.json({ enabled: chatEnabled(), models, defaultModel: models.some((m) => m.id === DEFAULT_CHAT_MODEL) ? DEFAULT_CHAT_MODEL : models[0]?.id, efforts: CHAT_EFFORTS, threads });
  });

  app.get("/api/chat/threads/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const thread = Number.isInteger(id) ? await chatStore.thread(req.userId!, id) : null;
    if (!thread) return res.status(404).json({ message: "No such conversation." });
    res.json({ ...thread, messages: bubblesOf(await chatStore.messages(id)) });
  });

  app.delete("/api/chat/threads/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const gone = Number.isInteger(id) && (await chatStore.deleteThread(req.userId!, id));
    res.status(gone ? 200 : 404).json({ deleted: !!gone });
  });

  app.post("/api/chat", async (req: Request, res: Response) => {
    const body = z
      .object({ threadId: z.number().int().positive().nullable().optional(), model: z.string().min(1).max(80), effort: z.enum(CHAT_EFFORTS).optional(), message: z.string().min(1).max(20_000) })
      .strict()
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "A message and a model are needed." });
    const userId = req.userId!;
    if (busy.has(userId)) return res.status(409).json({ message: "Still answering the last message." });
    busy.add(userId);
    const stop = new AbortController();
    let open = false;
    const emit = (e: ChatEvent) => {
      if (!open || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const start = () => {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      // no-transform: the compression layer must leave this alone, or the words would sit in its buffer.
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      open = true;
    };
    // The tab closed or Stop was pressed: the model is told to stop too, so nothing more is paid for.
    res.on("close", () => {
      if (!res.writableEnded) stop.abort();
    });
    try {
      start();
      await runChat({ userId, threadId: body.data.threadId ?? null, model: body.data.model, effort: body.data.effort ?? "medium", text: body.data.message, emit, signal: stop.signal });
    } catch (err: any) {
      emit({ t: "error", message: err instanceof ChatRefused ? err.message : "The chat failed. Try again." });
      if (!(err instanceof ChatRefused)) console.error(`[chat] ${String(err?.message ?? err).slice(0, 300)}`);
    } finally {
      busy.delete(userId);
      if (!res.writableEnded) res.end();
    }
  });
}
