// Pin a zone with a real offset BEFORE anything reads the clock. In UTC every
// assertion below passes whether the code is right or wrong, and CI runs in
// UTC — so a test that did not do this would be decorative.
process.env.TZ = "America/New_York";

import { describe, expect, it } from "vitest";
import { localNow, toIso } from "../client/src/components/trade-shared";

/**
 * The "Now" button writes localNow() straight into a datetime-local input, so
 * two things have to hold or every trade logged with it is stamped wrong.
 *
 * A datetime-local input has no timezone: it shows exactly the characters it is
 * given and parses them back as LOCAL time. So the string has to be local
 * wall-clock, not UTC. Writing `new Date().toISOString().slice(0, 16)` — the
 * obvious simplification, and the one a future cleanup would reach for — puts
 * UTC in a field that will be read as local, and every timestamp silently
 * moves by the offset. Four hours is not a rounding error on a scalp.
 */
const pad = (n: number) => String(n).padStart(2, "0");

describe("the clock the Now button writes", () => {
  it("is local wall-clock, not UTC", () => {
    const d = new Date();
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
      d.getHours(),
    )}:${pad(d.getMinutes())}`;
    expect(localNow()).toBe(local);

    // And explicitly not the UTC rendering, which is what a "simplification"
    // to toISOString().slice(0, 16) would produce.
    expect(localNow()).not.toBe(new Date().toISOString().slice(0, 16));
  });

  it("is exactly the shape a datetime-local input accepts", () => {
    // Anything else and the field silently renders blank — the button would
    // look broken with nothing in the console to say why.
    expect(localNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("round-trips back to this moment", () => {
    // The button's whole claim: tap it, save, and the stored instant is now.
    // localNow() -> input -> toIso() is the actual path a logged trade takes.
    const drift = Math.abs(new Date(toIso(localNow())).getTime() - Date.now());
    expect(drift).toBeLessThan(60_000 + 1_000); // truncated to the minute
  });

  it("keeps a hand-typed time meaning what it says on the clock", () => {
    // Typing 09:30 must store 09:30 New York, not 09:30 UTC. Same conversion
    // the Now button leans on, exercised at a fixed instant so the assertion
    // is about the offset rather than about the current time.
    const iso = toIso("2026-08-12T09:30");
    expect(new Date(iso).getHours()).toBe(9);
    expect(new Date(iso).getMinutes()).toBe(30);
    expect(iso).toBe("2026-08-12T13:30:00.000Z"); // EDT is UTC-4
  });
});
