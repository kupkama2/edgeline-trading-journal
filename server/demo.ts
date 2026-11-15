/**
 * The demo: the journal as a stranger can walk through it, with no account.
 *
 * One ordinary account holds it — never the owner's, so the owner's tools
 * (the screener, the chat, the portfolio, the terminal) are not there and
 * nothing of the owner's can be reached from it. Opening /demo signs the
 * visitor into that account on a session marked as the demo, and from then
 * on every request that would change anything is refused: a hundred
 * strangers share the one journal, and it has to be the same for each.
 *
 * The trades are generated (shared/demo.ts) from the venue's real hourly
 * candles, so the charts line up with the entries; when the venue cannot
 * be asked they are generated from a stand-in price path instead. The
 * journal is rebuilt when it has gone stale, so the dates never look old.
 *
 * DEMO=off turns the whole thing off: the door answers 404.
 */
import type { Express, NextFunction, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { accounts, storageFor } from "./storage";
import { hlInfo } from "./hyperliquid";
import { parseScreenerCandles, type ScreenerCandle } from "@shared/screener";
import { demoTrades, syntheticCandles } from "@shared/demo";

export const DEMO_SUB = "edgeline-demo";
export const DEMO_EMAIL = "demo@edgeline.invalid";
export const demoEnabled = (): boolean => (process.env.DEMO ?? "on").toLowerCase() !== "off";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const DAYS = 120;
/** The journal is rebuilt once its newest trade is this old. */
const STALE_MS = 3 * DAY;
const COINS: [string, number][] = [["BTC", 95000], ["ETH", 3400], ["SOL", 190], ["HYPE", 38], ["DOGE", 0.22], ["LINK", 17]];
/** The habit a sample trade shows, as one of the mistake tags every new journal starts with. Getting out early has none: its cost shows in the management figures. */
const MISTAKES = { "early-exit": "", oversized: "Bet Too Large", chased: "Poor Risk/Reward" } as const;

declare module "express-session" {
  interface SessionData {
    /** This session is a visitor in the demo journal: read-only. */
    demo?: boolean;
  }
}

let building: Promise<number> | null = null;

async function candlesFor(coin: string, start: number, now: number): Promise<ScreenerCandle[]> {
  const raw = await hlInfo({ type: "candleSnapshot", req: { coin, interval: "1h", startTime: now - DAYS * DAY, endTime: now } }, 15_000, { lane: "background" });
  const bars = parseScreenerCandles(raw).filter((b) => b.t + HOUR <= now);
  if (bars.length < 240) throw new Error(`${coin}: ${bars.length} bars`);
  void start;
  return bars;
}

/** The demo account, with a journal in it that is not stale. One build at a time. */
export function demoAccount(nowFn: () => number = Date.now): Promise<number> {
  if (building) return building;
  building = (async () => {
    const now = nowFn();
    const user = (await accounts.byGoogleSub(DEMO_SUB)) ?? (await accounts.create({ googleSub: DEMO_SUB, email: DEMO_EMAIL, name: "Demo trader", isOwner: false }));
    const s = storageFor(user.id);
    const have = await s.listTrades();
    const newest = have.reduce((m, t) => Math.max(m, new Date(t.entryTime).getTime()), 0);
    if (have.length >= 20 && now - newest < STALE_MS) return user.id;

    const series = new Map<string, ScreenerCandle[]>();
    for (const [coin, start] of COINS) {
      // The venue's own candles; a coin it will not give is walked from a stand-in price instead.
      series.set(coin, await candlesFor(coin, start, now).catch(() => syntheticCandles(start, DAYS * 24, now, coin.length * 7919 + start)));
    }
    const made = demoTrades(series, { seed: Math.floor(now / STALE_MS) });
    const tags = await s.listMistakeTags();
    const tagFor = async (name: string) => tags.find((t) => t.name.toLowerCase() === name.toLowerCase())?.id ?? null;
    const ids = { "early-exit": await tagFor(MISTAKES["early-exit"]), oversized: await tagFor(MISTAKES.oversized), chased: await tagFor(MISTAKES.chased) };
    for (const t of have) await s.deleteTrade(t.id);
    for (const t of made) {
      const { mistake, ...row } = t;
      const tag = mistake ? ids[mistake] : null;
      await s.createTrade({ ...row, sizeUnit: "base", pointValue: 1, account: "Demo", pricePair: `hyperliquid:${t.symbol}`, targetSource: "manual", outcomeSource: t.noManagementOutcome ? "auto" : null } as any, tag ? [tag] : []);
    }
    console.log(`[demo] journal rebuilt: ${made.length} trades`);
    return user.id;
  })().finally(() => {
    building = null;
  });
  return building;
}

/** Whether an account is the demo's: it is let in without being on the allowlist. */
export const isDemoEmail = (email: string | null | undefined): boolean => email === DEMO_EMAIL;

/**
 * Nothing a demo visitor does may change the journal they share. Reads pass;
 * anything else is refused in words the page can show.
 */
export function demoReadOnly(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.demo || req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  res.status(403).json({ message: "This is the demo: you can look at everything, but nothing is saved. Sign in for a journal of your own." });
}

/** Where the built client keeps the tour, and where the source does when the server runs from it. */
const TOUR_FILES = [...(typeof __dirname === "string" ? [path.resolve(__dirname, "public", "tour.html")] : []), path.resolve(process.cwd(), "dist", "public", "tour.html"), path.resolve(process.cwd(), "client", "public", "tour.html")];

/** The pages a visitor may be dropped on: /demo?to=stats opens the demo there. Anything else is the journal. */
export const DEMO_LANDINGS = ["stats", "calendar", "review", "screener"] as const;
export const landing = (to: unknown): string => (typeof to === "string" && (DEMO_LANDINGS as readonly string[]).includes(to) ? `/#/${to}` : "/");

/** The door: /demo and /api/auth/demo sign a visitor into the demo journal. Registered before the sign-in wall. */
export function registerDemoDoor(app: Express): void {
  const enter = async (req: Request, res: Response) => {
    if (!demoEnabled()) return res.status(404).send("Not found");
    try {
      const id = await demoAccount();
      // A new session, as on any sign-in; and never over a real account's.
      req.session.regenerate((err) => {
        if (err) return res.redirect("/");
        req.session.userId = id;
        req.session.demo = true;
        req.session.save(() => res.redirect(landing(req.query.to)));
      });
    } catch (err: any) {
      console.error(`[demo] ${String(err?.message ?? err).slice(0, 200)}`);
      res.redirect("/");
    }
  };
  app.get("/demo", enter);
  app.get("/api/auth/demo", enter);
  // The tour: a page that walks a visitor through the demo. Its file ships with the client; the address is this one.
  app.get("/tour", (_req, res) => {
    const file = demoEnabled() ? TOUR_FILES.find((f) => fs.existsSync(f)) : undefined;
    if (!file) return res.status(404).send("Not found");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(file);
  });
}
