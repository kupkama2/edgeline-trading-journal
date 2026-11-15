import { describe, expect, it } from "vitest";
import { blendedRate, parseLuloAccount, parseLuloRates, sumLulo } from "../shared/lulo";

/** Lulo's own answers, as its public API gives them. */
const ACCOUNT = { totalUsdValue: 5120.5, lusdUsdBalance: 4020.5, pusdUsdBalance: 1100, maxWithdrawable: { protected: {}, regular: {} }, totalInterestEarned: 120.5, protectedInterestEarned: 20.5, regularInterestEarned: 100, blockTime: 1794756617, referredBy: null };
const RATES = { regular: { CURRENT: 7.5, "1HR": 7.48, "24HR": 7.5 }, protected: { CURRENT: 3.7, "1HR": 3.72 } };

describe("a Lulo deposit", () => {
  it("is read from the account answer, with what went in worked out from the interest", () => {
    expect(parseLuloAccount(ACCOUNT)).toEqual({ valueUsd: 5120.5, protectedUsd: 1100, boostedUsd: 4020.5, interestUsd: 120.5, protectedInterestUsd: 20.5, boostedInterestUsd: 100, depositedUsd: 5000 });
    expect(parseLuloAccount({ error: { code: "BAD_REQUEST", message: "owner: Invalid PublicKey" } })).toBeNull();
    expect(parseLuloAccount(null)).toBeNull();
  });

  it("earns each pool's rate on what is in that pool", () => {
    const rates = parseLuloRates(RATES);
    expect(rates).toEqual({ protected: 3.7, boosted: 7.5 });
    const a = parseLuloAccount(ACCOUNT)!;
    expect(blendedRate(a, rates)).toBeCloseTo((1100 * 3.7 + 4020.5 * 7.5) / 5120.5, 6);
    expect(blendedRate(sumLulo([]), rates)).toBeNull();
    expect(parseLuloRates({})).toEqual({ protected: null, boosted: null });
    expect(sumLulo([a, a]).valueUsd).toBe(10241);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("on the server", () => {
  it("asks Lulo about each Solana address followed, keeps the day, and names a wallet that cannot be read", async () => {
    const { createServer } = await import("node:http");
    const A = "DYWmganT7fTJkJHMi4qMBqF1xSt5mD3i7K8Y2FSUMufY";
    const B = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN4";
    const fake = createServer((req, res) => {
      const owner = new URL(req.url!, "http://x").searchParams.get("owner");
      if (req.url!.includes("rates.getRates")) return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(RATES));
      if (owner === A) return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(ACCOUNT));
      res.writeHead(500).end("down");
    }).listen(0);
    process.env.LULO_BASE = `http://127.0.0.1:${(fake.address() as any).port}`;
    try {
      const { initSchema, accounts, portfolioStore, followedValues } = await import("../server/storage");
      await initSchema();
      const sub = "lulo-test";
      const user = (await accounts.byGoogleSub(sub)) ?? (await accounts.create({ googleSub: sub, email: "lulo@test.invalid", name: "Lulo", isOwner: false }));
      for (const a of await portfolioStore.addresses(user.id)) await portfolioStore.removeAddress(user.id, a.id);
      await followedValues.remove("lulo", String(user.id));
      const { readLulo } = await import("../server/lulo");

      expect((await readLulo(user.id, { fresh: true })).followed).toBe(0);
      await portfolioStore.addAddress(user.id, "solana", A, "Sol Main");
      await portfolioStore.addAddress(user.id, "evm", "0x1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f", null);
      const NOW = Date.UTC(2026, 10, 15, 9);
      const one = await readLulo(user.id, { fresh: true, now: NOW });
      expect(one.wallets).toHaveLength(1);
      expect(one.total.valueUsd).toBe(5120.5);
      expect(one.total.depositedUsd).toBe(5000);
      expect(one.rate).toBeGreaterThan(6);
      expect(one.history).toEqual([{ date: "2026-11-15", valueUsd: 5120.5 }]);
      // Within ten minutes the answer kept is given again.
      expect(await readLulo(user.id, { now: NOW + 60_000 })).toBe(one);

      // A second wallet Lulo will not answer for: named, and the day is not kept short of it.
      await portfolioStore.addAddress(user.id, "solana", B, null);
      const two = await readLulo(user.id, { fresh: true, now: NOW + 86400_000 });
      expect(two.wallets.map((w) => !!w.error)).toEqual([false, true]);
      expect(two.wallets[1].error).toMatch(/500/);
      expect(two.total.valueUsd).toBe(5120.5);
      expect(two.history).toHaveLength(1);
    } finally {
      delete process.env.LULO_BASE;
      await new Promise((r) => fake.close(r));
    }
  });

  it("keeps positions typed by hand: one value a day, the owner's only", async () => {
    const express = (await import("express")).default;
    const { initSchema, accounts } = await import("../server/storage");
    await initSchema();
    const mk = async (sub: string) => (await accounts.byGoogleSub(sub)) ?? (await accounts.create({ googleSub: sub, email: `${sub}@test.invalid`, name: sub, isOwner: false }));
    const me = await mk("typed-me");
    const other = await mk("typed-other");
    const { registerLuloRoutes } = await import("../server/lulo");
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.userId = req.headers["x-other"] ? other.id : me.id;
      req.account = { isOwner: !req.headers["x-guest"] };
      next();
    });
    registerLuloRoutes(app);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as any).port}/api/typed-positions`;
    const call = async (method: string, path = "", body?: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, json: await r.json() };
    };
    try {
      for (const p of (await call("GET")).json) await call("DELETE", `/${p.id}`);
      expect((await call("GET", "", undefined, { "x-guest": "1" })).status).toBe(404);
      expect((await call("POST", "", { name: "", entryUsd: 1 })).status).toBe(400);
      const made = (await call("POST", "", { name: "Sigil Core II", entryUsd: 10000 })).json;
      expect(made).toEqual([{ id: expect.any(Number), name: "Sigil Core II", entryUsd: 10000, values: [] }]);
      const id = made[0].id;
      expect((await call("PUT", `/${id}/value`, { valueUsd: -1 })).status).toBe(400);
      expect((await call("PUT", `/${id}/value`, { valueUsd: 9000, date: "2099-01-01" })).status).toBe(400);
      await call("PUT", `/${id}/value`, { valueUsd: 9500, date: "2026-11-08" });
      await call("PUT", `/${id}/value`, { valueUsd: 9800, date: "2026-11-15" });
      // The same day again corrects it.
      const after = (await call("PUT", `/${id}/value`, { valueUsd: 9900, date: "2026-11-15" })).json;
      expect(after[0].values).toEqual([{ date: "2026-11-08", valueUsd: 9500 }, { date: "2026-11-15", valueUsd: 9900 }]);
      // Somebody else's account neither sees it nor can touch it.
      expect((await call("GET", "", undefined, { "x-other": "1" })).json).toEqual([]);
      expect((await call("PUT", `/${id}/value`, { valueUsd: 1 }, { "x-other": "1" })).status).toBe(404);
      expect((await call("DELETE", `/${id}`, undefined, { "x-other": "1" })).status).toBe(404);
      expect((await call("PUT", `/${id}`, { name: "Sigil II", entryUsd: null })).json[0]).toMatchObject({ name: "Sigil II", entryUsd: null });
      expect((await call("DELETE", `/${id}`)).json).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
