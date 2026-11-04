import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import compression from "compression";
import { createServer, type Server } from "node:http";

/**
 * The page told when the record changes (server/events.ts). A tab opens the
 * stream, a trade is written through the route, and the tab hears "trades"
 * — through the same compression layer production runs, which must leave
 * the stream alone. A burst of writes is one word, and a stranger's write
 * is nobody's business.
 */
const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the route tests must run");
}

let server: Server;
let base: string;
let me = 0;
let other = 0;

beforeAll(async () => {
  if (!DB) return;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { initSchema, accounts } = await import("../server/storage");
  const { registerRoutes } = await import("../server/routes");
  await initSchema();
  me = (await accounts.create({ googleSub: `ev-${stamp}`, email: `ev-${stamp}@x.test` })).id;
  other = (await accounts.create({ googleSub: `ev2-${stamp}`, email: `ev2-${stamp}@x.test` })).id;
  const app = express();
  app.use(compression({ threshold: 1024 }));
  app.use(express.json({ limit: "25mb" }));
  app.use((req, _res, next) => {
    (req as any).userId = req.headers["x-as"] === "other" ? other : me;
    next();
  });
  server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

const trade = (symbol: string) => ({
  symbol,
  direction: "long",
  size: 1,
  entryPrice: 100,
  initialStop: 95,
  entryTime: "2026-10-18T08:00:00.000Z",
  status: "open",
});

/** Open the stream and collect event names as they arrive. */
async function listen(as?: string) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, {
    signal: ac.signal,
    headers: { accept: "text/event-stream", "accept-encoding": "gzip, br", ...(as ? { "x-as": as } : {}) },
  });
  const events: string[] = [];
  let buf = "";
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (const m of buf.matchAll(/^event: (\w+)$/gm)) events.push(m[1]);
        buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
      }
    } catch {
      /* aborted */
    }
  })();
  const until = async (pred: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  };
  return { res, events, until, close: () => ac.abort() };
}

describe.skipIf(!DB)("the page told when the record changes", () => {
  it("hears a trade written through the route, uncompressed, once per burst", async () => {
    const tab = await listen();
    expect(tab.res.status).toBe(200);
    expect(tab.res.headers.get("content-type")).toContain("text/event-stream");
    expect(tab.res.headers.get("content-encoding")).toBeNull();
    await tab.until(() => tab.events.includes("hello"));
    expect(tab.events).toEqual(["hello"]);

    const made = await fetch(`${base}/api/trades`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trade: trade("EVAUSDT") }),
    });
    expect(made.status).toBe(201);
    const row = await made.json();
    // Two more writes inside the coalescing window: still one word.
    await fetch(`${base}/api/trades/${row.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trade: { initialStop: 94 } }),
    });
    await fetch(`${base}/api/trades/${row.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trade: { initialStop: 93 } }),
    });
    await tab.until(() => tab.events.includes("trades"));
    await new Promise((r) => setTimeout(r, 600));
    expect(tab.events.filter((e) => e === "trades")).toHaveLength(1);

    // A later write, after the window, is a new word.
    await fetch(`${base}/api/trades/${row.id}`, { method: "DELETE" });
    await tab.until(() => tab.events.filter((e) => e === "trades").length === 2);
    expect(tab.events.filter((e) => e === "trades")).toHaveLength(2);
    tab.close();
  });

  it("tells only the person whose record changed", async () => {
    const mine = await listen();
    const theirs = await listen("other");
    await mine.until(() => mine.events.includes("hello"));
    await theirs.until(() => theirs.events.includes("hello"));
    const made = await fetch(`${base}/api/trades`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-as": "other" },
      body: JSON.stringify({ trade: trade("EVBUSDT") }),
    });
    expect(made.status).toBe(201);
    await theirs.until(() => theirs.events.includes("trades"));
    expect(theirs.events).toContain("trades");
    expect(mine.events).not.toContain("trades");
    mine.close();
    theirs.close();
  });

  it("lets go of a tab that closed", async () => {
    const { listening } = await import("../server/events");
    const tab = await listen();
    await tab.until(() => tab.events.includes("hello"));
    const before = listening(me);
    expect(before).toBeGreaterThan(0);
    tab.close();
    const end = Date.now() + 2000;
    while (listening(me) >= before && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect(listening(me)).toBeLessThan(before);
  });
});
