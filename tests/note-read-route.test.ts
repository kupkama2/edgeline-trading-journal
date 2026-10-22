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
        const reply = /UPDATE/.test(note)
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
        entryTime: at, exitTime: at, exitPrice: 98, status: "closed", reviewNote: note,
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
      trade: { reviewNote: "UPDATE: actually gold went lower, so a good SL (fundamental news)" },
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
});
