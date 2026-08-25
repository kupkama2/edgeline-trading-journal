import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  candidateKey,
  dropBracketLegs,
  mergeCandidates,
  parseImport,
  pruneWarnings,
  type ImportCandidate,
} from "@shared/import-parse";
import { fileToDownscaledDataUrl, parseScreenshot, useImportTrades } from "@/lib/data";
import { FillLogReview } from "@/components/import-fills";
import type { LoggedFill } from "@shared/order-log";
import { useStyleFilter } from "@/lib/style-filter";

/**
 * Paste-import for resting orders.
 *
 * Parsing runs in the browser against the same module the server uses, so the
 * preview is not a guess about what will be imported — it *is* the payload,
 * edited and then sent. Rows land as pending trades, which is the point: you
 * see how many positions could open, then add rationale one at a time.
 */

/** The log rows complete enough to place in a position walk. */
function readableFills(rows: { symbol: string | null; side: string | null; qty: number | null; price: number | null; time: string | null; kind: string | null; stopPrice: number | null }[]): LoggedFill[] {
  return rows
    .filter((f) => f.symbol && (f.side === "buy" || f.side === "sell") && f.qty && f.price && f.time)
    .map((f) => ({
      symbol: f.symbol!,
      side: f.side as "buy" | "sell",
      kind: f.kind,
      qty: f.qty!,
      price: f.price!,
      time: f.time!,
      stopPrice: f.stopPrice,
    }));
}

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
  // A filled-order log, kept separately: it becomes completed trades with legs
  // rather than resting orders, so it has nothing to merge with above.
  const [logRows, setLogRows] = useState<LoggedFill[] | null>(null);
  // The last image scanned, so either reading can be asked for again without
  // making the trader find and re-paste the screenshot.
  const [lastShot, setLastShot] = useState<string | null>(null);
  /*
   * What to read the next screenshot as.
   *
   * Auto works and is what most pastes should need, but it rests on a
   * judgement about the picture, and a judgement that goes the wrong way
   * costs a round trip and a moment of "why is it showing me that". Saying so
   * up front costs one click and cannot be wrong — so it is offered, and the
   * automatic reading stays the default rather than the only option.
   */
  const [mode, setMode] = useState<"auto" | "log" | "orders">("auto");
  /*
   * Read through a ref, because the paste listener is installed once and
   * captures the scanImage of the render that installed it. Picking a mode
   * re-renders without re-registering, so a plain read here would have been
   * the mode as it was when the dialog opened — which is to say "auto", every
   * time, no matter which chip was lit.
   */
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [scanning, setScanning] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Keyed by the order's identity rather than its row position: pasting a second
  // screen re-merges the list, and an index-keyed edit would slide onto the
  // neighbouring trade when a row folds away.
  const [edits, setEdits] = useState<Record<string, Partial<Row>>>({});
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});
  /*
   * What is currently TYPED in a level field, which is not the same as the
   * number it parses to. An input bound straight to the number can never accept
   * a decimal: "59." parses to 59, the field re-renders as "59", and the point
   * you just typed is gone before you can type the 3. The draft holds the text
   * until blur, at which point the canonical number takes over ("59.30" → 59.3).
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
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

  /**
   * Ctrl+V anywhere in the dialog reads a screenshot off the clipboard.
   *
   * The journal has its own window-level paste handler, but it deliberately
   * stands down while any dialog is open — "only the dropzone inside it should
   * claim the paste" — so without this, Ctrl+V in here hit nothing at all.
   *
   * Only image items are claimed. A text paste falls through untouched, which
   * is what keeps the textarea below working: the two are the same keystroke.
   */
  useEffect(() => {
    if (!open) return;

    function onPaste(e: ClipboardEvent) {
      if (scanning) return;
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

      e.preventDefault();
      scanImage(file);
    }

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // scanImage closes over nothing that changes between renders; `scanning` is
    // in here so a second paste cannot queue a scan on top of one in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scanning]);

  /** Re-read the screenshot already in hand as an execution log. */
  async function rereadAsLog() {
    if (!lastShot) return;
    setScanning(true);
    try {
      const log = await parseScreenshot(lastShot, "fills");
      const rows = readableFills(log.fills ?? []);
      if (rows.length) setLogRows(rows);
      else
        toast({
          title: "No filled orders in that screenshot",
          description: "Every row needs a side, a size, a price and a time to be placed in a position.",
          variant: "destructive",
        });
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

  const parsed = useMemo(() => parseImport(text), [text]);

  // Several views of one order — the table plus its Take Profit / Stop Loss
  // dialog — are folded together before anything is shown, so the preview
  // describes one trade rather than an order and an orphaned pair of levels.
  const { rows: base, merged } = useMemo(
    () => mergeCandidates([...shotRows, ...parsed.candidates]),
    [shotRows, parsed.candidates],
  );

  // Manual corrections are layered over the parse, so retyping the paste does
  // not silently discard them mid-edit — and a hand-typed level outranks one
  // matched from a later screen, because it was stated rather than inferred.
  const rows: Row[] = useMemo(
    () =>
      base.map((c) => {
        const k = candidateKey(c);
        const row = { ...c, ...edits[k], include: !excluded[k] };
        return { ...row, warnings: pruneWarnings(row) };
      }),
    [base, edits, excluded],
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
    setDrafts({});
  }

  /**
   * Read an orders screenshot as rows. The AI returns the same shape the text
   * parser emits, so everything downstream — preview, per-row edits, commit —
   * is shared.
   *
   * Scans accumulate rather than replace, which is what makes a second screen
   * useful: drop the orders table, then drop the Take Profit / Stop Loss dialog
   * for one of those orders and the merge attaches its levels to the right row.
   * Re-dropping the same table costs nothing, since identical orders fold too.
   */
  async function scanImage(file: File) {
    setScanning(true);
    try {
      const dataUrl = await fileToDownscaledDataUrl(file);
      setLastShot(dataUrl);

      /*
       * The execution log is read FIRST, because it is the commoner paste.
       *
       * It used to be second, reached only when the resting-orders read came
       * back empty — and it never was. Asked to ignore filled rows, that
       * prompt read a Tradovate "Filled" tab as nine resting orders anyway:
       * the rows have a symbol, a side, a quantity and a limit price, and
       * nothing about them refuses to be an order. So the fallback stayed
       * dark and a log of finished trades came out as positions about to
       * open.
       *
       * Order alone would only move the failure, so the reader now returns a
       * verdict on what it is looking at rather than leaving it to be
       * inferred from whether any rows survived. Emptiness is a poor
       * discriminator in both directions: a log whose rows were unreadable is
       * still a log, and reaching for the other reader there answers a
       * question nobody asked.
       */
      if (modeRef.current !== "orders") {
      const log = await parseScreenshot(dataUrl, "fills");
      // Told which it is, the verdict is not consulted: the trader is looking
      // at the screenshot and this is not.
      if (log.isExecutionLog || modeRef.current === "log") {
        const rows = readableFills(log.fills ?? []);
        if (rows.length) {
          setLogRows(rows);
        } else {
          toast({
            title: "That looks like a filled-order log, but nothing was readable",
            description: "Try a wider or sharper screenshot — every row needs its side, size, price and time.",
            variant: "destructive",
          });
        }
        return;
      }
      }

      const res = await parseScreenshot(dataUrl, "orders");

      // A bracketed order comes back as its parent plus two exit legs; listing
      // the legs would offer to import the take profit as a trade of its own.
      const mapped: ImportCandidate[] = dropBracketLegs(
        (res.orders ?? [])
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
            warnings: [
              ...(o.initialStop == null
                ? ["No stop in this screenshot — type one, or drop the TP/SL screen."]
                : []),
              ...(o.symbol ? [] : ["Symbol unreadable — set it before importing."]),
            ],
          })),
      );
      setShotRows((prev) => [...prev, ...mapped]);
      if (!mapped.length) {
        toast({
          title: "No orders found in that image",
          description: "Paste the table as text instead, or try a clearer screenshot.",
          variant: "destructive",
        });
      } else {
        const attached = mapped.filter((m) => m.initialStop != null || m.initialTarget != null);
        toast({
          title: `Read ${mapped.length} ${mapped.length === 1 ? "order" : "orders"} from the screenshot`,
          description: attached.length
            ? "Levels found — they'll attach to any matching resting order."
            : undefined,
        });
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
            {logRows ? "Trades from your order log" : "Import resting orders"}
          </DialogTitle>
        </DialogHeader>

        {/* An execution log is a different thing from a list of resting orders
            — completed trades with legs, not positions that might open — so it
            takes over the window rather than sharing it. The dropzone's other
            controls would all be about the wrong thing. */}
        {logRows ? (
          <div className="space-y-3">
            <FillLogReview
              fills={logRows}
              onDone={() => {
                setLogRows(null);
                onClose();
              }}
            />
            <Button
              type="button"
              variant="ghost"
              className="w-full text-[11px]"
              onClick={() => setLogRows(null)}
              data-testid="button-back-to-import"
            >
              That was not an order log — read it as resting orders
            </Button>
          </div>
        ) : (
        <div className="space-y-4">
          {/* What the next screenshot is, where the trader would rather say
              than have it worked out. */}
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="text-muted-foreground">Read the screenshot as</span>
            {(
              [
                ["auto", "whatever it is"],
                ["log", "filled trades"],
                ["orders", "resting orders"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                className={`rounded-full border px-2 py-0.5 transition-colors ${
                  mode === id
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:border-primary/40"
                }`}
                data-testid={`button-import-mode-${id}`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Three ways in, because a screenshot arrives three ways: dropped,
              pasted with Ctrl+V, or picked through the file dialog. */}
          <label
            className={`flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed p-3 text-[11px] text-muted-foreground transition-colors ${
              dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
            }`}
            data-testid="label-import-screenshot"
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f?.type.startsWith("image/")) scanImage(f);
            }}
          >
            {scanning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Camera className="h-3.5 w-3.5" />
            )}
            {scanning
              ? "Reading orders…"
              : shotRows.length
                ? "Drop or paste another screen — a TP/SL dialog attaches to its order"
                : "Drop or paste (Ctrl+V) a screenshot of your orders table"}
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
              {merged > 0 && (
                <Badge variant="secondary" className="font-mono" data-testid="badge-merged">
                  {merged} matched to an order
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
              {rows.map((r, i) => {
                const key = candidateKey(r);
                return (
                <Card
                  key={key}
                  className={`p-3 ${r.include ? "" : "opacity-40"}`}
                  data-testid={`row-import-${i}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="checkbox"
                      checked={r.include}
                      onChange={(e) =>
                        setExcluded((p) => ({ ...p, [key]: !e.target.checked }))
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
                          [key]: { ...p[key], symbol: e.target.value.toUpperCase() },
                        }))
                      }
                      placeholder="SYMBOL"
                      className={`h-7 w-28 font-mono text-[11px] ${
                        r.symbol ? "" : "border-destructive"
                      }`}
                    />

                    <span className="font-mono text-[11px] text-muted-foreground">
                      @ {num(r.entryPrice)}
                    </span>

                    <span className="font-mono text-[11px]">
                      {num(r.size)}
                      <span className="ml-1 text-muted-foreground">
                        {r.sizeUnit === "quote" ? "USD" : "ct"}
                      </span>
                    </span>

                    {/* Levels are editable because the view that lists an order
                        usually isn't the view that shows its bracket: type them
                        here, or drop the Take Profit / Stop Loss screen and let
                        it match on the limit price. */}
                    <div className="ml-auto flex items-center gap-1.5">
                      {(
                        [
                          ["initialStop", "stop"],
                          ["initialTarget", "target"],
                        ] as const
                      ).map(([field, label]) => {
                        const draftKey = `${key}:${field}`;
                        return (
                        <label key={field} className="flex items-center gap-1">
                          <span className="text-[10px] text-muted-foreground">{label}</span>
                          <Input
                            value={drafts[draftKey] ?? (r[field] == null ? "" : String(r[field]))}
                            onChange={(e) => {
                              const typed = e.target.value;
                              setDrafts((p) => ({ ...p, [draftKey]: typed }));
                              // A half-typed number ("59.", "-") is not yet a
                              // level, so the row holds null until it parses —
                              // which also keeps it out of the import.
                              const n = Number(typed.trim());
                              setEdits((p) => ({
                                ...p,
                                [key]: {
                                  ...p[key],
                                  [field]: typed.trim() === "" || !isFinite(n) ? null : n,
                                },
                              }));
                            }}
                            onBlur={() =>
                              setDrafts((p) => {
                                const { [draftKey]: _, ...rest } = p;
                                return rest;
                              })
                            }
                            placeholder="—"
                            inputMode="decimal"
                            className="h-7 w-24 font-mono text-[11px]"
                            data-testid={`input-${field}-${i}`}
                          />
                        </label>
                        );
                      })}
                    </div>
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
                );
              })}
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

          {/* The escape hatch in the other direction. The verdict on what a
              screenshot is will sometimes go the wrong way, and when it does
              the trader can see it instantly — so the fix should be one click
              and not a re-paste. */}
          {lastShot && (
            <Button
              type="button"
              variant="ghost"
              className="w-full text-[11px]"
              disabled={scanning}
              onClick={rereadAsLog}
              data-testid="button-read-as-log"
            >
              {scanning && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              These already filled — read them as completed trades
            </Button>
          )}
        </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
