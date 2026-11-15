import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { capturedAtOf, diffSnapshots, parseCrypkitCsv, pragueDay, sigilGroups, sigilMovers, sigilReport, sigilStreaks, SigilRefused, withHistoryPoint, type SigilChange } from "../shared/sigil";

/**
 * Sigil Core: reading the tracker's export, comparing two days, and keeping
 * them. The exports here are made up; the owner's real pack is run through
 * the same code when SIGIL_SEED_DIR points at it (it is not in the repository).
 */
const DB = !!process.env.DATABASE_URL;
const SEED = process.env.SIGIL_SEED_DIR;
const HEAD = "Asset;Amount;Price [USD];Price [BTC];Total [USD];Total [BTC];ROI 24h;Share";
const NAME = (d: string, t = "10_40_12.929") => `Crypkit_portfolio-table_${d}T${t}Z.csv`;
const row = (name: string, amount: string, price: number | "", total: number, roi: number | "" = 1, share: number | "" = 1) => `${name};${amount};${price};0;${total};0;${roi};${share}`;
const file = (rows: string[], bom = true) => `${bom ? "﻿" : ""}${[HEAD, ...rows].join("\n")}\n`;

const DAY1 = file([
  row("Bitcoin", "0.5 BTC", 60000, 30000, 2),
  row("Euro", "81.4 EUR", 1.1, 89.54, ""),
  row("ALEO", "3951.12 ALEO", 0.0287, 113.48, -5.7),
  row("Verulink Bridged ALEO (BSC)", "100 ALEO", 0.0287, 28.7, -5.7),
  row("Tiny", "5e-7 TINY", 2e7, 10, 0.1),
  row("牛来 (Niu Lai)", "1200.5 牛来", 0.02, 24.01, -24),
  row("Hivemapper", "900 HONEY", 0.012, 10.8, -3),
  row("Other Assets <10 USD", "", "", 103.98, "", 0.3),
]);
const DAY2 = file([
  row("Bitcoin", "0.5 BTC", 61000, 30500, 1.6),
  row("Euro", "62.19 EUR", 1.1, 68.41, ""),
  row("ALEO", "3951.12 ALEO", 0.03, 118.5, 4),
  row("Verulink Bridged ALEO (BSC)", "100 ALEO", 0.03, 30, 4),
  row("Tiny", "5e-7 TINY", 2e7, 10, 0.1),
  row("牛来 (Niu Lai)", "1200.5 牛来", 0.02, 24.01, -24),
  row("Solana", "10 SOL", 150, 1500, 3),
  row("Other Assets <10 USD", "", "", 119.84, "", 0.3),
]);

describe("reading a Crypkit export", () => {
  it("takes the time from the file's name and the day from Prague's clock", () => {
    expect(capturedAtOf(NAME("2026-11-15"))).toBe("2026-11-15T10:40:12.929Z");
    expect(capturedAtOf("holdings.csv")).toBeNull();
    // Half past eleven at night in UTC is already the next day in Prague.
    expect(pragueDay("2026-11-15T23:30:00.000Z")).toBe("2026-11-16");
    expect(pragueDay("2026-11-15T10:40:12.929Z")).toBe("2026-11-15");
  });

  it("reads past the byte-order mark, keeps the dust row as a total, and sums the value", () => {
    const s = parseCrypkitCsv(DAY1, NAME("2026-11-12"));
    expect(s.positionCount).toBe(7);
    expect(s.positions.find((p) => p.name.startsWith("Other"))).toBeUndefined();
    expect(s.dustTotalUsd).toBe(103.98);
    expect(s.portfolioValueUsd).toBeCloseTo(30000 + 89.54 + 113.48 + 28.7 + 10 + 24.01 + 10.8 + 103.98, 2);
    expect(parseCrypkitCsv(file([row("Bitcoin", "1 BTC", 1, 1)], false), NAME("2026-11-12")).positionCount).toBe(1);
  });

  it("splits the amount on its last space: scientific notation, a symbol that is not Latin, an empty ROI", () => {
    const s = parseCrypkitCsv(DAY1, NAME("2026-11-12"));
    expect(s.positions.find((p) => p.symbol === "TINY")!.amount).toBe(5e-7);
    expect(s.positions.find((p) => p.symbol === "牛来")!.name).toBe("牛来 (Niu Lai)");
    expect(s.positions.find((p) => p.symbol === "EUR")!.roi24h).toBeNull();
    expect(s.positions.filter((p) => p.symbol === "ALEO")).toHaveLength(2);
  });

  it("refuses what is not an export, in words", () => {
    expect(() => parseCrypkitCsv("%PDF-1.7\n…", NAME("2026-11-12"))).toThrow(SigilRefused);
    expect(() => parseCrypkitCsv("Asset,Amount\nBitcoin,1 BTC", NAME("2026-11-12"))).toThrow(/not a Crypkit portfolio table/);
    expect(() => parseCrypkitCsv(DAY1, "export.csv")).toThrow(/carries no time/);
    expect(() => parseCrypkitCsv(file([row("Bitcoin", "lots", 1, 1)]), NAME("2026-11-12"))).toThrow(/cannot be read/);
    expect(() => parseCrypkitCsv(file([]), NAME("2026-11-12"))).toThrow(/no positions/);
  });
});

