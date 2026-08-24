import { describe, expect, it } from "vitest";
import {
  AFTERMATH_HORIZON_MS,
  SEED_CATALOGUE,
  collapseToInstrument,
  scanWindow,
  binanceSymbolForTrade,
  firstTouch,
  matchBinanceSymbol,
  pathExtremes,
  type BinanceSymbol,
  type Candle,
} from "../shared/binance";

/** A bar, written the way a chart reads: open, high, low, close. */
const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c });

/** Long from 100, stop 90, target 130. */
const plan = { direction: "long", stop: 90, target: 130 };
const short = { direction: "short", stop: 110, target: 70 };

describe("which level price reached first", () => {
  it("finds the target when the move went straight there", () => {
    const out = firstTouch([bar(1, 100, 110, 99, 108), bar(2, 108, 131, 107, 130)], plan);
    expect(out).toEqual({ verdict: "target_first", at: 2 });
  });

  it("finds the stop when it went the other way", () => {
    const out = firstTouch([bar(1, 100, 102, 95, 96), bar(2, 96, 97, 89, 90)], plan);
    expect(out).toEqual({ verdict: "stop_first", at: 2 });
  });

  it("reads WICKS, not closes", () => {
    // A bar that dipped to the stop and closed back at 105 is a stopped-out
    // trade. Scanning closes would report that trades routinely survive levels
    // they were taken out at — the single most dangerous way to get this wrong.
    const out = firstTouch([bar(1, 100, 106, 89.5, 105)], plan);
    expect(out.verdict).toBe("stop_first");
  });

  it("counts price trading exactly AT the level", () => {
    expect(firstTouch([bar(1, 100, 130, 99, 129)], plan).verdict).toBe("target_first");
    expect(firstTouch([bar(1, 100, 101, 90, 95)], plan).verdict).toBe("stop_first");
  });

  it("needs no special case for a gap through the level", () => {
    // A bar that OPENS beyond the stop still has the stop inside its range.
    expect(firstTouch([bar(1, 80, 82, 78, 81)], plan).verdict).toBe("stop_first");
  });

  it("refuses to guess when one bar touched both", () => {
    // The order inside the bar is unknowable at this resolution. Picking one
    // would write a confident wrong answer into the field that potentialR and
    // managementDeltaR are built from — worse than leaving it blank, because a
    // blank is visibly missing and a wrong answer is not.
    const out = firstTouch([bar(7, 100, 131, 89, 120)], plan);
    expect(out).toEqual({ verdict: "ambiguous", at: 7 });
  });

  it("says pending while neither has happened", () => {
    const out = firstTouch([bar(1, 100, 112, 95, 108), bar(2, 108, 120, 101, 118)], plan);
    expect(out).toEqual({ verdict: "pending" });
  });

  it("is pending on an empty range rather than inventing a verdict", () => {
    expect(firstTouch([], plan)).toEqual({ verdict: "pending" });
  });

  it("takes the FIRST touch, not the last", () => {
    // Stopped on bar 2; that the target printed later is exactly the fact this
    // is meant to distinguish from "it would have worked".
    const out = firstTouch(
      [bar(1, 100, 105, 96, 97), bar(2, 97, 99, 88, 92), bar(3, 92, 140, 91, 139)],
      plan,
    );
    expect(out).toEqual({ verdict: "stop_first", at: 2 });
  });

  it("flips both comparisons for a short", () => {
    // Short from 100: the target is BELOW and the stop ABOVE, so the tests
    // that mean "hit" are the other way round on both.
    expect(firstTouch([bar(1, 100, 104, 69, 72)], short).verdict).toBe("target_first");
    expect(firstTouch([bar(1, 100, 111, 98, 109)], short).verdict).toBe("stop_first");
    expect(firstTouch([bar(1, 100, 105, 95, 97)], short).verdict).toBe("pending");
  });

  it("declines when the plan has no levels to reach", () => {
    expect(firstTouch([bar(1, 1, 999, 0, 5)], { ...plan, stop: null }).verdict).toBe("pending");
    expect(firstTouch([bar(1, 1, 999, 0, 5)], { ...plan, target: null }).verdict).toBe("pending");
  });
});

