import type { TradeWithTags } from "../shared/schema";

/**
 * A closed trade with every field the metrics engine reads, overridable per
 * test. Defaults describe the simplest possible trade: 1 unit, point value 1,
 * entry 100, stop 90 — so 1R = 10 points = $10, and an exit at 120 is +2R.
 */
export function trade(over: Partial<TradeWithTags> = {}): TradeWithTags {
  return {
    id: 1,
    styleId: null,
    symbol: "TEST",
    direction: "long",
    size: 1,
    sizeUnit: "base",
    pointValue: 1,
    entryPrice: 100,
    initialStop: 90,
    initialTarget: 130,
    extraTargets: null,
    entryTime: "2026-08-03T09:30:00.000Z",
    exitPrice: 120,
    exitTime: "2026-08-03T10:00:00.000Z",
    status: "closed",
    exitReason: "target",
    cancelReason: null,
    wouldHaveHitTarget: null,
    mae: null,
    mfe: null,
    noManagementOutcome: null,
    setupScreenshot: null,
    outcomeScreenshot: null,
    notes: null,
    rationale: null,
    rationaleTags: null,
    playbook: null,
    account: null,
    fees: null,
    highlights: null,
    mistakeTagIds: [],
    imageCount: 0,
    fills: [],
    ...over,
  };
}

/** A local-clock timestamp, so hour/weekday bucketing is timezone-stable. */
export function localIso(
  y: number,
  mo: number,
  d: number,
  h = 9,
  mi = 30,
): string {
  return new Date(y, mo - 1, d, h, mi, 0).toISOString();
}
