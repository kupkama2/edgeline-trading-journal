import { describe, expect, it } from "vitest";
import { chartLevels } from "../client/src/components/chart-levels";
import { formatStopMoves } from "../shared/stops";

/**
 * The lines on a trade's chart, and which of them answer to a drag.
 *
 * Two questions, and they pull in different directions. A reader wants the
 * stop where it is NOW; a form editing `initialStop` wants the number in the
 * box, because a line ignoring the field while the field is open is a chart
 * of a different trade. And a trade whose stop has been managed must not
 * offer a handle at all: initialStop is the R denominator, so dragging it
 * would restate every figure the trade has ever had.
 */
const base: any = {
  id: 1,
  symbol: "BTC",
  direction: "long",
  size: 1,
  sizeUnit: "base",
  pointValue: 1,
  entryPrice: 100,
  initialStop: 90,
  initialTarget: 130,
  extraTargets: null,
  exitPrice: null,
  stopMoves: null,
  scalp: false,
  status: "open",
};

const at = (levels: ReturnType<typeof chartLevels>, label: string) =>
  levels.find((l) => l.label === label);

describe("what the chart draws", () => {
  it("draws the plan, and lets you drag all of it", () => {
    const l = chartLevels(base);
    expect(l.map((x) => x.label)).toEqual(["entry", "stop", "target"]);
    expect(l.map((x) => x.field)).toEqual(["entryPrice", "initialStop", "initialTarget"]);
  });

  it("adds the exit once there is one", () => {
    expect(at(chartLevels({ ...base, exitPrice: 121 }), "exit")).toMatchObject({
      price: 121,
      field: "exitPrice",
    });
  });

  it("has nothing to say about a scalp", () => {
    // A scalp is a result, not a plan — and an entry of zero is the absence
    // of a level, not a level at zero.
    expect(chartLevels({ ...base, scalp: true, entryPrice: 0 })).toEqual([]);
  });
});

describe("what a form is holding", () => {
  it("draws the number in the box, not the one on the trade", () => {
    const l = chartLevels(base, { initialStop: 94 });
    expect(at(l, "stop")?.price).toBe(94);
    // Untouched fields still come from the trade.
    expect(at(l, "entry")?.price).toBe(100);
  });

  it("takes the line away when the field is emptied", () => {
    // Null is the form saying "there is no target", which is a different
    // statement from not editing the target at all.
    expect(at(chartLevels(base, { initialTarget: null }), "target")).toBeUndefined();
    expect(at(chartLevels(base, {}), "target")?.price).toBe(130);
  });

  it("draws an exit that exists only in the form", () => {
    expect(at(chartLevels(base, { exitPrice: 118 }), "exit")?.price).toBe(118);
  });

  it("replaces the scale-outs wholesale rather than merging them", () => {
    const saved = { ...base, extraTargets: JSON.stringify([140, 150]) };
    expect(chartLevels(saved).filter((x) => x.label.startsWith("tp")).map((x) => x.price)).toEqual([
      140, 150,
    ]);
    const l = chartLevels(saved, { extraTargets: [145] });
    expect(l.filter((x) => x.label.startsWith("tp")).map((x) => x.price)).toEqual([145]);
  });
});

describe("a stop that has been moved", () => {
  const managed = {
    ...base,
    stopMoves: formatStopMoves([{ at: new Date().toISOString(), price: 100 }]),
  };

  it("draws where it is now, and where it started, faintly", () => {
    const l = chartLevels(managed);
    expect(at(l, "stop")?.price).toBe(100);
    expect(at(l, "was")).toMatchObject({ price: 90, faint: true });
  });

  it("refuses the handle: initialStop is the R denominator, not a drawing", () => {
    // Dragging this would silently rewrite what every R on the trade means.
    // Moving a live stop goes through the stop card, which records when.
    expect(at(chartLevels(managed), "stop")?.field).toBeUndefined();
    expect(at(chartLevels(managed, { initialStop: 95 }), "stop")?.field).toBeUndefined();
  });

  it("shows the plan while the plan is being edited, and drops the memory", () => {
    // Both lines at once would read as two stops rather than as one and a
    // memory — and the faint one sits exactly where the solid one started.
    const l = chartLevels(managed, { initialStop: 95 });
    expect(at(l, "stop")?.price).toBe(95);
    expect(at(l, "was")).toBeUndefined();
  });
});
