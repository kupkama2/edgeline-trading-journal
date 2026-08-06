import {
  trades,
  mistakeTags,
  tradeMistakes,
  weeklyReviews,
  tradingStyles,
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
} from "@shared/schema";
import { DEMON_TAXONOMY, DEMON_LEGACY_ALIASES } from "@shared/demons";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, desc } from "drizzle-orm";

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
  sort_order INTEGER NOT NULL DEFAULT 0
);
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
CREATE TABLE IF NOT EXISTS weekly_reviews (
  id SERIAL PRIMARY KEY,
  week_start TEXT NOT NULL,
  plans TEXT NOT NULL,
  submitted_at TEXT NOT NULL
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
    return rows.map((t) => ({
      ...t,
      mistakeTagIds: links.filter((l) => l.tradeId === t.id).map((l) => l.mistakeTagId),
    }));
  }

  async getTrade(id: number): Promise<TradeWithTags | undefined> {
    const [t] = await db.select().from(trades).where(eq(trades.id, id));
    if (!t) return undefined;
    return { ...t, mistakeTagIds: await this.tagIdsFor(id) };
  }

  async createTrade(t: InsertTrade, tagIds: number[] = []): Promise<TradeWithTags> {
    const [row] = await db.insert(trades).values(t as any).returning();
    if (tagIds.length) await this.setTags(row.id, tagIds);
    return { ...row, mistakeTagIds: tagIds };
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
    return { ...row, mistakeTagIds: await this.tagIdsFor(id) };
  }

  async deleteTrade(id: number): Promise<void> {
    await db.delete(tradeMistakes).where(eq(tradeMistakes.tradeId, id));
    await db.delete(trades).where(eq(trades.id, id));
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
}

export const storage = new DatabaseStorage();
