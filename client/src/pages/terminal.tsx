/**
 * The terminal: draw a plan on the chart, send it, and watch the venue act
 * on it — with the journal written as a side effect of trading rather than
 * as a chore afterwards.
 *
 * Three lines on the chart are the plan: entry, stop, target. Drag them or
 * type them; the size follows from the dollars at risk. Send puts the stop
 * on the book first, then the entry, then the target, and the journal trade
 * exists from that moment with exactly those numbers. While a trade is live
 * on the symbol, the same lines are its resting brackets, and dragging one
 * moves the order — and writes the move to the stop log.
 *
 * The page exists only for the emails the server lists. Everyone else sees
 * one line saying so, and the API behind it answers 404.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Bell, BellOff, Crosshair, ExternalLink, Loader2, X } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Segmented, num } from "@/components/trade-shared";
import type { SessionResponse } from "@/components/login-gate";
import type { Level, LevelField } from "@/components/chart-levels";
import {
  fetchTerminalPage,
  useAddSize,
  useAdoptPosition,
  useCancelOrder,
  useTakeAt,
  useTerminalTrades,
  useCancelTerminalTrade,
  useCloseTerminalTrade,
  useEnableHedgeMode,
  useLiveKlines,
  useMoveBracket,
  useMoveEntry,
  usePlanAlerts,
  notificationsAllowed,
  useReconcile,
  useReduce,
  useSendPlan,
  useTerminalBook,
  useTerminalCandles,
  useTerminalLog,
  useTerminalStatus,
  useTerminalSymbols,
  useTicker,
  type Book as BookData,
  type VenueOrder,
} from "@/lib/terminal";
import { fmtAmount, fmtMoney } from "@shared/metrics";
import { parseTerminalRef, planVerdictOf, rAt, sizePlan, type SymbolRules, type TerminalPlan } from "@shared/terminal";
import type { TradeWithTags } from "@shared/schema";

const Candles = lazy(() => import("@/components/trade-chart").then((m) => ({ default: m.Candles })));

const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
type Interval = (typeof INTERVALS)[number];

const numOrNull = (s: string): number | null => {
  const v = Number(String(s).replace(/,/g, "").trim());
  return s.trim() !== "" && Number.isFinite(v) ? v : null;
};

export default function TerminalPage() {
  const session = useQuery<SessionResponse>({ queryKey: ["/api/session"] });
  const allowed = session.data?.terminal === true;
  const status = useTerminalStatus(allowed);
  const [account, setAccount] = useState<string | null>(null);
  const accounts = status.data?.accounts ?? [];
  useEffect(() => {
    if (!account && accounts.length) setAccount(accounts[0].name);
  }, [accounts, account]);
  const acct = accounts.find((a) => a.name === account) ?? null;

  if (session.isLoading) return null;
  if (!allowed) {
    return (
      <div className="space-y-2">
        <h1 className="text-xl font-bold tracking-tight">Terminal</h1>
        <p className="text-xs text-muted-foreground" data-testid="text-terminal-off">
          The terminal is not enabled for this account. It is switched on per email, on the server.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="page-terminal">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Crosshair className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Terminal</h1>
          {acct && <EnvBadge env={acct.env} />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {accounts.length > 1 && (
            <Select value={account ?? ""} onValueChange={setAccount}>
              <SelectTrigger className="h-8 w-48 text-xs" data-testid="select-terminal-account">
                <SelectValue placeholder="Account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.name} value={a.name} className="text-xs">
                    {a.name} <span className="text-muted-foreground">· {a.env}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <AlertsBell />
          {acct?.balance && (
            <span className="font-mono text-xs text-muted-foreground" data-testid="text-terminal-balance">
              {acct.balance.asset} {num(acct.balance.available)} free
            </span>
          )}
        </div>
      </div>

      {accounts.length === 0 && !status.isLoading && (
        <Card className="border-amber-500/40 bg-card p-4 text-xs" data-testid="text-terminal-no-key">
          No account holds a trading key. In Settings, save a Binance key on an account and mark it <b>testnet</b> or{" "}
          <b>trading</b>.
        </Card>
      )}
      {acct?.error && (
        <Card className="border-destructive/50 bg-card p-3 text-xs text-destructive" data-testid="text-terminal-error">
          {acct.name} did not answer: {acct.error}
        </Card>
      )}
      {acct && acct.env === "live" && acct.ipLocked === false && (
        <Card className="flex items-center gap-2 border-red-500/50 bg-red-500/5 p-3 text-xs text-red-400" data-testid="bar-unlocked-key">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            This live trading key is <b>not locked to an IP</b>. Anyone who obtains it can trade this account from anywhere.
            Restrict it on Binance to the server's outbound IP as soon as the host has one.
          </span>
        </Card>
      )}
      {acct && acct.hedgeMode === false && <HedgeModeBar account={acct.name} />}

      {acct && <Desk account={acct.name} env={acct.env} hedge={acct.hedgeMode !== false} free={acct.balance?.available ?? null} quote={acct.balance?.asset ?? "USDT"} />}
    </div>
  );
}

function EnvBadge({ env }: { env: "live" | "testnet" }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        env === "testnet" ? "bg-amber-500/15 text-amber-500" : "bg-red-500/15 text-red-400"
      }`}
      data-testid="badge-terminal-env"
    >
      {env === "testnet" ? "testnet · play money" : "live · real money"}
    </span>
  );
}

function HedgeModeBar({ account }: { account: string }) {
  const enable = useEnableHedgeMode();
  const { toast } = useToast();
  return (
    <Card className="flex flex-wrap items-center gap-3 border-amber-500/40 bg-card p-3 text-xs" data-testid="bar-hedge-mode">
      <AlertTriangle className="h-4 w-4 text-amber-500" />
      <span>
        The account is in one-way mode. The terminal sends every order with a side, which needs <b>hedge mode</b>. The venue
        only switches it with no positions or orders open.
      </span>
      <Button
        size="sm"
        variant="outline"
        className="ml-auto h-7 text-[11px]"
        disabled={enable.isPending}
        onClick={() =>
          enable
            .mutateAsync(account)
            .then(() => toast({ title: "Hedge mode on" }))
            .catch((err: any) => toast({ title: "Not switched", description: String(err?.message ?? err).slice(0, 200), variant: "destructive" }))
        }
        data-testid="button-enable-hedge"
      >
        Switch to hedge mode
      </Button>
    </Card>
  );
}

/* ------------------------------ the desk ------------------------------ */

