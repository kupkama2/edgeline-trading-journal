/**
 * The two per-trade dialogs: close it, and edit it in place.
 *
 * Reading a trade is not a dialog — it is the /trade/:id page, which every
 * click path lands on. These two are the write paths, opened from that page
 * and from the journal rows.
 */
import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { useAccountSettings, useMistakeTags, useUpdateTrade, useAddTradeImage, archiveDataUrl, parseScreenshot, fileToDownscaledDataUrl } from "@/lib/data";
import { suggestFees } from "@shared/fees";
import { knownHighlights, parseHighlights, serializeHighlights } from "@shared/highlights";
import { AccountPicker, HighlightPicker } from "@/components/trade-pickers";
import { useDeleteFill, useStyles, useTrades } from "@/lib/data";
import { styleColor } from "@/lib/style-filter";
import { collapseFills, positionLedger } from "@shared/fills";
import { TradeImageGallery } from "@/components/trade-images";
import { parseExtraTargets, parsePlaybook, type TradeWithTags } from "@shared/schema";
import { computeMetrics, fmtFees, fmtMoney, fmtR, EXIT_REASON_LABELS } from "@shared/metrics";
import { Dropzone, EXIT_REASONS, RationaleTags, localNow, num, parseTags, toIso } from "@/components/trade-shared";
import { EMPTY_GRADES, GradePicker, type GradeState } from "@/components/grade-picker";

/* ============================ close dialog ============================ */

