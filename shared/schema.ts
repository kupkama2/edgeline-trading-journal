import {
  pgTable,
  text,
  integer,
  serial,
  boolean,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

/* ========================== tradingStyles =========================== */

/**
 * A trading style doubles as the account: "NQ scalps" and "crypto swings" are
 * different books with different hold times and R profiles, so their stats,
 * demon streaks and guardrails must never pool. Every trade belongs to at most
 * one style (null = logged before styles existed, shown as "Unassigned").
 */
export const tradingStyles = pgTable("trading_styles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color").notNull().default("slate"),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const insertTradingStyleSchema = createInsertSchema(tradingStyles)
  .omit({ id: true })
  .extend({ name: z.string().min(1) });

export type InsertTradingStyle = z.infer<typeof insertTradingStyleSchema>;
export type TradingStyle = typeof tradingStyles.$inferSelect;

/* ============================== trades ============================== */

export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  styleId: integer("style_id"),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(), // 'long' | 'short'
  size: doublePrecision("size").notNull(),
  /**
   * How `size` is denominated. Futures are sized in contracts ("base"); crypto
   * is usually sized by USD notional ("quote"), which is how the venues report
   * it and how it is actually decided. Storing the unit beats converting on the
   * way in — the number you typed is the number you see.
   * Defaults to "base" so every pre-existing row keeps its meaning.
   */
  sizeUnit: text("size_unit").notNull().default("base"), // 'base' | 'quote'
  /**
   * Dollars per point of price movement, per contract. Derived from the symbol
   * as typed ("MNQU6" → 2) and stored on the trade, so history keeps the value
   * that applied when it was logged even if the contract table changes later.
   * 1 for crypto/equities, where price is already in quote currency.
   */
  pointValue: doublePrecision("point_value").notNull().default(1),
  entryPrice: doublePrecision("entry_price").notNull(),
  // Nullable because a PENDING trade is just a resting limit order — it has an
  // entry and nothing else yet. Both become required the moment it fills; see
  // insertTradeSchema's refinement.
  initialStop: doublePrecision("initial_stop"),
  initialTarget: doublePrecision("initial_target"),
  entryTime: text("entry_time").notNull(), // ISO
  exitPrice: doublePrecision("exit_price"),
  exitTime: text("exit_time"),
  status: text("status").notNull().default("open"), // 'pending' | 'open' | 'closed'
  exitReason: text("exit_reason"), // 'target' | 'stop' | 'trailed' | 'manual_early' | 'manual_late' | 'breakeven' | 'other'
  /**
   * Why a trade ended without ever becoming a real position. Distinct from
   * exitReason, which describes how a position that DID exist was closed.
   */
  cancelReason: text("cancel_reason"), // 'not_filled' | 'pulled' | 'changed_mind'
  /**
   * For an order that never filled: would the target have been reached anyway?
   * This is the counterfactual that makes "Didn't Take Planned Trade" costly
   * rather than merely annoying — missing a winner is the expensive half.
   */
  wouldHaveHitTarget: boolean("would_have_hit_target"),
  mae: doublePrecision("mae"),
  mfe: doublePrecision("mfe"),
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
/** 'base' = contracts/coins, 'quote' = USD(T) notional. */
export const sizeUnitEnum = z.enum(["base", "quote"]);
/**
 * 'pending' is a resting limit order that has not filled — logged so you can
 * see how many positions could open, with rationale added later. It carries no
 * risk yet, so it is excluded from every P&L, demon and guardrail calculation
 * (all of which key off 'closed').
 */
export const statusEnum = z.enum(["pending", "open", "closed", "cancelled"]);

/** Why a trade never became a position. */
export const cancelReasonEnum = z.enum(["not_filled", "pulled", "changed_mind"]);
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

const tradeFields = createInsertSchema(trades)
  .omit({ id: true })
  .extend({
    symbol: z.string().min(1),
    styleId: z.number().int().nullable().optional(),
    direction: directionEnum,
    status: statusEnum.optional(),
    sizeUnit: sizeUnitEnum.optional(),
    initialStop: z.number().nullable().optional(),
    initialTarget: z.number().nullable().optional(),
    exitReason: exitReasonEnum.nullable().optional(),
    cancelReason: cancelReasonEnum.nullable().optional(),
    wouldHaveHitTarget: z.boolean().nullable().optional(),
    noManagementOutcome: noManagementOutcomeEnum.nullable().optional(),
  });

/**
 * A pending trade may have no stop and no target — it is only a resting order.
 * Once it is open or closed both are mandatory: 1R is defined as entry-to-stop,
 * so a live position without a stop would silently poison every R-based metric.
 */
function requireRiskOnceLive(
  v: { status?: string | null; initialStop?: number | null; initialTarget?: number | null },
  ctx: z.RefinementCtx,
) {
  const st = v.status ?? "open";
  if (st === "pending" || st === "cancelled") return;
  for (const field of ["initialStop", "initialTarget"] as const) {
    if (v[field] == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is required once a trade is open or closed`,
      });
    }
  }
}

export const insertTradeSchema = tradeFields.superRefine(requireRiskOnceLive);

/**
 * Partial updates can't be refined the same way — a PATCH that only sets tags
 * carries no status, and the rule needs the merged row. Routes enforce it after
 * merging instead; see assertRiskOnceLive in server/routes.ts.
 */
export const updateTradeSchema = tradeFields.partial();

export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type UpdateTrade = z.infer<typeof updateTradeSchema>;
export type Trade = typeof trades.$inferSelect;

/* ============================ mistakeTags =========================== */

export const mistakeTags = pgTable("mistake_tags", {
  id: serial("id").primaryKey(),
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

export const tradeMistakes = pgTable("trade_mistakes", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id").notNull(),
  mistakeTagId: integer("mistake_tag_id").notNull(),
});

export const insertTradeMistakeSchema = createInsertSchema(tradeMistakes).omit({
  id: true,
});

export type InsertTradeMistake = z.infer<typeof insertTradeMistakeSchema>;
export type TradeMistake = typeof tradeMistakes.$inferSelect;

/* ======================== weekly combat plans ======================= */

export const weeklyReviews = pgTable("weekly_reviews", {
  id: serial("id").primaryKey(),
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