/* --------------------------------------------------------------------- */

const spot = (symbol: string, baseAsset: string, quoteAsset: string, status = "TRADING") =>
  ({ symbol, baseAsset, quoteAsset, status, market: "spot" as const });
const perp = (symbol: string, baseAsset: string, quoteAsset: string, status = "TRADING") =>
  ({ symbol, baseAsset, quoteAsset, status, market: "futures" as const });

const cat: BinanceSymbol[] = [
  perp("BTCUSDT", "BTC", "USDT"),
  spot("BTCUSDT", "BTC", "USDT"),
  spot("BTCUSDC", "BTC", "USDC"),
  spot("ETHBTC", "ETH", "BTC"),
  spot("ETHUSDC", "ETH", "USDC"),
  perp("HYPEUSDT", "HYPE", "USDT"),
  spot("OLDUSDT", "OLD", "USDT", "BREAK"),
  spot("ONLYBTC", "ONLY", "BTC"),
  spot("LTCUSDT", "LTC", "USDT"),
  perp("LTCUSDT", "LTC", "USDT"),
  spot("WBTCUSDT", "WBTC", "USDT"),
  spot("WUSDT", "W", "USDT"),
];

describe("matching a journal symbol to a Binance pair", () => {
  it("takes a pair typed straight in, from the futures book", () => {
    expect(matchBinanceSymbol("BTCUSDT", cat)).toEqual({ symbol: "BTCUSDT", market: "futures" });
    expect(matchBinanceSymbol(" btcusdt ", cat)).toEqual({ symbol: "BTCUSDT", market: "futures" });
  });

  it("prefers the PERP over the spot pair of the same name", () => {
    // They share a name and not a price: basis and funding separate them, and
    // a liquidation cascade wicks the perp through levels spot never prints.
    // That wick is what actually takes a stop.
    expect(matchBinanceSymbol("LTC", cat)!.market).toBe("futures");
    expect(matchBinanceSymbol("LTCUSDT", cat)!.market).toBe("futures");
  });

  it("resolves a bare ticker to its best-quoted pair", () => {
    expect(matchBinanceSymbol("HYPE", cat)).toEqual({ symbol: "HYPEUSDT", market: "futures" });
    expect(matchBinanceSymbol("BTC", cat)!.symbol).toBe("BTCUSDT"); // USDT over USDC
  });

  it("falls back to spot when a coin has no perp", () => {
    expect(matchBinanceSymbol("ETH", cat)).toEqual({ symbol: "ETHUSDC", market: "spot" });
  });

  it("refuses a base that only trades against BTC", () => {
    // A level in dollars is not a level in satoshis. Resolving a trade against
    // the wrong denominator is the confident wrong answer, dressed as data.
    expect(matchBinanceSymbol("ONLY", cat)).toBeNull();
  });

  it("ignores pairs that are not trading", () => {
    expect(matchBinanceSymbol("OLD", cat)).toBeNull();
    expect(matchBinanceSymbol("OLDUSDT", cat)).toBeNull();
  });

  it("says null for anything it does not recognise", () => {
    expect(matchBinanceSymbol("NOTACOIN", cat)).toBeNull();
    expect(matchBinanceSymbol("", cat)).toBeNull();
    expect(matchBinanceSymbol(null, cat)).toBeNull();
  });
});

/**
 * One coin, however the string was copied.
 *
 * "LTC/USDT" off a screenshot, "LTCUSDT.P" off a TradingView title, "LTCUSDT"
 * off the exchange and "LTC" typed by hand are one instrument. Without this
 * they are four, each with its own win rate and its own row in every
 * breakdown, and none of them is the truth.
 */
