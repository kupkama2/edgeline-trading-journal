import { describe, expect, it } from "vitest";
import { AstekzUnreadable, astekzChanges, astekzCoinIds, astekzExchangePairs, exchangeKey, parseAstekzWidget, parseExchangeLast, parseSimplePrices, valueAstekz } from "../shared/astekz";

/** The widget's own source, as the page serves it: the part that says what is held. */
const widget = (holdings: string, tail = "const START_USD = 100000;") => `<html><script>
/* CONFIG — edit holdings here. { kind: "coingecko", id: "<coingecko id>" } */
const GOAL_USD = 1000000;            // every $10,000 = 1%
const HOLDINGS = [
${holdings}
];
// Starting capital stays $100,000.
${tail}
</script></html>`;

const PEARL = `  {
    ticker: "PEARL", name: "Pearl",
    qty: 24590.163934,                // $15,000 ÷ $0.61
    costUsd: 15000,
    avgUsd: 0.61,
    sources: [
      { kind: "coingecko-exchange", exchange: "safe_trade", coinId: "pearl-2", base: "PEARL", target: "USDT", label: "SafeTrade PEARL/USDT via CoinGecko" },
      { kind: "coingecko", id: "pearl-2" },
      { kind: "manual", usd: 1.533, asOf: "14 Nov 2026 09:30 UK (SafeTrade screenshot)" },
    ],
  },`;
const BTC = `  { ticker: "BTC", name: "Bitcoin", qty: 0.15503876, costUsd: 10000, avgUsd: 64500, sources: [{ kind: "coingecko", id: "bitcoin" }] },`;
const HYPE = `  { ticker: "HYPE", name: 'Hyperliquid', qty: 165.289, costUsd: 10_000, sources: [{ kind: "coingecko", id: "hyperliquid" }], },`;
const cash = (usd: number) => `  { ticker: "CASH", name: "Cash (USD)", cash: true, qty: ${usd}, costUsd: ${usd}, sources: [{ kind: "cash" }] },`;

const BEFORE = widget([PEARL, HYPE, BTC, cash(65000)].join("\n"));
const AFTER = widget([PEARL, BTC, cash(76074.36)].join("\n"));
const prices = new Map([["pearl-2", 1.5002], ["bitcoin", 66370], ["hyperliquid", 67]]);

