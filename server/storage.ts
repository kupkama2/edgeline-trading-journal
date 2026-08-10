import {
  trades,
  mistakeTags,
  tradeMistakes,
  weeklyReviews,
  tradingStyles,
  dailyNotes,
  tradeImages,
  tradeFills,
  accountSettings,
} from "@shared/schema";
import type {
  InsertTrade,
  UpdateTrade,
  MistakeTag,
  InsertMistakeTag,
  TradeWithTags,
  WeeklyReview,
  InsertWeeklyReview,
  TradingStyle,
  InsertTradingStyle,
  DailyNote,
  TradeImage,
  TradeFill,
  AccountSettings,
  UpsertAccountSettings,
} from "@shared/schema";
import { DEMON_TAXONOMY, DEMON_LEGACY_ALIASES } from "@shared/demons";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, desc, sql as sqlx } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and add your Postgres connection string.",
  );
}

/**
 * Drop query parameters that are libpq client options rather than server
 * settings. postgres.js forwards anything it doesn't recognise as a startup
 * parameter, and Postgres then refuses the connection outright:
 *
 *   unrecognized configuration parameter "channel_binding"
 *
 * Neon puts `channel_binding=require` in the connection string it gives you,
 * so pasting that string in unedited would crash the server on boot. psql and
 * node-postgres both tolerate it, which is why it only breaks here.
 *
 * Stripping is string-level on purpose — round-tripping through URL would
 * re-encode a password containing reserved characters.
 */
const LIBPQ_ONLY_PARAMS = ["channel_binding"];

function stripLibpqOnlyParams(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const kept = url
    .slice(q + 1)
    .split("&")
    .filter((p) => !LIBPQ_ONLY_PARAMS.some((k) => p.toLowerCase().startsWith(`${k}=`)));
  return kept.length ? `${url.slice(0, q)}?${kept.join("&")}` : url.slice(0, q);
}

/* Neon's pooled endpoint is PgBouncer in transaction mode, which can't hold
   prepared statements across checkouts — hence `prepare: false`. */
const sql = postgres(stripLibpqOnlyParams(DATABASE_URL), { prepare: false });

export const db = drizzle(sql);

/**
 * Bootstrap tables. Postgres supports IF NOT EXISTS on both tables and columns,
 * so this stays a single idempotent statement — no migration tooling needed for
 * a single-user database, and no separate ensureColumn() helper.
 */
