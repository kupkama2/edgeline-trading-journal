/**
 * The owner's Lulo deposit, and the positions they keep by hand.
 *
 * Lulo: its public API answers for any wallet with no key. Every Solana
 * address the owner already follows on the Portfolio page is asked; the
 * ones with a deposit are shown, and the total is kept once a day so its
 * growth can be drawn. An address that cannot be read is named with the
 * reason, and the rest still show.
 *
 * Typed positions: a stake whose value arrives as one number, weekly or
 * whenever. The owner gives it a name and what went in, and types the
 * value when they have it; each value is kept under its day.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { adminOnly } from "./admin";
import { followedValues, portfolioStore, typedPositions } from "./storage";
import { blendedRate, parseLuloAccount, parseLuloRates, sumLulo, type LuloAccount, type LuloRates } from "@shared/lulo";
import { pragueDay } from "@shared/sigil";

/** Read when asked, not when loaded, so a test can stand a fake in for Lulo. */
const lulo = () => (process.env.LULO_BASE || "https://api.lulo.fi").replace(/\/+$/, "");
const CACHE_MS = 10 * 60_000;

async function get(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Lulo answered ${res.status}`);
  return res.json();
}

export interface LuloState {
  at: string;
  wallets: { address: string; label: string | null; account: LuloAccount | null; error: string | null }[];
  total: LuloAccount;
  rates: LuloRates;
  /** The yearly rate being earned now, weighted by pool; null when it cannot be said. */
  rate: number | null;
  history: { date: string; valueUsd: number }[];
  /** Whether any Solana address is followed at all: without one there is nothing to ask about. */
  followed: number;
}

const cache = new Map<number, { at: number; state: LuloState }>();

export async function readLulo(userId: number, opts: { fresh?: boolean; now?: number } = {}): Promise<LuloState> {
  const now = opts.now ?? Date.now();
  const hit = cache.get(userId);
  if (hit && !opts.fresh && now - hit.at < CACHE_MS) return hit.state;
  const addresses = (await portfolioStore.addresses(userId)).filter((a) => a.kind === "solana");
  const wallets = await Promise.all(
    addresses.map(async (a) => {
      try {
        const account = parseLuloAccount(await get(`${lulo()}/v1/account.getAccount?owner=${encodeURIComponent(a.address)}`));
        if (!account) throw new Error("Lulo's answer was not an account");
        return { address: a.address, label: a.label, account, error: null };
      } catch (err: any) {
        return { address: a.address, label: a.label, account: null, error: String(err?.message ?? err).slice(0, 160) };
      }
    }),
  );
  const rates = await get(`${lulo()}/v1/rates.getRates`).then(parseLuloRates, () => ({ protected: null, boosted: null }));
  const read = wallets.filter((w) => w.account);
  const total = sumLulo(read.map((w) => w.account!));
  const key = String(userId);
  // A day is kept only when every wallet answered: a total missing one of them would draw as a withdrawal.
  if (read.length > 0 && read.length === wallets.length && total.valueUsd > 0) await followedValues.put("lulo", key, new Date(now).toISOString().slice(0, 10), total.valueUsd);
  const state: LuloState = {
    at: new Date(now).toISOString(),
    // A followed wallet with nothing in Lulo is not listed; one that could not be read is.
    wallets: wallets.filter((w) => w.error || (w.account && w.account.valueUsd > 0)),
    total,
    rates,
    rate: blendedRate(total, rates),
    history: (await followedValues.list("lulo", key)).map((h) => ({ date: h.day, valueUsd: h.value })),
    followed: addresses.length,
  };
  cache.set(userId, { at: now, state });
  return state;
}

export interface TypedPosition {
  id: number;
  name: string;
  entryUsd: number | null;
  /** Where on the page it sits: "sigil" beside Sigil Core, null among the other positions. */
  group: string | null;
  values: { date: string; valueUsd: number }[];
}

export async function typedState(userId: number): Promise<TypedPosition[]> {
  const list = await typedPositions.list(userId);
  return Promise.all(list.map(async (p) => ({ id: p.id, name: p.name, entryUsd: p.entryUsd, group: p.group, values: (await followedValues.list("typed", String(p.id))).map((v) => ({ date: v.day, valueUsd: v.value })) })));
}

const money = z.number().positive().max(1e12);
const positionSchema = z.object({ name: z.string().trim().min(1).max(60), entryUsd: money.nullable() });
const createSchema = positionSchema.extend({ group: z.enum(["sigil"]).nullable().optional() });
const valueSchema = z.object({ valueUsd: money, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export function registerLuloRoutes(app: Express): void {
  app.use("/api/lulo", adminOnly);
  app.use("/api/typed-positions", adminOnly);
  const uid = (req: Request) => req.userId!;

  app.get("/api/lulo", async (req: Request, res: Response) => {
    res.json(await readLulo(uid(req), { fresh: req.query.fresh === "1" }));
  });

  app.get("/api/typed-positions", async (req: Request, res: Response) => {
    res.json(await typedState(uid(req)));
  });

  app.post("/api/typed-positions", async (req: Request, res: Response) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "A position needs a name; the entry, when given, is an amount above zero." });
    await typedPositions.create(uid(req), body.data.name, body.data.entryUsd, body.data.group ?? null);
    res.status(201).json(await typedState(uid(req)));
  });

  app.put("/api/typed-positions/:id", async (req: Request, res: Response) => {
    const body = positionSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "A position needs a name; the entry, when given, is an amount above zero." });
    if (!(await typedPositions.update(uid(req), Number(req.params.id), body.data.name, body.data.entryUsd))) return res.status(404).json({ message: "Not found" });
    res.json(await typedState(uid(req)));
  });

  app.delete("/api/typed-positions/:id", async (req: Request, res: Response) => {
    if (!(await typedPositions.remove(uid(req), Number(req.params.id)))) return res.status(404).json({ message: "Not found" });
    res.json(await typedState(uid(req)));
  });

  /** A value for a day: today in Prague unless a date is given. Typing the same day again corrects it. */
  app.put("/api/typed-positions/:id/value", async (req: Request, res: Response) => {
    const body = valueSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "The value is an amount in dollars, above zero." });
    const id = Number(req.params.id);
    if (!(await typedPositions.list(uid(req))).some((p) => p.id === id)) return res.status(404).json({ message: "Not found" });
    const today = pragueDay(new Date().toISOString());
    const date = body.data.date ?? today;
    if (date > today) return res.status(400).json({ message: "That date has not come yet." });
    await followedValues.put("typed", String(id), date, body.data.valueUsd);
    res.json(await typedState(uid(req)));
  });

  app.delete("/api/typed-positions/:id/value/:date", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!(await typedPositions.list(uid(req))).some((p) => p.id === id)) return res.status(404).json({ message: "Not found" });
    await followedValues.remove("typed", String(id), String(req.params.date));
    res.json(await typedState(uid(req)));
  });
}
