import { describe, expect, it } from "vitest";
import {
  binanceSymbolForTrade,
  pairForTradeWithFallback,
  SEED_CATALOGUE,
  type BinanceSymbol,
} from "../shared/binance";

/**
 * Reading the book that was actually traded, when the venue will not say
 * which books exist.
 *
 * fapi.binance.com answers 451 from a US host, so the catalogue comes back
 * spot-only and every perp trade resolves to its SPOT pair. Nothing about
 * that looks broken — the chart draws, the numbers are numbers — but a
 * liquidation cascade wicks the perp through levels spot never prints, and
 * that is precisely the level that decides whether a stop was hit.
 */
const spotOnly: BinanceSymbol[] = [
  { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING", market: "spot" },
  { symbol: "SUIUSDT", baseAsset: "SUI", quoteAsset: "USDT", status: "TRADING", market: "spot" },
  { symbol: "QUIRKUSDT", baseAsset: "QUIRK", quoteAsset: "USDT", status: "TRADING", market: "spot" },
];
const bothBooks: BinanceSymbol[] = [
  ...spotOnly,
  { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING", market: "futures" },
];

describe("when the futures book refused", () => {
  it("re-points a coin that has a perp at its perp", () => {
    // What the old call did, and why it was wrong.
    expect(binanceSymbolForTrade({ symbol: "BTC" }, spotOnly)?.market).toBe("spot");
    expect(pairForTradeWithFallback({ symbol: "BTC" }, spotOnly)).toMatchObject({
      symbol: "BTCUSDT",
      market: "futures",
    });
  });

  it("leaves a spot-only coin on spot", () => {
    /*
     * The distinction the written-down list exists to make. A coin matched to
     * spot because the perp book refused is a wrong answer; a coin that
     * genuinely trades on spot alone is a right one, and must keep working.
     */
    expect(pairForTradeWithFallback({ symbol: "QUIRK" }, spotOnly)?.market).toBe("spot");
  });

  it("still answers for a coin the catalogue never listed", () => {
    // Nothing matched at all, but the coin is known to have a perp — the
    // archive can serve it without the catalogue's help.
    expect(binanceSymbolForTrade({ symbol: "SOL" }, spotOnly)).toBeNull();
    expect(pairForTradeWithFallback({ symbol: "SOL" }, spotOnly)?.market).toBe("futures");
  });

  it("treats an empty catalogue as a refused futures book", () => {
    // The venue never answered, which leaves the perp book exactly as
    // unavailable as answering with spot alone does.
    expect(pairForTradeWithFallback({ symbol: "BTC" }, [])).toMatchObject({ market: "futures" });
  });
});

describe("when the futures book answered", () => {
  it("uses the venue's own catalogue rather than the written-down list", () => {
    expect(pairForTradeWithFallback({ symbol: "BTC" }, bothBooks)?.market).toBe("futures");
  });

  it("does not drag a coin the venue delisted back in", () => {
    /*
     * With the futures book present, its silence about a coin is an answer:
     * the perp is not there. Reaching for the seed list would resurrect a
     * pair the venue just said it does not have.
     */
    expect(pairForTradeWithFallback({ symbol: "SUI" }, bothBooks)?.market).toBe("spot");
  });
});

describe("a futures contract is not a Binance pair at all", () => {
  it("stays unmatched", () => {
    // MNQU6 is a CME micro, not a coin. Handing it a perp would be inventing
    // an instrument.
    expect(pairForTradeWithFallback({ symbol: "NQ", contract: "MNQU6" }, spotOnly)).toBeNull();
  });
});
