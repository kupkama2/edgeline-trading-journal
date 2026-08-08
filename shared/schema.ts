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
  /**
   * The hours this book is supposed to trade, "HH:MM" local, both optional.
   * The hour-of-day breakdown can show that 14:00 loses money; the window is
   * how that finding becomes enforcement — logging an entry outside it gets a
   * warning at the moment the decision is being made, not in next week's stats.
   */
  sessionStart: text("session_start"),
  sessionEnd: text("session_end"),
});

const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)")
  .nullable()
  .optional();

export const insertTradingStyleSchema = createInsertSchema(tradingStyles)
  .omit({ id: true })
  .extend({ name: z.string().min(1), sessionStart: hhmm, sessionEnd: hhmm });

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
  /**
   * Planned scale-out levels beyond the first target, stored as a JSON
   * number[] (same text-column convention as rationaleTags). initialTarget
   * stays TP1 and keeps driving every R:R and planned-R figure — extra TPs
   * are where the partials are MEANT to happen, not a redefinition of the
   * plan's reward. NULL for the common single-target trade.
   */
  extraTargets: text("extra_targets"),
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
  /**
   * Where the trade was executed — "Binance Futures", "Apex eval", "IBKR
   * real". Free text on purpose: accounts come and go (prop evals expire,
   * brokers change) and a managed table would make every one of them a
   * chore. The entry card re-offers every name already used, so spelling
   * stays consistent without any admin UI. NULL = not recorded.
   */
  account: text("account"),
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

/**
 * Read the extra-TP column back into numbers, defensively: the column is free
 * text, so anything that isn't a positive finite number is dropped rather than
 * allowed to poison a price display. Order is preserved — TP2 comes back
 * before TP3 because that is the order they were planned in.
 */
export function parseExtraTargets(json: string | null | undefined): number[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is number => typeof x === "number" && isFinite(x) && x > 0);
  } catch {
    return [];
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

/**
 * Why a trade never became a position.
 *
 * 'never_placed' is the missed trade: the setup was seen and the order was
 * never sent. It is kept in the same table as everything else on purpose — a
 * trade you talked yourself out of is a decision with a price, and the only way
 * to put a number on it is to store the plan next to the trades you did take.
 */
export const cancelReasonEnum = z.enum([
  "not_filled",
  "pulled",
  "changed_mind",
  "never_placed",
]);
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
  plans: text("plans"), // JSON: [{ tagId, tagName, plan }] — the manual "fix one" plan
  /** JSON WeeklyInsights — AI reading of the week's notes against its numbers. */
  insights: text("insights"),
  submittedAt: text("submitted_at").notNull(),
});

export const insertWeeklyReviewSchema = createInsertSchema(weeklyReviews)
  .omit({ id: true })
  .extend({
    plans: z.string().nullable().optional(),
    insights: z.string().nullable().optional(),
  });

export type InsertWeeklyReview = z.infer<typeof insertWeeklyReviewSchema>;
export type WeeklyReview = typeof weeklyReviews.$inferSelect;

/* =========================== daily notes ============================ */

/**
 * One free-form file per trading day.
 *
 * This is deliberately a single text blob, not structured fields: the point is
 * to be able to dump whatever happened — state of mind, what the market did,
 * why a trade was skipped — at any moment of the day without a form in the way.
 * Structure comes later, from reading it next to the day's computed numbers;
 * the daily report derives everything quantitative from the trades themselves.
 */
export const dailyNotes = pgTable("daily_notes", {
  id: serial("id").primaryKey(),
  day: text("day").notNull().unique(), // yyyy-MM-dd, local trading day
  body: text("body").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
});

export const upsertDailyNoteSchema = z.object({
  body: z.string(),
});

export type DailyNote = typeof dailyNotes.$inferSelect;

/* ============================ trade images ============================ */

/**
 * Screenshots attached to a trade — the visual record, kept for review.
 *
 * A separate table, and that separation IS the feature: a base64 chart is
 * ~300x the trade row it belongs to, and stored inline it would ride along in
 * every /api/trades response forever. Here images are fetched only when a
 * trade's detail is opened; the list endpoint carries a count and nothing
 * else. This is why screenshots used to be parsed-then-discarded — the cost
 * problem lived in the placement, not the keeping.
 */
export const tradeImages = pgTable("trade_images", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id").notNull(),
  /** What the shot shows: the plan, the aftermath, or anything else. */
  kind: text("kind").notNull().default("other"), // 'setup' | 'outcome' | 'other'
  /** Downscaled data-URL. The client shrinks before upload; the server caps size. */
  data: text("data").notNull(),
  createdAt: text("created_at").notNull(),
});

export const imageKindEnum = z.enum(["setup", "outcome", "other"]);

export const addTradeImageSchema = z.object({
  kind: imageKindEnum.optional(),
  // ~2 MB of base64 ≈ a 1.5 MB image — far above what the client's downscale
  // produces, low enough that nobody stores a screen recording in a row.
  data: z.string().min(1).max(2_000_000),
});

export type TradeImage = typeof tradeImages.$inferSelect;

/* ============================= trade fills ============================= */

/**
 * Scaling events on a running trade: profit taken off, or size added on.
 *
 * A fill is not a trade — it is a movement inside one position's life, and
 * modelling it that way (rather than as sibling trades) is what keeps the
 * journal honest: one idea, one row, one R, however many pieces it was
 * executed in. Adds move the weighted average entry; partials realise P&L
 * against that average; the final close settles whatever is left.
 *
 * `size` is denominated in the TRADE's sizeUnit — contracts for a futures
 * book, USD notional for crypto — so the number typed here is the number the
 * venue showed.
 */
export const tradeFills = pgTable("trade_fills", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id").notNull(),
  kind: text("kind").notNull(), // 'add' | 'partial'
  price: doublePrecision("price").notNull(),
  size: doublePrecision("size").notNull(),
  time: text("time").notNull(), // ISO
  note: text("note"),
});

export const fillKindEnum = z.enum(["add", "partial"]);

export const addFillSchema = z.object({
  kind: fillKindEnum,
  price: z.number().positive(),
  size: z.number().positive(),
  time: z.string().optional(),
  note: z.string().max(300).nullable().optional(),
});

export type TradeFill = typeof tradeFills.$inferSelect;

/* ===================== API payloads (screenshots) =================== */

export const parseScreenshotSchema = z.object({
  image: z.string().min(1), // data URL or raw base64
  kind: z.enum(["setup", "outcome", "orders"]),
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

/**
 * One row from an orders-table screenshot. Same shape the text importer emits,
 * so a screenshot and a paste feed the identical preview and commit path.
 */
export interface OrderRowParseResult {
  symbol: string | null;
  direction: "long" | "short" | null;
  size: number | null;
  sizeUnit: "base" | "quote" | null;
  entryPrice: number | null;
  initialStop: number | null;
  initialTarget: number | null;
  entryTime: string | null;
}

export interface SetupParseResult {
  /** True when the image was a multi-row orders table rather than one trade. */
  looksLikeOrdersTable?: boolean;
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
  /** How many screenshots are attached — the images themselves never ride in
      the list; they're fetched per trade when the detail opens. */
  imageCount: number;
  /** Scaling events, oldest first. A handful of floats per row, so unlike
      images they ride with the list — the metrics need them everywhere. */
  fills: TradeFill[];
}
