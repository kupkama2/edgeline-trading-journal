import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { trade } from "./helpers";
import { mentionedByName, mergeDayNote, normalizeDebrief, refOf } from "../shared/debrief";

/**
 * A day talked through, filed onto its trades — on the paragraph that asked
 * for it.
 */
const WORDS = `Yesterday I did two trades. I longed BTC and Pump. I lost both. Total loss was almost $400.

The main mistake was that I was generally right on direction, but the stops were too tight. On Pump, I think it was fine because it dumped much further. For BTC, I pretty much closed it at the very bottom, which was initially a place I wanted to add.

I think the lesson here would be to zoom out, be able to stomach more drawdown, or actually add, as long as my idea is not invalidated.

I think here on Pump, it was an okay trade, but then I could have gotten back in once there was a sign of strength. I would have easily made a day because it went straight up about 15%.`;

const btc = trade({ id: 11, symbol: "BTC", entryPrice: 100, exitPrice: 95, entryTime: "2026-10-18T09:00:00.000Z" });
const pump = trade({ id: 12, symbol: "PUMP", entryPrice: 0.005, initialStop: 0.0048, initialTarget: 0.006, exitPrice: 0.0048, entryTime: "2026-10-18T13:00:00.000Z" });
const eth = trade({ id: 13, symbol: "ETH", entryTime: "2026-10-18T16:00:00.000Z" });
const demons = [{ id: 1, name: "Stop too tight" }, { id: 2, name: "Panic exit" }];

describe("which trades the words name", () => {
  it("finds a symbol as a word, whatever its case, and nothing inside another word", () => {
    expect(mentionedByName(WORDS, [btc, pump, eth])).toEqual(new Set([11, 12]));
    expect(mentionedByName("bought WBTC", [btc]).size).toBe(0);
    expect(mentionedByName("btc.", [btc]).size).toBe(1);
  });
});

describe("what the model said, kept where it can be believed", () => {
  const model = {
    trades: [
      { ref: "T1", note: "Closed it at the very bottom, where I wanted to add.", stopGrade: "tight", exitGrade: "early", exitReason: "discretion", demons: ["Stop too tight", "Panic exit", "Made up"], verdict: null },
      { ref: "T2", note: "Okay trade; could have got back in on strength.", stopGrade: "tight", verdict: "okay", demons: ["Stop too tight"] },
      { ref: "T9", note: "a trade that does not exist" },
      { ref: "T1", note: "a second note for the same trade" },
    ],
    lessons: ["Zoom out and stomach more drawdown", "Re-enter on a sign of strength"],
    unmatched: [],
  };
  const d = normalizeDebrief(model, WORDS, [btc, pump, eth], demons);

  it("files each note on the trade its reference names, once, and nothing on a reference it invented", () => {
    expect(d.entries.map((e) => e.tradeId)).toEqual([11, 12]);
    expect(d.entries[0].note).toMatch(/very bottom/);
  });

  it("reads the grades and keeps only the mistakes on the trader's list", () => {
    expect(d.entries[0].read).toMatchObject({ stopGrade: "tight", exitGrade: "early", exitReason: "discretion", demonIds: [1, 2] });
  });

  it("takes only the two verdicts it knows", () => {
    expect(d.entries[1].verdict).toBeNull();
  });

  it("names the day's trade nobody talked about", () => {
    expect(d.unmentioned).toEqual([13]);
    expect(d.lessons).toHaveLength(2);
  });

  it("counts a trade named in the words as mentioned, even when the model gave it nothing", () => {
    const thin = normalizeDebrief({ trades: [] }, WORDS, [btc, pump, eth], demons);
    expect(thin.entries).toEqual([]);
    expect(thin.unmentioned).toEqual([13]);
  });

  it("refers to trades only as T1, T2…", () => {
    expect([0, 1, 2].map(refOf)).toEqual(["T1", "T2", "T3"]);
  });
});

describe("the day's note", () => {
  it("adds the words to what was there, and never twice", () => {
    expect(mergeDayNote("", "  the words ")).toBe("the words");
    expect(mergeDayNote("morning plan", "the words")).toBe("morning plan\n\nthe words");
    expect(mergeDayNote("morning plan\n\nthe words", "the words")).toBe("morning plan\n\nthe words");
  });
});

/* -------------------------- the route, end to end -------------------------- */

