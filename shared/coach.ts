/**
 * What to fix next, per style.
 *
 * Crypto swings and Nasdaq scalps are different jobs; averaging them produces
 * advice that fits neither. So every check below runs inside one style at a
 * time, and each returns an estimated cost in R — the leak is ranked by what
 * it is worth, not by how easy it was to detect.
 *
 * Rules, not a model. Every finding here is arithmetic over the log and can
 * be checked by hand, which matters because the whole point is to be believed
 * on a Monday morning. The checks are deliberately few and blunt: a long list
 * of small observations is how a review gets ignored.
 *
 * Each finding carries what it would have been worth to fix — `costR` — which
 * is an upper bound, not a promise. Cutting the worst hour does not hand you
 * those R back; it tells you where they went.
 */
import type { MistakeTag, TradeWithTags } from "./schema";
import { closedTrades, computeMetrics } from "./metrics";
import { byHour, byMistake } from "./breakdowns";
import { inSessionWindow } from "./session";
import { isMissed, missedStats } from "./missed";
import { MIN_GRADED, axisReport, exitCost, overrideReport } from "./grades";

export interface Finding {
  /** Stable id so the UI can key and dismiss. */
  id: string;
  title: string;
  detail: string;
  /** Estimated R currently lost to this, always ≥ 0. */
  costR: number;
  kind: "timing" | "demon" | "exits" | "stops" | "sizing" | "skipped" | "process";
}

export interface StyleReview {
  styleId: number | null;
  styleName: string;
  trades: number;
  findings: Finding[];
}

/** Below this, a bucket is an anecdote. */
const MIN_BUCKET = 4;
/** Below this, a style has nothing to review yet. */
const MIN_STYLE = 8;

