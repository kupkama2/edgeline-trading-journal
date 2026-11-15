/**
 * Sigil Core on the server: taking a day's export in, keeping every day,
 * and describing the assets nobody has described yet.
 *
 * An upload is read and compared by plain code (shared/sigil.ts) and saved
 * in one transaction: the snapshot, the day's change record, the day's
 * point in the value history. Only then, and in the background, a model is
 * asked about any asset with no description. That part can fail, be slow or
 * be switched off (no ANTHROPIC_API_KEY) without the upload noticing: the
 * asset simply stays "Uncategorized" until someone fills it in.
 *
 * Everything is the owner's alone. The one door that takes no session is
 * the push endpoint, which takes a personal token instead (SIGIL_UPLOAD_TOKEN)
 * so a script or a phone shortcut can send the morning's file.
 */
import type { Express, Request, Response } from "express";
import express from "express";
import { inflateRawSync } from "node:zlib";
import { timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { adminOnly } from "./admin";
import { sigilStore } from "./storage";
import { notifyAll } from "./events";
import {
  HISTORY_KEEP,
  SIGIL_ECOS,
  SIGIL_KINDS,
  SIGIL_SEGMENTS,
  SIGIL_SLUGS,
  SigilRefused,
  UNVERIFIED,
  diffSnapshots,
  needsEnriching,
  parseCrypkitCsv,
  pragueDay,
  sigilGroups,
  sigilMovers,
  sigilReport,
  type SigilAsset,
  type SigilChange,
  type SigilPosition,
  type SigilSnapshot,
} from "@shared/sigil";

const AI_MODEL = process.env.SIGIL_AI_MODEL || "claude-opus-5-5";
/** How many assets one upload may have described: a first upload with a hundred unknown names is not a hundred searches. */
const ENRICH_PER_UPLOAD = 12;
const MAX_UPLOAD_BYTES = 2_000_000;

const parse = <T,>(s: string | null): T | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

export async function sigilAssets(): Promise<Record<string, SigilAsset>> {
  const raw = await sigilStore.assets();
  const out: Record<string, SigilAsset> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = parse<SigilAsset>(v) ?? {};
  return out;
}

/* --------------------------------- upload --------------------------------- */

export interface SigilUploadResult {
  day: string;
  change: SigilChange;
  report: string[];
  /** Symbols a model is about to be asked about. */
  enriching: string[];
}

/**
 * Take an export in. Throws SigilRefused for a file that is not one, before
 * anything is written. The day is compared with the newest stored snapshot
 * of an EARLIER day, so sending today's file again replaces today's record
 * instead of comparing the file with itself.
 */
export async function takeUpload(text: string, filename: string): Promise<SigilUploadResult> {
  const snapshot = parseCrypkitCsv(text, filename);
  const day = pragueDay(snapshot.capturedAt);
  const prevRow = await sigilStore.before(day);
  const prev = prevRow ? parse<SigilSnapshot>(prevRow.body) : null;
  const change = diffSnapshots(prev, snapshot, day, prevRow?.day ?? null);
  await sigilStore.saveDay({ day, capturedAt: snapshot.capturedAt, snapshot: JSON.stringify(snapshot), change: JSON.stringify(change), value: snapshot.portfolioValueUsd, count: snapshot.positionCount, keep: HISTORY_KEEP });

  const assets = await sigilAssets();
  const missing = snapshot.positions.filter((p) => needsEnriching(assets[p.symbol]) && !assets[p.symbol]?.edited).slice(0, ENRICH_PER_UPLOAD);
  const report = sigilReport(change, { previousValueUsd: prev?.portfolioValueUsd ?? null, movers: sigilMovers(snapshot.positions) });
  notifyAll("sigil");
  // The upload is done; describing new names and reading the day follow on their own.
  void afterUpload(day, snapshot, change, missing).catch((err) => console.error(`[sigil] after upload: ${String(err?.message ?? err).slice(0, 200)}`));
  return { day, change, report, enriching: missing.map((p) => p.symbol) };
}

/* ------------------------------- enrichment ------------------------------- */

let client: Anthropic | undefined;
const enriching = new Set<string>();
let lastEnrichError: string | null = null;
export const sigilAiEnabled = (): boolean => !!process.env.ANTHROPIC_API_KEY;
export const sigilEnrichStatus = () => ({ enabled: sigilAiEnabled(), running: Array.from(enriching), error: lastEnrichError });

const ENRICH_SYSTEM = `You identify one asset held in a crypto fund's portfolio and describe it for a holdings table. Search the web to find it. Answer with one JSON object and nothing else:
{"tldr": string, "kind": string, "segment": string, "eco": string, "chain": string|null, "slug": string|null, "ca": string|null, "link": string|null, "foundPriceUsd": number|null}

tldr: about 110 characters, factual, what it is. No price talk, no opinion.
kind: one of ${SIGIL_KINDS.filter((k) => k !== "fiat").join(", ")}.
segment: exactly one of ${SIGIL_SEGMENTS.join(" · ")}.
eco: the chain's display name (${SIGIL_ECOS.slice(0, 13).join(", ")}…), or a native L1's own name (Bitcoin, Zcash, NEAR, Cosmos, Polkadot, Bittensor, Energy Web, Aleo, Celestia), or Multichain for major stablecoins and infrastructure, Equities for listed stocks, Private deals, Fiat, or Unknown.
Precedents: wrapped or staked HYPE is Hyperliquid. Memecoin launchpads (Pons, Pump.fun) are Launchpad. AI-themed memecoins are Memecoin. Bittensor subnet tokens are AI / Bittensor.
link: a chart link. For a token with a DEX market: https://www.defined.fi/token/<slug>/<contract>, slug one of ${SIGIL_SLUGS.join(", ")}. For a listed stock: its TradingView page. For an L1 with no DEX market: its CoinGecko page. For a private allocation or fiat: null.
ca: the token's contract address on that chain, or null.
foundPriceUsd: the current USD price of the token you identified, or null if you could not find one.

DEX search results are full of copycats with fake liquidity. Choose by project name, chain and 24-hour volume, never by liquidity. You are given the price the fund's tracker shows: the token you pick should trade near it. If you cannot tell which token it is, say so in the tldr and give link null.`;

const enrichedSchema = z.object({
  tldr: z.string().trim().min(1).max(400),
  kind: z.string().trim().max(40),
  segment: z.string().trim().max(40),
  eco: z.string().trim().max(40),
  chain: z.string().trim().max(40).nullable().optional(),
  slug: z.string().trim().max(40).nullable().optional(),
  ca: z.string().trim().max(120).nullable().optional(),
  link: z.string().trim().max(300).nullable().optional(),
  foundPriceUsd: z.number().positive().nullable().optional(),
});

/** The last JSON object in a reply: the model searches first and may say so before answering. */
export function lastJsonObject(text: string): unknown | null {
  for (let start = text.lastIndexOf("{"); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    const end = text.lastIndexOf("}");
    if (end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* an inner brace: try the one before */
    }
  }
  return null;
}

/**
 * A model's answer made safe to store: a segment outside the list is not
 * taken, an ecosystem outside it is taken and flagged, a link that is not a
 * web address is dropped, and a token trading more than twice away from the
 * tracker's own price loses its link and is marked unverified.
 */
export function vetEnriched(raw: unknown, csvPriceUsd: number | null): SigilAsset | null {
  const got = enrichedSchema.safeParse(raw);
  if (!got.success) return null;
  const a = got.data;
  const flags: string[] = [];
  const segment = (SIGIL_SEGMENTS as readonly string[]).includes(a.segment) ? a.segment : null;
  if (!segment) flags.push(`segment "${a.segment}" is not one of the list`);
  if (!(SIGIL_ECOS as readonly string[]).includes(a.eco)) flags.push(`new ecosystem label "${a.eco}"`);
  let link = a.link && /^https:\/\/[^\s"<>]+$/.test(a.link) ? a.link : null;
  let tldr = a.tldr.replace(/\s+/g, " ").slice(0, 300);
  const found = a.foundPriceUsd ?? null;
  if (found != null && csvPriceUsd != null && csvPriceUsd > 0) {
    const ratio = found / csvPriceUsd;
    if (ratio > 2 || ratio < 0.5) {
      link = null;
      if (!tldr.includes(UNVERIFIED)) tldr = `${tldr}  ${UNVERIFIED}`;
      flags.push("the token found trades more than twice away from the tracker's price");
    }
  }
  return {
    tldr,
    kind: (SIGIL_KINDS as readonly string[]).includes(a.kind) ? a.kind : "token",
    segment,
    eco: a.eco,
    chain: a.chain || null,
    slug: a.slug && (SIGIL_SLUGS as readonly string[]).includes(a.slug) ? a.slug : null,
    ca: a.ca || null,
    link,
    flagged: flags.length ? flags.join("; ") : null,
  };
}

/** Ask a model what an asset is, and store the answer. The owner's own note, and an entry they edited, are kept. */
export async function enrichAsset(p: Pick<SigilPosition, "name" | "symbol" | "priceUsd" | "totalUsd">, opts: { force?: boolean } = {}): Promise<SigilAsset | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || enriching.has(p.symbol)) return null;
  enriching.add(p.symbol);
  try {
    const before = (await sigilAssets())[p.symbol];
    if (before?.edited && !opts.force) return before;
    if (!client) client = new Anthropic({ apiKey: key });
    const res = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 4096,
      system: ENRICH_SYSTEM,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
      messages: [{ role: "user", content: `Asset as the tracker names it: "${p.name}". Symbol: ${p.symbol}. Tracker's price: ${p.priceUsd ?? "unknown"} USD. Today is ${new Date().toISOString().slice(0, 10)}.` }],
    } as any);
    const text = (res as any).content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    const vetted = vetEnriched(lastJsonObject(text), p.priceUsd);
    if (!vetted) throw new Error(`${p.symbol}: the reply was not the description asked for`);
    const next: SigilAsset = { ...vetted, note: before?.note ?? null };
    await sigilStore.putAsset(p.symbol, JSON.stringify(next));
    lastEnrichError = null;
    return next;
  } catch (err: any) {
    lastEnrichError = String(err?.message ?? err).slice(0, 240);
    console.error(`[sigil] enrich ${p.symbol}: ${lastEnrichError}`);
    return null;
  } finally {
    enriching.delete(p.symbol);
    notifyAll("sigil");
  }
}

