import { describe, expect, it } from "vitest";
import { parseTime24 } from "../client/src/components/trade-shared";

describe("a typed 24-hour time", () => {
  it("takes the ways people type one", () => {
    expect(parseTime24("14:30")).toBe("14:30");
    expect(parseTime24("1430")).toBe("14:30");
    expect(parseTime24("9:05")).toBe("09:05");
    expect(parseTime24("905")).toBe("09:05");
    expect(parseTime24("143")).toBe("01:43");
    expect(parseTime24("14.30")).toBe("14:30");
    expect(parseTime24("00:00")).toBe("00:00");
    expect(parseTime24("23:59")).toBe("23:59");
  });
  it("is not a time until it is one", () => {
    for (const s of ["", "1", "14", "24:00", "12:60", "ab:cd", "2:5"]) expect(parseTime24(s)).toBeNull();
  });
});
