import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

/**
 * The 1R default, through the route and into the database. The rule itself
 * is tested in default-target.test.ts; this is about it being applied on
 * every write — create, a moved stop, a typed target, a cleared one — and
 * about the risk line no longer refusing a trade that has only its stop.
 */
const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the route tests must run");
}

let server: Server;
let base: string;

beforeAll(async () => {
  if (!DB) return;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { initSchema, accounts } = await import("../server/storage");
  const { registerRoutes } = await import("../server/routes");
  await initSchema();
  const account = await accounts.create({ googleSub: `dt-${stamp}`, email: `dt-${stamp}@x.test` });
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
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
});

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const live = {
  symbol: "ZECUSDT",
  direction: "long",
  size: 2,
  entryPrice: 1137.29,
  initialStop: 1068.14,
  entryTime: "2026-10-18T08:00:00.000Z",
  status: "open",
};

describe.skipIf(!DB)("a trade with a stop and no target", () => {
  it("is taken, with a target at 1R marked as the default", async () => {
    const res = await send("POST", "/api/trades", { trade: live });
    expect(res.status).toBe(201);
    const t = await res.json();
    expect(t.initialTarget).toBe(1206.44);
    expect(t.targetSource).toBe("default");
  });

  it("moves the default when the stop moves, and drops the mark when a target is typed", async () => {
    const t = await (await send("POST", "/api/trades", { trade: live })).json();
    const moved = await (await send("PATCH", `/api/trades/${t.id}`, { trade: { initialStop: 1100 } })).json();
    expect(moved.initialTarget).toBe(1174.58);
    expect(moved.targetSource).toBe("default");

    const typed = await (await send("PATCH", `/api/trades/${t.id}`, { trade: { initialTarget: 1300 } })).json();
    expect(typed.initialTarget).toBe(1300);
    expect(typed.targetSource).toBeNull();

    // A real target is not touched by a stop moving afterwards.
    const after = await (await send("PATCH", `/api/trades/${t.id}`, { trade: { initialStop: 1090 } })).json();
    expect(after.initialTarget).toBe(1300);

    // Clearing it gives the default back.
    const cleared = await (await send("PATCH", `/api/trades/${t.id}`, { trade: { initialTarget: null } })).json();
    expect(cleared.initialTarget).toBe(1184.58);
    expect(cleared.targetSource).toBe("default");
  });

  it("leaves a typed target alone and unmarked", async () => {
    const t = await (await send("POST", "/api/trades", { trade: { ...live, initialTarget: 1250 } })).json();
    expect(t.initialTarget).toBe(1250);
    expect(t.targetSource ?? null).toBeNull();
  });

  it("gives a short its default below the entry", async () => {
    const t = await (
      await send("POST", "/api/trades", { trade: { ...live, direction: "short", entryPrice: 100, initialStop: 110 } })
    ).json();
    expect(t.initialTarget).toBe(90);
  });

  it("still refuses a live trade with no stop", async () => {
    const { initialStop, ...noStop } = live;
    const res = await send("POST", "/api/trades", { trade: noStop });
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!DB)("trades logged before the default existed", () => {
  it("get one at the next start, marked, and a scalp or a target is left alone", async () => {
    const { db, initSchema } = await import("../server/storage");
    const { sql } = await import("drizzle-orm");
    const t = await (await send("POST", "/api/trades", { trade: { ...live, initialTarget: 1250 } })).json();
    const s = await (await send("POST", "/api/trades", { trade: { ...live, initialTarget: 1250 } })).json();
    // Back to how such a row looked: a stop, no target, no mark.
    await db.execute(sql`UPDATE trades SET initial_target = NULL, target_source = NULL WHERE id = ${t.id}`);
    await db.execute(sql`UPDATE trades SET initial_target = NULL, target_source = NULL, scalp = true WHERE id = ${s.id}`);
    await initSchema();
    const rows: any[] = await db.execute(
      sql`SELECT id, initial_target, target_source FROM trades WHERE id IN (${t.id}, ${s.id}) ORDER BY id`,
    );
    expect(rows[0]).toMatchObject({ initial_target: 1206.44, target_source: "default" });
    expect(rows[1]).toMatchObject({ initial_target: null, target_source: null });
  });
});