describe("comparing two days", () => {
  const a = parseCrypkitCsv(DAY1, NAME("2026-11-12"));
  const b = parseCrypkitCsv(DAY2, NAME("2026-11-15"));

  it("judges by amount: a resize past a tenth, an add, and dust that only crossed the ten-dollar line", () => {
    const c = diffSnapshots(a, b, "2026-11-15", "2026-11-12");
    expect(c.status).toBe("ok");
    expect(c.resized).toEqual([{ name: "Euro", symbol: "EUR", from: 81.4, to: 62.19, pct: -23.6, totalUsd: 68.41 }]);
    expect(c.added.map((x) => x.symbol)).toEqual(["SOL"]);
    expect(c.removed).toEqual([]);
    expect(c.dust).toEqual([{ name: "Hivemapper", symbol: "HONEY", direction: "out" }]);
    // Bitcoin's dollars moved and its amount did not: not a change.
    expect(c.resized.find((r) => r.symbol === "BTC")).toBeUndefined();
    expect(c.notes?.[0]).toMatch(/spans 3 days, so resizes are cumulative/);
  });

  it("tells two rows that share a symbol apart by name", () => {
    const moved = parseCrypkitCsv(DAY2.replace("100 ALEO", "250 ALEO"), NAME("2026-11-15"));
    const c = diffSnapshots(a, moved, "2026-11-15", "2026-11-12");
    expect(c.resized.map((r) => r.name)).toEqual(["Euro", "Verulink Bridged ALEO (BSC)"]);
  });

  it("is a baseline with nothing before it", () => {
    const c = diffSnapshots(null, a, "2026-11-12");
    expect(c.status).toBe("baseline");
    expect(c.added).toEqual([]);
  });

  it("writes the day's report", () => {
    const c = diffSnapshots(a, b, "2026-11-15", "2026-11-12");
    const lines = sigilReport(c, { previousValueUsd: a.portfolioValueUsd, movers: sigilMovers(b.positions) });
    expect(lines[0]).toBe("Sigil Core — 2026-11-15: 2 changes");
    expect(lines).toContain("RESIZED Euro (EUR) 81.4 → 62.19 (−23.6%) · $68");
    expect(lines).toContain("DUST out: Hivemapper");
    expect(lines.find((l) => l.startsWith("Portfolio"))).toMatch(/vs 11-12, 3-day gap\) · 7 positions$/);
    expect(lines.find((l) => l.startsWith("Down:"))).toMatch(/牛来 \(Niu Lai\) −24\.0% \(\$24\)/);
    expect(sigilReport(diffSnapshots(a, a, "2026-11-13", "2026-11-12"))[0]).toMatch(/quiet day/);
  });

  it("weighs a group's day by value", () => {
    const g = sigilGroups(b.positions, { BTC: { segment: "L1 / L2", eco: "Bitcoin" }, SOL: { segment: "L1 / L2", eco: "Solana" } }, "segment");
    expect(g[0].key).toBe("L1 / L2");
    expect(g[0].count).toBe(2);
    expect(g[0].roi24h).toBeGreaterThan(1.6);
    expect(g[0].roi24h).toBeLessThan(3);
    expect(g.find((x) => x.key === "Uncategorized")!.count).toBe(5);
  });
});

