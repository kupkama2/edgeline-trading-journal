import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ColorType, createChart, LineSeries, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { AlertTriangle, Eye, EyeOff, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { usePublicMode } from "@/lib/public-mode";
import { useTheme } from "@/components/shell";
import { DUST_USD, isDust, type AddressKind, type PortfolioRead, type Position, type VaultHolding } from "@shared/portfolio";
import { fmtAmount, fmtMoney } from "@shared/metrics";
import { parseLooseNumber } from "@shared/loose-number";
import { amountsHidden, WITHHELD } from "@shared/redact";

type Page = PortfolioRead & { history: { at: string; value: number; pnl: number }[]; change24?: number | null; change24Why?: string | null };

/** What a failed request said, without the status and the JSON around it. */
const said = (err: unknown) =>
  String((err as any)?.message ?? err)
    .replace(/^\d+:\s*/, "")
    .replace(/^\{"message":"|"\}$/g, "")
    .slice(0, 160);

/** A phone's width: the tables become lists, with the asset, its value and its P&L first. */
const NARROW = "(max-width: 639px)";
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mql = window.matchMedia(NARROW);
    const onChange = () => setNarrow(mql.matches);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/* Through the journal's own formatters, so public mode hides these figures like every other amount. */
const usd = (x: number | null | undefined, signed = false) => {
  if (x == null || !Number.isFinite(x)) return "—";
  return signed ? fmtMoney(x) : fmtAmount(x, Math.abs(x) >= 1000 ? 0 : 2);
};
const pct = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`);
const qty = (x: number) => {
  // A quantity next to a public price is the value by one multiplication: withheld with the amounts.
  if (amountsHidden()) return WITHHELD;
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
  const chartRef = useRef<IChartApi | null>(null);
  const { isPublic } = usePublicMode();
  const { theme } = useTheme();
  const themed = (el: HTMLElement) => {
    const cs = getComputedStyle(el);
    const tok = (n: string, a?: number) => {
      const v = cs.getPropertyValue(n).trim();
      return v ? (a == null ? `hsl(${v})` : `hsl(${v} / ${a})`) : "#888";
    };
    return {
      layout: { background: { type: ColorType.Solid as const, color: tok("--card") }, textColor: tok("--muted-foreground"), fontSize: 10 },
      grid: { vertLines: { color: tok("--border", 0.4) }, horzLines: { color: tok("--border", 0.4) } },
      // In public mode the shape stays and the scale goes: the axis, the last-value tag and the crosshair's label each printed the account's size.
      rightPriceScale: { borderColor: tok("--border", 0.4), visible: !isPublic },
      timeScale: { borderColor: tok("--border", 0.4), timeVisible: true },
      crosshair: { horzLine: { labelVisible: !isPublic } },
    };
  };
  useEffect(() => {
    const el = host.current;
    if (!el || history.length < 2) return;
    const chart = createChart(el, { autoSize: true, ...themed(el) });
    chartRef.current = chart;
    const line = chart.addSeries(LineSeries, { color: "#38bdf8", lineWidth: 2, priceLineVisible: false, lastValueVisible: !isPublic });
    line.setData(history.map((h) => ({ time: Math.floor(new Date(h.at).getTime() / 1000) as UTCTimestamp, value: h.value })));
    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, isPublic]);
  // The theme changed: the chart was drawn in the old one's colours. Read after the paint, when the tokens are the new ones.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (host.current && chartRef.current) chartRef.current.applyOptions(themed(host.current));
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);
  if (history.length < 2) return <p className="py-6 text-center text-xs text-muted-foreground">The value over time builds from an hourly snapshot; it shows once there are two.</p>;
  return <div ref={host} className="h-44 w-full" data-testid="portfolio-chart" />;
}

/** Why a row is out of the default view, if it is. */
type Shade = "hidden" | "dust" | null;

/** The eye at the end of a row: hide it, or bring a hidden one back. */
function HideButton({ k, hidden, onHide }: { k: string; hidden: boolean; onHide: (key: string, hidden: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onHide(k, !hidden)}
      className="relative rounded p-0.5 text-muted-foreground after:absolute after:-inset-1.5 after:content-[''] hover:text-foreground"
      title={hidden ? "Show again, and count it in the totals" : "Hide, and leave it out of the totals"}
      aria-label={hidden ? "Unhide" : "Hide"}
      data-testid={`portfolio-hide-${k}`}
    >
      {hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
    </button>
  );
}

const ShadeTag = ({ shade }: { shade: Shade }) =>
  shade ? (
    <span className="ml-1 rounded border border-border px-1 text-[9px] uppercase tracking-wider text-muted-foreground" title={shade === "dust" ? `Worth under ${DUST_USD} dollars, or no price` : "Hidden by you, left out of the totals"}>
      {shade}
    </span>
  ) : null;

/**
 * A P&L figure that can be rewritten: a click on the figure turns it into a
 * field, Enter or leaving it saves, Escape leaves it as it was, blank goes
 * back to the source's figure.
 */
function PnlCell({ k, pnl, pct: pctOf, own, onSave }: { k: string; pnl: number | null; pct?: number | null; own: boolean; onSave: (key: string, pnl: number | null) => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState("");
  // Escape closes the field, and a field that closes loses focus: without this the blur saved what Escape was pressed to discard.
  const cancelled = useRef(false);
  // Public mode: the figure is withheld, and so is the field that would show it.
  if (amountsHidden()) return <span className={tone(pnl)}>{usd(pnl, true)}</span>;
  if (editing) {
    const done = () => {
      setEditing(false);
      if (cancelled.current) return;
      const raw = v.trim();
      if (raw === "") {
        if (own) onSave(k, null);
        return;
      }
      // As it was copied: "1,234.50", "−310", "(310)", "$1 200".
      const n = parseLooseNumber(raw);
      if (n == null) {
        toast({ title: "Not a number", description: `"${raw.slice(0, 24)}" was not saved as a P&L.`, variant: "destructive" });
        return;
      }
      if (n !== pnl || !own) onSave(k, n);
    };
    return (
      <Input
        autoFocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            setEditing(false);
          }
        }}
        placeholder="P&L, blank = source"
        inputMode="decimal"
        className="ml-auto h-6 w-28 px-1.5 text-right font-mono text-[11px]"
        data-testid={`portfolio-pnl-input-${k}`}
      />
    );
  }
  // The figure is the button: the pencil alone was twelve pixels, and showed only under a mouse.
  return (
    <button
      type="button"
      onClick={() => {
        cancelled.current = false;
        setV(own && pnl != null ? String(pnl) : "");
        setEditing(true);
      }}
      className="group -mx-1 -my-0.5 inline-flex items-center justify-end gap-1 rounded px-1 py-0.5 font-mono hover:bg-muted/60 focus-visible:bg-muted/60"
      title={own ? "Your figure, over the source's. Click to change it; leave it blank to go back." : "Click to rewrite this P&L"}
      aria-label="Rewrite P&L"
      data-testid={`portfolio-pnl-edit-${k}`}
    >
      <span className={tone(pnl)}>
        {usd(pnl, true)}
        {pctOf !== undefined && pnl != null && <span className="ml-1 text-[10px]">{pct(pctOf)}</span>}
      </span>
      {own && <span className="text-[9px] text-sky-400">yours</span>}
      <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-60" aria-hidden />
    </button>
  );
}

/** A wallet token's cost, typed in; blank clears it. */
function CostCell({ p, onSave }: { p: Position; onSave: (key: string, cost: number | null) => void }) {
  const { toast } = useToast();
  const mine = p.cost != null && p.costFrom === "owner" ? String(p.cost) : "";
  const [v, setV] = useState(mine);
  if (p.costFrom === "venue") return <span className="font-mono" title="What it cost, as Hyperliquid states it">{usd(p.cost)}</span>;
  // Public mode: a field would show the figure the mode withholds.
  if (amountsHidden()) return <span className="font-mono">{usd(p.cost)}</span>;
  return (
    <Input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setV(mine);
      }}
      onBlur={() => {
        const raw = v.trim();
        const n = raw === "" ? null : parseLooseNumber(raw);
        if (raw !== "" && (n == null || n < 0)) {
          // Said, and put back: it used to be dropped without a word, the field still showing what was typed.
          toast({ title: "Not a cost", description: `"${raw.slice(0, 24)}" is not an amount paid; nothing was saved.`, variant: "destructive" });
          setV(mine);
          return;
        }
        if (n !== (p.costFrom === "owner" ? p.cost : null)) onSave(p.key, n);
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
    onError: (err) => toast({ title: "Not refreshed", description: said(err), variant: "destructive" }),
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
  // A change that did not save says so: each of these used to fail in silence, the page showing the old figure as if nothing had been typed.
  const failed = (what: string) => (err: unknown) => {
    toast({ title: what, description: said(err), variant: "destructive" });
    invalidate();
  };
  const add = useMutation({
    mutationFn: async (b: { kind: AddressKind; address: string; label: string }) => (await apiRequest("POST", "/api/portfolio/addresses", b)).json(),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: async (id: number) => (await apiRequest("DELETE", `/api/portfolio/addresses/${id}`)).json(), onSuccess: invalidate, onError: failed("Still followed") });
  const saveCost = useMutation({ mutationFn: async (b: { key: string; cost: number | null }) => (await apiRequest("PUT", "/api/portfolio/cost", b)).json(), onSuccess: invalidate, onError: failed("Cost not saved") });
  const hide = useMutation({ mutationFn: async (b: { key: string; hidden: boolean }) => (await apiRequest("PUT", "/api/portfolio/hidden", b)).json(), onSuccess: invalidate, onError: failed("Not changed") });
  const onHide = (key: string, hidden: boolean) => hide.mutate({ key, hidden });
  const savePnl = useMutation({ mutationFn: async (b: { key: string; pnl: number | null }) => (await apiRequest("PUT", "/api/portfolio/pnl", b)).json(), onSuccess: invalidate, onError: failed("P&L not saved") });
  const narrow = useNarrow();
  // Read so the page draws again when the mode flips; the formatters themselves ask the switch.
  usePublicMode();
  const onPnl = (key: string, pnl: number | null) => savePnl.mutate({ key, pnl });
  // The P&L up top can be kept off the screen; remembered in this browser.
  const [pnlOff, setPnlOff] = useState<boolean>(() => {
    try {
      return localStorage.getItem("edgeline.portfolio.pnlOff") === "1";
    } catch {
      return false;
    }
  });
  const togglePnl = () =>
    setPnlOff((x) => {
      try {
        localStorage.setItem("edgeline.portfolio.pnlOff", x ? "0" : "1");
      } catch {
        /* fine */
      }
      return !x;
    });

  const [kind, setKind] = useState<AddressKind>("hyperliquid");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  // Dust and what the owner hid stay off the page until asked for; remembered in this browser.
  const [showHidden, setShowHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem("edgeline.portfolio.showHidden") === "1";
    } catch {
      return false;
    }
  });
  const toggleHidden = () =>
    setShowHidden((x) => {
      try {
        localStorage.setItem("edgeline.portfolio.showHidden", x ? "0" : "1");
      } catch {
        /* fine */
      }
      return !x;
    });

  const d = page.data;
  const hiddenKeys = useMemo(() => new Set(d?.hidden ?? []), [d]);
  const shadeOf = (key: string, p?: Position): Shade => (hiddenKeys.has(key) ? "hidden" : p && isDust(p) ? "dust" : null);
  const perps = d?.positions.filter((p) => p.source === "hl-perp") ?? [];
  const byValue = (a: Position, b: Position) => (b.value ?? -1) - (a.value ?? -1);
  const sorted = (rows: Position[]) => {
    const all = [...rows].sort(byValue);
    return { shown: showHidden ? all : all.filter((p) => !shadeOf(p.key, p)), out: all.filter((p) => shadeOf(p.key, p)).length };
  };
  const spot = useMemo(() => sorted(d?.positions.filter((p) => p.source === "hl-spot") ?? []), [d, showHidden, hiddenKeys]);
  const wallets = useMemo(() => sorted(d?.positions.filter((p) => p.source === "evm" || p.source === "solana") ?? []), [d, showHidden, hiddenKeys]);
  const vaults = useMemo(() => (d?.vaults ?? []).filter((v) => showHidden || !hiddenKeys.has(v.key)), [d, showHidden, hiddenKeys]);
  const counts = useMemo(() => {
    const present = [...(d?.positions ?? []).map((p) => p.key), ...(d?.vaults ?? []).map((v) => v.key)];
    const hidden = present.filter((k) => hiddenKeys.has(k)).length;
    const dust = (d?.positions ?? []).filter((p) => !hiddenKeys.has(p.key) && isDust(p)).length;
    return { hidden, dust };
  }, [d, hiddenKeys]);
  // The server's figure: it compares against the snapshot nearest a day back, and only when that one counted the same
  // addresses and hidden rows. Worked out here it took any snapshot older than a day, so an address added this
  // morning showed as the day's gain.
  const change24 = d?.change24 ?? null;

  const onAdd = async () => {
    try {
      await add.mutateAsync({ kind, address: address.trim(), label: label.trim() });
      setAddress("");
      setLabel("");
    } catch (err: any) {
      toast({ title: "Not added", description: said(err), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4" data-testid="page-portfolio">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Portfolio</h1>
          <p className="text-[11px] text-muted-foreground">{d ? `Read ${new Date(d.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · Hyperliquid vaults and accounts, EVM and Solana wallets · read-only` : page.isLoading ? "Reading…" : ""}</p>
        </div>
        <div className="flex items-center gap-2">
          {(counts.hidden > 0 || counts.dust > 0) && (
            <Button size="sm" variant={showHidden ? "secondary" : "ghost"} className="h-8 text-xs" onClick={toggleHidden} aria-pressed={showHidden} data-testid="portfolio-show-hidden">
              {showHidden ? <EyeOff className="mr-1 h-3.5 w-3.5" /> : <Eye className="mr-1 h-3.5 w-3.5" />}
              {showHidden ? "Hide dust and hidden" : `Show ${[counts.dust ? `${counts.dust} dust` : "", counts.hidden ? `${counts.hidden} hidden` : ""].filter(Boolean).join(" · ")}`}
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-8" onClick={() => refresh.mutate()} disabled={refresh.isPending} data-testid="portfolio-refresh">
            {refresh.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            Refresh
          </Button>
        </div>
      </div>

      {page.isError && !d && (
        <Card className="flex flex-wrap items-center justify-between gap-2 border-amber-500/40 bg-card p-4 text-xs" data-testid="portfolio-failed">
          <span className="flex items-center gap-1.5 text-amber-500">
            <AlertTriangle className="h-3.5 w-3.5" /> The portfolio could not be read: {said(page.error)}
          </span>
          <Button size="sm" variant="outline" className="h-7" onClick={() => void page.refetch()}>
            Try again
          </Button>
        </Card>
      )}

      {/* ------------------------------ the totals ------------------------------ */}
      {d && d.addresses.length > 0 && (
        <Card className="border-card-border bg-card p-4" data-testid="portfolio-totals">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Value</p>
              <p className="font-mono text-2xl font-bold" data-testid="portfolio-value">{usd(d.totals.value)}</p>
              <p className={`font-mono text-[11px] ${change24 != null ? tone(change24) : "text-muted-foreground"}`} data-testid="portfolio-change24">
                {change24 != null ? `${usd(change24, true)} 24h` : (d.change24Why ?? "24h change once a day of snapshots exists")}
              </p>
            </div>
            <div>
              <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                P&L
                <button type="button" onClick={togglePnl} className="relative rounded p-0.5 after:absolute after:-inset-2 after:content-[''] hover:text-foreground" title={pnlOff ? "Show the P&L" : "Hide the P&L from this card"} aria-pressed={pnlOff} data-testid="portfolio-pnl-toggle">
                  {pnlOff ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                </button>
              </p>
              {pnlOff ? (
                <p className="font-mono text-2xl font-bold text-muted-foreground" data-testid="portfolio-pnl">
                  hidden
                </p>
              ) : (
                <>
                  <p className={`font-mono text-2xl font-bold ${tone(d.totals.pnl)}`} data-testid="portfolio-pnl">{usd(d.totals.pnl, true)}</p>
                  <p className="text-[11px] text-muted-foreground">on {usd(d.totals.valueWithCost)} with a known cost or your own P&L, plus open perps. {narrow ? "Tap" : "Click"} a row's P&L to rewrite it.</p>
                </>
              )}
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
          {counts.hidden > 0 && (
            <p className="mt-2 text-[11px] text-muted-foreground" data-testid="portfolio-hidden-note">
              {counts.hidden} hidden {counts.hidden === 1 ? "holding is" : "holdings are"} left out of these totals. Dust under ${DUST_USD} is counted.
            </p>
          )}
          {d.errors.length > 0 && (
            <ul className="mt-3 space-y-0.5 text-[11px]" data-testid="portfolio-errors">
              {d.errors.map((e, i) => (
                <li key={i} className={`flex items-center gap-1 ${e.stale ? "text-muted-foreground" : "text-amber-500"}`}>
                  <AlertTriangle className="h-3 w-3" /> {short(e.address)} · {e.where}: {e.message}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* ------------------------------ vaults ------------------------------ */}
      {d && vaults.length > 0 && (
        <Card className="border-card-border bg-card p-4" data-testid="portfolio-vaults">
          <h2 className="text-sm font-semibold">Hyperliquid vaults</h2>
          {narrow ? (
            <ul className="mt-1 divide-y divide-border/40 text-xs" data-testid="portfolio-vault-list">
              {vaults.map((v: VaultHolding) => (
                <li key={v.key} className={`py-2 ${hiddenKeys.has(v.key) ? "opacity-50" : ""}`} data-testid={`portfolio-vault-${v.vaultAddress}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate">
                      <a href={`https://app.hyperliquid.xyz/vaults/${v.vaultAddress}`} target="_blank" rel="noreferrer" className="font-semibold hover:text-sky-400">
                        {v.name}
                      </a>
                      <ShadeTag shade={shadeOf(v.key)} />
                    </span>
                    <span className="shrink-0 font-mono text-sm font-semibold">{usd(v.equity)}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                      {v.label ?? short(v.address)}
                      {v.daysFollowing != null ? ` · ${v.daysFollowing}d in` : ""}
                    </span>
                    <span className="flex shrink-0 items-center gap-2.5">
                      <PnlCell k={v.key} pnl={v.pnl} pct={v.pnl != null && v.equity - v.pnl > 0 ? v.pnl / (v.equity - v.pnl) : null} own={v.pnlFrom === "owner"} onSave={onPnl} />
                      <HideButton k={v.key} hidden={hiddenKeys.has(v.key)} onHide={onHide} />
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span className="min-w-0 truncate">
                      APR <span className={`font-mono ${tone(v.apr)}`}>{pct(v.apr)}</span> · all-time <span className={`font-mono ${tone(v.allTimePnl)}`}>{usd(v.allTimePnl, true)}</span>
                      {v.lockedUntil && v.lockedUntil > Date.now() ? ` · locked until ${new Date(v.lockedUntil).toLocaleDateString()}` : ""}
                    </span>
                    <span className="shrink-0">
                      <Sparkline points={v.history} />
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
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
                  <th className="w-6" />
                </tr>
              </thead>
              <tbody>
                {vaults.map((v: VaultHolding) => (
                  <tr key={v.key} className={`border-t border-border/40 ${hiddenKeys.has(v.key) ? "opacity-50" : ""}`} data-testid={`portfolio-vault-${v.vaultAddress}`}>
                    <td className="py-1.5">
                      <a href={`https://app.hyperliquid.xyz/vaults/${v.vaultAddress}`} target="_blank" rel="noreferrer" className="font-semibold hover:text-sky-400">
                        {v.name}
                      </a>
                      <span className="ml-1 text-[10px] text-muted-foreground">{v.label ?? short(v.address)}{v.lockedUntil && v.lockedUntil > Date.now() ? ` · locked until ${new Date(v.lockedUntil).toLocaleDateString()}` : ""}</span>
                      <ShadeTag shade={shadeOf(v.key)} />
                    </td>
                    <td className="py-1.5 text-right font-mono">{usd(v.equity)}</td>
                    <td className="py-1.5 text-right font-mono">
                      <PnlCell k={v.key} pnl={v.pnl} pct={v.pnl != null && v.equity - v.pnl > 0 ? v.pnl / (v.equity - v.pnl) : null} own={v.pnlFrom === "owner"} onSave={onPnl} />
                    </td>
                    <td className={`py-1.5 text-right font-mono ${tone(v.allTimePnl)}`}>{usd(v.allTimePnl, true)}</td>
                    <td className="py-1.5 text-right font-mono">{v.daysFollowing ?? "—"}</td>
                    <td className={`py-1.5 text-right font-mono ${tone(v.apr)}`}>{pct(v.apr)}</td>
                    <td className="py-1.5 text-right">
                      <Sparkline points={v.history} />
                    </td>
                    <td className="py-1.5 pl-2 text-right">
                      <HideButton k={v.key} hidden={hiddenKeys.has(v.key)} onHide={onHide} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </Card>
      )}

      {/* ------------------------------ Hyperliquid accounts ------------------------------ */}
      {d && (perps.length > 0 || spot.shown.length > 0 || spot.out > 0) && (
        <Card className="border-card-border bg-card p-4" data-testid="portfolio-hl">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Hyperliquid accounts</h2>
            <span className="text-[11px] text-muted-foreground">
              {d.accounts.map((a) => `${a.label ?? short(a.address)} ${usd(a.accountValue)} margin account`).join(" · ")}
            </span>
          </div>
          {perps.length > 0 && narrow && (
            <ul className="mt-1 divide-y divide-border/40 text-xs" data-testid="portfolio-perp-list">
              {perps.map((p) => (
                <li key={p.key} className="py-2" data-testid={`portfolio-perp-${p.asset}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate">
                      <span className={`mr-1 rounded px-1 text-[10px] font-bold ${p.amount > 0 ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>{p.amount > 0 ? "LONG" : "SHORT"}</span>
                      <span className="font-semibold">{p.asset}</span>
                      <span className="ml-1 text-[10px] text-muted-foreground">{p.leverage ? `${p.leverage}×` : ""} {p.label ?? short(p.address)}</span>
                    </span>
                    <span className={`shrink-0 font-mono text-sm font-semibold ${tone(p.pnl)}`}>
                      {usd(p.pnl, true)} <span className="text-[10px] font-normal">{pct(p.pnlPct)}</span>
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
                    <span>
                      {qty(Math.abs(p.amount))} @ {px(p.entryPx)} → {px(p.price)}
                    </span>
                    <span>
                      {usd(p.value)} · <span className="text-amber-500">liq {px(p.liquidationPx)}</span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {perps.length > 0 && !narrow && (
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
          {spot.shown.length > 0 && <HoldingsTable rows={spot.shown} title="Spot on Hyperliquid" onCost={(key, cost) => saveCost.mutate({ key, cost })} onPnl={onPnl} onHide={onHide} shadeOf={shadeOf} testId="portfolio-spot" narrow={narrow} />}
          {!showHidden && spot.out > 0 && <p className="mt-2 text-[11px] text-muted-foreground">{spot.out} spot {spot.out === 1 ? "balance" : "balances"} out of view: dust or hidden.</p>}
        </Card>
      )}

      {/* ------------------------------ wallets ------------------------------ */}
      {d && (wallets.shown.length > 0 || wallets.out > 0) && (
        <Card className="border-card-border bg-card p-4" data-testid="portfolio-wallets">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Wallets</h2>
            {!showHidden && wallets.out > 0 && <span className="text-[11px] text-muted-foreground">{wallets.out} out of view: dust or hidden</span>}
          </div>
          <HoldingsTable rows={wallets.shown} onCost={(key, cost) => saveCost.mutate({ key, cost })} onPnl={onPnl} onHide={onHide} shadeOf={shadeOf} testId="portfolio-wallet-table" showChain narrow={narrow} />
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

function HoldingsTable({
  rows,
  title,
  onCost,
  onPnl,
  onHide,
  shadeOf,
  testId,
  showChain = false,
  narrow = false,
}: {
  rows: Position[];
  title?: string;
  onCost: (key: string, cost: number | null) => void;
  onPnl: (key: string, pnl: number | null) => void;
  onHide: (key: string, hidden: boolean) => void;
  shadeOf: (key: string, p?: Position) => Shade;
  testId: string;
  showChain?: boolean;
  narrow?: boolean;
}) {
  if (rows.length === 0) return null;
  // A phone: the asset, what it is worth and its P&L first; the table's seven columns put the last three off the screen.
  if (narrow)
    return (
      <div className="mt-3" data-testid={testId}>
        {title && <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{title}</p>}
        <ul className="divide-y divide-border/40 text-xs">
          {rows.map((p) => {
            const shade = shadeOf(p.key, p);
            return (
              <li key={p.key} className={`py-2 ${shade ? "opacity-50" : ""}`} data-testid={`portfolio-row-${p.asset}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate">
                    <span className="font-semibold">{p.asset}</span>
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      {showChain ? `${p.chain} · ` : ""}
                      {p.label ?? short(p.address)}
                    </span>
                    <ShadeTag shade={shade} />
                  </span>
                  <span className="shrink-0 font-mono text-sm font-semibold">{usd(p.value)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                    {qty(p.amount)} @ {px(p.price)}
                  </span>
                  <span className="flex shrink-0 items-center gap-2.5">
                    <PnlCell k={p.key} pnl={p.pnl} pct={p.pnlPct} own={p.pnlFrom === "owner"} onSave={onPnl} />
                    <HideButton k={p.key} hidden={shade === "hidden"} onHide={onHide} />
                  </span>
                </div>
                {!(p.asset === "USDC" && p.source === "hl-spot") && (
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>Cost</span>
                    <CostCell p={p} onSave={onCost} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    );
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
            <th className="w-6" />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const shade = shadeOf(p.key, p);
            return (
            <tr key={p.key} className={`border-t border-border/40 ${shade ? "opacity-50" : ""}`} data-testid={`portfolio-row-${p.asset}`}>
              <td className="py-1.5">
                <span className="font-semibold">{p.asset}</span>
                <span className="ml-1 text-[10px] text-muted-foreground">
                  {showChain ? `${p.chain} · ` : ""}
                  {p.label ?? short(p.address)}
                </span>
                <ShadeTag shade={shade} />
              </td>
              <td className="py-1.5 text-right font-mono">{qty(p.amount)}</td>
              <td className="py-1.5 text-right font-mono">{px(p.price)}</td>
              <td className="py-1.5 text-right font-mono">{usd(p.value)}</td>
              <td className="py-1.5 text-right">{p.asset === "USDC" && p.source === "hl-spot" ? "" : <CostCell p={p} onSave={onCost} />}</td>
              <td className="py-1.5 text-right font-mono">
                <PnlCell k={p.key} pnl={p.pnl} pct={p.pnlPct} own={p.pnlFrom === "owner"} onSave={onPnl} />
              </td>
              <td className="py-1.5 pl-2 text-right">
                <HideButton k={p.key} hidden={shade === "hidden"} onHide={onHide} />
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
