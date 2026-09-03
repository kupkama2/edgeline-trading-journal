/**
 * The entry card: log a setup by hand or drop a chart and confirm the numbers.
 */
import { useEffect, useMemo, useState } from "react";
import { store } from "@/lib/scoped-storage";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ArrowDownRight, ArrowUpRight, Ban, CheckCircle2, ChevronDown, ClipboardList, Clock3, Loader2, Sparkles } from "lucide-react";
import { useTrades, useMistakeTags, useStyles, useCreateTrade, useAddTradeImage, archiveDataUrl, parseScreenshot, fileToDownscaledDataUrl, analyzeRationale } from "@/lib/data";
import { styleColor, styleName, useStyleFilter } from "@/lib/style-filter";
import { parsePlaybook } from "@shared/schema";
import { EXIT_REASON_LABELS } from "@shared/metrics";
import { useDemonGuard } from "@/components/daily-guard";
import {
  contractFor,
  exposureOf,
  fmtExposure,
  lastPointValueFor,
  looksLikeFuturesContract,
  pointValueFor,
} from "@shared/symbols";
import { dropBracketLegs, type ImportCandidate } from "@shared/import-parse";
import { Dropzone, EXIT_REASONS, RationaleTags, TimeField, localNow, num, parseTags, toIso } from "@/components/trade-shared";
import { EMPTY_GRADES, GradePicker, type GradeState } from "@/components/grade-picker";
import { AccountPicker, SetupTagPicker } from "@/components/trade-pickers";
import { TradeOutcomeFields } from "@/components/trade-outcome";
import { normalizeSetupTags } from "@shared/setups";
import { splitSourceFromTags } from "@shared/sources";
import { conflictWarning, directionWarning, readDirection } from "@shared/direction";
import { SymbolPicker } from "@/components/symbol-picker";
import { knownHighlights, serializeHighlights } from "@shared/highlights";
import { suggestSize } from "@shared/sizing";
import { inSessionWindow, windowLabel } from "@shared/session";
import { LevelLabel, LevelLadder, type LevelKind } from "@/components/levels";

/* ============================ new trade card ========================== */

const setupFormSchema = z.object({
  symbol: z.string().min(1, "Required"),
  direction: z.enum(["long", "short"]),
  size: z.coerce.number().positive("Must be > 0"),
  entryPrice: z.coerce.number(),
  initialStop: z.coerce.number(),
  initialTarget: z.coerce.number(),
  entryTime: z.string().min(1),
  notes: z.string().optional(),
  rationale: z.string().optional(),
});
type SetupForm = z.input<typeof setupFormSchema>;

const RISK_BUDGET_KEY = "edgeline.riskBudget";
const ACCOUNT_KEY = "edgeline.lastAccount";

/**
 * An empty or half-typed box is not a price.
 *
 * Number("") is 0, and a zero here is a real level rather than an absent one.
 * Coercing would read a cleared stop as a stop AT zero — which the ladder
 * draws as a plan collapsed onto one end of its axis, and which the direction
 * reader would take as a confident vote for "long". Both at exactly the moment
 * the field is being edited.
 */
