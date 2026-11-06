/**
 * The New York open on the clock: 09:30 America/New_York on weekdays, and
 * the session until 16:00. Market holidays are not known here. Pure, so
 * the header's chip can be tested without a browser.
 */
const TZ = "America/New_York";
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
export const WARN_MS = 5 * 60_000;

/** New York wall-clock parts for an instant. */
export function nyParts(ms: number): { day: string; weekday: number; minutes: number; seconds: number; hh: string; mm: string } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false });
  const get = (t: string) => f.formatToParts(new Date(ms)).find((p) => p.type === t)?.value ?? "00";
  const hh = String(Number(get("hour")) % 24).padStart(2, "0");
  const mm = get("minute");
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day: `${get("year")}-${get("month")}-${get("day")}`, weekday, minutes: Number(hh) * 60 + Number(mm), seconds: Number(get("second")), hh, mm };
}

/** Milliseconds until the next weekday 09:30 in New York, and whether the session is on now. */
export function nextNyOpen(now: number): { openAt: number; inSession: boolean } {
  const p = nyParts(now);
  const inSession = p.weekday >= 1 && p.weekday <= 5 && p.minutes >= OPEN_MIN && p.minutes < CLOSE_MIN;
  // Walk forward minute by minute is wasteful; instead count minutes to 09:30 today, then add whole days as needed.
  const sinceMidnight = p.minutes * 60_000 + p.seconds * 1000 + (now % 1000);
  let openAt = now - sinceMidnight + OPEN_MIN * 60_000;
  let weekday = p.weekday;
  if (openAt <= now) {
    openAt += 86400_000;
    weekday = (weekday + 1) % 7;
  }
  while (weekday === 0 || weekday === 6) {
    openAt += 86400_000;
    weekday = (weekday + 1) % 7;
  }
  // A clock change between now and then shifts the wall clock by an hour: re-read it at the target and correct once.
  const at = nyParts(openAt);
  const drift = (at.minutes - OPEN_MIN) * 60_000 + at.seconds * 1000;
  return { openAt: openAt - drift, inSession };
}