export async function initSchema() {
  await sql.unsafe(`
CREATE TABLE IF NOT EXISTS trading_styles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'slate',
  sort_order INTEGER NOT NULL DEFAULT 0,
  session_start TEXT,
  session_end TEXT
);
-- The hours each book is supposed to trade; NULL means "no window set".
ALTER TABLE trading_styles ADD COLUMN IF NOT EXISTS session_start TEXT;
ALTER TABLE trading_styles ADD COLUMN IF NOT EXISTS session_end TEXT;
CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  style_id INTEGER,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  size DOUBLE PRECISION NOT NULL,
  size_unit TEXT NOT NULL DEFAULT 'base',
  point_value DOUBLE PRECISION NOT NULL DEFAULT 1,
  entry_price DOUBLE PRECISION NOT NULL,
  -- Nullable: a pending trade is a resting order with no risk defined yet.
  initial_stop DOUBLE PRECISION,
  initial_target DOUBLE PRECISION,
  extra_targets TEXT,
  entry_time TEXT NOT NULL,
  exit_price DOUBLE PRECISION,
  exit_time TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  exit_reason TEXT,
  cancel_reason TEXT,
  would_have_hit_target BOOLEAN,
  mae DOUBLE PRECISION,
  mfe DOUBLE PRECISION,
  no_management_outcome TEXT,
  setup_screenshot TEXT,
  outcome_screenshot TEXT,
  notes TEXT,
  rationale TEXT,
  rationale_tags TEXT,
  playbook TEXT
);
-- Pending trades are resting limit orders with no stop or target yet, so these
-- two columns had to lose NOT NULL. Both DDL statements are no-ops once applied.
ALTER TABLE trades ALTER COLUMN initial_stop DROP NOT NULL;
ALTER TABLE trades ALTER COLUMN initial_target DROP NOT NULL;
-- Existing rows were all sized in contracts/coins, which is exactly 'base'.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS size_unit TEXT NOT NULL DEFAULT 'base';
-- 1 is the correct default for existing rows: it reproduces the previous
-- (unmultiplied) arithmetic exactly, so no historical figure silently shifts.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS point_value DOUBLE PRECISION NOT NULL DEFAULT 1;
-- A trade that never became a position: why, and (if it simply never filled)
-- whether the target would have been reached anyway.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS would_have_hit_target BOOLEAN;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS rationale TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS rationale_tags TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS playbook TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS style_id INTEGER;
-- Planned scale-out levels beyond TP1, as a JSON number[]. NULL = one target.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS extra_targets TEXT;
-- Which account the trade ran in ("Binance Futures", "Apex eval", …).
ALTER TABLE trades ADD COLUMN IF NOT EXISTS account TEXT;
-- Commission paid on the trade, both sides, in dollars. Deducted in metrics.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS fees DOUBLE PRECISION;
-- Green flags: JSON string[] of what went right on the trade.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS highlights TEXT;
-- Execution grades: how the entry, the stop and the exit actually went.
-- NULL = not graded, which is not the same as average and is never counted so.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_grade TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS stop_grade TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_grade TEXT;
-- 'manual_early'/'manual_late' packed a fact (closed by hand) and a judgement
-- (it was mistimed) into one column, so neither could be counted on its own.
-- Split them: the judgement becomes an exit grade, the fact becomes the reason.
-- Lossless, and a no-op on every run after the first.
UPDATE trades SET exit_grade = CASE exit_reason
    WHEN 'manual_early' THEN 'early' ELSE 'late' END
  WHERE exit_reason IN ('manual_early', 'manual_late') AND exit_grade IS NULL;
UPDATE trades SET exit_reason = 'discretion'
  WHERE exit_reason IN ('manual_early', 'manual_late');
-- Fee schedule per account name: maker/taker per side, % of notional or $
-- per contract. Free-standing — an account needs no row to exist on trades.
CREATE TABLE IF NOT EXISTS account_settings (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  fee_mode TEXT NOT NULL DEFAULT 'percent',
  maker_fee DOUBLE PRECISION NOT NULL DEFAULT 0,
  taker_fee DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mistake_tags (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT 'red'
);
CREATE TABLE IF NOT EXISTS trade_mistakes (
  id SERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL,
  mistake_tag_id INTEGER NOT NULL
);
-- Retire the four timing demons into the grade axes that replaced them.
--
-- "Exited Too Soon" and an exit graded early were the same claim in two
-- places, and two places is worse than one: the demon fed streaks and the
-- discipline score while the grade fed the take-profit arithmetic, so ticking
-- one, both, or the wrong one told three different stories about one trade.
--
-- Copy first, delete second: every tick becomes a grade on the matching axis
-- unless that axis was already graded by hand, in which case the hand-set
-- value wins. Only these exact names are touched, so a custom demon that
-- happens to read similarly is left alone. A no-op once the tags are gone.
UPDATE trades t SET entry_grade = 'early'
  FROM trade_mistakes tm JOIN mistake_tags mt ON mt.id = tm.mistake_tag_id
  WHERE tm.trade_id = t.id AND mt.name = 'Entered Too Soon' AND t.entry_grade IS NULL;
UPDATE trades t SET entry_grade = 'late'
  FROM trade_mistakes tm JOIN mistake_tags mt ON mt.id = tm.mistake_tag_id
  WHERE tm.trade_id = t.id AND mt.name = 'Entered Too Late' AND t.entry_grade IS NULL;
UPDATE trades t SET exit_grade = 'early'
  FROM trade_mistakes tm JOIN mistake_tags mt ON mt.id = tm.mistake_tag_id
  WHERE tm.trade_id = t.id AND mt.name = 'Exited Too Soon' AND t.exit_grade IS NULL;
UPDATE trades t SET exit_grade = 'late'
  FROM trade_mistakes tm JOIN mistake_tags mt ON mt.id = tm.mistake_tag_id
  WHERE tm.trade_id = t.id AND mt.name = 'Exited Too Late' AND t.exit_grade IS NULL;
DELETE FROM trade_mistakes WHERE mistake_tag_id IN (
  SELECT id FROM mistake_tags
   WHERE name IN ('Entered Too Soon', 'Entered Too Late', 'Exited Too Soon', 'Exited Too Late')
);
DELETE FROM mistake_tags
 WHERE name IN ('Entered Too Soon', 'Entered Too Late', 'Exited Too Soon', 'Exited Too Late');
CREATE TABLE IF NOT EXISTS weekly_reviews (
  id SERIAL PRIMARY KEY,
  week_start TEXT NOT NULL,
  plans TEXT,
  insights TEXT,
  submitted_at TEXT NOT NULL
);
-- A review can now carry AI insights, a manual plan, or both, so neither is
-- required on its own.
ALTER TABLE weekly_reviews ALTER COLUMN plans DROP NOT NULL;
ALTER TABLE weekly_reviews ADD COLUMN IF NOT EXISTS insights TEXT;
-- One free-form file per trading day; the day's numbers are derived from the
-- trades at read time, so only the written half is stored.
CREATE TABLE IF NOT EXISTS trade_images (
  id SERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- The one query pattern is "images for this trade" — index it.
CREATE INDEX IF NOT EXISTS trade_images_trade_id ON trade_images (trade_id);
CREATE TABLE IF NOT EXISTS trade_fills (
  id SERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  size DOUBLE PRECISION NOT NULL,
  time TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS trade_fills_trade_id ON trade_fills (trade_id);
CREATE TABLE IF NOT EXISTS daily_notes (
  id SERIAL PRIMARY KEY,
  day TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
`);

  await storage.seed();
}