/** One line on what the day's changes look like, from a model. Skipped without a key, on a quiet day, or on any failure. */
async function readTheDay(day: string, snapshot: SigilSnapshot, change: SigilChange): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || change.status !== "ok" || change.added.length + change.removed.length + change.resized.length === 0) return;
  if (!client) client = new Anthropic({ apiKey: key });
  const assets = await sigilAssets();
  const brief = (gs: ReturnType<typeof sigilGroups>) => gs.slice(0, 8).map((g) => ({ group: g.key, valueUsd: Math.round(g.valueUsd), roi24h: g.roi24h == null ? null : Number(g.roi24h.toFixed(1)) }));
  const res = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 300,
    system: "You are given what changed in a crypto fund's holdings since its previous snapshot, by token amount, and how its groups moved in price. Write ONE plain sentence, at most 30 words, on what the changes look like taken together (a rotation, a build, an exit, a trim). Say only what the numbers support; if nothing stands out, say so. No advice, no preamble.",
    messages: [{ role: "user", content: JSON.stringify({ added: change.added, removed: change.removed, resized: change.resized, notes: change.notes ?? [], bySegment: brief(sigilGroups(snapshot.positions, assets, "segment")), byEco: brief(sigilGroups(snapshot.positions, assets, "eco")) }) }],
  });
  const line = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b as any).text as string)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  if (!line) return;
  // The record may have been replaced by a newer upload of the same day while this ran: read it again before writing.
  const now = parse<SigilChange>(await sigilStore.change(day));
  if (!now) return;
  await sigilStore.putChange(day, JSON.stringify({ ...now, aiRead: line }));
}