describe("the Astekz page", () => {
  it("is read as text: comments, trailing commas, single quotes and a colon inside a string", () => {
    const c = parseAstekzWidget(BEFORE);
    expect(c.goalUsd).toBe(1_000_000);
    expect(c.startUsd).toBe(100_000);
    expect(c.holdings.map((h) => h.ticker)).toEqual(["PEARL", "HYPE", "BTC", "CASH"]);
    expect(c.holdings[0]).toMatchObject({ name: "Pearl", qty: 24590.163934, costUsd: 15000, cash: false });
    expect(c.holdings[1]).toMatchObject({ name: "Hyperliquid", costUsd: 10000 });
    expect(c.holdings[3].cash).toBe(true);
    expect(astekzCoinIds(c).sort()).toEqual(["bitcoin", "hyperliquid", "pearl-2"]);
    expect(astekzExchangePairs(c)).toHaveLength(1);
  });

  it("says so when the list is gone or cannot be read", () => {
    expect(() => parseAstekzWidget("<html>Portfolio</html>")).toThrow(AstekzUnreadable);
    expect(() => parseAstekzWidget(widget("  { ticker: loadTicker(), qty: 1 },"))).toThrow(/cannot read/);
    expect(() => parseAstekzWidget(widget(""))).toThrow(/empty/);
    expect(() => parseAstekzWidget(widget('  { name: "x", qty: 1 },'))).toThrow(/no ticker/);
  });

  it("prices to the figures the page showed on 15 November", () => {
    const s = valueAstekz(parseAstekzWidget(BEFORE), prices, "2026-11-15T09:00:00.000Z");
    const w = (t: string) => s.holdings.find((h) => h.ticker === t)!.weight;
    expect(w("PEARL")).toBeCloseTo(29.9, 0);
    expect(w("HYPE")).toBeCloseTo(9.0, 1);
    expect(w("BTC")).toBeCloseTo(8.3, 0);
    expect(s.cashPct).toBeCloseTo(52.7, 1);
    expect(s.progressPct).toBeCloseTo(12.33, 1);
    // Against the starting capital, as the page counts it.
    expect(s.pnlPct).toBeCloseTo(23.3, 0);
    expect(s.holdings[s.holdings.length - 1].ticker).toBe("CASH");
  });

  it("prefers the exchange's last trade, then the coin's price, then the page's typed figure; and refuses a hole", () => {
    const c = parseAstekzWidget(AFTER);
    const pair = astekzExchangePairs(c)[0];
    expect(parseExchangeLast({ tickers: [{ base: "PEARL", target: "BTC", last: 9 }, { base: "PEARL", target: "USDT", last: 1.49, is_stale: false }] }, pair)).toBe(1.49);
    expect(parseExchangeLast({ tickers: [{ base: "PEARL", target: "USDT", last: 1.49, is_stale: true }] }, pair)).toBeNull();
    const via = valueAstekz(c, new Map([...prices, [exchangeKey(pair), 1.49]]), "t");
    expect(via.holdings.find((h) => h.ticker === "PEARL")).toMatchObject({ priceUsd: 1.49, priceFrom: "safe_trade via CoinGecko" });
    expect(valueAstekz(c, prices, "t").holdings.find((h) => h.ticker === "PEARL")!.priceFrom).toBe("CoinGecko");
    expect(valueAstekz(c, new Map([["bitcoin", 66370]]), "t").holdings.find((h) => h.ticker === "PEARL")).toMatchObject({ priceUsd: 1.533, priceFrom: "The page's own typed price" });
    expect(() => valueAstekz(c, new Map(), "t")).toThrow(/No price could be found for BTC/);
    expect(parseSimplePrices({ bitcoin: { usd: 66370 }, junk: { usd: 0 }, x: null }).size).toBe(1);
  });

  it("logs what was sold, bought and resized by quantity, and not a day where only prices moved", () => {
    const day = (d: string, html: string, p = prices) => ({ day: d, snap: valueAstekz(parseAstekzWidget(html), p, `${d}T09:00:00.000Z`) });
    const moved = new Map([...prices, ["bitcoin", 70000]]);
    const more = widget([PEARL.replace("24590.163934", "30000"), BTC, HYPE.replace('"HYPE"', '"SOL"'), cash(60000)].join("\n"));
    const log = astekzChanges([day("2026-11-14", BEFORE), day("2026-11-15", AFTER), day("2026-11-16", AFTER, moved), day("2026-11-17", more)]);
    expect(log.map((c) => c.date)).toEqual(["2026-11-17", "2026-11-15"]);
    expect(log[1]).toMatchObject({ since: "2026-11-14", bought: [], resized: [] });
    expect(log[1].sold).toEqual([expect.objectContaining({ ticker: "HYPE", qty: 165.289 })]);
    expect(log[1].cashDelta).toBeCloseTo(11074.36, 2);
    expect(log[0].bought.map((b) => b.ticker)).toEqual(["SOL"]);
    expect(log[0].resized).toEqual([expect.objectContaining({ ticker: "PEARL", from: 24590.163934, to: 30000 })]);
    expect(log[0].resized[0].pct).toBeCloseTo(22, 0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("the daily read", () => {
  it("keeps one good read a day, and the last good one when a read fails", async () => {
    const { createServer } = await import("node:http");
    let html = BEFORE;
    let down = false;
    const fake = createServer((req, res) => {
      if (down) return void res.writeHead(503).end("down");
      if (req.url!.startsWith("/widget")) return void res.writeHead(200, { "Content-Type": "text/html" }).end(html);
      if (req.url!.includes("/simple/price")) return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ "pearl-2": { usd: 1.5002 }, bitcoin: { usd: 66370 }, hyperliquid: { usd: 67 } }));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ tickers: [] }));
    }).listen(0);
    const base = `http://127.0.0.1:${(fake.address() as any).port}`;
    process.env.ASTEKZ_WIDGET_URL = `${base}/widget`;
    process.env.COINGECKO_BASE = base;
    try {
      const { astekzStore, initSchema } = await import("../server/storage");
      await initSchema();
      const { refreshAstekz, astekzState, astekzTick } = await import("../server/astekz");
      await astekzStore.clear();
      const D1 = Date.UTC(2026, 10, 15, 9);
      const D2 = Date.UTC(2026, 10, 16, 9);
      expect(await refreshAstekz(D1)).toEqual({ ok: true, error: null });
      // Today has its read: the clock leaves it alone.
      expect(await astekzTick(D1 + 3600_000)).toBe(false);

      down = true;
      const failed = await refreshAstekz(D2);
      expect(failed.ok).toBe(false);
      let st = await astekzState(D2);
      expect(st.latest?.day).toBe("2026-11-15");
      expect(st.failed?.error).toMatch(/503/);
      // Not again within the hour; then yes.
      expect(await astekzTick(D2 + 10 * 60_000)).toBe(false);

      down = false;
      html = AFTER;
      expect((await refreshAstekz(D2 + 2 * 3600_000)).ok).toBe(true);
      st = await astekzState(D2 + 2 * 3600_000);
      expect(st.failed).toBeNull();
      expect(st.history.map((h) => h.date)).toEqual(["2026-11-15", "2026-11-16"]);
      expect(st.changes[0].sold[0].ticker).toBe("HYPE");
      expect(st.latest?.holdings.map((h) => h.ticker)).toEqual(["PEARL", "BTC", "CASH"]);
    } finally {
      delete process.env.ASTEKZ_WIDGET_URL;
      delete process.env.COINGECKO_BASE;
      await new Promise((r) => fake.close(r));
    }
  });
});
