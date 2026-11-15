import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { nestList, parseInline, parseMarkdown } from "../shared/markdown";

/**
 * The owner's chat: the Markdown an answer is drawn from, read by hand;
 * then a whole turn against a fake Claude that asks for a tool and answers
 * from what it is given — what the model was sent, what the page was told,
 * and what was stored.
 */

describe("the Markdown an answer is written in", () => {
  it("reads paragraphs, headings, lists and a table into a tree", () => {
    const blocks = parseMarkdown(["## Strongest", "", "SOL leads on **alpha**, not beta.", "still the same paragraph", "", "- one", "- two", "  - nested", "", "1. first", "2. second", "", "| Coin | RS |", "|---|---:|", "| SOL | +3% |", "| TAO | -1% |", "", "---", "", "> careful"].join("\n"));
    expect(blocks.map((b) => b.t)).toEqual(["h", "p", "list", "list", "table", "hr", "quote"]);
    expect(blocks[0]).toMatchObject({ t: "h", level: 2, c: [{ t: "text", v: "Strongest" }] });
    expect(blocks[1]).toMatchObject({ t: "p", c: [{ t: "text", v: "SOL leads on " }, { t: "bold", c: [{ t: "text", v: "alpha" }] }, { t: "text", v: ", not beta.\nstill the same paragraph" }] });
    expect(blocks[2]).toMatchObject({ t: "list", ordered: false, items: [{ depth: 0 }, { depth: 0 }, { depth: 1 }] });
    expect(blocks[3]).toMatchObject({ t: "list", ordered: true });
    // A bullet under a numbered item belongs to that item, and stays a bullet.
    const mixed = parseMarkdown("1. wait\n2. size\n   - for the stop\n3. go")[0] as any;
    expect(nestList(mixed.items).map((n) => [n.ordered, n.children.map((c: any) => c.ordered)])).toEqual([[true, []], [true, [false]], [true, []]]);
    const table = blocks[4] as any;
    expect(table.head.map((h: any) => h[0].v)).toEqual(["Coin", "RS"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1].map((c: any) => c[0].v)).toEqual(["TAO", "-1%"]);
  });

  it("keeps what is not markup as the text it was, and only a web address is a link", () => {
    // Arithmetic, a ticker with an underscore, and a lone marker are text.
    expect(parseInline("5 * 3 = 15 and risk_per_trade")).toEqual([{ t: "text", v: "5 * 3 = 15 and risk_per_trade" }]);
    expect(parseInline("an unclosed **bold")).toEqual([{ t: "text", v: "an unclosed **bold" }]);
    expect(parseInline("*soon* and `kPEPE`")).toEqual([{ t: "em", c: [{ t: "text", v: "soon" }] }, { t: "text", v: " and " }, { t: "code", v: "kPEPE" }]);
    expect(parseInline("[docs](https://example.com/a)")).toEqual([{ t: "link", href: "https://example.com/a", c: [{ t: "text", v: "docs" }] }]);
    // Not a web address: never a link, whatever it claims to be.
    expect(parseInline("[x](javascript:alert(1))").some((x) => x.t === "link")).toBe(false);
    // Markup inside the text is text: the tree has no way to say "element".
    expect(parseMarkdown("<img src=x onerror=alert(1)>")).toEqual([{ t: "p", c: [{ t: "text", v: "<img src=x onerror=alert(1)>" }] }]);
    // An answer still streaming: the open fence is a code block to the end.
    expect(parseMarkdown("```\nconst a = 1;")).toEqual([{ t: "code", v: "const a = 1;" }]);
  });
});

const DB = process.env.DATABASE_URL;
let fake: Server;
let app: Server;
let base = "";
const asked: any[] = [];
let modelsAsked = 0;
/** What the fake Claude does on its next call. */
let script: ("tool" | "answer" | "refuse" | "two-tools")[] = [];