export function CloseTradeDialog({
  trade,
  onClose,
}: {
  trade: TradeWithTags | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { data: tags = [] } = useMistakeTags();
  const updateTrade = useUpdateTrade();
  const addImage = useAddTradeImage();

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
  const [fees, setFees] = useState("");
  const [highlights, setHighlights] = useState<string[]>([]);
  const [grades, setGrades] = useState<GradeState>(EMPTY_GRADES);
  const { data: feeSchedules = [] } = useAccountSettings();
  const { data: allTrades = [] } = useTrades();

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
    setFees("");
    setHighlights([]);
    setGrades(EMPTY_GRADES);
  }

  // One-click fee suggestions from the account's schedule, sized on THIS
  // trade (fills included). Only when the account has a schedule.
  const feeChips = useMemo(() => {
    if (!trade?.account) return [];
    const cfg = feeSchedules.find((s) => s.name === trade.account?.trim());
    return suggestFees(trade, cfg, Number(exitPrice) || null);
  }, [trade, feeSchedules, exitPrice]);

  async function handleFile(file: File) {
    if (!trade) return;
    const dataUrl = await fileToDownscaledDataUrl(file);
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
      // With a scale-out plan, "hit target" means the level this remainder was
      // aimed at — the nth TP after n partials — not TP1, which was taken
      // several fills ago. Falls back to the last planned level.
      if (r === "target") {
        const tps = [trade.initialTarget, ...parseExtraTargets(trade.extraTargets)].filter(
          (x): x is number => x != null,
        );
        const taken = positionLedger(trade).partials;
        setExitPrice(String(tps[Math.min(taken, tps.length - 1)] ?? trade.initialTarget));
      }
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
      fees: fees && isFinite(Number(fees)) ? Number(fees) : null,
      status: "closed",
    } as any);
  }, [trade, exitPrice, mae, mfe, nmo, fees]);

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
        fees: fees && isFinite(Number(fees)) ? Number(fees) : null,
        highlights: serializeHighlights(highlights),
        entryGrade: grades.entry as any,
        stopGrade: grades.stop as any,
        exitGrade: grades.exit as any,
        // Parsed for MAE/MFE, then discarded — see the note on setupScreenshot.
        outcomeScreenshot: null,
        notes: notes || trade.notes || null,
      },
      mistakeTagIds: selectedTags,
    });
    // The chart was parsed for MAE/MFE; keeping it costs one lazy-loaded row
    // in trade_images and buys the visual record. Failure here must not block
    // the close — the numbers are already saved.
    if (image) {
      archiveDataUrl(image).then((data) =>
        addImage.mutate({ tradeId: trade.id, kind: "outcome", data }),
      );
    }
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
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {parseExtraTargets(trade.extraTargets).length > 0 ? "Targets" : "Target"}
                </p>
                <p className="text-emerald-400">
                  {[trade.initialTarget, ...parseExtraTargets(trade.extraTargets)]
                    .filter((x): x is number => x != null)
                    .map((x) => num(x))
                    .join(" → ") || "—"}
                </p>
              </div>
              {trade.account && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Account
                  </p>
                  <p className="truncate">{trade.account}</p>
                </div>
              )}
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

            <GradePicker
              value={grades}
              onChange={setGrades}
              testPrefix="grade-close"
              exitReason={exitReason}
            />

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
              <div className="col-span-2 space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Fees $ <span className="normal-case">(both sides · optional — R and P&amp;L go net)</span>
                </label>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Input
                    type="number"
                    step="any"
                    inputMode="decimal"
                    value={fees}
                    onChange={(e) => setFees(e.target.value)}
                    placeholder="0"
                    className="h-8 w-24 font-mono text-sm"
                    data-testid="input-fees"
                  />
                  {feeChips.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => setFees(String(c.dollars))}
                      data-testid={`chip-fee-${c.key}`}
                      className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                      title="From this account's fee schedule"
                    >
                      {c.label} · ${c.dollars}
                    </button>
                  ))}
                </div>
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

            {/* The other half of the same minute: name what you nailed. */}
            <HighlightPicker
              selected={highlights}
              extra={knownHighlights(allTrades)}
              onToggle={(h) =>
                setHighlights((s) => (s.includes(h) ? s.filter((x) => x !== h) : [...s, h]))
              }
              testIdPrefix="close-highlight"
            />

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
                {/* R rounds to two places, so a small commission can vanish
                    from it entirely — the dollars are where fees show up. */}
                {previewMetrics.fees > 0 && (
                  <p
                    className="col-span-3 border-t border-border/60 pt-2 text-[11px] text-muted-foreground"
                    data-testid="preview-net"
                  >
                    net{" "}
                    <span
                      className={
                        (previewMetrics.actualPnL ?? 0) >= 0 ? "text-emerald-400" : "text-primary"
                      }
                    >
                      {fmtMoney(previewMetrics.actualPnL ?? 0)}
                    </span>{" "}
                    · {fmtMoney(previewMetrics.grossPnL ?? 0)} gross − {fmtFees(previewMetrics.fees)} fees
                  </p>
                )}
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
export function EditTradeDialog({
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
      account: trade.account ?? "",
      fees: trade.fees != null ? String(trade.fees) : "",
    });
    setDirection(trade.direction === "short" ? "short" : "long");
    setExitReason(trade.exitReason ?? null);
    setNmo(trade.noManagementOutcome ?? null);
    setSelectedTags(trade.mistakeTagIds);
    setExtraTps(parseExtraTargets(trade.extraTargets).map(String));
    setHighlights(parseHighlights(trade.highlights));
    setGrades({
      entry: trade.entryGrade ?? null,
      stop: trade.stopGrade ?? null,
      exit: trade.exitGrade ?? null,
    });
    setAccount(trade.account ?? "");
    setStyleId(trade.styleId ?? null);
    setSizeUnit(trade.sizeUnit === "quote" ? "quote" : "base");
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
        sizeUnit,
        initialStop,
        initialTarget,
        entryTime: f.entryTime ? toIso(f.entryTime) : trade.entryTime,
        extraTargets: (() => {
          const xs = extraTps.map(Number).filter((x) => isFinite(x) && x > 0);
          return xs.length ? JSON.stringify(xs) : null;
        })(),
        exitPrice: numOrNull(f.exitPrice),
        exitTime: f.exitTime ? toIso(f.exitTime) : null,
        exitReason: (exitReason as any) ?? null,
        mae: numOrNull(f.mae),
        mfe: numOrNull(f.mfe),
        noManagementOutcome: (nmo as any) ?? null,
        rationale: f.rationale.trim() || null,
        rationaleTags: rTags.length ? JSON.stringify(rTags) : null,
        notes: f.notes.trim() || null,
        account: account.trim() || null,
        styleId,
        fees: numOrNull(f.fees ?? ""),
        highlights: serializeHighlights(highlights),
        entryGrade: grades.entry as any,
        stopGrade: grades.stop as any,
        exitGrade: grades.exit as any,
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
              {field("entryPrice", "Entry")}
              {field("initialStop", "Stop")}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {extraTps.length > 0 ? "TP1" : "Target"}
                  </label>
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
                </div>
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
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      TP{i + 2}
                    </label>
                    <button
                      type="button"
                      onClick={() => setExtraTps((x) => x.filter((_, j) => j !== i))}
                      title="Remove this level"
                      data-testid={`button-edit-remove-tp-${i}`}
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
                    data-testid={`input-edit-extra-tp-${i}`}
                  />
                </div>
              ))}
              {field("entryTime", "Entry time", "datetime-local")}
              {field("exitTime", "Exit time", "datetime-local")}
              {field("exitPrice", "Exit price")}
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
              {field("mae", "MAE (worst price)")}
              {field("mfe", "MFE (best price)")}
              {field("fees", "Fees $ (both sides)")}
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

            <GradePicker
              value={grades}
              onChange={setGrades}
              testPrefix="grade-edit"
              exitReason={exitReason}
            />

            {/* Scaling belongs in the edit dialog too: the trade view can show
                and remove fills, but this is where a trade gets corrected, and
                "I logged partials I would rather not keep" is a correction. */}
            {trade.fills.length > 0 && (
              <div data-testid="section-edit-fills">
                <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Partials and adds
                </p>
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
              </div>
            )}

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

            <HighlightPicker
              selected={highlights}
              extra={knownHighlights(allTrades)}
              onToggle={(h) =>
                setHighlights((s) => (s.includes(h) ? s.filter((x) => x !== h) : [...s, h]))
              }
              testIdPrefix="edit-highlight"
            />

            {/* Fees explained where they're typed, since they change the R. */}

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
                className="grid grid-cols-2 gap-2 rounded-md border border-border/60 bg-secondary/30 p-2.5 text-center font-mono text-xs sm:grid-cols-4"
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
            )}

            {/* Attach here too, not only from the read-only detail view: Edit
                is where you reach to change a trade, and a screenshot added to
                a trade closed weeks ago is a change like any other. Images save
                on their own, so they survive whether or not "Save changes" is
                pressed. */}
            <div className="border-t border-border/60 pt-3">
              <TradeImageGallery tradeId={trade.id} />
            </div>

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
