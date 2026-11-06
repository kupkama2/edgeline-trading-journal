import { useEffect, useRef, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { nextNyOpen, nyParts, WARN_MS } from "@shared/ny-open";

/**
 * The New York open, in the header: the clock there, how long until the
 * bell (09:30 New York time, weekdays), and a soft chime five minutes
 * before it. Browsers play nothing until the person has clicked, so the
 * chime is behind a bell toggle that is remembered in this browser.
 * Market holidays are not known here: on a holiday the countdown runs to
 * a bell that does not ring.
 */
const SOUND_KEY = "edgeline.nyopen.sound";
const RUNG_KEY = "edgeline.nyopen.rung";

const fmtLeft = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
};

/** A soft two-note chime, made here so there is nothing to download. */
function chime(): void {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const note = (freq: number, at: number, len: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + at + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + len);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + len + 0.05);
    };
    note(659.25, 0, 0.9); // E5
    note(987.77, 0.35, 1.3); // B5
    setTimeout(() => void ctx.close().catch(() => {}), 2500);
  } catch {
    /* no sound here */
  }
}

export function NyOpenChip() {
  const { toast } = useToast();
  const [now, setNow] = useState(() => Date.now());
  const [sound, setSound] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SOUND_KEY) === "1";
    } catch {
      return false;
    }
  });
  const rungFor = useRef<string | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const { openAt, inSession } = nextNyOpen(now);
  const left = openAt - now;
  const p = nyParts(now);

  // Five minutes before the bell, once per open, when the sound is on.
  useEffect(() => {
    if (!sound || left > WARN_MS || left <= 0) return;
    const key = String(openAt);
    let rung = rungFor.current;
    if (rung == null) {
      try {
        rung = localStorage.getItem(RUNG_KEY);
      } catch {
        rung = null;
      }
    }
    if (rung === key) return;
    rungFor.current = key;
    try {
      localStorage.setItem(RUNG_KEY, key);
    } catch {
      /* fine */
    }
    chime();
    toast({ title: "New York opens in 5 minutes", description: `09:30 New York · ${p.hh}:${p.mm} there now.` });
  }, [sound, left, openAt, p.hh, p.mm, toast]);

  const toggle = () => {
    const next = !sound;
    setSound(next);
    try {
      localStorage.setItem(SOUND_KEY, next ? "1" : "0");
    } catch {
      /* fine */
    }
    // The click is what lets the page make sound; play the chime once so it is known to work.
    if (next) chime();
  };

  const soon = left > 0 && left <= WARN_MS;
  return (
    <div
      className={`hidden items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 font-mono text-[10px] xl:flex ${soon ? "border-amber-500/60 bg-amber-500/10 text-amber-500" : inSession ? "border-emerald-500/40 text-emerald-400" : "border-border text-muted-foreground"}`}
      title={inSession ? "New York session is on (09:30–16:00 New York)" : `Next New York open: ${new Date(openAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })} your time`}
      data-testid="ny-open"
    >
      <span>
        NY {p.hh}:{p.mm}
      </span>
      <span className="text-foreground/80" data-testid="ny-open-left">
        {inSession ? "open" : `opens in ${fmtLeft(left)}`}
      </span>
      <button type="button" onClick={toggle} className="ml-0.5 rounded p-0.5 hover:text-foreground" title={sound ? "Chime 5 minutes before the open: on. Click to turn off." : "Chime 5 minutes before the open: off. Click to turn on."} aria-pressed={sound} data-testid="ny-open-sound">
        {sound ? <Bell className="h-3 w-3" /> : <BellOff className="h-3 w-3" />}
      </button>
    </div>
  );
}
