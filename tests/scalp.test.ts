import { describe, expect, it } from "vitest";
import { describeScalp, parseScalpLine, scalpR } from "../shared/scalp";
import { computeMetrics } from "../shared/metrics";
import { journalHealth } from "../shared/health";
import { tradeXp } from "../shared/xp";
import { lifecycleConflict, missingRisk } from "../shared/schema";
import { trade } from "./helpers";

/**
 * The whole feature is one line of typing, so the line is where it can go
 * wrong. The result comes first and the risk second; everything here either
 * pins that order or refuses to guess.
 */
const ok = (raw: string, ctx = {}) => {
  const p = parseScalpLine(raw, ctx);
  if (!p.ok) throw new Error(`expected a scalp from ${JSON.stringify(raw)}, got: ${p.hint}`);
  return p.scalp;
};
const bad = (raw: string, ctx = {}) => {
  const p = parseScalpLine(raw, ctx);
  if (p.ok) throw new Error(`expected a refusal from ${JSON.stringify(raw)}`);
  return p.hint;
};

describe("reading the line", () => {
  it("takes the ticker and the result", () => {
    expect(ok("btc 100")).toMatchObject({ symbol: "BTC", netPnl: 100, riskAmount: null, direction: "long" });
  });

  it("takes the risk as the second number, and R falls out of the two", () => {
    const s = ok("btc 100 50");
    expect(s).toMatchObject({ netPnl: 100, riskAmount: 50, riskFrom: "typed" });
    expect(scalpR(s)).toBe(2);
  });

  it("reads a loser, with the ticker on either side", () => {
    expect(ok("btc -45")).toMatchObject({ symbol: "BTC", netPnl: -45 });
    expect(ok("-45 sol")).toMatchObject({ symbol: "SOL", netPnl: -45 });
    expect(scalpR(ok("btc -50 50"))).toBe(-1);
  });

  it("takes the risk said out loud, in any of its spellings", () => {
    for (const line of ["btc 100 r50", "btc 100 r$50", "btc 100 risk50", "btc 100 risk=50"]) {
      expect(ok(line)).toMatchObject({ netPnl: 100, riskAmount: 50, riskFrom: "typed" });
    }
  });

  it("survives the money people actually type", () => {
    expect(ok("btc $1,250.50 $500")).toMatchObject({ netPnl: 1250.5, riskAmount: 500 });
    expect(ok("btc +100")).toMatchObject({ netPnl: 100 });
  });

  it("takes a direction when it is said, and assumes long when it is not", () => {
    expect(ok("btc short 100 50").direction).toBe("short");
    expect(ok("btc 100").direction).toBe("long");
  });

  it("keeps whatever else you wrote as the note", () => {
    expect(ok("btc 100 50 chased it into the close").note).toBe("chased it into the close");
    expect(ok("btc 100").note).toBeNull();
  });
});

describe("what it will not guess", () => {
  it("refuses a line with no result", () => {
    expect(bad("btc")).toMatch(/what did it make/i);
    expect(bad("   ")).toMatch(/ticker/i);
  });

  it("refuses a line with no ticker and nothing to borrow one from", () => {
    expect(bad("100")).toMatch(/which ticker/i);
  });

  it("refuses a negative risk, which is how the two numbers get swapped", () => {
    expect(bad("btc 100 -50")).toMatch(/never negative/i);
  });
});

describe("what it borrows", () => {
  it("reuses the last ticker for a bare number, so a burst is just numbers", () => {
    expect(ok("+50", { lastSymbol: "ETH" })).toMatchObject({ symbol: "ETH", netPnl: 50 });
    // A ticker on the line always wins over the one before it.
    expect(ok("sol +50", { lastSymbol: "ETH" }).symbol).toBe("SOL");
  });

  it("falls back to the book's usual risk, and says that it did", () => {
    const s = ok("btc 100", { defaultRisk: 25 });
    expect(s).toMatchObject({ riskAmount: 25, riskFrom: "default" });
    expect(scalpR(s)).toBe(4);
    // Typed on the line beats the default, and a zero default is no default.
    expect(ok("btc 100 50", { defaultRisk: 25 })).toMatchObject({ riskAmount: 50, riskFrom: "typed" });
    expect(ok("btc 100", { defaultRisk: 0 })).toMatchObject({ riskAmount: null, riskFrom: null });
  });
});

