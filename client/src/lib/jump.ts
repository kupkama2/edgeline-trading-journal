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

/* ----------------------------- stats sections ---------------------------- */

/**
 * The same one-shot handoff, for "show me where this number comes from".
 *
 * A figure on the homepage is a conclusion; the card it came from is the
 * working. Clicking the figure therefore has to do two things Stats cannot
 * infer from the URL alone — pick the right half, and scroll to the right
 * card — so both travel together and are cleared on arrival.
 */
const SECTION_KEY = "edgeline.jumpToSection";

export interface JumpSection {
  half: "edge" | "habits";
  /** Matches the id="jump-<anchor>" on the destination card. */
  anchor: string;
}

export function setJumpSection(s: JumpSection) {
  try {
    sessionStorage.setItem(SECTION_KEY, JSON.stringify(s));
  } catch {
    // See setJumpDay: navigation matters more than the scroll position.
  }
}

export function takeJumpSection(): JumpSection | null {
  try {
    const v = sessionStorage.getItem(SECTION_KEY);
    if (!v) return null;
    sessionStorage.removeItem(SECTION_KEY);
    const parsed = JSON.parse(v);
    return parsed?.half === "edge" || parsed?.half === "habits" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Scroll a jump target into view once its half has actually rendered.
 *
 * Two frames, not one: switching halves mounts a page of charts, and a scroll
 * issued in the same tick lands on the height the old half had. Highlighting
 * afterwards is what tells you which of a dozen cards answered your click.
 */
export function scrollToAnchor(anchor: string) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = document.getElementById(`jump-${anchor}`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("ring-2", "ring-primary/60");
      setTimeout(() => el.classList.remove("ring-2", "ring-primary/60"), 1600);
    }),
  );
}