/**
 * Demons (mistake tags). The fixed taxonomy lives in shared/demons.ts; these
 * extras were seeded before the taxonomy existed and are kept as "custom"
 * demons so historical tagging isn't lost.
 */
const LEGACY_EXTRA_TAGS = [
  "Incorrect Stop Placement",
  "Moved Stop Early",
  "Revenge Trade",
  "FOMO Entry",
];

/** Starting points only — renameable and deletable like any other style. */
const DEFAULT_STYLES: { name: string; color: string }[] = [
  { name: "NQ Scalps", color: "amber" },
  { name: "Crypto Swings", color: "violet" },
];

export interface IStorage {
  seed(): Promise<void>;

  listTradingStyles(): Promise<TradingStyle[]>;
  createTradingStyle(s: InsertTradingStyle): Promise<TradingStyle>;
  updateTradingStyle(
    id: number,
    s: Partial<InsertTradingStyle>,
  ): Promise<TradingStyle | undefined>;
  deleteTradingStyle(id: number): Promise<void>;

  listTrades(): Promise<TradeWithTags[]>;
  getTrade(id: number): Promise<TradeWithTags | undefined>;
  createTrade(t: InsertTrade, tagIds?: number[]): Promise<TradeWithTags>;
  updateTrade(id: number, t: UpdateTrade, tagIds?: number[]): Promise<TradeWithTags | undefined>;
  deleteTrade(id: number): Promise<void>;

  listMistakeTags(): Promise<MistakeTag[]>;
  createMistakeTag(t: InsertMistakeTag): Promise<MistakeTag>;
  updateMistakeTag(id: number, t: Partial<InsertMistakeTag>): Promise<MistakeTag | undefined>;
  deleteMistakeTag(id: number): Promise<void>;

  listWeeklyReviews(): Promise<WeeklyReview[]>;
  createWeeklyReview(r: InsertWeeklyReview): Promise<WeeklyReview>;
  upsertWeeklyInsights(weekStart: string, insights: string): Promise<WeeklyReview>;

  listDailyNotes(): Promise<DailyNote[]>;
  upsertDailyNote(day: string, body: string): Promise<DailyNote>;

  addFill(tradeId: number, f: { kind: string; price: number; size: number; time: string; note?: string | null }): Promise<TradeFill>;
  deleteFill(id: number): Promise<void>;

  listAccountSettings(): Promise<AccountSettings[]>;
  upsertAccountSettings(s: UpsertAccountSettings): Promise<AccountSettings>;

