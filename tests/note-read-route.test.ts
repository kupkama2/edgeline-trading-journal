import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

/**
 * A review note, read on request and read again when it changes — through
 * the route, against a stand-in for the model that answers from the note.
 */
const DB = process.env.DATABASE_URL;
let model: Server;
let app: Server;
let base: string;
let calls = 0;
let demonId = 0;

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => r.json());

describe.skipIf(!DB)("reading a trade's note", () => {
  let gold = 0;
  let other = 0;
  beforeAll(async () => {
    model = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls++;
        const asked = JSON.parse(body || "{}").messages?.[0]?.content?.map((c: any) => c.text ?? "").join("") ?? "";
        const note = asked.split('"""')[1] ?? "";
        // The why, read for its setup tags.
        const tagging = /jotted/.test(asked);
        const reply = tagging
          ? { tags: /severin's call/i.test(asked) ? ["Fib Retest", "Severin"] : ["VAH Rejection"] }
          : /UPDATE/.test(note)
          ? { exitReason: null, entryGrade: null, stopGrade: "good", exitGrade: null, demons: [], highlights: [], noManagementOutcome: null }
          : { exitReason: "stop", entryGrade: null, stopGrade: "tight", exitGrade: null, demons: ["Stop too tight"], highlights: [], noManagementOutcome: null };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          id: "msg_test", type: "message", role: "assistant", model: "claude-test",
          content: [{ type: "text", text: JSON.stringify(reply) }],
          stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        }));
      });
    });
    await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(model.address() as any).port}`;

    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { initSchema, accounts, storageFor } = await import("../server/storage");
    const { registerRoutes } = await import("../server/routes");
    await initSchema();
    const me = await accounts.create({ googleSub: `note-${stamp}`, email: `note-${stamp}@x.test` });
    const store = storageFor(me.id);
    const tags = await store.listMistakeTags();
    demonId = (tags.find((t) => t.name === "Stop too tight") ?? (await store.createMistakeTag({ name: "Stop too tight" } as any))).id;
    const mk = (symbol: string, at: string, note: string | null) =>
      store.createTrade({
        symbol, direction: "long", size: 1, sizeUnit: "base", pointValue: 1, entryPrice: 100, initialStop: 98, initialTarget: 106,
        entryTime: at, exitTime: at, exitPrice: 98, status: "closed", notes: note,
      } as any);
    gold = (await mk("GOLD", "2026-10-20T09:00:00.000Z", "stopped out, the stop was too tight")).id;
    other = (await mk("SOL", "2026-10-21T09:00:00.000Z", "chased it")).id;

    const e = express();
    e.use(express.json());
    e.use((req, _res, next) => {
      (req as any).userId = me.id;
      next();
    });
    app = createServer(e);
    await registerRoutes(app, e);
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as any).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => (app ? app.close(() => r()) : r()));
    await new Promise<void>((r) => (model ? model.close(() => r()) : r()));
  });

  it("fills the grades and demons the note gives", async () => {
    const r = await send("POST", `/api/trades/${gold}/read-note`);
    expect(r.ok).toBe(true);
    expect(r.trade).toMatchObject({ stopGrade: "tight", exitReason: "stop" });
    expect(r.trade.mistakeTagIds).toContain(demonId);
  });

  it("replaces what it said when the note is updated, and keeps what you set by hand", async () => {
    // You set the exit reason yourself in between.
    await send("PATCH", `/api/trades/${gold}`, { trade: { exitReason: "discretion" } });
    await send("PATCH", `/api/trades/${gold}`, {
      trade: { notes: "stopped out, the stop was too tight\n\nUPDATE: actually gold went lower, so a good SL (fundamental news)" },
    });
    const r = await send("POST", `/api/trades/${gold}/read-note`);
    expect(r.trade.stopGrade).toBe("good");
    expect(r.trade.mistakeTagIds).not.toContain(demonId);
    expect(r.trade.exitReason).toBe("discretion");
  });

  it("reads, in one go, only the notes changed since they were last read", async () => {
    const before = calls;
    const r = await send("POST", "/api/notes/read", { from: "2026-10-19T00:00:00.000Z", to: "2026-10-26T00:00:00.000Z" });
    // GOLD was read as it stands; only SOL is new.
    expect(r).toMatchObject({ ok: true, read: 1, failed: 0, left: 0 });
    expect(calls - before).toBe(1);
    const again = await send("POST", "/api/notes/read", {});
    expect(again.read).toBe(0);
    const sol = (await send("GET", "/api/trades")).find((t: any) => t.id === other);
    expect(sol.noteRead).toBeTruthy();
  });

  it("reads a closed trade's note on its own after a save, and an open trade's not at all", async () => {
    const open = await send("POST", "/api/trades", {
      trade: { symbol: "ETH", direction: "long", size: 1, sizeUnit: "base", entryPrice: 100, initialStop: 98, entryTime: "2026-10-22T09:00:00.000Z", status: "open", notes: "long the reclaim" },
    });
    // Tagging the why may start; reading the note may not, while it is open.
    expect(open.rationale).toBe("long the reclaim");
    await new Promise((r) => setTimeout(r, 300));
    expect((await send("GET", "/api/trades")).find((t: any) => t.id === open.id).stopGrade).toBeNull();
    const before = calls;
    const closed = await send("PATCH", `/api/trades/${open.id}`, {
      trade: { status: "closed", exitPrice: 98, exitTime: "2026-10-22T10:00:00.000Z", notes: "long the reclaim\n\nstopped, stop too tight" },
    });
    expect(closed.noteReading).toBe(true);
    // The read happens after the answer; give it a moment.
    let after: any;
    for (let i = 0; i < 60; i++) {
      after = (await send("GET", "/api/trades")).find((t: any) => t.id === open.id);
      if (after.stopGrade) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    void before;
    expect(after).toMatchObject({ stopGrade: "tight", exitReason: "stop" });
    expect(after.mistakeTagIds).toContain(demonId);
  });
  it("tags the why from the note, again when it changes, and finds a known source in it", async () => {
    await send("POST", "/api/trades", {
      trade: { symbol: "SOL", direction: "long", size: 1, sizeUnit: "base", entryPrice: 100, initialStop: 98, entryTime: "2026-10-22T08:00:00.000Z", status: "open", source: "Severin" },
    });
    const t = await send("POST", "/api/trades", {
      trade: { symbol: "SOL", direction: "long", size: 1, sizeUnit: "base", entryPrice: 100, initialStop: 98, entryTime: "2026-10-22T09:00:00.000Z", status: "open", notes: "vah rejection" },
    });
    expect(t.noteReading).toBe(true);
    const settle = async (pred: (x: any) => boolean) => {
      for (let i = 0; i < 60; i++) {
        const x = (await send("GET", "/api/trades")).find((y: any) => y.id === t.id);
        if (pred(x)) return x;
        await new Promise((r) => setTimeout(r, 50));
      }
      return (await send("GET", "/api/trades")).find((y: any) => y.id === t.id);
    };
    expect(JSON.parse((await settle((x) => !!x.rationaleTags)).rationaleTags)).toEqual(["VAH Rejection"]);
    // The why rewritten: tagged again, and the coach named in it becomes the source.
    await send("PATCH", `/api/trades/${t.id}`, { trade: { notes: "fib retest, severin's call\n\nmanaging it" } });
    const after = await settle((x) => x.rationaleTags?.includes("Fib"));
    expect(after.source).toBe("Severin");
    expect(JSON.parse(after.rationaleTags)).not.toContain("Severin");
    // Adding below the why does not ask again.
    const calls0 = calls;
    await send("PATCH", `/api/trades/${t.id}`, { trade: { notes: "fib retest, severin's call\n\nmanaging it\n\nmoved stop" } });
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBe(calls0);
  });
});

describe.skipIf(!DB)("notes written before there was one note", () => {
  it("are joined into it at start, in order, and nothing is lost or doubled", async () => {
    const { db, initSchema, accounts, storageFor } = await import("../server/storage");
    const { sql } = await import("drizzle-orm");
    const me = await accounts.create({ googleSub: `merge-${Date.now()}`, email: `merge-${Date.now()}@x.test` });
    const t = await storageFor(me.id).createTrade({
      symbol: "BTC", direction: "long", size: 1, entryPrice: 100, initialStop: 98, entryTime: "2026-10-01T09:00:00.000Z", status: "open",
    } as any);
    await db.execute(sql`UPDATE trades SET rationale = 'vah retest', notes = 'closed by hand', review_note = 'UPDATE: good SL' WHERE id = ${t.id}`);
    await initSchema();
    await initSchema();
    const rows: any[] = await db.execute(sql`SELECT notes, rationale, review_note FROM trades WHERE id = ${t.id}`);
    expect(rows[0]).toMatchObject({ notes: "vah retest\n\nclosed by hand\n\nUPDATE: good SL", rationale: "vah retest", review_note: null });
  });
});
