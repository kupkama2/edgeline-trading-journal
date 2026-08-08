/**
 * One trade, in full — the single place a trade is ever looked at.
 *
 * Every route into a trade (a bar on the excursion chart, a point on the
 * dashboard curve, a row in the journal or on a day) lands here, so what you
 * see never depends on how you arrived. It replaced a dialog for exactly that
 * reason: a dialog is a peek that dies on Escape and can't be linked to or
 * come back to, and half the routes here were opening a different, smaller
 * view of the same row.
 *
 * Everything on the page reads from the live list by id, so an edit made in
 * the dialog above (or a fill removed below) is reflected the moment the
 * mutation lands.
 */
import { useMemo, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  ClipboardList,
  Minus,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useDeleteFill, useDeleteTrade, useMistakeTags, useTrades } from "@/lib/data";
import { parseExtraTargets, parsePlaybook, type TradeWithTags } from "@shared/schema";
import { computeMetrics, fmtFees, fmtMoney, fmtR, EXIT_REASON_LABELS } from "@shared/metrics";
import { positionLedger } from "@shared/fills";
import { parseHighlights } from "@shared/highlights";
import { StyleChip } from "@/components/style-switcher";
import { TradeImageGallery } from "@/components/trade-images";
import { RationaleTags, num, parseTags } from "@/components/trade-shared";
import { CloseTradeDialog, EditTradeDialog } from "@/components/trade-dialogs";
import { FillDialog } from "@/components/fill-dialog";
import { ResolveTradeDialog } from "@/components/resolve-trade";

