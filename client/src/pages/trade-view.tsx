import { useAccountBalances } from "@/lib/data";
import { equityAt, fmtPercent, riskPercent } from "@shared/equity";
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
  Skull,
  Star,
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
import { aftermathPending, aftermathWindowMs, couldLearnMore, pathIncomplete } from "@shared/aftermath";
import {
  alreadyDismissed,
  MarketSuggestion,
  type FieldChange,
} from "@/components/market-suggestion";
import { overrodeThePlan } from "@shared/grades";
import { exposureOf, fmtExposure } from "@shared/symbols";
import { GradeBadges } from "@/components/grade-picker";
import { LEVEL, LevelLabel, LevelLadder, PathBands } from "@/components/levels";
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
 * What a finished inline edit means.
 *
 * Four different nothings, and telling them apart is the whole rule:
 *
 *   - a value that is not a number — a slip, put the old one back
 *   - an empty box you clicked away from — you looked and left, keep what
 *     was there. This is the common one, and treating it as "delete" wiped
 *     numbers people were only reading
 *   - an empty box you pressed Enter on — somebody saying "clear this", so
 *     clear it, unless the trade cannot exist without the column
 *   - the same value it already had — nothing to write
 *
 * Blur otherwise commits exactly as Enter does: abandoning a field by looking
 * at something else is the commonest way to finish an edit, and losing the
 * number to it is indistinguishable from the edit never having worked.
 */
export type EditOutcome = { save: false } | { save: true; value: number | null };

/**
 * What a scalp's excursion was worth, in R, for the line under the figure.
 * Money on its own says nothing without the risk beside it.
 */
function excursionHint(
  dollars: number | null,
  risk: number | null,
  direction: string,
): string {
  if (dollars == null) return `${direction} · not recorded`;
  if (risk == null || risk <= 0) return direction;
  const r = dollars / risk;
  return `${direction} · ${r > 0 ? "+" : ""}${r.toFixed(2)}R`;
}

