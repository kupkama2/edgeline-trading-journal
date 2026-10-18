import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { TradeWithTags } from "../shared/schema";
import { readPrefs } from "../shared/schema";
import { canSnooze, debtSentence, gateShut, reviewDebt, SNOOZE_MS } from "../shared/review-pressure";

/**
 * The review, pushed.
 *
 * One rule behind the tab badge, the journal banner and the gate: a trade
 * that has finished having its say and has not been gone over is owed on the
 * day it ended. The cases that matter are where that rule could be unfair —
 * today's trades counted as late, a typo'd future date locking the journal,
 * a backlog from before enforcement locking it, an hour's way past it that
 * never runs out — and where it could be toothless.
 */
let id = 0;
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();
const t = (ended: string, over: Partial<TradeWithTags> = {}): TradeWithTags =>
  ({
    id: ++id,
    status: "closed",
    entryTime: ended,
    exitTime: ended,
    reviewedAt: null,
    cancelReason: null,
    mistakeTagIds: [],
    ...over,
  }) as unknown as TradeWithTags;

// Saturday 17 Oct 2026, mid-afternoon local.
const NOW = new Date(2026, 9, 17, 15, 0);

describe("what is owed", () => {
  it("is nothing when everything finished has been gone over", () => {
    const d = reviewDebt([t(at(2026, 10, 15), { reviewedAt: "x" }), t(at(2026, 10, 17), { status: "open", exitTime: null })], NOW);
    expect(d).toMatchObject({ level: "clear", owed: 0, overdue: 0, today: [], next: null, gate: false });
  });

  it("holds today's trades apart — the day is not over", () => {
    const d = reviewDebt([t(at(2026, 10, 17, 9)), t(at(2026, 10, 17, 11))], NOW);
    expect(d.level).toBe("today");
    expect(d.today).toHaveLength(2);
    expect(d.owed).toBe(0);
    expect(d.next).toBe("2026-10-17");
    expect(debtSentence(d)).toBe("2 trades from today not gone over yet.");
  });

  it("owes yesterday, and calls it late the day after", () => {
    const yesterday = reviewDebt([t(at(2026, 10, 16))], NOW);
    expect(yesterday).toMatchObject({ level: "owed", owed: 1, overdue: 0, gate: false });
    expect(debtSentence(yesterday)).toBe("1 trade from yesterday not gone over.");
    const older = reviewDebt([t(at(2026, 10, 15))], NOW);
    expect(older).toMatchObject({ level: "overdue", owed: 1, overdue: 1, gate: true });
  });

  it("files a trade by the day it ended, and a pass by the day it was looked at", () => {
    const swing = t(at(2026, 10, 16), { entryTime: at(2026, 10, 12) });
    const pass = t(at(2026, 10, 14), { status: "cancelled", cancelReason: "never_placed", exitTime: null });
    const unfilled = t(at(2026, 10, 14), { status: "cancelled", cancelReason: "not_filled", exitTime: null });
    const d = reviewDebt([swing, pass, unfilled], NOW);
    expect(d.days.map((x) => [x.key, x.trades.map((y) => y.id)])).toEqual([
      ["2026-10-14", [pass.id]],
      ["2026-10-16", [swing.id]],
    ]);
    expect(d.next).toBe("2026-10-14");
  });

  it("never owes a trade dated in the future — a typo must not lock anything", () => {
    const d = reviewDebt([t(at(2026, 11, 10))], NOW);
    expect(d).toMatchObject({ level: "clear", owed: 0, gate: false });
  });

  it("counts whole calendar days across a clock change", () => {
    // 25 Oct 2026 is the end of summer time in Europe; 27 Oct is two days on.
    const d = reviewDebt([t(at(2026, 10, 25, 1))], new Date(2026, 9, 27, 0, 30));
    expect(d.days[0].age).toBe(2);
  });
});

