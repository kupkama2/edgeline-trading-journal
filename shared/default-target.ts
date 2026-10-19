/**
 * A target of 1R when none was given.
 *
 * A trade with a stop and no target used to be a trade the journal could
 * not do much with: a resting order showed "needs stop and target" instead
 * of what it risked and could not be marked filled, and every R:R beside it
 * was blank. A stop is the part that cannot be guessed — it is the
 * denominator of every R. A target can be: one risk-width the other side of
 * the entry is the plainest plan there is, and it is what an order with
 * only a stop on it implicitly aims at.
 *
 * So it is filled in, and marked: `targetSource: "default"`. The mark
 * matters in two directions. Typing a real target replaces the default and
 * clears the mark; moving the stop or the entry moves a default target with
 * them. And the default is NOT a plan anyone made, so the plan's verdict —
 * did the untouched trade reach its target or its stop first — is never
 * settled against it; see server/outcomes.ts.
 */

export interface TargetInputs {
  status?: string | null;
  direction?: string | null;
  entryPrice?: number | null;
  initialStop?: number | null;
  initialTarget?: number | null;
  scalp?: boolean | null;
}

/** Decimals a price is written to, for a default that does not look computed. */
const decimals = (n: number) => {
  const s = String(n);
  if (s.includes("e-")) return Number(s.split("e-")[1]) + 2;
  return (s.split(".")[1] ?? "").length;
};

/** 1R beyond the entry, on the profit side, or null when it cannot be said. */
export function oneRTarget(t: TargetInputs): number | null {
  if (t.entryPrice == null || t.initialStop == null) return null;
  const risk = t.entryPrice - t.initialStop;
  if (!Number.isFinite(risk) || risk === 0) return null;
  const short = t.direction === "short";
  // A stop on the wrong side has no "profit side" to mirror it onto.
  if (short ? risk > 0 : risk < 0) return null;
  const target = t.entryPrice + (short ? -Math.abs(risk) : Math.abs(risk));
  if (!(target > 0)) return null;
  const dp = Math.min(10, Math.max(decimals(t.entryPrice), decimals(t.initialStop)));
  return Number(target.toFixed(dp));
}

/** Whether a trade in this state gets a default target. */
export const wantsDefaultTarget = (t: TargetInputs) =>
  t.status !== "cancelled" && !t.scalp && t.initialStop != null && t.initialTarget == null;

/**
 * The target fields a write should carry, given the row as it will be.
 *
 * `merged` is the trade after the write; `patch` is what the write said.
 * A target the write sets is the trader's. A default already on the row is
 * kept in step with the entry and stop.
 */
export function targetFields(
  merged: TargetInputs & { targetSource?: string | null },
  patch: Record<string, unknown> = merged as Record<string, unknown>,
): { initialTarget?: number | null; targetSource?: string | null } {
  if ("initialTarget" in patch && patch.initialTarget != null) return { targetSource: null };
  const isDefault = merged.targetSource === "default";
  if (isDefault || wantsDefaultTarget(merged)) {
    const target = oneRTarget(merged);
    if (target != null) return { initialTarget: target, targetSource: "default" };
    // Nothing to mirror any more (the stop was cleared): take the default back.
    if (isDefault) return { initialTarget: null, targetSource: null };
  }
  return {};
}
