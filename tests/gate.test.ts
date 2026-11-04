import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { DEFAULT_GATE_QUESTIONS, formatGate, gateLeft, gatePassed, gateReport, parseGate, readGate, redAnswers } from "../shared/gate";

/** The pre-trade gate: its rules, and the answers on the record. */
const Q = DEFAULT_GATE_QUESTIONS;
const green = { calm: "yes", planned: "yes", entry: "yes", stop: "no", bias: "yes", loss: "yes" } as const;

describe("the gate's rules", () => {
  it("is green only when every answer is the good one — the stop question on No", () => {
    expect(gatePassed(Q, { at: "x", answers: { ...green }, where: "entry-card" })).toBe(true);
    expect(gatePassed(Q, { at: "x", answers: { ...green, stop: "yes" }, where: "entry-card" })).toBe(false);
    expect(redAnswers(Q, { at: "x", answers: { ...green, stop: "yes", calm: "no" }, where: "entry-card" })).toEqual(["calm", "stop"]);
    expect(gateLeft(Q, {})).toBe(6);
    expect(gateLeft(Q, { calm: "yes", planned: "no" })).toBe(5);
    // Skipped is red on all of them, and never a pass.
    const skipped = { at: "x", answers: {}, skipped: true, where: "tracked" as const };
    expect(gatePassed(Q, skipped)).toBe(false);
    expect(redAnswers(Q, skipped)).toHaveLength(6);
  });

  it("reads settings leniently and a record strictly", () => {
    expect(readGate(undefined)).toMatchObject({ entryCard: true, terminal: true, tracked: true });
    expect(readGate({ entryCard: false, questions: "nope" }).questions).toEqual(Q);
    expect(readGate({ entryCard: false }).entryCard).toBe(false);
    expect(parseGate(formatGate({ at: "x", answers: { calm: "yes" }, where: "terminal" }))).toMatchObject({ where: "terminal" });
    expect(parseGate('{"answers":{"calm":"maybe"}}')).toBeNull();
    expect(parseGate("nonsense")).toBeNull();
  });

  it("reports the record: green trades against red ones, and the question that goes red most", () => {
    const r = gateReport(Q, [
      { status: "closed", r: 2, gate: formatGate({ at: "x", answers: { ...green }, where: "entry-card" }) },
      { status: "closed", r: 1, gate: formatGate({ at: "x", answers: { ...green }, where: "terminal" }) },
      { status: "closed", r: -1, gate: formatGate({ at: "x", answers: { ...green, calm: "no" }, where: "tracked" }) },
      { status: "closed", r: -2, gate: formatGate({ at: "x", answers: { ...green, calm: "no", stop: "yes" }, where: "tracked" }) },
      { status: "closed", r: 0.5, gate: null },
      { status: "open", r: null, gate: formatGate({ at: "x", answers: { ...green, calm: "no" }, where: "tracked" }) },
    ]);
    expect(r.passed).toEqual({ n: 2, avgR: 1.5 });
    expect(r.failed).toEqual({ n: 2, avgR: -1.5 });
    expect(r.unanswered).toBe(1);
    expect(r.red[0]).toMatchObject({ id: "calm", n: 2 });
    expect(r.red[1]).toMatchObject({ id: "stop", n: 1 });
  });
});

