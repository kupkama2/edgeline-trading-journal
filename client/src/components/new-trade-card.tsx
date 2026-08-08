/**
 * The entry card: log a setup by hand or drop a chart and confirm the numbers.
 */
import { useEffect, useMemo, useState } from "react";
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
import { pointValueFor } from "@shared/symbols";
import { dropBracketLegs, type ImportCandidate } from "@shared/import-parse";
import { Dropzone, EXIT_REASONS, RationaleTags, localNow, num, parseTags, toIso } from "@/components/trade-shared";
import { AccountPicker, HighlightPicker } from "@/components/trade-pickers";
import { knownHighlights, serializeHighlights } from "@shared/highlights";
import { suggestSize } from "@shared/sizing";
import { inSessionWindow, windowLabel } from "@shared/session";

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

export function NewTradeCard({
  onOrdersDetected,
}: {
  onOrdersDetected: (rows: ImportCandidate[]) => void;
}) {
  const { toast } = useToast();
  const createTrade = useCreateTrade();
  const addImage = useAddTradeImage();
  const [image, setImage] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(false);

  /* One-step closed-trade logging: when the screenshot already shows an exit
     (or the user flips the toggle) we skip CloseTradeDialog entirely and write
     the trade straight to the log with status="closed". */
  const [closedMode, setClosedMode] = useState(false);
  const [autoClosed, setAutoClosed] = useState(false);
  const [exitPrice, setExitPrice] = useState("");
  const [exitTime, setExitTime] = useState(localNow());
  const [exitReason, setExitReason] = useState<string | null>(null);
  const [selectedDemons, setSelectedDemons] = useState<number[]>([]);
  const [highlights, setHighlights] = useState<string[]>([]);
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
    () => localStorage.getItem(RISK_BUDGET_KEY) ?? "",
  );
  // Planned scale-out levels beyond the first target. Most trades have one
  // TP, so this starts empty and only the "+" reveals more rows.
  const [extraTps, setExtraTps] = useState<string[]>([]);
  // Which account the trade runs in. Sticky like the risk budget — you trade
  // the same account all session, so it should not need re-picking per trade.
  const [account, setAccount] = useState<string>(
    () => localStorage.getItem(ACCOUNT_KEY) ?? "",
  );
  // Every account name already on a trade, so picking stays one click and one
  // spelling. Free text underneath it all: no accounts table to administer.
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

  // A recognised futures root is unambiguous — contracts, always.
  const isFutures = Boolean(v.symbol) && pointValueFor(v.symbol) !== 1;
  useEffect(() => {
    if (isFutures) setSizeUnit("base");
  }, [isFutures]);
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
    const perPoint = qty * pointValueFor(v.symbol);
    return {
      risk,
      rr: reward / risk,
      riskDollars: isFinite(perPoint) ? risk * perPoint : null,
    };
  }, [v.entryPrice, v.initialStop, v.initialTarget, v.size, v.symbol, sizeUnit]);

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
      if (r.direction) form.setValue("direction", r.direction);
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
        entryPrice: data.entryPrice,
        initialStop: data.initialStop,
        initialTarget: data.initialTarget,
        extraTargets: extras.length ? JSON.stringify(extras) : null,
        account: account.trim() || null,
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
            }
          : { status: "open" as const }),
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
        : { title: "Trade open", description: `${data.symbol.toUpperCase()} logged.` },
    );
    setClosedMode(false);
    setAutoClosed(false);
    setExitPrice("");
    setExitTime(localNow());
    setExitReason(null);
    setSelectedDemons([]);
    setHighlights([]);
    setPickedStyleId(null);
    setExtraTps([]);
    // The account survives the reset on purpose — next trade, same account.
    localStorage.setItem(ACCOUNT_KEY, account.trim());
    setPb({ setupName: "", stopLogic: "", targetLogic: "", confidence: null, standAside: "" });
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
    <Card className="border-card-border bg-card p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold tracking-tight">Log a setup</h2>
        </div>
        <div className="flex items-center gap-2">
          {parsed && (
            <Badge variant="secondary" className="text-[10px]" data-testid="badge-ai-prefill">
              AI pre-filled · verify
            </Badge>
          )}
          <Button
            type="button"
            size="sm"
            variant={closedMode ? "default" : "outline"}
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={() => {
              setClosedMode((c) => !c);
              setAutoClosed(false);
            }}
            data-testid="button-toggle-closed"
            aria-pressed={closedMode}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Already closed
          </Button>
        </div>
      </div>

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
        <form onSubmit={onSubmit} className="mt-4 space-y-4">
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

          <div className="space-y-1" data-testid="section-account-picker">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Account
            </p>
            <AccountPicker value={account} onChange={setAccount} known={knownAccounts} />
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
                    <Input
                      {...field}
                      placeholder="NQ"
                      className="h-9 font-mono text-sm uppercase"
                      data-testid="input-symbol"
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
                  <FormLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Direction
                  </FormLabel>
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
                        onClick={() => field.onChange(d)}
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
                    <FormLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Size
                    </FormLabel>
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
                      type="number"
                      step="any"
                      inputMode="decimal"
                      className="h-9 font-mono text-sm"
                    />
                  </FormControl>
                  <FormMessage className="text-[10px]" />
                </FormItem>
              )}
            />
            {numField("entryPrice", "Entry")}
            {numField("initialStop", "Stop")}

            {/* First target plus optional extra TPs. TP1 stays the target the
                R:R math runs on; the extras are the levels the partials are
                planned at, so they read TP2/TP3 the way a bracket order does. */}
            <FormField
              control={form.control}
              name="initialTarget"
              render={({ field }) => (
                <FormItem className="space-y-1">
                  <div className="flex items-center justify-between">
                    <FormLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {extraTps.length > 0 ? "TP1" : "Target"}
                    </FormLabel>
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
                  </div>
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
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    TP{i + 2}
                  </label>
                  <button
                    type="button"
                    onClick={() => setExtraTps((x) => x.filter((_, j) => j !== i))}
                    title="Remove this level"
                    data-testid={`button-remove-tp-${i}`}
                    className="rounded px-1 text-[11px] leading-none text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    ×
                  </button>
                </div>
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

            {/* Size from risk: type what the idea may cost, get the size that
                costs exactly that. Same arithmetic as the metrics engine, so
                the suggested size produces the promised 1R to the cent. */}
            {(() => {
              const s = suggestSize({
                symbol: v.symbol ?? "",
                entryPrice: Number(v.entryPrice),
                initialStop: Number(v.initialStop),
                riskDollars: Number(riskBudget),
                sizeUnit,
              });
              return (
                <div className="col-span-2 flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-secondary/20 px-2.5 py-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Risk $
                  </span>
                  <Input
                    value={riskBudget}
                    onChange={(e) => {
                      setRiskBudget(e.target.value);
                      localStorage.setItem(RISK_BUDGET_KEY, e.target.value);
                    }}
                    placeholder="300"
                    inputMode="decimal"
                    className="h-7 w-20 font-mono text-[11px]"
                    data-testid="input-risk-budget"
                  />
                  {s ? (
                    <button
                      type="button"
                      onClick={() => form.setValue("size", s.size as any)}
                      className="rounded bg-primary/10 px-2 py-1 font-mono text-[11px] text-primary transition-colors hover:bg-primary/20"
                      data-testid="button-apply-size"
                      title="Apply this size"
                    >
                      →{" "}
                      {s.sizeUnit === "base"
                        ? `${s.size} ${s.size === 1 ? "contract" : "contracts"}`
                        : `$${s.size.toLocaleString()}`}
                      {s.sizeUnit === "base" && s.size > 0 && (
                        <span className="ml-1 text-muted-foreground">
                          (risks ${Math.round(s.actualRiskDollars)})
                        </span>
                      )}
                    </button>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">
                      needs entry, stop and a risk amount
                    </span>
                  )}
                  {s?.sizeUnit === "base" && s.size === 0 && (
                    <span className="text-[10px] text-amber-500">
                      stop too far for this budget — even 1 contract risks $
                      {Math.round(s.perUnitRisk)}
                    </span>
                  )}
                </div>
              );
            })()}

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
            <div
              className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3"
              data-testid="section-exit-fields"
            >
              <div className="flex flex-wrap items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                <p className="text-[11px] font-semibold text-emerald-400">
                  {autoClosed
                    ? "Exit detected in the screenshot — logging as a closed trade"
                    : "Logging a completed trade"}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Exit price
                  </label>
                  <Input
                    type="number"
                    step="any"
                    inputMode="decimal"
                    value={exitPrice}
                    onChange={(e) => setExitPrice(e.target.value)}
                    className="h-9 font-mono text-sm"
                    data-testid="input-new-exit-price"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Exit time
                  </label>
                  <Input
                    type="datetime-local"
                    value={exitTime}
                    onChange={(e) => setExitTime(e.target.value)}
                    className="h-9 font-mono text-xs"
                    data-testid="input-new-exit-time"
                  />
                </div>
              </div>

              <div>
                <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  How did it end?
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {EXIT_REASONS.map((r) => (
                    <Button
                      key={r}
                      type="button"
                      size="sm"
                      variant={exitReason === r ? "default" : "outline"}
                      className="h-8 text-[11px]"
                      onClick={() => setExitReason(exitReason === r ? null : r)}
                      data-testid={`button-new-exit-${r}`}
                    >
                      {EXIT_REASON_LABELS[r]}
                    </Button>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Demons on this trade
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {demons.map((d) => {
                    const on = selectedDemons.includes(d.id);
                    return (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() =>
                          setSelectedDemons((s) =>
                            on ? s.filter((x) => x !== d.id) : [...s, d.id],
                          )
                        }
                        data-testid={`chip-new-demon-${d.id}`}
                        className={`rounded-full border px-2.5 py-1 text-[11px] leading-tight transition-colors ${
                          on
                            ? "border-primary/60 bg-primary/15 text-primary"
                            : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                        }`}
                      >
                        {d.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <HighlightPicker
                selected={highlights}
                extra={knownHighlights(allTrades).filter((h) => !highlights.includes(h))}
                onToggle={(h) =>
                  setHighlights((s) => (s.includes(h) ? s.filter((x) => x !== h) : [...s, h]))
                }
                testIdPrefix="new-highlight"
              />

              <p className="text-[10px] leading-snug text-muted-foreground">
                MAE / MFE and the no-management verdict stay optional — add them later
                from the trade's Edit dialog if you want the full scorecard.
              </p>
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
              {guard.locked
                ? "Locked — acknowledge the demon"
                : closedMode
                  ? "Log closed trade"
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
    </Card>
  );
}

