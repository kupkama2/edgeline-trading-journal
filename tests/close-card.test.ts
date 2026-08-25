import { describe, expect, it } from "vitest";
import { closeFromCard, normalizeCloseCard, toNaiveLocal } from "../shared/close-card";

/**
 * Reading a broker's closed-position card onto a trade.
 *
 * The reading is the model's job. What may be WRITTEN from it is this file's,
 * and that is the part that can do damage: the model will occasionally hand
 * back a perfectly confident card for a screenshot of a different trade, and a
 * BTC close written onto an ETH position is not a mistake anyone spots a month
 * later.
 */

/** The card in the request that prompted this: a Binance futures close. */
const binance = {
  symbol: "BTCUSDT",
  direction: "Cross Short",
  exitPrice: "79,604.89",
  entryPrice: "79,210.67",
  exitTime: "08/25/2026 04:17:53",
  entryTime: "08/24/2026 17:43:27",
  size: "0.187",
  realizedPnl: "-86.4764 BNFCR",
  pnlCurrency: "BNFCR",
  roiPercent: "-87.57",
  leverage: "150x",
  isClosed: true,
};

const trade = {
  symbol: "BTC",
  direction: "short" as const,
  entryPrice: 79210.67,
  size: 0.187,
};

describe("reading the card", () => {
  it("takes the numbers as they are printed", () => {
    const c = normalizeCloseCard(binance);
    // Thousands separators, a currency suffix and an "x" on the leverage are
    // how exchanges print these; none of them are part of the number.
    expect(c.exitPrice).toBe(79604.89);
    expect(c.entryPrice).toBe(79210.67);
    expect(c.realizedPnl).toBe(-86.4764);
    expect(c.pnlCurrency).toBe("BNFCR");
    expect(c.leverage).toBe(150);
    expect(c.roiPercent).toBe(-87.57);
    expect(c.size).toBe(0.187);
  });

  it("reads the direction out of the margin mode", () => {
    // "Cross Short" and "Isolated Long" are the whole label; the word that
    // matters is the second one. Colour is not evidence and is not used.
    expect(normalizeCloseCard({ direction: "Cross Short" }).direction).toBe("short");
    expect(normalizeCloseCard({ direction: "Isolated Long" }).direction).toBe("long");
    expect(normalizeCloseCard({ direction: "" }).direction).toBeNull();
    expect(normalizeCloseCard({}).direction).toBeNull();
  });

  it("keeps the clock the card was printed on", () => {
    /*
     * The card shows the exchange's rendering of the trader's own clock, and
     * the journal stores naive local stamps throughout. Converting here would
     * move every pasted trade by the UTC offset and quietly file it in the
     * wrong session for the rest of its life.
     */
    expect(toNaiveLocal("08/25/2026 04:17:53")).toBe("2026-08-25T04:17");
    expect(toNaiveLocal("2026-08-25T04:17:53")).toBe("2026-08-25T04:17");
    expect(toNaiveLocal("2026-08-25 04:17")).toBe("2026-08-25T04:17");
    // A first component above twelve can only be a day, whatever the locale.
    expect(toNaiveLocal("25/08/2026 04:17:00")).toBe("2026-08-25T04:17");
    expect(toNaiveLocal("Lasting 10h 34m")).toBeNull();
    expect(toNaiveLocal(null)).toBeNull();
  });
});

describe("what may be written onto the trade", () => {
  it("applies the exit, which is the point of the exercise", () => {
    const v = closeFromCard(normalizeCloseCard(binance), trade);
    expect(v.usable).toBe(true);
    expect(v.apply.exitPrice).toBe(79604.89);
    expect(v.apply.exitTime).toBe("2026-08-25T04:17");
    expect(v.warnings).toEqual([]);
  });

  it("never uses the entry price as the exit", () => {
    // The two sit side by side on the card and are within a few tenths of a
    // percent of each other on a scalp — the one error here that would look
    // entirely plausible in the saved trade.
    const v = closeFromCard(normalizeCloseCard(binance), trade);
    expect(v.apply.exitPrice).not.toBe(79210.67);
  });

  it("refuses to write a card for another instrument", () => {
    const v = closeFromCard(normalizeCloseCard({ ...binance, symbol: "ETHUSDT" }), trade);
    expect(v.warnings.join(" ")).toMatch(/ETHUSDT.*BTC/);
  });

  it("accepts the pair written either way", () => {
    // The journal keeps BTC, the card prints BTCUSDT. Same instrument, and
    // warning about it would train you to ignore the warnings.
    expect(closeFromCard(normalizeCloseCard(binance), trade).warnings).toEqual([]);
    expect(
      closeFromCard(normalizeCloseCard({ ...binance, symbol: "BTC" }), trade).warnings,
    ).toEqual([]);
  });

  it("does not wave a card through on a shared first letter", () => {
    /*
     * W, S and T are all real coins, and a prefix match calls WIFUSDT a W
     * trade — exactly the tickers where a mix-up is easiest to make and
     * hardest to spot afterwards. The card's quote is stripped and the bases
     * are compared whole.
     */
    const wTrade = { ...trade, symbol: "W" };
    expect(
      closeFromCard(normalizeCloseCard({ ...binance, symbol: "WIFUSDT" }), wTrade).warnings.join(" "),
    ).toMatch(/WIFUSDT/);
    // And the same coin, quoted, still passes without a word.
    expect(
      closeFromCard(normalizeCloseCard({ ...binance, symbol: "WUSDT" }), wTrade).warnings,
    ).toEqual([]);
  });

  it("says so when the card is the other side of the market", () => {
    const v = closeFromCard(normalizeCloseCard({ ...binance, direction: "Cross Long" }), {
      ...trade,
    });
    expect(v.warnings.join(" ")).toMatch(/long.*short/);
  });

  it("reports a different entry rather than rewriting it", () => {
    /*
     * The exchange's average entry is probably better than what was typed —
     * and it is the denominator of every R this trade has ever contributed.
     * Changing it from a screenshot would restate history silently, so it is
     * shown and left alone.
     */
    const v = closeFromCard(normalizeCloseCard({ ...binance, entryPrice: "79,000.00" }), trade);
    expect(v.apply).not.toHaveProperty("entryPrice");
    expect(v.warnings.join(" ")).toMatch(/1R/);
  });

  it("stays quiet about an entry that only differs in rounding", () => {
    const v = closeFromCard(normalizeCloseCard({ ...binance, entryPrice: "79,210.70" }), trade);
    expect(v.warnings).toEqual([]);
  });

  it("flags a size that does not match, and changes nothing", () => {
    // "Closed Vol" and "Max OI" sit next to each other and mean different
    // things on a position that was scaled out of.
    const v = closeFromCard(normalizeCloseCard({ ...binance, size: "0.5" }), trade);
    expect(v.apply).not.toHaveProperty("size");
    expect(v.warnings.join(" ")).toMatch(/0\.5/);
  });

  it("says when the card is of a position that has not closed", () => {
    const v = closeFromCard(normalizeCloseCard({ ...binance, isClosed: false }), trade);
    expect(v.warnings.join(" ")).toMatch(/still open/);
  });

  it("is unusable without an exit price", () => {
    // Nothing to close the trade with. Better to say so than to write a time
    // onto a trade with no exit and leave it looking half-finished.
    const v = closeFromCard(normalizeCloseCard({ ...binance, exitPrice: null }), trade);
    expect(v.usable).toBe(false);
  });
});