const DB = process.env.DATABASE_URL;
let model: Server;
let app: Server;
let base: string;
let asked = "";

describe.skipIf(!DB)("a debrief over the wire", () => {
  let ids: number[] = [];
  beforeAll(async () => {
    // A stand-in for the Anthropic API, answering the way Claude would.
    model = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const sent = JSON.parse(body || "{}");
        asked = sent.messages?.[0]?.content?.map((c: any) => c.text ?? "").join("") ?? "";
        const reply = {
          trades: [
            { ref: "T1", note: "For BTC, I pretty much closed it at the very bottom, which was initially a place I wanted to add.", stopGrade: "tight", exitGrade: "early", exitReason: "discretion", demons: ["Stop too tight"], highlights: [], verdict: null },
            { ref: "T2", note: "On Pump the stop was too tight but it was fine — it dumped much further. Could have got back in on strength.", stopGrade: "tight", demons: ["Stop too tight"], highlights: [], verdict: null },
          ],
          lessons: ["Zoom out, stomach more drawdown, or add while the idea is not invalidated"],
          unmatched: [],
        };
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "msg_test", type: "message", role: "assistant", model: "claude-test",
            content: [{ type: "text", text: JSON.stringify(reply) }],
            stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(model.address() as any).port}`;

    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { initSchema, accounts, storageFor } = await import("../server/storage");
    const { registerRoutes } = await import("../server/routes");
    await initSchema();
    const me = await accounts.create({ googleSub: `debrief-${stamp}`, email: `debrief-${stamp}@x.test` });
    const store = storageFor(me.id);
    const tags = await store.listMistakeTags();
    if (!tags.some((t) => t.name === "Stop too tight")) await store.createMistakeTag({ name: "Stop too tight" } as any);
    const mk = (symbol: string, at: string) =>
      store.createTrade({
        symbol, direction: "long", size: 1, sizeUnit: "base", pointValue: 1, entryPrice: 100, initialStop: 98, initialTarget: 106,
        entryTime: at, exitTime: at, exitPrice: 98, status: "closed", exitReason: "other",
      } as any);
    ids = [(await mk("BTC", "2026-10-18T09:00:00.000Z")).id, (await mk("PUMP", "2026-10-18T13:00:00.000Z")).id, (await mk("ETH", "2026-10-18T16:00:00.000Z")).id];

    const e = express();
    e.use(express.json());
    e.use((req, _res, next) => {
      (req as any).userId = me.id;
      next();
    });
    app = createServer(e);
    await registerRoutes(app, e);
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as any).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => (app ? app.close(() => r()) : r()));
    await new Promise<void>((r) => (model ? model.close(() => r()) : r()));
    delete process.env.ANTHROPIC_BASE_URL;
  });

  it("sends the day's trades by reference with the trader's own list, and files the reply", async () => {
    const res = await fetch(`${base}/api/debrief`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ day: "2026-10-18", text: WORDS, tradeIds: ids }),
    });
    expect(res.status).toBe(200);
    const { debrief } = await res.json();
    // The prompt carried the trades as T1–T3, and the demon list to pick from.
    expect(asked).toContain('"ref": "T1"');
    expect(asked).toContain('"symbol": "PUMP"');
    expect(asked).toContain("Stop too tight");
    expect(asked).toContain("I longed BTC and Pump");
    // BTC and PUMP filed; ETH named as not talked about.
    expect(debrief.entries.map((x: any) => x.tradeId)).toEqual([ids[0], ids[1]]);
    expect(debrief.entries[0].read).toMatchObject({ stopGrade: "tight", exitGrade: "early", exitReason: "discretion" });
    expect(debrief.entries[0].read.demonIds).toHaveLength(1);
    expect(debrief.unmentioned).toEqual([ids[2]]);
  });

  it("will not read trades that are not this account's", async () => {
    const res = await fetch(`${base}/api/debrief`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ day: "2026-10-18", text: WORDS, tradeIds: [999999] }),
    });
    const { debrief } = await res.json();
    expect(debrief.entries).toEqual([]);
    expect(debrief.unmentioned).toEqual([]);
  });

  it("refuses a request without words", async () => {
    const res = await fetch(`${base}/api/debrief`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ day: "2026-10-18", text: "", tradeIds: ids }),
    });
    expect(res.status).toBe(400);
  });
});
