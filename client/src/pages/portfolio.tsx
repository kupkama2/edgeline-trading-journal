import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ColorType, createChart, LineSeries, type UTCTimestamp } from "lightweight-charts";
import { AlertTriangle, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { AddressKind, PortfolioRead, Position, VaultHolding } from "@shared/portfolio";
import { fmtAmount, fmtMoney } from "@shared/metrics";

type Page = PortfolioRead & { history: { at: string; value: number; pnl: number }[] };

/* Through the journal's own formatters, so public mode hides these figures like every other amount. */
const usd = (x: number | null | undefined, signed = false) => {
  if (x == null || !Number.isFinite(x)) return "—";
  return signed ? fmtMoney(x) : fmtAmount(x, Math.abs(x) >= 1000 ? 0 : 2);
};
const pct = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`);
const qty = (x: number) => {
  const a = Math.abs(x);
  return x.toLocaleString(undefined, { maximumFractionDigits: a >= 1000 ? 0 : a >= 1 ? 4 : 6 });
};
const px = (x: number | null | undefined) => (x == null ? "—" : x.toLocaleString(undefined, { maximumFractionDigits: x >= 100 ? 2 : x >= 1 ? 4 : 8 }));
const tone = (x: number | null | undefined) => (x == null ? "" : x > 0 ? "text-emerald-400" : x < 0 ? "text-red-400" : "");
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** A line of the vault's account value, small. */
function Sparkline({ points }: { points: [number, number][] }) {
  if (points.length < 2) return <span className="text-muted-foreground">—</span>;
  const vs = points.map((p) => p[1]);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const w = 80;
  const h = 20;
  const d = points.map((p, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * w).toFixed(1)},${(h - ((p[1] - lo) / (hi - lo || 1)) * h).toFixed(1)}`).join(" ");
  const up = vs[vs.length - 1] >= vs[0];
  return (
    <svg width={w} height={h} className="inline-block align-middle" aria-hidden>
      <path d={d} fill="none" stroke={up ? "#10b981" : "#ef4444"} strokeWidth={1.5} />
    </svg>
  );
}

/** The portfolio's value over time, from the server's hourly snapshots. */
function ValueChart({ history }: { history: Page["history"] }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el || history.length < 2) return;
    const cs = getComputedStyle(el);
    const tok = (n: string, a?: number) => {
      const v = cs.getPropertyValue(n).trim();
      return v ? (a == null ? `hsl(${v})` : `hsl(${v} / ${a})`) : "#888";
    };
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: tok("--card") }, textColor: tok("--muted-foreground"), fontSize: 10 },
      grid: { vertLines: { color: tok("--border", 0.4) }, horzLines: { color: tok("--border", 0.4) } },
      rightPriceScale: { borderColor: tok("--border", 0.4) },
      timeScale: { borderColor: tok("--border", 0.4), timeVisible: true },
    });
    const line = chart.addSeries(LineSeries, { color: "#38bdf8", lineWidth: 2, priceLineVisible: false });
    line.setData(history.map((h) => ({ time: Math.floor(new Date(h.at).getTime() / 1000) as UTCTimestamp, value: h.value })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [history]);
  if (history.length < 2) return <p className="py-6 text-center text-xs text-muted-foreground">The value over time builds from an hourly snapshot; it shows once there are two.</p>;
  return <div ref={host} className="h-44 w-full" data-testid="portfolio-chart" />;
}

/** A wallet token's cost, typed in; blank clears it. */
function CostCell({ p, onSave }: { p: Position; onSave: (key: string, cost: number | null) => void }) {
  const [v, setV] = useState(p.cost != null && p.costFrom === "owner" ? String(p.cost) : "");
  if (p.costFrom === "venue") return <span className="font-mono" title="What it cost, as Hyperliquid states it">{usd(p.cost)}</span>;
  return (
    <Input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const n = v.trim() === "" ? null : Number(v.replace(/[$,\s]/g, ""));
        if (n === null || (Number.isFinite(n) && n >= 0)) if (n !== (p.costFrom === "owner" ? p.cost : null)) onSave(p.key, n);
      }}
      placeholder="cost $"
      inputMode="decimal"
      className="ml-auto h-6 w-24 px-1.5 text-right font-mono text-[11px]"
      data-testid={`portfolio-cost-${p.key}`}
    />
  );
}