/** Small labelled figure; the page is mostly these. */
function Fig({
  label,
  value,
  hint,
  tone,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "good" | "bad";
  testId?: string;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={`font-mono text-sm ${
          tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-primary" : ""
        }`}
        data-testid={testId}
      >
        {value}
      </p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function TradeView() {
  const [, params] = useRoute("/trade/:id");
  const [, navigate] = useLocation();
  const id = Number(params?.id);
  const { data: trades, isLoading } = useTrades();
  const { data: tags = [] } = useMistakeTags();
  const deleteFill = useDeleteFill();
  const deleteTrade = useDeleteTrade();

  const [editing, setEditing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [filling, setFilling] = useState<"add" | "partial" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const trade = useMemo(
    () => (trades ?? []).find((t) => t.id === id) ?? null,
    [trades, id],
  );
  const tagNames = useMemo(
    () => Object.fromEntries(tags.map((t) => [t.id, t.name])),
    [tags],
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!trade) {
    return (
      <Card className="border-dashed border-border bg-card/40 p-8 text-center">
        <p className="text-sm">That trade is gone.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          It was deleted, or the link points at an id that never existed.
        </p>
        <Link href="/">
          <Button variant="outline" size="sm" className="mt-4" data-testid="button-back-journal">
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Back to the journal
          </Button>
        </Link>
      </Card>
    );
  }

  const m = computeMetrics(trade);
  const led = positionLedger(trade);
  const tps = [trade.initialTarget, ...parseExtraTargets(trade.extraTargets)].filter(
    (x): x is number => x != null,
  );
  const highlights = parseHighlights(trade.highlights);
  const playbook = parsePlaybook(trade.playbook);
  const playbookRows: [string, string][] = playbook
    ? ([
        ["Setup", playbook.setupName],
        ["Stop logic", playbook.stopLogic],
        ["Target logic", playbook.targetLogic],
        ["Confidence", playbook.confidence ? `${playbook.confidence} / 5` : undefined],
        ["Stand aside if", playbook.standAside],
      ].filter(([, v]) => v && String(v).trim()) as [string, string][])
    : [];
  const win = (m.actualR ?? 0) >= 0;
  const plannedRr =
    trade.initialStop != null && trade.initialTarget != null
      ? Math.abs(trade.initialTarget - trade.entryPrice) /
        Math.abs(trade.entryPrice - trade.initialStop)
      : null;

  return (
    <div className="space-y-4" data-testid={`page-trade-${trade.id}`}>
      {/* ------------------------------ header ------------------------------ */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-muted-foreground"
          onClick={() => window.history.back()}
          data-testid="button-back"
        >
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
          Back
        </Button>
        <span
          className={`flex h-7 w-7 items-center justify-center rounded ${
            trade.direction === "long"
              ? "bg-emerald-500/15 text-emerald-400"
              : "bg-primary/15 text-primary"
          }`}
        >
          {trade.direction === "long" ? (
            <ArrowUpRight className="h-4 w-4" />
          ) : (
            <ArrowDownRight className="h-4 w-4" />
          )}
        </span>
        <h1 className="font-mono text-xl font-bold tracking-tight">{trade.symbol}</h1>
        <Badge variant="outline" className="text-[10px] uppercase">
          {trade.status}
        </Badge>
        <StyleChip styleId={trade.styleId} />
        {trade.account && (
          <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
            {trade.account}
          </Badge>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {trade.status === "open" && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-[11px]"
                onClick={() => setFilling("partial")}
                data-testid="button-view-partial"
              >
                <Minus className="mr-1 h-3 w-3" /> Take
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-[11px]"
                onClick={() => setFilling("add")}
                data-testid="button-view-add"
              >
                <Plus className="mr-1 h-3 w-3" /> Add
              </Button>
              <Button
                size="sm"
                className="h-8 text-[11px]"
                onClick={() => setClosing(true)}
                data-testid="button-view-close"
              >
                Close trade
              </Button>
            </>
          )}
          {(trade.status === "open" || trade.status === "pending") && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={() => setResolving(true)}
              aria-label="Never became a position"
              data-testid="button-view-resolve"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-[11px]"
            onClick={() => setEditing(true)}
            data-testid="button-view-edit"
          >
            <Pencil className="mr-1 h-3 w-3" /> Edit
          </Button>
          {confirmDelete ? (
            <Button
              variant="destructive"
              size="sm"
              className="h-8 text-[11px]"
              onClick={async () => {
                await deleteTrade.mutateAsync(trade.id);
                navigate("/");
              }}
              data-testid="button-view-delete-confirm"
            >
              Delete for good?
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
              aria-label="Delete trade"
              data-testid="button-view-delete"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* ------------------------------ result ------------------------------ */}
      <Card className="border-card-border bg-card p-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
          <Fig
            label="Result"
            value={trade.status === "closed" ? fmtR(m.actualR) : "—"}
            hint={trade.status === "closed" ? EXIT_REASON_LABELS[trade.exitReason ?? "other"] : "still running"}
            tone={trade.status === "closed" ? (win ? "good" : "bad") : undefined}
            testId="view-actual-r"
          />
          <Fig
            label={m.fees > 0 ? "Net P&L" : "P&L"}
            value={trade.status === "closed" ? fmtMoney(m.actualPnL) : "—"}
            hint={m.fees > 0 ? `${fmtMoney(m.grossPnL)} gross − ${fmtFees(m.fees)}` : undefined}
            tone={trade.status === "closed" ? (win ? "good" : "bad") : undefined}
            testId="view-pnl"
          />
          <Fig label="1R" value={`$${num(m.riskDollars, 0)}`} hint={`${num(m.risk)} pts`} />
          <Fig
            label="Planned R:R"
            value={plannedRr != null ? num(plannedRr, 1) : "—"}
            hint={tps.length > 1 ? `${tps.length} targets` : undefined}
          />
          <Fig
            label="Best reach"
            value={m.mfeR != null ? fmtR(m.mfeR) : "—"}
            hint={m.captureRatio != null ? `kept ${Math.round(m.captureRatio * 100)}%` : "no path logged"}
          />
          <Fig
            label="Worst dip"
            value={m.maeR != null ? fmtR(m.maeR) : "—"}
            hint="heat taken"
          />
        </div>
      </Card>

      {/* ------------------------------ the plan ---------------------------- */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="border-card-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold tracking-tight">The plan</h2>
          <div className="grid grid-cols-2 gap-3 font-mono text-sm sm:grid-cols-4">
            <Fig label="Entry" value={num(trade.entryPrice)} testId="view-entry" />
            <Fig
              label="Stop"
              value={<span className="text-primary">{num(trade.initialStop)}</span>}
            />
            <Fig
              label={tps.length > 1 ? "Targets" : "Target"}
              value={
                <span className="text-emerald-400" data-testid="view-targets">
                  {tps.map((x) => num(x)).join(" → ") || "—"}
                </span>
              }
            />
            <Fig
              label="Size"
              value={`${num(trade.size, 4)}${trade.sizeUnit === "quote" ? " USD" : ""}`}
              hint={trade.pointValue !== 1 ? `$${trade.pointValue}/pt` : undefined}
            />
            <Fig
              label="Entered"
              value={
                <span className="text-xs">
                  {new Date(trade.entryTime).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              }
            />
            {trade.exitTime && (
              <Fig
                label="Exited"
                value={
                  <span className="text-xs">
                    {new Date(trade.exitTime).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                }
              />
            )}
            {trade.exitPrice != null && <Fig label="Exit" value={num(trade.exitPrice)} />}
          </div>

          {playbookRows.length > 0 && (
            <div className="mt-4" data-testid="view-playbook">
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
        </Card>

        {/* --------------------------- how it went -------------------------- */}
        <Card className="border-card-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold tracking-tight">How it was worked</h2>

          {trade.fills.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              One entry, one exit — no scaling logged.
              {trade.status === "open" && " Use Take or Add above to record a partial."}
            </p>
          ) : (
            <>
              <ul className="space-y-1" data-testid="view-fills">
                {[...trade.fills]
                  .sort((a, b) => a.time.localeCompare(b.time))
                  .map((f) => (
                    <li
                      key={f.id}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-xs"
                      data-testid={`view-fill-${f.id}`}
                    >
                      <Badge
                        variant="outline"
                        className={`shrink-0 text-[10px] font-normal ${
                          f.kind === "add"
                            ? "border-sky-500/40 text-sky-400"
                            : "border-emerald-500/40 text-emerald-400"
                        }`}
                      >
                        {f.kind === "add" ? "added" : "took"}
                      </Badge>
                      <span className="font-mono">
                        {num(f.size, 4)}
                        {trade.sizeUnit === "quote" ? " USD" : ""} @ {num(f.price, 4)}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {new Date(f.time).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {f.note ? ` · ${f.note}` : ""}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="ml-auto h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteFill.mutate(f.id)}
                        disabled={deleteFill.isPending}
                        aria-label="Remove this fill"
                        data-testid={`button-view-delete-fill-${f.id}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </li>
                  ))}
              </ul>
              <p className="mt-2 font-mono text-[11px] text-muted-foreground" data-testid="view-ledger">
                avg entry {num(led.avgEntry, 4)}
                {trade.status === "open" && ` · ${num(led.openQty, 4)} still on`} ·{" "}
                {fmtMoney(led.realizedPnL)} banked before the close
              </p>
            </>
          )}

          {(trade.mistakeTagIds.length > 0 || highlights.length > 0) && (
            <div className="mt-4 space-y-2">
              {trade.mistakeTagIds.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Demons
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {trade.mistakeTagIds.map((tid) => (
                      <Badge
                        key={tid}
                        variant="outline"
                        className="border-primary/40 text-[10px] font-normal text-primary"
                      >
                        {tagNames[tid] ?? "?"}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {highlights.length > 0 && (
                <div data-testid="view-highlights">
                  <p className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <Sparkles className="h-3 w-3 text-emerald-400" />
                    What went right
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {highlights.map((h) => (
                      <Badge
                        key={h}
                        variant="outline"
                        className="border-emerald-500/40 text-[10px] font-normal text-emerald-400"
                      >
                        {h}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* ---------------------------- the words ----------------------------- */}
      {(trade.rationale || trade.notes) && (
        <Card className="border-card-border bg-card p-4">
          {trade.rationale && (
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Rationale
              </p>
              <p className="text-xs">{trade.rationale}</p>
              <RationaleTags tags={parseTags(trade.rationaleTags)} />
            </div>
          )}
          {trade.notes && (
            <div className={trade.rationale ? "mt-3" : ""}>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Notes
              </p>
              <p className="whitespace-pre-wrap text-xs">{trade.notes}</p>
            </div>
          )}
        </Card>
      )}

      {/* ---------------------------- the charts ---------------------------- */}
      {/* The gallery labels itself, so this card carries no heading of its own. */}
      <Card className="border-card-border bg-card p-4">
        <TradeImageGallery tradeId={trade.id} />
      </Card>

      <EditTradeDialog trade={editing ? trade : null} onClose={() => setEditing(false)} />
      <CloseTradeDialog trade={closing ? trade : null} onClose={() => setClosing(false)} />
      <ResolveTradeDialog trade={resolving ? trade : null} onClose={() => setResolving(false)} />
      <FillDialog
        trade={filling ? trade : null}
        kind={filling ?? "partial"}
        onClose={() => setFilling(null)}
      />
    </div>
  );
}
