import { useEffect, useRef, type RefObject } from "react";
import { IDLE_MS, TOUCH_EVENTS, idleStep, shouldHold } from "@/lib/idle";

/**
 * Folds a card nobody has touched for a while. The rules live in lib/idle;
 * this is the wiring: listeners on the card, one lazy timer, the DOM read
 * at the moment it fires.
 *
 * `card` is where a touch lands. `body` is the part a parked caret holds —
 * the header's own toggle button is inside the card but outside the body,
 * so the click that opened the form does not also keep it open.
 */
export function useIdleCollapse({
  active,
  busy,
  card,
  body,
  onIdle,
  idleMs = IDLE_MS,
}: {
  /** The form is open; there is something to fold. */
  active: boolean;
  /** Work in flight on the form's behalf. A change restarts the clock. */
  busy: boolean;
  card: RefObject<HTMLElement | null>;
  body: RefObject<HTMLElement | null>;
  onIdle: () => void;
  idleMs?: number;
}) {
  // Read at fire time, so a fresh closure each render does not restart the clock.
  const idle = useRef(onIdle);
  idle.current = onIdle;

  useEffect(() => {
    if (!active) return;
    const el = card.current;
    if (!el) return;

    let lastTouchAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A touch only moves the deadline. The timer is not reset on every
    // pointer move; it finds out how far the deadline moved when it fires.
    const touch = () => {
      lastTouchAt = Date.now();
    };
    const holding = () => {
      const focused = document.activeElement;
      return shouldHold({
        busy,
        focusInside: Boolean(focused && body.current?.contains(focused)),
        windowFocused: document.hasFocus(),
        menuOpen: el.querySelector('[data-state="open"]') != null,
      });
    };
    const tick = () => {
      const step = idleStep(lastTouchAt, Date.now(), holding(), idleMs);
      if (step.collapse) idle.current();
      else timer = setTimeout(tick, step.waitMs);
    };

    for (const type of TOUCH_EVENTS) el.addEventListener(type, touch, { passive: true });
    // Leaving counts from the moment of leaving. The caret moving out of a
    // field, or the window going behind another, is when the thirty seconds
    // start — not thirty seconds after the last keystroke before it.
    el.addEventListener("focusout", touch);
    window.addEventListener("blur", touch);
    timer = setTimeout(tick, idleMs);

    return () => {
      clearTimeout(timer);
      for (const type of TOUCH_EVENTS) el.removeEventListener(type, touch);
      el.removeEventListener("focusout", touch);
      window.removeEventListener("blur", touch);
    };
  }, [active, busy, card, body, idleMs]);
}
