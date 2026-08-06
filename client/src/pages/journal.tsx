import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowDownRight,
  ArrowUpRight,
  Ban,
  Camera,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  ClipboardPaste,
  Eye,
  Loader2,
  Pencil,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  useTrades,
  useMistakeTags,
  useStyles,
  useCreateTrade,
  useUpdateTrade,
  useDeleteTrade,
  parseScreenshot,
  fileToDataUrl,
  analyzeRationale,
} from "@/lib/data";
import {
  filterByStyle,
  styleColor,
  styleName,
  useStyleFilter,
} from "@/lib/style-filter";
import { parsePlaybook, type TradeWithTags } from "@shared/schema";
import {
  computeMetrics,
  fmtMoney,
  fmtR,
  EXIT_REASON_LABELS,
} from "@shared/metrics";
import { DailyGuardCard, useDemonGuard } from "@/components/daily-guard";
import { StyleChip, StyleSwitcher } from "@/components/style-switcher";
import { pointValueFor } from "@shared/symbols";
import { ImportTradesDialog } from "@/components/import-trades";

/* ============================== helpers ============================== */

const num = (v: number | null | undefined, d = 2) =>
  v == null || !isFinite(v) ? "—" : v.toFixed(d);

function localNow() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function toIso(local: string) {
  return local ? new Date(local).toISOString() : new Date().toISOString();
}

