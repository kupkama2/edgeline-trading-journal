import { describe, expect, it } from "vitest";
import { inSessionWindow, parseHHMM, windowLabel } from "../shared/session";

const at = (h: number, m = 0) => new Date(2026, 7, 6, h, m);

describe("session windows", () => {
  it("parses HH:MM and rejects noise", () => {
    expect(parseHHMM("09:30")).toBe(570);
    expect(parseHHMM("23:59")).toBe(1439);
    expect(parseHHMM("9:30")).toBe(570); // a human-typed single digit is fine
    expect(parseHHMM("25:00")).toBeNull();
    expect(parseHHMM("")).toBeNull();
    expect(parseHHMM(null)).toBeNull();
  });

  it("answers inside/outside for a normal daytime window", () => {
    expect(inSessionWindow(at(10, 0), "09:30", "11:00")).toBe(true);
    expect(inSessionWindow(at(9, 29), "09:30", "11:00")).toBe(false);
    expect(inSessionWindow(at(14, 0), "09:30", "11:00")).toBe(false);
    // Start is inclusive, end exclusive — 11:00 is already outside.
    expect(inSessionWindow(at(11, 0), "09:30", "11:00")).toBe(false);
  });

  it("wraps midnight for an overnight book", () => {
    expect(inSessionWindow(at(23, 0), "22:00", "02:00")).toBe(true);
    expect(inSessionWindow(at(1, 0), "22:00", "02:00")).toBe(true);
    expect(inSessionWindow(at(12, 0), "22:00", "02:00")).toBe(false);
  });

  it("has no opinion when no window is configured", () => {
    expect(inSessionWindow(at(10), null, null)).toBeNull();
    expect(inSessionWindow(at(10), "09:30", null)).toBeNull();
    // A zero-length window is a configuration mistake, not a 24h ban.
    expect(inSessionWindow(at(10), "09:30", "09:30")).toBeNull();
    expect(windowLabel(null, null)).toBeNull();
  });
});