/** "2 hours", "3 days" — how long a trade's aftermath window runs. */
function fmtWindow(ms: number): string {
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.round(hours / 24)} days`;
}

export function readEdit(
  raw: string,
  via: "enter" | "blur",
  edit: { current: number | null; required?: boolean },
): EditOutcome {
  const text = raw.trim();
  if (text === "") {
    if (via === "blur" || edit.required) return { save: false };
    return edit.current == null ? { save: false } : { save: true, value: null };
  }
  const next = Number(text);
  if (!isFinite(next)) return { save: false };
  return next === edit.current ? { save: false } : { save: true, value: next };
}

/**
 * The written fields, under the same gesture as the figures.
 *
 * Numbers were the only thing a double-click could correct, which made the
 * rationale and the note the two things you had to open a form for — and they
 * are precisely the fields you come back to, because what you thought at the
 * time is the part you get more honest about afterwards.
 *
 * Three differences from Fig, all forced by text. Enter inserts a newline
 * rather than committing, so there is an explicit Save; blur does NOT commit,
 * because clicking away from a paragraph you are mid-sentence on is not the
 * same promise as clicking away from a number; and empty is a legitimate
 * value, so clearing one clears it.
 */
function Words({
  label,
  value,
  field,
  trade,
  placeholder,
  children,
}: {
  label: string;
  value: string | null;
  field: "rationale" | "notes";
  trade: TradeWithTags;
  placeholder: string;
  /** Anything that belongs under the text when it is not being edited. */
  children?: React.ReactNode;
}) {
  const [typing, setTyping] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const update = useUpdateTrade();
  const { toast } = useToast();

  async function commit() {
    if (typing == null) return;
    const next = typing.trim();
    const now = (value ?? "").trim();
    setTyping(null);
    if (next === now) return;
    setSaving(true);
    try {
      await update.mutateAsync({ id: trade.id, trade: { [field]: next || null } as any });
    } catch (err: any) {
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
      <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      {typing != null ? (
        <div className="space-y-1.5">
          <textarea
            autoFocus
            rows={4}
            value={typing}
            onChange={(e) => setTyping(e.target.value)}
            onKeyDown={(e) => {
              // Escape abandons; the overlay's own Escape handler already
              // stands down while a textarea has focus.
              if (e.key === "Escape") setTyping(null);
              e.stopPropagation();
            }}
            placeholder={placeholder}
            className="w-full resize-y rounded border border-primary/50 bg-transparent px-2 py-1.5 text-xs outline-none"
            data-testid={`inline-${field}`}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => void commit()}
              data-testid={`inline-save-${field}`}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px] text-muted-foreground"
              onClick={() => setTyping(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p
            className={`-mx-1 cursor-text whitespace-pre-wrap rounded px-1 text-xs decoration-dotted underline-offset-4 hover:bg-secondary/40 hover:underline ${
              value ? "" : "text-muted-foreground"
            } ${saving ? "opacity-50" : ""}`}
            title="Double-click to edit"
            data-testid={`view-${field}`}
            onMouseDown={(e) => e.detail > 1 && e.preventDefault()}
            onDoubleClick={() => setTyping(value ?? "")}
          >
            {value || placeholder}
          </p>
          {children}
        </>
      )}
    </div>
  );
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
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "good" | "bad";
  testId?: string;
  edit?: Editable;
  /** Draws the label in the level vocabulary the rest of the app uses. */
  icon?: keyof typeof LEVEL;
}) {
  const [typing, setTyping] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  /** Hand what was typed to readEdit, and write it if it says to. */
  async function commit(via: "enter" | "blur") {
    if (typing == null || !edit) return;
    const outcome = readEdit(typing, via, edit);
    setTyping(null);
    if (!outcome.save) return;
    setSaving(true);
    try {
      await edit.save(outcome.value);
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
      {icon ? (
        <LevelLabel kind={icon} text={label} />
      ) : (
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      )}
      {typing != null ? (
        <input
          autoFocus
          type="number"
          step="any"
          inputMode="decimal"
          value={typing}
          onChange={(e) => setTyping(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit("enter");
            // Escape gets out with the old value intact. Without it the only
            // way out of a mis-click is to save something.
            if (e.key === "Escape") setTyping(null);
            // The overlay closes on Escape from anywhere; not while a field is
            // open, or leaving one would throw the trade away too.
            e.stopPropagation();
          }}
          onBlur={() => void commit("blur")}
          className="w-full rounded border border-primary/50 bg-transparent px-1 py-0.5 font-mono text-sm outline-none"
          data-testid={`inline-${edit?.field}`}
        />
      ) : (
        <p
          className={`font-mono text-sm ${
            tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-primary" : ""
          } ${
            edit
              ? // A dotted underline that firms up on hover: enough to say
                // "this one answers to a double-click" without turning a page
                // of figures into a page of form controls. The padding is not
                // decoration — an unlogged figure renders as a single em-dash,
                // and a one-character double-click target is one you miss.
                "-mx-1 cursor-text rounded px-1 decoration-dotted underline-offset-4 hover:bg-secondary/40 hover:underline"
              : ""
          } ${saving ? "opacity-50" : ""}`}
          data-testid={testId}
          title={edit ? "Double-click to edit" : undefined}
          /* The second mousedown of a double-click is what selects the word.
             Swallowing it means the value does not flash highlighted on its
             way to becoming an input — which read as the click having done
             nothing at all. */
          onMouseDown={edit ? (e) => e.detail > 1 && e.preventDefault() : undefined}
          onDoubleClick={
            edit ? () => setTyping(edit.current == null ? "" : String(edit.current)) : undefined
          }
        >
          {value}
        </p>
      )}
      {/*
        An empty figure you can fill in should say so. "no path logged" is a
        true statement that reads as a dead end — the one moment the hint is
        worth spending on the way to change it rather than on what it means.
      */}
      {edit && edit.current == null && typing == null ? (
        <p className="text-[10px] text-muted-foreground/70">double-click to log it</p>
      ) : (
        hint && <p className="text-[10px] text-muted-foreground">{hint}</p>
      )}
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
/**
 * One trade's contents, with no window around them.
 *
 * Exported because the overlay is no longer the only place a trade is shown:
 * the journal expands a row into this same body in place, the way the log card
 * expands. Same component either way — a trade that looked different depending
 * on how you opened it was the thing this file's header promised not to do.
 */
export function TradeBody({
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
  /** One line, always — the two-line wrap in a narrow column read as a bug. */
  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  const sizeText = `${num(trade.size)}${trade.sizeUnit === "quote" ? " USD" : ""}`;
  // For a contract quoted in dollars per coin or per ounce, what the position
  // actually holds is the more useful of the two.
  const sizeHint =
    fmtExposure(exposureOf(trade.symbol, trade.size, trade.pointValue)) ??
    (trade.pointValue !== 1 ? `$${trade.pointValue}/pt` : undefined);
  /** How long it was on, in the coarsest unit that still says something. */
  const held = (() => {
    if (!trade.exitTime) return null;
    const ms = new Date(trade.exitTime).getTime() - new Date(trade.entryTime).getTime();
    if (!(ms > 0)) return null;
    const mins = Math.round(ms / 60000);
    if (mins < 90) return `${mins}m`;
    const hours = mins / 60;
    return hours < 36 ? `${hours.toFixed(hours < 10 ? 1 : 0)}h` : `${Math.round(hours / 24)}d`;
  })();
  const led = positionLedger(trade);

  /*
   * Reported either way. "Nothing came back" is a real answer here — the
   * archive may still not have the day — and a button that silently did
   * nothing would be indistinguishable from one that was broken.
   */
  const [rechecking, setRechecking] = useState(false);
  // The balance logged for this account before the trade, so 1R can also be
  // read as the share of the account it was. Blank when no such balance
  // exists — a balance logged afterwards says nothing about what was at
  // risk then.
  const { data: balances = [] } = useAccountBalances();
  const equityThen = equityAt(balances, trade.account, trade.entryTime);
  const [suggestion, setSuggestion] = useState<FieldChange[] | null>(null);
  const updateTrade = useUpdateTrade();
  /*
   * Binds a figure to the column behind it. The RAW value, never the
   * rendering: these mostly show R, and R is a price measured against the
   * stop — writing "3.2" into the price column would not be a correction, it
   * would be a different trade.
   */
  /**
   * An R reading in this trade's own dollars.
   *
   * Exact, not an estimate: 1R on this trade cost a known amount, so "+2.4R"
   * IS "$480 at the high". Null when there is nothing to convert — the figure
   * then falls back to whatever it said before, rather than printing "$0" for
   * a path that was never logged.
   */
  const inDollars = (r: number | null | undefined) =>
    r != null && isFinite(r) && m.riskDollars > 0 ? `${fmtMoney(r * m.riskDollars)} of it` : null;

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
        {/* The verdict on the entry, flippable here because this is where a
            trade gets looked at properly. */}
        <button
          type="button"
          onClick={() => updateTrade.mutate({ id: trade.id, trade: { tilt: !trade.tilt } })}
          aria-pressed={trade.tilt}
          title={
            trade.tilt
              ? "In the tilt book — click to put it back in the plan"
              : "Mark as tilt: it should not have been taken"
          }
          className={`flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] transition-colors ${
            trade.tilt
              ? "border-primary/50 bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:border-primary/50 hover:text-primary"
          }`}
          data-testid="button-view-tilt"
        >
          <Skull className="h-3 w-3" />
          {trade.tilt ? "tilt" : "mark tilt"}
        </button>
        {/* The other verdict, on the execution rather than the idea. */}
        {!trade.tilt && (
          <button
            type="button"
            onClick={() => updateTrade.mutate({ id: trade.id, trade: { wellTraded: !trade.wellTraded } })}
            aria-pressed={trade.wellTraded === true}
            title={
              trade.wellTraded
                ? "Traded well — click to take it back"
                : "Mark as traded well: waited for it, sized it, left it alone. Whatever it paid."
            }
            className={`flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] transition-colors ${
              trade.wellTraded
                ? "border-amber-500/50 bg-amber-500/10 text-amber-400"
                : "border-border text-muted-foreground hover:border-amber-500/50 hover:text-amber-400"
            }`}
            data-testid="button-view-well"
          >
            <Star className={`h-3 w-3 ${trade.wellTraded ? "fill-current" : ""}`} />
            {trade.wellTraded ? "well traded" : "mark well traded"}
          </button>
        )}
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
        {/*
          The result leads, at the size it deserves.
          It used to be one of seven identical figures in a flat row, so the
          answer to "how did this go" carried exactly the weight of the point
          value beside it. The rest are supporting detail and now read as it.
        */}
        <div className="mb-3 flex flex-wrap items-start gap-x-8 gap-y-2 border-b border-border/50 pb-3">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Result</p>
            <p
              className={`font-mono text-3xl font-semibold leading-none ${
                trade.status !== "closed" ? "" : win ? "text-emerald-400" : "text-primary"
              }`}
              data-testid="view-actual-r"
            >
              {trade.status === "closed" ? fmtR(m.actualR) : "—"}
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {/* A scalp was never asked how it ended, so "Other" here is an
                  answer nobody gave. */}
              {trade.scalp
                ? "scalp"
                : trade.status === "closed"
                  ? EXIT_REASON_LABELS[trade.exitReason ?? "other"]
                  : "still running"}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {m.fees > 0 || m.funding !== 0 ? "Net P&L" : "P&L"}
            </p>
            <p
              className={`font-mono text-xl font-semibold leading-none ${
                trade.status !== "closed" ? "" : win ? "text-emerald-400" : "text-primary"
              }`}
              data-testid="view-pnl"
            >
              {trade.status === "closed" ? fmtMoney(m.actualPnL) : "—"}
            </p>
            {(m.fees > 0 || m.funding !== 0) && (
              <p className="mt-1 text-[10px] text-muted-foreground" data-testid="view-pnl-breakdown">
                {fmtMoney(m.grossPnL)} gross
                {m.fees > 0 && <> − {fmtFees(m.fees)} fees</>}
                {/* Funding is signed as received, so a positive figure is money
                    the position was paid to hold. Estimated from the venue's
                    rate history on the opening notional, and said to be. */}
                {m.funding !== 0 && (
                  <span
                    title="Estimated from the venue's funding-rate history over the hold, on the opening notional."
                    data-testid="view-funding"
                  >
                    {" "}
                    {m.funding > 0 ? "+" : "−"} {fmtFees(m.funding)} funding (est.)
                  </span>
                )}
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {trade.scalp ? (
            /* A scalp's figures are the two it actually has. The price-based
               pair below edits mfe and mae, which a trade with no entry
               price cannot use — typing into them wrote a number nothing
               would ever read. */
            <>
              <Fig
                label="1R"
                value={m.riskDollars > 0 ? `$${num(m.riskDollars, 0)}` : "—"}
                hint={m.riskDollars > 0 ? "risked" : "no risk recorded"}
              />
              <Fig
                label="Best it showed ($)"
                value={m.mfeR != null ? fmtR(m.mfeR) : "—"}
                hint={trade.netMfe != null ? fmtMoney(trade.netMfe) : "double-click to log it"}
                edit={editable("netMfe", trade.netMfe)}
                testId="view-mfe"
              />
              <Fig
                label="Worst it showed ($)"
                value={m.maeR != null ? fmtR(m.maeR) : "—"}
                hint={trade.netMae != null ? fmtMoney(trade.netMae) : "double-click to log it"}
                edit={editable("netMae", trade.netMae)}
                testId="view-mae"
              />
            </>
          ) : (
          <>
          <Fig
            label="1R"
            value={`$${num(m.riskDollars, 0)}`}
            hint={
              riskPercent(m.riskDollars, equityThen) != null
                ? `${num(m.risk)} pts · ${fmtPercent(riskPercent(m.riskDollars, equityThen))} of equity`
                : `${num(m.risk)} pts`
            }
          />
          <Fig
            label="Planned R:R"
            value={plannedRr != null ? num(plannedRr, 1) : "—"}
            hint={tps.length > 1 ? `${tps.length} targets` : undefined}
          />
          <Fig
            label="Best reach"
            value={m.mfeR != null ? fmtR(m.mfeR) : "—"}
            /*
             * Both units, rather than the page-wide R/USD switch the stats
             * carry. On ONE trade the switch would be a downgrade: R is the
             * better unit here because it is measured against this trade's own
             * plan, and hiding it to show dollars would lose the comparison the
             * figure exists for. Showing the money underneath costs a line and
             * loses nothing — it is the same question ("how much was I up at
             * the high?") answered permanently.
             *
             * What share you kept only means something once you are out. On a
             * running trade there is no exit to have kept anything of — and
             * falling back to "no path logged" was a flat contradiction of the
             * figure right above it.
             */
            hint={inDollars(m.mfeR) ?? (
              m.captureRatio != null
                ? `kept ${Math.round(m.captureRatio * 100)}%`
                : trade.status === "closed"
                  ? "no path logged"
                  : "high so far"
            )}
            edit={editable("mfe", trade.mfe)}
            testId="view-mfe"
          />
          <Fig
            label="Worst dip"
            value={m.maeR != null ? fmtR(m.maeR) : "—"}
            hint={
              inDollars(m.maeR) ?? (trade.status === "closed" ? "heat taken" : "heat so far")
            }
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
              hint={
                inDollars(m.leftBehindR) ??
                (m.leftBehindR >= 0.5 ? "ran on without you" : "died on cue")
              }
              testId="view-left-behind"
              edit={editable("postExitPeak", trade.postExitPeak)}
            />
          )}
          </>
          )}
        </div>

        {/* How you graded it, and — where the log allows — whether the grade
            agrees with the arithmetic. The delta only exists when the trade
            records what the untouched plan would have done, so its absence is
            stated rather than papered over with an assumption. */}
        {/* A scalp has no plan to have departed from, so "your call, not the
            plan's" is a verdict on a decision it never recorded. */}
        {trade.status === "closed" &&
          !trade.scalp &&
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
      {/*
        Side by side only when there is something to put beside. A trade with
        one entry and one exit — most of them — used to sit next to a
        half-page card whose entire contents were the sentence "no scaling
        logged", and an empty column that tall reads as something failing to
        load.
      */}
      <div
        className={`grid gap-4 ${
          trade.fills.length > 0 ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : "grid-cols-1"
        }`}
      >
        <Card className="border-card-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold tracking-tight">
            {trade.scalp ? "The result" : "The plan"}
          </h2>

          {/* A scalp was recorded as a result, so there are no levels to draw
              and the four price boxes below would be four zeroes. What it
              made and what it risked is the whole record; everything else on
              this page — notes, screenshots, the verdicts — still applies. */}
          {trade.scalp ? (
            /* The figures are all in the header now, where they can be
               edited. What is left to say is what kind of record this is. */
            <p className="text-[11px] leading-snug text-muted-foreground" data-testid="view-scalp-result">
              Logged as a scalp: a result rather than a set of prices, so there are no levels to
              show. What it made, what it risked and how far it went are at the top. Fill in an
              entry and a stop here and it becomes an ordinary trade.
            </p>
          ) : (
          <>

          {/*
            The four decisions, in the vocabulary the editor already speaks.
            Entry, stop, target and exit carry an icon and a colour everywhere
            else in the app; the view was the one place they were four
            identical grey labels, so the same trade looked like two different
            things depending on which window you were in.
          */}
          <div className="grid grid-cols-2 gap-3 font-mono text-sm sm:grid-cols-4">
            <Fig
              label="Entry"
              icon="entry"
              value={num(trade.entryPrice)}
              testId="view-entry"
              edit={editable("entryPrice", trade.entryPrice, true)}
            />
            <Fig
              label="Stop"
              icon="stop"
              value={<span className="text-red-400">{num(trade.initialStop)}</span>}
              testId="view-stop"
              edit={editable("initialStop", trade.initialStop, true)}
            />
            <Fig
              label={tps.length > 1 ? "Targets" : "Target"}
              icon="target"
              value={
                <span className="text-emerald-400" data-testid="view-targets">
                  {tps.map((x) => num(x)).join(" → ") || "—"}
                </span>
              }
              /* Only when there is one. With several the figure is a JOINED
                 list, and a box that shows "120 → 140" but writes a single
                 price would silently drop the rest of the plan. Those go
                 through the editor, which has a field per target. */
              edit={tps.length > 1 ? undefined : editable("initialTarget", trade.initialTarget)}
            />
            {trade.exitPrice != null ? (
              <Fig
                label="Exit"
                icon="exit"
                value={<span className="text-sky-400">{num(trade.exitPrice)}</span>}
                testId="view-exit"
                edit={editable("exitPrice", trade.exitPrice)}
              />
            ) : (
              <Fig
                label="Size"
                value={sizeText}
                hint={sizeHint}
                testId="view-size"
                edit={editable("size", trade.size, true)}
              />
            )}
          </div>

          {/* The same ladder the editor draws. It is the one thing that makes
              four prices read as a trade rather than as four prices, and the
              view was going without it. */}
          <LevelLadder
            bare
            className="mt-3"
            direction={trade.direction}
            entry={trade.entryPrice}
            stop={trade.initialStop}
            target={trade.initialTarget}
            extraTps={tps.slice(1)}
            exit={trade.exitPrice}
          />

          {/*
            What price DID, in the same prices as what you decided.

            The strip at the top gives these in R, which is the right unit for
            comparing trades and the wrong one for reading a chart: "+2.00R"
            does not tell you where to look. The four decisions are prices, so
            the four facts are shown as prices beside them — and they are the
            numbers most often typed in by hand, so they are editable in place
            like the rest.
          */}
          {(trade.mfe != null ||
            trade.mae != null ||
            trade.postExitPeak != null ||
            trade.postExitAdverse != null ||
            trade.status === "closed") && (
            <div
              className="mt-3 grid grid-cols-2 gap-3 border-t border-border/50 pt-3 font-mono text-sm sm:grid-cols-4"
              data-testid="view-path"
            >
              <Fig
                label="Best while in"
                icon="mfe"
                value={trade.mfe != null ? num(trade.mfe) : "—"}
                hint={trade.direction === "short" ? "lowest it got" : "highest it got"}
                testId="view-mfe-price"
                edit={editable("mfe", trade.mfe)}
              />
              <Fig
                label="Worst while in"
                icon="mae"
                value={trade.mae != null ? num(trade.mae) : "—"}
                hint={trade.direction === "short" ? "highest it got" : "lowest it got"}
                testId="view-mae-price"
                edit={editable("mae", trade.mae)}
              />
              <Fig
                label="Kept going your way"
                icon="ranAfter"
                value={trade.postExitPeak != null ? num(trade.postExitPeak) : "—"}
                hint={trade.direction === "short" ? "lowest after you left" : "highest after you left"}
                testId="view-peak-price"
                edit={editable("postExitPeak", trade.postExitPeak)}
              />
              <Fig
                label="Turned against you"
                icon="fellAfter"
                value={trade.postExitAdverse != null ? num(trade.postExitAdverse) : "—"}
                hint={trade.direction === "short" ? "highest after you left" : "lowest after you left"}
                testId="view-adverse-price"
                edit={editable("postExitAdverse", trade.postExitAdverse)}
              />
            </div>
          )}

          {/* Blank because it is early, not because it is missing. The two
              after-exit prices are read once the window has run, so the
              first number written is one that means something. */}
          {aftermathPending(trade) && (
            <p
              className="mt-2 text-[11px] leading-snug text-muted-foreground"
              data-testid="text-aftermath-pending"
            >
              What price did once you were out is read about{" "}
              {fmtWindow(aftermathWindowMs(trade))} after the exit — long enough for the move that
              followed to have happened. Type the prices yourself to settle it now.
            </p>
          )}

          {/*
            The same two bands the editor draws, and the reason the four prices
            above are not enough on their own.

            "Ran on to 226.88" and "best held 220.12" are two numbers you have
            to subtract in your head, against an entry you have to scroll up
            for. On one axis they are a picture: how far the trade went while
            you were in it, how far it went once you were out, and — the whole
            point — whether the second range starts where the first one ended
            or reaches somewhere you never saw.

            "I sat through the move and took the middle" and "it did all its
            work after I left" are different mistakes with different fixes, and
            they look identical as four prices in a row.

            Self-guarding: nothing is drawn without an entry to measure from and
            at least one excursion to measure, so an unlogged trade shows the
            prices and no empty axis.
          */}
          <PathBands
            className="mt-3"
            direction={trade.direction}
            entry={trade.entryPrice}
            stop={trade.initialStop}
            exit={trade.exitPrice}
            mae={trade.mae}
            mfe={trade.mfe}
            postExitPeak={trade.postExitPeak}
            postExitAdverse={trade.postExitAdverse}
          />

          {/* Size and the clock: true of the trade, but not decisions about
              price, so they sit apart from the four that are. */}
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-border/50 pt-2.5 text-[11px] text-muted-foreground">
            {trade.exitPrice != null && (
              <span>
                Size <span className="font-mono text-foreground">{sizeText}</span>
                {sizeHint ? ` · ${sizeHint}` : ""}
              </span>
            )}
            <span>
              In <span className="font-mono text-foreground">{when(trade.entryTime)}</span>
            </span>
            {trade.exitTime && (
              <span>
                Out <span className="font-mono text-foreground">{when(trade.exitTime)}</span>
              </span>
            )}
            {held && <span>held {held}</span>}
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
          </>
          )}
        </Card>

        {/* --------------------------- how it went -------------------------- */}
        <Card className={`border-card-border bg-card p-4 ${trade.fills.length ? "" : "py-2.5"}`}>
          {trade.fills.length > 0 && (
            <h2 className="mb-3 text-sm font-semibold tracking-tight">How it was worked</h2>
          )}

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
      {/* Always drawn, empty or not. Hiding the card when there were no words
          meant the trade with nothing written on it — the one worth writing on
          — was the one with nowhere to write. */}
      <Card className="border-card-border bg-card p-4">
        <Words
          label="Rationale"
          value={trade.rationale}
          field="rationale"
          trade={trade}
          placeholder="Why you took it. Double-click to write it."
        >
          <RationaleTags tags={parseTags(trade.rationaleTags)} />
        </Words>
        <div className="mt-3">
          <Words
            label="Notes"
            value={trade.notes}
            field="notes"
            trade={trade}
            placeholder="What you want to remember. Double-click to write it."
          />
        </div>
      </Card>

      {/* ---------------------------- the charts ---------------------------- */}
      {/* The gallery labels itself, so this card carries no heading of its own. */}
      <Card className="border-card-border bg-card p-4">
        <TradeImageGallery tradeId={trade.id} />
      </Card>

    </div>
  );
}