describe("collapsing a pair to the instrument", () => {
  it("takes the base off every way a pair gets written", () => {
    for (const written of ["LTC/USDT", "LTCUSDT", "LTCUSDT.P", "LTC/USDT.P", "ltc-usdt", "LTC : USDT"]) {
      expect(collapseToInstrument(written, cat)).toBe("LTC");
    }
  });

  it("reads a quote Binance does not even list, when the coin is real", () => {
    // "LTCUSD" is not a pair on Binance — it is how TradingView and half the
    // industry write it. The journal still has to know it means litecoin.
    expect(collapseToInstrument("LTCUSD", cat)).toBe("LTC");
    expect(collapseToInstrument("LTC/USD", cat)).toBe("LTC");
    expect(collapseToInstrument("BTCUSD", cat)).toBe("BTC");
  });

  it("peels the longest quote, not the first one that fits", () => {
    // USD is a suffix of USDT. Try the short one first and LTCUSDT collapses
    // to "LTCUSD" — a coin that does not exist.
    expect(collapseToInstrument("LTCUSDT", cat)).toBe("LTC");
  });

  it("will not peel a suffix off a string that leaves nonsense behind", () => {
    // The guard on the fallback: the remainder has to be a coin the catalogue
    // knows. "ZZZUSD" leaves "ZZZ", which is nothing, so the string stands.
    expect(collapseToInstrument("ZZZUSD", cat)).toBe("ZZZUSD");
  });

  it("leaves a bare ticker alone", () => {
    expect(collapseToInstrument("LTC", cat)).toBe("LTC");
    expect(collapseToInstrument(" hype ", cat)).toBe("HYPE");
  });

  it("does NOT cut a suffix off a coin whose name ends in one", () => {
    // The trap a quote-suffix list walks straight into: strip "BTC" from
    // "WBTC" and Wrapped Bitcoin starts logging as "W" — which is a real and
    // different coin, sitting right there in the catalogue.
    expect(collapseToInstrument("WBTC", cat)).toBe("WBTC");
    expect(collapseToInstrument("WBTCUSDT", cat)).toBe("WBTC");
  });

  it("trusts an explicit separator even for a coin it has never heard of", () => {
    // Writing "FOO/USDT" is a human saying which half is the instrument, and
    // that beats not recognising the ticker.
    expect(collapseToInstrument("FOO/USDT", cat)).toBe("FOO");
  });

  it("leaves an unrecognised bare string entirely alone", () => {
    // Not knowing a symbol is not a licence to start cutting letters off it.
    expect(collapseToInstrument("NOTACOIN", cat)).toBe("NOTACOIN");
    expect(collapseToInstrument("MNQU6", cat)).toBe("MNQU6");
  });

  it("has nothing to say about nothing", () => {
    expect(collapseToInstrument("", cat)).toBe("");
    expect(collapseToInstrument(null, cat)).toBe("");
  });
});

describe("matching a whole trade", () => {
  it("resolves an ordinary crypto trade", () => {
    expect(binanceSymbolForTrade({ symbol: "HYPE", contract: null }, cat)).toEqual({
      symbol: "HYPEUSDT",
      market: "futures",
    });
  });

  it("never touches an index-futures trade", () => {
    // Nothing stops a token called NQ from listing tomorrow, and resolving a
    // Nasdaq future against a memecoin's candles would be catastrophic and
    // silent. A trade carrying a contract is not matched at all.
    expect(binanceSymbolForTrade({ symbol: "BTC", contract: "MBTZ6" }, cat)).toBeNull();
    expect(binanceSymbolForTrade({ symbol: "BTC", contract: "   " }, cat)!.symbol).toBe("BTCUSDT");
  });
});

describe("how finely to scan a window", () => {
  it("gets coarser as the window gets longer", async () => {
    const { intervalFor } = await import("../server/binance");
    const h = 3_600_000;
    expect(intervalFor(6 * h)).toBe("1m");
    expect(intervalFor(48 * h)).toBe("5m");
    expect(intervalFor(24 * 7 * h)).toBe("1h");
    expect(intervalFor(24 * 90 * h)).toBe("4h");
  });

  it("never returns a bar so wide that most trades come back ambiguous", async () => {
    // The trade-off this function IS: a wider bar is fewer requests and more
    // bars that swallow both levels at once, and an ambiguous verdict is a
    // trade left parked. Daily bars would do that to almost everything.
    const { intervalFor } = await import("../server/binance");
    for (const days of [1, 7, 30, 365, 3650]) {
      expect(intervalFor(days * 24 * 3_600_000)).not.toBe("1d");
    }
  });
});