async function afterUpload(day: string, snapshot: SigilSnapshot, change: SigilChange, missing: SigilPosition[]): Promise<void> {
  if (!sigilAiEnabled()) return;
  for (const p of missing) await enrichAsset(p);
  await readTheDay(day, snapshot, change).catch((err) => console.error(`[sigil] read of the day: ${String(err?.message ?? err).slice(0, 200)}`));
  notifyAll("sigil");
}

/* ---------------------------------- seed ---------------------------------- */

/** The files of a zip archive, by path. Stored and deflated entries only, which is all an ordinary archive holds. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // The directory sits at the end; its record is found by its signature, searching back past any comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SigilRefused("That is not a zip archive.");
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let i = 0; i < count && i < 2000; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new SigilRefused("The zip archive's directory cannot be read.");
    const method = buf.readUInt16LE(at + 10);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    total += size;
    if (size > 20_000_000 || total > 60_000_000) throw new SigilRefused("The archive is far larger than a seed pack.");
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new SigilRefused(`The archive's entry ${name} cannot be read.`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + packed);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: 20_000_000 }));
    else throw new SigilRefused(`The archive's entry ${name} is packed in a way this cannot open.`);
  }
  return out;
}

/** The open questions the owner wants kept in view: written into an asset's note when it has none. */
const SEED_NOTES: Record<string, string> = {
  META: "Open question: Crypkit prices MetaDAO around $3–6 while the real META trades about 1000× higher. Left unlinked.",
  LONG: "Open question: linked to the Arc contract but unverified; public write-ups say Robinhood Chain.",
};

