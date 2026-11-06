import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { alertsDue, nextWeekdaysNy, nyTime, parseForexFactory, parseNasdaqEarnings, type CalendarEvent } from "../shared/calendar";

/**
 * The event calendar: the macro feed and the earnings calendar read the
 * way each source shapes them, New York times across the clock change,
 * the morning and hour-before alerts, and a download against fake feeds
 * where one source fails and the other's events still arrive.
 */
const ff = [
  { title: "Non-Farm Employment Change", country: "USD", date: "2026-11-06T08:30:00-05:00", impact: "High", forecast: "110K", previous: "254K" },
  { title: "Core PPI m/m", country: "USD", date: "2026-11-13T08:30:00-05:00", impact: "Medium", forecast: "0.2%", previous: "0.3%" },
  { title: "Crude Oil Inventories", country: "USD", date: "2026-11-11T10:30:00-05:00", impact: "Medium", forecast: "", previous: "" },
  { title: "ECB President Lagarde Speaks", country: "EUR", date: "2026-11-10T09:00:00-05:00", impact: "High" },
  { title: "Bank Holiday", country: "USD", date: "2026-11-11T00:00:00-05:00", impact: "Holiday" },
  { title: "bad date", country: "USD", date: "nope", impact: "High" },
];
const nasdaq = (rows: object[]) => ({ data: { rows } });

