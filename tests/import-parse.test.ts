import { describe, expect, it } from "vitest";
import {
  candidateKey,
  dropBracketLegs,
  mergeCandidates,
  parseImport,
  parseNum,
  parseVenueTime,
  pruneWarnings,
  type ImportCandidate,
} from "../shared/import-parse";

const BINANCE = [
  "2026-08-05 21:30:51\tBTCUSDT Perp\tLimit\tOpen Short\t65,109.40\t37,177.47 USDT\t0.00 USDT\tNo",
  "2026-08-05 12:55:01\tHYPEUSDT Perp\tLimit\tOpen Long\t53.84200\t4,655.18 USDT\t0.00 USDT\tNo",
].join("\n");

const OTOCO = `Take Profit / Stop Loss
If order A is filled partially or fully, orders B and C will be placed.
Limit New Order A
Side Buy
Amount 4,655.18 USDT
Price 53.842
Take Profit Market Pending Order B
Side Sell
Stop Price 59.3
Stop Market Pending Order C
Side Sell
Stop Price 51.918`;

/** TradingView working orders: ONE bracketed order drawn as three rows. */
const BRACKET = [
  "MNQU6\tSell\tLimit\t1\t\t\t29,701.75\t\t29,599.50\t29,728.75\t\tWorking\t2026-08-06 17:10:49",
  "MNQU6\tBuy\tTake Profit\t1\t\t\t29,599.50\t\t\t\t\tInactive\t2026-08-06 17:10:49",
  "MNQU6\tBuy\tStop Loss\t1\t\t\t\t29,728.75\t\t\t\tInactive\t2026-08-06 17:10:49",
].join("\n");

describe("primitives", () => {
  it("reads venue-formatted numbers", () => {
    expect(parseNum("37,177.47 USDT")).toBe(37177.47);
    expect(parseNum("-1,234.5")).toBe(-1234.5);
    expect(parseNum("")).toBeNull();
    expect(parseNum("n/a")).toBeNull();
  });

  it("reads venue timestamps as LOCAL time", () => {
    // The venue prints the trader's wall clock; whatever the zone, 21:30 on
    // the paste must stay 21:30 on the clock every breakdown buckets by.
    const iso = parseVenueTime("2026-08-05 21:30:51")!;
    const d = new Date(iso);
    expect(d.getHours()).toBe(21);
    expect(d.getMinutes()).toBe(30);
    expect(parseVenueTime("junk")).toBeNull();
  });
});

describe("parseImport", () => {
  it("reads a Binance open-orders table as quote-sized pending trades", () => {
    const r = parseImport(BINANCE);
    expect(r.candidates).toHaveLength(2);
    const [btc, hype] = r.candidates;
    expect(btc.symbol).toBe("BTCUSDT");
    expect(btc.direction).toBe("short");
    expect(btc.sizeUnit).toBe("quote");
    expect(btc.size).toBe(37177.47);
    expect(hype.entryPrice).toBe(53.842);
    // This view carries no protective levels and must say so.
    expect(btc.initialStop).toBeNull();
    expect(btc.warnings.join(" ")).toMatch(/no stop or target/i);
  });

  it("reads the OTOCO dialog as one order with both legs", () => {
    const r = parseImport(OTOCO);
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.direction).toBe("long");
    expect(c.initialTarget).toBe(59.3); // Order B
    expect(c.initialStop).toBe(51.918); // Order C
    expect(c.symbol).toBe(""); // the dialog names no instrument
  });

  /**
   * Regression: parseImport used to return early on the dialog, silently
   * discarding every table row pasted above it — and the dialog's symbol scan
   * read the whole paste, stealing the FIRST ticker from the table.
   */
  it("parses a table with the dialog appended, without cross-contamination", () => {
    const r = parseImport(BINANCE + "\n" + OTOCO);
    expect(r.candidates).toHaveLength(3);
    const otoco = r.candidates.find((c) => c.source === "binance-otoco")!;
    expect(otoco.symbol).toBe(""); // NOT "BTCUSDT" lifted from the table
  });

  /**
   * Regression: a bracketed futures order occupies three rows. Counting them
   * as three trades made a single order look like a batch, and offered the
   * take profit for import as a trade of its own.
   */
  it("folds a three-row bracket into one trade", () => {
    const r = parseImport(BRACKET);
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.direction).toBe("short");
    expect(c.entryPrice).toBe(29701.75);
    expect(c.initialStop).toBe(29728.75);
    expect(c.initialTarget).toBe(29599.5);
  });

  it("recovers levels from children when the parent's columns are blank", () => {
    const blankParent = BRACKET.replace(
      "29,701.75\t\t29,599.50\t29,728.75",
      "29,701.75\t\t\t",
    );
    const r = parseImport(blankParent);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].initialStop).toBe(29728.75);
    expect(r.candidates[0].initialTarget).toBe(29599.5);
  });
});

