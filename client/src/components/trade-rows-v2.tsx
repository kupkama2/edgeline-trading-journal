/**
 * The quiet rows.
 *
 * V1 puts everything the journal knows on the row: capture ratio, MFE, MAE,
 * the management delta, the exit reason, the account, the tags. All of it is
 * true and almost none of it is what you are doing when you scroll a list of
 * closed trades — which is looking for the ones worth opening.
 *
 * So a closed row here says four things and stops: what it was, what it was
 * worth in R, what it was worth in money, and the one word for whether it was
 * one of yours. Everything V1 showed is still a click away inside the trade,
 * where there is room to read it. Nothing is computed differently; the same
 * metrics run, fewer of them are printed.
 */
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  Pencil,
  Plus,
  Skull,
  Star,
  X,
  Zap,
} from "lucide-react";
import { useUpdateTrade, useTrades } from "@/lib/data";
import { tiltFromHere } from "@shared/tilt";
import { markNote, standingOf, type Mark } from "@shared/marks";
import { lockedIn, riskLeft, stopWasMoved } from "@shared/stops";
import type { TradeWithTags } from "@shared/schema";
import { computeMetrics, fmtAmount, fmtFees, fmtMoney, fmtR } from "@shared/metrics";
import { tradeVerdict, isWin, type Verdict } from "@shared/verdict";
import { markWhen, num } from "@/components/trade-shared";
import { maskIfQuote } from "@shared/redact";

/* ============================== the word ============================== */

/**
 * Tone per verdict. Tilt and loss share the primary red because they are both
 * the colour of a day going wrong; great is the amber the journal already uses
 * for the traded-well star, so the two read as the same idea in two places.
 */
const VERDICT_TONE: Record<Verdict, string> = {
  tilt: "border-primary/50 bg-primary/10 text-primary",
  great: "border-amber-500/50 bg-amber-500/10 text-amber-400",
  win: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  loss: "border-primary/40 bg-primary/5 text-primary/90",
};

