/**
 * The guard rails: how much a day may lose, how many losses in a row stop
 * it, how long the breaks are. One person's limits, not the app's — set in
 * Settings by whoever is signed in and kept with their prefs, so the laptop
 * and the phone hold the same line. Everything that reads a day against a
 * limit (the daily guard, the tilt meter, the entry form's signals) takes
 * these; the defaults are what the journal shipped with.
 */
import { z } from "zod";

export interface GuardRails {
  /** Dollars down on the day at which the guard turns amber. */
  dailyLossAlert: number;
  /** Dollars down on the day at which the day is over. */
  dailyLossStop: number;
  /** Losses in a row that halt the day and light the meter. */
  lossStreakLimit: number;
  /** The forced break after that streak, in seconds. */
  cooldownSeconds: number;
  /** How long the meter's lock holds past the last sign, in minutes. */
  walkMinutes: number;
  /** Back into a symbol this soon after losing on it counts as a re-entry, in minutes. */
  reentryMinutes: number;
}

export const DEFAULT_GUARDRAILS: GuardRails = {
  dailyLossAlert: 300,
  dailyLossStop: 500,
  lossStreakLimit: 3,
  cooldownSeconds: 60,
  walkMinutes: 30,
  reentryMinutes: 15,
};

const money = z.number().finite().min(0).max(1_000_000_000);
const count = z.number().int().min(1).max(100);
const seconds = z.number().int().min(0).max(24 * 3600);
const minutes = z.number().int().min(0).max(24 * 60);

export const guardRailsSchema = z.object({
  dailyLossAlert: money,
  dailyLossStop: money,
  lossStreakLimit: count,
  cooldownSeconds: seconds,
  walkMinutes: minutes,
  reentryMinutes: minutes,
});

/** A change to some of them. Checked as a whole against the current values by the caller: the warning must not sit past the stop. */
export const guardRailsPatchSchema = guardRailsSchema.partial().strict();

/** Stored rails, read leniently: a field missing or malformed takes its default. */
export function readGuardRails(raw: unknown): GuardRails {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: GuardRails = { ...DEFAULT_GUARDRAILS };
  for (const key of Object.keys(DEFAULT_GUARDRAILS) as (keyof GuardRails)[]) {
    const one = guardRailsSchema.shape[key].safeParse(o[key]);
    if (one.success) out[key] = one.data;
  }
  return out;
}

/** What is wrong with a set of rails taken together, or null. */
export function guardRailsProblem(r: GuardRails): string | null {
  if (r.dailyLossAlert > r.dailyLossStop) return "The warning has to come before the hard stop.";
  return null;
}
