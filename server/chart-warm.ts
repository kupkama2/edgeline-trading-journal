/**
 * Charts read ahead of the page.
 *
 * A trade's chart is wanted the moment the trade is opened, and the trades
 * that get opened are the ones on now and the ones just closed. So their
 * windows are read into the cache before anybody asks: every minute for
 * the open ones, whose window moves with the clock, and once for the ones
 * closed in the last day, whose window does not. A venue that refuses
 * costs nothing here but a quick failure; the breaker in binance-ban.ts
 * sees to that.
 */
import { inArray, or, and, gt, eq } from "drizzle-orm";
import { trades } from "@shared/schema";
import { venueOfAccount } from "@shared/hyperliquid";
import { candleStore, db, storageFor } from "./storage";
import { ensureCatalogue } from "./outcomes";
import { hyperliquidAssets } from "./hyperliquid";
import { pairForTradeAt, readCandlesAt } from "./candles";
import { chartWindow } from "./chart-window";

const RECENT_MS = 24 * 60 * 60_000;

export async function warmCharts(now = Date.now(), onlyUser?: number): Promise<{ users: number; warmed: number; failed: number }> {
  const since = new Date(now - RECENT_MS).toISOString();
  const live = or(inArray(trades.status, ["open", "pending"]), and(eq(trades.status, "closed"), gt(trades.exitTime, since)));
  const rows = await db
    .selectDistinct({ userId: trades.userId })
    .from(trades)
    .where(onlyUser != null ? and(live, eq(trades.userId, onlyUser)) : live);
  const out = { users: rows.length, warmed: 0, failed: 0 };
  const cat = await ensureCatalogue();
  let hlNames: Awaited<ReturnType<typeof hyperliquidAssets>> | null = null;
  for (const { userId } of rows) {
    const s = storageFor(userId);
    const mine = (await s.listLiveTrades(since)).filter((t) => !t.scalp);
    for (const t of mine) {
      try {
        if (venueOfAccount(t.account) === "hyperliquid" && !hlNames) hlNames = await hyperliquidAssets().catch(() => []);
        const pair = pairForTradeAt(t, cat, venueOfAccount(t.account) === "hyperliquid" ? (hlNames ?? []) : []);
        if (!pair) continue;
        const w = chartWindow(t, undefined, undefined, now);
        await readCandlesAt(pair, w.interval, w.from, w.to, 1200, true);
        out.warmed += 1;
      } catch {
        out.failed += 1;
      }
    }
  }
  return out;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Every minute, after a few seconds' grace at boot. `CHART_WARM_MS=0` turns it off. */
export function startChartWarm(everyMs = Number(process.env.CHART_WARM_MS ?? "60000")): void {
  if (!(everyMs > 0)) return;
  let lastPrune = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // Rows past their time, gone — a few times a day is plenty.
      if (Date.now() - lastPrune > 6 * 60 * 60_000) {
        lastPrune = Date.now();
        await candleStore.prune().catch(() => 0);
      }
      const r = await warmCharts();
      if (r.failed) console.error(`[charts] warmed ${r.warmed}, ${r.failed} could not be read`);
    } catch (err: any) {
      console.error("[charts] warm:", String(err?.message ?? err).slice(0, 200));
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  setTimeout(() => void tick(), 5_000).unref();
}

export function stopChartWarm(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
