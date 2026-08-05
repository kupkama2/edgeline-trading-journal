import {
  trades,
  mistakeTags,
  tradeMistakes,
  weeklyReviews,
} from "@shared/schema";
import type {
  Trade,
  InsertTrade,
  UpdateTrade,
  MistakeTag,
  InsertMistakeTag,
  TradeWithTags,
  WeeklyReview,
  InsertWeeklyReview,
} from "@shared/schema";
import { DEMON_TAXONOMY, DEMON_LEGACY_ALIASES } from "@shared/demons";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, and } from "drizzle-orm";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite);

/* Bootstrap tables (no migration tooling needed for a single-user local DB). */
sqlite.exec(`
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  size REAL NOT NULL,
  entry_price REAL NOT NULL,
  initial_stop REAL NOT NULL,
  initial_target REAL NOT NULL,
  entry_time TEXT NOT NULL,
  exit_price REAL,
  exit_time TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  exit_reason TEXT,
  mae REAL,
  mfe REAL,
  no_management_outcome TEXT,
  setup_screenshot TEXT,
  outcome_screenshot TEXT,
  notes TEXT,
  rationale TEXT,
  rationale_tags TEXT
);
CREATE TABLE IF NOT EXISTS mistake_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT 'red'
);
CREATE TABLE IF NOT EXISTS trade_mistakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL,
  mistake_tag_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS weekly_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  plans TEXT NOT NULL,
  submitted_at TEXT NOT NULL
);
`);

/* Lightweight migration for columns added after the table already existed. */
function ensureColumn(table: string, column: string, ddl: string) {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn("trades", "rationale", "rationale TEXT");
ensureColumn("trades", "rationale_tags", "rationale_tags TEXT");
ensureColumn("trades", "playbook", "playbook TEXT");

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

export interface IStorage {
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
  constructor() {
    this.seedDemons();
  }

  /**
   * Idempotently reconcile the mistake_tags table with the demon taxonomy:
   * rename legacy names onto their canonical demon (preserving tag ids, so
   * existing trade links survive), then insert any canonical demon that is
   * still missing. Custom demons the user added are left untouched.
   */
  private seedDemons() {
    const existing = db.select().from(mistakeTags).all();

    for (const tag of existing) {
      const canonical = DEMON_LEGACY_ALIASES[tag.name];
      if (canonical && !existing.some((t) => t.name === canonical)) {
        db.update(mistakeTags)
          .set({ name: canonical })
          .where(eq(mistakeTags.id, tag.id))
          .run();
        tag.name = canonical;
      }
    }

    const present = new Set(existing.map((t) => t.name));
    DEMON_TAXONOMY.forEach((name, i) => {
      if (present.has(name)) {
        // Keep taxonomy demons in canonical order at the top of the list.
        const row = existing.find((t) => t.name === name)!;
        if (row.sortOrder !== i) {
          db.update(mistakeTags).set({ sortOrder: i }).where(eq(mistakeTags.id, row.id)).run();
        }
        return;
      }
      db.insert(mistakeTags).values({ name, sortOrder: i, color: "red" }).run();
    });

    // Seed the pre-taxonomy extras only on a completely fresh database.
    if (existing.length === 0) {
      LEGACY_EXTRA_TAGS.forEach((name, i) => {
        db.insert(mistakeTags)
          .values({ name, sortOrder: DEMON_TAXONOMY.length + i, color: "red" })
          .run();
      });
    }
  }

  private tagIdsFor(tradeId: number): number[] {
    return db
      .select()
      .from(tradeMistakes)
      .where(eq(tradeMistakes.tradeId, tradeId))
      .all()
      .map((r) => r.mistakeTagId);
  }

  private setTags(tradeId: number, tagIds: number[]) {
    db.delete(tradeMistakes).where(eq(tradeMistakes.tradeId, tradeId)).run();
    for (const mistakeTagId of tagIds) {
      db.insert(tradeMistakes).values({ tradeId, mistakeTagId }).run();
    }
  }

  async listTrades(): Promise<TradeWithTags[]> {
    const rows = db.select().from(trades).orderBy(desc(trades.entryTime)).all();
    const links = db.select().from(tradeMistakes).all();
    return rows.map((t) => ({
      ...t,
      mistakeTagIds: links.filter((l) => l.tradeId === t.id).map((l) => l.mistakeTagId),
    }));
  }

  async getTrade(id: number): Promise<TradeWithTags | undefined> {
    const t = db.select().from(trades).where(eq(trades.id, id)).get();
    if (!t) return undefined;
    return { ...t, mistakeTagIds: this.tagIdsFor(id) };
  }

  async createTrade(t: InsertTrade, tagIds: number[] = []): Promise<TradeWithTags> {
    const row = db.insert(trades).values(t as any).returning().get();
    if (tagIds.length) this.setTags(row.id, tagIds);
    return { ...row, mistakeTagIds: tagIds };
  }

  async updateTrade(
    id: number,
    t: UpdateTrade,
    tagIds?: number[],
  ): Promise<TradeWithTags | undefined> {
    const row = db
      .update(trades)
      .set(t as any)
      .where(eq(trades.id, id))
      .returning()
      .get();
    if (!row) return undefined;
    if (tagIds) this.setTags(id, tagIds);
    return { ...row, mistakeTagIds: this.tagIdsFor(id) };
  }

  async deleteTrade(id: number): Promise<void> {
    db.delete(tradeMistakes).where(eq(tradeMistakes.tradeId, id)).run();
    db.delete(trades).where(eq(trades.id, id)).run();
  }

  async listMistakeTags(): Promise<MistakeTag[]> {
    return db.select().from(mistakeTags).orderBy(mistakeTags.sortOrder).all();
  }

  async createMistakeTag(t: InsertMistakeTag): Promise<MistakeTag> {
    return db.insert(mistakeTags).values(t as any).returning().get();
  }

  async updateMistakeTag(
    id: number,
    t: Partial<InsertMistakeTag>,
  ): Promise<MistakeTag | undefined> {
    return db.update(mistakeTags).set(t as any).where(eq(mistakeTags.id, id)).returning().get();
  }

  async deleteMistakeTag(id: number): Promise<void> {
    db.delete(tradeMistakes).where(eq(tradeMistakes.mistakeTagId, id)).run();
    db.delete(mistakeTags).where(eq(mistakeTags.id, id)).run();
  }

  async listWeeklyReviews(): Promise<WeeklyReview[]> {
    return db.select().from(weeklyReviews).orderBy(desc(weeklyReviews.weekStart)).all();
  }

  async createWeeklyReview(r: InsertWeeklyReview): Promise<WeeklyReview> {
    const existing = db
      .select()
      .from(weeklyReviews)
      .where(eq(weeklyReviews.weekStart, r.weekStart))
      .get();
    if (existing) {
      return db
        .update(weeklyReviews)
        .set(r as any)
        .where(eq(weeklyReviews.id, existing.id))
        .returning()
        .get();
    }
    return db.insert(weeklyReviews).values(r as any).returning().get();
  }
}

export const storage = new DatabaseStorage();
