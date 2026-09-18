/**
 * Which lines go on a trade's chart, and which of them you may drag.
 *
 * Kept away from the canvas because it is the part with the rules in it — the
 * plan against the management, a field being typed against a field at rest —
 * and those are worth reading, and testing, without a chart engine and a DOM
 * in the way.
 */
import { parseExtraTargets, type TradeWithTags } from "@shared/schema";
import { currentStop } from "@shared/stops";

/**
 * The trade columns a line on the chart can be dragged into.
 *
 * Deliberately the four single-valued ones. The scale-out targets beyond TP1
 * still draw, but they are a list rather than a column, and a grab handle
 * that has to say WHICH tp2 it is turns one gesture into two decisions. The
 * moved stop is left alone for a stronger reason — see below.
 */
export type LevelField = "entryPrice" | "initialStop" | "initialTarget" | "exitPrice";

/**
 * Levels a form is holding but has not saved.
 *
 * Numbers being typed into an editor, or just dragged on the chart. The chart
 * draws these in place of the trade's own so the line moves while the number
 * is still being decided, rather than after it has been committed — which is
 * the moment "is that where the stop goes" is actually being asked. Filling a
 * trade in backwards against a chart you cannot see the effect on is guesswork
 * with extra steps.
 *
 * Absent and undefined are different: a key that is not here means "the trade
 * still speaks for this one", and an explicit null means the form has emptied
 * it and the line should go.
 */
export interface LevelDraft {
  entryPrice?: number | null;
  initialStop?: number | null;
  initialTarget?: number | null;
  exitPrice?: number | null;
  extraTargets?: number[] | null;
}

export type Level = {
  price: number;
  label: string;
  color: string;
  dashed: boolean;
  /** Drawn quietly — a level that is history rather than a live one. */
  faint?: boolean;
  /** Set only where the line may be dragged, and where it writes when it is. */
  field?: LevelField;
};

/**
 * The lines, in drawing order, for a trade and whatever a form is holding.
 *
 * Pure on purpose: hand it a trade and a draft, get back what should be on
 * screen. Nothing here reads the DOM, so the one thing that decides whether a
 * chart tells the truth can be checked without one.
 */
export function chartLevels(trade: TradeWithTags, draft?: LevelDraft): Level[] {
  // A scalp was recorded as a result, so it has no levels to draw — and an
  // entry of zero is not a level, it is the absence of one. Drawing it put
  // a line at the bottom of the axis and squashed every candle into a
  // stripe at the top.
  if (trade.scalp) return [];
  /** The form's number where it has one, the trade's otherwise. */
  const said = <K extends keyof LevelDraft>(k: K, saved: number | null) =>
    draft && k in draft ? ((draft[k] as number | null) ?? null) : saved;
  const tps = draft?.extraTargets ?? parseExtraTargets(trade.extraTargets);
  const entry = said("entryPrice", trade.entryPrice);
  const target = said("initialTarget", trade.initialTarget);
  const exit = said("exitPrice", trade.exitPrice);
  /*
   * Two stops, and which one the line is depends on who is asking.
   *
   * The chart is where you look to see where your stop is, and it once drew
   * the one the trade was OPENED with — so a position pulled up to breakeven
   * still showed its line down at the original level, contradicting the stop
   * card directly above it. So `currentStop` wins for a reader, and the
   * original stays on faintly, because seeing the distance travelled is most
   * of why you would look.
   *
   * A form editing `initialStop` is editing the plan, though, and a line
   * that ignored the field while the field was open would be a chart of a
   * different trade. So a draft that carries the stop wins over both.
   */
  const live = currentStop(trade);
  const editing = draft != null && "initialStop" in draft;
  const stop = editing ? said("initialStop", trade.initialStop) : live;
  const managed = live != null && trade.initialStop != null && live !== trade.initialStop;
  /* The stop a trade started with, once it is no longer the one in force.
     Not while the plan itself is being edited: it would be drawn at the very
     number the solid line is being dragged away from, which reads as two
     stops rather than as one and a memory. */
  const moved = managed && !editing;
  /*
   * A trade whose stop has been MOVED does not get a handle, and that is not
   * caution. initialStop is the R denominator — every R on this trade, and
   * every average built from it, is measured against it — so it is the plan,
   * not the management. Dragging the line would silently rewrite the
   * denominator and restate the trade's whole history. Moving a live stop is
   * what the stop card is for, and it records WHEN as well as where. So the
   * handle is offered only while the two are still the same number, which is
   * exactly the case this is for: a trade being filled in after the fact.
   */
  const stopField: LevelField | undefined = managed ? undefined : "initialStop";
  return [
    ...(entry != null
      ? [{ price: entry, label: "entry", color: "entry", dashed: false, field: "entryPrice" as const }]
      : []),
    ...(stop != null
      ? [{ price: stop, label: "stop", color: "stop", dashed: true, field: stopField }]
      : []),
    ...(moved
      ? [{ price: trade.initialStop!, label: "was", color: "stop", dashed: true, faint: true }]
      : []),
    ...(target != null
      ? [{ price: target, label: "target", color: "target", dashed: true, field: "initialTarget" as const }]
      : []),
    ...tps.map((p: number, i: number) => ({
      price: p,
      label: `tp${i + 2}`,
      color: "target",
      dashed: true,
    })),
    ...(exit != null
      ? [{ price: exit, label: "exit", color: "exit", dashed: false, field: "exitPrice" as const }]
      : []),
  ];
}