describe("the gate", () => {
  const late = reviewDebt([t(at(2026, 10, 14))], NOW);

  it("shuts only when enforcing and something is past the grace", () => {
    expect(gateShut("enforce", late, null, NOW)).toBe(true);
    expect(gateShut("remind", late, null, NOW)).toBe(false);
    expect(gateShut("off", late, null, NOW)).toBe(false);
    expect(gateShut("enforce", reviewDebt([t(at(2026, 10, 16))], NOW), null, NOW)).toBe(false);
  });

  it("is not shut by a backlog from before enforcement was switched on", () => {
    const d = reviewDebt([t(at(2026, 10, 14))], NOW, { gateSince: at(2026, 10, 15, 0) });
    expect(d.level).toBe("overdue"); // still said, in red
    expect(d.gate).toBe(false); // but locks nothing
    expect(gateShut("enforce", d, null, NOW)).toBe(false);
  });

  it("opens for an hour once a day, and not twice", () => {
    const now = NOW.getTime();
    const snooze = { day: "2026-10-17", until: now + SNOOZE_MS };
    expect(gateShut("enforce", late, snooze, NOW)).toBe(false);
    expect(gateShut("enforce", late, snooze, new Date(now + SNOOZE_MS + 1))).toBe(true);
    expect(canSnooze(snooze, NOW)).toBe(false);
    // Tomorrow the hour is there again.
    expect(canSnooze(snooze, new Date(2026, 9, 18, 9))).toBe(true);
    // Yesterday's snooze opens nothing today, whatever its clock says.
    expect(gateShut("enforce", late, { day: "2026-10-16", until: now + SNOOZE_MS }, NOW)).toBe(true);
  });
});

describe("stored prefs", () => {
  it("default to reminding, and survive junk", () => {
    expect(readPrefs(null)).toEqual({ reviewMode: "remind", reviewEnforcedSince: null });
    expect(readPrefs("{not json")).toEqual({ reviewMode: "remind", reviewEnforcedSince: null });
    expect(readPrefs(JSON.stringify({ reviewMode: "nag", reviewEnforcedSince: 5 }))).toEqual({ reviewMode: "remind", reviewEnforcedSince: null });
    expect(readPrefs(JSON.stringify({ reviewMode: "enforce", reviewEnforcedSince: "2026-10-17T00:00:00.000Z" }))).toEqual({
      reviewMode: "enforce",
      reviewEnforcedSince: "2026-10-17T00:00:00.000Z",
    });
  });
});

/* ------------------------------- the route ------------------------------- */

const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) throw new Error("DATABASE_URL is required in CI — the route tests must run");

let server: Server;
let base: string;

describe.skipIf(!DB)("prefs over the wire", () => {
  beforeAll(async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { initSchema, accounts } = await import("../server/storage");
    const { registerRoutes } = await import("../server/routes");
    await initSchema();
    const me = await accounts.create({ googleSub: `prefs-${stamp}`, email: `prefs-${stamp}@x.test` });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).userId = me.id;
      next();
    });
    server = createServer(app);
    await registerRoutes(server, app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  const patch = (body: unknown) =>
    fetch(`${base}/api/prefs`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("starts at the default", async () => {
    expect(await (await fetch(`${base}/api/prefs`)).json()).toEqual({ reviewMode: "remind", reviewEnforcedSince: null });
  });

  it("stamps the moment enforcement is switched on, and keeps it on a repeat", async () => {
    const on = await (await patch({ reviewMode: "enforce" })).json();
    expect(on.reviewMode).toBe("enforce");
    expect(Math.abs(Date.now() - Date.parse(on.reviewEnforcedSince))).toBeLessThan(10_000);
    const again = await (await patch({ reviewMode: "enforce" })).json();
    expect(again.reviewEnforcedSince).toBe(on.reviewEnforcedSince);
    expect(await (await fetch(`${base}/api/prefs`)).json()).toEqual(again);
  });

  it("refuses a mode it does not know, and a field it does not take", async () => {
    expect((await patch({ reviewMode: "nag" })).status).toBe(400);
    expect((await patch({ reviewEnforcedSince: "2020-01-01T00:00:00Z" })).status).toBe(400);
  });
});
