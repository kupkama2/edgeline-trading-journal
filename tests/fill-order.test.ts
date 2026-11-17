import { describe, expect, it } from "vitest";
import { inVenueOrder } from "../shared/fill-order";
import { tradesFromFills, type HlFill } from "../shared/hyperliquid";
import { cutAtVenueFlat } from "../shared/terminal";

/**
 * A short opened in two fills, then stopped out by one order that swept the
 * book: four fills on one millisecond. The ids run AGAINST the order they
 * happened in, as the venue's can, so the fill that took it to flat has the
 * lowest id of the four.
 */
const fill = (time: number, tid: number, side: "A" | "B", sz: number, startPosition: number, px = 21): HlFill =>
  ({ coin: "VVV", time, tid, oid: side === "A" ? 1 : 2, side, sz, px, startPosition, fee: 0.01, closedPnl: side === "B" ? -1 : 0, dir: "", maker: false }) as unknown as HlFill;

const fills: HlFill[] = [
  fill(1000, 11, "A", 100, 0),
  fill(2000, 12, "A", 182.01, -100),
  // The stop, one stamp, four fills: -282.01 → -222.75 → -150 → -40 → 0.
  fill(9000, 904, "B", 59.26, -282.01, 21.8),
  fill(9000, 903, "B", 72.75, -222.75, 21.8),
  fill(9000, 902, "B", 110, -150, 21.8),
  fill(9000, 901, "B", 40, -40, 21.8),
];

describe("fills on one stamp", () => {
  it("are put in the order the venue's position count gives, not by id", () => {
    expect(inVenueOrder(fills).map((f) => f.tid)).toEqual([11, 12, 904, 903, 902, 901]);
  });

  it("chains a group that opens the record, where nothing came before", () => {
    const sweep = fills.slice(2);
    expect(inVenueOrder(sweep).map((f) => f.tid)).toEqual([904, 903, 902, 901]);
  });

  it("leaves fills on different stamps in time order", () => {
    const apart = [fill(3, 1, "B", 1, -1), fill(1, 9, "A", 2, 0), fill(2, 5, "B", 1, -2)];
    expect(inVenueOrder(apart).map((f) => f.tid)).toEqual([9, 5, 1]);
  });

  it("the flat is the LAST fill of the stop, so the whole size is accounted for", () => {
    const own = cutAtVenueFlat(fills, false);
    expect(own.cut).toBe(true);
    const closed = own.fills.filter((f) => f.side === "B").reduce((s, f) => s + f.sz, 0);
    expect(closed).toBeCloseTo(282.01, 6);
  });

  it("reads as one closed trade, not as fills that do not add up", () => {
    const read = tradesFromFills(fills, "hl");
    expect(read.unreconstructed).toEqual([]);
    expect(read.trades).toHaveLength(1);
    expect(read.trades[0].status).toBe("closed");
    expect(read.trades[0].size).toBeCloseTo(282.01, 6);
  });
});
