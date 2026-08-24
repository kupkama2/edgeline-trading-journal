import { describe, expect, it } from "vitest";
import {
  binanceSymbolForTrade,
  firstTouch,
  matchBinanceSymbol,
  type BinanceSymbol,
  type Candle,
} from "../shared/binance";

/** A bar, written the way a chart reads: open, high, low, close. */
const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c });

/** Long from 100, stop 90, target 130. */
const plan = { direction: "long", stop: 90, target: 130 };
const short = { direction: "short", stop: 110, target: 70 };

describe("which level price reached first", () => {
  it("finds the target when the move went straight there", () => {
    const out = firstTouch([bar(1, 100, 110, 99, 108), bar(2, 108, 131, 107, 130)], plan);
    expect(out).toEqual({ verdict: "target_first", at: 2 });
  });

  it("finds the stop when it went the other way", () => {
    const out = firstTouch([bar(1, 100, 102, 95, 96), bar(2, 96, 97, 89, 90)], plan);
    expect(out).toEqual({ verdict: "stop_first", at: 2 });
  });

  it("reads WICKS, not closes", () => {
    // A bar that dipped to the stop and closed back at 105 is a stopped-out
    // trade. Scanning closes would report that trades routinely survive levels
    // they were taken out at — the single most dangerous way to get this wrong.
    const out = firstTouch([bar(1, 100, 106, 89.5, 105)], plan);
    expect(out.verdict).toBe("stop_first");
  });

  it("counts price trading exactly AT the level", () => {
    expect(firstTouch([bar(1, 100, 130, 99, 129)], plan).verdict).toBe("target_first");
    expect(firstTouch([bar(1, 100, 101, 90, 95)], plan).verdict).toBe("stop_first");
  });

  it("needs no special case for a gap through the level", () => {
    // A bar that OPENS beyond the stop still has the stop inside its range.
    expect(firstTouch([bar(1, 80, 82, 78, 81)], plan).verdict).toBe("stop_first");
  });

  it("refuses to guess when one bar touched both", () => {
    // The order inside the bar is unknowable at this resolution. Picking one
    // would write a confident wrong answer into the field that potentialR and
    // managementDeltaR are built from — worse than leaving it blank, because a
    // blank is visibly missing and a wrong answer is not.
    const out = firstTouch([bar(7, 100, 131, 89, 120)], plan);
    expect(out).toEqual({ verdict: "ambiguous", at: 7 });
  });

  it("says pending while neither has happened", () => {
    const out = firstTouch([bar(1, 100, 112, 95, 108), bar(2, 108, 120, 101, 118)], plan);
    expect(out).toEqual({ verdict: "pending" });
  });

  it("is pending on an empty range rather than inventing a verdict", () => {
    expect(firstTouch([], plan)).toEqual({ verdict: "pending" });
  });

  it("takes the FIRST touch, not the last", () => {
    // Stopped on bar 2; that the target printed later is exactly the fact this
    // is meant to distinguish from "it would have worked".
    const out = firstTouch(
      [bar(1, 100, 105, 96, 97), bar(2, 97, 99, 88, 92), bar(3, 92, 140, 91, 139)],
      plan,
    );
    expect(out).toEqual({ verdict: "stop_first", at: 2 });
  });

  it("flips both comparisons for a short", () => {
    // Short from 100: the target is BELOW and the stop ABOVE, so the tests
    // that mean "hit" are the other way round on both.
    expect(firstTouch([bar(1, 100, 104, 69, 72)], short).verdict).toBe("target_first");
    expect(firstTouch([bar(1, 100, 111, 98, 109)], short).verdict).toBe("stop_first");
    expect(firstTouch([bar(1, 100, 105, 95, 97)], short).verdict).toBe("pending");
  });

  it("declines when the plan has no levels to reach", () => {
    expect(firstTouch([bar(1, 1, 999, 0, 5)], { ...plan, stop: null }).verdict).toBe("pending");
    expect(firstTouch([bar(1, 1, 999, 0, 5)], { ...plan, target: null }).verdict).toBe("pending");
  });
});

