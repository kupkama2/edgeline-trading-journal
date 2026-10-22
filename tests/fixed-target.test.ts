import { describe, expect, it } from "vitest";
import { fixedTargetReport, outcomeAt, replay } from "../shared/fixed-target";
import { trade } from "./helpers";

/*
 * The helper's trade: long from 100, stop 90, so 1R is 10 points and $10.
 * Each test sets only the path it is about.
 */
const t = (over: Parameters<typeof trade>[0]) =>
  trade({ initialTarget: null, mae: 95, mfe: 112, exitPrice: 108, postExitPeak: null, postExitAdverse: null, ...over } as any);

describe("which level a trade reached first", () => {
  it("wins every rung up to the best reach when the stop was never touched", () => {
    const p = replay(t({ mfe: 115, mae: 96, postExitPeak: 125, postExitAdverse: 85 }))!;
    // 1.5R in the trade, 2.5R after it before the stop broke.
    expect(p.reach).toBeCloseTo(2.5);
    expect(outcomeAt(p, 1)).toBe("win");
    expect(outcomeAt(p, 2.5)).toBe("win");
    // Above that, the stop broke later in the window: a loss.
    expect(outcomeAt(p, 3)).toBe("loss");
  });

  it("leaves a rung open when neither level was reached in the window", () => {
    const p = replay(t({ mfe: 112, mae: 96, postExitPeak: 114, postExitAdverse: 93 }))!;
    expect(outcomeAt(p, 1)).toBe("win");
    expect(outcomeAt(p, 2)).toBe("open");
  });

  it("leaves it open when the aftermath was never measured, rather than calling it a loss", () => {
    const p = replay(t({ mfe: 112, mae: 96 }))!;
    expect(outcomeAt(p, 2)).toBe("open");
  });

  it("counts what came before a stop-out as reached first", () => {
    // Ran to +1.4R, then came back and stopped out.
    const p = replay(t({ mfe: 114, mae: 89.5, exitPrice: 89.5, exitReason: "stop" }))!;
    expect(outcomeAt(p, 1)).toBe("win");
    expect(outcomeAt(p, 1.5)).toBe("loss");
  });

  it("counts a stop-out as the stop being hit even when the bars stop a tick short of it", () => {
    // Stopped at 90; the feed's low was 90.4, and price bounced to 115 afterwards.
    const p = replay(t({ mfe: 105, mae: 90.4, exitPrice: 90, exitReason: "stop", postExitPeak: 115, postExitAdverse: 89 }))!;
    expect(outcomeAt(p, 0.5)).toBe("win");
    expect(outcomeAt(p, 1)).toBe("loss");
    // Marked as stopped, the same — even with a fill a little inside the stop.
    const q = replay(t({ mfe: 103, mae: 91, exitPrice: 90.8, exitReason: "stop", postExitPeak: 120 }))!;
    expect(outcomeAt(q, 1)).toBe("loss");
  });

  it("does not guess the order when the stop was touched and the trade carried on", () => {
    // Dipped through the stop, ran to +2R, exited at +1.5R.
    const p = replay(t({ mfe: 120, mae: 88, exitPrice: 115 }))!;
    expect(outcomeAt(p, 1)).toBe("ambiguous");
    expect(outcomeAt(p, 2)).toBe("ambiguous");
    // Above the reach the target never came, and the stop did: a loss either way.
    expect(outcomeAt(p, 3)).toBe("loss");
  });

  it("measures a short from the other side", () => {
    const p = replay(
      t({ direction: "short", entryPrice: 100, initialStop: 110, mfe: 85, mae: 104, exitPrice: 90, postExitAdverse: 111 }),
    )!;
    expect(p.reach).toBeCloseTo(1.5);
    expect(outcomeAt(p, 1.5)).toBe("win");
    expect(outcomeAt(p, 2)).toBe("loss");
  });

  it("leaves out what it cannot replay", () => {
    expect(replay(t({ mfe: null, mae: null }))).toBeNull();
    expect(replay(t({ initialStop: null }))).toBeNull();
    expect(replay(t({ scalp: true }))).toBeNull();
    expect(replay(t({ status: "open", exitPrice: null }))).toBeNull();
  });
});

describe("the report across trades", () => {
  const trades = [
    // Three that ran to 2R+ before any stop.
    t({ id: 1, mfe: 125, mae: 97, exitPrice: 110, postExitAdverse: 80 }),
    t({ id: 2, mfe: 121, mae: 98, exitPrice: 105, postExitAdverse: 80 }),
    t({ id: 3, mfe: 130, mae: 99, exitPrice: 128, postExitAdverse: 80 }),
    // Two that got to 1.2R and then stopped out.
    t({ id: 4, mfe: 112, mae: 90, exitPrice: 90, exitReason: "stop" }),
    t({ id: 5, mfe: 112, mae: 90, exitPrice: 90, exitReason: "stop" }),
    // One straight stop-out.
    t({ id: 6, mfe: 101, mae: 90, exitPrice: 90, exitReason: "stop" }),
  ];
  const rep = fixedTargetReport(trades as any);
  const at = (n: number) => rep.rungs.find((r) => r.n === n)!;

  it("scores each rung on the same trades", () => {
    expect(rep.sample).toBe(6);
    // 1R: five reach it, one does not.
    expect(at(1)).toMatchObject({ wins: 5, losses: 1, totalR: 4 });
    // 2R: three reach it; the other three are stopped.
    expect(at(2)).toMatchObject({ wins: 3, losses: 3, totalR: 3 });
    // 3R: only one (id 3 reached exactly 3R).
    expect(at(3)).toMatchObject({ wins: 1, losses: 5, totalR: -2 });
    expect(at(1).breakEvenWinRate).toBeCloseTo(0.5);
  });

  it("compares with what the trades actually made", () => {
    // +1, +0.5, +2.8, -1, -1, -1.
    expect(rep.actual.totalR).toBeCloseTo(1.3);
    // Every trade is decided at 1R here, so the rung's own comparison is the same.
    expect(at(1).actualR).toBeCloseTo(1.3);
  });

  it("does not name a best rung from six trades", () => {
    expect(rep.best).toBeNull();
  });

  it("names one once the sample allows", () => {
    const many = Array.from({ length: 4 }, (_, k) => trades.map((x) => ({ ...x, id: x.id + k * 10 })));
    const big = fixedTargetReport(many.flat() as any);
    expect(big.best?.n).toBe(1);
  });

  it("takes costs off every outcome", () => {
    // $2 of fees on a $10 R is 0.2R.
    const r = fixedTargetReport([t({ id: 9, mfe: 125, mae: 97, fees: 2, postExitAdverse: 80 })] as any);
    expect(r.rungs.find((x) => x.n === 2)!.totalR).toBeCloseTo(1.8);
    expect(r.rungs.find((x) => x.n === 3)!.totalR).toBeCloseTo(-1.2);
  });

  it("gives undecided trades as a range, not a guess", () => {
    const r = fixedTargetReport([...trades, t({ id: 7, mfe: 120, mae: 88, exitPrice: 115 })] as any);
    const one = r.rungs.find((x) => x.n === 1)!;
    expect(one.ambiguous).toBe(1);
    expect(one.totalR).toBe(4);
    expect(one.lowR).toBe(3);
    expect(one.highR).toBe(5);
  });
});