function Desk({ account, env, hedge, free, quote }: { account: string; env: "live" | "testnet"; hedge: boolean; free: number | null; quote: string }) {
  const { toast } = useToast();
  const { data: rules = [] } = useTerminalSymbols(account);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval_] = useState<Interval>("15m");
  const rule = useMemo(() => rules.find((r) => r.symbol === symbol) ?? null, [rules, symbol]);
  const candlesQ = useTerminalCandles(rule ? symbol : null, interval);
  const { candles, live: tapeLive } = useLiveKlines(rule ? symbol : null, interval, candlesQ.data?.candles ?? []);
  const last = candles.length ? candles[candles.length - 1].c : null;
  const book = useTerminalBook(account);
  const ticker = useTicker(account, rule ? symbol : null);

  // The journal's own copy of what this terminal has on: read back every few seconds.
  const reconcile = useReconcile();
  useEffect(() => {
    const tick = () => {
      if (!reconcile.isPending) reconcile.mutate();
    };
    tick();
    const id = window.setInterval(tick, 5_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  const { data: trades = [] } = useTerminalTrades();
  const mine = useMemo(
    () =>
      trades
        .map((t) => ({ t, ref: parseTerminalRef(t.terminal) }))
        .filter((x): x is { t: TradeWithTags; ref: NonNullable<ReturnType<typeof parseTerminalRef>> } => !!x.ref && x.ref.account === account)
        .filter((x) => x.t.status === "open" || x.t.status === "pending"),
    [trades, account],
  );
  /*
   * Which trade the desk is on. Picked from the book — that also brings its
   * symbol onto the chart — or, failing that, whatever this terminal has on
   * for the chart's symbol. A second ticket can be opened beside it (a hedge
   * on the same symbol, say) without leaving the trade.
   */
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [ticketToo, setTicketToo] = useState(false);
  const live = mine.find((x) => x.t.id === selectedId && x.ref.symbol === symbol) ?? mine.find((x) => x.ref.symbol === symbol) ?? null;
  const select = (x: { t: TradeWithTags; ref: { symbol: string } }) => {
    setSelectedId(x.t.id);
    setSymbol(x.ref.symbol);
    setTicketToo(false);
  };
  useEffect(() => setTicketToo(false), [symbol]);
  useEffect(() => {
    if (ticketToo && live) setSide(live.t.direction === "long" ? "short" : "long");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketToo]);

  // The original stop or target being reached while a trade is on: said once, here and on the desktop.
  const say = useCallback(
    (title: string, body: string, tone: "stop" | "target") => {
      toast({ title, description: body, variant: tone === "stop" ? "destructive" : "default", duration: 15_000 });
      if (notificationsAllowed()) {
        try {
          new Notification(title, { body, tag: title });
        } catch {
          /* no desktop notifications here */
        }
      }
    },
    [toast],
  );
  usePlanAlerts(mine, say);

  /* ---------------- the ticket ---------------- */
  const [side, setSide] = useState<"long" | "short">("long");
  const [entryType, setEntryType] = useState<"market" | "limit">("market");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [targets, setTargets] = useState<string[]>([""]);
  const [sizeMode, setSizeMode] = useState<"risk" | "qty">("risk");
  const [risk, setRisk] = useState("50");
  const [qty, setQty] = useState("");
  const [leverage, setLeverage] = useState("5");
  const [confirm, setConfirm] = useState(false);
  // Real money asks for a word, not a click: a second click is a reflex.
  const [typed, setTyped] = useState("");
  const armedToSend = env !== "live" || typed.trim().toUpperCase() === "SEND";

  // A market entry is priced where the market is; the field follows the tape.
  // A limit starts there too, as a line to drag — not as a blank to fill.
  useEffect(() => {
    if (entryType === "market" && last != null) setEntry(String(last));
    if (entryType === "limit" && last != null && numOrNull(entry) == null) setEntry(String(last));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryType, last]);

  /*
   * How far a stop sits when it is added from the chart: about two bars'
   * worth of range, which is what a stop that is not inside the noise has
   * to be. The target is twice that. Both are a starting line to drag.
   */
  const typicalRange = useMemo(() => {
    const recent = candles.slice(-20);
    if (recent.length === 0) return null;
    return recent.reduce((s, k) => s + (k.h - k.l), 0) / recent.length;
  }, [candles]);
  const snap = (p: number) => (rule ? Number(p.toFixed(Math.max(0, Math.round(-Math.log10(rule.tickSize))))) : p);
  const entryActions = useMemo(() => {
    if (live && !ticketToo) return null;
    const e = numOrNull(entry);
    if (e == null) return null;
    const dist = Math.max(typicalRange != null ? typicalRange * 2 : e * 0.005, rule?.tickSize ?? 0);
    const dir = side === "long" ? 1 : -1;
    return {
      price: e,
      hasSl: numOrNull(stop) != null,
      hasTp: numOrNull(targets[0] ?? "") != null,
      onSl: () => setStop(String(snap(e - dir * dist))),
      onTp: () => {
        const s = numOrNull(stop);
        const risk = s != null ? Math.abs(e - s) : dist;
        setTargets((xs) => [String(snap(e + dir * risk * 2)), ...xs.slice(1)]);
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, ticketToo, entry, stop, targets, side, typicalRange, rule]);
  // A new symbol is a new drawing.
  useEffect(() => {
    setStop("");
    setTargets([""]);
    setQty("");
  }, [symbol]);

  const planFor = useCallback(
    (forSide: "long" | "short"): TerminalPlan | null => {
      const e = numOrNull(entry);
      const s0 = numOrNull(stop);
      if (e == null || s0 == null) return null;
      return {
        symbol,
        side: forSide,
        entryType,
        entryPrice: e,
        stop: s0,
        targets: targets.map(numOrNull).filter((x): x is number => x != null),
        riskDollars: sizeMode === "risk" ? numOrNull(risk) : null,
        qty: sizeMode === "qty" ? numOrNull(qty) : null,
        leverage: Number(leverage) || 0,
      };
    },
    [symbol, entryType, entry, stop, targets, sizeMode, risk, qty, leverage],
  );
  const plan = useMemo(() => planFor(side), [planFor, side]);
  const sized = plan && rule ? sizePlan(plan, rule) : null;
  // Both buttons are live at once, as on the venue: each is sized for its own side.
  const sizedFor = (forSide: "long" | "short") => {
    const pl = planFor(forSide);
    return pl && rule ? sizePlan(pl, rule) : null;
  };
  const sizedLong = sizedFor("long");
  const sizedShort = sizedFor("short");
  // The side the drawing implies: a stop under the entry is a long's.
  useEffect(() => {
    const e = numOrNull(entry);
    const s0 = numOrNull(stop);
    if (e != null && s0 != null && s0 !== e) setSide(s0 < e ? "long" : "short");
  }, [entry, stop]);

  /* ---------------- the chart's lines ---------------- */
  const liveBrackets = useMemo(() => bracketsOf(live?.ref ?? null, book.data?.orders ?? []), [live, book.data]);
  const levels = useMemo<Level[]>(() => {
    const drawn: Level[] = [];
    if (!live || ticketToo) {
      const e = numOrNull(entry);
      const s0 = numOrNull(stop);
      if (e != null) drawn.push({ price: e, label: entryType === "market" ? `${side} · market` : `${side} · limit`, color: "entry", dashed: entryType === "market", field: entryType === "limit" ? "entryPrice" : undefined });
      if (s0 != null) drawn.push({ price: s0, label: "stop", color: "stop", dashed: true, field: "initialStop" });
      const t1 = numOrNull(targets[0] ?? "");
      if (t1 != null) drawn.push({ price: t1, label: "target", color: "target", dashed: true, field: "initialTarget" });
      targets.slice(1).forEach((t) => {
        const v = numOrNull(t);
        if (v != null) drawn.push({ price: v, label: "target", color: "target", dashed: true, faint: true });
      });
    }
    if (live) {
      const t = live.t;
      // With a ticket open beside it, the live trade's lines are shown but not dragged: the drag belongs to the drawing.
      const drag = !ticketToo;
      const out: Level[] = [
        t.status === "pending"
          ? { price: t.entryPrice, label: "entry · resting", color: "entry", dashed: true, field: "entryPrice" }
          : { price: t.entryPrice, label: "entry", color: "entry", dashed: false },
      ];
      const waiting = live.ref.armOnFill;
      if (liveBrackets.stop) out.push({ price: liveBrackets.stop.stopPrice!, label: "stop", color: "stop", dashed: false, field: drag ? "initialStop" : undefined });
      else if (waiting) out.push({ price: Number(waiting.stop.stopPrice), label: "stop · on fill", color: "stop", dashed: true, field: drag ? "initialStop" : undefined });
      else if (t.initialStop != null) out.push({ price: t.initialStop, label: "stop · not resting", color: "stop", dashed: true, faint: true });
      if (liveBrackets.targets.length) for (const o of liveBrackets.targets) out.push({ price: o.stopPrice!, label: o.closePosition ? "target" : `take ${num(o.origQty)}`, color: "target", dashed: false, field: drag && o.closePosition ? "initialTarget" : undefined });
      else if (waiting) for (const o of waiting.targets) out.push({ price: Number(o.stopPrice), label: "target · on fill", color: "target", dashed: true, field: drag ? "initialTarget" : undefined });
      if (!drag) out[0] = { ...out[0], field: undefined };
      return [...out.map((l) => (ticketToo ? { ...l, faint: true } : l)), ...drawn];
    }
    return drawn;
  }, [live, ticketToo, liveBrackets, entry, stop, targets, entryType, side]);

  const move = useMoveBracket();
  const moveEntry = useMoveEntry();
  const onLevel = (field: LevelField, price: number, done: boolean) => {
    const p = rule ? Number(price.toFixed(Math.max(0, Math.round(-Math.log10(rule.tickSize))))) : price;
    if (live && !ticketToo) {
      if (!done) return;
      if (field === "entryPrice" && live.t.status === "pending") {
        moveEntry
          .mutateAsync({ tradeId: live.t.id, price: p })
          .then(() => toast({ title: "Entry moved", description: `${symbol} resting at ${num(p)}.` }))
          .catch((err: any) => toast({ title: "Not moved", description: String(err?.message ?? err).slice(0, 200), variant: "destructive" }));
        return;
      }
      const kind = field === "initialStop" ? "stop" : field === "initialTarget" ? "target" : null;
      if (!kind) return;
      move
        .mutateAsync({ tradeId: live.t.id, kind, price: p })
        .then(() => toast({ title: kind === "stop" ? "Stop moved" : "Target moved", description: `${symbol} ${kind} now ${num(p)}.` }))
        .catch((err: any) => toast({ title: "Not moved", description: String(err?.message ?? err).slice(0, 200), variant: "destructive" }));
      return;
    }
    if (field === "entryPrice") setEntry(String(p));
    else if (field === "initialStop") setStop(String(p));
    else if (field === "initialTarget") setTargets((xs) => [String(p), ...xs.slice(1)]);
  };

  /* ---------------- sending ---------------- */
  const send = useSendPlan();
  async function doSend() {
    if (!plan) return;
    try {
      const r = await send.mutateAsync({ account, plan });
      setConfirm(false);
      setTyped("");
      if (r.refused.length) {
        toast({
          title: "Sent — but the venue refused part of it",
          description: r.refused.map((x) => `${x.which}: ${x.reason}`).join(" · ").slice(0, 300),
          variant: "destructive",
        });
      } else {
        toast({ title: `${side === "long" ? "Long" : "Short"} ${symbol} sent`, description: `${r.sized.qty} ${rule?.baseAsset ?? ""} · stop ${num(plan.stop)}${plan.targets.length ? ` · target ${num(plan.targets[0])}` : ""}. Logged as trade #${r.trade.id}.` });
      }
      setStop("");
      setTargets([""]);
      setTicketToo(false);
      setSelectedId(r.trade.id);
    } catch (err: any) {
      toast({ title: "Not sent", description: String(err?.message ?? err).replace(/^\d+:\s*/, "").slice(0, 300), variant: "destructive" });
    }
  }

  const problems = sized?.problems ?? (plan ? [] : ["Draw a stop to size the trade."]);

  const tk = ticker.data;
  const up = (tk?.changePct ?? 0) >= 0;
  const fundingIn = tk?.nextFundingTime ? Math.max(0, tk.nextFundingTime - Date.now()) : null;
  const hhmmss = (ms: number) => {
    const t = Math.floor(ms / 1000);
    return `${String(Math.floor(t / 3600)).padStart(2, "0")}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  };
  const maxQty = (forSide: "long" | "short") => {
    const e = numOrNull(entry);
    if (free == null || e == null || !rule) return null;
    void forSide;
    const q = (free * (Number(leverage) || 1)) / e;
    return Math.floor(q / rule.stepSize) * rule.stepSize;
  };
  const arm = (forSide: "long" | "short") => {
    setSide(forSide);
    setConfirm(true);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-border/50" data-testid="desk">
      <div className="grid gap-px xl:grid-cols-[minmax(0,1fr)_360px]">
        {/* ------------------------------ left: ticker, chart, panel ------------------------------ */}
        <div className="grid min-w-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-px overflow-hidden">
          {/* ticker strip */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 overflow-hidden bg-card px-3 py-1.5" data-testid="bar-terminal-ticker">
            <Input
              list="terminal-symbols"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase().trim())}
              className="h-7 w-28 border-0 bg-transparent px-0 font-sans text-base font-semibold uppercase tracking-tight shadow-none focus-visible:ring-0"
              spellCheck={false}
              data-testid="input-terminal-symbol"
            />
            <datalist id="terminal-symbols">
              {rules.slice(0, 400).map((r) => (
                <option key={r.symbol} value={r.symbol} />
              ))}
            </datalist>
            {last != null && (
              <span className={`flex items-center gap-1.5 font-mono text-lg font-semibold tabular-nums ${tk?.changePct != null ? (up ? UP : DOWN) : ""}`} data-testid="text-terminal-last">
                {num(last)}
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${tapeLive ? "animate-pulse bg-[#0ECB81]" : "bg-muted-foreground/40"}`} aria-label={tapeLive ? "live" : "polling"} />
              </span>
            )}
            {tk && (
              <>
                <Tick k="Mark" v={tk.mark != null ? num(tk.mark) : "—"} />
                <Tick k="24h change" v={tk.changePct != null ? `${tk.change != null ? num(tk.change) : ""} ${tk.changePct >= 0 ? "+" : ""}${tk.changePct.toFixed(2)}%` : "—"} tone={tk.changePct == null ? "" : up ? UP : DOWN} />
                <Tick k="24h high" v={tk.high != null ? num(tk.high) : "—"} />
                <Tick k="24h low" v={tk.low != null ? num(tk.low) : "—"} />
                <Tick k={`24h vol (${quote})`} v={tk.quoteVolume != null ? fmtAmount(tk.quoteVolume, 0) : "—"} />
                <Tick k="Funding / countdown" v={`${tk.fundingRate != null ? `${(tk.fundingRate * 100).toFixed(4)}%` : "—"}${fundingIn != null ? ` / ${hhmmss(fundingIn)}` : ""}`} tone={tk.fundingRate != null ? (tk.fundingRate >= 0 ? UP : DOWN) : ""} />
              </>
            )}
            {!rule && rules.length > 0 && <span className="text-[11px] text-amber-500">not a perpetual on this host</span>}
          </div>

          {/* chart */}
          <div className="min-w-0 overflow-hidden bg-card" data-testid="card-terminal-chart">
            <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-2 py-1">
              <div className="flex items-center gap-0.5">
                {INTERVALS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setInterval_(f)}
                    aria-pressed={interval === f}
                    className={`rounded px-2 py-0.5 font-mono text-[11px] leading-5 transition-colors ${interval === f ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    data-testid={`terminal-tf-${f}`}
                  >
                    {f}
                  </button>
                ))}
              </div>
              {live && (
                <p className="ml-2 text-[11px] text-sky-400/90" data-testid="text-terminal-managing">
                  Managing #{live.t.id}{ticketToo ? " — drawing a new order beside it" : ` — drag the ${live.t.status === "pending" ? "entry, " : ""}stop or target to move the resting order`}
                  {live.ref.unprotected && live.t.status === "open" && <span className="ml-2 font-semibold text-[#F6465D]">No stop is resting on this position.</span>}
                </p>
              )}
              {candlesQ.isError && (
                <p className="ml-2 text-[11px] text-amber-500" data-testid="text-terminal-candles-error">
                  The price feed did not answer for {interval}: {String((candlesQ.error as any)?.message ?? candlesQ.error).replace(/^\d+:\s*/, "").slice(0, 160)}
                </p>
              )}
            </div>
            <div className="min-w-0 overflow-hidden p-1.5">
              {candles.length === 0 ? (
                <p className="py-24 text-center text-[11px] text-muted-foreground" data-testid="text-terminal-no-candles">
                  {candlesQ.isLoading ? "Loading the tape…" : rule ? "No candles." : "Pick a perpetual."}
                </p>
              ) : (
                <Suspense fallback={<div className="h-[500px] animate-pulse rounded-md bg-secondary/30" />}>
                  <Candles
                    seriesKey={symbol}
                    interval={interval}
                    candles={candles}
                    levels={levels}
                    onLevel={onLevel}
                    loadPage={(before) => fetchTerminalPage(symbol, interval, before)}
                    height={500}
                    entryActions={entryActions}
                  />
                </Suspense>
              )}
            </div>
          </div>

          <BottomPanel account={account} mine={mine} book={book.data} selectedId={live?.t.id ?? null} onSelect={select} />
        </div>

        {/* ------------------------------ right: the order form ------------------------------ */}
        <div className="grid min-w-0 content-start gap-px overflow-hidden">
          {live && <ManagePanel live={live} book={book.data} rule={rule} last={last} account={account} onNewOrder={() => setTicketToo((v) => !v)} ticketOpen={ticketToo} />}
          {(!live || ticketToo) && (
            <div className="bg-card" data-testid="card-terminal-ticket">
              {/* margin mode · leverage · available */}
              <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
                <span className="rounded bg-secondary px-2 py-0.5 text-[11px] font-medium">Hedge</span>
                <label className="flex items-center rounded bg-secondary px-2 py-0.5 text-[11px] font-medium">
                  <input value={leverage} onChange={(e) => setLeverage(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" className="w-6 bg-transparent text-right font-mono outline-none" data-testid="input-terminal-leverage" />
                  <span>×</span>
                </label>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                  Avbl <span className="text-foreground">{free != null ? fmtAmount(free, 2) : "—"}</span> {quote}
                </span>
              </div>
              <div className="space-y-3 p-3">
                <div className="flex items-center gap-4 border-b border-border/40 text-[12px] font-medium">
                  {(["limit", "market"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setEntryType(k)}
                      className={`-mb-px border-b-2 pb-1.5 capitalize transition-colors ${entryType === k ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                      aria-pressed={entryType === k}
                      data-testid={`button-terminal-${k}`}
                    >
                      {k}
                    </button>
                  ))}
                </div>

                <Row label="Price" unit={quote} testId="input-terminal-entry" value={entry} onChange={setEntry} disabled={entryType === "market"} placeholder={entryType === "market" ? "Market" : ""}
                  right={entryType === "limit" && last != null ? <button type="button" className="text-[11px] text-primary hover:underline" onClick={() => setEntry(String(last))}>Last</button> : undefined} />
                <div className="grid grid-cols-2 gap-2">
                  <Row label="Stop loss" unit={quote} testId="input-terminal-stop" value={stop} onChange={setStop} tone={DOWN} />
                  <Row label="Take profit" unit={quote} testId="input-terminal-target" value={targets[0] ?? ""} onChange={(v) => setTargets((xs) => [v, ...xs.slice(1)])} tone={UP} />
                </div>
                {targets.length > 1 && (
                  <div className="grid grid-cols-2 gap-2">
                    {targets.slice(1).map((t, i) => (
                      <Row key={i} label={`Take profit ${i + 2}`} unit={quote} testId={`input-terminal-target-${i + 2}`} value={t} onChange={(v) => setTargets((xs) => xs.map((x, j) => (j === i + 1 ? v : x)))} tone={UP} />
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-3 text-[11px]">
                  {targets.length < 3 && (
                    <button type="button" className="text-muted-foreground transition-colors hover:text-foreground" onClick={() => setTargets((xs) => [...xs, ""])} data-testid="button-terminal-add-target">
                      + another take profit
                    </button>
                  )}
                  {targets.length > 1 && (
                    <button type="button" className="text-muted-foreground transition-colors hover:text-foreground" onClick={() => setTargets((xs) => xs.slice(0, -1))}>
                      − last
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-[auto_1fr] items-stretch gap-2">
                  <Segmented
                    size="xs"
                    value={sizeMode}
                    onChange={setSizeMode}
                    ariaLabel="Size by"
                    options={[
                      { id: "risk", label: "Risk", testId: "button-terminal-size-risk" },
                      { id: "qty", label: "Size", testId: "button-terminal-size-qty" },
                    ]}
                  />
                  {sizeMode === "risk" ? (
                    <Row label="Risk" unit={quote} testId="input-terminal-risk" value={risk} onChange={setRisk} />
                  ) : (
                    <Row label="Size" unit={rule?.baseAsset ?? ""} testId="input-terminal-qty" value={qty} onChange={setQty} />
                  )}
                </div>
                {sizeMode === "risk" && (
                  <div className="flex gap-1">
                    {[25, 50, 100, 200].map((r) => (
                      <button key={r} type="button" onClick={() => setRisk(String(r))} className={`flex-1 rounded border px-1 py-0.5 font-mono text-[10px] transition-colors ${risk === String(r) ? "border-primary/60 bg-secondary text-foreground" : "border-border/60 text-muted-foreground hover:text-foreground"}`} data-testid={`button-terminal-risk-${r}`}>
                        ${r}
                      </button>
                    ))}
                  </div>
                )}

                {sized && problems.length === 0 ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-[11px] text-muted-foreground" data-testid="text-terminal-sized">
                    <span>Size</span><span className="text-right text-foreground">{sized.qty} {rule?.baseAsset}</span>
                    <span>Notional</span><span className="text-right text-foreground">{fmtAmount(sized.notional, 2)}</span>
                    <span>Risk</span><span className={`text-right ${DOWN}`}>{fmtAmount(sized.riskDollars, 2)}</span>
                    {plan && plan.targets[0] != null && (
                      <>
                        <span>To target</span><span className={`text-right ${UP}`}>{(Math.abs(plan.targets[0] - plan.entryPrice) / Math.abs(plan.entryPrice - plan.stop)).toFixed(2)}R</span>
                      </>
                    )}
                  </div>
                ) : (
                  <p className="text-[11px] text-amber-500" data-testid="text-terminal-problems">
                    {problems[0]}
                  </p>
                )}

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <Button className={`h-10 bg-[#0ECB81] text-sm font-semibold text-white hover:bg-[#2EBD85] disabled:opacity-40 ${sizedLong && sizedLong.problems.length === 0 ? "" : ""}`} disabled={!rule || !hedge || send.isPending || !(live ? ticketToo : true) || !sizedLong || sizedLong.problems.length > 0} onClick={() => arm("long")} data-testid="button-terminal-long">
                    {send.isPending && side === "long" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Buy / Long
                  </Button>
                  <Button className="h-10 bg-[#F6465D] text-sm font-semibold text-white hover:bg-[#FF707E] disabled:opacity-40" disabled={!rule || !hedge || send.isPending || !(live ? ticketToo : true) || !sizedShort || sizedShort.problems.length > 0} onClick={() => arm("short")} data-testid="button-terminal-short">
                    {send.isPending && side === "short" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Sell / Short
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2 font-mono text-[10px] text-muted-foreground">
                  <div className="flex justify-between"><span>Cost</span><span>{sizedLong && sizedLong.problems.length === 0 ? fmtAmount(sizedLong.margin, 2) : "—"}</span></div>
                  <div className="flex justify-between"><span>Cost</span><span>{sizedShort && sizedShort.problems.length === 0 ? fmtAmount(sizedShort.margin, 2) : "—"}</span></div>
                  <div className="flex justify-between"><span>Max</span><span>{maxQty("long") != null ? `${num(maxQty("long")!)} ${rule?.baseAsset ?? ""}` : "—"}</span></div>
                  <div className="flex justify-between"><span>Max</span><span>{maxQty("short") != null ? `${num(maxQty("short")!)} ${rule?.baseAsset ?? ""}` : "—"}</span></div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <Dialog open={confirm} onOpenChange={(o) => !o && setConfirm(false)}>
        <DialogContent className="max-w-sm" data-testid="dialog-terminal-confirm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              Send this plan? <EnvBadge env={env} />
            </DialogTitle>
          </DialogHeader>
          {plan && sized && (
            <ul className="space-y-1 font-mono text-xs">
              <li>
                <b className={side === "long" ? "text-emerald-400" : "text-red-400"}>{side.toUpperCase()}</b> {symbol} · {sized.qty} {rule?.baseAsset} · {leverage}×
              </li>
              <li>entry {entryType === "market" ? "at market" : `limit ${num(plan.entryPrice)}`}</li>
              <li className="text-red-400">stop {num(plan.stop)} · first on the book</li>
              {plan.targets.map((t, i) => (
                <li key={i} className="text-emerald-400">
                  target {plan.targets.length > 1 ? i + 1 : ""} {num(t)}
                </li>
              ))}
              <li className="text-muted-foreground">
                risk {fmtAmount(sized.riskDollars, 2)} · {fmtAmount(sized.notional, 0)} notional · {fmtAmount(sized.margin, 0)} margin
              </li>
            </ul>
          )}
          {env === "live" && (
            <label className="block space-y-1 pt-1">
              <span className="block text-[10px] uppercase tracking-wider text-red-400">Real money — type SEND to confirm</span>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus spellCheck={false} autoComplete="off" className="h-8 font-mono text-sm uppercase" data-testid="input-terminal-type-send" />
            </label>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={() => { setConfirm(false); setTyped(""); }} data-testid="button-terminal-confirm-no">
              Not yet
            </Button>
            <Button size="sm" className={`text-white ${side === "long" ? "bg-[#0ECB81] hover:bg-[#2EBD85]" : "bg-[#F6465D] hover:bg-[#FF707E]"}`} onClick={() => void doSend()} disabled={send.isPending || !armedToSend} data-testid="button-terminal-confirm-yes">
              {send.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Send
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Desktop notifications for the original stop or target being hit: asked for with a click, as browsers require. */
function AlertsBell() {
  const [state, setState] = useState<NotificationPermission | "unsupported">(() => (typeof Notification === "undefined" ? "unsupported" : Notification.permission));
  if (state === "unsupported") return null;
  const on = state === "granted";
  return (
    <Button
      size="sm"
      variant="ghost"
      className={`h-8 px-2 text-[11px] ${on ? "text-emerald-400" : "text-muted-foreground"}`}
      title={on ? "Desktop alerts on: you are told when an original stop or target is hit." : state === "denied" ? "Desktop alerts are blocked in this browser's site settings." : "Turn on desktop alerts for original stop/target hits"}
      disabled={state === "denied"}
      onClick={() => {
        if (on) return;
        void Notification.requestPermission().then((p) => setState(p));
      }}
      data-testid="button-terminal-alerts"
    >
      {on ? <Bell className="mr-1 h-3.5 w-3.5" /> : <BellOff className="mr-1 h-3.5 w-3.5" />}
      {on ? "alerts on" : "alerts"}
    </Button>
  );
}

/* ------------------------------ managing a trade ------------------------------ */

type Live = { t: TradeWithTags; ref: NonNullable<ReturnType<typeof parseTerminalRef>> };

/**
 * What you do to a trade once it is on: move the stop and the target, take
 * some off, add some, move a resting entry, close. Each is one call to the
 * venue and one line in the journal; the recent terminal log sits under it
 * so a refusal is read here rather than guessed at.
 */
function ManagePanel({
  live,
  book,
  rule,
  last,
  account,
  onNewOrder,
  ticketOpen,
}: {
  live: Live;
  book: BookData | undefined;
  rule: SymbolRules | null;
  last: number | null;
  account: string;
  onNewOrder: () => void;
  ticketOpen: boolean;
}) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { t, ref } = live;
  const resting = t.status === "pending";
  const pos = (book?.positions ?? []).find((p) => p.symbol === ref.symbol && p.positionSide === ref.positionSide) ?? null;
  const br = bracketsOf(ref, book?.orders ?? []);
  const waiting = resting ? ref.armOnFill : undefined;
  const currentStop = br.stop?.stopPrice ?? (waiting ? Number(waiting.stop.stopPrice) : null);
  const currentTarget = br.targets[0]?.stopPrice ?? (waiting?.targets[0] ? Number(waiting.targets[0].stopPrice) : null);
  const held = pos ? Math.abs(pos.amt) : t.size;
  const long = t.direction === "long";
  const entry = pos?.entryPrice || t.entryPrice;
  // Against the original risk: a stop moved to breakeven does not make the next tick a ten-R trade.
  const stopForR = ref.idea?.stop ?? t.initialStop ?? currentStop ?? null;
  const risk = stopForR != null ? Math.abs(t.entryPrice - stopForR) : null;
  const rNow = pos && risk ? ((long ? 1 : -1) * (pos.markPrice - entry)) / risk : null;

  const [stopIn, setStopIn] = useState(currentStop != null ? String(currentStop) : "");
  const [targetIn, setTargetIn] = useState(currentTarget != null ? String(currentTarget) : "");
  const [entryIn, setEntryIn] = useState(String(t.entryPrice));
  const [takeQty, setTakeQty] = useState("");
  const [takeAtQty, setTakeAtQty] = useState("");
  const [takeAtPrice, setTakeAtPrice] = useState("");
  const [addQty, setAddQty] = useState("");
  const [addType, setAddType] = useState<"market" | "limit">("market");
  const [addPrice, setAddPrice] = useState("");
  // The fields follow the book until they are being typed in.
  useEffect(() => setStopIn(currentStop != null ? String(currentStop) : ""), [currentStop]);
  useEffect(() => setTargetIn(currentTarget != null ? String(currentTarget) : ""), [currentTarget]);
  useEffect(() => setEntryIn(String(t.entryPrice)), [t.entryPrice]);

  const move = useMoveBracket();
  const moveEntry = useMoveEntry();
  const reduce = useReduce();
  const add = useAddSize();
  const takeAt = useTakeAt();
  const cancelOrder = useCancelOrder();
  const close = useCloseTerminalTrade();
  const cancel = useCancelTerminalTrade();
  const busy = move.isPending || moveEntry.isPending || reduce.isPending || add.isPending || takeAt.isPending || close.isPending || cancel.isPending;
  // The original risk, for the one-click stops: breakeven and a locked R.
  const idea = ref.idea;
  const risk0 = (idea?.stop ?? t.initialStop) != null ? Math.abs(t.entryPrice - (idea?.stop ?? t.initialStop)!) : null;
  const dir = long ? 1 : -1;
  const beAt = t.entryPrice;
  const lockAt = risk0 != null ? t.entryPrice + dir * risk0 : null;
  const canLock = (p: number | null) => p != null && pos != null && (long ? pos.markPrice > p : pos.markPrice < p) && p !== currentStop;
  const heldFor = (() => {
    const ms = Date.now() - new Date(t.entryTime).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    const m = Math.floor(ms / 60_000);
    return m < 60 ? `${m}m` : m < 60 * 24 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  })();
  const { data: log = [] } = useTerminalLog(true);
  const mineLog = log.filter((l) => l.tradeId === t.id).slice(0, 6);

  const run = (title: string, p: Promise<unknown>, done: string) =>
    p.then(() => toast({ title, description: done })).catch((err: any) => toast({ title: `${title} — not done`, description: String(err?.message ?? err).replace(/^\d+:\s*/, "").slice(0, 220), variant: "destructive" }));
  const digits = rule ? Math.max(0, Math.round(-Math.log10(rule.tickSize))) : 2;
  const fmt = (v: number) => v.toFixed(digits);

  const tone = (v: number | null | undefined) => (v == null ? "" : v >= 0 ? "text-emerald-400" : "text-red-400");
  const sideCls = long ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400";

  return (
    <Card className="overflow-hidden border-card-border bg-card" data-testid="card-terminal-manage">
      {/* ---- the position ---- */}
      <div className="border-b border-border/60 bg-gradient-to-b from-secondary/30 to-transparent px-3.5 pb-3 pt-3">
        <div className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider ${sideCls}`}>{long ? "LONG" : "SHORT"}</span>
          <span className="font-mono text-sm font-semibold">{ref.symbol}</span>
          {resting && <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">resting</span>}
          <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
            <button type="button" className="inline-flex items-center gap-0.5 transition-colors hover:text-foreground" onClick={() => navigate(`/trade/${t.id}`)} title="Open the trade's page" data-testid="link-manage-trade">
              #{t.id} <ExternalLink className="h-3 w-3" />
            </button>
            <span>· {ref.leverage}×</span>
          </span>
        </div>
        <div className="mt-2 flex items-end justify-between gap-3">
          <div>
            {pos && !resting ? (
              <div className={`font-mono text-2xl font-semibold leading-none tabular-nums ${tone(pos.unrealized)}`} data-testid="text-manage-upnl">
                {fmtMoney(pos.unrealized)}
                {rNow != null && <span className="ml-2 text-sm font-medium opacity-80">{rNow >= 0 ? "+" : ""}{rNow.toFixed(2)}R</span>}
              </div>
            ) : (
              <div className="font-mono text-2xl font-semibold leading-none text-muted-foreground">—</div>
            )}
            <div className="mt-1.5 font-mono text-[11px] text-muted-foreground">
              {num(held)} {rule?.baseAsset ?? ""} @ {num(entry)}
            </div>
          </div>
          {pos && !resting && (
            <div className="grid grid-cols-3 gap-x-3 text-right font-mono text-[11px] tabular-nums" data-testid="text-manage-position">
              <div><div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">mark</div>{num(pos.markPrice)}</div>
              <div><div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">liq</div>{pos.liquidationPrice != null ? num(pos.liquidationPrice) : "—"}</div>
              <div><div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">on for</div>{heldFor ?? "—"}</div>
            </div>
          )}
        </div>
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/80">
          idea · {num(ref.idea?.entry ?? t.entryPrice)} · stop {(ref.idea?.stop ?? t.initialStop) != null ? num((ref.idea?.stop ?? t.initialStop)!) : "—"} · target{" "}
          {(ref.idea?.targets[0] ?? t.initialTarget) != null ? num((ref.idea?.targets[0] ?? t.initialTarget)!) : "—"}
        </p>
        {!resting && <PlanWatchLine t={t} ref_={ref} mark={pos?.markPrice ?? last} />}
      </div>

      <div className="space-y-4 p-3.5">
        {resting && (
          <section className="space-y-1.5">
            <SectionLabel>Resting entry</SectionLabel>
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-1.5">
              <Input value={entryIn} onChange={(e) => setEntryIn(e.target.value)} inputMode="decimal" className="h-8 font-mono text-sm" data-testid="input-manage-entry" />
              <Button size="sm" variant="outline" className={CHIP} disabled={busy || numOrNull(entryIn) == null || numOrNull(entryIn) === t.entryPrice}
                onClick={() => run("Entry moved", moveEntry.mutateAsync({ tradeId: t.id, price: numOrNull(entryIn)! }), `Resting at ${entryIn}.`)} data-testid="button-manage-move-entry">
                Move
              </Button>
              <Button size="sm" variant="ghost" className={`${CHIP} text-muted-foreground`} disabled={busy}
                onClick={() => run("Cancelled", cancel.mutateAsync(t.id), "The resting order is off the book.")} data-testid="button-manage-cancel">
                Cancel
              </Button>
            </div>
          </section>
        )}

        {/* ---- protection ---- */}
        <section className="space-y-1.5">
          <div className="flex items-center justify-between">
            <SectionLabel tone={currentStop == null && !waiting ? "text-red-400" : undefined}>
              Stop{currentStop == null ? (waiting ? " · on fill" : " · none resting") : br.stop ? "" : " · on fill"}
            </SectionLabel>
            {!resting && pos && rNow != null && <span className="font-mono text-[10px] text-muted-foreground">{rNow >= 0 ? "+" : ""}{rNow.toFixed(2)}R now</span>}
          </div>
          <div className="grid grid-cols-[1fr_auto] items-center gap-1.5">
            <Input value={stopIn} onChange={(e) => setStopIn(e.target.value)} inputMode="decimal" placeholder="stop price" className={`h-8 font-mono text-sm ${currentStop == null && !waiting ? "border-red-500/50" : ""}`} data-testid="input-manage-stop" />
            <Button size="sm" variant="outline" className={CHIP} disabled={busy || numOrNull(stopIn) == null || numOrNull(stopIn) === currentStop}
              onClick={() => run("Stop set", move.mutateAsync({ tradeId: t.id, kind: "stop", price: numOrNull(stopIn)! }), `${ref.symbol} stop ${stopIn}.`)} data-testid="button-manage-set-stop">
              {currentStop == null ? "Place" : "Set"}
            </Button>
          </div>
          {!resting && (
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" className={CHIP} disabled={busy || !canLock(beAt)} title="Stop to the entry: the trade can no longer lose"
                onClick={() => run("Stop at breakeven", move.mutateAsync({ tradeId: t.id, kind: "stop", price: beAt }), `${ref.symbol} stop ${num(beAt)}.`)} data-testid="button-manage-be">
                → breakeven
              </Button>
              {lockAt != null && (
                <Button size="sm" variant="outline" className={CHIP} disabled={busy || !canLock(lockAt)} title="Stop one original risk into profit"
                  onClick={() => run("Locked +1R", move.mutateAsync({ tradeId: t.id, kind: "stop", price: lockAt }), `${ref.symbol} stop ${num(lockAt)}.`)} data-testid="button-manage-lock-1r">
                  lock +1R
                </Button>
              )}
            </div>
          )}
        </section>

        {/* ---- target ---- */}
        <section className="space-y-1.5">
          <SectionLabel>Target{currentTarget == null ? " · none" : br.targets.length ? "" : " · on fill"}</SectionLabel>
          <div className="grid grid-cols-[1fr_auto] items-center gap-1.5">
            <Input value={targetIn} onChange={(e) => setTargetIn(e.target.value)} inputMode="decimal" placeholder="target price" className="h-8 font-mono text-sm" data-testid="input-manage-target" />
            <Button size="sm" variant="outline" className={CHIP} disabled={busy || numOrNull(targetIn) == null || numOrNull(targetIn) === currentTarget}
              onClick={() => run("Target set", move.mutateAsync({ tradeId: t.id, kind: "target", price: numOrNull(targetIn)! }), `${ref.symbol} target ${targetIn}.`)} data-testid="button-manage-set-target">
              {currentTarget == null ? "Place" : "Set"}
            </Button>
          </div>
        </section>

        {!resting && (
          <>
            {/* ---- take profit ---- */}
            <section className="space-y-1.5">
              <SectionLabel>Take profit</SectionLabel>
              <div className="flex flex-wrap items-center gap-1.5">
                {[0.25, 0.5, 0.75].map((f) => (
                  <Button key={f} size="sm" variant="outline" className={CHIP} disabled={busy || !pos}
                    onClick={() => run(`Took ${Math.round(f * 100)}%`, reduce.mutateAsync({ tradeId: t.id, fraction: f }), `${fmt(held * f)} ${rule?.baseAsset ?? ""} off at market.`)} data-testid={`button-manage-take-${Math.round(f * 100)}`}>
                    {Math.round(f * 100)}%
                  </Button>
                ))}
                <Input value={takeQty} onChange={(e) => setTakeQty(e.target.value)} placeholder="qty" inputMode="decimal" className="h-7 w-20 font-mono text-[11px]" data-testid="input-manage-take-qty" />
                <Button size="sm" variant="outline" className={CHIP} disabled={busy || !pos || numOrNull(takeQty) == null}
                  onClick={() => run("Took profit", reduce.mutateAsync({ tradeId: t.id, qty: numOrNull(takeQty)! }), `${takeQty} off at market.`).then(() => setTakeQty(""))} data-testid="button-manage-take-qty">
                  at market
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Input value={takeAtQty} onChange={(e) => setTakeAtQty(e.target.value)} placeholder="qty" inputMode="decimal" className="h-7 w-20 font-mono text-[11px]" data-testid="input-manage-take-at-qty" />
                <Input value={takeAtPrice} onChange={(e) => setTakeAtPrice(e.target.value)} placeholder="at price" inputMode="decimal" className="h-7 w-24 font-mono text-[11px]" data-testid="input-manage-take-at-price" />
                <Button size="sm" variant="outline" className={CHIP} disabled={busy || !pos || numOrNull(takeAtQty) == null || numOrNull(takeAtPrice) == null}
                  onClick={() => run("Take resting", takeAt.mutateAsync({ tradeId: t.id, qty: numOrNull(takeAtQty)!, price: numOrNull(takeAtPrice)! }), `${takeAtQty} off at ${takeAtPrice} when it gets there.`).then(() => { setTakeAtQty(""); setTakeAtPrice(""); })} data-testid="button-manage-take-at">
                  rest it
                </Button>
              </div>
              {br.targets.filter((o) => !o.closePosition).length > 0 && (
                <ul className="space-y-0.5 font-mono text-[10px] text-muted-foreground" data-testid="list-manage-takes">
                  {br.targets.filter((o) => !o.closePosition).map((o) => (
                    <li key={o.orderId} className="flex items-center gap-2">
                      <span className="h-1 w-1 rounded-full bg-emerald-400" />
                      <span>take {num(o.origQty)} at {num(o.stopPrice ?? 0)}</span>
                      <button type="button" className="inline-flex items-center text-muted-foreground transition-colors hover:text-red-400" disabled={cancelOrder.isPending} title="Cancel this take"
                        onClick={() => run("Take cancelled", cancelOrder.mutateAsync({ account, symbol: ref.symbol, orderId: o.orderId }), "Off the book.")} data-testid={`button-manage-cancel-take-${o.orderId}`}>
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ---- add ---- */}
            <section className="space-y-1.5">
              <SectionLabel>Add size</SectionLabel>
              <div className="flex flex-wrap items-center gap-1.5">
                <Input value={addQty} onChange={(e) => setAddQty(e.target.value)} placeholder="qty" inputMode="decimal" className="h-7 w-20 font-mono text-[11px]" data-testid="input-manage-add-qty" />
                <Segmented size="xs" value={addType} onChange={setAddType} ariaLabel="Add at" options={[{ id: "market", label: "market", testId: "button-manage-add-market" }, { id: "limit", label: "limit", testId: "button-manage-add-limit" }]} />
                {addType === "limit" && (
                  <Input value={addPrice} onChange={(e) => setAddPrice(e.target.value)} placeholder={last != null ? fmt(last) : "price"} inputMode="decimal" className="h-7 w-24 font-mono text-[11px]" data-testid="input-manage-add-price" />
                )}
                <Button size="sm" variant="outline" className={CHIP} disabled={busy || numOrNull(addQty) == null || (addType === "limit" && numOrNull(addPrice) == null)}
                  onClick={() => run("Added", add.mutateAsync({ tradeId: t.id, qty: numOrNull(addQty)!, price: addType === "limit" ? numOrNull(addPrice) : null }), addType === "limit" ? `${addQty} resting at ${addPrice}.` : `${addQty} more at market.`).then(() => setAddQty(""))} data-testid="button-manage-add">
                  add
                </Button>
              </div>
              {(ref.addOrderIds?.length ?? 0) > 0 && (
                <p className="font-mono text-[10px] text-muted-foreground">
                  {(book?.orders ?? []).filter((o) => ref.addOrderIds!.includes(o.orderId)).map((o) => `${num(o.origQty)} resting at ${num(o.price ?? 0)}`).join(" · ") || `${ref.addOrderIds!.length} add${ref.addOrderIds!.length === 1 ? "" : "s"} filled`}
                </p>
              )}
            </section>

            <div className="grid grid-cols-[1fr_auto] gap-2 pt-1">
              <Button variant="outline" className="h-9 border-red-500/40 text-xs font-semibold text-red-400 hover:bg-red-500/10 hover:text-red-300" disabled={busy || !pos}
                onClick={() => run("Closed at market", close.mutateAsync(t.id), "The position is flat and the brackets are off.")} data-testid="button-manage-close">
                Close at market
              </Button>
              <Button variant="ghost" className="h-9 text-xs text-muted-foreground" onClick={onNewOrder} data-testid="button-manage-new-order">
                {ticketOpen ? "Hide ticket" : "New order"}
              </Button>
            </div>
          </>
        )}

        {mineLog.length > 0 && (
          <ul className="space-y-0.5 border-t border-border/60 pt-2 font-mono text-[10px]" data-testid="list-manage-log">
            {mineLog.map((l) => (
              <li key={l.id} className={`flex gap-2 truncate ${l.ok ? "text-muted-foreground/80" : "text-red-400"}`} title={l.response ?? ""}>
                <span className="shrink-0 tabular-nums">{new Date(l.at).toLocaleTimeString(undefined, { hour: "2-digit", hourCycle: "h23", minute: "2-digit", second: "2-digit" })}</span>
                <span className="truncate">{l.action} {l.ok ? "" : `— ${(l.response ?? "").slice(0, 80)}`}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** One scale for every small action on the desk. */
const CHIP = "h-7 rounded-md border-border/60 bg-secondary/30 px-2.5 font-mono text-[11px] hover:bg-secondary/70 disabled:opacity-40";

function SectionLabel({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return <span className={`block text-[10px] font-medium uppercase tracking-[0.12em] ${tone ?? "text-muted-foreground/80"}`}>{children}</span>;
}


/** Which original level the tape has reached, and what set-and-forget would be worth now. */
function PlanWatchLine({ t, ref_, mark }: { t: TradeWithTags; ref_: NonNullable<ReturnType<typeof parseTerminalRef>>; mark: number | null }) {
  const w = ref_.planWatch;
  const plan = planVerdictOf(t, ref_);
  const idea = ref_.idea;
  const nowR = rAt(mark, t.entryPrice, idea?.stop ?? t.initialStop, t.direction);
  const hhmm = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (plan.verdict) {
    const stop = plan.verdict === "stop_first";
    return (
      <p className={`mt-1 text-[11px] font-medium ${stop ? "text-red-400" : "text-emerald-400"}`} data-testid="text-manage-plan-hit">
        Original {stop ? "stop" : "target"} hit{plan.at ? ` at ${hhmm(plan.at)}` : ""} — set and forget {plan.planR != null ? `${plan.planR >= 0 ? "+" : ""}${plan.planR.toFixed(2)}R` : ""}
        {nowR != null && <span className="text-muted-foreground">; you are at {nowR >= 0 ? "+" : ""}{nowR.toFixed(2)}R</span>}
      </p>
    );
  }
  return (
    <p className="mt-1 text-[10px] text-muted-foreground/80" data-testid="text-manage-plan-watch">
      {w ? "Neither original level reached yet" : "Watching the tape for the original levels"}
      {nowR != null && ` · ${nowR >= 0 ? "+" : ""}${nowR.toFixed(2)}R now`}
    </p>
  );
}


/** The resting brackets that carry a trade's tag. */
/** The brackets on the book for a trade: by the tag its own orders carry, or by the ids an adopted one was given. */
function bracketsOf(ref: { tag: string; stopOrderId?: number | null; targetOrderIds?: number[] } | null, orders: VenueOrder[]): { stop: VenueOrder | null; targets: VenueOrder[] } {
  if (!ref) return { stop: null, targets: [] };
  const ids = new Set([ref.stopOrderId, ...(ref.targetOrderIds ?? [])].filter((x): x is number => x != null));
  const mine = orders.filter((o) => o.clientOrderId.startsWith(ref.tag) || ids.has(o.orderId));
  return {
    stop: mine.find((o) => o.type === "STOP_MARKET") ?? null,
    targets: mine.filter((o) => o.type === "TAKE_PROFIT_MARKET"),
  };
}

/* ------------------------------ the bottom panel ------------------------------ */

const UP = "text-[#0ECB81]";
const DOWN = "text-[#F6465D]";

function Tick({ k, v, tone = "" }: { k: string; v: string; tone?: string }) {
  return (
    <span className="flex flex-col leading-tight">
      <span className="text-[10px] text-muted-foreground">{k}</span>
      <span className={`font-mono text-[11px] tabular-nums ${tone}`}>{v}</span>
    </span>
  );
}

/** One input row as the venue draws it: label on the left, unit on the right, the number between. */
function Row({ label, unit, value, onChange, disabled, placeholder, tone = "", right, testId }: { label: string; unit?: string; value: string; onChange: (v: string) => void; disabled?: boolean; placeholder?: string; tone?: string; right?: React.ReactNode; testId: string }) {
  return (
    <label className={`flex h-9 items-center gap-2 rounded-md border border-border/60 bg-secondary/20 px-2.5 focus-within:border-primary/60 ${disabled ? "opacity-70" : ""}`}>
      <span className={`shrink-0 text-[11px] ${tone || "text-muted-foreground"}`}>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder={placeholder} inputMode="decimal" className="min-w-0 flex-1 bg-transparent text-right font-mono text-sm tabular-nums outline-none placeholder:text-muted-foreground/60" data-testid={testId} />
      {right}
      {unit && <span className="shrink-0 text-[11px] text-muted-foreground">{unit}</span>}
    </label>
  );
}

type Mine = { t: TradeWithTags; ref: NonNullable<ReturnType<typeof parseTerminalRef>> };

/**
 * Positions, open orders and the log, as tabs under the chart: the venue's
 * own arrangement, which is where a trader's eyes already go. A position row
 * is the way to its trade; the quick actions sit at its end.
 */
function BottomPanel({ account, mine, book, selectedId, onSelect }: { account: string; mine: Mine[]; book: ReturnType<typeof useTerminalBook>["data"]; selectedId: number | null; onSelect: (x: Mine) => void }) {
  const [tab, setTab] = useState<"positions" | "orders" | "log">("positions");
  const positions = book?.positions ?? [];
  const orders = book?.orders ?? [];
  const unmanaged = positions.filter((p) => !mine.some((m) => m.ref.symbol === p.symbol && m.ref.positionSide === p.positionSide));
  const { data: log = [] } = useTerminalLog(tab === "log");
  const tabs: { id: typeof tab; label: string; n: number }[] = [
    { id: "positions", label: "Positions", n: mine.length + unmanaged.length },
    { id: "orders", label: "Open Orders", n: orders.length },
    { id: "log", label: "Log", n: 0 },
  ];
  return (
    <div className="min-w-0 overflow-hidden bg-card" data-testid="card-terminal-book">
      <div className="flex items-center gap-5 border-b border-border/40 px-3 text-[12px] font-medium">
        {tabs.map((x) => (
          <button key={x.id} type="button" onClick={() => setTab(x.id)} aria-pressed={tab === x.id} className={`-mb-px border-b-2 py-2 transition-colors ${tab === x.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`} data-testid={`tab-terminal-${x.id}`}>
            {x.label}
            {x.n > 0 && <span className="ml-1 text-muted-foreground">({x.n})</span>}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-muted-foreground">{account}</span>
      </div>
      <div className="overflow-x-auto">
        {tab === "positions" && <PositionsTable account={account} mine={mine} book={book} selectedId={selectedId} onSelect={onSelect} unmanaged={unmanaged} />}
        {tab === "orders" && <OrdersTable account={account} mine={mine} orders={orders} />}
        {tab === "log" && (
          <ul className="divide-y divide-border/30 px-3 py-1 font-mono text-[11px]" data-testid="list-terminal-log">
            {log.length === 0 && <li className="py-3 text-center text-muted-foreground">Nothing yet.</li>}
            {log.slice(0, 40).map((l) => (
              <li key={l.id} className={`flex gap-3 py-1 ${l.ok ? "text-muted-foreground" : DOWN}`} title={l.response ?? ""}>
                <span className="shrink-0 tabular-nums">{new Date(l.at).toLocaleTimeString(undefined, { hour: "2-digit", hourCycle: "h23", minute: "2-digit", second: "2-digit" })}</span>
                <span className="w-24 shrink-0 text-foreground/80">{l.action}</span>
                {l.tradeId != null && <span className="shrink-0">#{l.tradeId}</span>}
                <span className="truncate">{l.ok ? (l.request ?? "").slice(0, 120) : `failed — ${(l.response ?? "").slice(0, 120)}`}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const TH = "px-2 py-1.5 text-left text-[10px] font-medium text-muted-foreground whitespace-nowrap first:pl-3 last:pr-3";
const TD = "px-2 py-2 font-mono text-[11px] tabular-nums whitespace-nowrap first:pl-3 last:pr-3";

function PositionsTable({ account, mine, book, selectedId, onSelect, unmanaged }: { account: string; mine: Mine[]; book: ReturnType<typeof useTerminalBook>["data"]; selectedId: number | null; onSelect: (x: Mine) => void; unmanaged: VenuePositionRow[] }) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const close = useCloseTerminalTrade();
  const cancel = useCancelTerminalTrade();
  const reduce = useReduce();
  const move = useMoveBracket();
  const adopt = useAdoptPosition();
  const act = (what: "close" | "cancel", id: number) =>
    (what === "close" ? close : cancel)
      .mutateAsync(id)
      .then((r) => toast({ title: what === "close" ? "Closed at market" : "Cancelled", description: `Trade #${id} is ${r.trade.status}.` }))
      .catch((err: any) => toast({ title: "Not done", description: String(err?.message ?? err).slice(0, 200), variant: "destructive" }));
  const positions = book?.positions ?? [];
  const posFor = (symbol: string, side: "LONG" | "SHORT") => positions.find((p) => p.symbol === symbol && p.positionSide === side);
  if (mine.length === 0 && unmanaged.length === 0) return <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">No open positions.</p>;
  return (
    <table className="w-full min-w-[560px] border-collapse">
      <thead>
        <tr className="border-b border-border/30">
          <th className={TH}>Symbol</th>
          <th className={TH}>Size</th>
          <th className={TH}>Entry / Mark</th>
          <th className={TH}>Margin / Liq.</th>
          <th className={TH}>PNL (ROI %) / R</th>
          <th className={TH}>TP / SL</th>
          <th className={`${TH} text-right`}></th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border/30">
        {mine.map(({ t, ref }) => {
          const p = posFor(ref.symbol, ref.positionSide);
          const br = bracketsOf(ref, book?.orders ?? []);
          const waiting = t.status === "pending" ? ref.armOnFill : undefined;
          const stop0 = ref.idea?.stop ?? t.initialStop ?? null;
          const risk0 = stop0 != null ? Math.abs(t.entryPrice - stop0) : null;
          const rNow = p && risk0 ? ((t.direction === "long" ? 1 : -1) * (p.markPrice - t.entryPrice)) / risk0 : null;
          const selected = selectedId === t.id;
          const long = t.direction === "long";
          const size = p && t.status === "open" ? Math.abs(p.amt) : t.size;
          const entryPx = p && t.status === "open" && p.entryPrice ? p.entryPrice : t.entryPrice;
          const margin = p ? (size * entryPx) / (ref.leverage || 1) : null;
          const roi = p && margin ? (p.unrealized / margin) * 100 : null;
          const stopPx = br.stop?.stopPrice ?? (waiting ? Number(waiting.stop.stopPrice) : null);
          return (
            <tr
              key={t.id}
              className={`cursor-pointer transition-colors ${selected ? "bg-secondary/40" : "hover:bg-secondary/20"}`}
              onClick={() => onSelect({ t, ref })}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSelect({ t, ref });
              }}
              aria-pressed={selected}
              data-testid={`row-terminal-trade-${t.id}`}
            >
              <td className={`${TD} border-l-2 ${long ? "border-l-[#0ECB81]" : "border-l-[#F6465D]"}`}>
                <div className="flex items-center gap-2">
                  <span className="font-sans text-[12px] font-semibold">{ref.symbol}</span>
                  <span className={`rounded px-1 py-px text-[9px] font-semibold ${long ? "bg-[#0ECB81]/15 text-[#0ECB81]" : "bg-[#F6465D]/15 text-[#F6465D]"}`}>{long ? "Long" : "Short"} {ref.leverage}x</span>
                  {t.status === "pending" && <span className="rounded bg-secondary px-1 py-px text-[9px] uppercase tracking-wider text-muted-foreground">resting</span>}
                </div>
              </td>
              <td className={`${TD} ${long ? UP : DOWN}`}>{num(size)} {ref.symbol.replace(/USDT$|USDC$|BUSD$/, "")}</td>
              <td className={`${TD} leading-tight`}>
                <div>{num(entryPx)}</div>
                <div className="text-muted-foreground">{p ? num(p.markPrice) : "—"}</div>
              </td>
              <td className={`${TD} leading-tight`}>
                <div>{margin != null ? fmtAmount(margin, 2) : "—"}</div>
                <div className="text-amber-400/80">{p?.liquidationPrice != null ? num(p.liquidationPrice) : "—"}</div>
              </td>
              <td className={`${TD} leading-tight ${p ? (p.unrealized >= 0 ? UP : DOWN) : ""}`}>
                {p ? (
                  <>
                    <div>
                      {fmtMoney(p.unrealized)}
                      {roi != null && <span className="ml-1 text-[10px]">({roi >= 0 ? "+" : ""}{roi.toFixed(2)}%)</span>}
                    </div>
                    <div className={`text-[10px] ${rNow == null ? "text-muted-foreground" : rNow >= 0 ? UP : DOWN}`}>{rNow != null ? `${rNow >= 0 ? "+" : ""}${rNow.toFixed(2)}R` : "—"}</div>
                  </>
                ) : t.status === "pending" ? (
                  <span className="text-muted-foreground">resting</span>
                ) : (
                  "—"
                )}
              </td>
              <td className={`${TD} leading-tight`}>
                <div className={UP}>{br.targets.length ? br.targets.map((o) => num(o.stopPrice!)).join(" / ") : "—"}</div>
                <div className={stopPx == null ? `${DOWN} font-semibold` : DOWN}>
                  {stopPx != null ? num(stopPx) : "no stop"}
                  {waiting && <span className="ml-1 text-[9px] text-muted-foreground">on fill</span>}
                </div>
              </td>
              <td className={`${TD} text-right`} onClick={(e) => e.stopPropagation()}>
                <span className="inline-flex items-center gap-1">
                  {t.status === "pending" ? (
                    <Button size="sm" variant="ghost" className={CHIP} onClick={() => void act("cancel", t.id)} disabled={cancel.isPending} data-testid={`button-terminal-cancel-${t.id}`}>
                      Cancel
                    </Button>
                  ) : (
                    <>
                      {p && stop0 != null && (long ? p.markPrice > t.entryPrice : p.markPrice < t.entryPrice) && br.stop?.stopPrice !== t.entryPrice && (
                        <Button size="sm" variant="ghost" className={CHIP} disabled={move.isPending} title="Stop to breakeven"
                          onClick={() => move.mutateAsync({ tradeId: t.id, kind: "stop", price: t.entryPrice }).then(() => toast({ title: "Stop at breakeven" })).catch((err: any) => toast({ title: "Not moved", description: String(err?.message ?? err).slice(0, 200), variant: "destructive" }))}
                          data-testid={`button-terminal-be-${t.id}`}>
                          BE
                        </Button>
                      )}
                      {p && (
                        <Button size="sm" variant="ghost" className={CHIP} disabled={reduce.isPending} title="Take half off at market"
                          onClick={() => reduce.mutateAsync({ tradeId: t.id, fraction: 0.5 }).then(() => toast({ title: "Took 50%" })).catch((err: any) => toast({ title: "Not taken", description: String(err?.message ?? err).slice(0, 200), variant: "destructive" }))}
                          data-testid={`button-terminal-half-${t.id}`}>
                          50%
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className={`${CHIP} ${DOWN}`} onClick={() => void act("close", t.id)} disabled={close.isPending} data-testid={`button-terminal-close-${t.id}`}>
                        Market
                      </Button>
                    </>
                  )}
                  <button type="button" className="ml-1 text-muted-foreground transition-colors hover:text-foreground" title="Open the trade's page" onClick={() => navigate(`/trade/${t.id}`)} data-testid={`link-terminal-trade-${t.id}`}>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                </span>
              </td>
            </tr>
          );
        })}
        {unmanaged.map((p) => (
          <tr key={`${p.symbol}-${p.positionSide}`} className="text-muted-foreground" data-testid={`row-terminal-unmanaged-${p.symbol}`}>
            <td className={`${TD} border-l-2 border-l-muted-foreground/40`}>
              <div className="flex items-center gap-2">
                <span className="font-sans text-[12px] font-semibold text-foreground/80">{p.symbol}</span>
                <span className="rounded bg-secondary px-1 py-px text-[9px]">{p.positionSide} {p.leverage || ""}{p.leverage ? "x" : ""}</span>
                <span className="text-[10px]">not from this terminal</span>
              </div>
            </td>
            <td className={TD}>{num(Math.abs(p.amt))}</td>
            <td className={`${TD} leading-tight`}>
              <div>{num(p.entryPrice)}</div>
              <div>{num(p.markPrice)}</div>
            </td>
            <td className={`${TD} leading-tight`}>
              <div>—</div>
              <div className="text-amber-400/80">{p.liquidationPrice != null ? num(p.liquidationPrice) : "—"}</div>
            </td>
            <td className={`${TD} ${p.unrealized >= 0 ? UP : DOWN}`}>{fmtMoney(p.unrealized)}</td>
            <td className={TD}>—</td>
            <td className={`${TD} text-right`}>
              {(p.positionSide === "LONG" || p.positionSide === "SHORT") && (
                <Button size="sm" variant="outline" className={CHIP} disabled={adopt.isPending}
                  onClick={() =>
                    adopt
                      .mutateAsync({ account, symbol: p.symbol, positionSide: p.positionSide as "LONG" | "SHORT" })
                      .then((r) => toast({ title: "Adopted", description: `Trade #${r.trade.id} now manages ${p.symbol} ${p.positionSide}.` }))
                      .catch((err: any) => toast({ title: "Not adopted", description: String(err?.message ?? err).replace(/^\d+:\s*/, "").slice(0, 200), variant: "destructive" }))
                  }
                  data-testid={`button-terminal-adopt-${p.symbol}`}>
                  Adopt
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type VenuePositionRow = NonNullable<ReturnType<typeof useTerminalBook>["data"]>["positions"][number];

function OrdersTable({ account, mine, orders }: { account: string; mine: Mine[]; orders: VenueOrder[] }) {
  const { toast } = useToast();
  const cancel = useCancelOrder();
  const roleOf = (o: VenueOrder): { trade: number | null; role: string } => {
    for (const { t, ref } of mine) {
      if (ref.entryOrderId === o.orderId) return { trade: t.id, role: "entry" };
      if (ref.stopOrderId === o.orderId) return { trade: t.id, role: "stop loss" };
      if (ref.targetOrderIds.includes(o.orderId)) return { trade: t.id, role: o.closePosition ? "take profit" : "partial take" };
      if ((ref.addOrderIds ?? []).includes(o.orderId)) return { trade: t.id, role: "add" };
      if (o.clientOrderId.startsWith(ref.tag)) return { trade: t.id, role: o.type.replace(/_/g, " ").toLowerCase() };
    }
    return { trade: null, role: "not from this terminal" };
  };
  if (orders.length === 0) return <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">No open orders.</p>;
  return (
    <table className="w-full min-w-[560px] border-collapse" data-testid="card-terminal-orders">
      <thead>
        <tr className="border-b border-border/30">
          <th className={TH}>Symbol</th>
          <th className={TH}>Type</th>
          <th className={TH}>Side</th>
          <th className={TH}>Price</th>
          <th className={TH}>Amount</th>
          <th className={TH}>Trigger</th>
          <th className={TH}>Trade</th>
          <th className={`${TH} text-right`}>Cancel</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border/30">
        {[...orders]
          .sort((a, b) => b.time - a.time)
          .map((o) => {
            const r = roleOf(o);
            return (
              <tr key={`${o.symbol}-${o.orderId}`} className="hover:bg-secondary/20" data-testid={`row-terminal-order-${o.orderId}`}>
                <td className={`${TD} leading-tight`}>
                  <div>
                    <span className="font-sans text-[12px] font-semibold">{o.symbol}</span> <span className="text-muted-foreground">{o.positionSide}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground">{o.time ? new Date(o.time).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : ""}</div>
                </td>
                <td className={`${TD} text-muted-foreground`}>{o.type.replace(/_/g, " ").toLowerCase()}</td>
                <td className={`${TD} ${o.side === "BUY" ? UP : DOWN}`}>{o.side === "BUY" ? "Buy" : "Sell"}</td>
                <td className={TD}>{o.price != null ? num(o.price) : o.type.includes("MARKET") ? "Market" : "—"}</td>
                <td className={TD}>{o.closePosition ? "All" : num(o.origQty)}</td>
                <td className={TD}>{o.stopPrice != null ? `Mark ≤≥ ${num(o.stopPrice)}`.replace("≤≥", o.side === "SELL" ? (o.type.startsWith("TAKE") ? "≥" : "≤") : o.type.startsWith("TAKE") ? "≤" : "≥") : "—"}</td>
                <td className={`${TD} text-[10px] ${r.trade == null ? "text-amber-500/90" : "text-muted-foreground"}`}>{r.trade != null ? `#${r.trade} · ${r.role}` : r.role}</td>
                <td className={`${TD} text-right`}>
                  <button
                    type="button"
                    className="text-muted-foreground transition-colors hover:text-[#F6465D] disabled:opacity-50"
                    disabled={cancel.isPending}
                    title="Cancel this order"
                    onClick={() =>
                      cancel
                        .mutateAsync({ account, symbol: o.symbol, orderId: o.orderId })
                        .then(() => toast({ title: "Order cancelled", description: `${o.symbol} ${o.type.replace(/_/g, " ").toLowerCase()} is off the book.` }))
                        .catch((err: any) => toast({ title: "Not cancelled", description: String(err?.message ?? err).replace(/^\d+:\s*/, "").slice(0, 200), variant: "destructive" }))
                    }
                    data-testid={`button-terminal-cancel-order-${o.orderId}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            );
          })}
      </tbody>
    </table>
  );
}
