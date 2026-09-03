import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { lifecycleConflict } from "../shared/schema";

/**
 * A trade's state and its exit price cannot contradict each other — enforced
 * where every writer has to pass, not only in the one form that knew the rule.
 *
 * Found by probing the live server rather than reading the code: the editor
 * refused both contradictions, and PATCH {status:"closed"} with no exit came
 * back 200 anyway. A row like that says "closed" in the journal and is
 * counted by nothing, because every statistic needs an exit price to compute
 * — the trade quietly ceases to exist everywhere except the list.
 */
describe("the rule on its own", () => {
  it("wants an exit price on a closed trade", () => {
    expect(lifecycleConflict({ status: "closed", exitPrice: null }).map((c) => c.field)).toEqual([
      "exitPrice",
    ]);
    expect(lifecycleConflict({ status: "closed", exitPrice: 120 })).toEqual([]);
  });

  it("refuses an exit price on anything not closed", () => {
    for (const status of ["pending", "open", "cancelled"]) {
      expect(lifecycleConflict({ status, exitPrice: 120 })).toHaveLength(1);
      expect(lifecycleConflict({ status, exitPrice: null })).toEqual([]);
    }
  });

  it("treats a missing status as open, the same as the row default does", () => {
    expect(lifecycleConflict({ exitPrice: 120 })).toHaveLength(1);
    expect(lifecycleConflict({})).toEqual([]);
  });

  it("does not mistake a zero exit for no exit", () => {
    // 0 is a real price on a spread; only null and undefined are absences.
    expect(lifecycleConflict({ status: "closed", exitPrice: 0 })).toEqual([]);
  });
});

const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the route tests must run");
}

let server: Server;
let base: string;
let booted = 0;

async function boot() {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}-${booted++}`;
  const { initSchema, accounts } = await import("../server/storage");
  const { registerRoutes } = await import("../server/routes");
  await initSchema();
  const account = await accounts.create({
    googleSub: `life-${stamp}`,
    email: `life-${stamp}@x.test`,
  });
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  app.use((req, _res, next) => {
    (req as any).userId = account.id;
    next();
  });
  server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

const send = (method: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const live = {
  symbol: "NQ",
  direction: "long",
  size: 1,
  sizeUnit: "base",
  pointValue: 1,
  entryPrice: 100,
  initialStop: 90,
  initialTarget: 130,
  entryTime: "2026-09-01T10:00:00.000Z",
};

async function openTrade() {
  const res = await send("POST", "/api/trades", { trade: { ...live, status: "open" }, mistakeTagIds: [] });
  expect(res.status).toBe(201);
  return res.json();
}

describe.skipIf(!DB)("through the real routes", () => {
  beforeAll(boot);
  afterAll(() => new Promise<void>((r) => server?.close(() => r())));

  it("will not create a closed trade with no exit", async () => {
    const res = await send("POST", "/api/trades", {
      trade: { ...live, status: "closed" },
      mistakeTagIds: [],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("exitPrice");
  });

  it("will not close a trade without giving it an exit", async () => {
    const t = await openTrade();
    const res = await send("PATCH", `/api/trades/${t.id}`, { trade: { status: "closed" } });
    expect(res.status).toBe(400);
    expect((await res.json()).issues[0].path).toEqual(["trade", "exitPrice"]);
  });

  it("will not leave an exit price on a trade marked open", async () => {
    const t = await openTrade();
    const res = await send("PATCH", `/api/trades/${t.id}`, {
      trade: { status: "open", exitPrice: 120 },
    });
    expect(res.status).toBe(400);
  });

  it("closes a trade the ordinary way", async () => {
    // The editor sends status and exit together; that is the shape to keep working.
    const t = await openTrade();
    const res = await send("PATCH", `/api/trades/${t.id}`, {
      trade: { status: "closed", exitPrice: 120, exitTime: "2026-09-01T11:00:00.000Z" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("closed");
  });

  it("reopens a closed trade when the exit is cleared in the same patch", async () => {
    const t = await openTrade();
    await send("PATCH", `/api/trades/${t.id}`, { trade: { status: "closed", exitPrice: 120 } });
    const res = await send("PATCH", `/api/trades/${t.id}`, {
      trade: { status: "open", exitPrice: null },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).exitPrice).toBeNull();
  });

  it("still cancels a resting order, which never had an exit to conflict with", async () => {
    const res = await send("POST", "/api/trades", {
      trade: { ...live, initialStop: null, initialTarget: null, status: "pending" },
      mistakeTagIds: [],
    });
    const t = await res.json();
    const cancel = await send("PATCH", `/api/trades/${t.id}`, {
      trade: { status: "cancelled", cancelReason: "not_filled" },
    });
    expect(cancel.status).toBe(200);
  });

  it("lets the excursion settler patch a closed trade without touching its state", async () => {
    // The settler and the inline editor both PATCH single fields onto a closed
    // trade. The merged row keeps its exit, so the rule must stay out of the way.
    const t = await openTrade();
    await send("PATCH", `/api/trades/${t.id}`, { trade: { status: "closed", exitPrice: 120 } });
    const res = await send("PATCH", `/api/trades/${t.id}`, { trade: { mfe: 124 } });
    expect(res.status).toBe(200);
    expect((await res.json()).mfe).toBe(124);
  });
});