describe("reading the calendar", () => {
  it("keeps US releases of high impact, and the ones crypto trades on at medium", () => {
    const e = parseForexFactory(ff);
    expect(e.map((x) => x.title)).toEqual(["Non-Farm Employment Change", "Core PPI m/m"]);
    expect(e[0]).toMatchObject({ kind: "macro", tag: "USD", at: "2026-11-06T13:30:00.000Z", impact: "high", forecast: "110K", previous: "254K" });
    expect(e[1].impact).toBe("medium");
  });

  it("keeps earnings over $200B and the crypto names, timed by session in New York", () => {
    const e = parseNasdaqEarnings(
      nasdaq([
        { symbol: "NVDA", name: "NVIDIA Corporation", marketCap: "$3,412,000,000,000", time: "time-after-hours", epsForecast: "$0.85" },
        { symbol: "COIN", name: "Coinbase Global, Inc.", marketCap: "$60,000,000,000", time: "time-pre-market" },
        { symbol: "SMOL", name: "Small Co", marketCap: "$2,000,000,000", time: "time-pre-market" },
        { symbol: "WMT", name: "Walmart Inc.", marketCap: "$700,000,000,000", time: "time-not-supplied" },
      ]),
      "2026-11-19",
    );
    expect(e.map((x) => x.tag)).toEqual(["NVDA", "COIN", "WMT"]);
    // New York is on winter time on the 19th: 16:05 there is 21:05 UTC; 08:00 is 13:00.
    expect(e[0]).toMatchObject({ title: "NVIDIA earnings", at: "2026-11-19T21:05:00.000Z", impact: "high", session: "after-close", forecast: "$0.85" });
    expect(e[1]).toMatchObject({ title: "Coinbase Global earnings", at: "2026-11-19T13:00:00.000Z", impact: "high", session: "before-open" });
    expect(e[2]).toMatchObject({ impact: "medium", session: "unknown" });
  });

  it("puts New York times on the right UTC hour on both sides of the clock change, and counts weekdays", () => {
    expect(nyTime("2026-07-15", "08:30")).toBe("2026-07-15T12:30:00.000Z");
    expect(nyTime("2026-12-15", "08:30")).toBe("2026-12-15T13:30:00.000Z");
    // Friday 6 Nov, noon UTC: today, then Monday to Thursday.
    expect(nextWeekdaysNy(Date.parse("2026-11-06T12:00:00Z"), 5)).toEqual(["2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]);
  });
});

describe("the alerts", () => {
  const ev = (id: string, at: string): CalendarEvent => ({ id, kind: "macro", title: id, tag: "USD", at, impact: "high" });
  const events = [ev("CPI", "2026-11-12T13:30:00Z"), ev("FOMC", "2026-11-12T19:00:00Z"), ev("GDP", "2026-11-13T13:30:00Z")];
  // The viewer in UTC, for a plain clock.
  const clock = (iso: string) => {
    const d = new Date(iso);
    return { localDay: iso.slice(0, 10), localMinutes: d.getUTCHours() * 60 + d.getUTCMinutes(), dayOf: (x: string) => x.slice(0, 10) };
  };

  it("gives the morning one from 07:30 on a day with anything on, once", () => {
    const at = "2026-11-12T07:00:00Z";
    expect(alertsDue(events, Date.parse(at), new Set(), clock(at))).toEqual([]);
    const later = "2026-11-12T07:45:00Z";
    const due = alertsDue(events, Date.parse(later), new Set(), clock(later));
    expect(due).toMatchObject([{ kind: "morning", key: "morning:2026-11-12" }]);
    expect(due[0].events.map((e) => e.id)).toEqual(["CPI", "FOMC"]);
    expect(alertsDue(events, Date.parse(later), new Set(["morning:2026-11-12"]), clock(later))).toEqual([]);
  });

  it("gives one an hour before each event, once, and none after it starts", () => {
    const at = "2026-11-12T12:40:00Z";
    const due = alertsDue(events, Date.parse(at), new Set(["morning:2026-11-12"]), clock(at));
    expect(due).toMatchObject([{ kind: "soon", key: "soon:CPI" }]);
    expect(alertsDue(events, Date.parse(at), new Set(["morning:2026-11-12", "soon:CPI"]), clock(at))).toEqual([]);
    const after = "2026-11-12T13:31:00Z";
    expect(alertsDue(events, Date.parse(after), new Set(["morning:2026-11-12"]), clock(after))).toEqual([]);
    // A day with nothing on: no morning alert.
    const sat = "2026-11-14T09:00:00Z";
    expect(alertsDue(events, Date.parse(sat), new Set(), clock(sat))).toEqual([]);
  });
});

/* ------------------------------- the download ------------------------------- */

const DB = process.env.DATABASE_URL;
let fake: Server;
let app: Server;
let base = "";
let earningsDown = false;

beforeAll(async () => {
  if (!DB) return;
  await new Promise<void>((resolve) => {
    fake = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      const json = (o: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (u.pathname === "/ff.json") return json(ff);
      if (u.pathname === "/api/calendar/earnings") {
        if (earningsDown) return json({ message: "blocked" }, 403);
        const day = u.searchParams.get("date");
        return json(nasdaq(day === "2026-11-09" ? [{ symbol: "NVDA", name: "NVIDIA Corporation", marketCap: "$3,412,000,000,000", time: "time-after-hours" }] : []));
      }
      json({}, 404);
    });
    fake.listen(0, "127.0.0.1", () => resolve());
  });
  const f = `http://127.0.0.1:${(fake.address() as any).port}`;
  process.env.CALENDAR_MACRO_URL = `${f}/ff.json`;
  process.env.CALENDAR_EARNINGS_BASE = f;
  const { initSchema, accounts } = await import("../server/storage");
  const { registerRoutes } = await import("../server/routes");
  await initSchema();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const me = await accounts.create({ googleSub: `cal-${stamp}`, email: `cal-${stamp}@x.test` });
  const ex = express();
  ex.use(express.json());
  ex.use((req, _res, next) => {
    (req as any).userId = me.id;
    (req as any).account = { id: me.id, email: me.email, isOwner: false };
    next();
  });
  app = createServer(ex);
  await registerRoutes(app, ex);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as any).port}`;
}, 60_000);

afterAll(async () => {
  if (app) await new Promise((r) => app.close(r));
  if (fake) await new Promise((r) => fake.close(r));
});

describe.skipIf(!DB)("the download", () => {
  it("stores both sources, and keeps a source's last copy when it fails", async () => {
    const { refreshCalendar, calendarTick } = await import("../server/calendar");
    const { calendarStore } = await import("../server/storage");
    const now = Date.parse("2026-11-06T12:00:00Z");
    const st = await refreshCalendar(now);
    expect(st.macro).toEqual({ events: 2, error: null });
    expect(st.earnings).toEqual({ events: 1, error: null });
    const all = await calendarStore.between("2026-11-05T00:00:00Z", "2026-11-20T00:00:00Z");
    expect(all.map((e) => e.id)).toEqual(expect.arrayContaining(["macro:Non-Farm Employment Change:2026-11-06T13:30:00.000Z", "earnings:NVDA:2026-11-09"]));

    // Nasdaq refuses the next day: the macro feed still lands, and NVDA stays from the last good copy.
    earningsDown = true;
    const st2 = await refreshCalendar(now + 3600_000);
    expect(st2.earnings.error).toMatch(/HTTP 403/);
    expect((await calendarStore.between("2026-11-05T00:00:00Z", "2026-11-20T00:00:00Z")).some((e) => e.id === "earnings:NVDA:2026-11-09")).toBe(true);
    earningsDown = false;

    // The clock's tick does nothing within twelve hours on the same New York day.
    await calendarTick(now + 2 * 3600_000);
    const { calendarStatus } = await import("../server/calendar");
    expect(calendarStatus().fetchedAt).toBe(new Date(now + 3600_000).toISOString());

    // Every signed-in account reads it.
    const r = await (await fetch(`${base}/api/calendar`)).json();
    expect(Array.isArray(r.events)).toBe(true);
    expect(r.status.earnings.error).toMatch(/HTTP 403/);
  });
});