  listTradeImages(tradeId: number): Promise<TradeImage[]>;
  imageUsage(): Promise<{ images: number; bytes: number }>;
  addTradeImage(tradeId: number, kind: string, data: string): Promise<TradeImage>;
  deleteTradeImage(id: number): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  /** Runs once at boot, after the tables exist. Idempotent. */
  async seed() {
    await this.seedDemons();
    await this.seedStyles();
  }

  /**
   * Idempotently reconcile the mistake_tags table with the demon taxonomy:
   * rename legacy names onto their canonical demon (preserving tag ids, so
   * existing trade links survive), then insert any canonical demon that is
   * still missing. Custom demons the user added are left untouched.
   */
  private async seedDemons() {
    const existing = await db.select().from(mistakeTags);

    for (const tag of existing) {
      const canonical = DEMON_LEGACY_ALIASES[tag.name];
      if (canonical && !existing.some((t) => t.name === canonical)) {
        await db
          .update(mistakeTags)
          .set({ name: canonical })
          .where(eq(mistakeTags.id, tag.id));
        tag.name = canonical;
      }
    }

    const present = new Set(existing.map((t) => t.name));
    for (let i = 0; i < DEMON_TAXONOMY.length; i++) {
      const name = DEMON_TAXONOMY[i];
      if (present.has(name)) {
        // Keep taxonomy demons in canonical order at the top of the list.
        const row = existing.find((t) => t.name === name)!;
        if (row.sortOrder !== i) {
          await db.update(mistakeTags).set({ sortOrder: i }).where(eq(mistakeTags.id, row.id));
        }
        continue;
      }
      await db.insert(mistakeTags).values({ name, sortOrder: i, color: "red" });
    }

    // Seed the pre-taxonomy extras only on a completely fresh database.
    if (existing.length === 0) {
      for (let i = 0; i < LEGACY_EXTRA_TAGS.length; i++) {
        await db.insert(mistakeTags).values({
          name: LEGACY_EXTRA_TAGS[i],
          sortOrder: DEMON_TAXONOMY.length + i,
          color: "red",
        });
      }
    }
  }

  /** Give a brand-new database something to log against; never overwrite. */
  private async seedStyles() {
    const existing = await db.select().from(tradingStyles);
    if (existing.length > 0) return;
    for (let i = 0; i < DEFAULT_STYLES.length; i++) {
      await db.insert(tradingStyles).values({ ...DEFAULT_STYLES[i], sortOrder: i });
    }
  }

  async listTradingStyles(): Promise<TradingStyle[]> {
    return db.select().from(tradingStyles).orderBy(tradingStyles.sortOrder);
  }

  async createTradingStyle(s: InsertTradingStyle): Promise<TradingStyle> {
    const [row] = await db.insert(tradingStyles).values(s as any).returning();
    return row;
  }

  async updateTradingStyle(
    id: number,
    s: Partial<InsertTradingStyle>,
  ): Promise<TradingStyle | undefined> {
    const [row] = await db
      .update(tradingStyles)
      .set(s as any)
      .where(eq(tradingStyles.id, id))
      .returning();
    return row;
  }

  /** Deleting a style orphans its trades rather than destroying trade history. */
  async deleteTradingStyle(id: number): Promise<void> {
    await db.update(trades).set({ styleId: null }).where(eq(trades.styleId, id));
    await db.delete(tradingStyles).where(eq(tradingStyles.id, id));
  }

  private async tagIdsFor(tradeId: number): Promise<number[]> {
    const rows = await db
      .select()
      .from(tradeMistakes)
      .where(eq(tradeMistakes.tradeId, tradeId));
    return rows.map((r) => r.mistakeTagId);
  }

  private async setTags(tradeId: number, tagIds: number[]) {
    await db.delete(tradeMistakes).where(eq(tradeMistakes.tradeId, tradeId));
    for (const mistakeTagId of tagIds) {
      await db.insert(tradeMistakes).values({ tradeId, mistakeTagId });
    }
  }

