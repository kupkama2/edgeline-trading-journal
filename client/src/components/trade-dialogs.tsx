/**
 * The trade editor.
 *
 * There used to be two dialogs here — close it, and edit it — stacked over a
 * /trade/:id page that was itself a modal. Closing was never a different act
 * from editing, only a different subset of the same questions with a
 * different button, and two writers for one row is how they drift apart. Both
 * are gone: this renders inside the trade's own surface, and "close this
 * trade" means filling in the exit.
 */
import { useEffect, useMemo, useState, Suspense, lazy } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { ArrowUpRight, CheckCircle2, Clock3, Loader2, Minus, Pencil, Plus, Trash2 } from "lucide-react";
import { useAccountSettings, useMistakeTags, useUpdateTrade, useAddTradeImage, archiveDataUrl, parseScreenshot, fileToDownscaledDataUrl,
  useAddFill,
} from "@/lib/data";
import { suggestFees } from "@shared/fees";
import { knownHighlights, parseHighlights, serializeHighlights } from "@shared/highlights";
import { AccountPicker, HighlightPicker, SetupTagPicker } from "@/components/trade-pickers";
import { normalizeSetupTags } from "@shared/setups";
import { splitSourceFromTags } from "@shared/sources";
import { useDeleteFill, useStyles, useTrades } from "@/lib/data";
import { styleColor } from "@/lib/style-filter";
import { collapseFills, positionLedger } from "@shared/fills";
import { TradeImageGallery } from "@/components/trade-images";
/*
 * The charting engine is a third of a megabyte and draws for crypto trades
 * only — a futures trade never shows it at all. Loading it with the app makes
 * every session pay for a picture some of them never see.
 */
const TradeChart = lazy(() =>
  import("@/components/trade-chart").then((m) => ({ default: m.TradeChart })),
);
import { parseExtraTargets, parsePlaybook, type TradeWithTags } from "@shared/schema";
import { type CloseCard, type CloseFill, closeFromCard, readHeadline, saysAnythingAboutClose } from "@shared/close-card";
import { LevelLabel, LevelLadder, type LevelKind } from "@/components/levels";
import { ClipboardList, Layers, NotebookPen } from "lucide-react";
import { AverageCloseSolver } from "@/components/average-close";
import { useCloseCardPaste } from "@/lib/close-paste";
import { computeMetrics, fmtFees, fmtMoney, fmtR, EXIT_REASON_LABELS } from "@shared/metrics";
import { Dropzone, EXIT_REASONS, FormSection, RationaleTags, TimeField, localNow, num, parseTags, toIso, toLocalInput } from "@/components/trade-shared";
import { EMPTY_GRADES, GradePicker, type GradeState } from "@/components/grade-picker";
import {
  TradeOutcomeFields,
  outcomeStage,
  resolveLifecycle,
  type Lifecycle,
} from "@/components/trade-outcome";
import { SymbolPicker } from "@/components/symbol-picker";
import {
  agoLabel,
  clearDraft,
  draftDiffers,
  draftFromTrade,
  readDraft,
  stashDraft,
  type TradeDraft,
} from "@/lib/trade-draft";
import { FillForm } from "@/components/fill-dialog";
import { typedSymbol } from "@shared/symbols";

/**
 * Editing a trade, as a panel rather than a window.
 *
 * This used to be a dialog stacked on top of the trade overlay, which is why
 * viewing and editing felt like two different places: you were two modals
 * deep, looking at the same trade twice. Now the overlay swaps its read-only
 * body for this and you stay exactly where you were.
 *
 * Closing a trade is not a separate flow either — it is editing one and
 * filling in the exit. That is all "closing" ever was; the second dialog only
 * existed to ask a subset of these questions with a different button on the
 * bottom, and having two writers for one row is how they drift apart.
 */
