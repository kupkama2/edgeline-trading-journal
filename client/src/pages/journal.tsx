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
  Camera,
  Eye,
  Loader2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  useTrades,
  useMistakeTags,
  useCreateTrade,
  useUpdateTrade,
  useDeleteTrade,
  parseScreenshot,
  fileToDataUrl,
  analyzeRationale,
} from "@/lib/data";
import type { TradeWithTags } from "@shared/schema";
import {
  computeMetrics,
  fmtMoney,
  fmtR,
  EXIT_REASON_LABELS,
} from "@shared/metrics";
import { DailyGuardCard } from "@/components/daily-guard";

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
  const preview = useMemo(() => {
    const e = Number(v.entryPrice);
    const s = Number(v.initialStop);
    const t = Number(v.initialTarget);
    const sz = Number(v.size);
    if (![e, s, t].every((x) => isFinite(x) && x !== 0)) return null;
    const risk = Math.abs(e - s);
    const reward = Math.abs(t - e);
    if (!risk) return null;
    return {
      risk,
      rr: reward / risk,
      riskDollars: isFinite(sz) ? risk * sz : null,
    };
  }, [v.entryPrice, v.initialStop, v.initialTarget, v.size]);

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
      setParsed(true);
      toast({
        title: "Chart read",
        description: "Check the pre-filled numbers, then confirm.",
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
    await createTrade.mutateAsync({
      trade: {
        symbol: data.symbol.toUpperCase(),
        direction: data.direction,
        size: data.size,
        entryPrice: data.entryPrice,
        initialStop: data.initialStop,
        initialTarget: data.initialTarget,
        entryTime: toIso(data.entryTime),
        status: "open",
        setupScreenshot: image,
        notes: data.notes || null,
        rationale: rationale || null,
        rationaleTags: rationaleTags.length ? JSON.stringify(rationaleTags) : null,
      },
    });
    toast({ title: "Trade open", description: `${data.symbol.toUpperCase()} logged.` });
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
        {parsed && (
          <Badge variant="secondary" className="text-[10px]" data-testid="badge-ai-prefill">
            AI pre-filled · verify
          </Badge>
        )}
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

            {numField("size", "Size")}
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

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              className="h-9 flex-1 min-w-[9rem] text-xs font-semibold"
              disabled={createTrade.isPending || analyzingRationale}
              data-testid="button-save-trade"
            >
              {(createTrade.isPending || analyzingRationale) && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              Open trade
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
        outcomeScreenshot: image,
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
  const risk = Math.abs(t.entryPrice - t.initialStop);
  const rr = risk ? Math.abs(t.initialTarget - t.entryPrice) / risk : 0;
  const rationaleTags = parseTags(t.rationaleTags);
  return (
    <div
      data-testid={`card-open-trade-${t.id}`}
      className="relative w-full rounded-lg border border-card-border bg-card p-3 text-left transition-colors hover:border-primary/50 hover-elevate"
    >
      {(t.setupScreenshot || t.outcomeScreenshot) && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-1.5 top-1.5 h-6 w-6 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onView();
          }}
          aria-label="View screenshots"
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

function ClosedTradeRow({
  t,
  tagNames,
  onView,
}: {
  t: TradeWithTags;
  tagNames: Record<number, string>;
  onView: () => void;
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
        {(t.setupScreenshot || t.outcomeScreenshot) && (
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onView}
            aria-label="View screenshots"
            data-testid={`button-view-${t.id}`}
          >
            <Eye className="h-3 w-3" />
          </Button>
        )}
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
  const [closing, setClosing] = useState<TradeWithTags | null>(null);
  const [viewing, setViewing] = useState<TradeWithTags | null>(null);

  const tagNames = useMemo(
    () => Object.fromEntries(tags.map((t) => [t.id, t.name])),
    [tags],
  );

  const open = (trades ?? []).filter((t) => t.status === "open");
  const closed = (trades ?? []).filter((t) => t.status === "closed");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Journal</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Drop a chart, confirm the numbers, move on. Everything else is computed.
        </p>
      </div>

      <DailyGuardCard trades={trades ?? []} />

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
              />
            ))}
          </div>
        )}
      </div>

      <CloseTradeDialog trade={closing} onClose={() => setClosing(null)} />
      <TradeDetailDialog trade={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
