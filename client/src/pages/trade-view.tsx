/**
 * One trade, in full — the single place a trade is ever looked at.
 *
 * Every route into a trade (a bar on the excursion chart, a point on the
 * dashboard curve, a row in the journal or on a day) opens this same view, so
 * what you see never depends on how you arrived.
 *
 * It is an overlay rather than a screen of its own: the page you came from
 * stays mounted underneath with its scroll and filters intact, and clicking
 * outside — or Escape, or the X — drops you straight back into it. But it
 * still has a URL, so a trade can be linked, bookmarked and reloaded; see the
 * router note in App.tsx for how those two facts coexist.
 *
 * Everything reads from the live list by id, so an edit made in the dialog
 * above (or a fill removed below) is reflected the moment the mutation lands.
 */
import { useEffect, useMemo, useRef, useState, Suspense, lazy } from "react";
import { useLocation, useRoute } from "wouter";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  Ban,
  ClipboardList,
  Loader2,
  Minus,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  useCheckTrade,
  useDeleteFill,
  useDeleteTrade,
  useMistakeTags,
  useTrades,
  useUpdateTrade,
} from "@/lib/data";
import { parseExtraTargets, parsePlaybook, type TradeWithTags } from "@shared/schema";
import { computeMetrics, fmtFees, fmtMoney, fmtR, EXIT_REASON_LABELS } from "@shared/metrics";
import { positionLedger } from "@shared/fills";
import { parseHighlights } from "@shared/highlights";
import { couldLearnMore, pathIncomplete } from "@shared/aftermath";
import {
  alreadyDismissed,
  MarketSuggestion,
  type FieldChange,
} from "@/components/market-suggestion";
import { overrodeThePlan } from "@shared/grades";
import { exposureOf, fmtExposure } from "@shared/symbols";
import { GradeBadges } from "@/components/grade-picker";
import { StyleChip } from "@/components/style-switcher";
import { TradeImageGallery } from "@/components/trade-images";
/*
 * The charting engine is a third of a megabyte and draws for crypto trades
 * only — a futures trade never shows it at all. Loading it with the app makes
 * every session pay for a picture some of them never see.
 */
const TradeChart = lazy(() =>
  import("@/components/trade-chart").then((m) => ({ default: m.TradeChart })),
);
import { useCloseCardPaste } from "@/lib/close-paste";
import { useToast } from "@/hooks/use-toast";
import { saysAnythingAboutClose } from "@shared/close-card";
import type { CloseCard } from "@shared/close-card";
import { RationaleTags, num, parseTags } from "@/components/trade-shared";
import { TradeEditor } from "@/components/trade-dialogs";
import { NewTradeCard } from "@/components/new-trade-card";
import { FillDialog } from "@/components/fill-dialog";
import { ResolveTradeDialog } from "@/components/resolve-trade";

/** A figure the page will let you correct without opening the editor. */
export interface Editable {
  /** The trade column this figure is showing. */
  field: string;
  /** What is stored, which is not always what is displayed — R is derived. */
  current: number | null;
  /** A column the trade cannot exist without; emptying it is not a correction. */
  required?: boolean;
  save: (v: number | null) => Promise<unknown>;
}

/**
 * Small labelled figure; the page is mostly these.
 *
 * Given an `edit`, a double-click turns it into the number behind it and
 * Enter puts it back. Correcting how far a trade ran without you is a
 * two-second thought, and routing it through the full editor — open, find the
 * field among thirty others, save, close — costs more attention than the
 * correction is worth, which is how records stay wrong.
 *
 * The RAW value is what gets edited, never the rendering. These figures mostly
 * show R, and R is derived from a price against the stop; letting someone type
 * "3.2R" into a box that writes a price would store 3.2 as the price and
 * destroy the trade.
 */
