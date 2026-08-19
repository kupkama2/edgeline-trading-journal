import { describe, expect, it } from "vitest";
import { computeMetrics, exitTimingRead, exitTimingVerdict } from "../shared/metrics";
import { exitTimingSummary } from "../shared/excursion";

/**
 * The two halves of "it went higher", kept apart.
 *
 * The motivating trade: closed a winner, the move kept running, and the
 * eventual high got logged as MFE. rLeftOnTable then read the entire missed
 * run as a SURRENDERED one and the coach said "you hold winners past the
 * peak" to someone who had just cut one loose. With MFE strictly in-trade and
 * the post-exit run in its own field, the same trade reads early, not late.
 */
const base = {
  symbol: "HYPE",
  direction: "long" as const,
  size: 1,
  sizeUnit: "base" as const,
  pointValue: 1,
  entryPrice: 100,
  initialStop: 90, // 1R = 10
  initialTarget: 130,
  entryTime: "2026-08-19T09:30:00Z",
  status: "closed" as const,
  mistakeTagIds: [] as number[],
  fills: [] as any[],
  imageCount: 0,
};

describe("the HYPE trade, filed both ways", () => {
  it("mislogged (post-exit high in MFE) used to read as late", () => {
    // Exit +1.2R, in-trade peak barely above the exit, then the move ran to
    // 140 WITHOUT the trader. Typed into mfe, the whole run counts as
    // given back — this is the inversion, preserved here as documentation.
    const m = computeMetrics({ ...base, exitPrice: 112, mfe: 140 } as any);
    expect(m.rLeftOnTable).toBeCloseTo(2.8, 5);
    expect(exitTimingRead(m)?.verdict).toBe("late"); // wrong, and why the field split exists
  });

  it("filed correctly, the same trade reads early", () => {
    const m = computeMetrics({
      ...base,
      exitPrice: 112,
      mfe: 113, // in-trade peak: you sold the top of your window
      postExitPeak: 140, // the run you were not in for
    } as any);
    expect(m.rLeftOnTable).toBeCloseTo(0.1, 5);
    expect(m.leftBehindR).toBeCloseTo(2.8, 5);
    const read = exitTimingRead(m)!;
    expect(read.verdict).toBe("early");
  });
});

describe("leftBehindR", () => {
  it("is null when the leg was not measured — no data is not zero cost", () => {
    expect(computeMetrics({ ...base, exitPrice: 112 } as any).leftBehindR).toBeNull();
  });

  it("clamps to zero when the move died on the exit", () => {
    // Post-exit peak below a long's exit: it fell the moment you left.
    const m = computeMetrics({ ...base, exitPrice: 112, postExitPeak: 105 } as any);
    expect(m.leftBehindR).toBe(0);
  });

  it("reads direction: a short left behind is a fall after the cover", () => {
    const m = computeMetrics({
      ...base,
      direction: "short",
      entryPrice: 100,
      initialStop: 110, // 1R = 10
      exitPrice: 92,
      postExitPeak: 72, // kept falling 2R past the cover
    } as any);
    expect(m.leftBehindR).toBeCloseTo(2.0, 5);
  });

  it("on a stop-out, a bounce without a new low means the stop was tight", () => {
    // Stopped at 90; price reversed to 125 without printing a lower low
    // first. 3.5R of trade existed and the stop was inside its noise.
    const m = computeMetrics({ ...base, exitPrice: 90, exitReason: "stop", postExitPeak: 125 } as any);
    expect(m.leftBehindR).toBeCloseTo(3.5, 5);
    expect(exitTimingRead(m)?.verdict).toBe("early");
  });

  it("on a stop-out that kept falling, the stop was right and the cost is zero", () => {
    const m = computeMetrics({ ...base, exitPrice: 90, exitReason: "stop", postExitPeak: 90 } as any);
    expect(m.leftBehindR).toBe(0);
    expect(exitTimingRead(m)?.verdict).toBe("clean");
  });
});

describe("the verdict rule", () => {
  it("says nothing when nothing was measured", () => {
    expect(exitTimingVerdict(null, null)).toBeNull();
  });

  it("ignores costs below the meaningful bar", () => {
    expect(exitTimingVerdict(0.3, 0.2)?.verdict).toBe("clean");
  });

  it("the larger meaningful cost wins when a trade carries both", () => {
    // Rode to +3R, gave back to +1R, then it ran another 0.6R after the exit.
    // Both true; the roundtrip is the story.
    expect(exitTimingVerdict(2.0, 0.6)?.verdict).toBe("late");
    expect(exitTimingVerdict(0.6, 2.0)?.verdict).toBe("early");
  });

  it("judges a trade on the one leg it measured", () => {
    expect(exitTimingVerdict(null, 1.2)?.verdict).toBe("early");
    expect(exitTimingVerdict(1.2, null)?.verdict).toBe("late");
  });
});

describe("the summary that answers the hunch", () => {
  it("totals each cost only over trades that measured it, and names the lean", () => {
    const trades = [
      // Two early exits: sold, it ran on.
      { ...base, id: 1, exitPrice: 112, mfe: 113, postExitPeak: 140 },
      { ...base, id: 2, exitPrice: 108, mfe: 109, postExitPeak: 122 },
      // One roundtrip: reached +3R, closed +0.5R.
      { ...base, id: 3, exitPrice: 105, mfe: 130 },
      // One with no path data at all — contributes nothing, silently.
      { ...base, id: 4, exitPrice: 111 },
    ] as any[];
    const s = exitTimingSummary(trades)!;
    expect(s.measured).toBe(3);
    expect(s.leftBehindTrades).toBe(2);
    expect(s.leftBehindTotalR).toBeCloseTo(2.8 + 1.4, 5);
    expect(s.gaveBackTrades).toBe(1);
    expect(s.gaveBackTotalR).toBeCloseTo(2.5, 5);
    expect(s.lean).toBe("early"); // the hunch, as a number
  });

  it("is null with no measured trades rather than a page of zeros", () => {
    expect(exitTimingSummary([{ ...base, exitPrice: 111 }] as any)).toBeNull();
  });
});
