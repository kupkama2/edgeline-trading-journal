import { describe, expect, it } from "vitest";
import {
  computeProgression,
  disciplineStreak,
  levelInfo,
  tradeXp,
} from "../shared/xp";
import type { DailyNote, WeeklyReview } from "../shared/schema";
import { localIso, trade } from "./helpers";

const note = (day: string, body = "Solid morning, sat out the chop after 11. Tomorrow: only A-setups."): DailyNote =>
  ({ id: 1, day, body, updatedAt: "" }) as DailyNote;

describe("tradeXp", () => {
  it("pays for process on a complete closed trade", () => {
    const ev = tradeXp(
      trade({ rationale: "vah retest", notes: "took it late", exitReason: "target" }),
    );
    const ids = ev.map((e) => e.id.split(":")[1]);
    expect(ids).toContain("rationale");
    expect(ids).toContain("levels");
    expect(ids).toContain("exit");
    expect(ids).toContain("reflection");
    expect(ids).toContain("clean"); // no demons on it
  });

  /** The Robinhood rule: outcome must never move XP. */
  it("pays a losing trade exactly like a winning one", () => {
    const base = { rationale: "plan", exitReason: "stop" as const };
    const win = tradeXp(trade({ ...base, exitPrice: 130 }));
    const loss = tradeXp(trade({ ...base, exitPrice: 90 }));
    expect(win.reduce((a, e) => a + e.points, 0)).toBe(
      loss.reduce((a, e) => a + e.points, 0),
    );
  });

  it("never charges for honesty about demons", () => {
    const clean = tradeXp(trade({ rationale: "plan", exitReason: "stop" }));
    const tagged = tradeXp(
      trade({ rationale: "plan", exitReason: "stop", mistakeTagIds: [3] }),
    );
    const sum = (ev: ReturnType<typeof tradeXp>) => ev.reduce((a, e) => a + e.points, 0);
    // The tagged trade loses only the "clean" nod — nothing is deducted.
    expect(sum(clean) - sum(tagged)).toBe(5);
  });

  it("pays the missed-trade log more than a bare entry", () => {
    const missed = tradeXp(
      trade({ status: "cancelled", cancelReason: "never_placed", exitPrice: null }),
    );
    expect(missed.reduce((a, e) => a + e.points, 0)).toBe(15);
  });

  it("gives an ordinary cancelled order nothing", () => {
    expect(tradeXp(trade({ status: "cancelled", cancelReason: "pulled" }))).toEqual([]);
  });
});

describe("levelInfo", () => {
  it("ramps 100, 150, 200…", () => {
    expect(levelInfo(0)).toMatchObject({ level: 1, into: 0, span: 100 });
    expect(levelInfo(99)).toMatchObject({ level: 1 });
    expect(levelInfo(100)).toMatchObject({ level: 2, into: 0, span: 150 });
    expect(levelInfo(250)).toMatchObject({ level: 3, into: 0, span: 200 });
  });

  it("clamps titles at the top instead of running out", () => {
    expect(levelInfo(1_000_000).title).toBe("Master of Process");
  });
});

describe("disciplineStreak", () => {
  const today = new Date(2026, 7, 6); // Thursday

  it("skips no-trade days instead of breaking on them", () => {
    // Journaled Mon + Wed(with note), nothing Tue — streak spans all three.
    const trades = [
      trade({ id: 1, rationale: "plan", entryTime: localIso(2026, 8, 3, 10), exitTime: localIso(2026, 8, 3, 11) }),
    ];
    const notes = [note("2026-08-05"), note("2026-08-06")];
    expect(disciplineStreak(trades, notes, today).days).toBe(3);
  });

  it("breaks on a trading day with nothing written", () => {
    const trades = [
      // Wednesday's trade has no rationale and no notes: the silent day.
      trade({ id: 1, rationale: null, notes: null, entryTime: localIso(2026, 8, 5, 10), exitTime: localIso(2026, 8, 5, 11) }),
      trade({ id: 2, rationale: "plan", entryTime: localIso(2026, 8, 3, 10), exitTime: localIso(2026, 8, 3, 11) }),
    ];
    const notes = [note("2026-08-06")];
    // Streak = today only; Wednesday broke the chain to Monday.
    expect(disciplineStreak(trades, notes, today).days).toBe(1);
  });

  it("does not punish today before the day is over", () => {
    const notes = [note("2026-08-05")];
    const s = disciplineStreak([], notes, today);
    expect(s.days).toBe(1); // yesterday's note counts…
    expect(s.todayDone).toBe(false); // …today simply isn't done yet
  });
});

describe("computeProgression", () => {
  it("assembles totals, achievements, and never pays for P&L", () => {
    const trades = [
      trade({ id: 1, rationale: "plan", exitReason: "target", exitPrice: 130 }),
      trade({ id: 2, rationale: "plan", exitReason: "stop", exitPrice: 90 }),
    ];
    const notes = [note("2026-08-03")];
    const reviews = [{ id: 1, weekStart: "2026-08-03", plans: null, insights: null, submittedAt: "" } as WeeklyReview];

    const p = computeProgression(trades, notes, reviews, new Date(2026, 7, 6));
    expect(p.level.totalXp).toBeGreaterThan(0);
    expect(p.achievements.find((a) => a.id === "first-ink")!.earned).toBe(true);
    expect(p.achievements.find((a) => a.id === "reviewer")!.earned).toBe(true);
    // Both closed trades earned identical XP despite opposite outcomes.
    const one = p.events.filter((e) => e.id.startsWith("1:")).reduce((a, e) => a + e.points, 0);
    const two = p.events.filter((e) => e.id.startsWith("2:")).reduce((a, e) => a + e.points, 0);
    expect(one).toBe(two);
  });
});