function Fig({
  label,
  value,
  hint,
  tone,
  testId,
  edit,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "good" | "bad";
  testId?: string;
  edit?: Editable;
}) {
  const [typing, setTyping] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  async function commit() {
    if (typing == null || !edit) return;
    const raw = typing.trim();
    const next = raw === "" ? null : Number(raw);
    // Nonsense, or emptying a column the trade cannot exist without. Both put
    // the old value back rather than sending something the server will refuse.
    if (raw !== "" && !isFinite(next as number)) return setTyping(null);
    if (next == null && edit.required) return setTyping(null);
    setTyping(null);
    if (next === edit.current) return;
    setSaving(true);
    try {
      await edit.save(next);
    } catch (err: any) {
      /*
       * Said out loud. Without this the field simply snapped back to its old
       * value and the trader was left to guess whether it had saved — which is
       * the worst of the three things that can happen to an edit.
       */
      toast({
        title: "That didn't save",
        description: String(err?.message ?? err).slice(0, 160),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      {typing != null ? (
        <input
          autoFocus
          type="number"
          step="any"
          inputMode="decimal"
          value={typing}
          onChange={(e) => setTyping(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            // Escape gets out with the old value intact. Without it the only
            // way out of a mis-click is to save something.
            if (e.key === "Escape") setTyping(null);
            // The overlay closes on Escape from anywhere; not while a field is
            // open, or leaving one would throw the trade away too.
            e.stopPropagation();
          }}
          onBlur={() => void commit()}
          className="w-full rounded border border-primary/50 bg-transparent px-1 py-0.5 font-mono text-sm outline-none"
          data-testid={`inline-${edit?.field}`}
        />
      ) : (
        <p
          className={`font-mono text-sm ${
            tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-primary" : ""
          } ${edit ? "cursor-text rounded hover:bg-secondary/40" : ""} ${saving ? "opacity-50" : ""}`}
          data-testid={testId}
          title={edit ? "Double-click to edit" : undefined}
          onDoubleClick={
            edit ? () => setTyping(edit.current == null ? "" : String(edit.current)) : undefined
          }
        >
          {value}
        </p>
      )}
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function TradeView({ under = "/" }: { under?: string }) {
  const [isNew] = useRoute("/trade/new");
  const [, params] = useRoute("/trade/:id");
  /*
   * Editing has its own address rather than its own window.
   *
   * Same surface, one segment deeper — which makes the back button leave the
   * editor instead of the trade, lets "edit this trade" be a link the journal
   * rows can point at, and survives a refresh. A boolean in component state
   * could do none of those.
   */
  const [isEditRoute, editParams] = useRoute("/trade/:id/edit");
  const [, navigate] = useLocation();
  const id = isNew ? NaN : Number(editParams?.id ?? params?.id);
  const { data: trades, isLoading } = useTrades();

  const editing = isEditRoute;
  const setEditing = (on: boolean) =>
    navigate(on ? `/trade/${id}/edit` : `/trade/${id}`, { replace: true });
  const [resolving, setResolving] = useState(false);
  const [filling, setFilling] = useState<"add" | "partial" | null>(null);

  const trade = useMemo(
    () => (trades ?? []).find((t) => t.id === id) ?? null,
    [trades, id],
  );

  /*
   * Ctrl-V while VIEWING a live trade means the same thing as while editing
   * it: here is how it ended. It opens the editor with the exit already
   * filled in rather than making you find the button first — whether you
   * clicked View or Edit should not change what a paste does.
   */
  const { toast } = useToast();
  const [pastedCard, setPastedCard] = useState<CloseCard | null>(null);
  const { busy: readingCard } = useCloseCardPaste({
    trade,
    // Any trade, closed ones included: the exit is most often corrected after
    // the fact, and a screenshot of the fills is how you find out you logged
    // one exit for five. What the picture turns out to be decides what
    // happens next, not the trade's state.
    enabled: !editing && !!trade,
    onCard: (c) => {
      // A chart is the other thing Ctrl-V means here, and the gallery's own
      // listener has already kept it. Dragging the editor open over an
      // attachment would make the commoner gesture the more annoying one.
      if (!saysAnythingAboutClose(c)) {
        if (trade?.status !== "closed") {
          toast({
            title: "No exit on that screenshot",
            description:
              "It was attached to the trade, but there was nothing in it to close with — a fills table or a position card is what this reads.",
          });
        }
        return;
      }
      setPastedCard(c);
      setEditing(true);
    },
    // Without this a failed read was silent, which is indistinguishable from
    // a paste that was never noticed — and that is exactly what it looked
    // like from the outside.
    onError: (message) =>
      toast({ title: "Couldn't read that screenshot", description: message, variant: "destructive" }),
  });

  // Dismissing REPLACES the trade URL with the page underneath, so the back
  // button doesn't bounce you straight back into the trade you just closed.
  const close = () => navigate(under, { replace: true });
  // While a write dialog is stacked on top, a click inside it counts as
  // "outside" the overlay; without this guard, editing would dismiss both.
  // Editing happens INSIDE this overlay now, so it is not an inner window:
  // counting it as one would make Escape refuse to close the trade while the
  // editor is showing, with nothing on top to close instead.
  const innerOpen = resolving || filling != null;

  /*
   * Escape is handled here rather than left to the dialog primitive. Landing
   * cold on a trade URL, the primitive's own Escape handling stayed inert for
   * the first few seconds — click-outside and the close button worked
   * throughout, but the key did nothing — and a dismissal that works only
   * sometimes is worse than one that never did.
   *
   * Two details make this deterministic. It listens in the CAPTURE phase, and
   * it is registered when the overlay mounts, which is before any stacked
   * dialog registers its own: same target, same phase, so this handler runs
   * first and still sees the world as it was when the key went down. And it
   * reads the guard from a ref, because a dialog closing flushes state
   * synchronously mid-dispatch — a value captured in a closure would already
   * be stale by the time a later listener ran.
   */
  const innerOpenRef = useRef(false);
  innerOpenRef.current = innerOpen;
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A stacked write dialog gets first refusal: Escape closes that and
      // leaves the trade open behind it.
      if (innerOpenRef.current) return;
      /*
       * And so does a field being typed in. This handler listens in the
       * CAPTURE phase, so it sees the key before the field does and
       * stopPropagation down there comes far too late — Escape out of a
       * half-typed correction used to throw the whole trade away with it.
       */
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (el instanceof HTMLElement && el.isContentEditable) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <>
      {/* Written once, at a stable position in the tree. Declaring this shell
          inside a conditional (or as a nested component) would give React a
          new component identity on every render and remount the dialog —
          which silently costs it its focus trap and its Escape handler. */}
      <Dialog open onOpenChange={(o) => !o && close()}>
        <DialogContent
          className="max-h-[90vh] max-w-4xl overflow-y-auto"
          onInteractOutside={(e) => innerOpen && e.preventDefault()}
          /* Always declined here; the listener below owns Escape. Sharing the
             key with the primitive lost a race: closing a stacked dialog
             flushes innerOpen to false synchronously, so by the time this
             guard ran it no longer knew a dialog had just been dismissed and
             the trade closed along with it. */
          onEscapeKeyDown={(e) => e.preventDefault()}
          data-testid="overlay-trade"
        >
          <DialogTitle className="sr-only">
            {trade ? `${trade.symbol} trade` : "Trade"}
          </DialogTitle>

          {/* A read takes a few seconds against a vision model, and for those
              seconds an unacknowledged paste is indistinguishable from one
              that was never noticed. Saying so is most of the fix. */}
          {readingCard && (
            <div
              className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-[11px]"
              data-testid="text-reading-card"
            >
              <Loader2 className="h-3 w-3 animate-spin text-primary" />
              Reading your screenshot…
            </div>
          )}

          {/* Creating has an address too, so "log a trade" is a link rather
              than a state only the journal can reach. Same window as viewing
              and editing one. */}
          {isNew ? (
            <NewTradeCard
              defaultExpanded
              onOrdersDetected={() => {}}
              onCreated={(newId) => navigate(`/trade/${newId}`, { replace: true })}
            />
          ) : isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-8 w-40" />
              <Skeleton className="h-64 w-full" />
            </div>
          ) : !trade ? (
            <div className="p-4 text-center">
              <p className="text-sm">That trade is gone.</p>
              <p className="mt-1 text-xs text-muted-foreground">
                It was deleted, or the link points at an id that never existed.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={close}
                data-testid="button-back-journal"
              >
                <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
                Back
              </Button>
            </div>
          ) : (
            /* One surface, two states. Viewing and editing are the same
               window showing the same trade, which is the whole point:
               "close this trade" is just editing it and filling in the exit,
               so it lands here too rather than opening a third thing. */
            editing ? (
              <TradeEditor
                trade={trade}
                card={pastedCard}
                onClose={() => {
                  setEditing(false);
                  setPastedCard(null);
                }}
              />
            ) : (
              <TradeBody
                trade={trade}
                onEdit={() => setEditing(true)}
                onCloseTrade={() => setEditing(true)}
                onResolve={() => setResolving(true)}
                onFill={setFilling}
                onDeleted={close}
              />
            )
          )}
        </DialogContent>
      </Dialog>

      {/* Stacked above the overlay, not inside it: each is its own root, so
          Escape closes the top one and the trade stays open behind it. */}
      <ResolveTradeDialog trade={resolving ? trade : null} onClose={() => setResolving(false)} />
      <FillDialog
        trade={filling ? trade : null}
        kind={filling ?? "partial"}
        onClose={() => setFilling(null)}
      />
    </>
  );
}

/** The trade itself. Split out so the overlay shell above never remounts. */
function TradeBody({
  trade,
  onEdit,
  onCloseTrade,
  onResolve,
  onFill,
  onDeleted,
}: {
  trade: TradeWithTags;
  onEdit: () => void;
  onCloseTrade: () => void;
  onResolve: () => void;
  onFill: (kind: "add" | "partial") => void;
  onDeleted: () => void;
}) {
  const { data: tags = [] } = useMistakeTags();
  const { toast } = useToast();
  const deleteFill = useDeleteFill();
  const deleteTrade = useDeleteTrade();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const tagNames = useMemo(
    () => Object.fromEntries(tags.map((t) => [t.id, t.name])),
    [tags],
  );

  const m = computeMetrics(trade);
  const led = positionLedger(trade);

  /*
   * Reported either way. "Nothing came back" is a real answer here — the
   * archive may still not have the day — and a button that silently did
   * nothing would be indistinguishable from one that was broken.
   */
  const [rechecking, setRechecking] = useState(false);
  const [suggestion, setSuggestion] = useState<FieldChange[] | null>(null);
  const updateTrade = useUpdateTrade();
  /*
   * Binds a figure to the column behind it. The RAW value, never the
   * rendering: these mostly show R, and R is a price measured against the
   * stop — writing "3.2" into the price column would not be a correction, it
   * would be a different trade.
   */
  const editable = (field: string, current: number | null, required = false): Editable => ({
    field,
    current,
    required,
    save: (v) => updateTrade.mutateAsync({ id: trade.id, trade: { [field]: v } as any }),
  });
  const checkTrade = useCheckTrade();
  async function recheck() {
    setRechecking(true);
    try {
      const res: any = await checkTrade.mutateAsync(trade.id);
      const settled = (res?.resolved ?? []).length > 0;
      const measured = (res?.measured ?? []).length > 0;

      /*
       * A disagreement is a decision, not a notification. The market saying
       * the trade went further than your record of it is the one result worth
       * stopping for, so it opens the window rather than joining a toast that
       * disappears in four seconds.
       */
      const mine = (res?.suggestions ?? []).find((x: any) => x.tradeId === trade.id);
      if (mine?.changes?.length && !alreadyDismissed(trade.id, mine.changes)) {
        setSuggestion(mine.changes);
        return;
      }

      toast(
        settled || measured
          ? {
              title: settled ? "Settled from the market" : "Price path filled in",
              description: settled
                ? "The plan's outcome is in, and the R beside it now means something."
                : "MAE, MFE and what happened after your exit are on the trade now.",
            }
          : {
              title: "Nothing new yet",
              description:
                res?.error ??
                "The archive has not published far enough past this trade. It is worth asking again tomorrow.",
            },
      );
    } catch (err: any) {
      toast({
        title: "Couldn't reach the market",
        description: String(err?.message ?? err).slice(0, 160),
        variant: "destructive",
      });
    } finally {
      setRechecking(false);
    }
  }
  const tps = [trade.initialTarget, ...parseExtraTargets(trade.extraTargets)].filter(
    (x): x is number => x != null,
  );
  const highlights = parseHighlights(trade.highlights);
  const overrode = overrodeThePlan(trade);
  const playbook = parsePlaybook(trade.playbook);
  const playbookRows: [string, string][] = playbook
    ? ([
        ["Setup", playbook.setupName],
        ["Stop logic", playbook.stopLogic],
        ["Target logic", playbook.targetLogic],
        ["Confidence", playbook.confidence ? `${playbook.confidence} / 5` : undefined],
        ["Stand aside if", playbook.standAside],
      ].filter(([, v]) => v && String(v).trim()) as [string, string][])
    : [];
  const win = (m.actualR ?? 0) >= 0;
  const plannedRr =
    trade.initialStop != null && trade.initialTarget != null
      ? Math.abs(trade.initialTarget - trade.entryPrice) /
        Math.abs(trade.entryPrice - trade.initialStop)
      : null;

  return (
    <div className="space-y-4" data-testid={`page-trade-${trade.id}`}>
      {/* ------------------------------ header ------------------------------ */}
      {/* The overlay supplies its own close affordance top-right, so the
          header carries identity and actions only. */}
      <div className="flex flex-wrap items-center gap-2 pr-8">
        <span
          className={`flex h-7 w-7 items-center justify-center rounded ${
            trade.direction === "long"
              ? "bg-emerald-500/15 text-emerald-400"
              : "bg-primary/15 text-primary"
          }`}
        >
          {trade.direction === "long" ? (
            <ArrowUpRight className="h-4 w-4" />
          ) : (
            <ArrowDownRight className="h-4 w-4" />
          )}
        </span>
        <h1 className="font-mono text-xl font-bold tracking-tight">{trade.symbol}</h1>
        <Badge variant="outline" className="text-[10px] uppercase">
          {trade.status}
        </Badge>
        <StyleChip styleId={trade.styleId} />
        {trade.account && (
          <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
            {trade.account}
          </Badge>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {trade.status === "open" && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-[11px]"
                onClick={() => onFill("partial")}
                data-testid="button-view-partial"
              >
                <Minus className="mr-1 h-3 w-3" /> Take
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-[11px]"
                onClick={() => onFill("add")}
                data-testid="button-view-add"
              >
                <Plus className="mr-1 h-3 w-3" /> Add
              </Button>
              <Button
                size="sm"
                className="h-8 text-[11px]"
                onClick={onCloseTrade}
                data-testid="button-view-close"
              >
                Close trade
              </Button>
            </>
          )}
          {(trade.status === "open" || trade.status === "pending") && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={onResolve}
              aria-label="Never became a position"
              title="It never became a position"
              data-testid="button-view-resolve"
            >
              {/* Not an X: the overlay's own dismiss X sits inches away, and
                  two identical glyphs one meaning "close this" and the other
                  "void this trade" is a mistake waiting to happen. */}
              <Ban className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-[11px]"
            onClick={onEdit}
            data-testid="button-view-edit"
          >
            <Pencil className="mr-1 h-3 w-3" /> Edit
          </Button>
          {confirmDelete ? (
            <Button
              variant="destructive"
              size="sm"
              className="h-8 text-[11px]"
              onClick={async () => {
                await deleteTrade.mutateAsync(trade.id);
                onDeleted();
              }}
              data-testid="button-view-delete-confirm"
            >
              Delete for good?
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
              aria-label="Delete trade"
              data-testid="button-view-delete"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* ------------------------------ result ------------------------------ */}
      <Card className="border-card-border bg-card p-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
          <Fig
            label="Result"
            value={trade.status === "closed" ? fmtR(m.actualR) : "—"}
            hint={trade.status === "closed" ? EXIT_REASON_LABELS[trade.exitReason ?? "other"] : "still running"}
            tone={trade.status === "closed" ? (win ? "good" : "bad") : undefined}
            testId="view-actual-r"
          />
          <Fig
            label={m.fees > 0 ? "Net P&L" : "P&L"}
            value={trade.status === "closed" ? fmtMoney(m.actualPnL) : "—"}
            hint={m.fees > 0 ? `${fmtMoney(m.grossPnL)} gross − ${fmtFees(m.fees)}` : undefined}
            tone={trade.status === "closed" ? (win ? "good" : "bad") : undefined}
            testId="view-pnl"
          />
          <Fig label="1R" value={`$${num(m.riskDollars, 0)}`} hint={`${num(m.risk)} pts`} />
          <Fig
            label="Planned R:R"
            value={plannedRr != null ? num(plannedRr, 1) : "—"}
            hint={tps.length > 1 ? `${tps.length} targets` : undefined}
          />
          <Fig
            label="Best reach"
            value={m.mfeR != null ? fmtR(m.mfeR) : "—"}
            hint={m.captureRatio != null ? `kept ${Math.round(m.captureRatio * 100)}%` : "no path logged"}
            edit={editable("mfe", trade.mfe)}
            testId="view-mfe"
          />
          <Fig
            label="Worst dip"
            value={m.maeR != null ? fmtR(m.maeR) : "—"}
            hint="heat taken"
            edit={editable("mae", trade.mae)}
            testId="view-mae"
          />
          {/* The counterfactual leg: what the move did after you left. This is
              the number that says "if I had not closed it, it reached X" —
              distinct from Best reach, which is only what you were IN for. */}
          {m.leftBehindR != null && (
            <Fig
              label="After exit"
              value={fmtR(m.leftBehindR)}
              hint={m.leftBehindR >= 0.5 ? "ran on without you" : "died on cue"}
              testId="view-left-behind"
              edit={editable("postExitPeak", trade.postExitPeak)}
            />
          )}
        </div>

        {/* How you graded it, and — where the log allows — whether the grade
            agrees with the arithmetic. The delta only exists when the trade
            records what the untouched plan would have done, so its absence is
            stated rather than papered over with an assumption. */}
        {trade.status === "closed" &&
          (trade.entryGrade || trade.stopGrade || trade.exitGrade || overrode) && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/60 pt-3">
              <GradeBadges
                entry={trade.entryGrade}
                stop={trade.stopGrade}
                exit={trade.exitGrade}
              />
              {overrode && (
                <span
                  className="font-mono text-[11px] text-muted-foreground"
                  data-testid="view-override-delta"
                >
                  {m.managementDeltaR != null ? (
                    <>
                      vs leaving the plan alone:{" "}
                      <span
                        className={
                          m.managementDeltaR >= 0 ? "text-emerald-400" : "text-primary"
                        }
                      >
                        {fmtR(m.managementDeltaR)}
                      </span>
                    </>
                  ) : (
                    "your call, not the plan's — log the no-management outcome to price it"
                  )}
                </span>
              )}
            </div>
          )}
      </Card>

      {/* ------------------------------ the path ---------------------------- */}
      {/* Renders nothing at all for a futures trade or an unmatched ticker —
          a trade is not broken for having no Binance chart, and an apology
          in its place would be noise on every NQ row. */}
      {/*
        The errand the trader can see but the schedule cannot.

        The archive publishes a day at a time, so a trade closed yesterday has
        no file covering its own exit and its MAE and MFE are withheld rather
        than measured over half a window. Today the file is there — and nothing
        on screen changes to say so. The sweep would get to it eventually, on
        its own hourly throttle and per-run cap, which is fine for a background
        errand and no use at all to somebody looking straight at the gap.

        Offered only when there is something to gain: a closed trade, missing
        numbers, and recent enough that the archive could still be publishing
        data about it.
      */}
      {couldLearnMore(trade) && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-[11px]"
          data-testid="panel-recheck"
        >
          <span className="text-muted-foreground">
            {pathIncomplete(trade)
              ? trade.mae == null && trade.mfe == null
                ? "No price path on this one yet — the archive publishes a day at a time."
                : "The price path is only half filled in."
              : "The archive publishes a day at a time, so it may know more about this one than it did."}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto h-7 gap-1.5 px-2 text-[11px]"
            disabled={rechecking}
            onClick={recheck}
            data-testid="button-recheck-trade"
          >
            {rechecking ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3 text-emerald-400" />
            )}
            Ask the market again
          </Button>
        </div>
      )}

      {suggestion && (
        <MarketSuggestion
          trade={trade}
          changes={suggestion}
          onClose={() => setSuggestion(null)}
        />
      )}

      <Suspense fallback={null}>
        <TradeChart trade={trade} />
      </Suspense>

      {/* ------------------------------ the plan ---------------------------- */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="border-card-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold tracking-tight">The plan</h2>
          <div className="grid grid-cols-2 gap-3 font-mono text-sm sm:grid-cols-4">
            <Fig
              label="Entry"
              value={num(trade.entryPrice)}
              testId="view-entry"
              edit={editable("entryPrice", trade.entryPrice, true)}
            />
            <Fig
              label="Stop"
              value={<span className="text-primary">{num(trade.initialStop)}</span>}
              testId="view-stop"
              edit={editable("initialStop", trade.initialStop, true)}
            />
            <Fig
              label={tps.length > 1 ? "Targets" : "Target"}
              value={
                <span className="text-emerald-400" data-testid="view-targets">
                  {tps.map((x) => num(x)).join(" → ") || "—"}
                </span>
              }
            />
            <Fig
              label="Size"
              value={`${num(trade.size)}${trade.sizeUnit === "quote" ? " USD" : ""}`}
              // For a contract quoted in dollars per coin or per ounce, what
              // the position actually holds is the more useful of the two.
              hint={
                fmtExposure(exposureOf(trade.symbol, trade.size, trade.pointValue)) ??
                (trade.pointValue !== 1 ? `$${trade.pointValue}/pt` : undefined)
              }
            />
            <Fig
              label="Entered"
              value={
                <span className="text-xs">
                  {new Date(trade.entryTime).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              }
            />
            {trade.exitTime && (
              <Fig
                label="Exited"
                value={
                  <span className="text-xs">
                    {new Date(trade.exitTime).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                }
              />
            )}
            {trade.exitPrice != null && <Fig label="Exit" value={num(trade.exitPrice)} />}
          </div>

          {playbookRows.length > 0 && (
            <div className="mt-4" data-testid="view-playbook">
              <p className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                <ClipboardList className="h-3 w-3" />
                Playbook
              </p>
              <dl className="space-y-1 rounded-md border border-border/60 bg-secondary/20 p-2.5">
                {playbookRows.map(([k, v]) => (
                  <div key={k} className="flex gap-2 text-xs">
                    <dt className="w-28 shrink-0 text-muted-foreground">{k}</dt>
                    <dd className="min-w-0 flex-1 break-words">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </Card>

        {/* --------------------------- how it went -------------------------- */}
        <Card className="border-card-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold tracking-tight">How it was worked</h2>

          {trade.fills.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              One entry, one exit — no scaling logged.
              {trade.status === "open" && " Use Take or Add above to record a partial."}
            </p>
          ) : (
            <>
              <ul className="space-y-1" data-testid="view-fills">
                {[...trade.fills]
                  .sort((a, b) => a.time.localeCompare(b.time))
                  .map((f) => (
                    <li
                      key={f.id}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-xs"
                      data-testid={`view-fill-${f.id}`}
                    >
                      <Badge
                        variant="outline"
                        className={`shrink-0 text-[10px] font-normal ${
                          f.kind === "add"
                            ? "border-sky-500/40 text-sky-400"
                            : "border-emerald-500/40 text-emerald-400"
                        }`}
                      >
                        {f.kind === "add" ? "added" : "took"}
                      </Badge>
                      <span className="font-mono">
                        {num(f.size)}
                        {trade.sizeUnit === "quote" ? " USD" : ""} @ {num(f.price)}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {new Date(f.time).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {f.note ? ` · ${f.note}` : ""}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="ml-auto h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteFill.mutate(f.id)}
                        disabled={deleteFill.isPending}
                        aria-label="Remove this fill"
                        data-testid={`button-view-delete-fill-${f.id}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </li>
                  ))}
              </ul>
              <p className="mt-2 font-mono text-[11px] text-muted-foreground" data-testid="view-ledger">
                avg entry {num(led.avgEntry)}
                {trade.status === "open" && ` · ${num(led.openQty)} still on`} ·{" "}
                {fmtMoney(led.realizedPnL)} banked before the close
              </p>

            </>
          )}

          {(trade.mistakeTagIds.length > 0 || highlights.length > 0) && (
            <div className="mt-4 space-y-2">
              {trade.mistakeTagIds.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Demons
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {trade.mistakeTagIds.map((tid) => (
                      <Badge
                        key={tid}
                        variant="outline"
                        className="border-primary/40 text-[10px] font-normal text-primary"
                      >
                        {tagNames[tid] ?? "?"}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {highlights.length > 0 && (
                <div data-testid="view-highlights">
                  <p className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <Sparkles className="h-3 w-3 text-emerald-400" />
                    What went right
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {highlights.map((h) => (
                      <Badge
                        key={h}
                        variant="outline"
                        className="border-emerald-500/40 text-[10px] font-normal text-emerald-400"
                      >
                        {h}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* ---------------------------- the words ----------------------------- */}
      {(trade.rationale || trade.notes) && (
        <Card className="border-card-border bg-card p-4">
          {trade.rationale && (
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Rationale
              </p>
              <p className="text-xs">{trade.rationale}</p>
              <RationaleTags tags={parseTags(trade.rationaleTags)} />
            </div>
          )}
          {trade.notes && (
            <div className={trade.rationale ? "mt-3" : ""}>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Notes
              </p>
              <p className="whitespace-pre-wrap text-xs">{trade.notes}</p>
            </div>
          )}
        </Card>
      )}

      {/* ---------------------------- the charts ---------------------------- */}
      {/* The gallery labels itself, so this card carries no heading of its own. */}
      <Card className="border-card-border bg-card p-4">
        <TradeImageGallery tradeId={trade.id} />
      </Card>

    </div>
  );
}
