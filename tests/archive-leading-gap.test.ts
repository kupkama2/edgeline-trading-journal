import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { zipSync, strToU8 } from "fflate";

/**
 * A coin that has not always existed.
 *
 * The archive is read a file at a time and the run stops at the first one
 * that is not there. In the MIDDLE of a window that is right: a hole means
 * the bars on either side do not join up, and a chart that quietly closes the
 * gap is drawing a day that did not happen. But the FIRST file is a different
 * thing. A coin listed three weeks ago has no file for the month before it
 * existed, and a chart window routinely reaches back further than the listing
 * — so the read gave up before it had started, returned nothing, and the
 * route fell through to reporting whatever the live API had said.
 *
 * Which is the shape of the bug on screen: the mark, which asks for five
 * days, had a price; the chart, which asks for the whole trade, had none and
 * printed the live book's parse error in place of a chart.
 */
const DAY = 86_400_000;
const HOUR = 3_600_000;
const day0 = (ms: number) => Math.floor(ms / DAY) * DAY;

/** NEWCOIN was listed four days ago; nothing before that is in the bucket. */
const LISTED = day0(Date.now() - 4 * DAY);
/** OLDCOIN has always been there, but one day in the middle is missing. */
const HOLE = day0(Date.now() - 2 * DAY);

function csv(dayStart: number): string {
  const rows: string[] = [];
  for (let t = dayStart; t < dayStart + DAY; t += HOUR) {
    rows.push(`${t},0.29,0.30,0.28,0.292,1000,${t + HOUR - 1},290,10,500,145,0`);
  }
  return rows.join("\n");
}

let server: Server;
const asked: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "";
    asked.push(path);
    const m = path.match(/-(\d{4})-(\d{2})-(\d{2})\.zip$/);
    // Anything that is not a daily file is a monthly one, and neither coin
    // here has history that far back.
    if (!m) {
      res.statusCode = 404;
      return res.end("not found");
    }
    const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const gone = path.includes("NEWCOIN") ? day < LISTED : day === HOLE;
    if (gone) {
      res.statusCode = 404;
      return res.end("not found");
    }
    const name = path.split("/").pop()!.replace(".zip", ".csv");
    res.writeHead(200, { "content-type": "application/zip" });
    res.end(Buffer.from(zipSync({ [name]: strToU8(csv(day)) })));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  // Read at module load by binance-archive.ts, so it must be set before the
  // first import of it anywhere in this file.
  process.env.BINANCE_ARCHIVE_BASE = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("reading across a coin's listing date", () => {
  it("skips the days before it existed and draws the rest", async () => {
    const { archiveCandles } = await import("../server/binance-archive");
    const read = await archiveCandles(
      { symbol: "NEWCOINUSDT", market: "futures" },
      "1h",
      LISTED - 3 * DAY,
      LISTED + 2 * DAY,
      true,
    );
    expect(read.candles.length).toBeGreaterThan(0);
    // What came back starts at the listing, not before it — the window simply
    // begins later than it was asked to.
    expect(read.candles[0].t).toBeGreaterThanOrEqual(LISTED);
    expect(read.coveredTo).toBeGreaterThanOrEqual(LISTED + DAY - 1);
  });

  it("refuses a late start unless the caller asked for one", async () => {
    /*
     * The default, and the one that matters. The settler's window starts at
     * the ENTRY, so a missing file at its start is not a coin that did not
     * exist — it is the entry day itself unread. Scanning on from day two
     * would report a target hit on day ten for a stop that went on day one,
     * which is the confident wrong answer this module exists to never give.
     * Nothing comes back, the trade stays unsettled, and it is asked again
     * tomorrow.
     */
    const { archiveCandles } = await import("../server/binance-archive");
    const read = await archiveCandles(
      { symbol: "NEWCOINUSDT", market: "futures" },
      "1h",
      LISTED - 3 * DAY,
      LISTED + 2 * DAY,
    );
    expect(read.candles).toEqual([]);
    expect(read.stoppedBecause).toBeTruthy();
  });

  it("still stops at a hole once the data has started", async () => {
    const { archiveCandles } = await import("../server/binance-archive");
    const read = await archiveCandles(
      { symbol: "OLDCOINUSDT", market: "futures" },
      "1h",
      HOLE - 3 * DAY,
      HOLE + 2 * DAY,
      true,
    );
    // The days before the hole are real and are returned; coverage stops
    // there and says why, rather than running past a day that is not here.
    expect(read.candles.length).toBeGreaterThan(0);
    expect(read.coveredTo).toBeLessThan(HOLE);
    expect(read.stoppedBecause).toBeTruthy();
  });

  it("gives up when there is nothing in the window at all", async () => {
    // Skipping a leading gap must not turn "this coin is not in the archive"
    // into a silent empty chart — the caller needs to know it was refused.
    const { archiveCandles } = await import("../server/binance-archive");
    const read = await archiveCandles(
      { symbol: "NEWCOINUSDT", market: "futures" },
      "1h",
      LISTED - 6 * DAY,
      LISTED - 2 * DAY,
      true,
    );
    expect(read.candles).toEqual([]);
    expect(read.stoppedBecause).toBeTruthy();
  });
});
