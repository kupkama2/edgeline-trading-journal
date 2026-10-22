import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

/**
 * Applying what "Ask the market again" previewed: only the fields the check
 * itself writes are taken, so a preview can never be used to rewrite the
 * entry, the size or anything else the P&L is built from.
 */
const DB = process.env.DATABASE_URL;
let server: Server;
let base: string;

beforeAll(async () => {
  if (!DB) return;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { initSchema, accounts } = await import("../server/storage");
  const { registerRoutes } = await import("../server/routes");
  await initSchema();
  const me = await accounts.create({ googleSub: `apply-${stamp}`, email: `apply-${stamp}@x.test` });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).userId = me.id;
    next();
  });
  server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
});

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

describe.skipIf(!DB)("applying the market's answer", () => {
  it("writes what was shown, and nothing outside the check's own fields", async () => {
    const t = await (
      await send("POST", "/api/trades", {
        trade: { symbol: "GOLD", direction: "long", size: 1, sizeUnit: "base", entryPrice: 100, initialStop: 98, entryTime: "2026-10-20T09:00:00.000Z", exitTime: "2026-10-20T10:00:00.000Z", exitPrice: 99, status: "closed" },
      })
    ).json();
    const res = await send("POST", `/api/trades/${t.id}/check/apply`, {
      patch: { mae: 97.5, noManagementOutcome: "stop_first", funding: -1.25, entryPrice: 50, size: 99 },
    });
    expect(res.status).toBe(200);
    const after = await res.json();
    expect(after).toMatchObject({ mae: 97.5, noManagementOutcome: "stop_first", funding: -1.25, entryPrice: 100, size: 1 });
  });

  it("refuses a value that is not one", async () => {
    const t = await (
      await send("POST", "/api/trades", {
        trade: { symbol: "GOLD", direction: "long", size: 1, sizeUnit: "base", entryPrice: 100, initialStop: 98, entryTime: "2026-10-20T09:00:00.000Z", exitTime: "2026-10-20T10:00:00.000Z", exitPrice: 99, status: "closed" },
      })
    ).json();
    expect((await send("POST", `/api/trades/${t.id}/check/apply`, { patch: { mae: { x: 1 } } })).status).toBe(400);
  });
});
