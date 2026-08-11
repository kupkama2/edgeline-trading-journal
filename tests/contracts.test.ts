import { describe, expect, it } from "vitest";
import {
  contractFor,
  exposureOf,
  fmtExposure,
  lastPointValueFor,
  normalizeSymbol,
  pointValueFor,
} from "../shared/symbols";

/**
 * Crypto futures are where the size table earns its keep: the same underlying
 * is sold in 5 BTC, 0.1 BTC and 0.01 BTC lots, and getting the multiplier
 * wrong misprices every R on the trade without any visible error.
 */

describe("crypto futures", () => {
  it("knows what a micro holds", () => {
    expect(pointValueFor("MBT")).toBe(0.1);
    expect(pointValueFor("MBTZ6")).toBe(0.1);
    expect(pointValueFor("MET")).toBe(0.1);
  });

  it("rolls every size and month up to one instrument", () => {
    // The whole point of the rollup: micro, full-size and every expiry are one
    // book, or the stats fragment across contracts that are the same idea.
    expect(normalizeSymbol("MBT")).toBe("BTC");
    expect(normalizeSymbol("MBTZ6")).toBe("BTC");
    expect(normalizeSymbol("BTCZ6")).toBe("BTC");
    expect(normalizeSymbol("METH7")).toBe("ETH");
  });

  it("treats a bare BTC as spot, not as a five-coin contract", () => {
    // The trap this table exists to avoid. "BTC" in a crypto journal is spot
    // roughly always; reading it as CME's 5 BTC future would multiply the
    // position by five and report it as fact.
    expect(pointValueFor("BTC")).toBe(1);
    expect(pointValueFor("ETH")).toBe(1);
    expect(contractFor("BTC")).toBeNull();
    // ...but a month code is an unambiguous statement that a contract is meant.
    expect(pointValueFor("BTCZ6")).toBe(5);
    expect(pointValueFor("ETHZ6")).toBe(50);
  });

  it("leaves spot pairs alone", () => {
    expect(pointValueFor("BTCUSDT")).toBe(1);
    expect(pointValueFor("BTCUSD")).toBe(1);
    expect(normalizeSymbol("BTCUSDT")).toBe("BTCUSDT");
  });

  it("still sizes the index and commodity contracts it always did", () => {
    expect(pointValueFor("MNQU6")).toBe(2);
    expect(pointValueFor("NQ")).toBe(20);
    expect(pointValueFor("MGC")).toBe(10);
    expect(pointValueFor("CL")).toBe(1000);
  });
});

describe("what the position actually holds", () => {
  it("converts contracts into coins", () => {
    expect(fmtExposure(exposureOf("MBT", 3))).toBe("0.3 BTC");
    expect(fmtExposure(exposureOf("MBTZ6", 1))).toBe("0.1 BTC");
    expect(fmtExposure(exposureOf("BTCZ6", 2))).toBe("10 BTC");
  });

  it("uses the unit the contract is actually quoted in", () => {
    expect(fmtExposure(exposureOf("MGC", 2))).toBe("20 oz");
    expect(fmtExposure(exposureOf("CL", 1))).toBe("1000 bbl");
  });

  it("says nothing for an instrument with no such unit", () => {
    // An NQ point is an index point. Printing "40 NQ" would be inventing a
    // quantity of something that does not exist.
    expect(exposureOf("MNQ", 20)).toBeNull();
    expect(exposureOf("AAPL", 100)).toBeNull();
    expect(fmtExposure(null)).toBeNull();
  });

  it("honours the size the trade was booked with over the current table", () => {
    // History must not silently re-price itself when a spec is corrected.
    expect(fmtExposure(exposureOf("MBT", 3, 0.05))).toBe("0.15 BTC");
  });

  it("keeps small positions legible instead of rounding them to nothing", () => {
    expect(fmtExposure(exposureOf("MBT", 0.1))).toBe("0.01 BTC");
    expect(exposureOf("MBT", 0)).toBeNull();
  });
});

describe("remembering a contract the table has never heard of", () => {
  const hist = (rows: [string, number, string][]) =>
    rows.map(([symbol, pointValue, entryTime]) => ({ symbol, pointValue, entryTime }));

  it("reuses the size this symbol carried last time", () => {
    // A broker's nano contract cannot be guessed from a table, but it only has
    // to be explained once.
    const history = hist([["NANOBIT", 0.01, "2026-08-01T10:00:00Z"]]);
    expect(lastPointValueFor("NANOBIT", history)).toBe(0.01);
    expect(pointValueFor("NANOBIT", lastPointValueFor("NANOBIT", history))).toBe(0.01);
  });

  it("takes the most recent answer when it has changed", () => {
    const history = hist([
      ["NANOBIT", 0.01, "2026-08-01T10:00:00Z"],
      ["NANOBIT", 0.02, "2026-08-05T10:00:00Z"],
    ]);
    expect(lastPointValueFor("NANOBIT", history)).toBe(0.02);
  });

  it("matches across expiry months, not across instruments", () => {
    const history = hist([["MBTZ6", 0.1, "2026-08-01T10:00:00Z"]]);
    expect(lastPointValueFor("MBTH7", history)).toBe(0.1);
    expect(lastPointValueFor("MNQ", history)).toBeNull();
  });

  it("matches across months for a root it does NOT recognise", () => {
    // The case that matters, and the one the known-root test above quietly
    // misses: an unrecognised symbol keeps its month code when stored, so
    // December and March would look like two different instruments and the
    // size would have to be re-typed every roll.
    const history = hist([["NANOBITZ6", 0.01, "2026-08-01T10:00:00Z"]]);
    expect(lastPointValueFor("NANOBITH7", history)).toBe(0.01);
    // Still not a licence to match anything that merely starts the same.
    expect(lastPointValueFor("NANOETHH7", history)).toBeNull();
  });

  it("never lets a remembered value override a known contract", () => {
    // Someone once logged MNQ with a wrong multiplier; the table still wins,
    // or one bad row would poison every trade after it.
    const history = hist([["MNQ", 99, "2026-08-01T10:00:00Z"]]);
    expect(pointValueFor("MNQ", lastPointValueFor("MNQ", history))).toBe(2);
  });

  it("ignores junk in the history rather than trusting it", () => {
    const history = [
      { symbol: "NANOBIT", pointValue: 0, entryTime: "2026-08-02T10:00:00Z" },
      { symbol: "NANOBIT", pointValue: null, entryTime: "2026-08-03T10:00:00Z" },
    ];
    expect(lastPointValueFor("NANOBIT", history)).toBeNull();
    expect(pointValueFor("NANOBIT", null)).toBe(1);
  });
});
