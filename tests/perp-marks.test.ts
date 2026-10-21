import { beforeEach, describe, expect, it } from "vitest";
import { resetPerpMarks, withBrowserPerpMarks } from "../client/src/lib/perp-marks";
import type { Mark } from "../shared/marks";

/**
 * A perp the server could only price from spot, priced from the browser.
 * Only ever an upgrade: whatever goes wrong, the server's mark stands.
 */
const fromSpot: Mark = { price: 100, at: 1, venue: "binance", book: "spot", perp: "INJUSDT" };
const live: Mark = { price: 50, at: 1, venue: "binance", book: "perp" };

const answering = (prices: Record<string, number>) => {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    return { ok: true, json: async () => Object.entries(prices).map(([symbol, price]) => ({ symbol, price: String(price) })) };
  };
  return { f, calls };
};

beforeEach(() => resetPerpMarks());

describe("pricing a perp from the browser", () => {
  it("replaces a spot fallback with the perp's own price", async () => {
    const { f } = answering({ INJUSDT: 101.5 });
    const out = await withBrowserPerpMarks({ 1: fromSpot, 2: live }, f, 1000);
    expect(out[1]).toMatchObject({ price: 101.5, book: "perp", stale: false, fromBrowser: true, at: 1000 });
    // A live perp mark is left as it came.
    expect(out[2]).toBe(live);
  });

  it("asks nothing when every mark is already live", async () => {
    const { f, calls } = answering({});
    await withBrowserPerpMarks({ 2: live }, f, 1000);
    expect(calls).toEqual([]);
  });

  it("keeps the server's mark when the book refuses, and stops asking for a while", async () => {
    const calls: string[] = [];
    const refuse = async (url: string) => {
      calls.push(url);
      return { ok: false, json: async () => ({}) };
    };
    const out = await withBrowserPerpMarks({ 1: fromSpot }, refuse, 1000);
    expect(out[1]).toBe(fromSpot);
    const tried = calls.length;
    await withBrowserPerpMarks({ 1: fromSpot }, refuse, 2000);
    expect(calls.length).toBe(tried);
  });

  it("keeps the server's mark when the request throws", async () => {
    const out = await withBrowserPerpMarks({ 1: fromSpot }, async () => {
      throw new TypeError("Failed to fetch");
    }, 1000);
    expect(out[1]).toBe(fromSpot);
  });

  it("holds one read briefly, since the page asks every minute", async () => {
    const { f, calls } = answering({ INJUSDT: 101.5 });
    await withBrowserPerpMarks({ 1: fromSpot }, f, 1000);
    await withBrowserPerpMarks({ 1: fromSpot }, f, 5000);
    expect(calls.length).toBe(1);
  });
});
