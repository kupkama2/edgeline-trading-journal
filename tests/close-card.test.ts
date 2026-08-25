import { describe, expect, it } from "vitest";
import {
  closeFromCard,
  normalizeCloseCard,
  readHeadline,
  saysAnythingAboutClose,
  toNaiveLocal,
} from "../shared/close-card";

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

/** Layout B: one line of trade history, columns in a separate screenshot. */
const historyRow = {
  symbol: "CASHCAT",
  direction: "Close Long",
  exitTime: "8/25/2026 - 10:05:44",
  exitPrice: "0.21051",
  size: "4,041 CASHCAT",
  fee: "0.37 USDC",
  feeCurrency: "USDC",
  realizedPnl: "352.58 USDC",
  pnlCurrency: "USDC",
  isClosed: true,
  fills: [],
};

/** Layout C: one order, sliced by the venue into prints at the same instant. */
const slicedOrder = {
  symbol: "ZROUSDT",
  direction: "Close Long",
  exitPrice: "1.0625305",
  exitTime: "2026-08-25T10:56:58",
  size: "655.48",
  realizedPnl: "115.37912",
  pnlCurrency: "BNFCR",
  fee: "0.32773753",
  feeCurrency: "BNFCR",
  isClosed: true,
  fills: [
    { time: "2026-08-25T10:56:58", price: "1.0626000", size: "100.00", fee: "0.04999533", pnl: "17.60611" },
    { time: "2026-08-25T10:56:58", price: "1.0626000", size: "100.00", fee: "0.04999533", pnl: "17.60611" },
    { time: "2026-08-25T10:56:58", price: "1.0625000", size: "8.50", fee: "0.00425", pnl: "1.496" },
    { time: "2026-08-25T10:56:58", price: "1.0625000", size: "108.91", fee: "0.05445312", pnl: "19.1675" },
    { time: "2026-08-25T10:56:58", price: "1.0625000", size: "338.09", fee: "0.16904375", pnl: "59.5034" },
  ],
};

