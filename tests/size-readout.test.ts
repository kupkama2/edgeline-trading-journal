import { describe, expect, it } from "vitest";
import { coinOf, notionalReadout } from "../shared/sizing";

/**
 * The unit you did not type, at the entry price. Coins and dollars are the
 * same position said two ways; the form says the other way so the size is
 * judged in both.
 */
describe("the other unit", () => {
  it("says the dollars when the size is in coins", () => {
    expect(notionalReadout({ size: 0.5, sizeUnit: "base", entryPrice: 2500, symbol: "ETHUSDT" })).toBe(
      "0.5 ETH ≈ $1,250 at entry",
    );
  });

  it("says the coins when the size is in dollars", () => {
    expect(notionalReadout({ size: 1250, sizeUnit: "quote", entryPrice: 2500, symbol: "ETH" })).toBe(
      "$1,250 ≈ 0.5 ETH at entry",
    );
    expect(notionalReadout({ size: 200, sizeUnit: "quote", entryPrice: 0.0064875, symbol: "PENGUUSDT" })).toBe(
      "$200 ≈ 30829 PENGU at entry",
    );
  });

  it("says nothing without a price or a size, and nothing for a contract", () => {
    expect(notionalReadout({ size: 0.5, sizeUnit: "base", entryPrice: 0, symbol: "ETH" })).toBeNull();
    expect(notionalReadout({ size: 0, sizeUnit: "base", entryPrice: 2500, symbol: "ETH" })).toBeNull();
    expect(notionalReadout({ size: 2, sizeUnit: "base", entryPrice: 29700, symbol: "MNQU6" })).toBeNull();
  });

  it("names the coin without its quote or venue suffix", () => {
    expect(coinOf("ETHUSDT")).toBe("ETH");
    expect(coinOf("btc-perp")).toBe("BTC");
    expect(coinOf("BTC-USD-PERP")).toBe("BTC");
    expect(coinOf("1000PEPEUSDT")).toBe("1000PEPE");
    expect(coinOf("kPEPE")).toBe("KPEPE");
  });
});