export function reviewStyle(
  trades: TradeWithTags[],
  tags: MistakeTag[],
  styleId: number | null,
  styleName: string,
): StyleReview {
  const scoped = trades.filter((t) => (t.styleId ?? null) === styleId);
  const closed = closedTrades(scoped);
  const findings: Finding[] = [];

  if (closed.length >= MIN_STYLE) {
    /* ---- the hour that keeps costing ---- */
    const hours = byHour(scoped).filter((h) => h.count >= MIN_BUCKET && h.totalR < 0);
    const worstHour = hours.sort((a, b) => a.totalR - b.totalR)[0];
    if (worstHour) {
      findings.push({
        id: `hour:${styleId}:${worstHour.key}`,
        kind: "timing",
        costR: -worstHour.totalR,
        title: `${worstHour.label} is where this book leaks`,
        detail: `${worstHour.count} trades in that hour, ${(worstHour.winRate * 100).toFixed(
          0,
        )}% winners, ${worstHour.totalR.toFixed(1)}R in total. Every other hour combined is what pays you.`,
      });
    }

    /* ---- the demon with a price ---- */
    const demons = byMistake(scoped, tags).filter((d) => d.count >= 3 && d.totalR < 0);
    const worstDemon = demons[0];
    if (worstDemon) {
      findings.push({
        id: `demon:${styleId}:${worstDemon.key}`,
        kind: "demon",
        costR: -worstDemon.totalR,
        title: `"${worstDemon.label}" is the expensive habit here`,
        detail: `${worstDemon.count} trades carry it, averaging ${worstDemon.expectancyR.toFixed(
          2,
        )}R. Removing just this one would change the book's whole result.`,
      });
    }

    /* ---- exits: how much of the move is handed back ---- */
    const withPath = closed
      .map((t) => computeMetrics(t))
      .filter((m) => m.captureRatioClipped != null && m.mfeR != null && m.mfeR > 0);
    if (withPath.length >= MIN_BUCKET) {
      const capture =
        withPath.reduce((a, m) => a + (m.captureRatioClipped ?? 0), 0) / withPath.length;
      const leftOnTable = withPath.reduce((a, m) => a + Math.max(0, m.rLeftOnTable ?? 0), 0);
      if (capture < 0.45) {
        findings.push({
          id: `exits:${styleId}`,
          kind: "exits",
          costR: leftOnTable,
          title: "You are keeping less than half of what these moves offer",
          detail: `Average capture ${Math.round(capture * 100)}% across ${
            withPath.length
          } trades with a recorded path — ${leftOnTable.toFixed(
            1,
          )}R reached and then given back. Trail wider, or target where the move actually goes.`,
        });
      }
    }

    /* ---- stops: winners that had to survive deep heat ---- */
    const winnersDeepHeat = closed
      .map((t) => computeMetrics(t))
      .filter((m) => (m.actualR ?? 0) > 0 && (m.maeR ?? 0) < -0.7);
    const losersAtFullStop = closed
      .map((t) => computeMetrics(t))
      .filter((m) => (m.actualR ?? 0) <= -0.95);
    if (winnersDeepHeat.length >= 3 && winnersDeepHeat.length / closed.length > 0.15) {
      findings.push({
        id: `stops:${styleId}`,
        kind: "stops",
        costR: losersAtFullStop.length * 0.25,
        title: "Your winners are surviving the stop by a hair",
        detail: `${winnersDeepHeat.length} winners dipped past −0.7R before working. A stop that close is being paid for in full-loss trades that were right — widen it and cut size to keep 1R the same.`,
      });
    }

    /* ---- win rate vs payoff: the two-number sanity check ---- */
    const rs = closed.map((t) => computeMetrics(t).actualR ?? 0);
    const wins = rs.filter((r) => r > 0);
    const losses = rs.filter((r) => r <= 0);
    if (wins.length >= 3 && losses.length >= 3) {
      const payoff = Math.abs(
        wins.reduce((a, b) => a + b, 0) / wins.length /
          (losses.reduce((a, b) => a + b, 0) / losses.length),
      );
      const winRate = wins.length / rs.length;
      if (winRate >= 0.6 && payoff < 0.9) {
        findings.push({
          id: `payoff:${styleId}`,
          kind: "sizing",
          costR: Math.abs(rs.reduce((a, b) => a + b, 0)) * 0.5,
          title: "Winning often, and it still barely pays",
          detail: `${Math.round(winRate * 100)}% winners but each one is worth ${payoff.toFixed(
            2,
          )}× a loser. This shape breaks the moment the win rate slips — the losers need to be smaller or the winners longer.`,
        });
      }
    }

    /* ---- the grades: which way you lean, and what it costs ---- */
    findings.push(...gradeFindings(scoped, styleId));
  }

  /* ---- the ones that were never taken ---- */
  const missed = missedStats(scoped);
  if (missed.resolved >= 3 && missed.netR > 0.5) {
    findings.push({
      id: `skipped:${styleId}`,
      kind: "skipped",
      costR: missed.netR,
      title: "The setups you talk yourself out of are winners",
      detail: `${missed.resolved} resolved skips net ${missed.netR.toFixed(
        1,
      )}R in your favour. Hesitation is costing more than the bad fills it avoids.`,
    });
  }

  /* ---- process: an unloggable trade cannot be reviewed ---- */
  if (closed.length >= MIN_STYLE) {
    const noWhy = closed.filter((t) => !t.rationale?.trim()).length;
    if (noWhy / closed.length > 0.4) {
      findings.push({
        id: `process:${styleId}`,
        kind: "process",
        costR: 0,
        title: `${Math.round((noWhy / closed.length) * 100)}% of these have no rationale`,
        detail:
          "Nothing here can tell you which setup is working, because most trades never said which setup they were. This is the cheapest fix on the list.",
      });
    }
  }

  return {
    styleId,
    styleName,
    trades: closed.length,
    findings: findings.sort((a, b) => b.costR - a.costR).slice(0, 3),
  };
}

/**
 * What the self-grades say once there are enough of them.
 *
 * These are the only findings built on an opinion rather than a price, so they
 * are held to a higher bar: a lean has to be both frequent and expensive
 * before it is worth a line in the weekly read. The cost attached is always
 * measured, never inferred from the grade — you say "late", the log says how
 * much was reached and given back.
 */