export function TradeEditor({
  trade,
  onClose,
  card,
}: {
  trade: TradeWithTags | null;
  onClose: () => void;
  /** A closed-position card pasted before the editor opened. */
  card?: CloseCard | null;
}) {
  const { toast } = useToast();
  const { data: tags = [] } = useMistakeTags();
  const updateTrade = useUpdateTrade();

  const [f, setF] = useState<Record<string, string>>({});
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [exitReason, setExitReason] = useState<string | null>(null);
  const [nmo, setNmo] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<number[]>([]);
  // Scale-out levels beyond TP1 — editable strings, serialized on save.
  const [extraTps, setExtraTps] = useState<string[]>([]);
  const [highlights, setHighlights] = useState<string[]>([]);
  const [grades, setGrades] = useState<GradeState>(EMPTY_GRADES);
  const [account, setAccount] = useState("");
  // Which book the trade belongs to. Mutable after the fact on purpose: a
  // trade often turns out to belong to a different style than the one that
  // was active when it was logged, and without this the only fix was to
  // delete it and re-enter it.
  const [styleId, setStyleId] = useState<number | null>(null);
  // Contracts vs USD notional. Editable because it is the one field that
  // silently changes what every other number MEANS — a 3,000 logged as
  // contracts instead of dollars misprices the whole trade — and until now it
  // could only be set at entry.
  const [sizeUnit, setSizeUnit] = useState<"base" | "quote">("base");
  const { data: styles = [] } = useStyles();
  const { data: allTrades = [] } = useTrades();
  const deleteFill = useDeleteFill();
  const addFill = useAddFill();
  const [merging, setMerging] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);

  // What the trade would look like as a single round trip. Null when there is
  // nothing to fold (no fills, or it hasn't been closed yet).
  const merged = useMemo(() => (trade ? collapseFills(trade) : null), [trade]);

  /**
   * Fold the scaling away: write the averaged round trip, then drop the fills.
   * Two clicks, because it destroys the fill history and the first click is
   * where the consequence is spelled out. The trade is written BEFORE the
   * fills are removed, so a failure midway leaves a trade that still adds up
   * rather than one whose exit no longer accounts for its partials.
   */
  async function mergeIntoOneExit() {
    if (!trade || !merged) return;
    if (!confirmMerge) {
      setConfirmMerge(true);
      return;
    }
    setMerging(true);
    try {
      await updateTrade.mutateAsync({
        id: trade.id,
        trade: {
          size: merged.size,
          entryPrice: merged.entryPrice,
          exitPrice: merged.exitPrice,
        },
        mistakeTagIds: selectedTags,
      });
      for (const fl of trade.fills) await deleteFill.mutateAsync(fl.id);
      setF((prev) => ({
        ...prev,
        size: String(merged.size),
        entryPrice: String(merged.entryPrice),
        exitPrice: String(merged.exitPrice),
      }));
      toast({
        title: "Merged into one exit",
        description: `Now ${num(merged.size)} @ ${num(merged.entryPrice)} → ${num(merged.exitPrice)}. Same P&L.`,
      });
    } catch (err: any) {
      toast({
        title: "Couldn't merge",
        description: String(err?.message ?? err).slice(0, 160),
        variant: "destructive",
      });
    } finally {
      setMerging(false);
      setConfirmMerge(false);
    }
  }
  const knownAccounts = useMemo(() => {
    const s = new Set<string>();
    for (const t of allTrades) if (t.account?.trim()) s.add(t.account.trim());
    return Array.from(s).sort();
  }, [allTrades]);
  const knownSources = useMemo(() => {
    const s = new Set<string>();
    for (const t of allTrades) if (t.source?.trim()) s.add(t.source.trim());
    return Array.from(s).sort();
  }, [allTrades]);
  const [source, setSource] = useState("");
  /**
   * Where this trade is in its life. Explicit rather than inferred, because
   * every step is editable: an order that never filled goes back to pending, a
   * trade closed by mistake goes back to open.
   */
  const [lifecycle, setLifecycle] = useState<Lifecycle>("open");
  /** Which scaling dialog is open, if any. */
  const [fillKind, setFillKind] = useState<"add" | "partial" | null>(null);

  /** Everything typed, as one value — what gets stashed and compared. */
  const current: TradeDraft = {
    f,
    direction,
    exitReason,
    nmo,
    selectedTags,
    extraTps,
    highlights,
    grades,
    account,
    source,
    styleId,
    sizeUnit,
    lifecycle,
  };
  /** The same shape, built from the trade as stored. */
  const saved = useMemo(() => (trade ? draftFromTrade(trade) : null), [trade]);

  /**
   * Load the trade into the form — once per trade, not once per refetch.
   *
   * Keyed on the id rather than the object. `trade` is a fresh object every
   * time the trades query settles, so with `[trade]` this fired on any
   * refetch: logging a partial invalidated the list, the list came back, and
   * this effect overwrote everything typed-but-unsaved with the stored row
   * mid-sentence. The fills list below reads from `trade` directly, so it
   * still updates; what must not move is the form.
   */
  const [restored, setRestored] = useState<string | null>(null);
  useEffect(() => {
    if (!trade) return;
    const base = draftFromTrade(trade);
    // Unsaved edits win over the stored row — that is the whole point of
    // keeping them — but never silently: the banner says they were restored
    // and offers to throw them away.
    const stored = readDraft(trade.id);
    const use = stored && draftDiffers(stored.draft, base) ? stored.draft : base;
    setRestored(stored && draftDiffers(stored.draft, base) ? stored.savedAt : null);
    applyDraft(use);
  }, [trade?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Put a draft into the form's state. Used by both load and discard. */
  function applyDraft(d: TradeDraft) {
    setF(d.f);
    setDirection(d.direction);
    setExitReason(d.exitReason);
    setNmo(d.nmo);
    setSelectedTags(d.selectedTags);
    setExtraTps(d.extraTps);
    setHighlights(d.highlights);
    setGrades(d.grades as GradeState);
    setAccount(d.account);
    setSource(d.source);
    setStyleId(d.styleId);
    setSizeUnit(d.sizeUnit);
    setLifecycle(d.lifecycle);
  }

  /*
   * Keep the draft current as it is typed.
   *
   * Every render rather than on unmount: the panel can go away without
   * unmounting cleanly (a route change, a reload, the tab being closed), and
   * an unsaved-work guarantee that depends on leaving politely is not one.
   * stashDraft removes the key when the form matches the stored trade, so
   * undoing an edit by hand clears the draft as surely as saving does.
   */
  useEffect(() => {
    if (!trade || !saved || !f.symbol) return;
    stashDraft(trade.id, current, saved);
  });

  /*
   * Typing an exit price IS closing the trade, so the picker follows — you
   * should not have to say it twice. One-way on purpose: it never drags a
   * trade back OFF closed, so clearing the field to correct a typo does not
   * reopen a finished trade underneath you.
   */
  useEffect(() => {
    if (outcomeStage(f.exitPrice ?? "", null).priced) {
      setLifecycle((cur) => (cur === "closed" ? cur : "closed"));
    }
  }, [f.exitPrice]);

  /*
   * A closed-position card, pasted.
   *
   * The exchange knows the average fill and the exact second; typing them back
   * in by hand is where a journal's numbers drift from what happened. Only the
   * exit goes on automatically — the card's entry price and its size are
   * REPORTED rather than applied, because the entry decides 1R and the size
   * column next to it means something different on a scaled position.
   */
  const [cardRead, setCardRead] = useState<{
    card: CloseCard;
    verdict: ReturnType<typeof closeFromCard>;
  } | null>(null);
  const [addingPartials, setAddingPartials] = useState(false);

  function applyCard(c: CloseCard) {
    if (!trade) return;
    // A chart pasted onto a closed trade is an attachment, not an argument.
    // It has none of a close's fields, so there is nothing to report and the
    // gallery's own listener has already kept the image.
    if (trade.status === "closed" && !saysAnythingAboutClose(c)) return;
    const verdict = closeFromCard(c, { ...trade, fees: trade.fees });
    setCardRead({ card: c, verdict });
    if (!verdict.usable) return;
    setF((p) => ({
      ...p,
      ...(verdict.apply.exitPrice != null ? { exitPrice: String(verdict.apply.exitPrice) } : {}),
      ...(verdict.apply.exitTime ? { exitTime: verdict.apply.exitTime } : {}),
      ...(verdict.apply.fees != null ? { fees: String(verdict.apply.fees) } : {}),
    }));
  }

  /**
   * Log the fills that were separate decisions.
   *
   * Never automatic. Partials change what the trade IS — its average exit, its
   * R, whether it reads as one clean exit or three nervous ones — and a set of
   * rows that arrived through a screenshot should be looked at before it
   * rewrites that. The last fill is left off: it is the close itself, already
   * going in as the exit above.
   */
  async function logPartials(fills: CloseFill[]) {
    if (!trade) return;
    setAddingPartials(true);
    try {
      /*
       * The table's sizes are not always in the trade's unit — Binance prints
       * fills in USDT against a position that may be kept in coins — and the
       * check that said so was only ever shown, never applied. Writing the
       * raw figure logged a position off by a factor of the price, which the
       * ledger then reported with a straight face.
       */
      const note = cardRead?.verdict.sizes?.unitNote ?? null;
      const inTradeUnit = (f: CloseFill) =>
        note === "the table is in quote, the trade in units"
          ? f.size! / f.price!
          : note === "the table is in units, the trade in quote"
            ? f.size! * f.price!
            : f.size!;

      /*
       * All but the last: the trade's own exit price carries the final slice,
       * which is the convention the ledger settles on everywhere.
       */
      const usable = fills.filter((f) => f.price != null && (f.size ?? 0) > 0);
      for (const f of usable.slice(0, -1)) {
        await addFill.mutateAsync({
          tradeId: trade.id,
          kind: "partial",
          price: f.price!,
          size: inTradeUnit(f),
          time: f.time ? toIso(f.time) : undefined,
          note: "from a pasted fill table",
        });
      }
      /*
       * The trade's own exit becomes the LAST clip, because that is what it
       * now is: the earlier clips are fills, and whatever size they leave came
       * off at the final price. Leaving the blended average there instead —
       * which is what this did, while the message below claimed otherwise —
       * prices the residual at an average that already includes the clips just
       * moved out of it, and the trade reports a total it never made.
       */
      const last = usable[usable.length - 1];
      if (last?.price != null) {
        setF((p) => ({
          ...p,
          exitPrice: String(last.price),
          ...(last.time ? { exitTime: last.time } : {}),
        }));
      }
      toast({
        title: "Logged as separate exits",
        description: `${Math.max(usable.length - 1, 0)} ${usable.length === 2 ? "partial" : "partials"} added. The exit above is the last one, and the R now follows the blend.`,
      });
      setCardRead((r) =>
        r ? { ...r, verdict: { ...r.verdict, fills: [], partials: [] } } : r,
      );
    } catch (err: any) {
      toast({
        title: "Couldn't log those partials",
        description: String(err?.message ?? err).slice(0, 160),
        variant: "destructive",
      });
    } finally {
      setAddingPartials(false);
    }
  }

  // Handed in by a surface that took the paste before this opened.
  useEffect(() => {
    if (card) applyCard(card);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card]);

  /*
   * Read on ANY trade, not just a live one.
   *
   * This used to be live-only, on the reasoning that Ctrl-V on a closed trade
   * is how you attach the outcome chart and hijacking it would take a working
   * gesture away. That was right about the gesture and wrong about the trader:
   * the exit is most often corrected AFTER the trade is closed — a screenshot
   * of the fills is exactly how you find out you logged one exit for five —
   * and a paste that silently did nothing was the worse of the two failures.
   *
   * Both readings coexist because the picture decides, not the trade's state:
   * a chart carries none of a close's fields, so it is attached and nothing is
   * said (see applyCard), while a fills table announces itself.
   */
  /*
   * What the offer actually logs.
   *
   * Where the table holds several clips, the clips — one exit per decision,
   * each at the price it got. Offering a row per PRINT there would turn three
   * partials taken through market orders into fifteen exits and invent a plan
   * nobody had. Where every print shares one instant there are no clips to
   * find, so the raw rows are all there is to offer.
   */
  const offeredExits =
    cardRead && cardRead.verdict.partials.length > 1
      ? cardRead.verdict.partials
      : (cardRead?.verdict.fills ?? []);

  const { busy: readingCard } = useCloseCardPaste({
    trade,
    enabled: !!trade,
    onCard: applyCard,
    onError: (message) =>
      toast({ title: "Couldn't read that screenshot", description: message, variant: "destructive" }),
  });

  const set = (k: string) => (e: { target: { value: string } }) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  const numOrNull = (v: string) => (v.trim() === "" || !isFinite(Number(v)) ? null : Number(v));

  const previewMetrics = useMemo(() => {
    if (!trade) return null;
    const entryPrice = numOrNull(f.entryPrice ?? "");
    const initialStop = numOrNull(f.initialStop ?? "");
    if (entryPrice == null || initialStop == null) return null;
    return computeMetrics({
      ...trade,
      direction,
      size: numOrNull(f.size ?? "") ?? trade.size,
      sizeUnit,
      entryPrice,
      initialStop,
      initialTarget: numOrNull(f.initialTarget ?? "") ?? trade.initialTarget,
      exitPrice: numOrNull(f.exitPrice ?? ""),
      mae: numOrNull(f.mae ?? ""),
      mfe: numOrNull(f.mfe ?? ""),
      noManagementOutcome: nmo,
      // Without this the preview kept the SAVED fee while you edited the
      // field, so correcting a commission left the R below it unmoved.
      fees: numOrNull(f.fees ?? ""),
    } as any);
  }, [trade, f, direction, nmo]);

  async function save() {
    if (!trade) return;
    const entryPrice = numOrNull(f.entryPrice);
    const initialStop = numOrNull(f.initialStop);
    const initialTarget = numOrNull(f.initialTarget);
    const size = numOrNull(f.size);
    // A pending trade is only a resting order, so it may be saved with just an
    // entry — that is the whole point of importing one before it fills. Stop
    // and target become mandatory when it goes live.
    const isPending = trade.status === "pending";
    if (!f.symbol?.trim() || entryPrice == null || size == null) {
      toast({ title: "Symbol, size and entry are required", variant: "destructive" });
      return;
    }
    if (!isPending && (initialStop == null || initialTarget == null)) {
      toast({ title: "A live trade needs a stop and a target", variant: "destructive" });
      return;
    }
    // The picked lifecycle and the exit price must agree before anything is
    // written; see resolveLifecycle for why neither contradiction is allowed.
    const resolution = resolveLifecycle(lifecycle, f.exitPrice ?? "");
    if ("error" in resolution) {
      toast({ title: resolution.error, variant: "destructive" });
      return;
    }
    const resolved = resolution;
    // Same promotion as the entry card: a source name typed into the tag
    // field moves to the source column rather than becoming a fake setup.
    const promoted = splitSourceFromTags(
      normalizeSetupTags(f.rationaleTags.split(",")),
      knownSources,
      source.trim() || null,
    );
    const rTags = promoted.tags;

    try {
    await updateTrade.mutateAsync({
      id: trade.id,
      trade: {
        symbol: f.symbol.trim().toUpperCase(),
        direction,
        size,
        entryPrice,
        sizeUnit,
        initialStop,
        initialTarget,
        entryTime: f.entryTime ? toIso(f.entryTime) : trade.entryTime,
        extraTargets: (() => {
          const xs = extraTps.map(Number).filter((x) => isFinite(x) && x > 0);
          return xs.length ? JSON.stringify(xs) : null;
        })(),
        status: resolved.status,
        exitPrice: numOrNull(f.exitPrice),
        exitTime: f.exitTime ? toIso(f.exitTime) : null,
        exitReason: (exitReason as any) ?? null,
        mae: numOrNull(f.mae),
        mfe: numOrNull(f.mfe),
        postExitPeak: numOrNull(f.postExitPeak ?? ""),
        postExitAdverse: numOrNull(f.postExitAdverse ?? ""),
        noManagementOutcome: (nmo as any) ?? null,
        rationale: f.rationale.trim() || null,
        rationaleTags: rTags.length ? JSON.stringify(rTags) : null,
        notes: f.notes.trim() || null,
        account: account.trim() || null,
        source: promoted.source,
        styleId,
        fees: numOrNull(f.fees ?? ""),
        highlights: serializeHighlights(highlights),
        entryGrade: grades.entry as any,
        stopGrade: grades.stop as any,
        exitGrade: grades.exit as any,
      },
      mistakeTagIds: selectedTags,
    });
    // Saved: the stored row IS the draft now, and a surviving copy is only a
    // way for the two to disagree the next time this opens.
    clearDraft(trade.id);
    setRestored(null);
    toast({ title: "Trade updated", description: `${f.symbol.toUpperCase()} corrected.` });
    onClose();
    } catch (err: any) {
      /*
       * A save that fails must say so, and must NOT close.
       *
       * Without this the promise rejected into nothing: no toast, no close,
       * the editor sitting there looking saved. A cold start, an expired
       * session or a rejected field all presented as success, and the work
       * was gone the next time the trade was opened. The panel stays put so
       * nothing typed is lost — pressing save again is the whole retry.
       */
      toast({
        title: "Not saved — nothing was changed",
        description: `${String(err?.message ?? err).slice(0, 140)} · your edits are still here, press Save to try again.`,
        variant: "destructive",
      });
    }
  }

  /** A price field that says what KIND of price it is, in colour and mark. */
  const levelField = (key: string, kind: LevelKind, label?: string) => (
    <div className="space-y-1">
      <LevelLabel kind={kind} text={label} />
      <Input
        type="number"
        step="any"
        inputMode="decimal"
        value={f[key] ?? ""}
        onChange={set(key)}
        className="h-9 font-mono text-sm"
        data-testid={`input-edit-${key}`}
      />
    </div>
  );

  const field = (
    key: string,
    label: string,
    type: "number" | "text" | "datetime-local" = "number",
  ) => (
    <div className="space-y-1">
      <label className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</label>
      <Input
        type={type}
        step={type === "number" ? "any" : undefined}
        inputMode={type === "number" ? "decimal" : undefined}
        value={f[key] ?? ""}
        onChange={set(key)}
        className={`h-9 ${type === "datetime-local" ? "font-mono text-xs" : "font-mono text-sm"}`}
        data-testid={`input-edit-${key}`}
      />
    </div>
  );

  return (
    <div className="space-y-4" data-testid="panel-trade-editor">
      <div>
        <div className="flex items-center gap-2 text-base font-semibold">
          <Pencil className="h-4 w-4 text-muted-foreground" />
          Edit {trade ? typedSymbol(trade) : ""}
          {readingCard && (
            <span className="text-[11px] font-normal text-muted-foreground" data-testid="text-reading-card">
              reading your screenshot…
            </span>
          )}
        </div>


        {/* What the card said, and what was left alone. Filling the fields
            silently would be the wrong kind of helpful: these are numbers you
            are about to sign off on, and the ones this refused to touch are
            exactly the ones worth a second look. */}
        {cardRead && (
          <div
            className="mt-2 space-y-1 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-[11px]"
            data-testid="banner-close-card"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {/* What KIND of screenshot that was, before any of the numbers.
                  "I pasted it and nothing happened" was literally true, but a
                  paste that quietly fills three fields looks the same — so the
                  read says what it saw, in the terms the position came off in
                  rather than the fields it wrote. */}
              <span className="font-medium" data-testid="text-close-card-headline">
                {readHeadline(cardRead.card, cardRead.verdict)}
              </span>
              {(cardRead.verdict.apply.exitPrice ?? cardRead.card.exitPrice) != null && (
                <span className="font-mono">
                  exit {num((cardRead.verdict.apply.exitPrice ?? cardRead.card.exitPrice)!)}
                </span>
              )}
              {/* The size is the field most worth showing and the one most
                  likely to be off: it is what says whether the screenshot is
                  the whole position or a slice of it. */}
              {(cardRead.card.size ?? cardRead.verdict.sizes?.total) != null && (
                <span className="font-mono" data-testid="text-close-card-size">
                  {num((cardRead.card.size ?? cardRead.verdict.sizes!.total)!)} closed
                </span>
              )}
              {(cardRead.verdict.apply.exitTime ?? cardRead.card.exitTime) && (
                <span className="font-mono">
                  {(cardRead.verdict.apply.exitTime ?? cardRead.card.exitTime)!.replace("T", " ")}
                </span>
              )}
              {cardRead.card.realizedPnl != null && (
                <span className="font-mono">
                  {cardRead.card.realizedPnl > 0 ? "+" : ""}
                  {num(cardRead.card.realizedPnl)} {cardRead.card.pnlCurrency ?? ""}
                </span>
              )}
              <button
                type="button"
                className="ml-auto text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => setCardRead(null)}
                data-testid="button-dismiss-close-card"
              >
                dismiss
              </button>
            </div>
            {cardRead.card.fee != null && cardRead.card.fee > 0 && (
              <p className="text-muted-foreground">
                Fee{" "}
                <span className="font-mono text-foreground/80">
                  {num(Math.abs(cardRead.card.fee))} {cardRead.card.feeCurrency ?? ""}
                </span>{" "}
                — R and P&amp;L go net of it.
              </p>
            )}
            {cardRead.verdict.warnings.map((w) => (
              <p key={w} className="text-amber-500" data-testid="text-close-card-warning">
                {w}
              </p>
            ))}
            {/* A fills table is an account of how the position came off, and
                the offer to keep it is only trustworthy if it ADDS UP: a table
                summing to the position loses nothing when it replaces one
                averaged exit, while a table summing to half of it would
                quietly shrink the trade. So the totals are checked, said out
                loud, and the conversion is offered either way — with the
                mismatch named, because a screenshot of half the exits is
                still worth keeping if you know that is what it is. */}
            {cardRead.verdict.fills.length > 1 && (
              <div className="space-y-1" data-testid="close-card-partials">
                <div className="flex flex-wrap items-center gap-2">
                  {/* The headline above already said what these rows are; this
                      is only the offer to keep them. */}
                  <span>
                    {cardRead.verdict.partials.length > 1
                      ? "Logged as one exit, but it was not one."
                      : "Kept as a single exit at the average."}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 px-2 text-[11px]"
                    disabled={addingPartials}
                    onClick={() => logPartials(offeredExits)}
                    data-testid="button-log-pasted-partials"
                  >
                    {addingPartials ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Minus className="h-3 w-3 text-emerald-500" />
                    )}
                    Keep all {offeredExits.length} as separate exits
                  </Button>
                </div>
                {cardRead.verdict.sizes && (
                  <p
                    className={
                      cardRead.verdict.sizes.matchesTrade ? "text-muted-foreground" : "text-amber-500"
                    }
                    data-testid="text-close-card-sizes"
                  >
                    {cardRead.verdict.sizes.matchesTrade ? (
                      <>
                        They add up to this position ({num(cardRead.verdict.sizes.total)})
                        {cardRead.verdict.sizes.unitNote ? ` — ${cardRead.verdict.sizes.unitNote}` : ""}
                        , so nothing is lost by keeping them all.
                      </>
                    ) : (
                      <>
                        They add up to {num(cardRead.verdict.sizes.total)}, and this trade is{" "}
                        {num(trade?.size)} — a partial view of how it came off. Keeping them would
                        replace the exit with less than the whole position.
                      </>
                    )}
                  </p>
                )}
              </div>
            )}
            <p className="text-muted-foreground">Check it, then save.</p>
          </div>
        )}

        {/* Restoring silently would be its own trap: you would be looking at
            numbers that are not what the trade says, with nothing to tell you
            so. The banner says where the fields came from and offers the way
            back to the stored row. */}
        {restored && trade && (
          <div
            className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-[11px]"
            data-testid="banner-restored-draft"
          >
            <span>
              Showing edits you never saved, from {agoLabel(restored)}. They stay here until you
              save or discard them.
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2 text-[11px]"
              onClick={() => {
                clearDraft(trade.id);
                applyDraft(draftFromTrade(trade));
                setRestored(null);
                toast({ title: "Unsaved edits discarded", description: "Back to the saved trade." });
              }}
              data-testid="button-discard-draft"
            >
              Discard them
            </Button>
          </div>
        )}

        {trade && (
          <div className="space-y-5">
            <FormSection
              icon={ClipboardList}
              title="The setup"
              hint="what you planned, and what you put on"
              testId="section-edit-setup"
            >
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0 space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Symbol
                </label>
                <SymbolPicker
                  value={f.symbol ?? ""}
                  onChange={(v) => setF((p) => ({ ...p, symbol: v }))}
                  trades={allTrades}
                  testId="input-edit-symbol"
                  className="h-9 font-mono text-sm"
                />
              </div>
              <div className="min-w-0 space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Direction
                </label>
                <div className="flex gap-1.5">
                  {(["long", "short"] as const).map((d) => (
                    <Button
                      key={d}
                      type="button"
                      size="sm"
                      variant={direction === d ? "default" : "outline"}
                      className={`h-9 min-w-0 flex-1 gap-1 px-1.5 text-xs capitalize ${
                        direction === d && d === "long"
                          ? "bg-emerald-600 text-white hover:bg-emerald-600/90"
                          : ""
                      }`}
                      onClick={() => setDirection(d)}
                      data-testid={`button-edit-direction-${d}`}
                    >
                      {d}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Size
                  </label>
                  <div className="flex gap-0.5">
                    {(["base", "quote"] as const).map((u) => {
                      // A futures contract has no notional sizing; offering it
                      // there produces a real but meaningless 1R.
                      const disabled = u === "quote" && (trade.pointValue ?? 1) !== 1;
                      return (
                        <button
                          key={u}
                          type="button"
                          disabled={disabled}
                          title={disabled ? "Futures are sized in contracts" : undefined}
                          onClick={() => !disabled && setSizeUnit(u)}
                          data-testid={`button-edit-size-unit-${u}`}
                          aria-pressed={sizeUnit === u}
                          className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider transition-colors ${
                            disabled
                              ? "cursor-not-allowed text-muted-foreground/30"
                              : sizeUnit === u
                                ? "bg-primary/15 text-primary"
                                : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {u === "base" ? "units" : "usd"}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <Input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={f.size ?? ""}
                  onChange={set("size")}
                  className="h-9 font-mono text-sm"
                  data-testid="input-edit-size"
                />
              </div>
              {levelField("entryPrice", "entry")}
              {levelField("initialStop", "stop")}
              <div className="space-y-1">
                <LevelLabel kind="target" text={extraTps.length > 0 ? "TP1" : "Target"}>
                  {extraTps.length < 3 && (
                    <button
                      type="button"
                      onClick={() => setExtraTps((x) => [...x, ""])}
                      title="Add another take-profit level"
                      data-testid="button-edit-add-tp"
                      className="rounded px-1 text-[11px] leading-none text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                    >
                      +
                    </button>
                  )}
                </LevelLabel>
                <Input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={f.initialTarget ?? ""}
                  onChange={set("initialTarget")}
                  className="h-9 font-mono text-sm"
                  data-testid="input-edit-initialTarget"
                />
              </div>
              {extraTps.map((tp, i) => (
                <div key={i} className="space-y-1">
                  <LevelLabel kind="tp" text={`TP${i + 2}`}>
                    <button
                      type="button"
                      onClick={() => setExtraTps((x) => x.filter((_, j) => j !== i))}
                      title="Remove this level"
                      data-testid={`button-edit-remove-tp-${i}`}
                      className="rounded px-1 text-[11px] leading-none text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      ×
                    </button>
                  </LevelLabel>
                  <Input
                    type="number"
                    step="any"
                    inputMode="decimal"
                    value={tp}
                    onChange={(e) =>
                      setExtraTps((x) => x.map((v, j) => (j === i ? e.target.value : v)))
                    }
                    className="h-9 font-mono text-sm"
                    data-testid={`input-edit-extra-tp-${i}`}
                  />
                </div>
              ))}
              {/* The plan, to scale. Two prices are two numbers to subtract; a
                  reward leg three times the length of the risk leg is a fact
                  you see before you have finished reading it. Spans the grid
                  because it is about the fields either side of it. */}
              <div className="col-span-2">
                <LevelLadder
                  direction={direction}
                  entry={numOrNull(f.entryPrice ?? "")}
                  stop={numOrNull(f.initialStop ?? "")}
                  target={numOrNull(f.initialTarget ?? "")}
                  extraTps={extraTps.map((t) => numOrNull(t))}
                  exit={numOrNull(f.exitPrice ?? "")}
                />
              </div>
              {field("entryTime", "Entry time", "datetime-local")}
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Account
                </label>
                <AccountPicker
                  value={account}
                  onChange={setAccount}
                  known={knownAccounts}
                  testIdPrefix="edit-account"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Source
                </label>
                <AccountPicker
                  value={source}
                  onChange={setSource}
                  known={knownSources}
                  testIdPrefix="edit-source"
                  placeholder="e.g. Daniel, Severin, CBS, UB"
                  emptyLabel="My own idea"
                  newLabel="+ New source…"
                />
              </div>
              {styles.length > 0 && (
                <div className="col-span-2 space-y-1" data-testid="section-edit-style">
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Style
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {styles.map((s) => {
                      const on = s.id === styleId;
                      const c = styleColor(s.color);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          /* Tapping the active one clears it: a trade can
                             legitimately belong to no book. */
                          onClick={() => setStyleId(on ? null : s.id)}
                          aria-pressed={on}
                          data-testid={`chip-edit-style-${s.id}`}
                          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] leading-tight transition-colors ${
                            on
                              ? c.chip
                              : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                          }`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
                          {s.name}
                        </button>
                      );
                    })}
                    {styleId != null && (
                      <button
                        type="button"
                        onClick={() => setStyleId(null)}
                        className="rounded-full border border-border px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                        data-testid="button-edit-style-clear"
                      >
                        unassigned
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
            </FormSection>

            {/* Where the trade is in its life, editable at every step.
                The entry card asks this when logging; nothing asked it again
                afterwards, so an order that never filled could not be walked
                back and a trade closed by mistake could not be reopened. The
                three states are the whole life of a trade: waiting for a
                fill, live, done. */}
            <div data-testid="section-edit-lifecycle">
              <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                State
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    { id: "pending", label: "Waiting to fill", icon: Clock3 },
                    { id: "open", label: "Open", icon: ArrowUpRight },
                    { id: "closed", label: "Closed", icon: CheckCircle2 },
                  ] as const
                ).map(({ id, label, icon: Icon }) => (
                  <Button
                    key={id}
                    type="button"
                    size="sm"
                    variant={lifecycle === id ? "default" : "outline"}
                    className="h-7 gap-1.5 px-2 text-[11px]"
                    onClick={() => setLifecycle(id)}
                    data-testid={`button-edit-lifecycle-${id}`}
                    aria-pressed={lifecycle === id}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </Button>
                ))}
              </div>
              {lifecycle === "closed" && !outcomeStage(f.exitPrice ?? "", null).priced && (
                <p className="mt-1.5 text-[11px] text-amber-500" data-testid="text-edit-needs-exit">
                  Fill in the exit price below to close it.
                </p>
              )}
              {lifecycle !== "closed" && outcomeStage(f.exitPrice ?? "", null).priced && (
                <p className="mt-1.5 text-[11px] text-amber-500" data-testid="text-edit-has-exit">
                  There is an exit price below — clear it to put this back to{" "}
                  {lifecycle === "pending" ? "waiting" : "open"}.
                </p>
              )}
            </div>

            {/* Sits directly above the exit price, because that is the field
                it writes and the one whose meaning it is disambiguating. */}
            {trade && <AverageCloseSolver trade={trade} onUse={(v) => setF((p) => ({ ...p, exitPrice: v }))} />}

            {/* The same questions the entry card asks when logging a
                completed trade — one component, so an open trade is never
                asked to grade an exit it has not had. */}
            <TradeOutcomeFields
              exitPrice={f.exitPrice ?? ""}
              setExitPrice={(v: string) => setF((p) => ({ ...p, exitPrice: v }))}
              exitTime={f.exitTime ?? ""}
              setExitTime={(v: string) => setF((p) => ({ ...p, exitTime: v }))}
              exitReason={exitReason}
              setExitReason={setExitReason}
              mae={f.mae ?? ""}
              setMae={(v: string) => setF((p) => ({ ...p, mae: v }))}
              mfe={f.mfe ?? ""}
              setMfe={(v: string) => setF((p) => ({ ...p, mfe: v }))}
              postExitPeak={f.postExitPeak ?? ""}
              setPostExitPeak={(v: string) => setF((p) => ({ ...p, postExitPeak: v }))}
              postExitAdverse={f.postExitAdverse ?? ""}
              setPostExitAdverse={(v: string) => setF((p) => ({ ...p, postExitAdverse: v }))}
              nmo={nmo}
              setNmo={setNmo}
              fees={f.fees ?? ""}
              setFees={(v: string) => setF((p) => ({ ...p, fees: v }))}
              grades={grades}
              setGrades={setGrades}
              demons={tags}
              demonIds={selectedTags}
              setDemonIds={setSelectedTags}
              highlights={highlights}
              setHighlights={setHighlights}
              extraHighlights={knownHighlights(allTrades)}
              testPrefix="edit"
              timing={{
                direction,
                entryPrice: numOrNull(f.entryPrice ?? ""),
                initialStop: numOrNull(f.initialStop ?? ""),
              }}
            />

            {/* Scaling belongs in the edit dialog too, and on a CLOSED trade
                it is the only place it can happen: the trade view offers
                these buttons while a position is running, which is no use to
                anyone who writes trades up afterwards. "It hit my stop, but I
                had already taken two partials" is an ordinary trade and the
                difference between a −1R and a small winner; the ledger always
                did that arithmetic, there was simply nowhere to type it.

                Always rendered, not only when fills exist — a section that
                appears once you already have what it is for cannot be how you
                get your first one. */}
            <div data-testid="section-edit-fills">
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
                  <Layers className="h-3.5 w-3.5 text-muted-foreground" />
                  Partials and adds
                </span>
                <div className="flex gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 px-2 text-[11px]"
                    onClick={() => setFillKind("partial")}
                    data-testid="button-edit-log-partial"
                  >
                    <Minus className="h-3 w-3 text-emerald-500" />
                    Took profit
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 px-2 text-[11px]"
                    onClick={() => setFillKind("add")}
                    data-testid="button-edit-log-add"
                  >
                    <Plus className="h-3 w-3 text-sky-400" />
                    Added size
                  </Button>
                </div>
              </div>
              {trade.fills.length === 0 ? (
                <p
                  className="rounded-md border border-dashed border-border/60 px-2.5 py-2 text-[11px] text-muted-foreground"
                  data-testid="text-edit-no-fills"
                >
                  Nothing scaled — the whole position went on at {num(trade.entryPrice)} and came
                  off in one piece. Log a partial or an add and the R above follows the blend.
                </p>
              ) : (
                <>
                <ul className="space-y-1">
                  {[...trade.fills]
                    .sort((a, b) => a.time.localeCompare(b.time))
                    .map((fl) => (
                      <li
                        key={fl.id}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-xs"
                        data-testid={`edit-fill-${fl.id}`}
                      >
                        <Badge
                          variant="outline"
                          className={`shrink-0 text-[10px] font-normal ${
                            fl.kind === "add"
                              ? "border-sky-500/40 text-sky-400"
                              : "border-emerald-500/40 text-emerald-400"
                          }`}
                        >
                          {fl.kind === "add" ? "added" : "took"}
                        </Badge>
                        <span className="font-mono">
                          {num(fl.size)}
                          {trade.sizeUnit === "quote" ? " USD" : ""} @ {num(fl.price)}
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {new Date(fl.time).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="ml-auto h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => deleteFill.mutate(fl.id)}
                          disabled={deleteFill.isPending}
                          aria-label="Remove this fill"
                          data-testid={`button-edit-delete-fill-${fl.id}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </li>
                    ))}
                </ul>

                {merged && (
                  <div className="mt-2 rounded-md border border-border/60 bg-secondary/20 p-2.5">
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      Log it as one round trip instead:{" "}
                      <span className="font-mono text-foreground">
                        {num(merged.size)}
                        {trade.sizeUnit === "quote" ? " USD" : ""} @ {num(merged.entryPrice)}{" "}
                        &rarr; {num(merged.exitPrice)}
                      </span>
                      . The P&amp;L is identical to the cent &mdash; only the story of how it
                      got there is dropped.
                      {trade.fills.some((fl) => fl.kind === "add") && (
                        <span className="text-amber-500">
                          {" "}
                          This trade was added to, so folding the adds into the entry rebases 1R
                          onto the larger position: R will change.
                        </span>
                      )}
                    </p>
                    <Button
                      type="button"
                      variant={confirmMerge ? "destructive" : "outline"}
                      size="sm"
                      className="mt-2 h-7 text-[11px]"
                      disabled={merging}
                      onClick={mergeIntoOneExit}
                      data-testid="button-merge-fills"
                    >
                      {merging && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                      {confirmMerge ? "Merge and delete the fills?" : "Merge into one exit"}
                    </Button>
                  </div>
                )}
                </>
              )}
            </div>

            {/* Inside the editor, not over it. The same form the live trade
                view uses — one validator, one ledger, one shape of row — but a
                partial logged while writing a trade up is part of writing it
                up, and a window stacked on top made a small correction feel
                like a separate errand while hiding the numbers it should be
                read against. */}
            {fillKind && (
              <FillForm
                inline
                trade={trade}
                kind={fillKind}
                onClose={() => setFillKind(null)}
              />
            )}


            {/* Fees explained where they're typed, since they change the R. */}

            <FormSection
              icon={NotebookPen}
              title="Why you took it"
              hint="the part only you can fill in"
              testId="section-edit-why"
            />
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Rationale
              </label>
              <Input
                value={f.rationale ?? ""}
                onChange={set("rationale")}
                className="h-9 text-sm"
                data-testid="input-edit-rationale"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Rationale tags (comma separated)
              </label>
              <Input
                value={f.rationaleTags ?? ""}
                onChange={set("rationaleTags")}
                placeholder="VAH Rejection, Fib Retest"
                className="h-9 text-sm"
                data-testid="input-edit-rationale-tags"
              />
              {/* Same chips as the entry card, writing into the same list — a
                  setup you can tap when logging must be tappable when
                  correcting, or the correction path quietly re-introduces the
                  spellings the chips exist to prevent. */}
              <SetupTagPicker
                selected={(f.rationaleTags ?? "").split(",").map((x) => x.trim()).filter(Boolean)}
                onToggle={(name) =>
                  setF((p) => {
                    const cur = (p.rationaleTags ?? "")
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean);
                    const has = cur.some((x) => x.toLowerCase() === name.toLowerCase());
                    const next = has
                      ? cur.filter((x) => x.toLowerCase() !== name.toLowerCase())
                      : [...cur, name];
                    return { ...p, rationaleTags: next.join(", ") };
                  })
                }
                testIdPrefix="edit-setup"
              />
            </div>

            <Textarea
              value={f.notes ?? ""}
              onChange={set("notes")}
              placeholder="Notes"
              className="min-h-[60px] text-xs"
              data-testid="input-edit-notes"
            />


            {/* The price path, here as well as on the trade's own page.
                Editing is where the levels get corrected, and correcting a
                stop against a chart you cannot see is guesswork. It draws for
                a RUNNING trade too — the window simply ends at now — which is
                the case that matters most, because that is the trade you can
                still do something about. Renders nothing for anything Binance
                cannot price. */}
            <Suspense fallback={null}>
        <TradeChart trade={trade} />
      </Suspense>

            {/* Attach here too, not only from the read-only detail view: Edit
                is where you reach to change a trade, and a screenshot added to
                a trade closed weeks ago is a change like any other. Images save
                on their own, so they survive whether or not "Save changes" is
                pressed. */}
            <div className="border-t border-border/60 pt-3">
              <TradeImageGallery tradeId={trade.id} />
            </div>

            {/*
                  Pinned to the BOTTOM, and last in the form.

                  The numbers you are editing FOR have to be visible while you
                  type, and at the top they were competing with the heading and
                  the section you were reading. A sticky bottom edge lifts the bar
                  up out of its flow position to sit on the viewport floor, so it
                  follows you down the whole form — and settles back into place
                  above Save when you reach the end, which is the one moment it
                  must not be covering anything.

                  Opaque, because form fields sliding under a translucent strip is
                  how a wrong number gets read as a right one.
                */}
            {previewMetrics && (
              /* An opaque shell does the pinning so the strip itself can keep
                 its tint. The offset is negative on purpose: the dialog scrolls
                 inside 24px of padding, so a plain top-0 would pin the bar 24px
                 down and leave a band above it where form rows slide past in
                 full view. -top-6 pins it 24px higher — flush with the visible
                 edge — and the shell's matching pt-6 fills that band, which the
                 scroll container clips away rather than painting over the
                 heading. */
              <div className="sticky bottom-0 z-20 -mb-1 bg-background pb-2 pt-1">
              <div
                className="grid grid-cols-2 gap-2 rounded-md border border-border/60 bg-secondary/30 p-2.5 text-center font-mono text-xs shadow-sm sm:grid-cols-4"
                data-testid="edit-preview-metrics"
              >
                {/* P&L leads. R is this journal's unit, but the broker's
                    statement is in dollars, and the fastest way to know a
                    trade was logged correctly is that this figure matches the
                    one on the exchange. */}
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {previewMetrics.fees > 0 ? "Net P&L" : "P&L"}
                  </p>
                  <p
                    className={`text-sm font-semibold ${
                      (previewMetrics.actualPnL ?? 0) >= 0 ? "text-emerald-400" : "text-primary"
                    }`}
                    data-testid="edit-preview-pnl"
                  >
                    {previewMetrics.actualPnL != null ? fmtMoney(previewMetrics.actualPnL) : "—"}
                  </p>
                  {previewMetrics.fees > 0 && (
                    <p className="text-[10px] text-muted-foreground">
                      {fmtMoney(previewMetrics.grossPnL)} gross
                    </p>
                  )}
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Actual</p>
                  <p
                    className={
                      (previewMetrics.actualR ?? 0) >= 0 ? "text-emerald-400" : "text-primary"
                    }
                  >
                    {fmtR(previewMetrics.actualR)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">No-mgmt</p>
                  <p>{fmtR(previewMetrics.potentialR)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Capture</p>
                  <p>
                    {previewMetrics.captureRatioClipped != null
                      ? `${Math.round(previewMetrics.captureRatioClipped * 100)}%`
                      : "—"}
                  </p>
                </div>
              </div>
              </div>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="h-10 text-xs font-semibold"
                onClick={onClose}
                data-testid="button-edit-cancel"
              >
                Cancel
              </Button>
              <Button
                className="h-10 flex-1 text-xs font-semibold"
                onClick={save}
                disabled={updateTrade.isPending}
                data-testid="button-edit-save"
              >
                {updateTrade.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Save changes
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