export interface SeedResult {
  snapshots: number;
  changes: number;
  history: number;
  assets: number;
}

/**
 * Load a seed pack: the files of sigil-core-seed, by path. Loading it twice
 * leaves the same rows. An asset the owner has edited since is not
 * overwritten, and a note already written is kept.
 */
export async function importSeed(files: Map<string, Buffer>): Promise<SeedResult> {
  const byTail = (tail: RegExp) => Array.from(files.entries()).filter(([k]) => tail.test(k));
  const json = <T,>(b: Buffer): T | null => parse<T>(b.toString("utf8").replace(/^﻿/, ""));
  const unwrap = (o: any) => (o && typeof o === "object" && o.data && typeof o.data === "object" ? o.data : o);
  const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const out: SeedResult = { snapshots: 0, changes: 0, history: 0, assets: 0 };

  const snaps = [...byTail(/(^|\/)snapshots\/\d{4}-\d{2}-\d{2}\.json$/), ...byTail(/(^|\/)state\/latest\.json$/)];
  for (const [, b] of snaps) {
    const s = unwrap(json<any>(b)) as SigilSnapshot | null;
    if (!s || !Array.isArray(s.positions) || !isDay(s.asOf)) continue;
    const capturedAt = typeof s.capturedAt === "string" && Number.isFinite(new Date(s.capturedAt).getTime()) ? s.capturedAt : `${s.asOf}T12:00:00.000Z`;
    await sigilStore.putSnapshot(pragueDay(capturedAt), capturedAt, JSON.stringify({ ...s, capturedAt }));
    out.snapshots++;
  }
  // Counted once each: latest.json is usually one of the dated snapshots again.
  out.snapshots = new Set(snaps.map(([, b]) => (unwrap(json<any>(b)) as any)?.asOf).filter(isDay)).size;

  for (const [, b] of byTail(/(^|\/)changes\/\d{4}-\d{2}-\d{2}\.json$/)) {
    const c = unwrap(json<any>(b));
    if (!c || !isDay(c.date)) continue;
    // Older records carry one free-text "note"; the page reads a list.
    const notes = [...(Array.isArray(c.notes) ? c.notes : []), ...(typeof c.note === "string" && c.note.trim() ? [c.note] : [])].filter((n) => typeof n === "string");
    const { note: _note, ...rest } = c;
    const change: SigilChange = { status: "ok", added: [], removed: [], resized: [], dust: [], source: "seed", ...rest, ...(notes.length ? { notes } : {}) };
    // A day uploaded since the pack was made is newer than the pack: left alone.
    const have = parse<SigilChange>(await sigilStore.change(c.date));
    if (!have || have.source === "seed" || have.source === change.source) await sigilStore.putChange(c.date, JSON.stringify({ ...change, aiRead: have?.aiRead ?? change.aiRead ?? null }));
    out.changes++;
  }

  for (const [, b] of byTail(/(^|\/)state\/history\.json$/)) {
    const pts = (unwrap(json<any>(b))?.points ?? []) as { date: string; valueUsd: number; positionCount: number }[];
    for (const p of pts.slice(-HISTORY_KEEP)) {
      if (!isDay(p.date) || !Number.isFinite(p.valueUsd)) continue;
      await sigilStore.putHistory(p.date, p.valueUsd, Number(p.positionCount) || 0);
      out.history++;
    }
  }

  for (const [, b] of byTail(/(^|\/)state\/assets\.json$/)) {
    const doc = unwrap(json<any>(b)) ?? {};
    const have = await sigilAssets();
    for (const [symbol, raw] of Object.entries((doc.items ?? {}) as Record<string, any>)) {
      if (have[symbol]?.edited) continue;
      const a: SigilAsset = { tldr: raw.tldr ?? null, kind: raw.kind ?? null, segment: raw.segment ?? null, eco: raw.eco ?? null, chain: raw.chain ?? null, slug: raw.slug ?? null, ca: raw.ca ?? null, link: raw.link ?? null, note: have[symbol]?.note ?? raw.note ?? SEED_NOTES[symbol] ?? null };
      await sigilStore.putAsset(symbol, JSON.stringify(a));
      out.assets++;
    }
    const { items: _items, ...meta } = doc;
    await sigilStore.putMeta("watchlist", JSON.stringify(meta));
  }
  notifyAll("sigil");
  return out;
}