export default function PortfolioPage() {
  const { toast } = useToast();
  const page = useQuery<Page>({ queryKey: ["/api/portfolio"], refetchInterval: 120_000 });
  const refresh = useMutation({
    mutationFn: async () => (await apiRequest("GET", "/api/portfolio?fresh=1")).json(),
    onSuccess: (d) => queryClient.setQueryData(["/api/portfolio"], d),
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
  const add = useMutation({
    mutationFn: async (b: { kind: AddressKind; address: string; label: string }) => (await apiRequest("POST", "/api/portfolio/addresses", b)).json(),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: async (id: number) => (await apiRequest("DELETE", `/api/portfolio/addresses/${id}`)).json(), onSuccess: invalidate });
  const saveCost = useMutation({ mutationFn: async (b: { key: string; cost: number | null }) => (await apiRequest("PUT", "/api/portfolio/cost", b)).json(), onSuccess: invalidate });

  const [kind, setKind] = useState<AddressKind>("hyperliquid");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [showDust, setShowDust] = useState(false);

  const d = page.data;
  const perps = d?.positions.filter((p) => p.source === "hl-perp") ?? [];
  const spot = d?.positions.filter((p) => p.source === "hl-spot") ?? [];
  const wallets = useMemo(() => {
    const all = d?.positions.filter((p) => p.source === "evm" || p.source === "solana") ?? [];
    // Unpriced or under a dollar: airdropped junk, mostly. Hidden unless asked for.
    const shown = showDust ? all : all.filter((p) => p.value != null && p.value >= 1);
    return { shown: shown.sort((a, b) => (b.value ?? -1) - (a.value ?? -1)), hidden: all.length - shown.length };
  }, [d, showDust]);
  const change24 = useMemo(() => {
    const h = d?.history ?? [];
    if (!d || h.length === 0) return null;
    const dayAgo = Date.now() - 86400_000;
    const then = [...h].reverse().find((x) => new Date(x.at).getTime() <= dayAgo);
    return then ? d.totals.value - then.value : null;
  }, [d]);

  const onAdd = async () => {
    try {
      await add.mutateAsync({ kind, address: address.trim(), label: label.trim() });
      setAddress("");
      setLabel("");
    } catch (err: any) {
      toast({ title: "Not added", description: String(err?.message ?? err).replace(/^\d+:\s*/, "").replace(/^\{"message":"|"\}$/g, "").slice(0, 160), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4" data-testid="page-portfolio">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Portfolio</h1>
          <p className="text-[11px] text-muted-foreground">{d ? `Read ${new Date(d.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · Hyperliquid vaults and accounts, EVM and Solana wallets · read-only` : page.isLoading ? "Reading…" : ""}</p>
        </div>
        <Button size="sm" variant="outline" className="h-8" onClick={() => refresh.mutate()} disabled={refresh.isPending} data-testid="portfolio-refresh">
          {refresh.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
          Refresh
        </Button>
      </div>

      {/* ------------------------------ the totals ------------------------------ */}
      {d && d.addresses.length > 0 && (
        <Card className="border-card-border bg-card p-4" data-testid="portfolio-totals">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Value</p>
              <p className="font-mono text-2xl font-bold" data-testid="portfolio-value">{usd(d.totals.value)}</p>
              <p className={`font-mono text-[11px] ${tone(change24)}`}>{change24 != null ? `${usd(change24, true)} 24h` : "24h change once a day of snapshots exists"}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">P&L the sources state</p>
              <p className={`font-mono text-2xl font-bold ${tone(d.totals.pnl)}`} data-testid="portfolio-pnl">{usd(d.totals.pnl, true)}</p>
              <p className="text-[11px] text-muted-foreground">on {usd(d.totals.valueWithCost)} with a known cost, plus open perps</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Vaults · HL accounts</p>
              <p className="font-mono text-sm">{usd(d.totals.byKind.vaults)} · {usd(d.totals.byKind.hlAccounts)}</p>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mt-1">HL spot · wallets</p>
              <p className="font-mono text-sm">{usd(d.totals.byKind.hlSpot)} · {usd(d.totals.byKind.wallets)}</p>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <ValueChart history={d.history} />
            </div>
          </div>
          {d.errors.length > 0 && (
            <ul className="mt-3 space-y-0.5 text-[11px] text-amber-500" data-testid="portfolio-errors">
              {d.errors.map((e, i) => (
                <li key={i} className="flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> {short(e.address)} · {e.where}: {e.message}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* ------------------------------ vaults ------------------------------ */}
      {d && d.vaults.length > 0 && (
        <Card className="border-card-border bg-card p-4" data-testid="portfolio-vaults">
          <h2 className="text-sm font-semibold">Hyperliquid vaults</h2>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[620px] text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="py-1 text-left">Vault</th>
                  <th className="py-1 text-right">Equity</th>
                  <th className="py-1 text-right">P&L</th>
                  <th className="py-1 text-right">All-time P&L</th>
                  <th className="py-1 text-right">Days in</th>
                  <th className="py-1 text-right">Vault APR</th>
                  <th className="py-1 text-right">Vault, 30d</th>
                </tr>
              </thead>
              <tbody>
                {d.vaults.map((v: VaultHolding) => (
                  <tr key={v.key} className="border-t border-border/40" data-testid={`portfolio-vault-${v.vaultAddress}`}>
                    <td className="py-1.5">
                      <a href={`https://app.hyperliquid.xyz/vaults/${v.vaultAddress}`} target="_blank" rel="noreferrer" className="font-semibold hover:text-sky-400">
                        {v.name}
                      </a>
                      <span className="ml-1 text-[10px] text-muted-foreground">{v.label ?? short(v.address)}{v.lockedUntil && v.lockedUntil > Date.now() ? ` · locked until ${new Date(v.lockedUntil).toLocaleDateString()}` : ""}</span>
                    </td>
                    <td className="py-1.5 text-right font-mono">{usd(v.equity)}</td>
                    <td className={`py-1.5 text-right font-mono ${tone(v.pnl)}`}>
                      {usd(v.pnl, true)}
                      {v.pnl != null && v.equity - v.pnl > 0 && <span className="ml-1 text-[10px]">{pct(v.pnl / (v.equity - v.pnl))}</span>}
                    </td>
                    <td className={`py-1.5 text-right font-mono ${tone(v.allTimePnl)}`}>{usd(v.allTimePnl, true)}</td>
                    <td className="py-1.5 text-right font-mono">{v.daysFollowing ?? "—"}</td>
                    <td className={`py-1.5 text-right font-mono ${tone(v.apr)}`}>{pct(v.apr)}</td>
                    <td className="py-1.5 text-right">
                      <Sparkline points={v.history} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ------------------------------ Hyperliquid accounts ------------------------------ */}
      {d && (perps.length > 0 || spot.length > 0) && (
        <Card className="border-card-border bg-card p-4" data-testid="portfolio-hl">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Hyperliquid accounts</h2>
            <span className="text-[11px] text-muted-foreground">
              {d.accounts.map((a) => `${a.label ?? short(a.address)} ${usd(a.accountValue)} margin account`).join(" · ")}
            </span>
          </div>
          {perps.length > 0 && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="py-1 text-left">Perp</th>
                    <th className="py-1 text-right">Size</th>
                    <th className="py-1 text-right">Entry</th>
                    <th className="py-1 text-right">Mark</th>
                    <th className="py-1 text-right">Notional</th>
                    <th className="py-1 text-right">Liq.</th>
                    <th className="py-1 text-right">Unrealised</th>
                  </tr>
                </thead>
                <tbody>
                  {perps.map((p) => (
                    <tr key={p.key} className="border-t border-border/40" data-testid={`portfolio-perp-${p.asset}`}>
                      <td className="py-1.5">
                        <span className={`mr-1 rounded px-1 text-[10px] font-bold ${p.amount > 0 ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>{p.amount > 0 ? "LONG" : "SHORT"}</span>
                        <span className="font-semibold">{p.asset}</span>
                        <span className="ml-1 text-[10px] text-muted-foreground">{p.leverage ? `${p.leverage}×` : ""} {p.label ?? short(p.address)}</span>
                      </td>
                      <td className="py-1.5 text-right font-mono">{qty(Math.abs(p.amount))}</td>
                      <td className="py-1.5 text-right font-mono">{px(p.entryPx)}</td>
                      <td className="py-1.5 text-right font-mono">{px(p.price)}</td>
                      <td className="py-1.5 text-right font-mono">{usd(p.value)}</td>
                      <td className="py-1.5 text-right font-mono text-amber-500">{px(p.liquidationPx)}</td>
                      <td className={`py-1.5 text-right font-mono ${tone(p.pnl)}`}>
                        {usd(p.pnl, true)} <span className="text-[10px]">{pct(p.pnlPct)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {spot.length > 0 && <HoldingsTable rows={spot} title="Spot on Hyperliquid" onCost={(key, cost) => saveCost.mutate({ key, cost })} testId="portfolio-spot" />}
        </Card>
      )}

      {/* ------------------------------ wallets ------------------------------ */}
      {d && (wallets.shown.length > 0 || wallets.hidden > 0) && (
        <Card className="border-card-border bg-card p-4" data-testid="portfolio-wallets">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Wallets</h2>
            {wallets.hidden > 0 || showDust ? (
              <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setShowDust((x) => !x)} data-testid="portfolio-dust">
                {showDust ? "Hide unpriced and under $1" : `${wallets.hidden} unpriced or under $1 hidden — show`}
              </button>
            ) : null}
          </div>
          <HoldingsTable rows={wallets.shown} onCost={(key, cost) => saveCost.mutate({ key, cost })} testId="portfolio-wallet-table" showChain />
          <p className="mt-2 text-[11px] text-muted-foreground">A wallet token's cost is not on chain in a form a read can trust — a transfer in is not a purchase — so type what you paid and its P&L appears.</p>
        </Card>
      )}

      {/* ------------------------------ the addresses ------------------------------ */}
      <Card className="border-card-border bg-card p-4" data-testid="portfolio-addresses">
        <h2 className="text-sm font-semibold">Addresses followed</h2>
        <p className="text-[11px] text-muted-foreground">Read-only: nothing here can move funds. A Hyperliquid address brings its perps, spot and every vault it is in.</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Select value={kind} onValueChange={(v) => setKind(v as AddressKind)}>
            <SelectTrigger className="h-8 w-36 text-xs" data-testid="portfolio-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hyperliquid">Hyperliquid</SelectItem>
              <SelectItem value="evm">EVM wallet</SelectItem>
              <SelectItem value="solana">Solana wallet</SelectItem>
            </SelectContent>
          </Select>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={kind === "solana" ? "Solana address" : "0x…"} className="h-8 min-w-0 flex-1 basis-64 font-mono text-xs" data-testid="portfolio-address" />
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label (optional)" className="h-8 w-36 text-xs" data-testid="portfolio-label" />
          <Button size="sm" className="h-8" onClick={onAdd} disabled={!address.trim() || add.isPending} data-testid="portfolio-add">
            <Plus className="mr-1 h-3.5 w-3.5" /> Follow
          </Button>
        </div>
        {d && d.addresses.length > 0 && (
          <ul className="mt-3 divide-y divide-border/40 text-xs">
            {d.addresses.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 py-1.5" data-testid={`portfolio-addr-${a.id}`}>
                <span className="min-w-0 break-all">
                  <span className="mr-2 rounded border border-border px-1 text-[10px] uppercase text-muted-foreground">{a.kind}</span>
                  {a.label && <span className="mr-2 font-semibold">{a.label}</span>}
                  <span className="font-mono text-muted-foreground">{a.address}</span>
                </span>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground hover:text-red-400" onClick={() => remove.mutate(a.id)} title="Stop following" data-testid={`portfolio-remove-${a.id}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {d && d.addresses.length === 0 && <p className="mt-3 text-xs text-muted-foreground">Nothing followed yet. Add a Hyperliquid address to see its vaults, perps and spot.</p>}
      </Card>
    </div>
  );
}

function HoldingsTable({ rows, title, onCost, testId, showChain = false }: { rows: Position[]; title?: string; onCost: (key: string, cost: number | null) => void; testId: string; showChain?: boolean }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-3 overflow-x-auto" data-testid={testId}>
      {title && <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{title}</p>}
      <table className="w-full min-w-[620px] text-xs">
        <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="py-1 text-left">Asset</th>
            <th className="py-1 text-right">Amount</th>
            <th className="py-1 text-right">Price</th>
            <th className="py-1 text-right">Value</th>
            <th className="py-1 text-right">Cost</th>
            <th className="py-1 text-right">P&L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.key} className="border-t border-border/40" data-testid={`portfolio-row-${p.asset}`}>
              <td className="py-1.5">
                <span className="font-semibold">{p.asset}</span>
                <span className="ml-1 text-[10px] text-muted-foreground">
                  {showChain ? `${p.chain} · ` : ""}
                  {p.label ?? short(p.address)}
                </span>
              </td>
              <td className="py-1.5 text-right font-mono">{qty(p.amount)}</td>
              <td className="py-1.5 text-right font-mono">{px(p.price)}</td>
              <td className="py-1.5 text-right font-mono">{usd(p.value)}</td>
              <td className="py-1.5 text-right">{p.asset === "USDC" && p.source === "hl-spot" ? "" : <CostCell p={p} onSave={onCost} />}</td>
              <td className={`py-1.5 text-right font-mono ${tone(p.pnl)}`}>
                {p.pnl != null ? (
                  <>
                    {usd(p.pnl, true)} <span className="text-[10px]">{pct(p.pnlPct)}</span>
                  </>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
