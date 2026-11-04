import { describe, expect, it } from "vitest";
import { browserCandles, resetBrowserCandles } from "../client/src/lib/browser-candles";

/** The browser asking the venue for bars when the server could not. */
const bars = (n: number, step = 60_000, start = 1_700_000_000_000) => Array.from({ length: n }, (_, i) => [start + i * step, "1", "2", "0.5", "1.5", "1", start + i * step + step - 1, "0", 0, "0", "0", "0"]);

describe("bars read by the browser", () => {
  it("reads the perp book in pages, and gives up on a refused host for a while", async () => {
    resetBrowserCandles();
    const asked: string[] = [];
    const fetchImpl = async (url: string) => {
      asked.push(url);
      const u = new URL(url);
      if (u.hostname === "fapi.binance.com") return { ok: false, json: async () => ({}) };
      const start = Number(u.searchParams.get("startTime"));
      const first = 1_700_000_000_000;
      const n = start <= first ? 1000 : 10;
      return { ok: true, json: async () => bars(n, 60_000, start <= first ? first : start) };
    };
    const out = await browserCandles("futures", "BTCUSDT", "1m", 1_700_000_000_000, 1_700_000_000_000 + 1100 * 60_000, 1200, fetchImpl as any, 0);
    expect(out.length).toBe(1010);
    expect(out[0]).toEqual({ t: 1_700_000_000_000, o: 1, h: 2, l: 0.5, c: 1.5 });
    // The first host refused once and was not asked again; the second paged twice.
    expect(asked.filter((u) => u.includes("fapi.binance.com")).length).toBe(1);
    expect(asked.filter((u) => u.includes("fapi1.binance.com")).length).toBe(2);
  });

  it("answers nothing, quickly, while every host refuses — and backs off", async () => {
    resetBrowserCandles();
    let calls = 0;
    const refuse = async () => {
      calls += 1;
      return { ok: false, json: async () => ({}) };
    };
    expect(await browserCandles("spot", "BTCUSDT", "1h", 0, 3_600_000, 10, refuse as any, 1000)).toEqual([]);
    expect(calls).toBe(2);
    expect(await browserCandles("spot", "BTCUSDT", "1h", 0, 3_600_000, 10, refuse as any, 2000)).toEqual([]);
    expect(calls).toBe(2);
  });
});
