import { describe, expect, it } from "vitest";
import { nextNyOpen, nyParts } from "../shared/ny-open";

/** The New York open on the clock: weekdays at 09:30 New York, the session until 16:00, across the clock change. */
const at = (iso: string) => new Date(iso).getTime();

describe("the next New York open", () => {
  it("is today's 09:30 before the bell, tomorrow's after it, and Monday's over a weekend", () => {
    // Wednesday 2026-01-14, 08:00 New York (13:00Z): 90 minutes to go.
    const wed = nextNyOpen(at("2026-01-14T13:00:00Z"));
    expect(wed.inSession).toBe(false);
    expect(wed.openAt - at("2026-01-14T13:00:00Z")).toBe(90 * 60_000);
    expect(nyParts(wed.openAt)).toMatchObject({ hh: "09", mm: "30", weekday: 3 });
    // 10:00 the same day: in session, the next open is Thursday's.
    const inS = nextNyOpen(at("2026-01-14T15:00:00Z"));
    expect(inS.inSession).toBe(true);
    expect(nyParts(inS.openAt)).toMatchObject({ day: "2026-01-15", hh: "09", mm: "30" });
    // Friday 17:00 New York: Monday.
    const fri = nextNyOpen(at("2026-01-16T22:00:00Z"));
    expect(fri.inSession).toBe(false);
    expect(nyParts(fri.openAt)).toMatchObject({ day: "2026-01-19", hh: "09", mm: "30", weekday: 1 });
    // Saturday noon: still Monday.
    expect(nyParts(nextNyOpen(at("2026-01-17T17:00:00Z")).openAt).day).toBe("2026-01-19");
  });

  it("lands on 09:30 New York across the spring clock change", () => {
    // Saturday 2026-03-07 evening New York: Monday 2026-03-09 is after the change (08 March). 09:30 EDT = 13:30Z.
    const o = nextNyOpen(at("2026-03-08T01:00:00Z"));
    expect(nyParts(o.openAt)).toMatchObject({ day: "2026-03-09", hh: "09", mm: "30" });
    expect(new Date(o.openAt).toISOString()).toBe("2026-03-09T13:30:00.000Z");
    // Friday before, 09:30 EST = 14:30Z.
    expect(new Date(nextNyOpen(at("2026-03-06T10:00:00Z")).openAt).toISOString()).toBe("2026-03-06T14:30:00.000Z");
  });
});
