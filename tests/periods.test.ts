import { describe, expect, it } from "vitest";
import { byPeriod, metricOf, mondayOf } from "../shared/periods";
import { localIso, trade } from "./helpers";

/** A closed trade worth `r` R, exiting on the given local day. */
const on = (y: number, mo: number, d: number, r: number) =>
  trade({
    entryTime: localIso(y, mo, d, 9),
    exitTime: localIso(y, mo, d, 10),
    exitPrice: 100 + 10 * r,
  });

describe("byPeriod", () => {
  it("anchors weeks on Monday", () => {
    // 2026-08-09 is a Sunday; its week started Monday the 3rd.
    expect(mondayOf("2026-08-09")).toBe("2026-08-03");
    expect(mondayOf("2026-08-03")).toBe("2026-08-03");
  });

  it("rolls days into the week that contains them", () => {
    const weeks = byPeriod([on(2026, 8, 3, 1), on(2026, 8, 7, -1), on(2026, 8, 10, 2)], "week");
    expect(weeks).toHaveLength(2);
    expect(weeks[0].closed).toBe(2);
    expect(weeks[0].totalR).toBe(0);
    expect(weeks[1].totalR).toBe(2);
  });

  it("rolls days into calendar months", () => {
    const months = byPeriod([on(2026, 7, 30, 1), on(2026, 8, 1, 1), on(2026, 8, 20, -1)], "month");
    expect(months.map((m) => m.key)).toEqual(["2026-07", "2026-08"]);
    expect(months[1].closed).toBe(2);
    expect(months[1].winRate).toBeCloseTo(0.5);
    expect(months[1].activeDays).toBe(2);
  });

  it("leaves out periods with nothing closed, and keeps oldest first", () => {
    const days = byPeriod([on(2026, 8, 10, 1), on(2026, 8, 3, 1)], "day");
    expect(days).toHaveLength(2);
    expect(days[0].start < days[1].start).toBe(true);
  });

  it("returns nothing when nothing has closed", () => {
    expect(byPeriod([trade({ status: "open", exitPrice: null, exitTime: null })], "week")).toEqual(
      [],
    );
  });
});

describe("metricOf", () => {
  const b = { totalPnL: -250, totalR: 1.5, closed: 9, winRate: 0.33 };

  it("picks the asked-for figure", () => {
    expect(metricOf(b, "pnl").value).toBe(-250);
    expect(metricOf(b, "r").value).toBe(1.5);
    expect(metricOf(b, "trades").value).toBe(9);
    expect(metricOf(b, "winRate").value).toBeCloseTo(0.33);
  });

  it("colours by meaning, and refuses to call volume good or bad", () => {
    expect(metricOf(b, "pnl").tone).toBe("bad");
    expect(metricOf(b, "r").tone).toBe("good");
    expect(metricOf(b, "winRate").tone).toBe("bad");
    expect(metricOf(b, "trades").tone).toBe("flat");
  });
});