const sse = (res: any, events: any[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const start = (model: string) => ({ type: "message_start", message: { id: `msg_${asked.length}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: asked.length > 1 ? 80 : 0, cache_creation_input_tokens: 0 } } });
const stopWith = (stop_reason: string) => [{ type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } }, { type: "message_stop" }];
const toolBlock = (index: number, id: string, name: string, json: string) => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
  // The input arrives in pieces, as it does when it streams.
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, 5) } },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(5) } },
  { type: "content_block_stop", index },
];
const textBlock = (index: number, parts: string[]) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  ...parts.map((text) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } })),
  { type: "content_block_stop", index },
];

function startFake(): Promise<string> {
  return new Promise((resolve) => {
    fake = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const u = new URL(req.url ?? "/", "http://x");
        if (u.pathname === "/v1/models") {
          modelsAsked++;
          res.writeHead(200, { "content-type": "application/json" });
          // This key has three of the four on offer, and one the page does not offer.
          return res.end(JSON.stringify({ data: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-4-1"].map((id) => ({ id, type: "model", display_name: id, created_at: "2026-01-01T00:00:00Z" })), has_more: false, first_id: "claude-opus-5-5", last_id: "claude-opus-4-1" }));
        }
        if (u.pathname === "/v1/messages") {
          const q = JSON.parse(body || "{}");
          asked.push({ ...q, beta: req.headers["anthropic-beta"] ?? null });
          const step = script.shift() ?? "answer";
          if (step === "tool") return sse(res, [start(q.model), ...toolBlock(0, "toolu_1", "trading_stats", JSON.stringify({ groupBy: "symbol" })), ...stopWith("tool_use")]);
          if (step === "two-tools") return sse(res, [start(q.model), ...textBlock(0, ["Let me look."]), ...toolBlock(1, "toolu_a", "trades", JSON.stringify({ limit: 5 })), ...toolBlock(2, "toolu_b", "trade_detail", JSON.stringify({ id: "seven" })), ...stopWith("tool_use")]);
          if (step === "refuse") return sse(res, [start(q.model), ...stopWith("refusal")]);
          return sse(res, [start(q.model), ...textBlock(0, ["You are up **+1R** ", "over two trades."]), ...stopWith("end_turn")]);
        }
        res.writeHead(404).end("{}");
      });
    });
    fake.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(fake.address() as any).port}`));
  });
}

/** Send a message and collect every event of the answer. */
async function chat(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; events: any[] }> {
  const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  const events = text
    .split("\n\n")
    .map((c) => c.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5)));
  return { status: res.status, events };
}

