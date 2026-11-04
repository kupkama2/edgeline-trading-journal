import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";

/** A symbol with more than a page of fills in the week: every page is read, the closes included. */
const KEY = "pagingkey0123456789abcdef";
const SECRET = "pagingsecret0123456789abcdef";
let venue: Server;
let base = "";
const asked: number[] = [];
const T0 = Date.now() - 3 * 3_600_000;

describe("fills, paged", () => {
  beforeAll(async () => {
    venue = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      const sp = new URLSearchParams(u.search.slice(1));
      const sig = sp.get("signature") ?? "";
      const q = u.search.slice(1).replace(/&signature=[0-9a-f]*$/, "");
      const ok = req.headers["x-mbx-apikey"] === KEY && sig === createHmac("sha256", SECRET).update(q).digest("hex");
      res.setHeader("content-type", "application/json");
      if (!ok || u.pathname !== "/fapi/v1/userTrades") {
        res.statusCode = 401;
        return res.end(JSON.stringify({ code: -2015, msg: "bad" }));
      }
      const start = Number(sp.get("startTime"));
      asked.push(start);
      const all: any[] = [];
      for (let i = 0; i < 1010; i++) all.push({ symbol: "BTCUSDT", id: 1 + i, orderId: 100 + i, side: i === 1009 ? "SELL" : "BUY", positionSide: "LONG", price: "100", qty: "0.001", realizedPnl: "0", commission: "0", commissionAsset: "USDT", time: T0 + i * 1000, buyer: true, maker: false });
      res.end(JSON.stringify(all.filter((f) => f.time >= start).slice(0, 1000)));
    });
    await new Promise<void>((r) => venue.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(venue.address() as any).port}`;
    process.env.BINANCE_FUTURES_BASE = base;
  });
  afterAll(async () => {
    await new Promise<void>((r) => venue.close(() => r()));
  });

  it("asks again from the last fill's time until a page comes back short", async () => {
    const { fillsSince } = await import("../server/binance-trade");
    const rows = await fillsSince({ creds: { key: KEY, secret: SECRET }, env: "live" }, "BTCUSDT", T0 - 60_000);
    expect(rows).toHaveLength(1010);
    expect(rows[rows.length - 1]).toMatchObject({ id: 1010, side: "SELL" });
    expect(asked).toHaveLength(2);
    expect(asked[1]).toBe(T0 + 999 * 1000);
  });
});
