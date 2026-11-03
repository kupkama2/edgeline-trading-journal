import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

/**
 * A Binance rate ban, honoured.
 *
 * The venue bans an IP that keeps asking past the limit, and lengthens the
 * ban on every request made during it. So once a host has answered 418 with
 * "banned until", nothing is sent to it until then: the signed client and
 * the public one both fail at once, naming the end, and the stub sees no
 * further request.
 */
const BAN_END = Date.now() + 60 * 60_000;
let hits = 0;
let answer: { status: number; body: unknown } = { status: 418, body: { code: -1003, msg: `Way too many requests; IP(1.2.3.4) banned until ${BAN_END}. Please use the websocket for live updates to avoid bans.` } };
let venue: Server;
let base = "";

describe("the Binance rate ban", () => {
  beforeAll(async () => {
    venue = createServer((req, res) => {
      hits += 1;
      res.statusCode = answer.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((r) => venue.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(venue.address() as any).port}`;
    process.env.BINANCE_BASE = base;
    process.env.BINANCE_SAPI_BASE = base;
    process.env.BINANCE_FUTURES_BASE = base;
  });
  afterAll(async () => {
    await new Promise<void>((r) => venue.close(() => r()));
  });
  beforeEach(async () => {
    (await import("../server/binance-ban")).forgetRateBans();
    hits = 0;
  });

  it("reads the end the venue names, and a minute when it names none", async () => {
    const { banEndIn, noteRateLimit, rateBan } = await import("../server/binance-ban");
    expect(banEndIn("IP(1.2.3.4) banned until 1793755739273.")).toBe(1793755739273);
    expect(banEndIn("Too many requests")).toBeNull();
    noteRateLimit("x.test", 429, "Too many requests", null);
    const b = rateBan("x.test")!;
    expect(b.until - Date.now()).toBeGreaterThan(50_000);
    expect(b.until - Date.now()).toBeLessThanOrEqual(60_000);
    // A 418 naming a later end replaces it; an earlier one does not shorten it.
    noteRateLimit("x.test", 418, `banned until ${BAN_END}`, null);
    expect(rateBan("x.test")!.until).toBe(BAN_END);
    noteRateLimit("x.test", 429, null, null);
    expect(rateBan("x.test")!.until).toBe(BAN_END);
    // Anything else is not a ban.
    noteRateLimit("y.test", 451, "restricted location", null);
    expect(rateBan("y.test")).toBeNull();
  });

  it("stops the signed client at the first 418, and does not ask again until the end", async () => {
    const { signedCall, BinanceError } = await import("../server/binance-account");
    const creds = { key: "k".repeat(20), secret: "s".repeat(20) };
    await expect(signedCall("GET", base, "/fapi/v2/positionRisk", {}, creds)).rejects.toBeInstanceOf(BinanceError);
    expect(hits).toBe(1);
    const again = await signedCall("GET", base, "/fapi/v2/positionRisk", {}, creds).catch((e) => e);
    expect(String(again.message)).toMatch(/rate-limiting this server's IP until \d\d:\d\d UTC/);
    expect(hits).toBe(1);
    // The status endpoint's record names the host and the end.
    const { feedStatus } = await import("../server/binance");
    expect(feedStatus().rateBans).toMatchObject([{ host: "127.0.0.1", until: new Date(BAN_END).toISOString() }]);
  });

  it("stops the public client the same way, and forgets the ban on a forced refresh", async () => {
    const { fetchCandles, forgetRefusals } = await import("../server/binance");
    const first = await fetchCandles({ symbol: "BTCUSDT", market: "futures" }, "1m", Date.now() - 60_000, Date.now(), 10).catch((e) => e);
    expect(String(first.message)).toMatch(/HTTP 418/);
    const second = await fetchCandles({ symbol: "BTCUSDT", market: "futures" }, "1m", Date.now() - 60_000, Date.now(), 10).catch((e) => e);
    expect(String(second.message)).toMatch(/not asked again until then/);
    expect(hits).toBe(1);
    // ?refresh=1 asks again — the ban may have been lifted early.
    answer = { status: 200, body: [] };
    forgetRefusals();
    await expect(fetchCandles({ symbol: "BTCUSDT", market: "futures" }, "1m", Date.now() - 60_000, Date.now(), 10)).resolves.toEqual([]);
    expect(hits).toBe(2);
  });
});
