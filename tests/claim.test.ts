import { describe, expect, it } from "vitest";
import { findClaim, claimable, type VenueTrade } from "../shared/claim";
import { trade } from "./helpers";

/**
 * Is this the same trade, written twice?
 *
 * A venue sync brings the position as the venue saw it; the journal may hold
 * it already as a person typed it — entry rounded, time approximate, P&L off
 * by the fee. Written as two rows that is one trade counted twice. So the
 * hand-written one is looked for first and claimed, and these are the rules
 * for "the same", each of which has a number in it on purpose.
 */
const T0 = Date.parse("2026-09-15T10:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const venue: VenueTrade = {
  symbol: "BTC",
  direction: "long",
  entryTime: T0,
  entryPrice: 100_000,
  size: 0.5,
  status: "closed",
  exitTime: T0 + 3 * HOUR,
  closedPnl: 500,
};

/** A hand-logged copy of it: the entry a bit rounded, logged ten minutes late. */
const manual = () =>
  trade({
    id: 7,
    symbol: "BTC",
    direction: "long",
    size: 0.5,
    entryPrice: 100_050,
    entryTime: iso(T0 + 10 * 60_000),
    exitPrice: 101_000,
    exitTime: iso(T0 + 3 * HOUR),
    status: "closed",
    account: "Binance Futures",
  });

describe("what counts as the same trade", () => {
  it("claims the hand-logged copy on symbol, direction, time and price", () => {
    expect(findClaim(venue, [manual()])?.id).toBe(7);
  });

  it("never claims a trade a venue already wrote", () => {
    // That one is found by its id, or it is a different trade.
    expect(findClaim(venue, [manual(), { ...manual(), externalId: "hl:BTC:1" }])?.id).toBe(7);
    expect(findClaim(venue, [{ ...manual(), externalId: "binance:BTC:9" }])).toBeNull();
  });

  it("insists on the direction, whatever else agrees", () => {
    expect(findClaim(venue, [{ ...manual(), direction: "short" }])).toBeNull();
  });

  it("insists on the symbol, through the caller's spelling of it", () => {
    const strip = (s: string) => s.toUpperCase().replace(/USDT$/, "");
    const asPair = { ...venue, symbol: "BTCUSDT" };
    expect(findClaim(asPair, [manual()])).toBeNull();
    expect(findClaim(asPair, [manual()], strip)?.id).toBe(7);
    expect(findClaim(asPair, [{ ...manual(), symbol: "ETH" }], strip)).toBeNull();
  });

  it("allows two hours between the fill and the log, and not three", () => {
    expect(findClaim(venue, [{ ...manual(), entryTime: iso(T0 + 2 * HOUR) }])?.id).toBe(7);
    expect(findClaim(venue, [{ ...manual(), entryTime: iso(T0 - 2 * HOUR) }])?.id).toBe(7);
    expect(findClaim(venue, [{ ...manual(), entryTime: iso(T0 + 3 * HOUR) }])).toBeNull();
  });

  it("will not merge on time alone", () => {
    /*
     * Same coin, same hour, same way — and the entry a percent and a half
     * off, the size doubled, the P&L nowhere near. That is a coincidence,
     * or two trades, and the journal does not merge on either.
     */
    const far = { ...manual(), entryPrice: 101_600, size: 1, exitPrice: 99_000 };
    expect(claimable(venue, far, (s) => s)).toBe(false);
  });

  it("takes any one figure agreeing: price, size, or P&L", () => {
    // Price off by two percent, but the size is exact.
    expect(findClaim(venue, [{ ...manual(), entryPrice: 102_000 }])?.id).toBe(7);
    // Price and size both off, but the P&L the person wrote matches.
    const pnlOnly = { ...manual(), entryPrice: 102_000, size: 0.6, exitPrice: 102_000 + 500 / 0.6 };
    expect(findClaim(venue, [pnlOnly])?.id).toBe(7);
  });

  it("reads a quote-sized trade in base units before comparing size", () => {
    // 51,000 USD at 102,000 is half a coin — the price itself is two percent
    // off, so size is the only figure that can carry the match.
    const quoted = { ...manual(), sizeUnit: "quote" as const, size: 51_000, entryPrice: 102_000 };
    expect(findClaim(venue, [quoted])?.id).toBe(7);
  });

  it("is kind about P&L on small trades", () => {
    // Five percent of eight dollars is forty cents; a dollar of fees is not a
    // different trade. The absolute allowance is for exactly this.
    const small = { ...venue, closedPnl: 8 };
    const logged = { ...manual(), entryPrice: 102_000, size: 0.3, exitPrice: 102_000 + 7 / 0.3 };
    expect(findClaim(small, [logged])?.id).toBe(7);
  });

  it("claims an entry whose exit was never logged", () => {
    // The common case: logged on the way in, forgotten on the way out. The
    // sync fills the exit in.
    const stillOpen = { ...manual(), status: "open" as const, exitPrice: null, exitTime: null };
    expect(findClaim(venue, [stillOpen])?.id).toBe(7);
  });

  it("does not claim a trade the person already closed for one the venue says is open", () => {
    // That is not the same trade; that is the next one on the same coin.
    const venueOpen: VenueTrade = { ...venue, status: "open", exitTime: null, closedPnl: 0 };
    expect(findClaim(venueOpen, [manual()])).toBeNull();
    const stillOpen = { ...manual(), status: "open" as const, exitPrice: null, exitTime: null };
    expect(findClaim(venueOpen, [stillOpen])?.id).toBe(7);
  });

  it("leaves orders that never filled, and setups never taken, alone", () => {
    expect(findClaim(venue, [{ ...manual(), status: "pending" }])).toBeNull();
    expect(findClaim(venue, [{ ...manual(), status: "cancelled", cancelReason: "never_placed" }])).toBeNull();
  });

  it("picks the nearest entry when more than one qualifies", () => {
    const a = { ...manual(), id: 1, entryTime: iso(T0 + 90 * 60_000) };
    const b = { ...manual(), id: 2, entryTime: iso(T0 + 5 * 60_000) };
    const c = { ...manual(), id: 3, entryTime: iso(T0 - 40 * 60_000) };
    expect(findClaim(venue, [a, b, c])?.id).toBe(2);
  });
});