describe("positioning streaks", () => {
  const ch = (date: string, over: Partial<SigilChange>): SigilChange => ({ date, status: "ok", portfolioValueUsd: 1, positionCount: 1, added: [], removed: [], resized: [], dust: [], source: "t", ...over });
  const rs = (symbol: string, from: number, to: number) => ({ name: symbol, symbol, from, to, pct: Math.round((to / from - 1) * 1000) / 10, totalUsd: 1 });

  it("names what was sized the same way on updates running, and ends a run on a quiet update or a turn", () => {
    const s = sigilStreaks([
      ch("2026-11-01", { resized: [rs("SOL", 100, 50), rs("ETH", 10, 12)] }),
      ch("2026-11-02", { resized: [rs("SOL", 50, 44), rs("ETH", 12, 10)] }),
      ch("2026-11-03", { resized: [rs("SOL", 44, 40.5)] }),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ symbol: "SOL", direction: "down", live: true, from: 100, to: 40.5, totalPct: -59.5 });
    expect(s[0].steps.map((x) => x.pct)).toEqual([-50, -12, -8]);
    // A quiet update in between: two separate single moves, no streak.
    expect(sigilStreaks([ch("2026-11-01", { resized: [rs("SOL", 100, 50)] }), ch("2026-11-02", {}), ch("2026-11-03", { resized: [rs("SOL", 50, 40)] })])).toEqual([]);
  });

  it("counts an opening then an add as a build, and a cut then a close as an exit that has ended", () => {
    const s = sigilStreaks([
      ch("2026-11-01", { added: [{ name: "GNO", symbol: "GNO", amount: 5, totalUsd: 500 }], resized: [rs("USDT", 1000, 800)] }),
      ch("2026-11-02", { resized: [rs("GNO", 5, 9)], removed: [{ name: "USDT", symbol: "USDT", amount: 800, totalUsd: 800 }] }),
      ch("2026-11-03", {}),
    ]);
    expect(s.find((x) => x.symbol === "GNO")).toMatchObject({ direction: "up", live: false, from: 0, to: 9 });
    expect(s.find((x) => x.symbol === "USDT")).toMatchObject({ direction: "down", ended: "removed", live: false });
  });
});

it("keeps one history point a day and the newest 120", () => {
  const pts = Array.from({ length: 125 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), valueUsd: i }));
  const out = withHistoryPoint(pts, { date: pts[124].date, valueUsd: 999 });
  expect(out).toHaveLength(120);
  expect(out[119]).toEqual({ date: pts[124].date, valueUsd: 999 });
});

describe("what a model says about an asset", () => {
  it("is vetted before it is kept", async () => {
    const { vetEnriched, lastJsonObject } = await import("../server/sigil");
    const good = { tldr: "Solana liquid staking token.", kind: "token", segment: "Liquid staking", eco: "Solana", chain: "solana", slug: "sol", ca: "So111", link: "https://www.defined.fi/token/sol/So111", foundPriceUsd: 10.2 };
    expect(lastJsonObject(`I searched. {"note":1} Final: ${JSON.stringify(good)}`)).toEqual(good);
    expect(lastJsonObject("no json here")).toBeNull();
    expect(vetEnriched(good, 10)).toMatchObject({ segment: "Liquid staking", link: good.link, flagged: null });
    // A copycat: the token found trades far from the tracker's price.
    const fake = vetEnriched(good, 0.01)!;
    expect(fake.link).toBeNull();
    expect(fake.tldr).toMatch(/\(unverified\)$/);
    expect(vetEnriched({ ...good, segment: "Vibes", eco: "Plasma", link: "javascript:alert(1)" }, 10)).toMatchObject({ segment: null, eco: "Plasma", link: null, flagged: expect.stringMatching(/segment "Vibes".*new ecosystem label "Plasma"/) });
    expect(vetEnriched({ tldr: "x" }, 1)).toBeNull();
  });
});