/* --------------------------------- routes --------------------------------- */

export interface SigilState {
  latest: (SigilSnapshot & { day: string }) | null;
  /** The snapshot the latest one was compared with: its day and value. */
  previous: { day: string; valueUsd: number } | null;
  history: { date: string; valueUsd: number; positionCount: number }[];
  changes: SigilChange[];
  assets: Record<string, SigilAsset>;
  watchlist: Record<string, unknown> | null;
  /** What the owner put in: the figure the value is measured against. Null until they say. */
  entryUsd: number | null;
  enrich: ReturnType<typeof sigilEnrichStatus>;
  lists: { segments: readonly string[]; ecos: readonly string[]; kinds: readonly string[] };
}

export async function sigilState(): Promise<SigilState> {
  const row = await sigilStore.latest();
  const latest = row ? parse<SigilSnapshot>(row.body) : null;
  const prevRow = row ? await sigilStore.before(row.day) : null;
  const prev = prevRow ? parse<SigilSnapshot>(prevRow.body) : null;
  const history = await sigilStore.history();
  // With no earlier snapshot kept, the day before in the value history still says what it was worth.
  const before = row ? history.filter((h) => h.date < row.day).slice(-1)[0] : undefined;
  return {
    latest: latest && row ? { ...latest, day: row.day } : null,
    previous: prev && prevRow ? { day: prevRow.day, valueUsd: prev.portfolioValueUsd } : before ? { day: before.date, valueUsd: before.valueUsd } : null,
    history,
    changes: (await sigilStore.changes()).map((b) => parse<SigilChange>(b)).filter((c): c is SigilChange => !!c),
    assets: await sigilAssets(),
    watchlist: parse<Record<string, unknown>>(await sigilStore.meta("watchlist")),
    entryUsd: parse<{ valueUsd: number }>(await sigilStore.meta("entry"))?.valueUsd ?? null,
    enrich: sigilEnrichStatus(),
    lists: { segments: SIGIL_SEGMENTS, ecos: SIGIL_ECOS, kinds: SIGIL_KINDS },
  };
}