/**
 * The window the untouched-plan question is asked over.
 *
 * This shipped wrong for one review cycle: it scanned from the EXIT, and the
 * bug is invisible on every well-behaved trade. A plan is untouched from the
 * moment of ENTRY, and the trades where that distinction bites are exactly
 * the ones worth asking about — hold through your own stop and close later at
 * a better price, and an exit-onward scan never sees the stop being hit and
 * can come back "target_first" on a trade the original plan lost.
 */
describe("the window a trade is judged over", () => {
  it("starts at the entry, not the exit", () => {
    const w = scanWindow({
      entryTime: "2026-08-01T10:00:00.000Z",
      exitTime: "2026-08-03T10:00:00.000Z",
    })!;
    expect(new Date(w.from).toISOString()).toBe("2026-08-01T10:00:00.000Z");
    expect(w.to).toBeGreaterThan(new Date("2026-08-03T10:00:00.000Z").getTime());
  });

  it("covers a trade held through its own stop", async () => {
    // The concrete case. Entered at 100 with a stop at 90; price wicked to 88
    // WHILE the trade was on, then recovered and tagged 130 after the exit.
    // Judged from the entry this is stop_first, which is the truth about the
    // plan. Judged from the exit it reads target_first — the flattering
    // answer, and a false one.
    const held = [bar(1, 100, 101, 88, 95)];
    const after = [bar(2, 95, 131, 94, 130)];
    expect(firstTouch([...held, ...after], plan).verdict).toBe("stop_first");
    expect(firstTouch(after, plan).verdict).toBe("target_first");
  });

  it("declines a window that has not opened yet", () => {
    expect(scanWindow({ entryTime: "2099-01-01T00:00:00.000Z" })).toBeNull();
    expect(scanWindow({ entryTime: "not a date" })).toBeNull();
  });
});

/**
 * Reading the path off the candles.
 *
 * Four numbers, four windows, and the windows are the substance. MAE and MFE
 * that leak one bar of aftermath are the original bug this journal was built
 * around: an exit that was too EARLY then reads as too LATE, because the run
 * you were not in gets recorded as a move you gave back.
 */
describe("the path, read off the candles", () => {
  // Long from 100, stop 90. Held over bars 1-3, out after bar 3.
  const path = { direction: "long", entryMs: 1, exitMs: 3, stop: 90 };
  const bars = [
    bar(1, 100, 106, 97, 104), // in trade
    bar(2, 104, 118, 103, 117), // in trade — the best while held
    bar(3, 117, 119, 94, 96), // in trade — the worst while held
    bar(4, 96, 140, 95, 138), // after the exit — ran without you
    bar(5, 138, 141, 88, 89), // after — breaks the original stop
    bar(6, 89, 92, 70, 72), // after — well past it
  ];

  it("keeps MAE and MFE strictly inside the hold", () => {
    const p = pathExtremes(bars, path);
    expect(p.mfe).toBe(119); // bar 3's high, NOT bar 4's 140
    expect(p.mae).toBe(94); // bar 3's low, NOT bar 6's 70
  });

  it("stops the favourable aftermath where the thesis died", () => {
    // 140 on bar 4 counts. Bar 5 breaks the original stop, so a position left
    // alone would not have been there for anything after it — and without
    // that bound "it would have gone higher" is eventually true of every
    // trade ever taken.
    expect(pathExtremes(bars, path).postExitPeak).toBe(140);
  });

  it("does NOT stop the adverse aftermath at the stop", () => {
    // How far past the stop it went IS the measurement — it is what the stop
    // saved you. Bounding this one at the stop would answer that question
    // with "nothing" every single time.
    expect(pathExtremes(bars, path).postExitAdverse).toBe(70);
  });

  it("stops attributing the adverse move after a month", () => {
    const day = 86_400_000;
    const late = [bar(1, 100, 100, 100, 100), bar(2, 100, 100, 100, 100),
      { t: 2 + AFTERMATH_HORIZON_MS + day, o: 50, h: 50, l: 20, c: 25 }];
    const p = pathExtremes(late, { direction: "long", entryMs: 1, exitMs: 2, stop: 90 });
    // The crash is a month and a day later — that is the next cycle, not the
    // aftermath of this trade.
    expect(p.postExitAdverse).toBeNull();
  });

  it("flips every direction for a short", () => {
    const shortBars = [
      bar(1, 100, 103, 96, 97), // in trade
      bar(2, 97, 98, 82, 84), // in trade — best (lowest) while held
      bar(3, 84, 88, 83, 86), // after the exit is bar 2
    ];
    const p = pathExtremes(shortBars, { direction: "short", entryMs: 1, exitMs: 2, stop: 110 });
    expect(p.mfe).toBe(82); // best for a short is the LOW
    expect(p.mae).toBe(103); // worst is the HIGH
    expect(p.postExitPeak).toBe(83);
  });

  it("is null per leg rather than zero when a window is empty", () => {
    // An unmeasured leg is not a zero leg, and everything downstream depends
    // on being able to tell the two apart.
    const open = pathExtremes([bar(1, 100, 106, 97, 104)], { ...path, exitMs: null });
    expect(open.mfe).toBe(106);
    expect(open.postExitPeak).toBeNull();
    expect(open.postExitAdverse).toBeNull();
    expect(pathExtremes([], path)).toEqual({ mae: null, mfe: null, postExitPeak: null, postExitAdverse: null });
  });
});


