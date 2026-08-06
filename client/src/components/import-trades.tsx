import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { ArrowDownRight, ArrowUpRight, Camera, ClipboardPaste, Loader2 } from "lucide-react";
import { parseImport, type ImportCandidate } from "@shared/import-parse";
import { fileToDownscaledDataUrl, parseScreenshot, useImportTrades } from "@/lib/data";
import { useStyleFilter } from "@/lib/style-filter";

/**
 * Paste-import for resting orders.
 *
 * Parsing runs in the browser against the same module the server uses, so the
 * preview is not a guess about what will be imported — it *is* the payload,
 * edited and then sent. Rows land as pending trades, which is the point: you
 * see how many positions could open, then add rationale one at a time.
 */

/** A preview row: the parsed candidate plus any manual corrections. */
type Row = ImportCandidate & { include: boolean };

const PLACEHOLDER = `Paste an order log — Binance open orders, a Binance Take Profit / Stop Loss dialog, or a futures broker's working orders.

2026-08-05 21:30:51	BTCUSDT Perp	Limit	Open Short	65,109.40	37,177.47 USDT	0.00 USDT	No`;

function num(v: number | null | undefined, dp = 2): string {
  if (v == null) return "—";
  return v.toLocaleString(undefined, { maximumFractionDigits: dp });
}

