import { describe, expect, it } from "vitest";
import { extendsExtreme } from "../server/outcomes";

/**
 * When the market disagrees with a number already on the trade.
 *
 * Refusing to overwrite is right: MAE and MFE are read off a chart by hand,
 * and a hand-read value is a judgement about which wick counted. But refusing
 * SILENTLY throws away the interesting half — you read 1.20, the archive says
 * the wick reached 1.35, and the trade ran a third further in your favour
 * than your record of it.
 *
 * The rule is that only an EXTENSION is worth offering. These are maxima: a
 * machine reading that falls short of a hand-read one usually means the hand
 * read a finer timeframe, and pulling the number in would quietly shrink a
 * real excursion.
 */
describe("a long", () => {
  it("offers a higher best price", () => {
    expect(extendsExtreme("mfe", 120, 135, "long")).toBe(true);
  });

  it("refuses a lower one", () => {
    // The coarser instrument, not new information.
    expect(extendsExtreme("mfe", 135, 120, "long")).toBe(false);
  });

  it("offers a lower worst price", () => {
    expect(extendsExtreme("mae", 95, 88, "long")).toBe(true);
  });

  it("refuses a higher one", () => {
    expect(extendsExtreme("mae", 88, 95, "long")).toBe(false);
  });
});

describe("a short, where every direction inverts", () => {
  /*
   * The half that would go wrong unnoticed. On a short the best price is the
   * LOWEST, so an improving MFE is a falling number — and a rule written for
   * longs would read that as the market pulling the excursion in and stay
   * silent about the one case the trader most wants to hear about.
   */
  it("offers a lower best price", () => {
    expect(extendsExtreme("mfe", 120, 105, "short")).toBe(true);
  });

  it("refuses a higher one", () => {
    expect(extendsExtreme("mfe", 105, 120, "short")).toBe(false);
  });

  it("offers a higher worst price", () => {
    expect(extendsExtreme("mae", 130, 142, "short")).toBe(true);
  });

  it("refuses a lower one", () => {
    expect(extendsExtreme("mae", 142, 130, "short")).toBe(false);
  });
});

describe("the aftermath prices follow the same sides", () => {
  it("treats the post-exit peak as favourable", () => {
    expect(extendsExtreme("postExitPeak", 140, 160, "long")).toBe(true);
    expect(extendsExtreme("postExitPeak", 140, 120, "short")).toBe(true);
  });

  it("treats the post-exit adverse as against", () => {
    expect(extendsExtreme("postExitAdverse", 90, 80, "long")).toBe(true);
    expect(extendsExtreme("postExitAdverse", 90, 100, "short")).toBe(true);
  });
});

describe("what is not worth interrupting anybody about", () => {
  it("ignores a hair", () => {
    // Two instruments disagreeing about a wick, not news.
    expect(extendsExtreme("mfe", 30000, 30001, "long")).toBe(false);
  });

  it("offers a move that is actually a move", () => {
    expect(extendsExtreme("mfe", 30000, 30200, "long")).toBe(true);
  });

  it("says nothing about a price that is not one", () => {
    expect(extendsExtreme("mfe", 0, 120, "long")).toBe(false);
    expect(extendsExtreme("mfe", 120, 0, "long")).toBe(false);
  });
});
