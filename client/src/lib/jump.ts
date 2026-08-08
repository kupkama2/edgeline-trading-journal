/**
 * Handing a target from one page to the next.
 *
 * Clicking a point on the equity curve should land on that day's page, not
 * on today's. The router is hash-based (`#/daily`), and a query string inside
 * the hash would have to fight the route matcher for it, so the day travels
 * in sessionStorage instead: written on the way out, read and cleared on the
 * way in. It is a one-shot handoff, not state — a refresh of /daily should
 * show today again, which is exactly what clearing on read produces.
 */
const DAY_KEY = "edgeline.jumpToDay";

export function setJumpDay(day: string) {
  try {
    sessionStorage.setItem(DAY_KEY, day);
  } catch {
    // Private-mode storage failures are not worth breaking navigation over.
  }
}

/** The pending day, consumed. Returns null when there is nothing waiting. */
export function takeJumpDay(): string | null {
  try {
    const v = sessionStorage.getItem(DAY_KEY);
    if (v) sessionStorage.removeItem(DAY_KEY);
    return v;
  } catch {
    return null;
  }
}
