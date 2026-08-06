import { describe, expect, it } from "vitest";
import {
  mapHeaders,
  parseTradeCsv,
  splitCsvLine,
  tradesToCsv,
} from "../shared/csv";
import { trade } from "./helpers";

describe("splitCsvLine", () => {
  it("honours quoted commas and doubled quotes", () => {
    expect(splitCsvLine('a,"b,c","say ""hi""",d')).toEqual(["a", "b,c", 'say "hi"', "d"]);
  });
});

describe("mapHeaders", () => {
  it("reads a TradingView-style header", () => {
    const map = mapHeaders(
      "Symbol,Side,Qty,Avg Fill Price,Close Price,Stop Loss,Take Profit,Time,Closing Time,Comment".split(","),
    );
    expect(Object.values(map).sort()).toEqual([
      "direction", "entryPrice", "entryTime", "exitPrice",
      "exitTime", "initialStop", "initialTarget", "notes", "size", "symbol",
    ]);
  });

  it("maps each field at most once, first column wins", () => {
    const map = mapHeaders(["Time", "Entry Time", "Symbol"]);
    const fields = Object.values(map);
    expect(fields.filter((f) => f === "entryTime")).toHaveLength(1);
    expect(map[0]).toBe("entryTime"); // "Time" claimed it first
  });
});

describe("parseTradeCsv", () => {
  const TV = [
    "Symbol,Side,Qty,Avg Fill Price,Close Price,Stop Loss,Take Profit,Time,Closing Time,Comment",
    'MNQU6,Buy,2,29307.75,29359.00,29266.50,29359.00,2026-08-06 09:30:00,2026-08-06 10:15:00,"good, clean retest"',
    "ESU6,Sell,1,7790.75,7785.00,7796.50,7785.00,2026-08-06 10:18:56,2026-08-06 11:02:00,",
    "JUNK,,,,,,,,,",
  ].join("\n");

  it("imports the good rows and names why the bad one was skipped", () => {
    const r = parseTradeCsv(TV);
    expect(r.rows).toHaveLength(2);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].line).toBe(4);
    expect(r.missingFields).toEqual([]);
    const [mnq] = r.rows;
    expect(mnq.symbol).toBe("MNQU6");
    expect(mnq.direction).toBe("long");
    expect(mnq.initialStop).toBe(29266.5);
    expect(mnq.notes).toBe("good, clean retest");
  });

  it("reads naive timestamps as LOCAL time, not UTC", () => {
    const r = parseTradeCsv(TV);
    // Whatever the zone, 09:30 written by the trader must stay 09:30 on their clock.
    expect(new Date(r.rows[0].entryTime).getHours()).toBe(9);
    expect(new Date(r.rows[0].entryTime).getMinutes()).toBe(30);
  });

  it("survives a minimal file and reports what the import will lack", () => {
    const r = parseTradeCsv("ticker,action,amount,price\nBTCUSDT,SELL,0.5,65109.4");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].direction).toBe("short");
    expect(r.missingFields).toContain("initialStop");
    expect(r.missingFields).toContain("entryTime");
  });
});

describe("tradesToCsv", () => {
  it("writes derived metrics out so spreadsheets never re-derive R", () => {
    const csv = tradesToCsv([trade()], [], []);
    const [header, row] = csv.split("\n");
    const cols = header.split(",");
    const vals = splitCsvLine(row);
    const get = (name: string) => vals[cols.indexOf(name)];
    expect(get("actualR")).toBe("2");
    expect(get("riskDollars")).toBe("10");
    expect(get("status")).toBe("closed");
  });

  it("uses the LOCAL clock for the convenience date/time columns", () => {
    const entry = new Date(2026, 7, 6, 9, 30); // 09:30 local, whatever the zone
    const csv = tradesToCsv([trade({ entryTime: entry.toISOString() })], [], []);
    const [header, row] = csv.split("\n");
    const cols = header.split(",");
    const vals = splitCsvLine(row);
    expect(vals[cols.indexOf("date")]).toBe("2026-08-06");
    expect(vals[cols.indexOf("time")]).toBe("09:30");
  });

  it("quotes freehand text so notes with commas survive a round trip", () => {
    const csv = tradesToCsv([trade({ notes: 'went "late", again' })], [], []);
    const back = splitCsvLine(csv.split("\n")[1]);
    expect(back).toContain('went "late", again');
  });
});