describe("mergeCandidates", () => {
  it("attaches the dialog's levels to the order it brackets, by price and side", () => {
    const { rows, merged } = mergeCandidates([
      ...parseImport(BINANCE).candidates,
      ...parseImport(OTOCO).candidates,
    ]);
    expect(rows).toHaveLength(2);
    expect(merged).toBe(1);
    const hype = rows.find((r) => r.symbol === "HYPEUSDT")!;
    expect(hype.initialStop).toBe(51.918);
    expect(hype.initialTarget).toBe(59.3);
    // The stale "no stop or target" complaint must be gone…
    expect(hype.warnings.join(" ")).not.toMatch(/no stop or target/i);
    // …replaced by a note saying where the levels came from.
    expect(hype.warnings.join(" ")).toMatch(/matched from/i);
  });

  it("folds an identical table pasted twice", () => {
    const twice = [...parseImport(BINANCE).candidates, ...parseImport(BINANCE).candidates];
    const { rows, merged } = mergeCandidates(twice);
    expect(rows).toHaveLength(2);
    expect(merged).toBe(2);
  });

  it("refuses to fold across sides even at the same price", () => {
    const flipped = parseImport(OTOCO.replace("Side Buy", "Side Sell")).candidates;
    const { rows, merged } = mergeCandidates([
      ...parseImport(BINANCE).candidates,
      ...flipped,
    ]);
    expect(merged).toBe(0);
    expect(rows).toHaveLength(3);
  });

  it("names a bracket that matched nothing instead of listing it silently", () => {
    const orphan = parseImport(OTOCO.replace("Price 53.842", "Price 99.111")).candidates;
    const { rows } = mergeCandidates([...parseImport(BINANCE).candidates, ...orphan]);
    const stray = rows.find((r) => r.entryPrice === 99.111)!;
    expect(stray.warnings.join(" ")).toMatch(/no resting order here/i);
  });
});

describe("dropBracketLegs", () => {
  const row = (o: Partial<ImportCandidate>): ImportCandidate => ({
    symbol: "MNQU6",
    direction: "long",
    size: 1,
    sizeUnit: "base",
    entryPrice: 0,
    initialStop: null,
    initialTarget: null,
    entryTime: null,
    source: "futures-orders",
    raw: "",
    warnings: [],
    ...o,
  });

  const parent = row({
    direction: "short",
    entryPrice: 29701.75,
    initialStop: 29728.75,
    initialTarget: 29599.5,
  });

  it("drops exit legs a vision model failed to fold", () => {
    const kept = dropBracketLegs([
      parent,
      row({ entryPrice: 29599.5 }), // take-profit child
      row({ entryPrice: 29728.75 }), // stop-loss child
    ]);
    expect(kept).toEqual([parent]);
  });

  it("keeps a stop-and-reverse that carries its own bracket", () => {
    const reverse = row({
      entryPrice: 29728.75,
      initialStop: 29700,
      initialTarget: 29800,
    });
    expect(dropBracketLegs([parent, reverse])).toHaveLength(2);
  });

  it("leaves an ordinary batch alone", () => {
    const batch = [
      row({ symbol: "BTCUSDT", direction: "short", entryPrice: 65109.4 }),
      row({ symbol: "HYPEUSDT", entryPrice: 53.842 }),
    ];
    expect(dropBracketLegs(batch)).toHaveLength(2);
  });
});

describe("pruneWarnings", () => {
  const base: ImportCandidate = {
    symbol: "BTCUSDT",
    direction: "short",
    size: 1,
    sizeUnit: "quote",
    entryPrice: 65109.4,
    initialStop: null,
    initialTarget: null,
    entryTime: null,
    source: "binance-orders",
    raw: "",
    warnings: ["No stop or target in this view — add them when it fills."],
  };

  it("keeps a two-field warning until BOTH fields have arrived", () => {
    expect(pruneWarnings({ ...base, initialStop: 66000 })).toHaveLength(1);
    expect(
      pruneWarnings({ ...base, initialStop: 66000, initialTarget: 63000 }),
    ).toHaveLength(0);
  });

  it("never prunes result notes that merely mention a field", () => {
    const c = {
      ...base,
      initialStop: 66000,
      initialTarget: 63000,
      warnings: ["Stop and target matched from a binance otoco paste."],
    };
    expect(pruneWarnings(c)).toHaveLength(1);
  });
});

describe("candidateKey", () => {
  it("is the order's identity: side and limit price", () => {
    expect(candidateKey({ direction: "long", entryPrice: 53.842 })).toBe(
      candidateKey({ direction: "long", entryPrice: 53.842 }),
    );
    expect(candidateKey({ direction: "long", entryPrice: 53.842 })).not.toBe(
      candidateKey({ direction: "short", entryPrice: 53.842 }),
    );
  });
});
