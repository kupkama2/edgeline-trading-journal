import { markNote, standingOf, type Mark } from "@shared/marks";
/**
 * One row per trade, in each of its three lives: open, waiting to fill, closed.
 */
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ArrowDownRight, ArrowUpRight, Camera, CheckCircle2,  HelpCircle, Minus, Pencil, Plus, Skull, Star, Trash2, X, Zap } from "lucide-react";
import { useUpdateTrade, useDeleteTrade, useTrades } from "@/lib/data";
import { tiltFromHere } from "@shared/tilt";
import { isWellTraded } from "@shared/well-traded";
import { parseExtraTargets, type TradeWithTags } from "@shared/schema";
import { parseHighlights } from "@shared/highlights";
import { computeMetrics, fmtAmount, fmtFees, fmtMoney, fmtR, EXIT_REASON_LABELS } from "@shared/metrics";
import { positionLedger } from "@shared/fills";
import { outcomeParked, outcomeUnknown } from "@shared/aftermath";
import { StyleChip } from "@/components/style-switcher";
import { markWhen, num, parseTags, RationaleTags } from "@/components/trade-shared";
import { maskIfQuote } from "@shared/redact";

/* ============================== trade rows ============================ */

/** Resting this long without filling, an order is probably a stale decision. */
const STALE_PENDING_DAYS = 3;

