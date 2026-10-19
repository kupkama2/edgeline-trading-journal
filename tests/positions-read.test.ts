import { describe, expect, it } from "vitest";
import { readPositionsTable } from "../shared/positions-read";

/**
 * The Positions tab that asked for this: four longs opened as one idea, every
 * one with a stop, one with a target — read as the model should hand it over.
 */
const tab = {
  positions: [
    { symbol: "ZECUSDT Perp", direction: null, size: "3,028.28", sizeUnit: "quote", entryPrice: "1,137.29", positionTp: "--", positionSl: "--", orderTp: null, orderSl: "1,068.14", leverage: 45 },
    { symbol: "INJUSDT", direction: "long", size: 2049.41, sizeUnit: "quote", entryPrice: 8.429, positionTp: null, positionSl: null, orderTp: null, orderSl: 7.946, leverage: 20 },
    { symbol: "BTCUSDC", direction: "long", size: 10079.95, sizeUnit: "quote", entryPrice: 81620.1, positionTp: 84262.8, positionSl: null, orderTp: null, orderSl: 80539.2, leverage: 20 },
    { symbol: "ONDOUSDT", direction: "long", size: 2484.32, sizeUnit: "quote", entryPrice: 0.4408999, positionTp: null, positionSl: null, orderTp: null, orderSl: 0.3943, leverage: 20 },
  ],
};

describe("a Positions tab, row by row", () => {
  const rows = readPositionsTable(tab);

  it("reads all four, with the stop from whichever column holds it", () => {
    expect(rows.map((r) => [r.symbol, r.direction, r.size, r.sizeUnit, r.entryPrice, r.initialStop, r.initialTarget])).toEqual([
      ["ZECUSDT", "long", 3028.28, "quote", 1137.29, 1068.14, null],
      ["INJUSDT", "long", 2049.41, "quote", 8.429, 7.946, null],
      ["BTCUSDC", "long", 10079.95, "quote", 81620.1, 80539.2, 84262.8],
      ["ONDOUSDT", "long", 2484.32, "quote", 0.4408999, 0.3943, null],
    ]);
  });

  it("says when the side was read from the size's sign", () => {
    expect(rows[0].warnings.join(" ")).toMatch(/positive is a long/);
    expect(rows[1].warnings).toEqual([]);
  });
});

describe("what a row is not allowed to say", () => {
  it("reads a negative size as a short, and keeps the size positive", () => {
    const [r] = readPositionsTable({ positions: [{ symbol: "SOLUSDT", size: "-4962.12", sizeUnit: "quote", entryPrice: 120, positionSl: 125 }] });
    expect(r).toMatchObject({ direction: "short", size: 4962.12, initialStop: 125 });
  });

  it("drops a stop on the profit side and says why", () => {
    const [r] = readPositionsTable({ positions: [{ symbol: "ETHUSDT", direction: "long", size: 1000, sizeUnit: "quote", entryPrice: 2000, orderSl: 2100 }] });
    expect(r.initialStop).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/profit side/);
  });

  it("prefers the position's stop, and says when an order's disagrees", () => {
    const [r] = readPositionsTable({ positions: [{ symbol: "BTCUSDT", direction: "long", size: 1, sizeUnit: "base", entryPrice: 100, positionSl: 95, orderSl: 97 }] });
    expect(r.initialStop).toBe(95);
    expect(r.warnings.join(" ")).toMatch(/Two stops/);
  });

  it("skips a row with no entry, no size, or no side it can tell", () => {
    expect(
      readPositionsTable({
        positions: [
          { symbol: "AUSDT", direction: "long", size: 1 },
          { symbol: "BUSDT", direction: "long", entryPrice: 1 },
          { symbol: "CUSDT", size: "0", entryPrice: 1 },
        ],
      }),
    ).toEqual([]);
  });
});