/**
 * The written-down list, which is what stands in when the venue will not talk.
 *
 * It only has to do the two jobs that are not market-data questions: know that
 * "ZROUSDT" means ZRO, and offer real coins to pick from. Prices genuinely do
 * need the venue and are allowed to fail loudly.
 */
describe("the fallback catalogue", () => {
  it("is a real catalogue the matcher can use", () => {
    expect(SEED_CATALOGUE.length).toBeGreaterThan(150);
    expect(matchBinanceSymbol("ZRO", SEED_CATALOGUE)).toEqual({
      symbol: "ZROUSDT",
      market: "futures",
    });
  });

  it("collapses the pair spellings without a network", () => {
    // The reported symptom, offline: a trade filed as ZROUSDT stayed ZROUSDT
    // because the catalogue was empty, so it sat in the breakdowns as its own
    // instrument next to ZRO.
    for (const written of ["ZROUSDT", "ZRO/USDT", "ZROUSDT.P", "ZROUSD"]) {
      expect(collapseToInstrument(written, SEED_CATALOGUE)).toBe("ZRO");
    }
  });

  it("carries the coins actually traded here", () => {
    for (const coin of ["BTC", "ETH", "SOL", "XRP", "LTC", "ZEC", "ZK", "HYPE", "ZRO"]) {
      expect(matchBinanceSymbol(coin, SEED_CATALOGUE)?.symbol).toBe(`${coin}USDT`);
    }
  });

  it("names every asset once, and every one as a USDT perp", () => {
    // A duplicate would be harmless but is a sign the list was edited
    // carelessly, and this list is edited by hand.
    const names = SEED_CATALOGUE.map((s) => s.baseAsset);
    expect(new Set(names).size).toBe(names.length);
    expect(SEED_CATALOGUE.every((s) => s.quoteAsset === "USDT")).toBe(true);
    expect(SEED_CATALOGUE.every((s) => s.market === "futures")).toBe(true);
    expect(SEED_CATALOGUE.every((s) => s.symbol === `${s.baseAsset}USDT`)).toBe(true);
  });

  it("still leaves an unknown ticker alone", () => {
    // The list is written from knowledge and goes stale. A coin listed after
    // it was written is simply not folded — which is what an unrecognised
    // symbol has always done, and nothing worse.
    expect(collapseToInstrument("NEWCOINUSDT", SEED_CATALOGUE)).toBe("NEWCOINUSDT");
    expect(matchBinanceSymbol("NEWCOIN", SEED_CATALOGUE)).toBeNull();
  });
});