  async listTrades(): Promise<TradeWithTags[]> {
    const rows = await db.select().from(trades).orderBy(desc(trades.entryTime));
    const links = await db.select().from(tradeMistakes);
    // Counts only — the payloads stay in trade_images until a detail view asks.
    const counts = await db
      .select({ tradeId: tradeImages.tradeId, n: sqlx<number>`count(*)::int` })
      .from(tradeImages)
      .groupBy(tradeImages.tradeId);
    const countFor = new Map(counts.map((c) => [c.tradeId, c.n]));
    const allFills = await db.select().from(tradeFills).orderBy(tradeFills.time);
    return rows.map((t) => ({
      ...t,
      mistakeTagIds: links.filter((l) => l.tradeId === t.id).map((l) => l.mistakeTagId),
      imageCount: countFor.get(t.id) ?? 0,
      fills: allFills.filter((f) => f.tradeId === t.id),
    }));
  }

  async getTrade(id: number): Promise<TradeWithTags | undefined> {
    const [t] = await db.select().from(trades).where(eq(trades.id, id));
    if (!t) return undefined;
    return {
      ...t,
      mistakeTagIds: await this.tagIdsFor(id),
      imageCount: await this.imageCountFor(id),
      fills: await this.fillsFor(id),
    };
  }

  async createTrade(t: InsertTrade, tagIds: number[] = []): Promise<TradeWithTags> {
    const [row] = await db.insert(trades).values(t as any).returning();
    if (tagIds.length) await this.setTags(row.id, tagIds);
    return { ...row, mistakeTagIds: tagIds, imageCount: 0, fills: [] };
  }

  async updateTrade(
    id: number,
    t: UpdateTrade,
    tagIds?: number[],
  ): Promise<TradeWithTags | undefined> {
    // Drizzle throws on an empty SET clause, so a tags-only patch just reads.
    const [row] =
      Object.keys(t).length > 0
        ? await db.update(trades).set(t as any).where(eq(trades.id, id)).returning()
        : await db.select().from(trades).where(eq(trades.id, id));
    if (!row) return undefined;
    if (tagIds) await this.setTags(id, tagIds);
    return {
      ...row,
      mistakeTagIds: await this.tagIdsFor(id),
      imageCount: await this.imageCountFor(id),
      fills: await this.fillsFor(id),
    };
  }

  async deleteTrade(id: number): Promise<void> {
    await db.delete(tradeMistakes).where(eq(tradeMistakes.tradeId, id));
    await db.delete(tradeImages).where(eq(tradeImages.tradeId, id));
    await db.delete(tradeFills).where(eq(tradeFills.tradeId, id));
    await db.delete(trades).where(eq(trades.id, id));
  }

  private async fillsFor(tradeId: number): Promise<TradeFill[]> {
    return db
      .select()
      .from(tradeFills)
      .where(eq(tradeFills.tradeId, tradeId))
      .orderBy(tradeFills.time);
  }

  async addFill(
    tradeId: number,
    f: { kind: string; price: number; size: number; time: string; note?: string | null },
  ): Promise<TradeFill> {
    const [row] = await db
      .insert(tradeFills)
      .values({ tradeId, kind: f.kind, price: f.price, size: f.size, time: f.time, note: f.note ?? null })
      .returning();
    return row;
  }

  async deleteFill(id: number): Promise<void> {
    await db.delete(tradeFills).where(eq(tradeFills.id, id));
  }

  async listAccountSettings(): Promise<AccountSettings[]> {
    return db.select().from(accountSettings).orderBy(accountSettings.name);
  }

