import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

/* ============================== trades ============================== */

export const trades = sqliteTable("trades", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(), // 'long' | 'short'
  size: real("size").notNull(),
  entryPrice: real("entry_price").notNull(),
  initialStop: real("initial_stop").notNull(),
  initialTarget: real("initial_target").notNull(),
  entryTime: text("entry_time").notNull(), // ISO
  exitPrice: real("exit_price"),
  exitTime: text("exit_time"),
  status: text("status").notNull().default("open"), // 'open' | 'closed'
  exitReason: text("exit_reason"), // 'target' | 'stop' | 'trailed' | 'manual_early' | 'manual_late' | 'breakeven' | 'other'
  mae: real("mae"),
  mfe: real("mfe"),
  noManagementOutcome: text("no_management_outcome"), // 'target_first' | 'stop_first' | 'undetermined'
  setupScreenshot: text("setup_screenshot"),
  outcomeScreenshot: text("outcome_screenshot"),
  notes: text("notes"),
  rationale: text("rationale"), // raw quick-entry comment, e.g. "vah, 786 retest"
  rationaleTags: text("rationale_tags"), // JSON string[] — AI-normalized setup concepts
  playbook: text("playbook"), // JSON TradePlaybook — optional setup/edge checklist
});

/* ------------------------------- playbook ------------------------------ */

/**
 * Optional "edge checklist" captured when logging a trade. Stored as a JSON
 * text column (same convention as rationaleTags, since SQLite has no object
 * type). Every field is optional — logging a trade fast must stay possible.
 */
export const playbookSchema = z.object({
  setupName: z.string().optional(),
  stopLogic: z.string().optional(),
  targetLogic: z.string().optional(),
  confidence: z.number().int().min(1).max(5).optional(),
  standAside: z.string().optional(),
});

export type TradePlaybook = z.infer<typeof playbookSchema>;

export function parsePlaybook(json: string | null | undefined): TradePlaybook | null {
  if (!json) return null;
  try {
    const parsed = playbookSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return null;
    const p = parsed.data;
    const hasAny = Object.values(p).some(
      (v) => v != null && String(v).trim() !== "",
    );
    return hasAny ? p : null;
  } catch {
    return null;
  }
}

export const directionEnum = z.enum(["long", "short"]);
export const statusEnum = z.enum(["open", "closed"]);
export const exitReasonEnum = z.enum([
  "target",
  "stop",
  "trailed",
  "manual_early",
  "manual_late",
  "breakeven",
  "other",
]);
export const noManagementOutcomeEnum = z.enum([
  "target_first",
  "stop_first",
  "undetermined",
]);

export const insertTradeSchema = createInsertSchema(trades)
  .omit({ id: true })
  .extend({
    symbol: z.string().min(1),
    direction: directionEnum,
    status: statusEnum.optional(),
    exitReason: exitReasonEnum.nullable().optional(),
    noManagementOutcome: noManagementOutcomeEnum.nullable().optional(),
  });

export const updateTradeSchema = insertTradeSchema.partial();

export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type UpdateTrade = z.infer<typeof updateTradeSchema>;
export type Trade = typeof trades.$inferSelect;

/* ============================ mistakeTags =========================== */

export const mistakeTags = sqliteTable("mistake_tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  color: text("color").notNull().default("red"),
});

export const insertMistakeTagSchema = createInsertSchema(mistakeTags)
  .omit({ id: true })
  .extend({ name: z.string().min(1) });

export type InsertMistakeTag = z.infer<typeof insertMistakeTagSchema>;
export type MistakeTag = typeof mistakeTags.$inferSelect;

/* =========================== tradeMistakes ========================== */

export const tradeMistakes = sqliteTable("trade_mistakes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tradeId: integer("trade_id").notNull(),
  mistakeTagId: integer("mistake_tag_id").notNull(),
});

export const insertTradeMistakeSchema = createInsertSchema(tradeMistakes).omit({
  id: true,
});

export type InsertTradeMistake = z.infer<typeof insertTradeMistakeSchema>;
export type TradeMistake = typeof tradeMistakes.$inferSelect;

/* ======================== weekly combat plans ======================= */

export const weeklyReviews = sqliteTable("weekly_reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  weekStart: text("week_start").notNull(), // yyyy-MM-dd (Monday)
  plans: text("plans").notNull(), // JSON: [{ tagId, tagName, plan }]
  submittedAt: text("submitted_at").notNull(),
});

export const insertWeeklyReviewSchema = createInsertSchema(weeklyReviews).omit({
  id: true,
});

export type InsertWeeklyReview = z.infer<typeof insertWeeklyReviewSchema>;
export type WeeklyReview = typeof weeklyReviews.$inferSelect;

/* ===================== API payloads (screenshots) =================== */

export const parseScreenshotSchema = z.object({
  image: z.string().min(1), // data URL or raw base64
  kind: z.enum(["setup", "outcome"]),
  context: z
    .object({
      symbol: z.string().optional(),
      direction: directionEnum.optional(),
      entryPrice: z.number().optional(),
      initialStop: z.number().optional(),
      initialTarget: z.number().optional(),
    })
    .optional(),
});

export const analyzeRationaleSchema = z.object({
  text: z.string().min(1),
});

export type AnalyzeRationaleRequest = z.infer<typeof analyzeRationaleSchema>;

export interface AnalyzeRationaleResult {
  tags: string[];
}

export type ParseScreenshotRequest = z.infer<typeof parseScreenshotSchema>;

export interface SetupParseResult {
  symbol: string | null;
  direction: "long" | "short" | null;
  entryPrice: number | null;
  initialStop: number | null;
  initialTarget: number | null;
  entryTime: string | null;
  size: number | null;
  /** True when the screenshot already shows the trade as completed/closed. */
  isClosed?: boolean | null;
  exitPrice?: number | null;
  exitTime?: string | null;
  exitReason?:
    | "target"
    | "stop"
    | "trailed"
    | "manual_early"
    | "manual_late"
    | "breakeven"
    | "other"
    | null;
}

export interface OutcomeParseResult {
  mae: number | null;
  mfe: number | null;
  noManagementOutcome: "target_first" | "stop_first" | "undetermined" | null;
}

/* ==================== trade with tags (read model) ================== */

export interface TradeWithTags extends Trade {
  mistakeTagIds: number[];
}
