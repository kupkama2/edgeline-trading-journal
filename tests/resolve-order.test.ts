import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

/**
 * Cancelling an order that never became a position — through the real route.
 *
 * A unit test on the rule would not have caught this. The rule was correct in
 * shared/schema.ts the whole time; the PATCH route carried its OWN copy that
 * excluded only "pending", so every button on the "didn't become a position"
 * dialog came back 400 against a resting order with no stop on it — which is
 * what a resting order normally looks like. The dialog swallowed the error,
 * so it presented as a button that did nothing.
 *
 * So this drives the route: express, the real handlers, a real database. The
 * only thing stubbed is auth, which the routes read as `req.userId` and
 * nothing else.
 */
const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the route tests must run");
}

let server: Server;
let base: string;

/*
 * A fresh identity per boot, not per module.
 *
 * Two describe blocks each call this, and a module-level stamp made the second
 * one insert a googleSub the first had already taken. The unique index caught
 * it, beforeAll threw, and vitest reported that block's tests as SKIPPED —
 * which reads almost exactly like a pass in the summary line. CI, which
 * counts skips as failures, is what actually said so.
 */
let booted = 0;

async function boot() {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}-${booted++}`;
  const { initSchema, accounts } = await import("../server/storage");
  const { registerRoutes } = await import("../server/routes");
  await initSchema();
  const account = await accounts.create({
    googleSub: `route-${stamp}`,
    email: `route-${stamp}@x.test`,
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

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const patch = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A resting order the way the entry card files one: no stop, no target yet. */
async function restingOrder(over: Record<string, unknown> = {}) {
  const res = await post("/api/trades", {
    trade: {
      symbol: `ORD${Math.floor(Math.random() * 1e6)}`,
      direction: "long",
      size: 1,
      sizeUnit: "base",
      entryPrice: 100,
      entryTime: "2026-08-24T08:00:00.000Z",
      status: "pending",
      ...over,
    },
    mistakeTagIds: [],
  });
  expect(res.status).toBe(201);
  return res.json();
}

/**
 * A pair, written any of the ways it gets written, is one instrument.
 *
 * Not a cosmetic point: the symbol is what every breakdown groups by, so
 * "LTC/USDT" and "LTC" landing as different rows means one coin arrives with
 * two win rates and neither is true. Through the real route, because the
 * collapse happens on write and a unit test on the helper would not notice
 * the route forgetting to call it.
 */
describe.skipIf(!DB)("what a pasted pair gets stored as", () => {
  beforeAll(boot);
  afterAll(() => new Promise<void>((r) => server?.close(() => r())));

  it("keeps a futures contract exactly as it was", async () => {
    // The other half of the rule: an index future must not be collapsed by a
    // crypto-pair rule that has never heard of it.
    const res = await post("/api/trades", {
      trade: {
        symbol: "MNQU6",
        direction: "long",
        size: 1,
        sizeUnit: "base",
        entryPrice: 100,
        entryTime: "2026-08-24T08:00:00.000Z",
        status: "pending",
      },
      mistakeTagIds: [],
    });
    const t = await res.json();
    expect(t.symbol).toBe("NQ");
    expect(t.contract).toBe("MNQU6");
  });
});

describe.skipIf(!DB)("resolving an order that never filled", () => {
  beforeAll(boot);
  afterAll(() => new Promise<void>((r) => server?.close(() => r())));

  it("cancels a resting order that never had a stop", async () => {
    const t = await restingOrder();
    const res = await patch(`/api/trades/${t.id}`, {
      trade: { status: "cancelled", cancelReason: "not_filled", wouldHaveHitTarget: null },
    });
    expect(res.status).toBe(200);
    const after = await res.json();
    expect(after.status).toBe("cancelled");
    expect(after.cancelReason).toBe("not_filled");
  });

  it("accepts every reason the dialog offers", async () => {
    // All three broke together — the route never looked at the reason, only at
    // the absent stop — so all three have to be pinned together.
    for (const reason of ["not_filled", "pulled", "changed_mind"]) {
      const t = await restingOrder();
      const res = await patch(`/api/trades/${t.id}`, {
        trade: { status: "cancelled", cancelReason: reason },
      });
      expect([reason, res.status]).toEqual([reason, 200]);
    }
  });

  it("keeps the missed-winner answer that makes the record worth keeping", async () => {
    // The whole reason a never-filled order is logged rather than deleted: a
    // missed entry that would have paid is a measurable cost.
    const t = await restingOrder();
    const res = await patch(`/api/trades/${t.id}`, {
      trade: { status: "cancelled", cancelReason: "not_filled", wouldHaveHitTarget: true },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).wouldHaveHitTarget).toBe(true);
  });

  it("still refuses to open a trade with no stop or target", async () => {
    // The rule this bug came from is a real rule — 1R is entry-to-stop, and a
    // live position without one poisons every R in the app. Relaxing it for
    // cancellation must not relax it for going live.
    const t = await restingOrder();
    const res = await patch(`/api/trades/${t.id}`, { trade: { status: "open" } });
    expect(res.status).toBe(400);
    expect((await res.json()).issues.map((i: any) => i.path[1])).toEqual([
      "initialStop",
      "initialTarget",
    ]);
  });

  it("lets an order that does have levels go live", async () => {
    const t = await restingOrder({ initialStop: 90, initialTarget: 130 });
    const res = await patch(`/api/trades/${t.id}`, { trade: { status: "open" } });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("open");
  });
});