  async upsertAccountSettings(s: UpsertAccountSettings): Promise<AccountSettings> {
    const name = s.name.trim();
    const [existing] = await db
      .select()
      .from(accountSettings)
      .where(eq(accountSettings.name, name));
    if (existing) {
      const [row] = await db
        .update(accountSettings)
        .set({ feeMode: s.feeMode, makerFee: s.makerFee, takerFee: s.takerFee })
        .where(eq(accountSettings.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await db
      .insert(accountSettings)
      .values({ name, feeMode: s.feeMode, makerFee: s.makerFee, takerFee: s.takerFee })
      .returning();
    return row;
  }

  private async imageCountFor(tradeId: number): Promise<number> {
    const [row] = await db
      .select({ n: sqlx<number>`count(*)::int` })
      .from(tradeImages)
      .where(eq(tradeImages.tradeId, tradeId));
    return row?.n ?? 0;
  }

  /**
   * How much of the database the screenshots occupy. length(data) counts the
   * base64 characters, which IS the stored size for a text column — the
   * honest number to hold against Neon's free-tier 512 MB.
   */
  async imageUsage(): Promise<{ images: number; bytes: number }> {
    const [row] = await db
      .select({
        images: sqlx<number>`count(*)::int`,
        bytes: sqlx<number>`coalesce(sum(length(${tradeImages.data})), 0)::bigint`,
      })
      .from(tradeImages);
    return { images: row?.images ?? 0, bytes: Number(row?.bytes ?? 0) };
  }

  async listTradeImages(tradeId: number): Promise<TradeImage[]> {
    return db
      .select()
      .from(tradeImages)
      .where(eq(tradeImages.tradeId, tradeId))
      .orderBy(tradeImages.id);
  }

  async addTradeImage(tradeId: number, kind: string, data: string): Promise<TradeImage> {
    const [row] = await db
      .insert(tradeImages)
      .values({ tradeId, kind, data, createdAt: new Date().toISOString() })
      .returning();
    return row;
  }

  async deleteTradeImage(id: number): Promise<void> {
    await db.delete(tradeImages).where(eq(tradeImages.id, id));
  }

  async listMistakeTags(): Promise<MistakeTag[]> {
    return db.select().from(mistakeTags).orderBy(mistakeTags.sortOrder);
  }

  async createMistakeTag(t: InsertMistakeTag): Promise<MistakeTag> {
    const [row] = await db.insert(mistakeTags).values(t as any).returning();
    return row;
  }

  async updateMistakeTag(
    id: number,
    t: Partial<InsertMistakeTag>,
  ): Promise<MistakeTag | undefined> {
    const [row] = await db
      .update(mistakeTags)
      .set(t as any)
      .where(eq(mistakeTags.id, id))
      .returning();
    return row;
  }

  async deleteMistakeTag(id: number): Promise<void> {
    await db.delete(tradeMistakes).where(eq(tradeMistakes.mistakeTagId, id));
    await db.delete(mistakeTags).where(eq(mistakeTags.id, id));
  }

  async listWeeklyReviews(): Promise<WeeklyReview[]> {
    return db.select().from(weeklyReviews).orderBy(desc(weeklyReviews.weekStart));
  }

  async createWeeklyReview(r: InsertWeeklyReview): Promise<WeeklyReview> {
    const [existing] = await db
      .select()
      .from(weeklyReviews)
      .where(eq(weeklyReviews.weekStart, r.weekStart));
    if (existing) {
      const [row] = await db
        .update(weeklyReviews)
        .set(r as any)
        .where(eq(weeklyReviews.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await db.insert(weeklyReviews).values(r as any).returning();
    return row;
  }

  /**
   * Store the week's insights without touching its manual plan. Kept separate
   * from createWeeklyReview because that one replaces the row wholesale, which
   * would silently wipe a "fix one" plan the trader wrote by hand.
   */
  async upsertWeeklyInsights(weekStart: string, insights: string): Promise<WeeklyReview> {
    const [existing] = await db
      .select()
      .from(weeklyReviews)
      .where(eq(weeklyReviews.weekStart, weekStart));
    if (existing) {
      const [row] = await db
        .update(weeklyReviews)
        .set({ insights })
        .where(eq(weeklyReviews.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await db
      .insert(weeklyReviews)
      .values({ weekStart, insights, submittedAt: new Date().toISOString() } as any)
      .returning();
    return row;
  }

  async listDailyNotes(): Promise<DailyNote[]> {
    return db.select().from(dailyNotes).orderBy(desc(dailyNotes.day));
  }

  /**
   * Last write wins, whole-body. The note is one file edited in one textarea,
   * so field-level merging has nothing to merge — and an upsert keyed on the
   * day means "save" never has to know whether today's file exists yet.
   */
  async upsertDailyNote(day: string, body: string): Promise<DailyNote> {
    const updatedAt = new Date().toISOString();
    const [existing] = await db.select().from(dailyNotes).where(eq(dailyNotes.day, day));
    if (existing) {
      const [row] = await db
        .update(dailyNotes)
        .set({ body, updatedAt })
        .where(eq(dailyNotes.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await db
      .insert(dailyNotes)
      .values({ day, body, updatedAt })
      .returning();
    return row;
  }
}

export const storage = new DatabaseStorage();
