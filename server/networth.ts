/**
 * Everything the owner follows, as one figure.
 *
 * The Portfolio page reads several things that do not know of each other:
 * the wallets, Hyperliquid accounts and vaults behind the followed
 * addresses; Sigil Core, from its export; the Lulo deposit; and positions
 * valued by hand. This adds them up and says what each contributes, and
 * keeps the sum once a day so it can be drawn.
 *
 * A part that could not be read is left out of the sum and named, and a
 * day with a part missing is not kept: a total short of one of its parts
 * would draw as a loss that never happened. Astekz is somebody else's
 * portfolio and is not in it.
 */
import type { Express, Request, Response } from "express";
import { adminOnly } from "./admin";
import { followedValues } from "./storage";
import { readPortfolio } from "./portfolio";
import { sigilState } from "./sigil";
import { readLulo, typedState } from "./lulo";

export interface NetWorthPart {
  id: string;
  label: string;
  valueUsd: number;
  /** Gain against what went in, where that is known. */
  pnlUsd: number | null;
  /** The day the figure is from, when it is not live. */
  asOf: string | null;
}

export interface NetWorth {
  at: string;
  totalUsd: number;
  parts: NetWorthPart[];
  /** What could not be read, or was only partly read, in words. */
  missing: string[];
  history: { date: string; valueUsd: number }[];
}

export async function netWorth(userId: number, now = Date.now()): Promise<NetWorth> {
  const parts: NetWorthPart[] = [];
  const missing: string[] = [];

  try {
    const p = await readPortfolio(userId);
    if (p.addresses.length > 0) parts.push({ id: "addresses", label: "Wallets and Hyperliquid", valueUsd: p.totals.value, pnlUsd: p.totals.pnl ?? null, asOf: null });
    // A source that failed outright leaves its wallet out of that figure; one answered from an earlier read does not.
    const hard = p.errors.filter((e) => !e.stale);
    if (hard.length) missing.push(`Wallets and Hyperliquid: ${hard.length} ${hard.length === 1 ? "source" : "sources"} could not be read`);
  } catch (err: any) {
    missing.push(`Wallets and Hyperliquid: ${String(err?.message ?? err).slice(0, 120)}`);
  }

  try {
    const s = await sigilState();
    if (s.latest) parts.push({ id: "sigil", label: "Sigil Core", valueUsd: s.latest.portfolioValueUsd, pnlUsd: s.entryUsd != null ? s.latest.portfolioValueUsd - s.entryUsd : null, asOf: s.latest.day });
  } catch (err: any) {
    missing.push(`Sigil Core: ${String(err?.message ?? err).slice(0, 120)}`);
  }

  try {
    const l = await readLulo(userId);
    if (l.total.valueUsd > 0) parts.push({ id: "lulo", label: "Lulo", valueUsd: l.total.valueUsd, pnlUsd: l.total.interestUsd, asOf: null });
    const failed = l.wallets.filter((w) => w.error).length;
    if (failed) missing.push(`Lulo: ${failed} ${failed === 1 ? "wallet" : "wallets"} could not be read`);
  } catch (err: any) {
    missing.push(`Lulo: ${String(err?.message ?? err).slice(0, 120)}`);
  }

  try {
    for (const t of await typedState(userId)) {
      const last = t.values[t.values.length - 1];
      if (last) parts.push({ id: `typed:${t.id}`, label: t.name, valueUsd: last.valueUsd, pnlUsd: t.entryUsd != null ? last.valueUsd - t.entryUsd : null, asOf: last.date });
    }
  } catch (err: any) {
    missing.push(`Other positions: ${String(err?.message ?? err).slice(0, 120)}`);
  }

  const totalUsd = parts.reduce((s, p) => s + p.valueUsd, 0);
  const key = String(userId);
  if (missing.length === 0 && totalUsd > 0) await followedValues.put("networth", key, new Date(now).toISOString().slice(0, 10), totalUsd);
  return { at: new Date(now).toISOString(), totalUsd, parts: parts.sort((a, b) => b.valueUsd - a.valueUsd), missing, history: (await followedValues.list("networth", key)).map((h) => ({ date: h.day, valueUsd: h.value })) };
}

export function registerNetWorthRoutes(app: Express): void {
  app.use("/api/networth", adminOnly);
  app.get("/api/networth", async (req: Request, res: Response) => {
    res.json(await netWorth(req.userId!));
  });
}