export function OpenTradeRow({
  t,
  onSelect,
  onEdit,
  onResolve,
  onAdd,
  onTake,
  mark = null,
}: {
  t: TradeWithTags;
  onSelect: () => void;
  onEdit: () => void;
  onResolve: () => void;
  onAdd: () => void;
  onTake: () => void;
  /** Where the market is now, when a venue could say. */
  mark?: Mark | null;
}) {
  const led = positionLedger(t);
  // The plan against one price: the current R, and whether price is already
  // through a level on a trade still marked open.
  const standing = mark ? standingOf(t, mark.price) : null;
  const note = mark ? markNote(mark, markWhen(mark.at)) : null;
  const scaled = t.fills.length > 0;
  // Pending trades have no stop or target yet, so there is no R:R to show.
  const risk = t.initialStop == null ? 0 : Math.abs(t.entryPrice - t.initialStop);
  const rr =
    risk && t.initialTarget != null
      ? Math.abs(t.initialTarget - t.entryPrice) / risk
      : 0;
  const rationaleTags = parseTags(t.rationaleTags);
  return (
    <div
      data-testid={`card-open-trade-${t.id}`}
      className="relative w-full rounded-lg border border-card-border bg-card p-3 text-left transition-colors hover:border-primary/50 hover-elevate"
    >
      <div className="absolute right-1.5 top-1.5 flex gap-0.5">
        {/* Levels move while a position is live — editing must not require
            closing it first. */}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          aria-label="Edit trade"
          data-testid={`button-edit-open-${t.id}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6 text-muted-foreground hover:text-destructive"
          onClick={(e) => { e.stopPropagation(); onResolve(); }}
          aria-label="Never became a position"
          data-testid={`button-resolve-${t.id}`}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <button
        type="button"
        onClick={onSelect}
        className="block w-full text-left"
      >
        {/* Clears the three-icon action cluster pinned top-right. It was sized
            for one icon, so the size/price badge slid underneath the others. */}
        <div className="flex items-center gap-2 pr-[4.75rem]">
          <span
            className={`flex h-6 w-6 items-center justify-center rounded ${
              t.direction === "long" ? "bg-emerald-500/15 text-emerald-400" : "bg-primary/15 text-primary"
            }`}
          >
            {t.direction === "long" ? (
              <ArrowUpRight className="h-3.5 w-3.5" />
            ) : (
              <ArrowDownRight className="h-3.5 w-3.5" />
            )}
          </span>
          <span className="truncate font-mono text-sm font-semibold">{t.symbol}</span>
          <StyleChip styleId={t.styleId} />
          {t.account && (
            <Badge
              variant="outline"
              className="max-w-[8rem] truncate text-[10px] font-normal text-muted-foreground"
              data-testid={`badge-account-${t.id}`}
            >
              {t.account}
            </Badge>
          )}
          <span className="ml-auto shrink-0 rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {t.size} @ {num(t.entryPrice)}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
          <span>
            SL <span className="text-primary">{num(t.initialStop)}</span>
          </span>
          <span data-testid={`text-tps-${t.id}`}>
            TP{" "}
            <span className="text-emerald-400">
              {[t.initialTarget, ...parseExtraTargets(t.extraTargets)]
                .filter((x): x is number => x != null)
                .map((x) => num(x))
                .join(" → ")}
            </span>
          </span>
          <span>R:R {num(rr, 1)}</span>
          {mark && standing && (
            <span data-testid={`text-mark-${t.id}`} title={note?.title}>
              {/* "now" only when it is: a price off spot, or off the archive,
                  replaces the word rather than sitting next to it — "now 5.11
                  last read" says both things and means neither. */}
              {note?.badge ?? "now"}{" "}
              <span className="text-foreground">{num(mark.price)}</span>
              {standing.currentR != null && (
                <>
                  {" · "}
                  <span className={standing.currentR >= 0 ? "text-emerald-400" : "text-primary"}>
                    {fmtR(standing.currentR)}
                  </span>
                </>
              )}
            </span>
          )}
          <span className="ml-auto">
            {new Date(t.entryTime).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
        {/* Evidence, not proof: a mid through a level is very likely a fill,
            and the journal writes nothing on evidence alone — it asks. */}
        {standing?.crossedStop && (
          <p className="mt-1 text-[10px] text-primary" data-testid={`text-crossed-${t.id}`}>
            Price is through the stop — still open?
          </p>
        )}
        {standing?.crossedTarget && !standing.crossedStop && (
          <p className="mt-1 text-[10px] text-emerald-400" data-testid={`text-crossed-${t.id}`}>
            Price is through the target — still open?
          </p>
        )}
        <RationaleTags tags={rationaleTags} />
      </button>

      {/* Scaling controls live on the row because that is where the decision
          happens — mid-trade, fast. The ledger line only appears once the
          trade has actually scaled; a plain one-fill position stays quiet. */}
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/40 pt-2">
        {scaled && (
          <span className="font-mono text-[10px] text-muted-foreground" data-testid={`text-ledger-${t.id}`}>
            avg {num(led.avgEntry)} · {num(led.openQty)} on ·{" "}
            <span className={led.realizedPnL >= 0 ? "text-emerald-400" : "text-primary"}>
              {fmtMoney(led.realizedPnL)} banked
            </span>
          </span>
        )}
        <div className="ml-auto flex gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={onTake}
            data-testid={`button-partial-${t.id}`}
          >
            <Minus className="mr-0.5 h-3 w-3" /> Take
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={onAdd}
            data-testid={`button-add-${t.id}`}
          >
            <Plus className="mr-0.5 h-3 w-3" /> Add
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * A resting order that has not filled. It carries no risk yet, so there is no
 * R:R or P&L to show — what matters is what is still missing before it can go
 * live, which is what the row surfaces.
 */
export function PendingTradeRow({
  t,
  onEdit,
  onResolve,
}: {
  t: TradeWithTags;
  onEdit: () => void;
  onResolve: () => void;
}) {
  const updateTrade = useUpdateTrade();
  const { toast } = useToast();
  const needsRisk = t.initialStop == null || t.initialTarget == null;
  const needsRationale = !t.rationale?.trim();

  async function markFilled() {
    try {
      await updateTrade.mutateAsync({ id: t.id, trade: { status: "open" } });
      toast({ title: `${t.symbol} is now open` });
    } catch (err: any) {
      // The server enforces stop+target on the merged row, so this is the
      // authoritative check — surface its reason rather than pre-guessing.
      toast({
        title: "Add a stop and target first",
        description: String(err?.message ?? err).slice(0, 160),
        variant: "destructive",
      });
    }
  }
  return (
    <Card className="min-w-0 p-3" data-testid={`row-pending-${t.id}`}>
      <div className="flex items-center gap-2">
        {t.direction === "long" ? (
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        ) : (
          <ArrowDownRight className="h-3.5 w-3.5 shrink-0 text-red-500" />
        )}
        <span className="shrink-0 font-mono text-xs font-semibold">{t.symbol}</span>
        {/* The one thing in the row allowed to give way. Everything else is a
            control or a name; the size-at-price can lose its tail on a phone
            and still say what it needs to. */}
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {maskIfQuote(t.sizeUnit, String(t.size))}
          {t.sizeUnit === "quote" ? " USD" : ""} @ {num(t.entryPrice)}
        </span>
        {/* A resting order that has sat for days is usually a decision nobody
            made: the level is gone, or the idea is. Age is only worth showing
            once it becomes a question. */}
        {(() => {
          const days = Math.floor(
            (Date.now() - new Date(t.entryTime).getTime()) / 86400000,
          );
          if (!isFinite(days) || days < STALE_PENDING_DAYS) return null;
          return (
            <Badge
              variant="outline"
              className="border-amber-500/40 text-[10px] font-normal text-amber-500"
              title="This order has been resting a while — still valid, or should it be cancelled?"
              data-testid={`badge-stale-${t.id}`}
            >
              {days}d old — still valid?
            </Badge>
          );
        })()}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 shrink-0 px-2 text-[11px]"
          onClick={onEdit}
          data-testid={`button-fill-${t.id}`}
        >
          <Pencil className="mr-1 h-3 w-3" />
          Fill in
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onResolve}
          aria-label="Never filled"
          data-testid={`button-resolve-pending-${t.id}`}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5 pl-5">
        {needsRisk && (
          <Badge variant="outline" className="text-[10px] font-normal">
            needs stop &amp; target
          </Badge>
        )}
        {needsRationale && (
          <Badge variant="outline" className="text-[10px] font-normal">
            needs rationale
          </Badge>
        )}
        {!needsRisk && !needsRationale && (
          <Badge variant="secondary" className="text-[10px] font-normal">
            ready
          </Badge>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-2 text-[10px]"
          onClick={markFilled}
          disabled={updateTrade.isPending}
          data-testid={`button-mark-filled-${t.id}`}
        >
          <CheckCircle2 className="mr-1 h-3 w-3" />
          Mark filled
        </Button>
      </div>
    </Card>
  );
}

export function ClosedTradeRow({
  t,
  tagNames,
  onSelect,
  onEdit,
}: {
  t: TradeWithTags;
  tagNames: Record<number, string>;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const m = computeMetrics(t);
  const del = useDeleteTrade();
  const update = useUpdateTrade();
  const { data: all = [] } = useTrades();
  const { toast } = useToast();
  const win = (m.actualR ?? 0) >= 0;
  // The camera is a button, not a label: it both reports the count and is the
  // shortcut to add more, so attaching to a trade closed weeks ago is one
  // click from its row. With no images it stays faint and reads "add" — the
  // affordance exists without cluttering the row that has none. Counts stay
  // lazy; the images themselves load only when the trade opens.
  const shots = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onEdit();
      }}
      className={`flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 font-mono text-[10px] transition-colors hover:text-foreground ${
        t.imageCount > 0 ? "text-muted-foreground" : "text-muted-foreground/40"
      }`}
      title={t.imageCount > 0 ? "View or add screenshots" : "Add a screenshot"}
      data-testid={`badge-images-${t.id}`}
    >
      <Camera className="h-3 w-3" />
      {t.imageCount > 0 ? t.imageCount : "+"}
    </button>
  );
  const rationaleTags = parseTags(t.rationaleTags);
  /*
   * The one question this trade cannot answer for itself: left alone, would
   * price have hit the target or the stop first? Amber rather than red —
   * an incomplete record is not a bad trade — and only ever on the trades
   * where the answer is genuinely still out there, so it never becomes
   * wallpaper. The badge is the shortcut: one click to the field.
   */
  const unknown = outcomeUnknown(t);
  return (
    /* The whole row opens the trade. Clicking a thing that plainly represents
       a trade should show you the trade — an eye icon in the corner made the
       obvious gesture do nothing and hid the destination in six pixels. The
       controls inside stop the click from bubbling so each still means its own
       thing. */
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
      className={`group cursor-pointer rounded-lg border bg-card p-3 transition-colors hover:border-primary/40 ${
        unknown ? "border-amber-500/40" : t.tilt ? "border-primary/30 opacity-80" : "border-card-border"
      }`}
      data-testid={`card-closed-trade-${t.id}`}
      data-tilt={t.tilt ? "true" : undefined}
    >
      {/* Wraps on narrow screens: symbol, style, account, shots and reason are
          all shrink-0, so on a phone the money used to run off the card. The
          result group below stays glued together as one wrapping unit. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-mono text-sm font-semibold">{t.symbol}</span>
        <StyleChip styleId={t.styleId} />
        {t.account && (
          <Badge
            variant="outline"
            title={t.account}
            className="max-w-[6rem] truncate text-[10px] font-normal text-muted-foreground"
            data-testid={`badge-account-closed-${t.id}`}
          >
            {t.account}
          </Badge>
        )}
        {shots}
        {t.scalp ? (
          <Badge
            variant="outline"
            className="shrink-0 border-amber-500/40 text-[10px] text-amber-400"
            title="Logged as a scalp: a result rather than a set of prices"
            data-testid={`badge-scalp-${t.id}`}
          >
            <Zap className="mr-1 h-3 w-3" />
            scalp
          </Badge>
        ) : (
          <Badge variant="outline" className="shrink-0 text-[10px] capitalize">
            {t.exitReason ? EXIT_REASON_LABELS[t.exitReason] : "—"}
          </Badge>
        )}
        {t.tilt && (
          <Badge
            variant="outline"
            className="shrink-0 border-primary/50 text-[10px] text-primary"
            title="Should not have been taken. In the tilt book, out of every number."
            data-testid={`badge-tilt-${t.id}`}
          >
            <Skull className="mr-1 h-3 w-3" />
            tilt
          </Badge>
        )}
        {isWellTraded(t) && (
          <Badge
            variant="outline"
            className="shrink-0 border-amber-500/50 text-[10px] text-amber-400"
            title="Traded well: waited for it, sized it, left it alone. Whatever it paid."
            data-testid={`badge-well-${t.id}`}
          >
            <Star className="mr-1 h-3 w-3 fill-current" />
            well traded
          </Badge>
        )}
        {unknown && (
          <button
            type="button"
            onClick={onEdit}
            title={
              outcomeParked(t)
                ? "Marked undetermined — neither level had been reached yet. Still waiting on one."
                : "Left alone, would price have hit the target or the stop first? Not recorded."
            }
            className="flex shrink-0 items-center gap-1 rounded-full border border-amber-500/50 px-1.5 py-0.5 text-[10px] text-amber-500 transition-colors hover:bg-amber-500/10"
            data-testid={`badge-owed-${t.id}`}
          >
            <HelpCircle className="h-3 w-3" />
            target or stop?
          </button>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
        <span
          className={`shrink-0 font-mono text-sm font-bold ${
            win ? "text-emerald-400" : "text-primary"
          }`}
          data-testid={`text-actual-r-${t.id}`}
        >
          {fmtR(m.actualR)}
        </span>
        <span
          className={`shrink-0 font-mono text-xs ${win ? "text-emerald-400/80" : "text-primary/80"}`}
          title={m.fees > 0 ? `net of ${fmtFees(m.fees)} fees` : undefined}
        >
          {fmtMoney(m.actualPnL)}
        </span>
        {/* The verdict, flippable from the row: a skull that lights when the
            trade is tilt, and "from here" for the day that went wrong at a
            known point — this one and everything after it. Both surface on
            hover on a desktop and stay put on a phone. */}
        <Button
          size="icon"
          variant="ghost"
          className={`h-6 w-6 shrink-0 ${
            t.tilt
              ? "text-primary"
              : "text-muted-foreground hover:text-primary sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            // In the plan view the row leaves the list the moment it is
            // marked — that is the point — so the toast says where it went.
            update.mutate(
              { id: t.id, trade: { tilt: !t.tilt } },
              {
                onSuccess: () =>
                  toast(
                    t.tilt
                      ? { title: "Back in the plan", description: `${t.symbol} counts again.` }
                      : {
                          title: "Marked tilt",
                          description: `${t.symbol} is out of the plan book and every number. Find it under Tilt.`,
                        },
                  ),
              },
            );
          }}
          aria-label={t.tilt ? "Back into the plan" : "Mark as tilt"}
          aria-pressed={t.tilt}
          title={t.tilt ? "In the tilt book — click to put it back in the plan" : "Mark as tilt: it should not have been taken"}
          data-testid={`button-tilt-${t.id}`}
        >
          <Skull className="h-3 w-3" />
        </Button>
        {/* The other verdict, on the execution. One tap from the row,
            because the run it feeds is only worth keeping if marking a trade
            costs nothing. */}
        {!t.tilt && (
          <Button
            size="icon"
            variant="ghost"
            className={`h-6 w-6 shrink-0 ${
              t.wellTraded
                ? "text-amber-400"
                : "text-muted-foreground hover:text-amber-400 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
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
            data-testid={`button-well-${t.id}`}
          >
            <Star className={`h-3 w-3 ${t.wellTraded ? "fill-current" : ""}`} />
          </Button>
        )}
        {!t.tilt && (
          <button
            type="button"
            className="shrink-0 rounded border border-border/60 px-1 py-0.5 font-mono text-[9px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              const ids = tiltFromHere(all, t.id);
              Promise.all(ids.map((id) => update.mutateAsync({ id, trade: { tilt: true } }))).then(() =>
                toast({
                  title: `${ids.length} marked tilt`,
                  description: "This one and everything after it that day.",
                }),
              );
            }}
            title="Everything after this one that day was tilt"
            data-testid={`button-tilt-from-${t.id}`}
          >
            tilt from here
          </button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          aria-label="Edit trade"
          data-testid={`button-edit-${t.id}`}
        >
          <Pencil className="h-3 w-3" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            del.mutate(t.id);
          }}
          aria-label="Delete trade"
          data-testid={`button-delete-${t.id}`}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
        </div>
      </div>
      {/* A scalp has none of these, and a row of dashes reads as data that
          failed to load rather than questions it was never asked. Its own
          line says what it does have. */}
      {t.scalp ? (
        <div className="mt-1.5 font-mono text-[11px] text-muted-foreground">
          {t.riskAmount != null ? `risked ${fmtAmount(t.riskAmount)}` : "no risk recorded"}
          {t.netMfe != null || t.netMae != null
            ? ` · showed ${fmtMoney(t.netMae ?? 0)} to ${fmtMoney(t.netMfe ?? 0)}`
            : ""}
        </div>
      ) : (
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
        <span>No-mgmt {fmtR(m.potentialR)}</span>
        <span
          className={
            (m.managementDeltaR ?? 0) < 0 ? "text-primary/90" : "text-emerald-400/90"
          }
        >
          Δ {fmtR(m.managementDeltaR)}
        </span>
        <span>
          Capture{" "}
          {m.captureRatioClipped != null
            ? `${Math.round(m.captureRatioClipped * 100)}%`
            : "—"}
        </span>
        <span>MFE {fmtR(m.mfeR)}</span>
        <span>MAE {fmtR(m.maeR)}</span>
      </div>
      )}
      {t.mistakeTagIds.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {t.mistakeTagIds.map((id) => (
            <span
              key={id}
              className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] leading-tight text-primary"
            >
              {tagNames[id] ?? "?"}
            </span>
          ))}
        </div>
      )}
      {parseHighlights(t.highlights).length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1" data-testid={`highlights-${t.id}`}>
          {parseHighlights(t.highlights).map((h) => (
            <span
              key={h}
              className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] leading-tight text-emerald-400"
            >
              {h}
            </span>
          ))}
        </div>
      )}
      <RationaleTags tags={rationaleTags} />
    </div>
  );
}

