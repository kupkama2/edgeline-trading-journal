import { describe, expect, it } from "vitest";
import {
  hlAsset,
  hlAssetFor,
  parseHyperliquidMeta,
  parsePerpDexs,
  splitHlAsset,
} from "../shared/hyperliquid";
import { describePair, pairCandidates, parsePricePair } from "../shared/price-pair";
import { pairForTradeAt } from "../server/candles";
import { trade } from "./helpers";

/**
 * Hyperliquid lists its coin perps in one universe and everything else —
 * equities, commodities — in builder-deployed books of their own. Two books
 * can list the same ticker, so the rule throughout is that an unqualified
 * ticker is not an asset, and an ambiguous one resolves to nothing at all
 * rather than to whichever sorted first.
 */
const meta = (names: string[]) => ({ universe: names.map((name) => ({ name, maxLeverage: 20 })) });

describe("the books the venue has", () => {
  it("skips the null first entry, which is the venue's own universe", () => {
    expect(parsePerpDexs([null, { name: "vntls" }, { name: "xyz" }])).toEqual(["vntls", "xyz"]);
  });

  it("is empty for anything not shaped like a list, so nothing extra is asked for", () => {
    for (const bad of [null, undefined, {}, "vntls", 7]) {
      expect(parsePerpDexs(bad as any)).toEqual([]);
    }
  });

  it("drops a name carrying a colon, which would make a qualified asset unsplittable", () => {
    expect(parsePerpDexs([null, { name: "a:b" }, { name: "ok" }])).toEqual(["ok"]);
  });

  it("does not repeat a book", () => {
    expect(parsePerpDexs([{ name: "v" }, { name: "v" }])).toEqual(["v"]);
  });
});

describe("a coin and the book it is in", () => {
  it("carries the dex onto every row of that book's universe", () => {
    const out = parseHyperliquidMeta(meta(["NVDA", "GOLD"]), "vntls");
    expect(out.map((p) => p.dex)).toEqual(["vntls", "vntls"]);
    expect(out.map(hlAsset)).toEqual(["vntls:NVDA", "vntls:GOLD"]);
  });

  it("leaves the main universe unqualified", () => {
    const out = parseHyperliquidMeta(meta(["BTC"]));
    expect(out[0].dex).toBeNull();
    expect(hlAsset(out[0])).toBe("BTC");
  });

  it("round-trips a qualified name", () => {
    expect(splitHlAsset("vntls:NVDA")).toEqual({ dex: "vntls", coin: "NVDA" });
    expect(splitHlAsset("BTC")).toEqual({ dex: null, coin: "BTC" });
  });

  it("takes the book's own prefix off a name that already carries it", () => {
    /*
     * The bug that made ten builder books yield nothing at all, silently.
     * A book may answer with bare coins or with its own name on the front,
     * and the guard against ambiguous colons dropped every row of the second
     * kind — no throw, no empty response, nothing to see.
     */
    const out = parseHyperliquidMeta(meta(["xyz:GOLD", "xyz:WTIOIL"]), "xyz");
    expect(out.map((p) => p.name)).toEqual(["GOLD", "WTIOIL"]);
    expect(out.map(hlAsset)).toEqual(["xyz:GOLD", "xyz:WTIOIL"]);
  });

  it("takes it off whatever case the venue wrote it in", () => {
    expect(parseHyperliquidMeta(meta(["XYZ:GOLD"]), "xyz")[0].name).toBe("GOLD");
  });

  it("reads a book that answers with bare coins, the other way round", () => {
    expect(parseHyperliquidMeta(meta(["GOLD"]), "xyz").map(hlAsset)).toEqual(["xyz:GOLD"]);
  });

  it("carries equities through exactly like anything else — they are perps too", () => {
    const out = parseHyperliquidMeta(meta(["xyz:MU", "xyz:HOOD", "MRNA"]), "xyz");
    expect(out.map(hlAsset)).toEqual(["xyz:MU", "xyz:HOOD", "xyz:MRNA"]);
  });

  it("still drops a colon that is not the book's own prefix", () => {
    expect(parseHyperliquidMeta(meta(["other:GOLD", "OK"]), "xyz").map((p) => p.name)).toEqual(["OK"]);
    expect(parseHyperliquidMeta(meta(["a:b", "OK"]), "d").map((p) => p.name)).toEqual(["OK"]);
  });
});

describe("which asset a ticker means", () => {
  const listed = [
    { name: "BTC", dex: null },
    { name: "GOLD", dex: "vntls" },
    { name: "NVDA", dex: "vntls" },
    { name: "NVDA", dex: "other" },
  ];

  it("gives the coin universe outright", () => {
    expect(hlAssetFor("BTC", listed)).toBe("BTC");
  });

  it("reaches into a builder book when only one lists the ticker", () => {
    expect(hlAssetFor("GOLD", listed)).toBe("vntls:GOLD");
  });

  it("refuses when two books list it — that is a question, not a tie", () => {
    expect(hlAssetFor("NVDA", listed)).toBeNull();
  });

  it("prefers the coin universe over a builder book of the same name", () => {
    const both = [...listed, { name: "BTC", dex: "vntls" }];
    expect(hlAssetFor("BTC", both)).toBe("BTC");
  });

  it("is null for a ticker nobody lists", () => {
    expect(hlAssetFor("NOTHING", listed)).toBeNull();
    expect(hlAssetFor("", listed)).toBeNull();
  });
});

describe("storing and showing a builder-book pair", () => {
  it("keeps the whole qualified asset, rather than splitting off the book", () => {
    // The bug this guards: splitting on every colon handed back "vntls" as
    // the symbol and would have charted a market that does not exist.
    expect(parsePricePair("hyperliquid:vntls:NVDA")).toEqual({
      symbol: "VNTLS:NVDA",
      market: "futures",
      venue: "hyperliquid",
    });
  });

  it("still reads a plain coin", () => {
    expect(parsePricePair("hyperliquid:BTC")?.symbol).toBe("BTC");
  });

  it("names the book in the label", () => {
    expect(describePair({ symbol: "vntls:NVDA", market: "futures", venue: "hyperliquid" })).toBe(
      "Hyperliquid NVDA perp · vntls",
    );
  });

  it("offers a builder asset by its ticker, main universe first", () => {
    const out = pairCandidates("NVDA", [], [{ name: "vntls:NVDA" }, { name: "NVDA" }]);
    expect(out.map((r) => r.symbol)).toEqual(["NVDA", "vntls:NVDA"]);
  });

  it("points a trade at a builder book once it has been chosen", () => {
    const t = trade({ symbol: "GOLD", pricePair: "hyperliquid:vntls:GOLD" });
    expect(pairForTradeAt(t as any, [], [])).toEqual({
      symbol: "VNTLS:GOLD",
      market: "futures",
      venue: "hyperliquid",
    });
  });

  it("resolves a Hyperliquid account's ticker into the one book that lists it", () => {
    const t = trade({ symbol: "GOLD", account: "Hyperliquid" });
    expect(pairForTradeAt(t as any, [], ["BTC", "vntls:GOLD"])).toEqual({
      symbol: "vntls:GOLD",
      market: "futures",
      venue: "hyperliquid",
    });
  });
});