/* --------------------------------------------------------------------- */

const cat: BinanceSymbol[] = [
  { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING" },
  { symbol: "BTCUSDC", baseAsset: "BTC", quoteAsset: "USDC", status: "TRADING" },
  { symbol: "ETHBTC", baseAsset: "ETH", quoteAsset: "BTC", status: "TRADING" },
  { symbol: "ETHUSDC", baseAsset: "ETH", quoteAsset: "USDC", status: "TRADING" },
  { symbol: "HYPEUSDT", baseAsset: "HYPE", quoteAsset: "USDT", status: "TRADING" },
  { symbol: "OLDUSDT", baseAsset: "OLD", quoteAsset: "USDT", status: "BREAK" },
  { symbol: "ONLYBTC", baseAsset: "ONLY", quoteAsset: "BTC", status: "TRADING" },
];

describe("matching a journal symbol to a Binance pair", () => {
  it("takes a pair typed straight in", () => {
    expect(matchBinanceSymbol("BTCUSDT", cat)).toBe("BTCUSDT");
    expect(matchBinanceSymbol(" btcusdt ", cat)).toBe("BTCUSDT");
  });

  it("resolves a bare ticker to its best-quoted pair", () => {
    expect(matchBinanceSymbol("HYPE", cat)).toBe("HYPEUSDT");
    expect(matchBinanceSymbol("BTC", cat)).toBe("BTCUSDT"); // USDT over USDC
  });

  it("falls back through the stablecoins when there is no USDT pair", () => {
    expect(matchBinanceSymbol("ETH", cat)).toBe("ETHUSDC");
  });

  it("refuses a base that only trades against BTC", () => {
    // A level in dollars is not a level in satoshis. Resolving a trade against
    // the wrong denominator is the confident wrong answer, dressed as data.
    expect(matchBinanceSymbol("ONLY", cat)).toBeNull();
  });

  it("ignores pairs that are not trading", () => {
    expect(matchBinanceSymbol("OLD", cat)).toBeNull();
    expect(matchBinanceSymbol("OLDUSDT", cat)).toBeNull();
  });

  it("says null for anything it does not recognise", () => {
    expect(matchBinanceSymbol("NOTACOIN", cat)).toBeNull();
    expect(matchBinanceSymbol("", cat)).toBeNull();
    expect(matchBinanceSymbol(null, cat)).toBeNull();
  });
});

describe("matching a whole trade", () => {
  it("resolves an ordinary spot trade", () => {
    expect(binanceSymbolForTrade({ symbol: "HYPE", contract: null }, cat)).toBe("HYPEUSDT");
  });

  it("never touches a futures trade", () => {
    // Nothing stops a token called NQ from listing tomorrow, and resolving a
    // Nasdaq future against a memecoin's candles would be catastrophic and
    // silent. A trade carrying a contract is not matched at all.
    expect(binanceSymbolForTrade({ symbol: "BTC", contract: "MBTZ6" }, cat)).toBeNull();
    expect(binanceSymbolForTrade({ symbol: "BTC", contract: "   " }, cat)).toBe("BTCUSDT");
  });
});

describe("how finely to scan a window", () => {
  it("gets coarser as the window gets longer", async () => {
    const { intervalFor } = await import("../server/binance");
    const h = 3_600_000;
    expect(intervalFor(6 * h)).toBe("1m");
    expect(intervalFor(48 * h)).toBe("5m");
    expect(intervalFor(24 * 7 * h)).toBe("1h");
    expect(intervalFor(24 * 90 * h)).toBe("4h");
  });

  it("never returns a bar so wide that most trades come back ambiguous", async () => {
    // The trade-off this function IS: a wider bar is fewer requests and more
    // bars that swallow both levels at once, and an ambiguous verdict is a
    // trade left parked. Daily bars would do that to almost everything.
    const { intervalFor } = await import("../server/binance");
    for (const days of [1, 7, 30, 365, 3650]) {
      expect(intervalFor(days * 24 * 3_600_000)).not.toBe("1d");
    }
  });
});
