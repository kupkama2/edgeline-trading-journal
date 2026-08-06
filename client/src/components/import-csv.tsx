import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { FileUp, Loader2, TriangleAlert } from "lucide-react";
import { parseTradeCsv } from "@shared/csv";
import { useImportCsv } from "@/lib/data";
import { useStyleFilter } from "@/lib/style-filter";

/**
 * Backfill from a broker's CSV.
 *
 * The paste importer loads orders that haven't happened yet; this loads trading
 * that already did — the history from before this journal existed. Parsing runs
 * in the browser against the same module the server would use, so the preview
 * is the payload rather than a guess about it.
 *
 * Column names are matched loosely on purpose. Every venue spells the same
 * eight ideas differently, and a file that fails to import because it says
 * "Avg Fill Price" instead of "Entry Price" is a file the trader gives up on.
 */

const FIELD_LABELS: Record<string, string> = {
  symbol: "symbol",
  direction: "side",
  size: "size",
  entryPrice: "entry price",
  initialStop: "stop",
  exitPrice: "exit price",
  entryTime: "timestamp",
};

/** What each missing column actually costs, so the warning is worth reading. */
const MISSING_COST: Record<string, string> = {
  initialStop: "no stop means no R — these land as P&L-only history",
  exitPrice: "no exit price means they import as still-open positions",
  entryTime: "no timestamp means today's date, which breaks time-of-day stats",
};

export function ImportCsvDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const { toast } = useToast();
  const importCsv = useImportCsv();
  const { activeStyleId } = useStyleFilter();

  const parsed = useMemo(() => (text.trim() ? parseTradeCsv(text) : null), [text]);

  function reset() {
    setText("");
    setFileName(null);
  }

  async function readFile(file: File) {
    setFileName(file.name);
    setText(await file.text());
  }

  async function commit() {
    if (!parsed?.rows.length) return;
    try {
      const res = await importCsv.mutateAsync({
        styleId: activeStyleId,
        trades: parsed.rows.map((r) => ({
          symbol: r.symbol,
          direction: r.direction,
          size: r.size,
          entryPrice: r.entryPrice,
          initialStop: r.initialStop,
          initialTarget: r.initialTarget,
          exitPrice: r.exitPrice,
          entryTime: r.entryTime,
          exitTime: r.exitTime,
          notes: r.notes,
        })),
      });
      toast({
        title: `Imported ${res.imported} ${res.imported === 1 ? "trade" : "trades"}`,
        description: "They join your history and every stat that reads it.",
      });
      reset();
      onClose();
    } catch (err: any) {
      toast({
        title: "Import failed",
        description: String(err?.message ?? err).slice(0, 200),
        variant: "destructive",
      });
    }
  }

  const blocking = parsed?.missingFields.filter((f) => MISSING_COST[f]) ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <FileUp className="h-4 w-4" />
            Import trade history
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <label
            className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border p-3 text-[11px] text-muted-foreground transition-colors hover:border-primary/50"
            data-testid="label-csv-file"
          >
            <FileUp className="h-3.5 w-3.5" />
            {fileName ?? "Choose a .csv exported from your broker"}
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) readFile(f);
              }}
            />
          </label>

          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setFileName(null);
            }}
            placeholder={"…or paste the CSV directly.\n\nSymbol,Side,Qty,Avg Fill Price,Close Price,Stop Loss,Time\nMNQU6,Buy,2,29307.75,29359.00,29266.50,2026-08-06 09:30:00"}
            className="h-28 font-mono text-[11px]"
            data-testid="input-csv-paste"
          />

          {parsed && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <Badge variant="secondary" className="font-mono" data-testid="badge-csv-ready">
                  {parsed.rows.length} ready
                </Badge>
                {parsed.skipped.length > 0 && (
                  <Badge variant="destructive" className="font-mono">
                    {parsed.skipped.length} skipped
                  </Badge>
                )}
                {parsed.unmapped.length > 0 && (
                  <Badge variant="outline" className="font-mono">
                    {parsed.unmapped.length} columns ignored
                  </Badge>
                )}
              </div>

              {blocking.length > 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
                  <div className="mb-1 flex items-center gap-1.5">
                    <TriangleAlert className="h-3 w-3 text-amber-500" />
                    <span className="text-[11px] font-semibold">
                      This file is missing some columns
                    </span>
                  </div>
                  <ul className="space-y-0.5 pl-4">
                    {blocking.map((f) => (
                      <li key={f} className="list-disc text-[10px] leading-snug">
                        No <span className="font-mono">{FIELD_LABELS[f] ?? f}</span> column —{" "}
                        {MISSING_COST[f]}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {parsed.rows.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    First {Math.min(5, parsed.rows.length)} of {parsed.rows.length}
                  </p>
                  {parsed.rows.slice(0, 5).map((r, i) => (
                    <Card key={i} className="p-2" data-testid={`csv-row-${i}`}>
                      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                        <span
                          className={
                            r.direction === "long" ? "text-emerald-500" : "text-red-500"
                          }
                        >
                          {r.direction === "long" ? "▲" : "▼"}
                        </span>
                        <span className="font-semibold">{r.symbol}</span>
                        <span className="text-muted-foreground">{r.size} @ {r.entryPrice}</span>
                        <span className="text-muted-foreground">
                          stop {r.initialStop ?? "—"} · exit {r.exitPrice ?? "—"}
                        </span>
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {new Date(r.entryTime).toLocaleString()}
                        </span>
                      </div>
                    </Card>
                  ))}
                </div>
              )}

              {parsed.skipped.length > 0 && (
                <details className="text-[11px]">
                  <summary className="cursor-pointer text-muted-foreground">
                    {parsed.skipped.length} row(s) skipped
                  </summary>
                  <ul className="mt-1 space-y-0.5">
                    {parsed.skipped.slice(0, 20).map((s, i) => (
                      <li key={i} className="font-mono text-[10px] text-muted-foreground">
                        line {s.line}: {s.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={commit}
              disabled={!parsed?.rows.length || importCsv.isPending}
              data-testid="button-csv-commit"
            >
              {importCsv.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Import {parsed?.rows.length || ""}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
