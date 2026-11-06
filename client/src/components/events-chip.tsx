import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { chime, SOUND_KEY } from "@/components/ny-open";
import { alertsDue, type CalendarEvent } from "@shared/calendar";

/**
 * The events that move the whole tape, in the header: the next one today
 * with how long until it, the week's list on a click, and the alerts — on
 * the morning of a day with anything on (from 07:30 your time, or the
 * first time the page is open after it) and an hour before each one. An
 * alert is a toast, the chime when the bell is on, and a desktop
 * notification once allowed. They need a tab of the journal open; a closed
 * browser hears nothing.
 */
const GIVEN_KEY = "edgeline.calendar.given";

const localDay = (ms: number) => new Date(ms).toLocaleDateString("en-CA");
const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const left = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

function readGiven(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(GIVEN_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}
function remember(keys: string[]): void {
  try {
    const all = [...Array.from(readGiven()), ...keys].slice(-300);
    localStorage.setItem(GIVEN_KEY, JSON.stringify(all));
  } catch {
    /* fine */
  }
}

export function EventsChip() {
  const { toast } = useToast();
  const q = useQuery<{ events: CalendarEvent[]; status: { fetchedAt: string | null; macro: { error: string | null }; earnings: { error: string | null } } }>({
    queryKey: ["/api/calendar"],
    refetchInterval: 30 * 60_000,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const events = q.data?.events ?? [];
  const upcoming = events.filter((e) => new Date(e.at).getTime() > now - 15 * 60_000);
  const today = upcoming.filter((e) => localDay(new Date(e.at).getTime()) === localDay(now));
  const next = today.find((e) => new Date(e.at).getTime() > now) ?? null;

  // The alerts, checked on every tick.
  const shownRef = useRef(new Set<string>());
  useEffect(() => {
    if (!events.length) return;
    const given = readGiven();
    shownRef.current.forEach((k) => given.add(k));
    const d = new Date(now);
    const due = alertsDue(events, now, given, { localDay: localDay(now), localMinutes: d.getHours() * 60 + d.getMinutes(), dayOf: (iso) => localDay(new Date(iso).getTime()) });
    if (!due.length) return;
    due.forEach((a) => shownRef.current.add(a.key));
    remember(due.map((a) => a.key));
    let sound = false;
    try {
      sound = localStorage.getItem(SOUND_KEY) === "1";
    } catch {
      /* fine */
    }
    const said = due.map((a) => ({
      title: a.kind === "morning" ? `Today: ${a.events.length} event${a.events.length === 1 ? "" : "s"} that move the tape` : `In an hour: ${a.events[0].title}`,
      body: a.events.map((e) => `${hm(e.at)} ${e.title}${e.forecast ? ` (forecast ${e.forecast})` : ""}`).join(" · "),
    }));
    // The page shows one toast at a time: several alerts due together go in one.
    toast({ title: said.map((x) => x.title).join(" · "), description: said.length === 1 ? said[0].body : said.find((x) => x.title.startsWith("Today"))?.body ?? said[0].body });
    due.forEach((a, i) => {
      const { title, body } = said[i];
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          new Notification(title, { body, tag: a.key });
        } catch {
          /* a tab that may not */
        }
      }
    });
    if (sound) chime();
  }, [events, now, toast]);

  const byDay = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    for (const e of upcoming) {
      const k = new Date(e.at).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(e);
    }
    return Array.from(m);
  }, [upcoming]);

  if (!q.data) return null;
  const soon = next && new Date(next.at).getTime() - now <= 60 * 60_000;
  const canNotify = typeof Notification !== "undefined" && Notification.permission === "default";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-1.5 py-0.5 font-mono text-[10px] xl:px-2 ${soon ? "border-amber-500/60 bg-amber-500/10 text-amber-500" : today.length ? "border-sky-500/40 text-sky-400" : "border-border text-muted-foreground"}`}
          title={next ? `Next: ${next.title} at ${hm(next.at)}, in ${left(new Date(next.at).getTime() - now)}` : today.length ? "Today's events are done" : "No events today. Click for the week."}
          aria-label="Macro releases and large earnings this week"
          data-testid="events-chip"
        >
          <CalendarClock className="h-3 w-3" />
          {/* Narrow screens: the icon alone, with the time left when an event is within the hour. */}
          {next ? (
            <span className={soon ? "" : "hidden xl:inline"}>
              <span className="xl:hidden">{left(new Date(next.at).getTime() - now)}</span>
              <span className="hidden xl:inline">
              {next.tag === "USD" ? next.title.replace(/ (m\/m|y\/y|q\/q)$/, "") : next.tag} {hm(next.at)} · {left(new Date(next.at).getTime() - now)}
              </span>
            </span>
          ) : today.length ? (
            <span className="hidden xl:inline">today done</span>
          ) : (
            <span className="hidden xl:inline">no events today</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3 text-xs" data-testid="events-list">
        <p className="font-semibold">This week</p>
        <p className="text-[10px] text-muted-foreground">US releases of high impact and earnings over $200B, your time. Alerts the morning of, and an hour before.</p>
        {canNotify && (
          <Button size="sm" variant="outline" className="mt-2 h-7 w-full text-[11px]" onClick={() => void Notification.requestPermission()} data-testid="events-allow">
            Allow desktop alerts
          </Button>
        )}
        <div className="mt-2 max-h-80 space-y-2 overflow-y-auto">
          {byDay.length === 0 && <p className="text-muted-foreground">Nothing ahead in the calendar.</p>}
          {byDay.map(([day, list]) => (
            <div key={day}>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{day}</p>
              <ul className="mt-0.5 space-y-0.5">
                {list.map((e) => (
                  <li key={e.id} className="flex items-baseline gap-2">
                    <span className="w-10 shrink-0 font-mono text-muted-foreground">{e.kind === "earnings" && e.session !== "unknown" ? (e.session === "before-open" ? "pre" : "post") : hm(e.at)}</span>
                    <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${e.impact === "high" ? "bg-red-500" : "bg-amber-500"}`} />
                    <span className="min-w-0">
                      {e.kind === "earnings" ? <b>{e.tag}</b> : null} {e.kind === "earnings" ? e.title.replace(/ earnings$/, "") : e.title}
                      {e.forecast && <span className="ml-1 text-muted-foreground">f {e.forecast}{e.previous ? ` · p ${e.previous}` : ""}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {(q.data.status.macro.error || q.data.status.earnings.error) && (
          <p className="mt-2 text-[10px] text-amber-500">
            {q.data.status.macro.error ? `Macro feed: ${q.data.status.macro.error}. ` : ""}
            {q.data.status.earnings.error ? `Earnings: ${q.data.status.earnings.error}.` : ""}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
