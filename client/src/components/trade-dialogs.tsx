/**
 * The three per-trade dialogs: close it, edit it in place, read its story.
 */
import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { ClipboardList, Loader2, Pencil } from "lucide-react";
import { useMistakeTags, useUpdateTrade, useAddTradeImage, archiveDataUrl, parseScreenshot, fileToDownscaledDataUrl } from "@/lib/data";
import { TradeImageGallery } from "@/components/trade-images";
import { parsePlaybook, type TradeWithTags } from "@shared/schema";
import { computeMetrics, fmtR, EXIT_REASON_LABELS } from "@shared/metrics";
import { Dropzone, EXIT_REASONS, RationaleTags, localNow, num, parseTags, toIso } from "@/components/trade-shared";

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


export function TradeDetailDialog({
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

            <TradeImageGallery tradeId={trade.id} />

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