/** A zip with its entries stored as they are: enough for the reader, which does not check sums. */
function zipOf(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name);
    const d = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(d.length, 18);
    local.writeUInt32LE(d.length, 22);
    local.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt32LE(d.length, 20);
    c.writeUInt32LE(d.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    locals.push(local, n, d);
    central.push(c, n);
    offset += 30 + n.length + d.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

describe.skipIf(!DB)("Sigil Core on the server", () => {
  beforeEach(async () => {
    const { sigilStore, initSchema } = await import("../server/storage");
    await initSchema();
    await sigilStore.clear();
  });

  it("takes a day in, compares it with the day before, and replaces a day sent twice", async () => {
    const { takeUpload, sigilState } = await import("../server/sigil");
    const first = await takeUpload(DAY1, NAME("2026-11-12"));
    expect(first.change.status).toBe("baseline");
    const second = await takeUpload(DAY2, NAME("2026-11-15"));
    expect(second.day).toBe("2026-11-15");
    expect(second.change.resized.map((r) => r.symbol)).toEqual(["EUR"]);
    expect(second.report[0]).toBe("Sigil Core — 2026-11-15: 2 changes");

    // The same file again, later the same day: compared with the 12th again, not with itself.
    const again = await takeUpload(DAY2, NAME("2026-11-15", "14_00_00.000"));
    expect(again.change.resized).toEqual(second.change.resized);
    expect(again.change.added).toEqual(second.change.added);
    const st = await sigilState();
    expect(st.history.map((h) => h.date)).toEqual(["2026-11-12", "2026-11-15"]);
    expect(st.changes.map((c) => c.date)).toEqual(["2026-11-15", "2026-11-12"]);
    expect(st.latest?.capturedAt).toBe("2026-11-15T14:00:00.000Z");
    expect(st.previous).toEqual({ day: "2026-11-12", valueUsd: first.change.portfolioValueUsd });
  });

  it("writes nothing for a file it refuses", async () => {
    const { takeUpload, sigilState } = await import("../server/sigil");
    await expect(takeUpload("%PDF-1.7", NAME("2026-11-12"))).rejects.toThrow(SigilRefused);
    await expect(takeUpload("a;b;c\n1;2;3", NAME("2026-11-12"))).rejects.toThrow(/not a Crypkit portfolio table/);
    const st = await sigilState();
    expect(st.latest).toBeNull();
    expect(st.history).toEqual([]);
  });

  it("loads a seed pack from a zip, twice the same, and keeps what the owner wrote since", async () => {
    const { importSeed, unzip, sigilState } = await import("../server/sigil");
    const { sigilStore } = await import("../server/storage");
    const snap = parseCrypkitCsv(DAY1, NAME("2026-11-12"));
    const pack = zipOf({
      "sigil-core-seed/state/latest.json": JSON.stringify(snap),
      "sigil-core-seed/snapshots/2026-11-12.json": JSON.stringify(snap),
      "sigil-core-seed/state/history.json": JSON.stringify({ points: [{ date: "2026-11-11", valueUsd: 30000, positionCount: 7 }, { date: "2026-11-12", valueUsd: snap.portfolioValueUsd, positionCount: 7 }] }),
      "sigil-core-seed/state/assets.json": JSON.stringify({ watchlistName: "sigil", items: { BTC: { tldr: "Bitcoin.", kind: "token", segment: "L1 / L2", eco: "Bitcoin", link: null }, META: { tldr: "MetaDAO.  (unverified)", segment: "Launchpad", eco: "Solana" } } }),
      "sigil-core-seed/changes/2026-11-11.json": JSON.stringify({ date: "2026-11-11", status: "ok", portfolioValueUsd: 30000, positionCount: 7, added: [], removed: [], resized: [], dust: [], note: "Manual run." }),
      "sigil-core-seed/reference/diff_reference.py": "print('not run')",
    });
    const files = unzip(pack);
    expect(Array.from(files.keys())).toContain("sigil-core-seed/state/latest.json");
    expect(await importSeed(files)).toEqual({ snapshots: 1, changes: 1, history: 2, assets: 2 });

    await sigilStore.putAsset("BTC", JSON.stringify({ segment: "Privacy", eco: "Bitcoin", edited: true }));
    expect(await importSeed(files)).toEqual({ snapshots: 1, changes: 1, history: 2, assets: 1 });
    const st = await sigilState();
    expect(st.assets.BTC.segment).toBe("Privacy");
    expect(st.assets.META.note).toMatch(/Open question/);
    expect(st.changes[0].notes).toEqual(["Manual run."]);
    expect(st.history).toHaveLength(2);
    expect(st.watchlist).toEqual({ watchlistName: "sigil" });
    expect(() => unzip(Buffer.from("not a zip at all, just text"))).toThrow(SigilRefused);
  });

  it("serves the owner only, takes an upload over the API, and takes a push only with the token", async () => {
    const express = (await import("express")).default;
    const { registerSigilRoutes, registerSigilPush } = await import("../server/sigil");
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    registerSigilPush(app);
    app.use((req: any, _res, next) => {
      req.account = req.headers["x-owner"] ? { isOwner: true } : { isOwner: false };
      req.userId = 1;
      next();
    });
    registerSigilRoutes(app);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const owner = { "Content-Type": "application/json", "x-owner": "1" };
    try {
      expect((await fetch(`${base}/api/sigil`)).status).toBe(404);
      const bad = await fetch(`${base}/api/sigil/upload`, { method: "POST", headers: owner, body: JSON.stringify({ filename: "notes.pdf", text: "%PDF" }) });
      expect(bad.status).toBe(400);
      expect((await bad.json()).message).toMatch(/carries no time/);
      const ok = await fetch(`${base}/api/sigil/upload`, { method: "POST", headers: owner, body: JSON.stringify({ filename: NAME("2026-11-12"), text: DAY1 }) });
      expect(ok.status).toBe(200);
      expect((await ok.json()).report[0]).toMatch(/first snapshot/);

      const edit = await fetch(`${base}/api/sigil/assets/BTC`, { method: "PUT", headers: owner, body: JSON.stringify({ segment: "L1 / L2", eco: "Bitcoin", note: "core" }) });
      expect(await edit.json()).toMatchObject({ segment: "L1 / L2", note: "core", edited: true });
      expect((await fetch(`${base}/api/sigil/assets/BTC`, { method: "PUT", headers: owner, body: JSON.stringify({ link: "ftp://x" }) })).status).toBe(400);

      const push = (token?: string) => fetch(`${base}/api/sigil/push?filename=${NAME("2026-11-15")}`, { method: "POST", headers: { "Content-Type": "text/csv", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: DAY2 });
      delete process.env.SIGIL_UPLOAD_TOKEN;
      expect((await push("anything")).status).toBe(404);
      process.env.SIGIL_UPLOAD_TOKEN = "a-long-personal-token-for-the-test";
      expect((await push("wrong")).status).toBe(401);
      expect((await push()).status).toBe(401);
      const pushed = await push("a-long-personal-token-for-the-test");
      expect(pushed.status).toBe(200);
      expect((await pushed.json()).report[0]).toBe("Sigil Core — 2026-11-15: 2 changes");
    } finally {
      delete process.env.SIGIL_UPLOAD_TOKEN;
      await new Promise((r) => server.close(r));
    }
  });
});

/** The owner's real pack, when it is at hand: the table the request gave. */
describe.skipIf(!DB || !SEED)("the owner's own exports", () => {
  const read = (p: string) => fs.readFileSync(path.join(SEED!, p), "utf8");
  const F13 = "Crypkit_portfolio-table_2026-11-13T10_31_53.519Z.csv";
  const F15 = "Crypkit_portfolio-table_2026-11-15T10_40_12.929Z.csv";

  it("reproduces the 13th and the 15th, and a second upload of the 15th changes nothing", async () => {
    const { sigilStore, initSchema } = await import("../server/storage");
    const { takeUpload, sigilState } = await import("../server/sigil");
    await initSchema();
    await sigilStore.clear();
    const s12 = JSON.parse(read("snapshots/2026-11-12.json"));
    await sigilStore.putSnapshot("2026-11-12", s12.capturedAt, JSON.stringify(s12));
    await sigilStore.putHistory("2026-11-12", s12.portfolioValueUsd, s12.positionCount);

    const a = await takeUpload(read(`fixtures/${F13}`), F13);
    expect(a.change.positionCount).toBe(94);
    expect(a.change.portfolioValueUsd).toBeCloseTo(34694.28, 2);
    expect(a.change.resized).toEqual([expect.objectContaining({ symbol: "EUR", pct: -23.6 })]);
    expect(a.change.resized[0].from).toBeCloseTo(81.4, 1);
    expect(a.change.resized[0].to).toBeCloseTo(62.19, 2);
    expect([a.change.added, a.change.removed, a.change.dust]).toEqual([[], [], []]);

    const b = await takeUpload(read(`fixtures/${F15}`), F15);
    expect(b.change.positionCount).toBe(91);
    expect(b.change.portfolioValueUsd).toBeCloseTo(32487.92, 2);
    expect(b.change.resized).toEqual([expect.objectContaining({ symbol: "SLC", pct: 22.6 })]);
    expect(b.change.dust.map((d) => `${d.symbol}:${d.direction}`).sort()).toEqual(["ANSEM:out", "FAI:out", "HONEY:out"]);
    expect(b.change.notes?.[0]).toMatch(/spans 2 days/);
    expect((await sigilState()).latest?.dustTotalUsd).toBeCloseTo(119.84, 2);
    expect(JSON.parse((await sigilStore.snapshot("2026-11-15"))!).positions).toEqual(JSON.parse(read("snapshots/2026-11-15.json")).positions);

    const again = await takeUpload(read(`fixtures/${F15}`), F15);
    expect(again.change).toEqual(b.change);
    const st = await sigilState();
    expect(st.history.map((h) => h.date)).toEqual(["2026-11-12", "2026-11-13", "2026-11-15"]);
    expect(st.changes.filter((c) => c.date === "2026-11-15")).toHaveLength(1);
  });

  it("loads the whole pack", async () => {
    const { sigilStore } = await import("../server/storage");
    const { importSeed, sigilState } = await import("../server/sigil");
    await sigilStore.clear();
    const files = new Map<string, Buffer>();
    const walk = (dir: string) => fs.readdirSync(path.join(SEED!, dir), { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : files.set(path.join("sigil-core-seed", dir, e.name).replace(/\\/g, "/"), fs.readFileSync(path.join(SEED!, dir, e.name)))));
    walk("");
    const done = await importSeed(files);
    expect(done).toEqual(await importSeed(files));
    expect(done.snapshots).toBe(3);
    expect(done.changes).toBe(34);
    const st = await sigilState();
    expect(st.latest?.day).toBe("2026-11-15");
    expect(st.latest?.positionCount).toBe(91);
    expect(st.previous).toEqual({ day: "2026-11-13", valueUsd: 34694.28 });
    expect(st.assets.META.note).toMatch(/1000×/);
    expect(st.assets.LONG.note).toMatch(/Robinhood Chain/);
    expect(Object.keys(st.assets).length).toBe(124);
  });
});