const DB = process.env.DATABASE_URL;
describe.skipIf(!DB)("the gate on the record", () => {
  let app: Server;
  let base = "";
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  beforeAll(async () => {
    const { initSchema, accounts } = await import("../server/storage");
    await initSchema();
    const acct = await accounts.create({ googleSub: `gate-${stamp}`, email: `gate-${stamp}@x.test` });
    const express = (await import("express")).default;
    const { registerRoutes } = await import("../server/routes");
    const server = express();
    server.use(express.json({ limit: "25mb" }));
    server.use((req, _res, next) => {
      (req as any).userId = acct.id;
      next();
    });
    app = createServer(server);
    await registerRoutes(app, server);
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as any).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => app.close(() => r()));
  });

  it("keeps the questions and where the gate stands in the person's prefs", async () => {
    const before = await send("GET", "/api/prefs").then((x) => x.json());
    expect(before.gate).toMatchObject({ entryCard: true, terminal: true, tracked: true });
    expect(before.gate.questions).toHaveLength(6);
    const r = await send("PATCH", "/api/prefs", { gate: { terminal: false, questions: [{ id: "calm", text: "Calm?", good: "yes" }, { id: "stop", text: "Enter at the stop?", hint: "No.", good: "no" }] } });
    expect(r.status).toBe(200);
    const after = await send("GET", "/api/prefs").then((x) => x.json());
    expect(after.gate).toMatchObject({ entryCard: true, terminal: false, tracked: true });
    expect(after.gate.questions.map((q: any) => q.id)).toEqual(["calm", "stop"]);
    // Only the rails changed: the gate stays.
    await send("PATCH", "/api/prefs", { guard: { dailyLossStop: 900 } });
    expect((await send("GET", "/api/prefs").then((x) => x.json())).gate.terminal).toBe(false);
    const bad = await send("PATCH", "/api/prefs", { gate: { questions: [] } });
    expect(bad.status).toBe(400);
  });

  it("stamps a trade with its gate on creation, and takes one later on a tracked trade", async () => {
    const gate = formatGate({ at: new Date().toISOString(), answers: { ...green }, where: "entry-card" });
    const r = await send("POST", "/api/trades", {
      trade: { symbol: "BTC", direction: "long", size: 1, sizeUnit: "base", entryPrice: 100, initialStop: 90, initialTarget: 120, entryTime: new Date().toISOString(), status: "open", gate },
    });
    expect(r.status).toBe(201);
    const made = await r.json();
    expect(parseGate(made.gate)).toMatchObject({ where: "entry-card" });
    // After the fact, on a trade with no levels at all (as a tracked position may be): only the gate is written.
    const bare = await send("POST", "/api/trades", {
      trade: { symbol: "XRP", direction: "long", size: 100, sizeUnit: "base", entryPrice: 0.5, entryTime: new Date().toISOString(), status: "open", tilt: true },
    }).then((x) => x.json());
    const bareGate = await send("POST", `/api/trades/${bare.id}/gate`, { gate: { at: new Date().toISOString(), answers: {}, skipped: true, where: "tracked" } });
    expect(bareGate.status).toBe(200);
    expect(parseGate((await bareGate.json()).gate)?.skipped).toBe(true);
    expect((await send("POST", `/api/trades/${bare.id}/gate`, { gate: { nope: 1 } })).status).toBe(400);
    const u = await send("POST", `/api/trades/${made.id}/gate`, { gate: { at: new Date().toISOString(), answers: { ...green, calm: "no" }, where: "tracked" } });
    expect(u.status).toBe(200);
    const row = await send("GET", `/api/trades/${made.id}`).then((x) => x.json());
    expect(redAnswers(DEFAULT_GATE_QUESTIONS, parseGate(row.gate))).toEqual(["calm"]);
    // Strict: one red answer and the trade is marked traded poorly; a skip is red on every question.
    expect(row.tradedPoorly).toBe(true);
    expect((await send("GET", `/api/trades/${bare.id}`).then((x) => x.json())).tradedPoorly).toBe(true);
    // Green all the way through leaves the mark alone.
    const clean = await send("POST", "/api/trades", {
      trade: { symbol: "ETH", direction: "long", size: 1, sizeUnit: "base", entryPrice: 100, initialStop: 90, initialTarget: 120, entryTime: new Date().toISOString(), status: "open" },
    }).then((x) => x.json());
    await send("POST", `/api/trades/${clean.id}/gate`, { gate: { at: new Date().toISOString(), answers: { ...green }, where: "tracked" } });
    expect((await send("GET", `/api/trades/${clean.id}`).then((x) => x.json())).tradedPoorly).toBe(false);
  });
});
