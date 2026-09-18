import { describe, expect, it } from "vitest";
import {
  describePair,
  formatPricePair,
  pairCandidates,
  parsePricePair,
} from "../shared/price-pair";
import { pairForTradeAt } from "../server/candles";
import { trade } from "./helpers";

/**
 * Pointing a trade at a book by hand. The stored string is the only thing
 * standing between an unmatched trade and never being read again, so a bad one
 * must behave as no override rather than as a wrong one.
 */
const bin = [
  { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING", market: "futures" as const },
  { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING", market: "spot" as const },
  { symbol: "ETHUSDT", baseAsset: "ETH", quoteAsset: "USDT", status: "TRADING", market: "futures" as const },
  { symbol: "1000PEPEUSDT", baseAsset: "1000PEPE", quoteAsset: "USDT", status: "TRADING", market: "futures" as const },
];
const hl = [{ name: "BTC" }, { name: "HYPE" }];

describe("reading and writing a chosen pair", () => {
  it("round-trips all three shapes", () => {
    for (const ref of [
      { symbol: "BTCUSDT", market: "futures" as const, venue: "binance" as const },
      { symbol: "ETHUSDT", market: "spot" as const, venue: "binance" as const },
      { symbol: "BTC", market: "futures" as const, venue: "hyperliquid" as const },
    ]) {
      expect(parsePricePair(formatPricePair(ref))).toEqual(ref);
    }
  });

  it("treats a missing venue on a Binance ref as Binance", () => {
    expect(formatPricePair({ symbol: "BTCUSDT", market: "futures" })).toBe(
      "binance:BTCUSDT:futures",
    );
  });

  it("gives Hyperliquid futures without being told, because it has nothing else", () => {
    expect(parsePricePair("hyperliquid:HYPE")).toEqual({
      symbol: "HYPE",
      market: "futures",
      venue: "hyperliquid",
    });
  });

  it("upper-cases the symbol, since a venue's book does", () => {
    expect(parsePricePair("binance:btcusdt:futures")?.symbol).toBe("BTCUSDT");
  });

  it("is null on anything it cannot understand, never a guess", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "   ",
      "BTCUSDT",
      "binance:BTCUSDT",
      "binance:BTCUSDT:perp",
      "binance::futures",
      "kraken:BTCUSD:futures",
    ]) {
      expect(parsePricePair(bad as any)).toBeNull();
    }
  });

  it("keeps every colon after the first for Hyperliquid, where a book qualifies its coins", () => {
    // "hyperliquid:vntls:NVDA" is a builder book's NVDA, not a malformed
    // value: splitting on every colon would make the BOOK the symbol.
    expect(parsePricePair("hyperliquid:vntls:NVDA")?.symbol).toBe("vntls:NVDA");
  });

  it("keeps Hyperliquid's own spelling, which the venue is case-sensitive about", () => {
    // A book is named as its deployer wrote it and goes back as the `dex` on
    // every request; the venue writes a thousand-lot with a small k. Upper-
    // casing either asks about something that does not exist.
    expect(parsePricePair("hyperliquid:kPEPE")?.symbol).toBe("kPEPE");
    expect(parsePricePair("hyperliquid:xyz:GOLD")?.symbol).toBe("xyz:GOLD");
  });

  it("names a pair in one line", () => {
    expect(describePair({ symbol: "BTCUSDT", market: "futures", venue: "binance" })).toBe(
      "Binance BTCUSDT perp",
    );
    expect(describePair({ symbol: "ETHUSDT", market: "spot", venue: "binance" })).toBe(
      "Binance ETHUSDT spot",
    );
    expect(describePair({ symbol: "BTC", market: "futures", venue: "hyperliquid" })).toBe(
      "Hyperliquid BTC perp",
    );
  });
});

describe("what the picker offers", () => {
  it("puts an exact match first, and a perp before its own spot pair", () => {
    const out = pairCandidates("BTC", bin, hl);
    expect(out[0]).toEqual({ symbol: "BTC", market: "futures", venue: "hyperliquid" });
    const binanceOnly = out.filter((r) => r.venue === "binance");
    expect(binanceOnly[0].market).toBe("futures");
    expect(binanceOnly[1].market).toBe("spot");
  });

  it("puts the USDT book ahead of a thinner quote on the same coin", () => {
    const withUsdc = [
      ...bin,
      { symbol: "BTCUSDC", baseAsset: "BTC", quoteAsset: "USDC", status: "TRADING", market: "futures" as const },
    ];
    const binanceOnly = pairCandidates("BTC", withUsdc, []).filter((r) => r.venue === "binance");
    // Alphabetically USDC comes first; the deep book is the one that printed
    // the wick that took the stop, so it wins anyway.
    expect(binanceOnly[0].symbol).toBe("BTCUSDT");
  });

  it("still offers something when the spellings only overlap", () => {
    // The journal's PEPE against the venue's 1000PEPE — the exact case the
    // automatic match gives up on.
    const out = pairCandidates("PEPE", bin, hl);
    expect(out.map((r) => r.symbol)).toContain("1000PEPEUSDT");
  });

  it("offers nothing for an empty ticker rather than everything", () => {
    expect(pairCandidates("   ", bin, hl)).toEqual([]);
  });

  it("leaves out coins that have nothing to do with the ticker", () => {
    expect(pairCandidates("HYPE", bin, hl).map((r) => r.symbol)).toEqual(["HYPE"]);
  });
});

describe("the override beats every rule under it", () => {
  const cat = bin;
  const names = hl.map((h) => h.name);

  it("is used ahead of the ticker", () => {
    const t = trade({ symbol: "BTC", pricePair: "binance:ETHUSDT:futures" });
    expect(pairForTradeAt(t as any, cat, names)).toEqual({
      symbol: "ETHUSDT",
      market: "futures",
      venue: "binance",
    });
  });

  it("is used ahead of the account's venue", () => {
    const t = trade({ symbol: "BTC", account: "Hyperliquid", pricePair: "binance:BTCUSDT:spot" });
    expect(pairForTradeAt(t as any, cat, names)).toEqual({
      symbol: "BTCUSDT",
      market: "spot",
      venue: "binance",
    });
  });

  it("rescues a trade carrying a contract code, which otherwise reads as not crypto", () => {
    const t = trade({ symbol: "BTC", contract: "BTCH6", pricePair: "hyperliquid:BTC" });
    expect(pairForTradeAt(t as any, cat, names)).toEqual({
      symbol: "BTC",
      market: "futures",
      venue: "hyperliquid",
    });
    // And without the override it is still not crypto.
    expect(pairForTradeAt({ ...t, pricePair: null } as any, cat, names)).toBeNull();
  });

  it("falls back to the ticker when the stored string is nonsense", () => {
    const t = trade({ symbol: "BTC", pricePair: "kraken:BTCUSD" });
    expect(pairForTradeAt(t as any, cat, names)?.symbol).toBe("BTCUSDT");
  });
});