function gradeFindings(scoped: TradeWithTags[], styleId: number | null): Finding[] {
  const out: Finding[] = [];

  /* ---- take profit: the two sins, priced against each other ---- */
  const exits = axisReport(scoped, "exit");
  if (exits.graded >= MIN_GRADED) {
    const cost = exitCost(scoped);
    const worst = cost.worse === "late" ? cost.lateR : cost.earlyR;
    if (cost.worse && worst > 1) {
      const late = cost.worse === "late";
      out.push({
        id: `tp:${styleId}:${cost.worse}`,
        kind: "exits",
        costR: worst,
        title: late
          ? "You hold winners past the point they pay"
          : "You take profit before the move is done",
        detail: late
          ? `${cost.lateCount} exits you graded late gave back ${cost.lateR.toFixed(
              1,
            )}R from their best price — against ${cost.earlyR.toFixed(
              1,
            )}R left behind by the ones you called early. The round trips cost more than the early exits do.`
          : `${cost.earlyCount} exits you graded early left ${cost.earlyR.toFixed(
              1,
            )}R that the move went on to offer — against ${cost.lateR.toFixed(
              1,
            )}R handed back on the late ones. Cutting winners is the more expensive habit here.`,
      });
    }
  }

  /* ---- stops: a stop you keep calling too tight is a sizing decision ---- */
  const stops = axisReport(scoped, "stop");
  const tight = stops.buckets.find((b) => b.grade === "tight");
  if (stops.graded >= MIN_GRADED && tight && tight.count >= 3 && tight.missedPlanR > 1) {
    out.push({
      id: `stopgrade:${styleId}`,
      kind: "stops",
      costR: tight.missedPlanR,
      title: "Your stop keeps taking you out of trades that were right",
      detail: `${tight.count} trades you graded "too tight" would have paid ${tight.missedPlanR.toFixed(
        1,
      )}R had the original plan run untouched. Widen the stop and cut the size to hold 1R where it is — the risk per trade does not have to move for the stop to.`,
    });
  }

  /* ---- entries: chasing shows up as heat, and heat shows up in R ---- */
  const entries = axisReport(scoped, "entry");
  const lateEntry = entries.buckets.find((b) => b.grade === "late");
  if (
    entries.graded >= MIN_GRADED &&
    lateEntry &&
    lateEntry.count >= 3 &&
    lateEntry.share >= 0.4 &&
    lateEntry.expectancyR < 0
  ) {
    out.push({
      id: `entrygrade:${styleId}`,
      kind: "timing",
      costR: -lateEntry.totalR,
      title: "The ones you chase are the ones that lose",
      detail: `${Math.round(lateEntry.share * 100)}% of your graded entries here are late, and they average ${lateEntry.expectancyR.toFixed(
        2,
      )}R — ${lateEntry.totalR.toFixed(1)}R in total. The setup is not the problem; the price you accept for it is.`,
    });
  }

  /* ---- overriding the plan: is the discretion earning its keep? ---- */
  const ov = overrideReport(scoped);
  if (ov.judged >= MIN_GRADED && ov.netR < -1) {
    out.push({
      id: `override:${styleId}`,
      kind: "exits",
      costR: -ov.netR,
      title: "Leaving your own plan alone would have paid more",
      detail: `${ov.judged} exits here were your call rather than the target or the stop, and together they came out ${ov.netR.toFixed(
        1,
      )}R behind what the untouched trade would have done. Only ${ov.ahead} of them beat the plan.`,
    });
  }

  return out;
}

/**
 * One review per style that has enough history, worst-affected style first.
 * Styles with too little to say are dropped rather than padded.
 */
export function reviewAll(
  trades: TradeWithTags[],
  tags: MistakeTag[],
  styles: { id: number; name: string; sessionStart?: string | null; sessionEnd?: string | null }[],
): StyleReview[] {
  const buckets: { id: number | null; name: string }[] = [
    ...styles.map((s) => ({ id: s.id as number | null, name: s.name })),
    { id: null, name: "Unassigned" },
  ];

  const out = buckets
    .map((b) => {
      const review = reviewStyle(trades, tags, b.id, b.name);
      // A style's own session window is a per-style rule, so the check lives
      // here where the window is in scope.
      const style = styles.find((s) => s.id === b.id);
      if (style?.sessionStart && style?.sessionEnd) {
        const closed = closedTrades(trades.filter((t) => (t.styleId ?? null) === b.id));
        const off = closed.filter(
          (t) => inSessionWindow(new Date(t.entryTime), style.sessionStart, style.sessionEnd) === false,
        );
        const offR = off.reduce((a, t) => a + (computeMetrics(t).actualR ?? 0), 0);
        if (off.length >= 3 && offR < -0.5) {
          review.findings.push({
            id: `window:${b.id}`,
            kind: "timing",
            costR: -offR,
            title: "Trades outside this book's hours are losing money",
            detail: `${off.length} entries fell outside ${style.sessionStart}–${style.sessionEnd}, together ${offR.toFixed(
              1,
            )}R. The window is doing its job; the discipline to respect it is what's missing.`,
          });
          review.findings.sort((a, b2) => b2.costR - a.costR).splice(3);
        }
      }
      return review;
    })
    .filter((r) => r.findings.length > 0);

  return out.sort(
    (a, b) =>
      b.findings.reduce((x, f) => x + f.costR, 0) - a.findings.reduce((x, f) => x + f.costR, 0),
  );
}

/** True when a trade should never reach the coach (it was never a position). */
export const coachIgnores = isMissed;
