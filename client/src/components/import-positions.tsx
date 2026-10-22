import { useMemo, useState } from "react";
import { DateTime24 } from "@/components/trade-shared";
import { ArrowDownRight, ArrowUpRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { AccountPicker } from "@/components/trade-pickers";
import { useImportPositions, useTrades } from "@/lib/data";
import { useStyleFilter } from "@/lib/style-filter";
import { store } from "@/lib/scoped-storage";
import { oneRTarget } from "@shared/default-target";
import type { PositionRow } from "@shared/positions-read";
import { maskIfQuote } from "@shared/redact";
import { fmtAmount } from "@shared/metrics";

/**
 * A Positions tab, as the open trades it lists.
 *
 * Several positions opened together are usually one idea — long BTC, and a
 * few smaller, higher-beta coins on the same thesis — so the idea, the
 * account and the time are asked once for the batch, and each row carries
 * only what differs: instrument, size, entry, stop, target. The stop is
 * required; a blank target becomes 1R when the trade is saved.
 */

/** Same key the entry card remembers its account under. */
const ACCOUNT_KEY = "edgeline.lastAccount";

const localNow = () => {
  const d = new Date();
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

const fmt = (n: number | null | undefined, dp?: number) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : dp == null
      ? String(n)
      : n.toLocaleString(undefined, { maximumFractionDigits: dp, minimumFractionDigits: dp });

const level = (s: string): number | null => {
  const n = Number(s.replace(/,/g, "").trim());
  return s.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n;
};

/** Dollars lost at the stop. A quote size is the notional, so it scales by the move. */
function riskDollars(r: { size: number; sizeUnit: string; entryPrice: number }, stop: number | null) {
  if (stop == null) return null;
  const move = Math.abs(r.entryPrice - stop);
  return r.sizeUnit === "quote" ? (r.size * move) / r.entryPrice : r.size * move;
}

export function PositionsReview({
  positions,
  onDone,
  onBack,
}: {
  positions: PositionRow[];
  onDone: () => void;
  onBack: () => void;
}) {
  const { toast } = useToast();
  const importPositions = useImportPositions();
  const { activeStyleId, activeAccount } = useStyleFilter();
  const { data: allTrades = [] } = useTrades();
  const knownAccounts = useMemo(
    () => Array.from(new Set(allTrades.map((t) => t.account?.trim()).filter(Boolean) as string[])).sort(),
    [allTrades],
  );
  const [account, setAccount] = useState(() => activeAccount || store.get(ACCOUNT_KEY) || "");
  const [idea, setIdea] = useState("");
  const [openedAt, setOpenedAt] = useState(localNow);
  const [rows, setRows] = useState(() =>
    positions.map((p) => ({
      ...p,
      include: true,
      stop: p.initialStop == null ? "" : String(p.initialStop),
      target: p.initialTarget == null ? "" : String(p.initialTarget),
    })),
  );
  const put = (i: number, patch: Partial<(typeof rows)[number]>) =>
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  const read = rows.map((r) => {
    const stop = level(r.stop);
    const target = level(r.target);
    const wrongStop =
      stop != null && (r.direction === "long" ? stop >= r.entryPrice : stop <= r.entryPrice);
    const wrongTarget =
      target != null && (r.direction === "long" ? target <= r.entryPrice : target >= r.entryPrice);
    const fallback = oneRTarget({ direction: r.direction, entryPrice: r.entryPrice, initialStop: stop });
    const risk = riskDollars(r, wrongStop ? null : stop);
    const rr = stop != null && target != null && !wrongStop ? Math.abs(target - r.entryPrice) / Math.abs(r.entryPrice - stop) : null;
    return { stop, target, wrongStop, wrongTarget, fallback, risk, rr, ok: stop != null && !wrongStop && !wrongTarget };
  });
  const chosen = rows.map((r, i) => ({ r, x: read[i] })).filter(({ r }) => r.include);
  const ready = chosen.filter(({ x }) => x.ok);
  const blocked = chosen.length - ready.length;
  const totalRisk = ready.reduce((s, { x }) => s + (x.risk ?? 0), 0);

  async function commit() {
    if (!ready.length || blocked) return;
    try {
      const res = await importPositions.mutateAsync({
        styleId: activeStyleId,
        account: account.trim() || null,
        rationale: idea.trim() || null,
        entryTime: openedAt ? new Date(openedAt).toISOString() : null,
        positions: ready.map(({ r, x }) => ({
          symbol: r.symbol,
          direction: r.direction,
          size: r.size,
          sizeUnit: r.sizeUnit,
          entryPrice: r.entryPrice,
          initialStop: x.stop as number,
          initialTarget: x.target,
        })),
      });
      if (account.trim()) store.set(ACCOUNT_KEY, account.trim());
      toast({
        title: `Opened ${res.imported} ${res.imported === 1 ? "trade" : "trades"}`,
        description: res.skipped.length
          ? `${res.skipped.join(", ")} already open in the journal — skipped.`
          : idea.trim()
            ? undefined
            : "Add the idea behind them on any one of the trades.",
      });
      onDone();
    } catch (err: any) {
      toast({ title: "Import failed", description: String(err?.message ?? err).slice(0, 200), variant: "destructive" });
    }
  }

  return (
    <div className="min-w-0 space-y-3" data-testid="positions-review">
      <p className="text-[11px] text-muted-foreground">
        {positions.length} open {positions.length === 1 ? "position" : "positions"} read. Each becomes an
        open trade; a blank target is set at 1R.
      </p>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[640px] text-[11px]">
          <thead className="bg-muted/40 text-left text-[10px] text-muted-foreground">
            <tr>
              <th className="w-6 p-2" />
              <th className="p-2 font-normal">Symbol</th>
              <th className="p-2 font-normal">Size</th>
              <th className="p-2 font-normal">Entry</th>
              <th className="p-2 font-normal">Stop</th>
              <th className="p-2 font-normal">Target</th>
              <th className="p-2 text-right font-normal">Risk</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const x = read[i];
              return (
                <tr
                  key={`${r.symbol}-${r.entryPrice}-${i}`}
                  className={`border-t border-border align-top ${r.include ? "" : "opacity-40"}`}
                  data-testid={`row-position-${i}`}
                >
                  <td className="p-2">
                    <input
                      type="checkbox"
                      checked={r.include}
                      onChange={(e) => put(i, { include: e.target.checked })}
                      className="h-3.5 w-3.5 accent-primary"
                      aria-label={`Include ${r.symbol}`}
                    />
                  </td>
                  <td className="p-2">
                    <div className="flex items-center gap-1 font-mono font-semibold">
                      {r.direction === "long" ? (
                        <ArrowUpRight className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <ArrowDownRight className="h-3.5 w-3.5 text-red-500" />
                      )}
                      {r.symbol}
                      {r.leverage != null && (
                        <span className="font-normal text-muted-foreground">{r.leverage}x</span>
                      )}
                    </div>
                    {r.include && r.warnings.length > 0 && (
                      <ul className="mt-1 max-w-[220px] space-y-0.5">
                        {/* "No stop on the screen" is answered once one is typed. */}
                        {r.warnings.filter((w) => x.stop == null || !/^No stop/.test(w)).map((w, k) => (
                          <li key={k} className="text-[10px] leading-snug text-muted-foreground">
                            {w}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="p-2 font-mono">
                    {maskIfQuote(r.sizeUnit, fmt(r.size, r.sizeUnit === "quote" ? 2 : undefined))}
                    <span className="ml-1 text-muted-foreground">{r.sizeUnit === "quote" ? "USD" : "units"}</span>
                  </td>
                  <td className="p-2 font-mono">{fmt(r.entryPrice)}</td>
                  <td className="p-2">
                    <Input
                      value={r.stop}
                      onChange={(e) => put(i, { stop: e.target.value })}
                      inputMode="decimal"
                      placeholder="required"
                      className={`h-7 w-24 font-mono text-[11px] ${
                        r.include && (x.stop == null || x.wrongStop) ? "border-destructive" : ""
                      }`}
                      data-testid={`input-position-stop-${i}`}
                    />
                    {r.include && x.wrongStop && (
                      <p className="mt-0.5 text-[10px] text-destructive">Profit side of the entry</p>
                    )}
                  </td>
                  <td className="p-2">
                    <Input
                      value={r.target}
                      onChange={(e) => put(i, { target: e.target.value })}
                      inputMode="decimal"
                      placeholder={x.fallback != null ? `1R · ${x.fallback}` : "1R"}
                      className={`h-7 w-36 font-mono text-[11px] ${r.include && x.wrongTarget ? "border-destructive" : ""}`}
                      data-testid={`input-position-target-${i}`}
                    />
                    {r.include && x.wrongTarget && (
                      <p className="mt-0.5 text-[10px] text-destructive">Losing side of the entry</p>
                    )}
                  </td>
                  <td className="p-2 text-right font-mono">
                    {x.risk != null ? fmtAmount(x.risk, 2) : "—"}
                    <div className="text-[10px] text-muted-foreground">
                      {x.rr != null ? `${fmt(x.rr, 1)}R target` : x.stop != null && !x.wrongStop ? "1R target" : ""}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {ready.length > 1 && (
            <tfoot>
              <tr className="border-t border-border text-muted-foreground">
                <td colSpan={6} className="p-2 text-right text-[10px]">
                  Risk across the {ready.length}, if every stop is hit
                </td>
                <td className="p-2 text-right font-mono text-foreground" data-testid="text-positions-total-risk">
                  {fmtAmount(totalRisk, 2)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">Account</p>
          <AccountPicker value={account} onChange={setAccount} known={knownAccounts} testIdPrefix="positions-account" />
        </div>
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">Opened at</p>
          <DateTime24 value={openedAt} onChange={setOpenedAt} testId="input-positions-opened" />
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-[11px] text-muted-foreground">The idea behind them — saved on every one</p>
        <Textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="e.g. Bullish crypto into the weekly open: BTC as the core, smaller size on higher-beta alts for the upside."
          className="h-16 text-[11px]"
          data-testid="input-positions-idea"
        />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
        {blocked > 0 && (
          <span className="mr-auto text-[11px] text-destructive">
            {blocked} {blocked === 1 ? "row needs" : "rows need"} a stop on the losing side
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={onBack} data-testid="button-positions-back">
          Back
        </Button>
        <Button
          size="sm"
          onClick={commit}
          disabled={!ready.length || blocked > 0 || importPositions.isPending}
          data-testid="button-positions-commit"
        >
          {importPositions.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Open {ready.length || ""} {ready.length === 1 ? "trade" : "trades"}
        </Button>
      </div>
    </div>
  );
}