function parseTags(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function RationaleTags({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] leading-tight text-emerald-400"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

/* ========================= screenshot dropzone ======================== */

function Dropzone({
  label,
  hint,
  image,
  busy,
  onFile,
  onClear,
  testId,
}: {
  label: string;
  hint: string;
  image: string | null;
  busy: boolean;
  onFile: (f: File) => void;
  onClear: () => void;
  testId: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (image || busy) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      let file: File | null = null;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          file = items[i].getAsFile();
          break;
        }
      }
      if (!file) return;
      // If a dialog is open, only the dropzone inside it should claim the paste.
      const openDialog = document.querySelector('[role="dialog"]');
      if (openDialog && containerRef.current && !openDialog.contains(containerRef.current)) {
        return;
      }
      e.preventDefault();
      onFile(file);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [image, busy, onFile]);

  if (image) {
    return (
      <div ref={containerRef} className="relative overflow-hidden rounded-lg border border-border/70">
        <img src={image} alt={label} className="max-h-52 w-full object-contain bg-black/30" />
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/75 text-xs font-medium">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            Reading chart…
          </div>
        )}
        <div className="absolute right-2 top-2">
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="h-7 w-7"
            onClick={onClear}
            data-testid={`${testId}-clear`}
            aria-label="Remove screenshot"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      onPaste={(e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith("image/")) {
            const f = items[i].getAsFile();
            if (f) {
              e.preventDefault();
              onFile(f);
            }
            break;
          }
        }
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      data-testid={testId}
      className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center transition-colors ${
        over ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-secondary/40"
      }`}
    >
      <Camera className="h-5 w-5 text-muted-foreground" />
      <p className="text-xs font-medium">{label}</p>
      <p className="text-[11px] leading-snug text-muted-foreground">{hint} You can also press Ctrl+V (or Cmd+V) anywhere here to paste from your clipboard.</p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid={`${testId}-input`}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

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

function NewTradeCard() {
  const { toast } = useToast();
  const createTrade = useCreateTrade();
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
    const dataUrl = await fileToDataUrl(file);
    setImage(dataUrl);
    setParsing(true);
    setParsed(false);
    try {
      const r = await parseScreenshot(dataUrl, "setup");
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

    const loggingClosed = closedMode && exitPrice !== "" && isFinite(Number(exitPrice));
    if (closedMode && !loggingClosed) {
      toast({ title: "Exit price required", variant: "destructive" });
      return;
    }

    await createTrade.mutateAsync({
      trade: {
        styleId,
        symbol: data.symbol.toUpperCase(),
        direction: data.direction,
        size: data.size,
        sizeUnit,
        entryPrice: data.entryPrice,
        initialStop: data.initialStop,
        initialTarget: data.initialTarget,
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
    setPickedStyleId(null);
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
            {numField("initialTarget", "Target")}

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

              <p className="text-[10px] leading-snug text-muted-foreground">
                MAE / MFE and the no-management verdict stay optional — add them later
                from the trade's Edit dialog if you want the full scorecard.
              </p>
            </div>
          )}

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

/* ============================ close dialog ============================ */

const EXIT_REASONS = [
  "target",
  "stop",
  "trailed",
  "manual_early",
  "manual_late",
  "breakeven",
] as const;

function CloseTradeDialog({
  trade,
  onClose,
}: {
  trade: TradeWithTags | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { data: tags = [] } = useMistakeTags();
  const updateTrade = useUpdateTrade();

  const [image, setImage] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [exitReason, setExitReason] = useState<string | null>(null);
  const [exitPrice, setExitPrice] = useState("");
  const [exitTime, setExitTime] = useState(localNow());
  const [mae, setMae] = useState("");
  const [mfe, setMfe] = useState("");
  const [nmo, setNmo] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<number[]>([]);
  const [notes, setNotes] = useState("");

  const open = trade != null;

  function reset() {
    setImage(null);
    setExitReason(null);
    setExitPrice("");
    setExitTime(localNow());
    setMae("");
    setMfe("");
    setNmo(null);
    setSelectedTags([]);
    setNotes("");
  }

  async function handleFile(file: File) {
    if (!trade) return;
    const dataUrl = await fileToDataUrl(file);
    setImage(dataUrl);
    setParsing(true);
    try {
      const r = await parseScreenshot(dataUrl, "outcome", {
        symbol: trade.symbol,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        initialStop: trade.initialStop,
        initialTarget: trade.initialTarget,
      });
      if (r.mae != null) setMae(String(r.mae));
      if (r.mfe != null) setMfe(String(r.mfe));
      if (r.noManagementOutcome) setNmo(r.noManagementOutcome);
      toast({ title: "Outcome read", description: "Verify MAE / MFE before saving." });
    } catch {
      toast({
        title: "Couldn't read that chart",
        description: "Enter MAE / MFE manually.",
        variant: "destructive",
      });
    } finally {
      setParsing(false);
    }
  }

  function pickReason(r: string) {
    if (!trade) return;
    setExitReason(r);
    if (!exitPrice) {
      if (r === "target") setExitPrice(String(trade.initialTarget));
      else if (r === "stop") setExitPrice(String(trade.initialStop));
      else if (r === "breakeven") setExitPrice(String(trade.entryPrice));
    }
    setExitTime(localNow());
  }

  const previewMetrics = useMemo(() => {
    if (!trade || !exitPrice) return null;
    return computeMetrics({
      ...trade,
      exitPrice: Number(exitPrice),
      mae: mae ? Number(mae) : null,
      mfe: mfe ? Number(mfe) : null,
      noManagementOutcome: nmo,
      status: "closed",
    } as any);
  }, [trade, exitPrice, mae, mfe, nmo]);

  async function save() {
    if (!trade) return;
    if (!exitPrice || !isFinite(Number(exitPrice))) {
      toast({ title: "Exit price required", variant: "destructive" });
      return;
    }
    await updateTrade.mutateAsync({
      id: trade.id,
      trade: {
        status: "closed",
        exitPrice: Number(exitPrice),
        exitTime: toIso(exitTime),
        exitReason: (exitReason as any) ?? "other",
        mae: mae ? Number(mae) : null,
        mfe: mfe ? Number(mfe) : null,
        noManagementOutcome: (nmo as any) ?? null,
        // Parsed for MAE/MFE, then discarded — see the note on setupScreenshot.
        outcomeScreenshot: null,
        notes: notes || trade.notes || null,
      },
      mistakeTagIds: selectedTags,
    });
    toast({ title: "Trade closed", description: `${trade.symbol} recorded.` });
    reset();
    onClose();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            Close {trade?.symbol}
            {trade && (
              <Badge
                variant="outline"
                className={`text-[10px] uppercase ${
                  trade.direction === "long" ? "text-emerald-400" : "text-primary"
                }`}
              >
                {trade.direction}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {trade && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 rounded-md border border-border/60 bg-secondary/30 p-2.5 text-center font-mono text-xs">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Entry</p>
                <p>{num(trade.entryPrice)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Stop</p>
                <p className="text-primary">{num(trade.initialStop)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Target</p>
                <p className="text-emerald-400">{num(trade.initialTarget)}</p>
              </div>
            </div>

            <Dropzone
              testId="dropzone-outcome"
              label="Drop outcome screenshot"
              hint="Post-trade chart — estimates MAE, MFE and the no-management outcome. Optional."
              image={image}
              busy={parsing}
              onFile={handleFile}
              onClear={() => setImage(null)}
            />

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
                    onClick={() => pickReason(r)}
                    data-testid={`button-exit-${r}`}
                  >
                    {EXIT_REASON_LABELS[r]}
                  </Button>
                ))}
              </div>
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
                  data-testid="input-exit-price"
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
                  data-testid="input-exit-time"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  MAE (worst price)
                </label>
                <Input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={mae}
                  onChange={(e) => setMae(e.target.value)}
                  className="h-9 font-mono text-sm"
                  data-testid="input-mae"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  MFE (best price)
                </label>
                <Input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={mfe}
                  onChange={(e) => setMfe(e.target.value)}
                  className="h-9 font-mono text-sm"
                  data-testid="input-mfe"
                />
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Untouched plan would have hit…
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { k: "target_first", l: "Target first" },
                  { k: "stop_first", l: "Stop first" },
                  { k: "undetermined", l: "Undetermined" },
                ].map(({ k, l }) => (
                  <Button
                    key={k}
                    type="button"
                    size="sm"
                    variant={nmo === k ? "default" : "outline"}
                    className="h-8 text-[11px]"
                    onClick={() => setNmo(nmo === k ? null : k)}
                    data-testid={`button-nmo-${k}`}
                  >
                    {l}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Mistakes on this trade
              </p>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => {
                  const on = selectedTags.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() =>
                        setSelectedTags((s) =>
                          on ? s.filter((x) => x !== t.id) : [...s, t.id],
                        )
                      }
                      data-testid={`chip-mistake-${t.id}`}
                      className={`rounded-full border px-2.5 py-1 text-[11px] leading-tight transition-colors ${
                        on
                          ? "border-primary/60 bg-primary/15 text-primary"
                          : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                      }`}
                    >
                      {t.name}
                    </button>
                  );
                })}
              </div>
            </div>

            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes (optional)"
              className="min-h-[60px] text-xs"
              data-testid="input-notes"
            />

            {previewMetrics && (
              <div
                className="grid grid-cols-3 gap-2 rounded-md border border-border/60 bg-secondary/30 p-2.5 text-center font-mono text-xs"
                data-testid="preview-metrics"
              >
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Actual
                  </p>
                  <p
                    className={
                      (previewMetrics.actualR ?? 0) >= 0 ? "text-emerald-400" : "text-primary"
                    }
                  >
                    {fmtR(previewMetrics.actualR)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    No-mgmt
                  </p>
                  <p>{fmtR(previewMetrics.potentialR)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Δ mgmt
                  </p>
                  <p
                    className={
                      (previewMetrics.managementDeltaR ?? 0) >= 0
                        ? "text-emerald-400"
                        : "text-primary"
                    }
                  >
                    {fmtR(previewMetrics.managementDeltaR)}
                  </p>
                </div>
              </div>
            )}

            <Button
              className="h-10 w-full text-xs font-semibold"
              onClick={save}
              disabled={updateTrade.isPending}
              data-testid="button-close-trade-save"
            >
              {updateTrade.isPending && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              Save & close trade
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ============================= edit dialog ============================ */

const NMO_OPTIONS = [
  { k: "target_first", l: "Target first" },
  { k: "stop_first", l: "Stop first" },
  { k: "undetermined", l: "Undetermined" },
] as const;

function toLocalInput(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/**
 * Correct any field on an already-logged trade. Everything derived (actual R,
 * no-management R, MFE capture) is computed on read via `computeMetrics`, so
 * there is no cached metric to rebuild — invalidating the trades query after
 * the PATCH is enough for every number in the app to recompute.
 */
function EditTradeDialog({
  trade,
  onClose,
}: {
  trade: TradeWithTags | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { data: tags = [] } = useMistakeTags();
  const updateTrade = useUpdateTrade();

  const [f, setF] = useState<Record<string, string>>({});
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [exitReason, setExitReason] = useState<string | null>(null);
  const [nmo, setNmo] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<number[]>([]);

  useEffect(() => {
    if (!trade) return;
    setF({
      symbol: trade.symbol,
      size: String(trade.size),
      entryPrice: String(trade.entryPrice),
      // Pending trades have no stop/target yet — String(null) would put the
      // literal text "null" in the field for the user to delete by hand.
      initialStop: trade.initialStop != null ? String(trade.initialStop) : "",
      initialTarget: trade.initialTarget != null ? String(trade.initialTarget) : "",
      entryTime: toLocalInput(trade.entryTime),
      exitPrice: trade.exitPrice != null ? String(trade.exitPrice) : "",
      exitTime: toLocalInput(trade.exitTime),
      mae: trade.mae != null ? String(trade.mae) : "",
      mfe: trade.mfe != null ? String(trade.mfe) : "",
      rationale: trade.rationale ?? "",
      rationaleTags: parseTags(trade.rationaleTags).join(", "),
      notes: trade.notes ?? "",
    });
    setDirection(trade.direction === "short" ? "short" : "long");
    setExitReason(trade.exitReason ?? null);
    setNmo(trade.noManagementOutcome ?? null);
    setSelectedTags(trade.mistakeTagIds);
  }, [trade]);

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
      entryPrice,
      initialStop,
      initialTarget: numOrNull(f.initialTarget ?? "") ?? trade.initialTarget,
      exitPrice: numOrNull(f.exitPrice ?? ""),
      mae: numOrNull(f.mae ?? ""),
      mfe: numOrNull(f.mfe ?? ""),
      noManagementOutcome: nmo,
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
    const rTags = f.rationaleTags
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    await updateTrade.mutateAsync({
      id: trade.id,
      trade: {
        symbol: f.symbol.trim().toUpperCase(),
        direction,
        size,
        entryPrice,
        initialStop,
        initialTarget,
        entryTime: f.entryTime ? toIso(f.entryTime) : trade.entryTime,
        exitPrice: numOrNull(f.exitPrice),
        exitTime: f.exitTime ? toIso(f.exitTime) : null,
        exitReason: (exitReason as any) ?? null,
        mae: numOrNull(f.mae),
        mfe: numOrNull(f.mfe),
        noManagementOutcome: (nmo as any) ?? null,
        rationale: f.rationale.trim() || null,
        rationaleTags: rTags.length ? JSON.stringify(rTags) : null,
        notes: f.notes.trim() || null,
      },
      mistakeTagIds: selectedTags,
    });
    toast({ title: "Trade updated", description: `${f.symbol.toUpperCase()} corrected.` });
    onClose();
  }

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
    <Dialog open={trade != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Pencil className="h-4 w-4 text-muted-foreground" />
            Edit {trade?.symbol}
          </DialogTitle>
        </DialogHeader>

        {trade && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {field("symbol", "Symbol", "text")}
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
              {field("size", "Size")}
              {field("entryPrice", "Entry")}
              {field("initialStop", "Stop")}
              {field("initialTarget", "Target")}
              {field("entryTime", "Entry time", "datetime-local")}
              {field("exitTime", "Exit time", "datetime-local")}
              {field("exitPrice", "Exit price")}
              <div />
              {field("mae", "MAE (worst price)")}
              {field("mfe", "MFE (best price)")}
            </div>

            <div>
              <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Exit reason
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
                    data-testid={`button-edit-exit-${r}`}
                  >
                    {EXIT_REASON_LABELS[r]}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Untouched plan would have hit…
              </p>
              <div className="flex flex-wrap gap-1.5">
                {NMO_OPTIONS.map(({ k, l }) => (
                  <Button
                    key={k}
                    type="button"
                    size="sm"
                    variant={nmo === k ? "default" : "outline"}
                    className="h-8 text-[11px]"
                    onClick={() => setNmo(nmo === k ? null : k)}
                    data-testid={`button-edit-nmo-${k}`}
                  >
                    {l}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Demons on this trade
              </p>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => {
                  const on = selectedTags.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() =>
                        setSelectedTags((s) =>
                          on ? s.filter((x) => x !== t.id) : [...s, t.id],
                        )
                      }
                      data-testid={`chip-edit-demon-${t.id}`}
                      className={`rounded-full border px-2.5 py-1 text-[11px] leading-tight transition-colors ${
                        on
                          ? "border-primary/60 bg-primary/15 text-primary"
                          : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                      }`}
                    >
                      {t.name}
                    </button>
                  );
                })}
              </div>
            </div>

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
            </div>

            <Textarea
              value={f.notes ?? ""}
              onChange={set("notes")}
              placeholder="Notes"
              className="min-h-[60px] text-xs"
              data-testid="input-edit-notes"
            />

            {previewMetrics && (
              <div
                className="grid grid-cols-3 gap-2 rounded-md border border-border/60 bg-secondary/30 p-2.5 text-center font-mono text-xs"
                data-testid="edit-preview-metrics"
              >
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
            )}

            <Button
              className="h-10 w-full text-xs font-semibold"
              onClick={save}
              disabled={updateTrade.isPending}
              data-testid="button-edit-save"
            >
              {updateTrade.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save changes
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ============================== trade rows ============================ */

function OpenTradeRow({
  t,
  onSelect,
  onView,
}: {
  t: TradeWithTags;
  onSelect: () => void;
  onView: () => void;
}) {
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
      {(
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-1.5 top-1.5 h-6 w-6 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onView();
          }}
          aria-label="View trade details"
          data-testid={`button-view-${t.id}`}
        >
          <Eye className="h-3.5 w-3.5" />
        </Button>
      )}
      <button
        type="button"
        onClick={onSelect}
        className="block w-full text-left"
      >
        <div className="flex items-center gap-2 pr-7">
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
          <span className="ml-auto shrink-0 rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {t.size} @ {num(t.entryPrice)}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
          <span>
            SL <span className="text-primary">{num(t.initialStop)}</span>
          </span>
          <span>
            TP <span className="text-emerald-400">{num(t.initialTarget)}</span>
          </span>
          <span>R:R {num(rr, 1)}</span>
          <span className="ml-auto">
            {new Date(t.entryTime).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
        <RationaleTags tags={rationaleTags} />
      </button>
    </div>
  );
}

/**
 * A resting order that has not filled. It carries no risk yet, so there is no
 * R:R or P&L to show — what matters is what is still missing before it can go
 * live, which is what the row surfaces.
 */
function PendingTradeRow({
  t,
  onEdit,
}: {
  t: TradeWithTags;
  onEdit: () => void;
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
    <Card className="p-3" data-testid={`row-pending-${t.id}`}>
      <div className="flex items-center gap-2">
        {t.direction === "long" ? (
          <ArrowUpRight className="h-3.5 w-3.5 text-emerald-500" />
        ) : (
          <ArrowDownRight className="h-3.5 w-3.5 text-red-500" />
        )}
        <span className="font-mono text-xs font-semibold">{t.symbol}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {t.size}
          {t.sizeUnit === "quote" ? " USD" : ""} @ {num(t.entryPrice)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2 text-[11px]"
          onClick={onEdit}
          data-testid={`button-fill-${t.id}`}
        >
          <Pencil className="mr-1 h-3 w-3" />
          Fill in
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

function ClosedTradeRow({
  t,
  tagNames,
  onView,
  onEdit,
}: {
  t: TradeWithTags;
  tagNames: Record<number, string>;
  onView: () => void;
  onEdit: () => void;
}) {
  const m = computeMetrics(t);
  const del = useDeleteTrade();
  const win = (m.actualR ?? 0) >= 0;
  const rationaleTags = parseTags(t.rationaleTags);
  return (
    <div
      className="rounded-lg border border-card-border bg-card p-3"
      data-testid={`card-closed-trade-${t.id}`}
    >
      <div className="flex items-center gap-2">
        <span className="truncate font-mono text-sm font-semibold">{t.symbol}</span>
        <StyleChip styleId={t.styleId} />
        <Badge variant="outline" className="shrink-0 text-[10px] capitalize">
          {t.exitReason ? EXIT_REASON_LABELS[t.exitReason] : "—"}
        </Badge>
        <span
          className={`ml-auto shrink-0 font-mono text-sm font-bold ${
            win ? "text-emerald-400" : "text-primary"
          }`}
          data-testid={`text-actual-r-${t.id}`}
        >
          {fmtR(m.actualR)}
        </span>
        <span
          className={`shrink-0 font-mono text-xs ${win ? "text-emerald-400/80" : "text-primary/80"}`}
        >
          {fmtMoney(m.actualPnL)}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onView}
          aria-label="View trade details"
          data-testid={`button-view-${t.id}`}
        >
          <Eye className="h-3 w-3" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onEdit}
          aria-label="Edit trade"
          data-testid={`button-edit-${t.id}`}
        >
          <Pencil className="h-3 w-3" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={() => del.mutate(t.id)}
          aria-label="Delete trade"
          data-testid={`button-delete-${t.id}`}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
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
      <RationaleTags tags={rationaleTags} />
    </div>
  );
}

function TradeDetailDialog({
  trade,
  onClose,
}: {
  trade: TradeWithTags | null;
  onClose: () => void;
}) {
  const open = trade != null;
  const rationaleTags = parseTags(trade?.rationaleTags);
  const playbook = parsePlaybook(trade?.playbook);
  const playbookRows: [string, string][] = playbook
    ? ([
        ["Setup", playbook.setupName],
        ["Stop logic", playbook.stopLogic],
        ["Target logic", playbook.targetLogic],
        ["Confidence", playbook.confidence ? `${playbook.confidence} / 5` : undefined],
        ["Stand aside if", playbook.standAside],
      ].filter(([, v]) => v && String(v).trim()) as [string, string][])
    : [];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {trade?.symbol}
            {trade && (
              <Badge
                variant="outline"
                className={`text-[10px] uppercase ${
                  trade.direction === "long" ? "text-emerald-400" : "text-primary"
                }`}
              >
                {trade.direction}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {trade && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 rounded-md border border-border/60 bg-secondary/30 p-2.5 text-center font-mono text-xs">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Entry</p>
                <p>{num(trade.entryPrice)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Stop</p>
                <p className="text-primary">{num(trade.initialStop)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Target</p>
                <p className="text-emerald-400">{num(trade.initialTarget)}</p>
              </div>
            </div>

            {trade.rationale && (
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Rationale
                </p>
                <p className="text-xs">{trade.rationale}</p>
                <RationaleTags tags={rationaleTags} />
              </div>
            )}

            {playbookRows.length > 0 && (
              <div data-testid="detail-playbook">
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

            {trade.setupScreenshot && (
              <div>
                <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Setup screenshot
                </p>
                <img
                  src={trade.setupScreenshot}
                  alt="Setup screenshot"
                  className="w-full rounded-lg border border-border/70 bg-black/30 object-contain"
                  data-testid={`img-setup-${trade.id}`}
                />
              </div>
            )}

            {trade.outcomeScreenshot && (
              <div>
                <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Outcome screenshot
                </p>
                <img
                  src={trade.outcomeScreenshot}
                  alt="Outcome screenshot"
                  className="w-full rounded-lg border border-border/70 bg-black/30 object-contain"
                  data-testid={`img-outcome-${trade.id}`}
                />
              </div>
            )}

            {!trade.setupScreenshot && !trade.outcomeScreenshot && (
              <p className="text-xs text-muted-foreground">
                No screenshots attached to this trade.
              </p>
            )}

            {trade.notes && (
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Notes</p>
                <p className="text-xs">{trade.notes}</p>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ================================ page ================================ */

export default function Journal() {
  const { data: trades, isLoading } = useTrades();
  const { data: tags = [] } = useMistakeTags();
  const { activeStyleId } = useStyleFilter();
  const [closing, setClosing] = useState<TradeWithTags | null>(null);
  const [viewing, setViewing] = useState<TradeWithTags | null>(null);
  const [editing, setEditing] = useState<TradeWithTags | null>(null);
  const [importing, setImporting] = useState(false);

  const tagNames = useMemo(
    () => Object.fromEntries(tags.map((t) => [t.id, t.name])),
    [tags],
  );

  const scoped = useMemo(
    () => filterByStyle(trades ?? [], activeStyleId),
    [trades, activeStyleId],
  );
  const pending = scoped.filter((t) => t.status === "pending");
  const open = scoped.filter((t) => t.status === "open");
  const closed = scoped.filter((t) => t.status === "closed");

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Journal</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Drop a chart, confirm the numbers, move on. Everything else is computed.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setImporting(true)}
          data-testid="button-open-import"
        >
          <ClipboardPaste className="mr-1.5 h-3.5 w-3.5" />
          Import orders
        </Button>
      </div>

      <StyleSwitcher />

      <DailyGuardCard trades={scoped} tags={tags} styleId={activeStyleId} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <NewTradeCard />

        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold tracking-tight">Open trades</h2>
            <span className="font-mono text-[11px] text-muted-foreground" data-testid="text-open-count">
              {open.length} open
            </span>
          </div>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : open.length === 0 ? (
            <Card className="border-dashed border-border bg-card/40 p-6 text-center">
              <p className="text-xs text-muted-foreground">
                No open positions. Log a setup to start tracking one.
              </p>
            </Card>
          ) : (
            <div className="space-y-2">
              {open.map((t) => (
                <OpenTradeRow
                  key={t.id}
                  t={t}
                  onSelect={() => setClosing(t)}
                  onView={() => setViewing(t)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {pending.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold tracking-tight">
              Waiting to be filled
            </h2>
            <span
              className="font-mono text-[11px] text-muted-foreground"
              data-testid="text-pending-count"
            >
              {pending.length} could open
            </span>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {pending.map((t) => (
              <PendingTradeRow key={t.id} t={t} onEdit={() => setEditing(t)} />
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold tracking-tight">Closed trades</h2>
          <span className="font-mono text-[11px] text-muted-foreground">
            {closed.length} logged
          </span>
        </div>
        {closed.length === 0 ? (
          <Card className="border-dashed border-border bg-card/40 p-6 text-center">
            <p className="text-xs text-muted-foreground">
              Closed trades and their management scorecard will appear here.
            </p>
          </Card>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {closed.map((t) => (
              <ClosedTradeRow
                key={t.id}
                t={t}
                tagNames={tagNames}
                onView={() => setViewing(t)}
                onEdit={() => setEditing(t)}
              />
            ))}
          </div>
        )}
      </div>

      <CloseTradeDialog trade={closing} onClose={() => setClosing(null)} />
      <TradeDetailDialog trade={viewing} onClose={() => setViewing(null)} />
      <EditTradeDialog trade={editing} onClose={() => setEditing(null)} />
      <ImportTradesDialog open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}