const priceOrNull = (v: unknown): number | null => {
  const t = String(v ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return isFinite(n) ? n : null;
};

export function NewTradeCard({
  onOrdersDetected,
  onExpandedChange,
  defaultExpanded = false,
  onCreated,
}: {
  onOrdersDetected: (rows: ImportCandidate[]) => void;
  /** So the page can give the column back when the form is closed. */
  onExpandedChange?: (open: boolean) => void;
  /** Open from the start at /trade/new, where the form IS the page. */
  defaultExpanded?: boolean;
  /** Fired after a successful save, so the overlay can step out of the way. */
  onCreated?: (id: number) => void;
}) {
  const { toast } = useToast();
  const createTrade = useCreateTrade();
  const addImage = useAddTradeImage();
  const [image, setImage] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(false);
  /*
   * The form is a full page of fields and it is idle most of the time — the
   * journal is read far more often than it is written to. So it starts as a
   * single line and opens on demand: a click, or a chart pasted anywhere on
   * the page, which is how a trade usually starts anyway.
   */
  const [expanded, setExpanded] = useState(defaultExpanded);
  useEffect(() => onExpandedChange?.(expanded), [expanded, onExpandedChange]);

  /**
   * Where the trade is in its life, chosen at logging time.
   *
   * A trade goes: placed but not filled -> live -> done. All three are worth
   * logging, and which one you are in decides what the form even asks: a
   * resting order has no exit to grade, and a trade you are recording after
   * the fact should not need creating and then closing as two separate acts.
   */
  const [lifecycle, setLifecycle] = useState<"pending" | "open" | "closed">("open");
  const closedMode = lifecycle === "closed";
  const setClosedMode = (v: boolean | ((c: boolean) => boolean)) =>
    setLifecycle((cur) =>
      (typeof v === "function" ? v(cur === "closed") : v) ? "closed" : "open",
    );
  const [autoClosed, setAutoClosed] = useState(false);
  const [exitPrice, setExitPrice] = useState("");
  const [exitTime, setExitTime] = useState(localNow());
  const [exitReason, setExitReason] = useState<string | null>(null);
  const [grades, setGrades] = useState<GradeState>(EMPTY_GRADES);
  const [selectedDemons, setSelectedDemons] = useState<number[]>([]);
  const [highlights, setHighlights] = useState<string[]>([]);
  const [mae, setMae] = useState("");
  const [mfe, setMfe] = useState("");
  const [postExitPeak, setPostExitPeak] = useState("");
  const [postExitAdverse, setPostExitAdverse] = useState("");
  const [nmo, setNmo] = useState<string | null>(null);
  const [fees, setFees] = useState("");
  const { data: demons = [] } = useMistakeTags();

  /* Optional playbook / edge checklist — never required. */
  const [showPlaybook, setShowPlaybook] = useState(false);
  const [pb, setPb] = useState<{
    setupName: string;
    stopLogic: string;
    targetLogic: string;
    confidence: number | null;
    standAside: string;
  }>({ setupName: "", stopLogic: "", targetLogic: "", confidence: null, standAside: "" });
  const { data: allTrades = [] } = useTrades();
  const knownSetups = useMemo(() => {
    const names = new Set<string>();
    for (const t of allTrades) {
      const p = parsePlaybook(t.playbook);
      if (p?.setupName?.trim()) names.add(p.setupName.trim());
    }
    return Array.from(names).sort();
  }, [allTrades]);
  /* Which book this trade belongs to. Falls back to the journal's active style,
     then the first style, so logging stays one-click for a single-book day. */
  const { data: styles = [] } = useStyles();
  const { activeStyleId } = useStyleFilter();
  const [pickedStyleId, setPickedStyleId] = useState<number | null>(null);
  const styleId = pickedStyleId ?? activeStyleId ?? styles[0]?.id ?? null;

  // Retarget the form when the page is scoped to a different book, otherwise a
  // picked style would silently outlive the filter it was chosen under.
  useEffect(() => setPickedStyleId(null), [activeStyleId]);

  // Same lock the R-loss guardrail produces — a repeated demon blocks new
  // entries, but only for the style that produced the streak.
  const guard = useDemonGuard(styleId);

  // Futures are decided in contracts, crypto in USD notional. Defaulted per
  // symbol so the common case needs no click, but always overridable — the
  // guess is from the ticker, and tickers are not a reliable venue signal.
  const [sizeUnit, setSizeUnit] = useState<"base" | "quote">("base");
  // The risk budget is a account-level habit, not a per-trade fact — it
  // survives reloads so it is typed once, not every morning.
  const [riskBudget, setRiskBudget] = useState<string>(
    () => store.get(RISK_BUDGET_KEY) ?? "",
  );
  // Planned scale-out levels beyond the first target. Most trades have one
  // TP, so this starts empty and only the "+" reveals more rows.
  const [extraTps, setExtraTps] = useState<string[]>([]);
  // Which account the trade runs in. Sticky like the risk budget — you trade
  // the same account all session, so it should not need re-picking per trade.
  const [account, setAccount] = useState<string>(
    () => store.get(ACCOUNT_KEY) ?? "",
  );
  // Scoping the page to an account is a statement about what you are doing
  // now, so a trade logged from that page belongs to it. Without this you can
  // filter to the Apex eval, log a trade, and have it land on whichever
  // account you happened to use last.
  const { activeAccount, activeSource } = useStyleFilter();
  useEffect(() => {
    if (activeAccount) setAccount(activeAccount);
  }, [activeAccount]);
  // Same reasoning for the source: reading Severin's trades and then logging
  // one is almost always logging one of his.
  useEffect(() => {
    if (activeSource) setSource(activeSource);
  }, [activeSource]);
  // Every account name already on a trade, so picking stays one click and one
  // spelling. Free text underneath it all: no accounts table to administer.
  const [source, setSource] = useState("");
  /** Setups tapped as chips. Merged with whatever the rationale parser finds. */
  const [setupTags, setSetupTags] = useState<string[]>([]);
  const knownSources = useMemo(() => {
    const s = new Set<string>();
    for (const t of allTrades) if (t.source?.trim()) s.add(t.source.trim());
    return Array.from(s).sort();
  }, [allTrades]);

  const knownAccounts = useMemo(() => {
    const names = new Set<string>();
    for (const t of allTrades) if (t.account?.trim()) names.add(t.account.trim());
    return Array.from(names).sort();
  }, [allTrades]);

  const form = useForm<SetupForm>({
    resolver: zodResolver(setupFormSchema) as any,
    defaultValues: {
      symbol: "",
      direction: "long",
      size: "" as any,
      entryPrice: "" as any,
      initialStop: "" as any,
      initialTarget: "" as any,
      entryTime: localNow(),
      notes: "",
      rationale: "",
    },
  });

  const v = form.watch();

  /*
   * Long or short, read off the levels.
   *
   * It is not really a separate decision: a stop under the entry and a target
   * over it IS a long, and there is no other trade those three prices
   * describe. Asking for the direction as well is asking the same question
   * twice, and the second answer is the one that gets left on whatever it
   * happened to default to — which then flips the sign of every R the trade
   * ever reports.
   *
   * Inferred only while the buttons are untouched. The moment somebody picks
   * one they own it, and a form that keeps changing the answer back is a form
   * you cannot use; from then on a disagreement is said out loud instead.
   */
  const [directionPicked, setDirectionPicked] = useState(false);
  const levelRead = useMemo(
    () =>
      readDirection(priceOrNull(v.entryPrice), priceOrNull(v.initialStop), priceOrNull(v.initialTarget)),
    [v.entryPrice, v.initialStop, v.initialTarget],
  );
  useEffect(() => {
    if (directionPicked || !levelRead.implied) return;
    if (form.getValues("direction") === levelRead.implied) return;
    form.setValue("direction", levelRead.implied as any, { shouldValidate: false });
  }, [levelRead.implied, directionPicked, form]);
  const directionMismatch = directionWarning(
    v.direction === "short" ? "short" : "long",
    levelRead,
  );
  const levelConflict = conflictWarning(levelRead);

  /*
   * What one contract of this symbol is worth, resolved exactly as the server
   * will resolve it on save: the table first, then whatever this symbol was
   * worth the last time it was logged. Computing it here rather than guessing
   * is what makes the 1R below match the broker instead of approximating it.
   */
  const remembered = useMemo(
    () => lastPointValueFor(v.symbol, allTrades),
    [v.symbol, allTrades],
  );
  const spec = contractFor(v.symbol);
  /*
   * A contract the table has never heard of — a broker's own nano listing, say
   * — still has a size, and the journal only has to be told it once. This is
   * that once: it appears only for symbols written like a contract (root plus
   * month code) that aren't recognised, pre-filled with whatever this symbol
   * was worth last time, and it is what makes the R on a nano trade real
   * instead of off by a hundredfold.
   */
  const [customMult, setCustomMult] = useState("");
  /*
   * Size leads; risk reads back.
   *
   * The normal way a trade gets logged is contract, entry, stop, size — the
   * numbers the platform already shows — and what the journal owes you in
   * return is what that costs: the dollar risk, the R:R and the exposure,
   * filled in as you type rather than worked out in your head.
   *
   * Risk-drives-size is the exception, not the rule. Typing a dollar figure
   * into the risk box back-solves the position for the rare "I have $300 to
   * lose on this, how many contracts is that" case, and the × puts it back.
   */
  const [sizeMode, setSizeMode] = useState<"auto" | "manual">("manual");
  /** Empty means "risk is whatever the size works out to". */
  const [riskOverride, setRiskOverride] = useState("");
  useEffect(() => {
    setCustomMult(remembered != null ? String(remembered) : "");
  }, [remembered, v.symbol]);
  const needsMultiplier =
    !spec && sizeUnit === "base" &&
    (remembered != null || looksLikeFuturesContract(v.symbol));
  const typedMult = Number(customMult);
  const perContract =
    needsMultiplier && isFinite(typedMult) && typedMult > 0
      ? typedMult
      : pointValueFor(v.symbol, remembered);
  // A recognised futures root is unambiguous — contracts, always.
  const isFutures = Boolean(v.symbol) && perContract !== 1;
  /*
   * Keyed on the resolved instrument rather than the raw string, so it fires
   * when the symbol genuinely changes and not on every keystroke — otherwise
   * it would fight a unit the user had just switched by hand.
   *
   * A recognised contract is bought in contracts. Anything else is assumed to
   * be a crypto asset, which is decided in USD notional; that is both the far
   * commoner case for an unrecognised ticker here and the recoverable one,
   * since the unit sits one click away.
   */
  const instrumentKey = spec?.root ?? (v.symbol?.trim() ? "unknown" : "");
  useEffect(() => {
    if (instrumentKey === "") return;
    setSizeUnit(instrumentKey === "unknown" ? "quote" : "base");
  }, [instrumentKey]);
  const sized = useMemo(
    () =>
      suggestSize({
        symbol: v.symbol ?? "",
        entryPrice: Number(v.entryPrice),
        initialStop: Number(v.initialStop),
        riskDollars: Number(riskOverride),
        sizeUnit,
        pointValue: perContract,
      }),
    [v.symbol, v.entryPrice, v.initialStop, riskOverride, sizeUnit, perContract],
  );

  // Keep the size honest to the risk while risk is driving. Writing only on a
  // real change stops this fighting the field the user is typing in.
  useEffect(() => {
    if (sizeMode !== "auto" || !sized) return;
    if (Number(form.getValues("size")) === sized.size) return;
    form.setValue("size", sized.size as any, { shouldValidate: false });
  }, [sized, sizeMode, form]);

  const preview = useMemo(() => {
    const e = Number(v.entryPrice);
    const s = Number(v.initialStop);
    const t = Number(v.initialTarget);
    const sz = Number(v.size);
    if (![e, s, t].every((x) => isFinite(x) && x !== 0)) return null;
    const risk = Math.abs(e - s);
    const reward = Math.abs(t - e);
    if (!risk) return null;

    // 1R has to agree with the broker, so it needs the same two adjustments the
    // stored trade gets: quote-denominated sizes convert to base units, and
    // futures scale by their contract multiplier. Without the multiplier this
    // read $83 on 2 MNQ where the platform said $165 — and it is shown at
    // exactly the moment the size decision is being made.
    const qty = sizeUnit === "quote" ? (e > 0 ? sz / e : 0) : sz;
    const perPoint = qty * perContract;
    return {
      risk,
      rr: reward / risk,
      riskDollars: isFinite(perPoint) ? risk * perPoint : null,
      // "3 contracts" says nothing about how much Bitcoin that is; this does.
      exposure: fmtExposure(exposureOf(v.symbol, qty, perContract)),
    };
  }, [v.entryPrice, v.initialStop, v.initialTarget, v.size, v.symbol, sizeUnit, perContract]);

  async function handleFile(file: File) {
    const dataUrl = await fileToDownscaledDataUrl(file);
    setImage(dataUrl);
    setParsing(true);
    setParsed(false);
    try {
      /*
       * A single chart is the common paste, so it must cost one call. The setup
       * read runs first and reports whether the image was actually an orders
       * table; only then does the orders read run. Probing for orders first
       * would put the extra call on the common path instead of the rare one.
       */
      const r = await parseScreenshot(dataUrl, "setup");

      if (r.looksLikeOrdersTable) {
        const asOrders = await parseScreenshot(dataUrl, "orders").catch(() => null);
        /*
         * Count trades, not rows. A working-orders table draws ONE bracketed
         * order as three rows — the parent plus its inactive take-profit and
         * stop-loss children — and reading that as a batch of three sent a
         * single trade down the wrong path entirely. The prompt asks the model
         * to collapse them; this drops any it still hands back, so the decision
         * does not rest on the model getting it right.
         */
        const many = dropBracketLegs(
          (asOrders?.orders ?? [])
            .filter((o) => o.entryPrice != null && o.direction)
            .map((o) => ({
              symbol: o.symbol ?? "",
              direction: o.direction as "long" | "short",
              size: o.size,
              sizeUnit: o.sizeUnit === "quote" ? "quote" : "base",
              entryPrice: o.entryPrice as number,
              initialStop: o.initialStop ?? null,
              initialTarget: o.initialTarget ?? null,
              entryTime: o.entryTime ?? null,
              source: "binance-orders" as const,
              raw: "(from screenshot)",
              warnings:
                o.initialStop == null
                  ? ["No stop in the screenshot — add it when it fills."]
                  : [],
            })),
        );
        // Two or more distinct orders is a batch; one is just a trade, and the
        // setup read already in hand describes it better than a re-parse would.
        if (many.length >= 2) {
          onOrdersDetected(many);
          setImage(null);
          setParsing(false);
          return;
        }
      }
      if (r.symbol) form.setValue("symbol", r.symbol);
      if (r.direction) {
        /*
         * A direction read off the chart counts as answered, so the level
         * reader stands down rather than overwriting it a tick later. It is at
         * least as good a source as the levels are — and where the two
         * disagree that is a suspect parse worth a banner, not something to
         * resolve silently in favour of whichever ran last.
         */
        setDirectionPicked(true);
        form.setValue("direction", r.direction);
      }
      if (r.entryPrice != null) form.setValue("entryPrice", r.entryPrice as any);
      if (r.initialStop != null) form.setValue("initialStop", r.initialStop as any);
      if (r.initialTarget != null) form.setValue("initialTarget", r.initialTarget as any);
      if (r.size != null) form.setValue("size", r.size as any);
      if (r.entryTime) {
        const d = new Date(r.entryTime);
        if (!isNaN(d.getTime())) {
          d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
          form.setValue("entryTime", d.toISOString().slice(0, 16));
        }
      }

      const detectedClosed = r.isClosed === true && r.exitPrice != null;
      if (detectedClosed) {
        setClosedMode(true);
        setAutoClosed(true);
        setExitPrice(String(r.exitPrice));
        setExitReason(r.exitReason ?? "other");
        if (r.exitTime) {
          const d = new Date(r.exitTime);
          if (!isNaN(d.getTime())) {
            d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
            setExitTime(d.toISOString().slice(0, 16));
          }
        }
      }

      setParsed(true);
      toast({
        title: detectedClosed ? "Completed trade read" : "Chart read",
        description: detectedClosed
          ? "An exit was visible — this will be logged as a closed trade."
          : "Check the pre-filled numbers, then confirm.",
      });
    } catch (e: any) {
      toast({
        title: "Couldn't read that chart",
        description: "Fill the fields manually — the screenshot is still attached.",
        variant: "destructive",
      });
    } finally {
      setParsing(false);
    }
  }

  // Paste while collapsed: open, then hand the image straight to the parser.
  // The expanded card has its own dropzone listener, so this one stands down
  // the moment the form is open, and never competes with a dialog's.
  useEffect(() => {
    if (expanded) return;
    function onPaste(e: ClipboardEvent) {
      if (document.querySelector('[role="dialog"]')) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          const file = items[i].getAsFile();
          if (!file) return;
          e.preventDefault();
          setExpanded(true);
          handleFile(file);
          return;
        }
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const [analyzingRationale, setAnalyzingRationale] = useState(false);

  const onSubmit = form.handleSubmit(async (values) => {
    const data = setupFormSchema.parse(values);
    let rationaleTags: string[] = [];
    const rationale = data.rationale?.trim() || "";
    if (rationale) {
      setAnalyzingRationale(true);
      rationaleTags = await analyzeRationale(rationale);
      setAnalyzingRationale(false);
    }
    // Chips first, so a setup you tapped deliberately outranks one the parser
    // guessed at; normalising the union means "cc" from the sentence and the
    // "61.8 Fib" chip collapse to one tag instead of two rows in the table.
    rationaleTags = normalizeSetupTags([...setupTags, ...rationaleTags]);
    // A source name typed as a tag is a source, not a setup — same promotion
    // the boot migration did once for history, applied at the door forever,
    // against this journal's own roster of sources.
    const promoted = splitSourceFromTags(rationaleTags, knownSources, source.trim() || null);
    rationaleTags = promoted.tags;
    const finalSource = promoted.source;
    const playbookPayload = {
      setupName: pb.setupName.trim() || undefined,
      stopLogic: pb.stopLogic.trim() || undefined,
      targetLogic: pb.targetLogic.trim() || undefined,
      confidence: pb.confidence ?? undefined,
      standAside: pb.standAside.trim() || undefined,
    };
    const playbookJson = Object.values(playbookPayload).some((v) => v !== undefined)
      ? JSON.stringify(playbookPayload)
      : null;

    // Extra TPs: keep only real prices, in the order they were planned.
    const extras = extraTps.map(Number).filter((x) => isFinite(x) && x > 0);

    const loggingClosed = closedMode && exitPrice !== "" && isFinite(Number(exitPrice));
    if (closedMode && !loggingClosed) {
      toast({ title: "Exit price required", variant: "destructive" });
      return;
    }

    const created = await createTrade.mutateAsync({
      trade: {
        styleId,
        symbol: data.symbol.toUpperCase(),
        direction: data.direction,
        size: data.size,
        sizeUnit,
        // Only sent when the table doesn't know this contract; otherwise the
        // server derives it from the symbol, which is the authority.
        ...(needsMultiplier && isFinite(typedMult) && typedMult > 0
          ? { pointValue: typedMult }
          : {}),
        entryPrice: data.entryPrice,
        initialStop: data.initialStop,
        initialTarget: data.initialTarget,
        extraTargets: extras.length ? JSON.stringify(extras) : null,
        account: account.trim() || null,
        source: finalSource,
        highlights: loggingClosed ? serializeHighlights(highlights) : null,
        entryTime: toIso(data.entryTime),
        // Screenshots are parsed, not kept. A base64 chart is ~300x the size of
        // the trade record it produces, and chart replay lives in Tradesly /
        // Edgewonk. The column stays nullable so this can be revisited.
        setupScreenshot: null,
        notes: data.notes || null,
        rationale: rationale || null,
        rationaleTags: rationaleTags.length ? JSON.stringify(rationaleTags) : null,
        playbook: playbookJson,
        ...(loggingClosed
          ? {
              status: "closed" as const,
              exitPrice: Number(exitPrice),
              exitTime: toIso(exitTime),
              exitReason: (exitReason as any) ?? "other",
              mae: mae.trim() && isFinite(Number(mae)) ? Number(mae) : null,
              mfe: mfe.trim() && isFinite(Number(mfe)) ? Number(mfe) : null,
              postExitPeak:
                postExitPeak.trim() && isFinite(Number(postExitPeak)) ? Number(postExitPeak) : null,
              noManagementOutcome: (nmo as any) ?? null,
              fees: fees.trim() && isFinite(Number(fees)) ? Number(fees) : null,
              entryGrade: grades.entry as any,
              stopGrade: grades.stop as any,
              exitGrade: grades.exit as any,
            }
          : { status: lifecycle === "pending" ? ("pending" as const) : ("open" as const) }),
      },
      mistakeTagIds: loggingClosed ? selectedDemons : [],
    });

    // Keep the parsed chart as the trade's setup screenshot — archival
    // quality, lazy-loaded, never in the list payload. Best-effort: a failed
    // attach must not un-save the trade.
    if (image && created?.id) {
      archiveDataUrl(image)
        .then((data) => addImage.mutate({ tradeId: created.id, kind: "setup", data }))
        .catch(() => {});
    }
    toast(
      loggingClosed
        ? {
            title: "Closed trade logged",
            description: `${data.symbol.toUpperCase()} recorded end-to-end.`,
          }
        : lifecycle === "pending"
          ? { title: "Order placed", description: `${data.symbol.toUpperCase()} waiting for a fill.` }
          : { title: "Trade open", description: `${data.symbol.toUpperCase()} logged.` },
    );
    if (created?.id) onCreated?.(created.id);
    setLifecycle("open");
    setAutoClosed(false);
    setExitPrice("");
    setExitTime(localNow());
    setExitReason(null);
    setGrades(EMPTY_GRADES);
    setSelectedDemons([]);
    setHighlights([]);
    setMae("");
    setMfe("");
    setPostExitPeak("");
    setPostExitAdverse("");
    setNmo(null);
    setFees("");
    setSetupTags([]);
    setPickedStyleId(null);
    setExtraTps([]);
    // The account survives the reset on purpose — next trade, same account.
    store.set(ACCOUNT_KEY, account.trim());
    setPb({ setupName: "", stopLogic: "", targetLogic: "", confidence: null, standAside: "" });
    // A new trade is a new blank. Left set, one manual pick would switch the
    // inference off for every trade logged afterwards in the same session.
    setDirectionPicked(false);
    form.reset({
      symbol: "",
      direction: "long",
      size: "" as any,
      entryPrice: "" as any,
      initialStop: "" as any,
      initialTarget: "" as any,
      entryTime: localNow(),
      notes: "",
      rationale: "",
    });
    setImage(null);
    setParsed(false);
  });

  /** A price field that says what KIND of price it is, in colour and mark. */
  const levelField = (name: keyof SetupForm, kind: LevelKind, label?: string) => (
    <FormField
      control={form.control}
      name={name as any}
      render={({ field }) => (
        <FormItem className="space-y-1">
          <LevelLabel kind={kind} text={label} />
          <FormControl>
            <Input
              {...field}
              type="number"
              step="any"
              inputMode="decimal"
              className="h-9 font-mono text-sm"
              data-testid={`input-${String(name)}`}
              value={(field.value as any) ?? ""}
            />
          </FormControl>
          <FormMessage className="text-[10px]" />
        </FormItem>
      )}
    />
  );

  const numField = (
    name: keyof SetupForm,
    label: string,
    step = "any",
    testId?: string,
  ) => (
    <FormField
      control={form.control}
      name={name as any}
      render={({ field }) => (
        <FormItem className="space-y-1">
          <FormLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {label}
          </FormLabel>
          <FormControl>
            <Input
              {...field}
              type="number"
              step={step}
              inputMode="decimal"
              className="h-9 font-mono text-sm"
              data-testid={testId ?? `input-${String(name)}`}
              value={(field.value as any) ?? ""}
            />
          </FormControl>
          <FormMessage className="text-[10px]" />
        </FormItem>
      )}
    />
  );

  return (
    /* min-w-0 is load-bearing. Inside the trade dialog this card is a grid
       item, and a grid item's automatic minimum is its content width — the
       three state pills in one unwrappable row were 371px of min-content,
       which widened the whole dialog past a 390px phone and dragged every
       field in it off the right edge. */
    <Card className="min-w-0 border-card-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="group flex min-w-0 items-center gap-2 text-left"
          data-testid="button-toggle-entry"
        >
          <Sparkles className="h-4 w-4 shrink-0 text-primary" />
          <h2 className="text-sm font-semibold tracking-tight">Log a setup</h2>
          {!expanded && (
            <span className="truncate text-[11px] text-muted-foreground">
              click, or paste a chart
            </span>
          )}
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
              expanded ? "" : "-rotate-90"
            }`}
          />
        </button>
        {!expanded && (
          <kbd className="hidden shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:block">
            ⌘V
          </kbd>
        )}
        <div className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 ${expanded ? "" : "hidden"}`}>
          {parsed && (
            <Badge variant="secondary" className="text-[10px]" data-testid="badge-ai-prefill">
              AI pre-filled · verify
            </Badge>
          )}
          {/* The three states a trade can be logged in. A resting order and a
              trade you are recording after the fact are both real things to
              write down, and neither was reachable before: everything was
              born open, so a pending order had to be logged as live and a
              finished trade had to be created and then closed as two acts. */}
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
              onClick={() => {
                setLifecycle(id);
                setAutoClosed(false);
              }}
              data-testid={`button-lifecycle-${id}`}
              aria-pressed={lifecycle === id}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </Button>
          ))}
        </div>
      </div>

      {expanded && (
      <>
      <div className="mt-3" />
      <Dropzone
        testId="dropzone-setup"
        label="Drop entry screenshot"
        hint="Chart with entry, stop and target — parsed automatically. Optional."
        image={image}
        busy={parsing}
        onFile={handleFile}
        onClear={() => {
          setImage(null);
          setParsed(false);
        }}
      />

      <Form {...form}>
        <form
          onSubmit={onSubmit}
          /*
           * Enter does not log the trade.
           *
           * A <form> submits implicitly when Enter is pressed in any input,
           * and typing a number then pressing Enter is what everyone does.
           * The result was a trade created mid-edit, with whatever was filled
           * in so far and the state picker still on its default of "open" —
           * "it just went open without me clicking the button". Logging a
           * trade is a decision, and it takes pressing the button that says
           * so. A textarea needs Enter for its own reasons and never submits
           * implicitly anyway; Enter while the submit button itself has focus
           * IS pressing it.
           */
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const el = e.target as HTMLElement | null;
            const tag = el?.tagName;
            if (tag === "TEXTAREA" || tag === "BUTTON") return;
            e.preventDefault();
          }}
          className="mt-4 space-y-4"
        >
          <FormField
            control={form.control}
            name="rationale"
            render={({ field }) => (
              <FormItem className="space-y-1">
                <FormLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Quick rationale
                </FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    placeholder="vah, 786 retest, bla bla…"
                    className="h-9 text-sm"
                    data-testid="input-rationale"
                  />
                </FormControl>
                <p className="text-[10px] leading-snug text-muted-foreground">
                  Type it however you'd say it — tags get pulled out automatically on save.
                </p>
                <SetupTagPicker
                  selected={setupTags}
                  onToggle={(name) =>
                    setSetupTags((cur) =>
                      cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name],
                    )
                  }
                  testIdPrefix="new-setup"
                />
              </FormItem>
            )}
          />

          {/* Optional playbook / edge checklist — collapsed by default so a
              trade can still be logged in seconds. */}
          <div>
            <button
              type="button"
              onClick={() => setShowPlaybook((s) => !s)}
              className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              data-testid="button-toggle-playbook"
              aria-expanded={showPlaybook}
            >
              <ClipboardList className="h-3.5 w-3.5" />
              Playbook · optional
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${showPlaybook ? "rotate-180" : ""}`}
              />
            </button>

            {showPlaybook && (
              <div
                className="mt-2 space-y-3 rounded-lg border border-border/60 bg-secondary/20 p-3"
                data-testid="section-playbook"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Trigger / setup name
                    </label>
                    <Input
                      list="playbook-setups"
                      value={pb.setupName}
                      onChange={(e) => setPb((p) => ({ ...p, setupName: e.target.value }))}
                      placeholder="e.g. VAH rejection"
                      className="h-9 text-sm"
                      data-testid="input-playbook-setup"
                    />
                    <datalist id="playbook-setups">
                      {knownSetups.map((s) => (
                        <option key={s} value={s} />
                      ))}
                    </datalist>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Stop-placement logic
                    </label>
                    <Input
                      value={pb.stopLogic}
                      onChange={(e) => setPb((p) => ({ ...p, stopLogic: e.target.value }))}
                      placeholder="e.g. above the swing high"
                      className="h-9 text-sm"
                      data-testid="input-playbook-stop"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Target logic
                    </label>
                    <Input
                      value={pb.targetLogic}
                      onChange={(e) => setPb((p) => ({ ...p, targetLogic: e.target.value }))}
                      placeholder="e.g. prior day VAL"
                      className="h-9 text-sm"
                      data-testid="input-playbook-target"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Stand-aside condition
                    </label>
                    <Input
                      value={pb.standAside}
                      onChange={(e) => setPb((p) => ({ ...p, standAside: e.target.value }))}
                      placeholder="e.g. skip if CPI within 15m"
                      className="h-9 text-sm"
                      data-testid="input-playbook-stand-aside"
                    />
                  </div>
                </div>

                <div>
                  <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Confidence
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Button
                        key={n}
                        type="button"
                        size="sm"
                        variant={pb.confidence === n ? "default" : "outline"}
                        className="h-8 w-9 p-0 font-mono text-[11px]"
                        onClick={() =>
                          setPb((p) => ({ ...p, confidence: p.confidence === n ? null : n }))
                        }
                        data-testid={`button-playbook-confidence-${n}`}
                      >
                        {n}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {styles.length > 0 && (
            <div className="space-y-1" data-testid="section-style-picker">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Style
              </p>
              <div className="flex flex-wrap gap-1.5">
                {styles.map((s) => {
                  const on = s.id === styleId;
                  const c = styleColor(s.color);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setPickedStyleId(s.id)}
                      data-testid={`chip-style-${s.id}`}
                      aria-pressed={on}
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
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-4">
            <div className="space-y-1" data-testid="section-account-picker">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Account
              </p>
              <AccountPicker value={account} onChange={setAccount} known={knownAccounts} />
            </div>
            <div className="space-y-1" data-testid="section-source-picker">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Source
              </p>
              <AccountPicker
                value={source}
                onChange={setSource}
                known={knownSources}
                testIdPrefix="source"
                placeholder="e.g. Daniel, Severin, CBS, UB"
                emptyLabel="My own idea"
                newLabel="+ New source…"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <FormField
              control={form.control}
              name="symbol"
              render={({ field }) => (
                <FormItem className="space-y-1">
                  <FormLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Symbol
                  </FormLabel>
                  <FormControl>
                    <SymbolPicker
                      value={(field.value as string) ?? ""}
                      onChange={field.onChange}
                      trades={allTrades}
                      onBlur={field.onBlur}
                      name={field.name}
                      placeholder="NQ, MBTZ6, SOL…"
                      className="h-9 font-mono text-sm uppercase"
                    />
                  </FormControl>
                  <FormMessage className="text-[10px]" />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="direction"
              render={({ field }) => (
                <FormItem className="min-w-0 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <FormLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Direction
                    </FormLabel>
                    {/* Says WHY the buttons moved on their own. A control that
                        changes without being touched and does not account for
                        itself reads as a glitch, and the trader stops trusting
                        the one field whose sign flips every R in the trade. */}
                    {!directionPicked && levelRead.implied && (
                      <span
                        className="text-[9px] uppercase tracking-wider text-muted-foreground/70"
                        title={`Read from your ${levelRead.from.join(" and ")}`}
                        data-testid="text-direction-auto"
                      >
                        from your {levelRead.from.join(" + ")}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1.5">
                    {(["long", "short"] as const).map((d) => (
                      <Button
                        key={d}
                        type="button"
                        size="sm"
                        variant={field.value === d ? "default" : "outline"}
                        className={`h-9 min-w-0 flex-1 gap-1 px-1.5 text-xs capitalize ${
                          field.value === d
                            ? d === "long"
                              ? "bg-emerald-600 text-white hover:bg-emerald-600/90"
                              : "bg-primary text-primary-foreground"
                            : ""
                        }`}
                        onClick={() => {
                          setDirectionPicked(true);
                          field.onChange(d);
                        }}
                        data-testid={`button-direction-${d}`}
                      >
                        {d === "long" ? (
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        ) : (
                          <ArrowDownRight className="h-3.5 w-3.5" />
                        )}
                        {d}
                      </Button>
                    ))}
                  </div>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name={"size" as any}
              render={({ field }) => (
                <FormItem className="space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <FormLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Size
                      </FormLabel>
                      {sizeMode === "auto" && Number(riskOverride) > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setSizeMode("manual");
                            setRiskOverride("");
                          }}
                          data-testid="button-size-mode"
                          title="Size is being solved from the risk you typed. Click to set it by hand again."
                          className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] text-primary transition-colors"
                        >
                          from ${riskOverride} risk
                        </button>
                      )}
                    </div>
                    <div className="flex gap-0.5">
                      {(["base", "quote"] as const).map((u) => {
                        // A futures contract has no notional sizing — you buy
                        // 2 contracts, never "$2 of MNQ". Offering it produced
                        // a real but meaningless 1R of $0.
                        const disabled = u === "quote" && isFutures;
                        return (
                          <button
                            key={u}
                            type="button"
                            disabled={disabled}
                            title={
                              disabled ? "Futures are sized in contracts" : undefined
                            }
                            onClick={() => !disabled && setSizeUnit(u)}
                            data-testid={`button-size-unit-${u}`}
                            className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider transition-colors ${
                              disabled
                                ? "cursor-not-allowed text-muted-foreground/30"
                                : sizeUnit === u
                                  ? "bg-primary/15 text-primary"
                                  : "text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            {u === "base" ? "contracts" : "usd"}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <FormControl>
                    <Input
                      {...field}
                      onChange={(e) => {
                        // Touching the field is the clearest possible statement
                        // that this position is fixed and the risk is whatever
                        // it works out to be.
                        setSizeMode("manual");
                        field.onChange(e);
                      }}
                      type="number"
                      step="any"
                      inputMode="decimal"
                      className="h-9 font-mono text-sm"
                      data-testid="input-size"
                    />
                  </FormControl>
                  <FormMessage className="text-[10px]" />
                </FormItem>
              )}
            />
            {needsMultiplier && (
              <div className="space-y-1" data-testid="field-contract-multiplier">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Contract size
                </label>
                <Input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={customMult}
                  onChange={(e) => setCustomMult(e.target.value)}
                  placeholder="0.01"
                  className="h-9 font-mono text-sm"
                  data-testid="input-contract-multiplier"
                />
                <p className="text-[10px] leading-snug text-muted-foreground">
                  What one contract holds — 0.01 for a nano Bitcoin. Saved with the trade
                  and reused for this symbol from now on.
                </p>
              </div>
            )}
            {levelField("entryPrice", "entry")}
            {levelField("initialStop", "stop")}

            {/* First target plus optional extra TPs. TP1 stays the target the
                R:R math runs on; the extras are the levels the partials are
                planned at, so they read TP2/TP3 the way a bracket order does. */}
            <FormField
              control={form.control}
              name="initialTarget"
              render={({ field }) => (
                <FormItem className="space-y-1">
                  <LevelLabel kind="target" text={extraTps.length > 0 ? "TP1" : "Target"}>
                    {extraTps.length < 3 && (
                      <button
                        type="button"
                        onClick={() => setExtraTps((x) => [...x, ""])}
                        title="Add another take-profit level"
                        data-testid="button-add-tp"
                        className="rounded px-1 text-[11px] leading-none text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                      >
                        +
                      </button>
                    )}
                  </LevelLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="number"
                      step="any"
                      inputMode="decimal"
                      className="h-9 font-mono text-sm"
                      data-testid="input-initialTarget"
                      value={(field.value as any) ?? ""}
                    />
                  </FormControl>
                  <FormMessage className="text-[10px]" />
                </FormItem>
              )}
            />
            {extraTps.map((tp, i) => (
              <div key={i} className="space-y-1">
                <LevelLabel kind="tp" text={`TP${i + 2}`}>
                  <button
                    type="button"
                    onClick={() => setExtraTps((x) => x.filter((_, j) => j !== i))}
                    title="Remove this level"
                    data-testid={`button-remove-tp-${i}`}
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
                  data-testid={`input-extra-tp-${i}`}
                />
              </div>
            ))}

            {/* The plan, to scale, the moment there is a plan to draw. Two
                prices are two numbers to subtract; a risk leg nearly as long
                as the reward leg is a trade you want to notice BEFORE you take
                it rather than in the review afterwards. */}
            <div className="col-span-2">
              <LevelLadder
                direction={v.direction}
                entry={priceOrNull(v.entryPrice)}
                stop={priceOrNull(v.initialStop)}
                target={priceOrNull(v.initialTarget)}
                extraTps={extraTps.map((t) => priceOrNull(t))}
              />
            </div>

            {/* What this position costs, filled in from what you typed. The
                box is editable, and typing in it flips the arithmetic round to
                solve for size instead — the exception, for when the budget is
                the fixed thing rather than the position. */}
            <div className="col-span-2 flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-secondary/20 px-2.5 py-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Risk $
              </span>
              <div className="relative">
                <Input
                  value={
                    riskOverride !== ""
                      ? riskOverride
                      : preview?.riskDollars != null
                        ? String(Math.round(preview.riskDollars))
                        : ""
                  }
                  onChange={(e) => {
                    setRiskOverride(e.target.value);
                    setSizeMode(e.target.value.trim() === "" ? "manual" : "auto");
                    if (e.target.value.trim() !== "") {
                      store.set(RISK_BUDGET_KEY, e.target.value);
                    }
                  }}
                  placeholder={store.get(RISK_BUDGET_KEY) ?? "300"}
                  inputMode="decimal"
                  className={`h-7 w-24 font-mono text-[11px] ${
                    riskOverride !== "" ? "border-primary/50 text-primary" : ""
                  }`}
                  data-testid="input-risk-budget"
                />
                {riskOverride !== "" && (
                  <button
                    type="button"
                    onClick={() => {
                      setRiskOverride("");
                      setSizeMode("manual");
                    }}
                    aria-label="Back to reading the risk off the size"
                    data-testid="button-clear-risk-override"
                    className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 text-[11px] leading-none text-muted-foreground hover:text-foreground"
                  >
                    ×
                  </button>
                )}
              </div>

              {sizeMode === "auto" && sized ? (
                <span
                  className="font-mono text-[11px] text-muted-foreground"
                  data-testid="text-sized-from-risk"
                >
                  &rarr;{" "}
                  <span className="text-foreground">
                    {sized.sizeUnit === "base"
                      ? `${sized.size} ${sized.size === 1 ? "contract" : "contracts"}`
                      : `$${sized.size.toLocaleString()}`}
                  </span>
                  {sized.sizeUnit === "base" && sized.size > 0 && (
                    <> · risks ${Math.round(sized.actualRiskDollars)}</>
                  )}
                </span>
              ) : preview ? (
                <span
                  className="font-mono text-[11px] text-muted-foreground"
                  data-testid="text-derived-risk"
                >
                  R:R{" "}
                  <span className={preview.rr >= 2 ? "text-emerald-400" : "text-foreground"}>
                    {num(preview.rr, 1)}
                  </span>
                  {preview.exposure && <> · {preview.exposure}</>}
                  {spec && <> · {spec.label}</>}
                </span>
              ) : (
                <span className="text-[10px] text-muted-foreground">
                  fills in from the contract, entry, stop and size
                </span>
              )}

              {sizeMode === "auto" && sized?.sizeUnit === "base" && sized.size === 0 && (
                <span className="text-[10px] text-amber-500" data-testid="text-stop-too-far">
                  stop too far for this budget — even 1 contract risks $
                  {Math.round(sized.perUnitRisk)}
                </span>
              )}
            </div>

            <FormField
              control={form.control}
              name="entryTime"
              render={({ field }) => (
                <FormItem className="col-span-2 space-y-1">
                  <FormLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Entry time
                  </FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="datetime-local"
                      className="h-9 font-mono text-xs"
                      data-testid="input-entry-time"
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            {/*
                The levels and the direction disagreeing.

                Two different faults with two different sentences, because the
                advice differs. A stated direction against one readable level
                is "your stop is on the wrong side" — actionable. Both levels
                on the same side of the entry is "one of these three prices is
                a typo", and nothing here can say which, so pointing at the
                stop would be a confident wrong answer.

                This is the one field whose sign flips every R the trade will
                ever report, and getting it wrong does not look wrong on the
                row — it looks like a different trade that happened to you.
            */}
            {(levelConflict || directionMismatch) && (
              <div
                className="col-span-2 flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-[11px] leading-snug text-amber-500"
                data-testid="warning-direction"
              >
                <Ban className="mt-px h-3 w-3 shrink-0" />
                <span>{levelConflict ?? directionMismatch}</span>
              </div>
            )}

            {/* The hour-of-day stats prove where the money leaks; the window
                turns that into a nudge at the moment of the decision. A
                warning, not a lock: outside-hours trades exist, but they
                should never happen absent-mindedly. */}
          {(() => {
              const style = styles.find((s) => s.id === styleId);
              if (!style) return null;
              const when = v.entryTime ? new Date(v.entryTime) : new Date();
              const inside = inSessionWindow(when, style.sessionStart, style.sessionEnd);
              if (inside !== false) return null;
              return (
                <div
                  className="col-span-2 flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-500"
                  data-testid="warning-session-window"
                >
                  <Clock3 className="h-3 w-3 shrink-0" />
                  Outside the {style.name} window (
                  {windowLabel(style.sessionStart, style.sessionEnd)}). Your best trades in this
                  book happen inside it — is this one planned, or just there?
                </div>
              );
            })()}
          </div>

          {closedMode && (
            /* A strip, not a box. The three questions below are boxes of
               their own now, and a box around three boxes reads as a nesting
               level that means nothing — the emerald line still says which
               mode you are in, which is all it was ever saying. */
            <div className="space-y-3" data-testid="section-exit-fields">
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                <p className="text-[11px] font-semibold text-emerald-400">
                  {autoClosed
                    ? "Exit detected in the screenshot — logging as a closed trade"
                    : "Logging a completed trade"}
                </p>
              </div>

              {/* The same questions, in the same order, as closing a trade
                  that was already open — because they are the same act. */}
              <TradeOutcomeFields
                exitPrice={exitPrice}
                setExitPrice={setExitPrice}
                exitTime={exitTime}
                setExitTime={setExitTime}
                exitReason={exitReason}
                setExitReason={setExitReason}
                mae={mae}
                setMae={setMae}
                mfe={mfe}
                setMfe={setMfe}
                postExitPeak={postExitPeak}
                postExitAdverse={postExitAdverse}
                setPostExitAdverse={setPostExitAdverse}
                setPostExitPeak={setPostExitPeak}
                nmo={nmo}
                setNmo={setNmo}
                fees={fees}
                setFees={setFees}
                grades={grades}
                setGrades={setGrades}
                demons={demons}
                demonIds={selectedDemons}
                setDemonIds={setSelectedDemons}
                highlights={highlights}
                setHighlights={setHighlights}
                extraHighlights={knownHighlights(allTrades)}
                testPrefix="new"
                timing={{
                  direction: v.direction === "short" ? "short" : "long",
                  entryPrice: isFinite(Number(v.entryPrice)) ? Number(v.entryPrice) : null,
                  initialStop: isFinite(Number(v.initialStop)) ? Number(v.initialStop) : null,
                }}
              />
            </div>
          )}

          {/* What THIS entry will earn, lighting up as the fields fill. The
              reward is visible before the act completes — the goal-gradient
              effect — and it doubles as a definition of "complete entry" that
              never needs a manual. All process; none of it reads the P&L. */}
          {(() => {
            const hasNum = (x: unknown) => x !== "" && isFinite(Number(x));
            const parts = [
              { label: "the why", pts: 10, on: Boolean(v.rationale?.trim()) },
              { label: "stop + target", pts: 5, on: hasNum(v.initialStop) && hasNum(v.initialTarget) },
              { label: "chart", pts: 5, on: Boolean(image) },
              ...(closedMode
                ? [
                    { label: "named exit", pts: 10, on: Boolean(exitReason) },
                    {
                      label: "clean — no demons",
                      pts: 5,
                      on: Boolean(exitReason) && selectedDemons.length === 0,
                    },
                  ]
                : []),
            ];
            const earned = parts.filter((p) => p.on).reduce((a, p) => a + p.pts, 0);
            return (
              <div
                className="flex flex-wrap items-center gap-1.5"
                data-testid="meter-entry-xp"
              >
                <span className="font-mono text-[10px] text-muted-foreground">
                  This entry: <span className="font-semibold text-foreground">+{earned} XP</span>
                </span>
                {parts.map((part) => (
                  <span
                    key={part.label}
                    className={`rounded-full border px-1.5 py-0.5 text-[9px] transition-colors duration-300 ${
                      part.on
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border/60 text-muted-foreground/50"
                    }`}
                    data-testid={`xp-part-${part.label.split(" ")[0]}`}
                  >
                    {part.on ? "✓ " : ""}
                    {part.label} +{part.pts}
                  </span>
                ))}
              </div>
            );
          })()}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              className="h-9 flex-1 min-w-[9rem] text-xs font-semibold"
              disabled={createTrade.isPending || analyzingRationale || guard.locked}
              data-testid="button-save-trade"
            >
              {(createTrade.isPending || analyzingRationale) && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              {/* The button says what it will actually do, because the three
                  lifecycles produce three different records. */}
              {guard.locked
                ? "Locked — acknowledge the demon"
                : lifecycle === "closed"
                  ? "Log closed trade"
                  : lifecycle === "pending"
                    ? "Place order"
                    : "Open trade"}
            </Button>
            {preview && (
              <div
                className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground"
                data-testid="text-risk-preview"
              >
                <span>
                  Risk <span className="text-foreground">{num(preview.risk)}</span>
                </span>
                <span>
                  R:R{" "}
                  <span className={preview.rr >= 2 ? "text-emerald-400" : "text-foreground"}>
                    {num(preview.rr, 1)}
                  </span>
                </span>
                {preview.riskDollars != null && (
                  <span>
                    1R <span className="text-foreground">${num(preview.riskDollars, 0)}</span>
                  </span>
                )}
                {preview.exposure && (
                  <span
                    data-testid="text-exposure"
                    title={
                      spec
                        ? `${spec.label} — ${spec.pointValue} ${spec.unit} per contract`
                        : `${perContract} per contract, remembered from your last ${v.symbol} trade`
                    }
                  >
                    = <span className="text-foreground">{preview.exposure}</span>
                  </span>
                )}
              </div>
            )}
          </div>

          {guard.locked && guard.demon && (
            <p
              className="flex items-start gap-1.5 rounded-md border border-destructive/50 bg-destructive/10 px-2.5 py-2 text-[11px] font-semibold leading-snug text-destructive"
              data-testid="text-new-trade-locked"
            >
              <Ban className="mt-px h-3.5 w-3.5 shrink-0" />
              New {styleName(styles, styleId)} entries are blocked: “{guard.demon.name}” has
              hit {guard.demon.currentStreak} trades in a row in this style. Acknowledge it on
              the guard card above to unlock — your other styles are unaffected.
            </p>
          )}
        </form>
      </Form>
      </>
      )}
    </Card>
  );
}