const uploadSchema = z.object({ filename: z.string().trim().min(1).max(200), text: z.string().min(1).max(MAX_UPLOAD_BYTES) });
const assetSchema = z
  .object({
    tldr: z.string().trim().max(400).nullable(),
    kind: z.string().trim().max(40).nullable(),
    segment: z.string().trim().max(40).nullable(),
    eco: z.string().trim().max(40).nullable(),
    link: z
      .string()
      .trim()
      .max(300)
      .regex(/^https:\/\/[^\s"<>]+$/, "A link must start with https://")
      .nullable(),
    note: z.string().trim().max(600).nullable(),
  })
  .partial()
  .strict();

const refuse = (res: Response, err: any) => {
  if (err instanceof SigilRefused) return res.status(400).json({ message: err.message });
  console.error(`[sigil] ${String(err?.message ?? err).slice(0, 300)}`);
  return res.status(500).json({ message: String(err?.message ?? "The upload could not be processed.").slice(0, 300) });
};

/**
 * The push door: the morning's file sent by a script, with a personal token
 * in place of a session. Registered before the sign-in wall. Off, answering
 * 404, until SIGIL_UPLOAD_TOKEN is set to something long enough to be one.
 *
 *   curl -X POST "https://<host>/api/sigil/push?filename=Crypkit_portfolio-table_2026-11-15T10_40_12.929Z.csv" \
 *     -H "Authorization: Bearer $SIGIL_UPLOAD_TOKEN" -H "Content-Type: text/csv" --data-binary @export.csv
 */
export function registerSigilPush(app: Express): void {
  app.post("/api/sigil/push", express.text({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (req: Request, res: Response) => {
    const token = process.env.SIGIL_UPLOAD_TOKEN ?? "";
    if (token.length < 24) return res.status(404).json({ message: "Not found" });
    const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return res.status(401).json({ message: "Wrong token." });
    const filename = String(req.query.filename ?? "");
    if (typeof req.body !== "string" || !req.body) return res.status(400).json({ message: "Send the file as the request body." });
    try {
      const r = await takeUpload(req.body, filename);
      res.json({ day: r.day, report: r.report });
    } catch (err) {
      refuse(res, err);
    }
  });
}

export function registerSigilRoutes(app: Express): void {
  app.use("/api/sigil", adminOnly);

  app.get("/api/sigil", async (_req: Request, res: Response) => {
    res.json(await sigilState());
  });

  app.post("/api/sigil/upload", async (req: Request, res: Response) => {
    const body = uploadSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "Send the export's name and its text." });
    try {
      res.json(await takeUpload(body.data.text, body.data.filename));
    } catch (err) {
      refuse(res, err);
    }
  });

  /** Load a seed pack, sent as a zip in base64. Safe to send twice. */
  app.post("/api/sigil/seed", async (req: Request, res: Response) => {
    const body = z.object({ zip: z.string().min(1).max(12_000_000) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "Send the seed pack as a zip." });
    try {
      const files = unzip(Buffer.from(body.data.zip, "base64"));
      const done = await importSeed(files);
      if (done.snapshots + done.changes + done.history + done.assets === 0) return res.status(400).json({ message: "The archive holds none of a seed pack's files (state/, changes/, snapshots/)." });
      res.json(done);
    } catch (err) {
      refuse(res, err);
    }
  });

  /** What the owner put into the fund, to measure its value against; null takes it away. */
  app.put("/api/sigil/entry", async (req: Request, res: Response) => {
    const body = z.object({ valueUsd: z.number().positive().max(1e12).nullable() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "The entry is an amount in dollars, above zero." });
    await sigilStore.putMeta("entry", JSON.stringify(body.data.valueUsd == null ? {} : { valueUsd: body.data.valueUsd }));
    notifyAll("sigil");
    res.json({ entryUsd: body.data.valueUsd });
  });

  app.put("/api/sigil/assets/:symbol", async (req: Request, res: Response) => {
    const symbol = String(req.params.symbol).slice(0, 60);
    const body = assetSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: body.error.issues[0]?.message ?? "Invalid asset" });
    const have = (await sigilAssets())[symbol] ?? {};
    const blank = (v: string | null | undefined) => (v == null || v === "" ? null : v);
    const next: SigilAsset = { ...have, ...Object.fromEntries(Object.entries(body.data).map(([k, v]) => [k, blank(v as string | null)])), edited: true, flagged: null };
    await sigilStore.putAsset(symbol, JSON.stringify(next));
    notifyAll("sigil");
    res.json(next);
  });

  /** Ask the model about one asset again, over whatever is stored: answered at once, the page hears when it lands. */
  app.post("/api/sigil/assets/:symbol/enrich", async (req: Request, res: Response) => {
    if (!sigilAiEnabled()) return res.status(400).json({ message: "No ANTHROPIC_API_KEY on the server." });
    const symbol = String(req.params.symbol);
    const row = await sigilStore.latest();
    const p = (row ? parse<SigilSnapshot>(row.body) : null)?.positions.find((x) => x.symbol === symbol);
    if (!p) return res.status(404).json({ message: "That asset is not in the latest snapshot." });
    if (enriching.has(symbol)) return res.status(429).json({ message: "Already being read." });
    void enrichAsset(p, { force: true });
    res.json({ started: true });
  });
}