beforeAll(async () => {
  if (!DB) return;
  const f = await startFake();
  process.env.ANTHROPIC_BASE_URL = f;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.HYPERLIQUID_BASE = f;
  process.env.SESSION_SECRET = "chat-test-session-secret-long-enough";
  const { initSchema, accounts, storageFor } = await import("../server/storage");
  const { registerRoutes } = await import("../server/routes");
  await initSchema();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const account = await accounts.create({ googleSub: `chat-${stamp}`, email: `chat-${stamp}@x.test` });
  const store = storageFor(account.id);
  // Two closed trades with a stop: +2R on SOL, −1R on ETH.
  const at = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  await store.createTrade({ symbol: "SOL", direction: "long", size: 10, sizeUnit: "base", pointValue: 1, entryPrice: 100, initialStop: 95, entryTime: at(30), exitPrice: 110, exitTime: at(28), status: "closed", notes: "Took the breakout." } as any);
  await store.createTrade({ symbol: "ETH", direction: "long", size: 1, sizeUnit: "base", pointValue: 1, entryPrice: 3000, initialStop: 2950, entryTime: at(20), exitPrice: 2950, exitTime: at(19), status: "closed" } as any);
  const ex = express();
  ex.use(express.json());
  ex.use((req, _res, next) => {
    (req as any).userId = account.id;
    (req as any).account = { id: account.id, email: account.email, isOwner: req.headers["x-not-owner"] !== "1" };
    next();
  });
  app = createServer(ex);
  await registerRoutes(app, ex);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as any).port}`;
}, 60_000);

afterAll(async () => {
  if (app) {
    app.closeAllConnections?.();
    await new Promise((r) => app.close(r));
  }
  if (fake) await new Promise((r) => fake.close(r));
});

describe("what the page draws from a stored conversation", () => {
  it("reads a chart the model drew, and a web search, out of the stored turn", async () => {
    const { bubblesOf, chartOf } = await import("../server/chat");
    const row = (role: string, content: unknown, meta: unknown = null) => ({ role, content: JSON.stringify(content), meta: meta ? JSON.stringify(meta) : null, at: "2026-11-15T10:00:00Z" });
    const bubbles = bubblesOf([
      row("user", [{ type: "text", text: "Now: …" }, { type: "text", text: "Show me SOL" }]),
      row("assistant", [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "solana news" } },
        { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] },
        { type: "tool_use", id: "t1", name: "show_chart", input: { coin: "SOL", timeframe: "1D", levels: [{ price: 150, label: "entry", kind: "entry" }, { price: -1, label: "bad" }, { label: "no price" }] } },
      ]),
      row("user", [{ type: "tool_result", tool_use_id: "t1", content: "{}" }]),
      row("assistant", [{ type: "text", text: "Here it is." }], { model: "claude-opus-5-5", usage: { input: 1, output: 2, cached: 0 } }),
    ]);
    expect(bubbles).toHaveLength(2);
    expect(bubbles[1]).toMatchObject({ role: "assistant", text: "Here it is.", tools: ["web_search", "show_chart"], charts: [{ coin: "SOL", timeframe: "1D", levels: [{ price: 150, label: "entry", kind: "entry" }] }] });
    // A timeframe the page does not know falls back to the default; anything but show_chart is no chart.
    expect(chartOf("show_chart", { coin: "ETH", timeframe: "3m" })).toEqual({ coin: "ETH", timeframe: "4h", levels: [] });
    expect(chartOf("trades", { coin: "ETH" })).toBeNull();
  });
});

describe.skipIf(!DB)("the owner's chat", () => {
  it("does not exist for anyone but the owner", async () => {
    expect((await fetch(`${base}/api/chat`, { headers: { "x-not-owner": "1" } })).status).toBe(404);
    expect((await chat({ model: "claude-opus-5-5", message: "hi" }, { "x-not-owner": "1" })).status).toBe(404);
    expect(asked).toHaveLength(0);
  });

  it("offers the models this key can use, and refuses one that is not a choice", async () => {
    const home = await (await fetch(`${base}/api/chat`)).json();
    expect(home.enabled).toBe(true);
    // Fable is on offer but not on this key; the old Opus is on the key but not on offer.
    expect(home.models.map((m: any) => m.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(home.defaultModel).toBe("claude-opus-5-5");
    expect(home.threads).toEqual([]);
    // Asked once, then remembered.
    await fetch(`${base}/api/chat`);
    expect(modelsAsked).toBe(1);
    const no = await chat({ model: "claude-opus-4-1", message: "hi" });
    expect(no.events).toEqual([{ t: "error", message: "That model is not one of the choices." }]);
    expect(asked).toHaveLength(0);
    expect((await chat({ model: "claude-opus-5-5" })).status).toBe(400);
  });

  it("answers from the journal through a tool, streams the answer, and stores the turn", async () => {
    script = ["tool", "answer"];
    const { status, events } = await chat({ model: "claude-opus-5-5", effort: "high", message: "How am I doing?" });
    expect(status).toBe(200);
    expect(events.map((e) => e.t)).toEqual(["tool", "tool_done", "text", "text", "thread", "done"]);
    expect(events[0]).toMatchObject({ name: "trading_stats", input: { groupBy: "symbol" } });
    expect(events[1]).toMatchObject({ name: "trading_stats", ok: true });
    expect(events.filter((e) => e.t === "text").map((e) => e.d).join("")).toBe("You are up **+1R** over two trades.");
    const done = events[events.length - 1];
    // Two calls: 100 read on the first; 100 more on the second with 80 from the cache; 20 written each.
    expect(done).toMatchObject({ t: "done", model: "claude-opus-5-5", usage: { input: 200, output: 40, cached: 80 } });

    // What the model was sent. The first call: the question with the time before it, the tools, adaptive thinking, the effort.
    expect(asked).toHaveLength(2);
    const [first, second] = asked;
    expect(first.model).toBe("claude-opus-5-5");
    expect(first.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(first.output_config).toEqual({ effort: "high" });
    expect(first.stream).toBe(true);
    expect(first.cache_control).toEqual({ type: "ephemeral" });
    // A declined request is re-run on another model inside the same call.
    expect(first.fallbacks).toBe("default");
    expect(first.beta).toContain("server-side-fallback-2026-07-01");
    expect(first.tools.map((t: any) => t.name)).toEqual(["screener_overview", "screener_coin", "screener_track_record", "open_positions", "trades", "trade_detail", "trading_stats", "price_candles", "show_chart", "upcoming_events", "web_search"]);
    const own = first.tools.filter((t: any) => t.name !== "web_search");
    expect(own.every((t: any) => t.eager_input_streaming === true && t.input_schema.additionalProperties === false)).toBe(true);
    // The web search is Anthropic's own tool, run on its side: declared, with a cap on searches per answer.
    expect(first.tools[first.tools.length - 1]).toEqual({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
    // No notes written yet: the prompt alone.
    expect(first.system).toHaveLength(1);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].content[0].text).toMatch(/^Now: .*Europe\/Prague \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\)\.$/);
    expect(first.messages[0].content[1].text).toBe("How am I doing?");
    // No time in the prompt: it is the same bytes on every call, so it stays cached.
    expect(first.system).toEqual(second.system);
    expect(JSON.stringify(first.system)).not.toMatch(/20\d\d-\d\d-\d\d/);

    // The second call: the tool's answer, from the journal's own arithmetic.
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1].content[0]).toMatchObject({ type: "tool_use", name: "trading_stats", input: { groupBy: "symbol" } });
    const result = second.messages[2].content[0];
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    expect(result.is_error).toBeUndefined();
    const stats = JSON.parse(result.content);
    expect(stats.overall).toMatchObject({ trades: 2, wins: 1, losses: 1, winRate: 0.5, totalR: 1, totalPnl: 50 });
    expect(stats.groups.find((g: any) => g.symbol === "SOL")).toMatchObject({ trades: 1, totalR: 2, totalPnl: 100 });

    // Stored: the conversation is listed, and reads back as a question and one answer with the tool it used.
    const threadId = events.find((e) => e.t === "thread").id;
    const home = await (await fetch(`${base}/api/chat`)).json();
    expect(home.threads).toMatchObject([{ id: threadId, title: "How am I doing?", model: "claude-opus-5-5" }]);
    const thread = await (await fetch(`${base}/api/chat/threads/${threadId}`)).json();
    expect(thread.messages).toMatchObject([
      { role: "user", text: "How am I doing?", tools: [] },
      { role: "assistant", text: "You are up **+1R** over two trades.", tools: ["trading_stats"], model: "claude-opus-5-5", usage: { input: 200, output: 40, cached: 80 } },
    ]);
  });

  it("carries the conversation on: the next question is sent after everything said before, unchanged", async () => {
    const threadId = (await (await fetch(`${base}/api/chat`)).json()).threads[0].id;
    const before = asked.length;
    script = ["answer"];
    // What the trader says about themselves goes after the fixed prompt, from the next question on.
    expect((await fetch(`${base}/api/chat/notes`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes: "  I risk 1% a trade and never hold through CPI. " }) })).status).toBe(200);
    expect((await (await fetch(`${base}/api/chat`)).json()).notes).toBe("I risk 1% a trade and never hold through CPI.");
    // Haiku has no fallback to send, and takes the plain web search.
    const { events } = await chat({ threadId, model: "claude-haiku-5-5", message: "And the losers?" });
    expect(events.map((e) => e.t)).toEqual(["text", "text", "done"]);
    const sent = asked[before];
    expect(sent.model).toBe("claude-haiku-5-5");
    expect(sent.fallbacks).toBeUndefined();
    expect(sent.tools[sent.tools.length - 1].type).toBe("web_search_20250305");
    expect(sent.system).toHaveLength(2);
    expect(sent.system[0]).toEqual(asked[0].system[0]);
    expect(sent.system[1].text).toMatch(/never hold through CPI\.$/);
    expect(sent.output_config).toEqual({ effort: "medium" });
    // The whole first turn, byte for byte as it was sent and answered, then the new question.
    expect(sent.messages).toHaveLength(5);
    expect(sent.messages.slice(0, 3)).toEqual(asked[1].messages);
    expect(sent.messages[3]).toEqual({ role: "assistant", content: [{ type: "text", text: "You are up **+1R** over two trades." }] });
    expect(sent.messages[4].content[1].text).toBe("And the losers?");
    const thread = await (await fetch(`${base}/api/chat/threads/${threadId}`)).json();
    expect(thread.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(thread.model).toBe("claude-haiku-5-5");
  });

  it("runs every tool of a round, tells the model which input did not fit, and stores nothing when the model declines", async () => {
    script = ["two-tools", "answer"];
    const before = asked.length;
    const { events } = await chat({ model: "claude-sonnet-5-5", message: "Show me my last trades and trade seven." });
    // The two run together, so they finish in either order.
    const finished = events.filter((e) => e.t === "tool_done");
    expect(finished).toHaveLength(2);
    expect(finished).toEqual(expect.arrayContaining([{ t: "tool_done", name: "trades", ok: true }, { t: "tool_done", name: "trade_detail", ok: false }]));
    // Both results go back in one message, in the order they were asked for.
    const results = asked[before + 1].messages[2].content;
    expect(results.map((r: any) => r.tool_use_id)).toEqual(["toolu_a", "toolu_b"]);
    const trades = JSON.parse(results[0].content);
    expect(trades.trades.map((t: any) => t.symbol)).toEqual(["ETH", "SOL"]);
    expect(trades.trades[1]).toMatchObject({ resultR: 2, pnl: 100, notes: "Took the breakout." });
    expect(results[1]).toMatchObject({ is_error: true });
    expect(results[1].content).toMatch(/did not fit/);
    // What the model wrote before the tools and after them is one answer.
    const all = (await (await fetch(`${base}/api/chat`)).json()).threads;
    const thread = await (await fetch(`${base}/api/chat/threads/${all[0].id}`)).json();
    expect(thread.messages[1]).toMatchObject({ role: "assistant", text: "Let me look.\n\nYou are up **+1R** over two trades.", tools: ["trades", "trade_detail"] });

    // A declined request: said, and not stored.
    script = ["refuse"];
    const declined = await chat({ model: "claude-opus-5-5", message: "Something it will not answer." });
    expect(declined.events).toEqual([{ t: "error", message: "The model declined to answer that. Rephrase it, or try another model." }]);
    expect((await (await fetch(`${base}/api/chat`)).json()).threads).toHaveLength(all.length);
  });

  it("deletes a conversation, and only its owner's", async () => {
    const threads = (await (await fetch(`${base}/api/chat`)).json()).threads;
    const id = threads[0].id;
    expect((await fetch(`${base}/api/chat/threads/${id}`, { method: "DELETE", headers: { "x-not-owner": "1" } })).status).toBe(404);
    expect((await fetch(`${base}/api/chat/threads/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${base}/api/chat/threads/${id}`)).status).toBe(404);
    expect((await fetch(`${base}/api/chat/threads/${id}`, { method: "DELETE" })).status).toBe(404);
    expect((await (await fetch(`${base}/api/chat`)).json()).threads).toHaveLength(threads.length - 1);
  });
});
