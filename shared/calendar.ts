/**
 * The events that move the whole tape: US macro releases and the largest
 * companies' earnings. Pure; the reads are in server/calendar.ts.
 *
 *   macro     Forex Factory's public weekly feed (via faireconomy.media):
 *             `[{ title, country, date, impact, forecast, previous }]`,
 *             dates in New York time with their offset. Kept: US events of
 *             high impact, and the ones crypto trades on whatever the
 *             feed's rating (PPI, FOMC minutes, JOLTS, the Fed chair).
 *   earnings  Nasdaq's calendar per day: `{ data: { rows: [{ symbol,
 *             name, marketCap, time }] } }`. Kept: companies over $200B,
 *             and the ones crypto moves with (COIN, MSTR, HOOD…). The time
 *             is a session, not a minute: before the open is taken as
 *             08:00 New York, after the close as 16:05.
 *
 * Alerts are the page's: the morning of a day with something on, and an
 * hour before each one. `alertsDue` is the rule, pure, so it can be tested.
 */

export type EventKind = "macro" | "earnings";

export interface CalendarEvent {
  /** Stable across downloads: kind, title and time. */
  id: string;
  kind: EventKind;
  title: string;
  /** "USD" for macro; the ticker for earnings. */
  tag: string;
  /** UTC. */
  at: string;
  impact: "high" | "medium";
  /** Earnings: the session the time stands for. */
  session?: "before-open" | "after-close" | "unknown";
  forecast?: string | null;
  previous?: string | null;
}

/** Released whatever the feed rates them: the ones crypto trades on. */
const ALWAYS = /\b(PPI|CPI|FOMC|Federal Funds Rate|Fed Chair|Powell|Non-Farm|NFP|JOLTS|Core PCE|PCE Price|GDP|Unemployment Rate|Retail Sales|ISM)\b/i;

export function parseForexFactory(json: unknown): CalendarEvent[] {
  if (!Array.isArray(json)) return [];
  const out: CalendarEvent[] = [];
  for (const r of json as any[]) {
    const title = String(r?.title ?? "").trim();
    const country = String(r?.country ?? "").toUpperCase();
    const impact = String(r?.impact ?? "");
    const t = Date.parse(String(r?.date ?? ""));
    if (!title || country !== "USD" || !Number.isFinite(t)) continue;
    const high = impact === "High";
    if (!high && !(ALWAYS.test(title) && impact === "Medium")) continue;
    const at = new Date(t).toISOString();
    out.push({
      id: `macro:${title}:${at}`,
      kind: "macro",
      title,
      tag: "USD",
      at,
      impact: high ? "high" : "medium",
      forecast: r?.forecast ? String(r.forecast) : null,
      previous: r?.previous ? String(r.previous) : null,
    });
  }
  return out;
}

/** Companies crypto moves with, whatever their size. */
export const CRYPTO_NAMES = new Set(["COIN", "MSTR", "HOOD", "MARA", "RIOT", "CLSK", "GLXY", "CRCL", "SQ", "XYZ", "PYPL"]);
export const EARNINGS_MIN_CAP = 200e9;

const capOf = (s: unknown) => {
  const x = Number(String(s ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(x) ? x : 0;
};

/**
 * One day of Nasdaq's earnings calendar. `day` is the New York date the
 * calendar was asked for (YYYY-MM-DD); the session becomes a time on it.
 */
export function parseNasdaqEarnings(json: unknown, day: string): CalendarEvent[] {
  const rows = (json as any)?.data?.rows;
  if (!Array.isArray(rows)) return [];
  const out: CalendarEvent[] = [];
  for (const r of rows) {
    const symbol = String(r?.symbol ?? "").toUpperCase();
    const cap = capOf(r?.marketCap);
    if (!symbol || (cap < EARNINGS_MIN_CAP && !CRYPTO_NAMES.has(symbol))) continue;
    const time = String(r?.time ?? "");
    const session = /pre-market/.test(time) ? "before-open" : /after-hours/.test(time) ? "after-close" : "unknown";
    const at = nyTime(day, session === "before-open" ? "08:00" : session === "after-close" ? "16:05" : "16:05");
    out.push({
      id: `earnings:${symbol}:${day}`,
      kind: "earnings",
      title: `${String(r?.name ?? symbol).replace(/,? (Inc|Corp|Corporation|Incorporated|Co|Ltd|Holdings|Platforms|Class [A-C])\.?$/gi, "").trim()} earnings`,
      tag: symbol,
      at,
      impact: cap >= 1e12 || CRYPTO_NAMES.has(symbol) ? "high" : "medium",
      session,
      forecast: r?.epsForecast ? String(r.epsForecast) : null,
      previous: r?.lastYearEPS ? String(r.lastYearEPS) : null,
    });
  }
  return out;
}

/** A New York wall-clock time on a date, as UTC: the offset that date has, daylight saving included. */
export function nyTime(day: string, hhmm: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  // Guess with the winter offset, then correct by what New York's clock reads at that instant.
  let t = Date.UTC(y, m - 1, d, hh + 5, mm);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(t));
    const h = Number(parts.find((p) => p.type === "hour")?.value) % 24;
    const mi = Number(parts.find((p) => p.type === "minute")?.value);
    t -= (h * 60 + mi - (hh * 60 + mm)) * 60_000;
  }
  return new Date(t).toISOString();
}

/** The New York dates of the next `n` weekdays starting today. */
export function nextWeekdaysNy(now: number, n: number): string[] {
  const out: string[] = [];
  for (let k = 0; out.length < n && k < n * 2 + 3; k++) {
    const d = new Date(now + k * 86400_000);
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(d);
    const wd = parts.find((p) => p.type === "weekday")?.value;
    const day = `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}-${parts.find((p) => p.type === "day")?.value}`;
    if (wd !== "Sat" && wd !== "Sun" && !out.includes(day)) out.push(day);
  }
  return out;
}

/* ------------------------------- the alerts ------------------------------- */

export interface Alert {
  /** Remembered once given, so it is given once. */
  key: string;
  kind: "morning" | "soon";
  events: CalendarEvent[];
}

/**
 * Which alerts are due now: the morning one — from `morningAt` local time
 * on a day with anything on, given once that day — and one an hour before
 * each event (from 60 minutes to the start). `localDay` and `localMinutes`
 * are the viewer's own clock, so "morning" is theirs.
 */
export function alertsDue(
  events: CalendarEvent[],
  now: number,
  given: Set<string>,
  clock: { localDay: string; localMinutes: number; dayOf: (iso: string) => string },
  morningAt = 7 * 60 + 30,
): Alert[] {
  const out: Alert[] = [];
  const today = events.filter((e) => clock.dayOf(e.at) === clock.localDay && new Date(e.at).getTime() > now - 30 * 60_000);
  const morningKey = `morning:${clock.localDay}`;
  if (today.length && clock.localMinutes >= morningAt && !given.has(morningKey)) out.push({ key: morningKey, kind: "morning", events: today });
  for (const e of events) {
    const left = new Date(e.at).getTime() - now;
    const key = `soon:${e.id}`;
    if (left > 0 && left <= 60 * 60_000 && !given.has(key)) out.push({ key, kind: "soon", events: [e] });
  }
  return out;
}