describe("the line it shows back to you", () => {
  it("says the R, and admits when the risk was assumed", () => {
    expect(describeScalp(ok("btc 100 50"))).toBe("BTC +$100, risked $50, so +2.00R");
    expect(describeScalp(ok("btc 100", { defaultRisk: 50 }))).toBe(
      "BTC +$100, risked $50 (your default), so +2.00R",
    );
  });

  it("says so when there is no risk to divide by", () => {
    expect(describeScalp(ok("btc 100"))).toBe("BTC +$100, no risk set, so money only");
  });

  it("says the direction when it is not the usual one", () => {
    expect(describeScalp(ok("btc short -20 40"))).toBe("BTC short -$20.00, risked $40, so -0.50R");
  });
});

describe("a scalp in the numbers", () => {
  // A scalp is a result, so the metrics engine answers it from the two
  // numbers rather than from prices it does not have.
  it("reports the typed result as the P&L, and R as result over risk", () => {
    const m = computeMetrics(trade({ scalp: true, netPnl: 100, riskAmount: 50, exitPrice: null, exitTime: null, initialStop: null, initialTarget: null, size: 0, entryPrice: 0 }));
    expect(m.actualPnL).toBe(100);
    expect(m.actualR).toBe(2);
    expect(m.riskDollars).toBe(50);
  });

  it("has money but no R when no risk was recorded", () => {
    const m = computeMetrics(trade({ scalp: true, netPnl: -30, riskAmount: null, exitPrice: null, size: 0, entryPrice: 0, initialStop: null }));
    expect(m.actualPnL).toBe(-30);
    expect(m.actualR).toBeNull();
  });

  it("does not deduct fees, because the number typed is what hit the account", () => {
    const m = computeMetrics(trade({ scalp: true, netPnl: 100, riskAmount: 50, fees: 7, exitPrice: null, size: 0, entryPrice: 0 }));
    expect(m.actualPnL).toBe(100);
    expect(m.fees).toBe(0);
  });

  it("owes the journal nothing and earns no XP", () => {
    const s = trade({ scalp: true, netPnl: 20, riskAmount: 10, exitPrice: null, initialStop: null, initialTarget: null, exitReason: null, size: 0, entryPrice: 0 });
    expect(journalHealth([s], Date.UTC(2026, 8, 20))).toEqual([]);
    expect(tradeXp(s)).toEqual([]);
  });

  it("is accepted by the trade rules without levels or an exit price", () => {
    const v = { status: "closed" as const, scalp: true, initialStop: null, initialTarget: null, exitPrice: null };
    expect(missingRisk(v)).toEqual([]);
    expect(lifecycleConflict(v)).toEqual([]);
    // Without the flag the same row is refused, which is the rule working.
    expect(missingRisk({ ...v, scalp: false })).toEqual(["initialStop", "initialTarget"]);
    expect(lifecycleConflict({ ...v, scalp: false })).toHaveLength(1);
  });
});

describe("how far a scalp went, added afterwards", () => {
  // Quick to log first; the excursions are a second visit, in the same
  // money as the result, and over the risk they are R like anything else.
  const s = (over = {}) =>
    trade({ scalp: true, netPnl: 60, riskAmount: 40, exitPrice: null, size: 0, entryPrice: 0, initialStop: null, ...over });

  it("reads the best and worst it showed as R over the risk", () => {
    const m = computeMetrics(s({ netMfe: 100, netMae: -20 }));
    expect(m.mfeR).toBeCloseTo(2.5);
    expect(m.maeR).toBeCloseTo(-0.5);
  });

  it("leaves them unmeasured when they were never recorded", () => {
    const m = computeMetrics(s());
    expect(m.mfeR).toBeNull();
    expect(m.maeR).toBeNull();
  });

  it("cannot turn them into R without a risk to divide by", () => {
    const m = computeMetrics(s({ riskAmount: null, netMfe: 100 }));
    expect(m.mfeR).toBeNull();
    expect(m.actualPnL).toBe(60);
  });
});

describe("two lines run together", () => {
  // What a fast burst produces when one line fails and the next is typed on
  // top of it. Refusing is the only safe answer: logging "-25sol" under a
  // ticker called "25SOL" is a trade nobody made.
  it("will not take a mangled token as a ticker", () => {
    expect(bad("-25sol 40 20")).toMatch(/which ticker/i);
    expect(bad("100 200")).toMatch(/which ticker/i);
  });

  it("still takes an ordinary ticker in either position", () => {
    expect(ok("sol 40").symbol).toBe("SOL");
    expect(ok("40 sol").symbol).toBe("SOL");
    expect(ok("btc.p 40").symbol).toBe("BTC.P");
  });
});
