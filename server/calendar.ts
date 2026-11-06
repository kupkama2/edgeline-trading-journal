/**
 * The event calendar's download: Forex Factory's weekly macro feed and
 * Nasdaq's earnings calendar for the next five weekdays, once a day (the
 * screener's clock asks every minute and this answers only when the last
 * download is twelve hours old or from another New York day). One source
 * failing leaves the other's events and the last good copy of its own.
 *
 * Hosts are overridable (CALENDAR_MACRO_URL, CALENDAR_EARNINGS_BASE) for
 * the tests.
 */
import { fetch as undiciFetch } from "undici";
import type { Express } from "express";
import { egressFor } from "./egress";
import { calendarStore } from "./storage";
import { nextWeekdaysNy, parseForexFactory, parseNasdaqEarnings, type CalendarEvent } from "@shared/calendar";

const MACRO_URL = process.env.CALENDAR_MACRO_URL || "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const EARNINGS_BASE = (process.env.CALENDAR_EARNINGS_BASE || "https://api.nasdaq.com").replace(/\/+$/, "");
const EVERY_MS = 12 * 3600_000;

export interface CalendarStatus {
  fetchedAt: string | null;
  macro: { events: number; error: string | null };
  earnings: { events: number; error: string | null };
}

let status: CalendarStatus = { fetchedAt: null, macro: { events: 0, error: null }, earnings: { events: 0, error: null } };
export const calendarStatus = () => status;

async function getJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await undiciFetch(url, {
      // Nasdaq answers a plain client with nothing; it wants to look like a browser asking.
      headers: { accept: "application/json, text/plain, */*", "user-agent": "Mozilla/5.0 (compatible; Edgeline journal calendar)" },
      signal: ctl.signal,
      dispatcher: egressFor(url),
    } as any);
    if (!res.ok) throw new Error(`${new URL(url).host} → HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Download both sources and store what came back. */
export async function refreshCalendar(now = Date.now()): Promise<CalendarStatus> {
  const next: CalendarStatus = { fetchedAt: new Date(now).toISOString(), macro: { events: 0, error: null }, earnings: { events: 0, error: null } };
  let macro: CalendarEvent[] | null = null;
  try {
    macro = parseForexFactory(await getJson(MACRO_URL));
    next.macro.events = macro.length;
  } catch (err: any) {
    next.macro.error = String(err?.message ?? err).slice(0, 200);
  }
  let earnings: CalendarEvent[] | null = null;
  try {
    earnings = [];
    for (const day of nextWeekdaysNy(now, 5)) earnings.push(...parseNasdaqEarnings(await getJson(`${EARNINGS_BASE}/api/calendar/earnings?date=${day}`), day));
    next.earnings.events = earnings.length;
  } catch (err: any) {
    next.earnings.error = String(err?.message ?? err).slice(0, 200);
    earnings = null;
  }
  // A source that failed keeps what it had; one that answered replaces its own kind from now on.
  if (macro) await calendarStore.replace("macro", new Date(now - 86400_000).toISOString(), macro);
  if (earnings) await calendarStore.replace("earnings", new Date(now - 86400_000).toISOString(), earnings);
  await calendarStore.prune(new Date(now - 14 * 86400_000).toISOString()).catch(() => {});
  status = next;
  return next;
}

const nyDay = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

/** The clock's question: refresh when the last download is old or from another New York day. */
export async function calendarTick(now = Date.now()): Promise<void> {
  const last = status.fetchedAt ? new Date(status.fetchedAt).getTime() : await calendarStore.lastFetchedAt().then((x) => (x ? new Date(x).getTime() : 0));
  if (last && now - last < EVERY_MS && nyDay(last) === nyDay(now)) return;
  await refreshCalendar(now);
}

export function registerCalendarRoutes(app: Express): void {
  /** The coming week's events and how the last download went. */
  app.get("/api/calendar", async (_req, res) => {
    const from = new Date(Date.now() - 2 * 3600_000).toISOString();
    const to = new Date(Date.now() + 8 * 86400_000).toISOString();
    res.json({ events: await calendarStore.between(from, to), status });
  });
}
