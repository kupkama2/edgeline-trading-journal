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
  users,
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
  User,
} from "@shared/schema";
import { DEMON_TAXONOMY, DEMON_LEGACY_ALIASES } from "@shared/demons";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, desc, inArray, isNull, sql as sqlx } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

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

-- ======================== accounts and ownership ========================
-- Identity is Google's; see shared/schema.ts for why the sub and not the email
-- is the key.
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  picture TEXT,
  is_owner BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

-- Every table that owns rows gains an owner. Left nullable on purpose: the
-- rows that predate sign-in have no owner until the first Google account
-- claims them (see claimOwnership), and a NULL matches no scoped query, so
-- unclaimed data is invisible rather than shared. Failing closed beats a
-- NOT NULL that cannot be satisfied at boot.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE trading_styles ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE mistake_tags ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE weekly_reviews ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE daily_notes ADD COLUMN IF NOT EXISTS user_id INTEGER;

-- The two global uniques have to become per-account, or the second person to
-- write a note on a day the first already used collides with a row they can
-- neither see nor edit. The old constraint names are Postgres's own defaults.
ALTER TABLE daily_notes DROP CONSTRAINT IF EXISTS daily_notes_day_key;
ALTER TABLE account_settings DROP CONSTRAINT IF EXISTS account_settings_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS daily_notes_user_day ON daily_notes (user_id, day);
CREATE UNIQUE INDEX IF NOT EXISTS account_settings_user_name
  ON account_settings (user_id, name);

