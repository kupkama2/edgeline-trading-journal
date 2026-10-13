import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import {
  CURRENT,
  chapterSpans,
  chapterTrades,
  freshStartRefusal,
  inSpan,
  spanFor,
  spanLabel,
  type Chapter,
} from "../shared/chapters";

/**
 * Starting over without throwing anything away.
 *
 * A fresh start is a date. Everything from it on is the chapter every page
 * shows; everything before it is kept whole and shown only when asked for.
 * The cases that matter: the default hides the past, an open position is
 * never hidden, a missed trade is dated by its entry like any other, and a
 * chapter that no longer exists falls back to now rather than to nothing.
 */
const D = (s: string) => new Date(s).toISOString();
const chapter = (id: number, startedAt: string, name: string | null = null): Chapter => ({
  id,
  userId: 1,
  startedAt: D(startedAt),
  name,
  note: null,
  createdAt: D(startedAt),
});
const trade = (entry: string, status = "closed") => ({ entryTime: D(entry), status });

describe("the chapters as spans of time", () => {
  it("is nothing until there has been a fresh start", () => {
    expect(chapterSpans([])).toEqual([]);
    expect(chapterTrades([trade("2026-01-01")], [], CURRENT)).toHaveLength(1);
  });

  it("puts an unnamed chapter before the first fresh start, and the rest in order", () => {
    const spans = chapterSpans([chapter(7, "2026-10-13T09:00", "After October"), chapter(3, "2026-08-01")]);
    expect(spans.map((s) => [s.id, s.index, s.name, s.current])).toEqual([
      [0, 1, null, false],
      [3, 2, null, false],
      [7, 3, "After October", true],
    ]);
    expect(spans[0].from).toBe(Number.NEGATIVE_INFINITY);
    expect(spans[0].to).toBe(Date.parse(D("2026-08-01")));
    expect(spans[2].to).toBeNull();
    expect(spans.map(spanLabel)).toEqual(["Chapter 1", "Chapter 2", "After October"]);
  });

  it("ignores a chapter whose date cannot be read rather than breaking every span", () => {
    expect(chapterSpans([{ ...chapter(1, "2026-08-01"), startedAt: "whenever" }])).toEqual([]);
  });
});

describe("which trades a view shows", () => {
  const chapters = [chapter(1, "2026-10-13T09:00")];
  const before = trade("2026-10-10T12:00");
  const missedBefore = trade("2026-10-11T12:00", "cancelled");
  const openBefore = trade("2026-10-12T12:00", "open");
  const pendingBefore = trade("2026-10-12T13:00", "pending");
  const after = trade("2026-10-13T09:00");
  const all = [before, missedBefore, openBefore, pendingBefore, after];

  it("hides everything before the fresh start by default, except what is still live", () => {
    expect(chapterTrades(all, chapters, CURRENT)).toEqual([openBefore, pendingBefore, after]);
  });

  it("shows everything when asked to", () => {
    expect(chapterTrades(all, chapters, { kind: "all" })).toEqual(all);
  });

  it("shows an earlier chapter on its own, by entry — a position opened there is there", () => {
    // And in the present too, until it closes: it was entered in the old
    // chapter and is being traded in the new one, and both are true.
    expect(chapterTrades(all, chapters, { kind: "chapter", id: 0 })).toEqual([before, missedBefore, openBefore, pendingBefore]);
  });

  it("falls back to the current chapter for one that no longer exists", () => {
    expect(chapterTrades(all, chapters, { kind: "chapter", id: 99 })).toEqual([openBefore, pendingBefore, after]);
    expect(spanFor(chapterSpans(chapters), { kind: "chapter", id: 99 })?.current).toBe(true);
  });

  it("dates a trade by its entry, to the millisecond, on both sides of the line", () => {
    const span = chapterSpans(chapters)[1];
    expect(inSpan(trade("2026-10-13T08:59:59.999"), span)).toBe(false);
    expect(inSpan(trade("2026-10-13T09:00:00.000"), span)).toBe(true);
  });
});

describe("when a fresh start may begin", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  it("now or earlier, with a minute's grace for a fast clock", () => {
    expect(freshStartRefusal(new Date(now).toISOString(), now)).toBeNull();
    expect(freshStartRefusal(new Date(now - 86_400_000).toISOString(), now)).toBeNull();
    expect(freshStartRefusal(new Date(now + 30_000).toISOString(), now)).toBeNull();
  });
  it("never in the future, and never on a date that is not one", () => {
    expect(freshStartRefusal(new Date(now + 3_600_000).toISOString(), now)).toMatch(/future/);
    expect(freshStartRefusal("next tuesday", now)).toMatch(/not a date/);
  });
});

/* ------------------------------- the route ------------------------------- */

const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the route tests must run");
}

let server: Server;
let base: string;
let userId = 0;
let currentUser = 0;

async function boot() {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { initSchema, accounts } = await import("../server/storage");
  const { registerRoutes } = await import("../server/routes");
  await initSchema();
  const me = await accounts.create({ googleSub: `chap-${stamp}`, email: `chap-${stamp}@x.test` });
  userId = me.id;
  currentUser = me.id;
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  app.use((req, _res, next) => {
    (req as any).userId = currentUser;
    next();
  });
  server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe.skipIf(!DB)("a fresh start, over the wire", () => {
  beforeAll(boot);
  afterAll(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  let id = 0;

  it("begins with none", async () => {
    expect(await (await send("GET", "/api/chapters")).json()).toEqual([]);
  });

  it("starts one now when no date is given, and keeps the name and the note", async () => {
    const res = await send("POST", "/api/chapters", { name: "  After October  ", note: "No more revenge trades." });
    expect(res.status).toBe(201);
    const row = await res.json();
    id = row.id;
    expect(row).toMatchObject({ name: "After October", note: "No more revenge trades." });
    expect(Math.abs(Date.now() - Date.parse(row.startedAt))).toBeLessThan(10_000);
  });

  it("refuses a fresh start in the future, and a date that is not one", async () => {
    const future = await send("POST", "/api/chapters", { startedAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(future.status).toBe(400);
    expect((await future.json()).message).toMatch(/future/);
    const junk = await send("POST", "/api/chapters", { startedAt: "someday" });
    expect(junk.status).toBe(400);
  });

  it("renames and re-dates one, in the journal's own instant form", async () => {
    const res = await send("PATCH", `/api/chapters/${id}`, { name: "", startedAt: "2026-10-01T09:00:00+02:00" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, name: null, startedAt: "2026-10-01T07:00:00.000Z" });
  });

  it("is nobody else's", async () => {
    const { accounts } = await import("../server/storage");
    const other = await accounts.create({ googleSub: `chap-o-${Date.now()}`, email: `chap-o-${Date.now()}@x.test` });
    currentUser = other.id;
    try {
      expect(await (await send("GET", "/api/chapters")).json()).toEqual([]);
      expect((await send("PATCH", `/api/chapters/${id}`, { name: "mine now" })).status).toBe(404);
      await send("DELETE", `/api/chapters/${id}`);
    } finally {
      currentUser = userId;
    }
    expect((await (await send("GET", "/api/chapters")).json()).map((c: any) => c.id)).toEqual([id]);
  });

  it("can be undone, which deletes the date and nothing else", async () => {
    expect((await send("DELETE", `/api/chapters/${id}`)).status).toBe(204);
    expect(await (await send("GET", "/api/chapters")).json()).toEqual([]);
  });
});