export function ImportTradesDialog({
  open,
  onClose,
  seedRows,
}: {
  open: boolean;
  onClose: () => void;
  /** Rows already read from a screenshot elsewhere (a paste on the journal). */
  seedRows?: ImportCandidate[] | null;
}) {
  const [text, setText] = useState("");
  // Rows read from a screenshot. Kept beside the pasted-text rows rather than
  // merged into it, because the paste is re-parsed on every keystroke and would
  // wipe them.
  const [shotRows, setShotRows] = useState<ImportCandidate[]>([]);
  const [scanning, setScanning] = useState(false);
  const [edits, setEdits] = useState<Record<number, Partial<Row>>>({});
  const [excluded, setExcluded] = useState<Record<number, boolean>>({});
  const { toast } = useToast();
  const importTrades = useImportTrades();
  // Imported trades join whichever book you are currently looking at.
  const { activeStyleId } = useStyleFilter();

  // Adopt rows handed in from a paste, replacing anything from a previous open.
  useEffect(() => {
    if (open && seedRows?.length) {
      setShotRows(seedRows);
      setEdits({});
      setExcluded({});
    }
  }, [open, seedRows]);

  const parsed = useMemo(() => parseImport(text), [text]);

  // Manual corrections are keyed by index and layered over the parse, so
  // retyping the paste does not silently discard them mid-edit.
  const rows: Row[] = useMemo(
    () =>
      [...shotRows, ...parsed.candidates].map((c, i) => ({
        ...c,
        ...edits[i],
        include: !excluded[i],
      })),
    [shotRows, parsed.candidates, edits, excluded],
  );

  const selected = rows.filter((r) => r.include);
  // A row is only importable once it has the two things a pending trade needs.
  const blocked = selected.filter((r) => !r.symbol || r.size == null || r.size <= 0);
  const ready = selected.filter((r) => r.symbol && r.size != null && r.size > 0);

  function reset() {
    setText("");
    setShotRows([]);
    setEdits({});
    setExcluded({});
  }

  /**
   * Read an orders-table screenshot as many rows. The AI returns the same shape
   * the text parser emits, so everything downstream — preview, per-row edits,
   * commit — is shared.
   */
  async function scanImage(file: File) {
    setScanning(true);
    try {
      const res = await parseScreenshot(await fileToDownscaledDataUrl(file), "orders");
      const mapped: ImportCandidate[] = (res.orders ?? [])
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
          source: "binance-orders",
          raw: "(from screenshot)",
          warnings: [
            ...(o.initialStop == null ? ["No stop in the screenshot — add it when it fills."] : []),
            ...(o.symbol ? [] : ["Symbol unreadable — set it before importing."]),
          ],
        }));
      setShotRows(mapped);
      if (!mapped.length) {
        toast({
          title: "No orders found in that image",
          description: "Paste the table as text instead, or try a clearer screenshot.",
          variant: "destructive",
        });
      } else {
        toast({ title: `Read ${mapped.length} orders from the screenshot` });
      }
    } catch (err: any) {
      toast({
        title: "Couldn't read that screenshot",
        description: String(err?.message ?? err).slice(0, 160),
        variant: "destructive",
      });
    } finally {
      setScanning(false);
    }
  }

  async function commit() {
    if (!ready.length) return;
    try {
      const res = await importTrades.mutateAsync({
        styleId: activeStyleId,
        trades: ready.map((r) => ({
          symbol: r.symbol,
          direction: r.direction,
          size: r.size as number,
          sizeUnit: r.sizeUnit,
          entryPrice: r.entryPrice,
          initialStop: r.initialStop,
          initialTarget: r.initialTarget,
          entryTime: r.entryTime,
        })),
      });
      toast({
        title: `Imported ${res.imported} pending ${res.imported === 1 ? "trade" : "trades"}`,
        description: "Add rationale to each one as it fills.",
      });
      reset();
      onClose();
    } catch (err: any) {
      toast({
        title: "Import failed",
        description: String(err?.message ?? err),
        variant: "destructive",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ClipboardPaste className="h-4 w-4" />
            Import resting orders
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <label
            className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border p-3 text-[11px] text-muted-foreground transition-colors hover:border-primary/50"
            data-testid="label-import-screenshot"
          >
            {scanning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Camera className="h-3.5 w-3.5" />
            )}
            {scanning ? "Reading orders…" : "Drop a screenshot of your orders table"}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) scanImage(f);
              }}
            />
          </label>

          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={PLACEHOLDER}
            className="h-32 font-mono text-[11px]"
            data-testid="input-import-paste"
          />

          {rows.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <Badge variant="secondary" className="font-mono">
                {ready.length} ready
              </Badge>
              {blocked.length > 0 && (
                <Badge variant="destructive" className="font-mono">
                  {blocked.length} need a symbol or size
                </Badge>
              )}
              {parsed.rejected.length > 0 && (
                <Badge variant="outline" className="font-mono">
                  {parsed.rejected.length} unrecognised
                </Badge>
              )}
              {rows[0] && (
                <span className="text-muted-foreground">
                  detected {rows[0].source.replace("-", " ")}
                </span>
              )}
            </div>
          )}

          {rows.length > 0 && (
            <div className="space-y-2">
              {rows.map((r, i) => (
                <Card
                  key={i}
                  className={`p-3 ${r.include ? "" : "opacity-40"}`}
                  data-testid={`row-import-${i}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="checkbox"
                      checked={r.include}
                      onChange={(e) =>
                        setExcluded((p) => ({ ...p, [i]: !e.target.checked }))
                      }
                      className="h-3.5 w-3.5 accent-primary"
                      aria-label="Include this row"
                    />

                    {r.direction === "long" ? (
                      <ArrowUpRight className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <ArrowDownRight className="h-3.5 w-3.5 text-red-500" />
                    )}

                    <Input
                      value={r.symbol}
                      onChange={(e) =>
                        setEdits((p) => ({
                          ...p,
                          [i]: { ...p[i], symbol: e.target.value.toUpperCase() },
                        }))
                      }
                      placeholder="SYMBOL"
                      className={`h-7 w-28 font-mono text-[11px] ${
                        r.symbol ? "" : "border-destructive"
                      }`}
                    />

                    <span className="font-mono text-[11px] text-muted-foreground">
                      @ {num(r.entryPrice, 6)}
                    </span>

                    <span className="font-mono text-[11px]">
                      {num(r.size, 4)}
                      <span className="ml-1 text-muted-foreground">
                        {r.sizeUnit === "quote" ? "USD" : "ct"}
                      </span>
                    </span>

                    <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                      stop {num(r.initialStop, 6)} · target {num(r.initialTarget, 6)}
                    </span>
                  </div>

                  {r.warnings.length > 0 && r.include && (
                    <ul className="mt-1.5 space-y-0.5 pl-6">
                      {r.warnings.map((w, k) => (
                        <li key={k} className="text-[10px] text-muted-foreground">
                          {w}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              ))}
            </div>
          )}

          {parsed.rejected.length > 0 && (
            <details className="text-[11px]">
              <summary className="cursor-pointer text-muted-foreground">
                {parsed.rejected.length} line(s) not recognised
              </summary>
              <ul className="mt-1 space-y-1">
                {parsed.rejected.map((x, i) => (
                  <li key={i} className="font-mono text-[10px] text-muted-foreground">
                    {x.reason}: {x.raw.slice(0, 90)}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={commit}
              disabled={!ready.length || importTrades.isPending}
              data-testid="button-import-commit"
            >
              {importTrades.isPending && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              Import {ready.length || ""} as pending
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