-- Every read is now filtered by owner, so every table wants the index.
CREATE INDEX IF NOT EXISTS trades_user_id ON trades (user_id);
CREATE INDEX IF NOT EXISTS trading_styles_user_id ON trading_styles (user_id);
CREATE INDEX IF NOT EXISTS mistake_tags_user_id ON mistake_tags (user_id);
CREATE INDEX IF NOT EXISTS account_settings_user_id ON account_settings (user_id);
CREATE INDEX IF NOT EXISTS weekly_reviews_user_id ON weekly_reviews (user_id);
CREATE INDEX IF NOT EXISTS daily_notes_user_id ON daily_notes (user_id);
`);
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

/* ============================== accounts ============================== */

/**
 * The account table is the one thing NOT scoped to an account, for the obvious
 * reason: sign-in has to find you before it knows who you are. It is therefore
 * kept deliberately small and separate from DatabaseStorage, so there is no
 * instance anywhere that can read a trade without an owner attached.
 */
export const accounts = {
  async byGoogleSub(sub: string): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.googleSub, sub));
    return row;
  },

  async byId(id: number): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.id, id));
    return row;
  },

  async count(): Promise<number> {
    const [row] = await db.select({ n: sqlx<number>`count(*)::int` }).from(users);
    return row?.n ?? 0;
  },

  async owner(): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.isOwner, true));
    return row;
  },

  async touchLogin(id: number): Promise<void> {
    await db
      .update(users)
      .set({ lastLoginAt: new Date().toISOString() })
      .where(eq(users.id, id));
  },

  /**
   * Create the account and give it something to log against. A brand new
   * journal gets its own copy of the demon taxonomy and the starter styles —
   * per account, because renaming a style must not rename it for everyone.
   */
  async create(p: {
    googleSub: string;
    email: string;
    name?: string | null;
    picture?: string | null;
    isOwner?: boolean;
  }): Promise<User> {
    const [row] = await db
      .insert(users)
      .values({
        googleSub: p.googleSub,
        email: p.email,
        name: p.name ?? null,
        picture: p.picture ?? null,
        isOwner: p.isOwner ?? false,
        createdAt: new Date().toISOString(),
      })
      .returning();
    await new DatabaseStorage(row.id).seed();
    return row;
  },

  /**
   * Adopt everything logged before sign-in existed.
   *
   * Runs exactly once, inside the creation of the first account, and only for
   * the account whose email matches OWNER_EMAIL. Every unowned row becomes
   * theirs; after this there are no unowned rows, so a second call updates
   * nothing. Keeping it here rather than in initSchema is deliberate — at boot
   * there is no way to know which Google account the history belongs to, and
   * guessing at that would be the one mistake with no undo.
   */
  async claimOwnership(userId: number): Promise<void> {
    // Parameterised per table rather than one interpolated multi-statement
    // string: the id comes from our own database, but a query builder that
    // cannot be handed a value it will not escape is one fewer thing to be
    // careful about forever.
    await db.update(trades).set({ userId }).where(isNull(trades.userId));
    await db.update(tradingStyles).set({ userId }).where(isNull(tradingStyles.userId));
    await db.update(mistakeTags).set({ userId }).where(isNull(mistakeTags.userId));
    await db.update(accountSettings).set({ userId }).where(isNull(accountSettings.userId));
    await db.update(weeklyReviews).set({ userId }).where(isNull(weeklyReviews.userId));
    await db.update(dailyNotes).set({ userId }).where(isNull(dailyNotes.userId));
  },
};

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

  /** undefined when the trade is not this account's — see DatabaseStorage. */
  addFill(tradeId: number, f: { kind: string; price: number; size: number; time: string; note?: string | null }): Promise<TradeFill | undefined>;
  deleteFill(id: number): Promise<void>;

  listAccountSettings(): Promise<AccountSettings[]>;
  upsertAccountSettings(s: UpsertAccountSettings): Promise<AccountSettings>;

  listTradeImages(tradeId: number): Promise<TradeImage[]>;
  imageUsage(): Promise<{ images: number; bytes: number }>;
  addTradeImage(tradeId: number, kind: string, data: string): Promise<TradeImage | undefined>;
  deleteTradeImage(id: number): Promise<void>;
}

/**
 * Everything one account can see and do.
 *
 * The owner id is a constructor argument rather than a parameter on each
 * method, and that is the entire security design: there is no instance of this
 * class without an account attached, so there is nowhere to write a query that
 * forgets to filter. `storageFor(userId)` is the only way to get one, and
 * routes never touch `db` directly.
 *
 * Child rows — fills, images, demon links — carry no owner column. They are
 * reached exclusively through their parent trade, so ownership has exactly one
 * definition and cannot drift between tables. Every method that takes a raw
 * child id therefore resolves the parent first and behaves as if the row does
 * not exist when it belongs to someone else.
 */
export class DatabaseStorage implements IStorage {
  constructor(private readonly userId: number) {}

  /** Runs when the account is created. Idempotent. */
  async seed() {
    await this.seedDemons();
    await this.seedStyles();
  }

  /**
   * Idempotently reconcile this account's mistake_tags with the demon
   * taxonomy: rename legacy names onto their canonical demon (preserving tag
   * ids, so existing trade links survive), then insert any canonical demon
   * that is still missing. Custom demons the user added are left untouched.
   */
  private async seedDemons() {
    const existing = await db.select().from(mistakeTags).where(this.owns(mistakeTags));

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
      await db.insert(mistakeTags).values({ name, sortOrder: i, color: "red", userId: this.userId });
    }

    // Seed the pre-taxonomy extras only for a brand-new journal.
    if (existing.length === 0) {
      for (let i = 0; i < LEGACY_EXTRA_TAGS.length; i++) {
        await db.insert(mistakeTags).values({
          name: LEGACY_EXTRA_TAGS[i],
          sortOrder: DEMON_TAXONOMY.length + i,
          color: "red",
          userId: this.userId,
        });
      }
    }
  }

  /** Give a brand-new journal something to log against; never overwrite. */
  private async seedStyles() {
    const existing = await db.select().from(tradingStyles).where(this.owns(tradingStyles));
    if (existing.length > 0) return;
    for (let i = 0; i < DEFAULT_STYLES.length; i++) {
      await db
        .insert(tradingStyles)
        .values({ ...DEFAULT_STYLES[i], sortOrder: i, userId: this.userId });
    }
  }

  /* ------------------------------ scoping ------------------------------ */

  /** The filter every query on an owning table carries. */
  private owns(t: { userId: AnyPgColumn }) {
    return eq(t.userId, this.userId);
  }

  /** True when this trade is ours. The gate in front of every child row. */
  private async ownsTrade(tradeId: number): Promise<boolean> {
    const [row] = await db
      .select({ id: trades.id })
      .from(trades)
      .where(and(eq(trades.id, tradeId), this.owns(trades)));
    return Boolean(row);
  }

  /** Our trade ids, for the child-table lookups that fan out from a list. */
  private async myTradeIds(): Promise<number[]> {
    const rows = await db.select({ id: trades.id }).from(trades).where(this.owns(trades));
    return rows.map((r) => r.id);
  }

  /* --------------------------- trading styles --------------------------- */

  async listTradingStyles(): Promise<TradingStyle[]> {
    return db
      .select()
      .from(tradingStyles)
      .where(this.owns(tradingStyles))
      .orderBy(tradingStyles.sortOrder);
  }

  async createTradingStyle(s: InsertTradingStyle): Promise<TradingStyle> {
    const [row] = await db
      .insert(tradingStyles)
      .values({ ...(s as any), userId: this.userId })
      .returning();
    return row;
  }

  async updateTradingStyle(
    id: number,
    s: Partial<InsertTradingStyle>,
  ): Promise<TradingStyle | undefined> {
    const [row] = await db
      .update(tradingStyles)
      .set(s as any)
      .where(and(eq(tradingStyles.id, id), this.owns(tradingStyles)))
      .returning();
    return row;
  }

  /** Deleting a style orphans its trades rather than destroying trade history. */
  async deleteTradingStyle(id: number): Promise<void> {
    if (!(await this.ownsStyle(id))) return;
    await db
      .update(trades)
      .set({ styleId: null })
      .where(and(eq(trades.styleId, id), this.owns(trades)));
    await db
      .delete(tradingStyles)
      .where(and(eq(tradingStyles.id, id), this.owns(tradingStyles)));
  }

  private async ownsStyle(id: number): Promise<boolean> {
    const [row] = await db
      .select({ id: tradingStyles.id })
      .from(tradingStyles)
      .where(and(eq(tradingStyles.id, id), this.owns(tradingStyles)));
    return Boolean(row);
  }

  /* -------------------------------- tags -------------------------------- */

  private async tagIdsFor(tradeId: number): Promise<number[]> {
    const rows = await db
      .select()
      .from(tradeMistakes)
      .where(eq(tradeMistakes.tradeId, tradeId));
    return rows.map((r) => r.mistakeTagId);
  }

  /**
   * Replace a trade's demons, ignoring any tag id that isn't ours — a request
   * naming someone else's tag is dropped rather than honoured, so a link can
   * never cross accounts.
   */
  private async setTags(tradeId: number, tagIds: number[]) {
    await db.delete(tradeMistakes).where(eq(tradeMistakes.tradeId, tradeId));
    if (!tagIds.length) return;
    const owned = await db
      .select({ id: mistakeTags.id })
      .from(mistakeTags)
      .where(and(this.owns(mistakeTags), inArray(mistakeTags.id, tagIds)));
    for (const { id: mistakeTagId } of owned) {
      await db.insert(tradeMistakes).values({ tradeId, mistakeTagId });
    }
  }

  /* ------------------------------- trades ------------------------------- */

  async listTrades(): Promise<TradeWithTags[]> {
    const rows = await db
      .select()
      .from(trades)
      .where(this.owns(trades))
      .orderBy(desc(trades.entryTime));
    if (rows.length === 0) return [];
    const ids = rows.map((t) => t.id);

    const links = await db
      .select()
      .from(tradeMistakes)
      .where(inArray(tradeMistakes.tradeId, ids));
    // Counts only — the payloads stay in trade_images until a detail view asks.
    const counts = await db
      .select({ tradeId: tradeImages.tradeId, n: sqlx<number>`count(*)::int` })
      .from(tradeImages)
      .where(inArray(tradeImages.tradeId, ids))
      .groupBy(tradeImages.tradeId);
    const countFor = new Map(counts.map((c) => [c.tradeId, c.n]));
    const allFills = await db
      .select()
      .from(tradeFills)
      .where(inArray(tradeFills.tradeId, ids))
      .orderBy(tradeFills.time);
    return rows.map((t) => ({
      ...t,
      mistakeTagIds: links.filter((l) => l.tradeId === t.id).map((l) => l.mistakeTagId),
      imageCount: countFor.get(t.id) ?? 0,
      fills: allFills.filter((f) => f.tradeId === t.id),
    }));
  }

  async getTrade(id: number): Promise<TradeWithTags | undefined> {
    const [t] = await db
      .select()
      .from(trades)
      .where(and(eq(trades.id, id), this.owns(trades)));
    if (!t) return undefined;
    return {
      ...t,
      mistakeTagIds: await this.tagIdsFor(id),
      imageCount: await this.imageCountFor(id),
      fills: await this.fillsFor(id),
    };
  }

  async createTrade(t: InsertTrade, tagIds: number[] = []): Promise<TradeWithTags> {
    const [row] = await db
      .insert(trades)
      .values({ ...(t as any), userId: this.userId })
      .returning();
    if (tagIds.length) await this.setTags(row.id, tagIds);
    return {
      ...row,
      mistakeTagIds: await this.tagIdsFor(row.id),
      imageCount: 0,
      fills: [],
    };
  }

  async updateTrade(
    id: number,
    t: UpdateTrade,
    tagIds?: number[],
  ): Promise<TradeWithTags | undefined> {
    // Drizzle throws on an empty SET clause, so a tags-only patch just reads.
    const [row] =
      Object.keys(t).length > 0
        ? await db
            .update(trades)
            .set(t as any)
            .where(and(eq(trades.id, id), this.owns(trades)))
            .returning()
        : await db
            .select()
            .from(trades)
            .where(and(eq(trades.id, id), this.owns(trades)));
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
    if (!(await this.ownsTrade(id))) return;
    await db.delete(tradeMistakes).where(eq(tradeMistakes.tradeId, id));
    await db.delete(tradeImages).where(eq(tradeImages.tradeId, id));
    await db.delete(tradeFills).where(eq(tradeFills.tradeId, id));
    await db.delete(trades).where(and(eq(trades.id, id), this.owns(trades)));
  }

  /* -------------------------------- fills ------------------------------- */

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
  ): Promise<TradeFill | undefined> {
    if (!(await this.ownsTrade(tradeId))) return undefined;
    const [row] = await db
      .insert(tradeFills)
      .values({ tradeId, kind: f.kind, price: f.price, size: f.size, time: f.time, note: f.note ?? null })
      .returning();
    return row;
  }

  async deleteFill(id: number): Promise<void> {
    const [fill] = await db.select().from(tradeFills).where(eq(tradeFills.id, id));
    if (!fill || !(await this.ownsTrade(fill.tradeId))) return;
    await db.delete(tradeFills).where(eq(tradeFills.id, id));
  }

  /* --------------------------- account settings -------------------------- */

  async listAccountSettings(): Promise<AccountSettings[]> {
    return db
      .select()
      .from(accountSettings)
      .where(this.owns(accountSettings))
      .orderBy(accountSettings.name);
  }

  async upsertAccountSettings(s: UpsertAccountSettings): Promise<AccountSettings> {
    const name = s.name.trim();
    const [existing] = await db
      .select()
      .from(accountSettings)
      .where(and(eq(accountSettings.name, name), this.owns(accountSettings)));
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
      .values({
        name,
        feeMode: s.feeMode,
        makerFee: s.makerFee,
        takerFee: s.takerFee,
        userId: this.userId,
      })
      .returning();
    return row;
  }

  /* -------------------------------- images ------------------------------- */

  private async imageCountFor(tradeId: number): Promise<number> {
    const [row] = await db
      .select({ n: sqlx<number>`count(*)::int` })
      .from(tradeImages)
      .where(eq(tradeImages.tradeId, tradeId));
    return row?.n ?? 0;
  }

  /**
   * How much of the database YOUR screenshots occupy. length(data) counts the
   * base64 characters, which IS the stored size for a text column — the
   * honest number to hold against Neon's free-tier 512 MB. Scoped to this
   * account: someone else's screenshots are not your storage problem.
   */
  async imageUsage(): Promise<{ images: number; bytes: number }> {
    const ids = await this.myTradeIds();
    if (ids.length === 0) return { images: 0, bytes: 0 };
    const [row] = await db
      .select({
        images: sqlx<number>`count(*)::int`,
        bytes: sqlx<number>`coalesce(sum(length(${tradeImages.data})), 0)::bigint`,
      })
      .from(tradeImages)
      .where(inArray(tradeImages.tradeId, ids));
    return { images: row?.images ?? 0, bytes: Number(row?.bytes ?? 0) };
  }

  async listTradeImages(tradeId: number): Promise<TradeImage[]> {
    if (!(await this.ownsTrade(tradeId))) return [];
    return db
      .select()
      .from(tradeImages)
      .where(eq(tradeImages.tradeId, tradeId))
      .orderBy(tradeImages.id);
  }

  async addTradeImage(
    tradeId: number,
    kind: string,
    data: string,
  ): Promise<TradeImage | undefined> {
    if (!(await this.ownsTrade(tradeId))) return undefined;
    const [row] = await db
      .insert(tradeImages)
      .values({ tradeId, kind, data, createdAt: new Date().toISOString() })
      .returning();
    return row;
  }

  async deleteTradeImage(id: number): Promise<void> {
    const [img] = await db.select().from(tradeImages).where(eq(tradeImages.id, id));
    if (!img || !(await this.ownsTrade(img.tradeId))) return;
    await db.delete(tradeImages).where(eq(tradeImages.id, id));
  }

  /* ------------------------------- demons -------------------------------- */

  async listMistakeTags(): Promise<MistakeTag[]> {
    return db
      .select()
      .from(mistakeTags)
      .where(this.owns(mistakeTags))
      .orderBy(mistakeTags.sortOrder);
  }

  async createMistakeTag(t: InsertMistakeTag): Promise<MistakeTag> {
    const [row] = await db
      .insert(mistakeTags)
      .values({ ...(t as any), userId: this.userId })
      .returning();
    return row;
  }

  async updateMistakeTag(
    id: number,
    t: Partial<InsertMistakeTag>,
  ): Promise<MistakeTag | undefined> {
    const [row] = await db
      .update(mistakeTags)
      .set(t as any)
      .where(and(eq(mistakeTags.id, id), this.owns(mistakeTags)))
      .returning();
    return row;
  }

  async deleteMistakeTag(id: number): Promise<void> {
    const [tag] = await db
      .select({ id: mistakeTags.id })
      .from(mistakeTags)
      .where(and(eq(mistakeTags.id, id), this.owns(mistakeTags)));
    if (!tag) return;
    await db.delete(tradeMistakes).where(eq(tradeMistakes.mistakeTagId, id));
    await db.delete(mistakeTags).where(and(eq(mistakeTags.id, id), this.owns(mistakeTags)));
  }

  /* --------------------------- weekly reviews ---------------------------- */

  async listWeeklyReviews(): Promise<WeeklyReview[]> {
    return db
      .select()
      .from(weeklyReviews)
      .where(this.owns(weeklyReviews))
      .orderBy(desc(weeklyReviews.weekStart));
  }

  async createWeeklyReview(r: InsertWeeklyReview): Promise<WeeklyReview> {
    const [existing] = await db
      .select()
      .from(weeklyReviews)
      .where(and(eq(weeklyReviews.weekStart, r.weekStart), this.owns(weeklyReviews)));
    if (existing) {
      const [row] = await db
        .update(weeklyReviews)
        .set(r as any)
        .where(eq(weeklyReviews.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await db
      .insert(weeklyReviews)
      .values({ ...(r as any), userId: this.userId })
      .returning();
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
      .where(and(eq(weeklyReviews.weekStart, weekStart), this.owns(weeklyReviews)));
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
      .values({
        weekStart,
        insights,
        submittedAt: new Date().toISOString(),
        userId: this.userId,
      } as any)
      .returning();
    return row;
  }

  /* ----------------------------- daily notes ----------------------------- */

  async listDailyNotes(): Promise<DailyNote[]> {
    return db
      .select()
      .from(dailyNotes)
      .where(this.owns(dailyNotes))
      .orderBy(desc(dailyNotes.day));
  }

  /**
   * Last write wins, whole-body. The note is one file edited in one textarea,
   * so field-level merging has nothing to merge — and an upsert keyed on the
   * day means "save" never has to know whether today's file exists yet.
   */
  async upsertDailyNote(day: string, body: string): Promise<DailyNote> {
    const updatedAt = new Date().toISOString();
    const [existing] = await db
      .select()
      .from(dailyNotes)
      .where(and(eq(dailyNotes.day, day), this.owns(dailyNotes)));
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
      .values({ day, body, updatedAt, userId: this.userId })
      .returning();
    return row;
  }
}

/** The only way to get a storage instance. There is no unscoped one. */
export function storageFor(userId: number): DatabaseStorage {
  return new DatabaseStorage(userId);
}