describe("the shapes an exchange prints a close in", () => {
  it("reads a history row, columns and all", () => {
    const c = normalizeCloseCard(historyRow);
    expect(c.symbol).toBe("CASHCAT");
    // "Close Long" is the side of the POSITION, not of the order.
    expect(c.direction).toBe("long");
    expect(c.exitPrice).toBe(0.21051);
    expect(c.size).toBe(4041);
    expect(c.fee).toBe(0.37);
    expect(c.realizedPnl).toBe(352.58);
    // "8/25/2026 - 10:05:44" — a dash between the date and the time, single
    // digit month, and no timezone to shift it by.
    expect(c.exitTime).toBe("2026-08-25T10:05");
  });

  it("treats one sliced order as one exit, not five partials", () => {
    /*
     * Five prints at the same second are the venue filling a market order,
     * and logging them as scaling would invent a plan the trader never had.
     * The exchange's own average is what goes on the trade.
     */
    const v = closeFromCard(normalizeCloseCard(slicedOrder), {
      symbol: "ZRO",
      direction: "long",
      entryPrice: 1.0,
      size: 655,
    });
    expect(v.fillsSeen).toBe(5);
    expect(v.partials).toEqual([]);
    expect(v.apply.exitPrice).toBe(1.0625305);
    expect(v.apply.fees).toBeCloseTo(0.32773753);
  });

  it("treats fills spread over time as the scaling they are", () => {
    // The trader's own words for why this matters: taking partials far too
    // early is a different mistake from one badly-timed exit, and a single
    // averaged price hides which one happened.
    const card = normalizeCloseCard({
      ...slicedOrder,
      // No summary line in this shot — just the fill table.
      exitPrice: null,
      exitTime: null,
      fills: [
        { time: "2026-08-25T10:05:00", price: "1.10", size: "200" },
        { time: "2026-08-25T12:30:00", price: "1.20", size: "200" },
        { time: "2026-08-26T09:00:00", price: "1.40", size: "200" },
      ],
    });
    const v = closeFromCard(card, { symbol: "ZRO", direction: "long", entryPrice: 1, size: 600 });
    expect(v.partials).toHaveLength(3);
    // No stated average, so one is computed — and the exit time is the last
    // print, which is when the position actually finished.
    expect(v.apply.exitPrice).toBeCloseTo((1.1 + 1.2 + 1.4) / 3);
    expect(v.apply.exitTime).toBe("2026-08-26T09:00");
  });

  it("checks whether the fills add up to the position", () => {
    /*
     * The check is what makes the offer trustworthy. These five sum to 655.5
     * against a 655-unit position — a complete account of how it came off, so
     * turning one averaged exit into five loses nothing.
     */
    const v = closeFromCard(normalizeCloseCard(slicedOrder), {
      symbol: "ZRO",
      direction: "long",
      entryPrice: 1.0,
      size: 655,
    });
    expect(v.fills).toHaveLength(5);
    expect(v.sizes?.total).toBeCloseTo(655.5);
    expect(v.sizes?.matchesTrade).toBe(true);
  });

  it("says so when the table is only half the story", () => {
    // Replacing one exit with a table that covers a third of the position
    // would quietly shrink the trade, so the mismatch is named.
    const v = closeFromCard(normalizeCloseCard(slicedOrder), {
      symbol: "ZRO",
      direction: "long",
      entryPrice: 1.0,
      size: 2000,
    });
    expect(v.sizes?.matchesTrade).toBe(false);
  });

  it("does not call a unit difference a discrepancy", () => {
    /*
     * Binance prints fill rows in USDT; the same position may be logged in
     * coins. 655 USDT of a coin at ~1.06 is 617 coins — the same position
     * twice, and warning about it would be warning about agreement.
     */
    const v = closeFromCard(normalizeCloseCard(slicedOrder), {
      symbol: "ZRO",
      direction: "long",
      entryPrice: 1.0,
      size: 617,
    });
    expect(v.sizes?.matchesTrade).toBe(true);
    expect(v.sizes?.unitNote).toMatch(/quote/);
  });

  it("fills in a fee only where there is none", () => {
    const base = { symbol: "ZRO", direction: "long", entryPrice: 1.0, size: 655 };
    const card = normalizeCloseCard(slicedOrder);
    expect(closeFromCard(card, { ...base, fees: null }).apply.fees).toBeCloseTo(0.32773753);
    // Already typed, and materially different: reported, never overwritten.
    // The trader may have counted both sides where the card shows one.
    const typed = closeFromCard(card, { ...base, fees: 0.9 });
    expect(typed.apply.fees).toBeUndefined();
    expect(typed.warnings.join(" ")).toMatch(/fee/i);
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

/**
 * The same order, screenshotted without its summary line — just the fill
 * table under its headers. This is what actually gets pasted: the summary sits
 * above the fold, or the trader crops to the rows because the rows are the
 * interesting part. Everything the card would have stated has to come from the
 * table itself.
 */
const bareFillTable = {
  symbol: null,
  direction: null,
  exitPrice: null,
  exitTime: null,
  size: null,
  realizedPnl: null,
  fee: null,
  isClosed: true,
  fills: slicedOrder.fills,
};

describe("a fill table with no summary above it", () => {
  const read = () =>
    closeFromCard(normalizeCloseCard(bareFillTable), {
      symbol: "ZRO",
      direction: "long",
      entryPrice: 1.0,
      size: 655.5,
    });

  it("still closes the trade, at the size-weighted average", () => {
    const v = read();
    expect(v.usable).toBe(true);
    // 655.50 quote across five prints between 1.0625 and 1.0626.
    expect(v.apply.exitPrice).toBeCloseTo(1.0625305, 6);
    expect(v.apply.exitTime).toBe("2026-08-25T10:56");
  });

  it("recognises the rows as one sliced order rather than five decisions", () => {
    const v = read();
    expect(v.fillsSeen).toBe(5);
    expect(v.partials).toEqual([]);
    expect(readHeadline(normalizeCloseCard(bareFillTable), v)).toMatch(
      /5 fills, all at the same instant.*single exit/i,
    );
  });

  it("matches the table's quote total against a position kept in quote", () => {
    expect(read().sizes).toMatchObject({ matchesTrade: true });
  });

  it("adds the per-fill fees up itself", () => {
    // The total is only printed on the summary line that got cropped off, and
    // adding a column of numbers is the last thing to delegate to a model.
    expect(read().apply.fees).toBeCloseTo(0.32773753, 8);
  });

  it("does not invent precision the exchange never printed", () => {
    /*
     * A size-weighted mean of five prices lands on all seventeen digits a
     * float can hold. "1.0625305110602594" in the exit box is not a price
     * anyone recognises — it reads as the app having made the number up.
     */
    expect(String(read().apply.exitPrice)).toBe("1.06253051");
  });
});

describe("saying what the screenshot was", () => {
  it("calls scaling out what it is", () => {
    // The same five prints, spread over an afternoon. Five decisions, not one
    // order — and the only thing separating the two is the clock.
    const scaled = {
      ...bareFillTable,
      fills: slicedOrder.fills.map((f, i) => ({ ...f, time: `2026-08-25T1${i}:00:00` })),
    };
    const card = normalizeCloseCard(scaled);
    expect(readHeadline(card, closeFromCard(card, { symbol: "ZRO", direction: "long", entryPrice: 1, size: 655.5 })))
      .toMatch(/5 exits across 5 different times.*scaled out/i);
  });

  it("names a plain single close", () => {
    const card = normalizeCloseCard(binance);
    expect(readHeadline(card, closeFromCard(card, trade))).toBe("One exit.");
  });

  it("stays quiet about a screenshot that is not a close at all", () => {
    /*
     * The reason this matters: on a CLOSED trade, Ctrl-V is also how you
     * attach the outcome chart. A chart has none of these fields, and a panel
     * that argued with every chart you ever attached would make the gesture
     * worse than useless.
     */
    const chart = normalizeCloseCard({ symbol: "ZROUSDT", direction: "long", fills: [] });
    expect(saysAnythingAboutClose(chart)).toBe(false);
    expect(readHeadline(chart, closeFromCard(chart, { symbol: "ZRO", direction: "long", entryPrice: 1, size: 1 })))
      .toMatch(/nothing about an exit/i);
  });

  it("counts a fill table on its own as something to say", () => {
    expect(saysAnythingAboutClose(normalizeCloseCard(bareFillTable))).toBe(true);
  });
});