const VERDICT_TITLE: Record<Verdict, string> = {
  tilt: "Should not have been taken. Out of every number.",
  great: "Traded well: waited for it, sized it, left it alone. Whatever it paid.",
  win: "Made money.",
  loss: "Lost money.",
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium lowercase ${VERDICT_TONE[verdict]}`}
      title={VERDICT_TITLE[verdict]}
      data-testid={`verdict-${verdict}`}
    >
      {verdict === "tilt" && <Skull className="h-3 w-3" />}
      {verdict === "great" && <Star className="h-3 w-3 fill-current" />}
      {verdict}
    </span>
  );
}

/* ============================ closed trade ============================ */

export function ClosedTradeRowV2({
  t,
  expanded = false,
  onSelect,
  onEdit,
}: {
  t: TradeWithTags;
  /** The trade is open underneath this row, so the row is its header. */
  expanded?: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const m = computeMetrics(t);
  const update = useUpdateTrade();
  const { data: all = [] } = useTrades();
  const { toast } = useToast();
  const verdict = tradeVerdict(t, m.actualPnL);
  const won = isWin(m.actualPnL);
  // The money is coloured by the money, never by the verdict: a well-traded
  // loss is red and still says "great", which is the whole point of having
  // both on the row.
  // Both weights written out rather than composed: Tailwind reads the source
  // for class names, and "text-emerald-400" + "/80" is a string it never sees.
  const money = won ? "text-emerald-400" : "text-primary";
  const moneyDim = won ? "text-emerald-400/80" : "text-primary/80";

  return (
    <div
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group flex cursor-pointer items-center gap-3 rounded-md border-l-2 px-3 py-2 transition-colors hover:bg-secondary/40 ${
        t.tilt ? "border-l-primary/60 opacity-70" : won ? "border-l-emerald-500/50" : "border-l-primary/50"
      } ${expanded ? "bg-secondary/40" : ""}`}
      data-testid={`row-v2-closed-${t.id}`}
      data-verdict={verdict}
      data-expanded={expanded ? "true" : undefined}
      aria-expanded={expanded}
    >
      {/* The ticker and the word for what it was, together — they are one
          sentence, and putting them at opposite ends of a wide row makes you
          read it twice. A minimum width rather than a fixed one lines the
          badges up down the list without cutting a long ticker in half. */}
      <span
        className="min-w-[3.25rem] shrink-0 font-mono text-sm font-semibold"
        data-testid={`row-v2-symbol-${t.id}`}
      >
        {t.symbol}
      </span>

      {/* A scalp is a result rather than a set of prices, so its R comes from
          a risk you typed rather than a stop you placed. One mark says which
          kind of row this is — without it a scalp and a fully priced trade
          look identical and only one of them can answer "how far did it go
          against me". */}
      {t.scalp && (
        <span
          className="shrink-0 text-amber-500/70"
          title="Logged as a scalp: a result rather than a set of prices"
          aria-label="Scalp"
          data-testid={`row-v2-scalp-${t.id}`}
        >
          <Zap className="h-3 w-3" />
        </span>
      )}

      <VerdictBadge verdict={verdict} />

      <span className="min-w-0 flex-1" />

      {/* Hover only, and only on a pointer: the two verdicts are worth one tap
          from the list, and worth nothing at all if they cost the row its
          quiet. On a phone they live inside the trade. */}
      <span className="hidden items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 sm:flex">
        <Button
          size="icon"
          variant="ghost"
          className={`h-6 w-6 ${t.tilt ? "text-primary" : "text-muted-foreground hover:text-primary"}`}
          onClick={(e) => {
            e.stopPropagation();
            update.mutate(
              { id: t.id, trade: { tilt: !t.tilt } },
              {
                onSuccess: () =>
                  toast(
                    t.tilt
                      ? { title: "Back in the plan", description: `${t.symbol} counts again.` }
                      : {
                          title: "Marked tilt",
                          description: `${t.symbol} is out of the plan book and every number.`,
                        },
                  ),
              },
            );
          }}
          aria-label={t.tilt ? "Back into the plan" : "Mark as tilt"}
          aria-pressed={t.tilt}
          title={t.tilt ? "In the tilt book — click to put it back" : "Mark as tilt: it should not have been taken"}
          data-testid={`button-v2-tilt-${t.id}`}
        >
          <Skull className="h-3 w-3" />
        </Button>
        {!t.tilt && (
          <Button
            size="icon"
            variant="ghost"
            className={`h-6 w-6 ${
              t.wellTraded ? "text-amber-400" : "text-muted-foreground hover:text-amber-400"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              update.mutate({ id: t.id, trade: { wellTraded: !t.wellTraded } });
            }}
            aria-label={t.wellTraded ? "Not traded well after all" : "Mark as traded well"}
            aria-pressed={t.wellTraded === true}
            title={
              t.wellTraded
                ? "Traded well — click to take it back"
                : "Mark as traded well: waited for it, sized it, left it alone"
            }
            data-testid={`button-v2-well-${t.id}`}
          >
            <Star className={`h-3 w-3 ${t.wellTraded ? "fill-current" : ""}`} />
          </Button>
        )}
        {/* The third verdict, on how the trade was RECORDED rather than on how
            it was taken or run. It belongs beside the other two because it is
            reached for in the same moment — going back over a day's rows and
            saying what each one was — and because promotion takes the mark off
            a scalp the moment it is given prices, so putting it back needs to
            cost one click from the row. A scalp reads from a typed result, so
            marking one writes the P&L and risk the trade already computed. */}
        <Button
          size="icon"
          variant="ghost"
          className={`h-6 w-6 ${
            t.scalp ? "text-amber-500" : "text-muted-foreground hover:text-amber-500"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            update.mutate({
              id: t.id,
              trade: t.scalp
                ? ({ scalp: false, netPnl: null, riskAmount: null } as any)
                : ({
                    scalp: true,
                    netPnl: m.actualPnL ?? 0,
                    riskAmount: m.riskDollars > 0 ? m.riskDollars : null,
                  } as any),
            });
          }}
          aria-label={t.scalp ? "Not a scalp after all" : "Mark as a scalp"}
          aria-pressed={t.scalp === true}
          title={
            t.scalp
              ? "Logged as a scalp — click to read it from its prices instead"
              : "Mark as a scalp: a result rather than a set of prices"
          }
          data-testid={`button-v2-scalp-${t.id}`}
        >
          <Zap className="h-3 w-3" />
        </Button>
        {!t.tilt && (
          <button
            type="button"
            className="rounded border border-border/60 px-1 py-0.5 font-mono text-[9px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
            onClick={(e) => {
              e.stopPropagation();
              const ids = tiltFromHere(all, t.id);
              Promise.all(ids.map((id) => update.mutateAsync({ id, trade: { tilt: true } }))).then(
                () =>
                  toast({
                    title: `${ids.length} marked tilt`,
                    description: "This one and everything after it that day.",
                  }),
              );
            }}
            title="Everything after this one that day was tilt"
            data-testid={`button-v2-tilt-from-${t.id}`}
          >
            from here
          </button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          aria-label="Edit trade"
          data-testid={`button-v2-edit-${t.id}`}
        >
          <Pencil className="h-3 w-3" />
        </Button>
      </span>

      {/* R first, money second, both right-aligned in fixed columns so a
          column of rows reads as a column of numbers rather than a ragged
          edge that moves with the length of the ticker. */}
      <span
        className={`w-16 shrink-0 text-right font-mono text-sm font-bold tabular-nums ${money}`}
        data-testid={`row-v2-r-${t.id}`}
      >
        {fmtR(m.actualR)}
      </span>
      <span
        className={`w-20 shrink-0 text-right font-mono text-xs tabular-nums ${moneyDim}`}
        title={m.fees > 0 ? `net of ${fmtFees(m.fees)} fees` : undefined}
        data-testid={`row-v2-pnl-${t.id}`}
      >
        {fmtMoney(m.actualPnL)}
      </span>
    </div>
  );
}

/* ============================= open trade ============================= */

/**
 * A live position on one line: what you are holding, and what it is doing.
 *
 * Size, what is at risk, and how it is doing. The prices are deliberately
 * gone: entry, stop and target are a plan you already made and cannot read
 * anything new from — you know where your stop is — and four numbers that
 * never change next to the ones that move every minute buries the moving
 * ones. They are all still inside the trade, one click down.
 *
 * Risk is what the stop would cost FROM HERE, not what it cost at entry. On a
 * trade that has run, those are different questions and only one of them is
 * still a decision: a position up two R with the stop still at the original
 * level is risking the open profit, and "1R" would go on describing a
 * yesterday that no longer exists. Once price is through the stop the figure
 * would go negative — you are past the point it was measuring — so it stops
 * and says so instead.
 *
 * The same two columns as a closed row, at the same widths, so open and closed
 * positions form one column of figures down the page rather than two ragged
 * ones.
 *
 * Two things survive the cut. The scaling controls, because they are the one
 * thing on this row you press mid-trade — on hover, not as two permanent
 * buttons on every position. And the crossed-level warning: "price is through
 * your stop, is this still open?" is not a figure, it is the journal noticing
 * something about your record that you would want to know.
 */
export function OpenTradeRowV2({
  t,
  mark = null,
  expanded = false,
  onSelect,
  onEdit,
  onResolve,
  onAdd,
  onTake,
}: {
  t: TradeWithTags;
  mark?: Mark | null;
  /** The trade is open underneath this row, so the row is its header. */
  expanded?: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onResolve: () => void;
  onAdd: () => void;
  onTake: () => void;
}) {
  const standing = mark ? standingOf(t, mark.price) : null;
  const note = mark ? markNote(mark, markWhen(mark.at)) : null;
  const long = t.direction === "long";
  // Green and red follow the money, and both are absent until a venue says
  // what the thing is worth — a position with no live price shows a dash
  // rather than a zero, because flat and unknown are not the same news.
  const up = (standing?.pnl ?? 0) >= 0;
  const tone = standing == null ? "text-muted-foreground" : up ? "text-emerald-400" : "text-primary";
  const toneDim =
    standing == null ? "text-muted-foreground" : up ? "text-emerald-400/80" : "text-primary/80";
  /*
   * What is still at risk, against the stop as it stands TODAY.
   *
   * riskLeft measures from the average entry to the current stop, so pulling
   * the stop up is visible here immediately and a stop through the entry
   * reads as nothing at risk. That is a different question from "how far is
   * price from my stop", and it is the one worth carrying on a row: it does
   * not move when the market breathes, only when you decide something.
   */
  const m = computeMetrics(t);
  const left = riskLeft(t);
  const locked = lockedIn(t);
  const moved = stopWasMoved(t);

  return (
    <div
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-card px-3 py-2 transition-colors hover:border-primary/40 ${
        expanded ? "border-primary/40 bg-secondary/30" : "border-card-border"
      }`}
      data-testid={`row-v2-open-${t.id}`}
      data-expanded={expanded ? "true" : undefined}
      aria-expanded={expanded}
    >
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
          long ? "bg-emerald-500/15 text-emerald-400" : "bg-primary/15 text-primary"
        }`}
        title={long ? "Long" : "Short"}
      >
        {long ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      </span>
      <span className="min-w-[3.25rem] shrink-0 font-mono text-sm font-semibold">{t.symbol}</span>
      <span
        className="font-mono text-[11px] text-muted-foreground"
        data-testid={`row-v2-size-${t.id}`}
      >
        {maskIfQuote(t.sizeUnit, num(t.size))}
        {t.sizeUnit === "quote" ? " USD" : ""}
      </span>
      <span
        className={`font-mono text-[11px] ${
          locked != null ? "text-emerald-400/90" : "text-muted-foreground"
        }`}
        title={
          left == null
            ? "No stop recorded, so nothing here knows what this is risking"
            : locked != null
              ? `The stop is through the entry — this much cannot be given back. Taken with ${fmtAmount(m.riskDollars)} at risk.`
              : moved
                ? `Against the stop as it stands now. Taken with ${fmtAmount(m.riskDollars)} at risk.`
                : "What the stop would cost from the average entry"
        }
        data-testid={`row-v2-risk-${t.id}`}
      >
        {left == null
          ? "no stop"
          : locked != null
            ? `locked ${fmtMoney(locked)}`
            : left === 0
              ? "risk nothing"
              : `risk ${fmtAmount(left)}`}
      </span>

      {standing?.crossedStop && (
        <span className="text-[10px] text-primary" data-testid={`row-v2-crossed-${t.id}`}>
          through the stop — still open?
        </span>
      )}
      {standing?.crossedTarget && !standing.crossedStop && (
        <span className="text-[10px] text-emerald-400" data-testid={`row-v2-crossed-${t.id}`}>
          through the target — still open?
        </span>
      )}

      {/* Only when there is something to warn about: a perp priced off spot,
          or off the archive. A live quote from its own book says nothing. */}
      {note?.badge && (
        <span
          className="shrink-0 text-[10px] text-muted-foreground"
          title={note.title}
          data-testid={`v2-open-mark-note-${t.id}`}
        >
          {note.badge}
        </span>
      )}

      <span className="min-w-0 flex-1" />

      {/* Nothing while the trade is open below: its own header carries Take,
          Add, Edit and the rest, and a second set on the row was the same
          buttons twice with the ticker between them. */}
      <span
        className={`flex shrink-0 items-center gap-1 ${
          expanded
            ? "hidden"
            : "sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
        }`}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-1.5 text-[10px]"
          onClick={(e) => {
            e.stopPropagation();
            onTake();
          }}
          data-testid={`button-v2-partial-${t.id}`}
        >
          <Minus className="mr-0.5 h-3 w-3" /> Take
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-1.5 text-[10px]"
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          data-testid={`button-v2-add-${t.id}`}
        >
          <Plus className="mr-0.5 h-3 w-3" /> Add
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          aria-label="Edit trade"
          data-testid={`button-v2-edit-open-${t.id}`}
        >
          <Pencil className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6 text-muted-foreground hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onResolve();
          }}
          aria-label="Never became a position"
          data-testid={`button-v2-resolve-${t.id}`}
        >
          <X className="h-3 w-3" />
        </Button>
      </span>

      {/* The two that move. Same widths as a closed row's. */}
      <span
        className={`w-16 shrink-0 text-right font-mono text-sm font-bold tabular-nums ${tone}`}
        data-testid={`row-v2-standing-${t.id}`}
      >
        {fmtR(standing?.currentR)}
      </span>
      <span
        className={`w-20 shrink-0 text-right font-mono text-xs tabular-nums ${toneDim}`}
        title={
          standing == null || note == null
            ? "No live price for this one — nothing is quoting it here"
            : note.title
        }
        /* Not "row-v2-open-pnl": that prefix collides with the row's own
           "row-v2-open-<id>", so a selector for open rows picked up their
           money cells too. */
        data-testid={`v2-open-pnl-${t.id}`}
      >
        {fmtMoney(standing?.pnl)}
      </span>
    </div>
  );
}
