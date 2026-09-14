/**
 * When a form left open should fold itself back up.
 *
 * The entry form opens on a click or a pasted chart, and until now it then
 * stayed open for the rest of the visit — and a visit is long, because
 * opening a trade keeps the journal mounted underneath it. So the form most
 * people came back to was the one they had opened an hour earlier, holding
 * nothing, taking the widest column on the page. Now thirty seconds without
 * a hand on it and it is one line again. Whatever was typed stays typed, a
 * click away, and the folded header says so.
 *
 * A hand on it is any pointer, key, paste, drop or scroll inside the card.
 * Two things hold it open past the deadline without being a touch: work in
 * flight on its behalf (a screenshot being read, a save on the wire), and a
 * caret parked in one of its fields while the window is in front — someone
 * thinking mid-sentence is still using the form. A menu opened from the
 * card (the account picker, say) holds it the same way: the keystrokes that
 * browse a menu land outside the card, and an open menu is nothing to fold
 * a form under.
 */

/** Thirty seconds without a touch, then the form folds. */
export const IDLE_MS = 30_000;

/** What counts as a touch. All bubbling events, listened for on the card. */
export const TOUCH_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "input",
  "focusin",
  "paste",
  "drop",
  "wheel",
  "touchstart",
] as const;

export type IdleStep = { collapse: true } | { collapse: false; waitMs: number };

/**
 * The timer's next move when it fires.
 *
 * The deadline is `idleMs` past the last touch. A timer that fires early —
 * a touch moved the deadline since it was set — waits out the rest. One that
 * fires under a hold waits a whole window more. Only one that fires past the
 * deadline with nothing holding folds the form.
 */
export function idleStep(
  lastTouchAt: number,
  now: number,
  hold: boolean,
  idleMs = IDLE_MS,
): IdleStep {
  const remaining = lastTouchAt + idleMs - now;
  if (remaining > 0) return { collapse: false, waitMs: remaining };
  if (hold) return { collapse: false, waitMs: idleMs };
  return { collapse: true };
}

export interface HoldState {
  /** Work in flight on the form's behalf: a read, a save. */
  busy: boolean;
  /** An element inside the form's body has focus. */
  focusInside: boolean;
  /** The document is the front window. A caret left in a background tab holds nothing. */
  windowFocused: boolean;
  /** A menu opened from the form — a select, a popover — is showing. */
  menuOpen: boolean;
}

/** Whether the form is spoken for at the deadline, touch or no touch. */
export function shouldHold(s: HoldState): boolean {
  return s.busy || s.menuOpen || (s.focusInside && s.windowFocused);
}
