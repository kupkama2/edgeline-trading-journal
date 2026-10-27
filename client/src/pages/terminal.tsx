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
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Crosshair, Loader2, Radio, ShieldX, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Segmented, num } from "@/components/trade-shared";
import type { SessionResponse } from "@/components/login-gate";
import type { Level, LevelField } from "@/components/chart-levels";
import { pill } from "@/components/trade-chart";
import { useTrades } from "@/lib/data";
import {
  fetchTerminalPage,
  useAddSize,
  useCancelTerminalTrade,
  useCloseTerminalTrade,
  useEnableHedgeMode,
  useLiveKlines,
  useMoveBracket,
  useMoveEntry,
  useReconcile,
  useReduce,
  useSendPlan,
  useTerminalBook,
  useTerminalCandles,
  useTerminalLog,
  useTerminalStatus,
  useTerminalSymbols,
  type Book as BookData,
  type VenueOrder,
} from "@/lib/terminal";
import { fmtAmount, fmtMoney } from "@shared/metrics";
import { parseTerminalRef, sizePlan, type SymbolRules, type TerminalPlan } from "@shared/terminal";
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

      {acct && <Desk account={acct.name} env={acct.env} hedge={acct.hedgeMode !== false} />}
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

function Desk({ account, env, hedge }: { account: string; env: "live" | "testnet"; hedge: boolean }) {
  const { toast } = useToast();
  const { data: rules = [] } = useTerminalSymbols(account);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval_] = useState<Interval>("15m");
  const rule = useMemo(() => rules.find((r) => r.symbol === symbol) ?? null, [rules, symbol]);
  const candlesQ = useTerminalCandles(rule ? symbol : null, interval);
  const { candles, live: tapeLive } = useLiveKlines(rule ? symbol : null, interval, candlesQ.data?.candles ?? []);
  const last = candles.length ? candles[candles.length - 1].c : null;
  const book = useTerminalBook(account);

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

  const { data: trades = [] } = useTrades();
  const mine = useMemo(
    () =>
      trades
        .map((t) => ({ t, ref: parseTerminalRef(t.terminal) }))
        .filter((x): x is { t: TradeWithTags; ref: NonNullable<ReturnType<typeof parseTerminalRef>> } => !!x.ref && x.ref.account === account)
        .filter((x) => x.t.status === "open" || x.t.status === "pending"),
    [trades, account],
  );
  const live = mine.find((x) => x.ref.symbol === symbol) ?? null;

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
    if (live) return null;
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
  }, [live, entry, stop, targets, side, typicalRange, rule]);
  // A new symbol is a new drawing.
  useEffect(() => {
    setStop("");
    setTargets([""]);
    setQty("");
  }, [symbol]);

  const plan: TerminalPlan | null = useMemo(() => {
    const e = numOrNull(entry);
    const s = numOrNull(stop);
    if (e == null || s == null) return null;
    return {
      symbol,
      side,
      entryType,
      entryPrice: e,
      stop: s,
      targets: targets.map(numOrNull).filter((x): x is number => x != null),
      riskDollars: sizeMode === "risk" ? numOrNull(risk) : null,
      qty: sizeMode === "qty" ? numOrNull(qty) : null,
      leverage: Number(leverage) || 0,
    };
  }, [symbol, side, entryType, entry, stop, targets, sizeMode, risk, qty, leverage]);
  const sized = plan && rule ? sizePlan(plan, rule) : null;

  /* ---------------- the chart's lines ---------------- */
  const liveBrackets = useMemo(() => bracketsOf(live?.ref.tag ?? null, book.data?.orders ?? []), [live, book.data]);
  const levels = useMemo<Level[]>(() => {
    if (live) {
      const t = live.t;
      const out: Level[] = [
        t.status === "pending"
          ? { price: t.entryPrice, label: "entry · resting", color: "entry", dashed: true, field: "entryPrice" }
          : { price: t.entryPrice, label: "entry", color: "entry", dashed: false },
      ];
      const waiting = live.ref.armOnFill;
      if (liveBrackets.stop) out.push({ price: liveBrackets.stop.stopPrice!, label: "stop", color: "stop", dashed: false, field: "initialStop" });
      else if (waiting) out.push({ price: Number(waiting.stop.stopPrice), label: "stop · on fill", color: "stop", dashed: true, field: "initialStop" });
      else if (t.initialStop != null) out.push({ price: t.initialStop, label: "stop · not resting", color: "stop", dashed: true, faint: true });
      if (liveBrackets.targets.length) for (const o of liveBrackets.targets) out.push({ price: o.stopPrice!, label: "target", color: "target", dashed: false, field: "initialTarget" });
      else if (waiting) for (const o of waiting.targets) out.push({ price: Number(o.stopPrice), label: "target · on fill", color: "target", dashed: true, field: "initialTarget" });
      return out;
    }
    const out: Level[] = [];
    const e = numOrNull(entry);
    const s = numOrNull(stop);
    if (e != null) out.push({ price: e, label: entryType === "market" ? `${side} · market` : `${side} · limit`, color: "entry", dashed: entryType === "market", field: entryType === "limit" ? "entryPrice" : undefined });
    if (s != null) out.push({ price: s, label: "stop", color: "stop", dashed: true, field: "initialStop" });
    const t1 = numOrNull(targets[0] ?? "");
    if (t1 != null) out.push({ price: t1, label: "target", color: "target", dashed: true, field: "initialTarget" });
    targets.slice(1).forEach((t) => {
      const v = numOrNull(t);
      if (v != null) out.push({ price: v, label: "target", color: "target", dashed: true, faint: true });
    });
    return out;
  }, [live, liveBrackets, entry, stop, targets, entryType]);

  const move = useMoveBracket();
  const moveEntry = useMoveEntry();
  const onLevel = (field: LevelField, price: number, done: boolean) => {
    const p = rule ? Number(price.toFixed(Math.max(0, Math.round(-Math.log10(rule.tickSize))))) : price;
    if (live) {
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
    } catch (err: any) {
      toast({ title: "Not sent", description: String(err?.message ?? err).replace(/^\d+:\s*/, "").slice(0, 300), variant: "destructive" });
    }
  }

  const problems = sized?.problems ?? (plan ? [] : ["Draw a stop to size the trade."]);
  const canSend = !!plan && !!rule && problems.length === 0 && hedge && !send.isPending && !live;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      {/* ------------------------------ chart ------------------------------ */}
      <Card className="border-card-border bg-card p-3" data-testid="card-terminal-chart">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Input
            list="terminal-symbols"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase().trim())}
            className="h-8 w-36 font-mono text-sm uppercase"
            spellCheck={false}
            data-testid="input-terminal-symbol"
          />
          <datalist id="terminal-symbols">
            {rules.slice(0, 400).map((r) => (
              <option key={r.symbol} value={r.symbol} />
            ))}
          </datalist>
          {last != null && (
            <span className="flex items-center gap-1.5 font-mono text-sm" data-testid="text-terminal-last">
              {num(last)}
              <Radio className={`h-3 w-3 ${tapeLive ? "text-emerald-400" : "text-muted-foreground/40"}`} aria-label={tapeLive ? "live" : "polling"} />
            </span>
          )}
          {!rule && rules.length > 0 && <span className="text-[11px] text-amber-500">not a perpetual on this host</span>}
          <div className="ml-auto flex items-center gap-1">
            {INTERVALS.map((f) => (
              <button key={f} type="button" onClick={() => setInterval_(f)} aria-pressed={interval === f} className={pill(interval === f)} data-testid={`terminal-tf-${f}`}>
                {f}
              </button>
            ))}
          </div>
        </div>
        {live && (
          <p className="mb-2 text-[11px] text-sky-400" data-testid="text-terminal-managing">
            Managing #{live.t.id} — drag the {live.t.status === "pending" ? "entry, " : ""}stop or target to move the resting order.
            {live.ref.unprotected && live.t.status === "open" && (
              <span className="ml-2 font-semibold text-red-400">No stop is resting on this position.</span>
            )}
          </p>
        )}
        {candlesQ.isError && (
          <p className="mb-2 text-[11px] text-amber-500" data-testid="text-terminal-candles-error">
            The price feed did not answer for {interval}: {String((candlesQ.error as any)?.message ?? candlesQ.error).replace(/^\d+:\s*/, "").slice(0, 160)}
          </p>
        )}
        {candles.length === 0 ? (
          <p className="py-16 text-center text-[11px] text-muted-foreground" data-testid="text-terminal-no-candles">
            {candlesQ.isLoading ? "Loading the tape…" : rule ? "No candles." : "Pick a perpetual."}
          </p>
        ) : (
          <Suspense fallback={<div className="h-[420px] animate-pulse rounded-md bg-secondary/30" />}>
            <Candles
              seriesKey={symbol}
              interval={interval}
              candles={candles}
              levels={levels}
              onLevel={onLevel}
              loadPage={(before) => fetchTerminalPage(symbol, interval, before)}
              height={420}
              entryActions={entryActions}
            />
          </Suspense>
        )}
      </Card>

      {/* ------------------------------ ticket + book ------------------------------ */}
      <div className="space-y-4">
        {live ? (
          <ManagePanel live={live} book={book.data} rule={rule} last={last} />
        ) : (
        <Card className="space-y-3 border-card-border bg-card p-3" data-testid="card-terminal-ticket">
          <div className="grid grid-cols-2 gap-2">
            <Segmented
              value={side}
              onChange={setSide}
              ariaLabel="Side"
              options={[
                { id: "long", label: "Long", tone: "text-emerald-400", testId: "button-terminal-long" },
                { id: "short", label: "Short", tone: "text-red-400", testId: "button-terminal-short" },
              ]}
            />
            <Segmented
              value={entryType}
              onChange={setEntryType}
              ariaLabel="Entry"
              options={[
                { id: "market", label: "Market", testId: "button-terminal-market" },
                { id: "limit", label: "Limit", testId: "button-terminal-limit" },
              ]}
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Field label={entryType === "market" ? "Entry · market" : "Entry"} value={entry} onChange={setEntry} disabled={entryType === "market"} testId="input-terminal-entry" />
            <Field label="Stop" value={stop} onChange={setStop} tone="text-red-400" testId="input-terminal-stop" />
            <Field label="Target" value={targets[0] ?? ""} onChange={(v) => setTargets((xs) => [v, ...xs.slice(1)])} tone="text-emerald-400" testId="input-terminal-target" />
          </div>
          {targets.length > 1 && (
            <div className="grid grid-cols-3 gap-2">
              {targets.slice(1).map((t, i) => (
                <Field key={i} label={`Target ${i + 2}`} value={t} onChange={(v) => setTargets((xs) => xs.map((x, j) => (j === i + 1 ? v : x)))} tone="text-emerald-400" testId={`input-terminal-target-${i + 2}`} />
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 text-[11px]">
            {targets.length < 3 && (
              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setTargets((xs) => [...xs, ""])} data-testid="button-terminal-add-target">
                + another target
              </button>
            )}
            {targets.length > 1 && (
              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setTargets((xs) => xs.slice(0, -1))}>
                − last target
              </button>
            )}
          </div>
          <div className="grid grid-cols-[auto_1fr_auto] items-end gap-2">
            <Segmented
              size="xs"
              value={sizeMode}
              onChange={setSizeMode}
              ariaLabel="Size by"
              options={[
                { id: "risk", label: "Risk $", testId: "button-terminal-size-risk" },
                { id: "qty", label: "Qty", testId: "button-terminal-size-qty" },
              ]}
            />
            {sizeMode === "risk" ? (
              <Field label="Dollars at risk" value={risk} onChange={setRisk} testId="input-terminal-risk" />
            ) : (
              <Field label={`Quantity${rule ? ` · ${rule.baseAsset}` : ""}`} value={qty} onChange={setQty} testId="input-terminal-qty" />
            )}
            <Field label="Lev ×" value={leverage} onChange={setLeverage} className="w-16" testId="input-terminal-leverage" />
          </div>

          {sized && problems.length === 0 ? (
            <p className="font-mono text-[11px] text-muted-foreground" data-testid="text-terminal-sized">
              {sized.qty} {rule?.baseAsset} · {fmtAmount(sized.notional, 0)} notional · {fmtAmount(sized.margin, 0)} margin · risk {fmtAmount(sized.riskDollars, 2)}
              {plan && plan.targets[0] != null && (
                <> · {(Math.abs(plan.targets[0] - plan.entryPrice) / Math.abs(plan.entryPrice - plan.stop)).toFixed(2)}R to target</>
              )}
            </p>
          ) : (
            <p className="text-[11px] text-amber-500" data-testid="text-terminal-problems">
              {problems[0]}
            </p>
          )}

          <Button className="h-10 w-full" disabled={!canSend} onClick={() => setConfirm(true)} data-testid="button-terminal-send">
            {send.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Send {side} {rule?.baseAsset ?? symbol}
          </Button>
        </Card>
        )}

        <Book account={account} mine={mine} book={book.data} />
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
            <Button size="sm" onClick={() => void doSend()} disabled={send.isPending || !armedToSend} data-testid="button-terminal-confirm-yes">
              {send.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Send
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
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
function ManagePanel({ live, book, rule, last }: { live: Live; book: BookData | undefined; rule: SymbolRules | null; last: number | null }) {
  const { toast } = useToast();
  const { t, ref } = live;
  const resting = t.status === "pending";
  const pos = (book?.positions ?? []).find((p) => p.symbol === ref.symbol && p.positionSide === ref.positionSide) ?? null;
  const br = bracketsOf(ref.tag, book?.orders ?? []);
  const waiting = resting ? ref.armOnFill : undefined;
  const currentStop = br.stop?.stopPrice ?? (waiting ? Number(waiting.stop.stopPrice) : null);
  const currentTarget = br.targets[0]?.stopPrice ?? (waiting?.targets[0] ? Number(waiting.targets[0].stopPrice) : null);
  const held = pos ? Math.abs(pos.amt) : t.size;
  const long = t.direction === "long";
  const entry = pos?.entryPrice || t.entryPrice;
  const stopForR = currentStop ?? t.initialStop ?? null;
  const risk = stopForR != null ? Math.abs(entry - stopForR) : null;
  const rNow = pos && risk ? ((long ? 1 : -1) * (pos.markPrice - entry)) / risk : null;

  const [stopIn, setStopIn] = useState(currentStop != null ? String(currentStop) : "");
  const [targetIn, setTargetIn] = useState(currentTarget != null ? String(currentTarget) : "");
  const [entryIn, setEntryIn] = useState(String(t.entryPrice));
  const [takeQty, setTakeQty] = useState("");
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
  const close = useCloseTerminalTrade();
  const cancel = useCancelTerminalTrade();
  const busy = move.isPending || moveEntry.isPending || reduce.isPending || add.isPending || close.isPending || cancel.isPending;
  const { data: log = [] } = useTerminalLog(true);
  const mineLog = log.filter((l) => l.tradeId === t.id).slice(0, 6);

  const run = (title: string, p: Promise<unknown>, done: string) =>
    p.then(() => toast({ title, description: done })).catch((err: any) => toast({ title: `${title} — not done`, description: String(err?.message ?? err).replace(/^\d+:\s*/, "").slice(0, 220), variant: "destructive" }));
  const digits = rule ? Math.max(0, Math.round(-Math.log10(rule.tickSize))) : 2;
  const fmt = (v: number) => v.toFixed(digits);

  return (
    <Card className="space-y-3 border-card-border bg-card p-3" data-testid="card-terminal-manage">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`text-sm font-semibold ${long ? "text-emerald-400" : "text-red-400"}`}>{long ? "LONG" : "SHORT"}</span>
        <span className="font-mono text-sm">{ref.symbol}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {num(held)} @ {num(entry)}
        </span>
        {resting ? (
          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wider">resting</span>
        ) : pos ? (
          <span className={`font-mono text-sm ${pos.unrealized >= 0 ? "text-emerald-400" : "text-red-400"}`} data-testid="text-manage-upnl">
            {fmtMoney(pos.unrealized)}
            {rNow != null && <span className="ml-1 text-xs opacity-80">{rNow >= 0 ? "+" : ""}{rNow.toFixed(2)}R</span>}
          </span>
        ) : null}
        <span className="ml-auto text-[10px] text-muted-foreground">trade #{t.id} · {ref.leverage}×</span>
      </div>

      {/* The plan as drawn, for reference: it is what the journal keeps. */}
      <p className="font-mono text-[10px] text-muted-foreground">
        plan: entry {num(t.entryPrice)} · stop {t.initialStop != null ? num(t.initialStop) : "—"} · target {t.initialTarget != null ? num(t.initialTarget) : "—"}
      </p>

      {resting && (
        <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
          <Field label="Resting entry" value={entryIn} onChange={setEntryIn} testId="input-manage-entry" />
          <Button size="sm" variant="outline" className="h-8 text-[11px]" disabled={busy || numOrNull(entryIn) == null || numOrNull(entryIn) === t.entryPrice}
            onClick={() => run("Entry moved", moveEntry.mutateAsync({ tradeId: t.id, price: numOrNull(entryIn)! }), `Resting at ${entryIn}.`)} data-testid="button-manage-move-entry">
            Move
          </Button>
          <Button size="sm" variant="ghost" className="h-8 text-[11px] text-muted-foreground" disabled={busy}
            onClick={() => run("Cancelled", cancel.mutateAsync(t.id), "The resting order is off the book.")} data-testid="button-manage-cancel">
            Cancel order
          </Button>
        </div>
      )}

      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <Field label={`Stop${currentStop == null ? (waiting ? " · on fill" : " · NONE RESTING") : br.stop ? " · resting" : " · on fill"}`} value={stopIn} onChange={setStopIn} tone={currentStop == null && !waiting ? "text-red-400 font-semibold" : "text-red-400"} testId="input-manage-stop" />
        <Button size="sm" variant="outline" className="h-8 text-[11px]" disabled={busy || numOrNull(stopIn) == null || numOrNull(stopIn) === currentStop}
          onClick={() => run("Stop set", move.mutateAsync({ tradeId: t.id, kind: "stop", price: numOrNull(stopIn)! }), `${ref.symbol} stop ${stopIn}.`)} data-testid="button-manage-set-stop">
          {currentStop == null ? "Place stop" : "Set"}
        </Button>
      </div>
      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <Field label={`Target${currentTarget == null ? " · none" : br.targets.length ? " · resting" : " · on fill"}`} value={targetIn} onChange={setTargetIn} tone="text-emerald-400" testId="input-manage-target" />
        <Button size="sm" variant="outline" className="h-8 text-[11px]" disabled={busy || numOrNull(targetIn) == null || numOrNull(targetIn) === currentTarget}
          onClick={() => run("Target set", move.mutateAsync({ tradeId: t.id, kind: "target", price: numOrNull(targetIn)! }), `${ref.symbol} target ${targetIn}.`)} data-testid="button-manage-set-target">
          {currentTarget == null ? "Place target" : "Set"}
        </Button>
      </div>

      {!resting && (
        <>
          <div className="space-y-1">
            <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">Take profit at market</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {[0.25, 0.5, 0.75].map((f) => (
                <Button key={f} size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={busy || !pos}
                  onClick={() => run(`Took ${Math.round(f * 100)}%`, reduce.mutateAsync({ tradeId: t.id, fraction: f }), `${fmt(held * f)} ${rule?.baseAsset ?? ""} off at market.`)} data-testid={`button-manage-take-${Math.round(f * 100)}`}>
                  {Math.round(f * 100)}%
                </Button>
              ))}
              <Input value={takeQty} onChange={(e) => setTakeQty(e.target.value)} placeholder={rule ? `qty · ${rule.baseAsset}` : "qty"} inputMode="decimal" className="h-7 w-28 font-mono text-[11px]" data-testid="input-manage-take-qty" />
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={busy || !pos || numOrNull(takeQty) == null}
                onClick={() => run("Took profit", reduce.mutateAsync({ tradeId: t.id, qty: numOrNull(takeQty)! }), `${takeQty} off at market.`).then(() => setTakeQty(""))} data-testid="button-manage-take-qty">
                Take
              </Button>
            </div>
          </div>
          <div className="space-y-1">
            <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">Add size</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <Input value={addQty} onChange={(e) => setAddQty(e.target.value)} placeholder={rule ? `qty · ${rule.baseAsset}` : "qty"} inputMode="decimal" className="h-7 w-28 font-mono text-[11px]" data-testid="input-manage-add-qty" />
              <Segmented size="xs" value={addType} onChange={setAddType} ariaLabel="Add at" options={[{ id: "market", label: "market", testId: "button-manage-add-market" }, { id: "limit", label: "limit", testId: "button-manage-add-limit" }]} />
              {addType === "limit" && (
                <Input value={addPrice} onChange={(e) => setAddPrice(e.target.value)} placeholder={last != null ? fmt(last) : "price"} inputMode="decimal" className="h-7 w-28 font-mono text-[11px]" data-testid="input-manage-add-price" />
              )}
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={busy || numOrNull(addQty) == null || (addType === "limit" && numOrNull(addPrice) == null)}
                onClick={() => run("Added", add.mutateAsync({ tradeId: t.id, qty: numOrNull(addQty)!, price: addType === "limit" ? numOrNull(addPrice) : null }), addType === "limit" ? `${addQty} resting at ${addPrice}.` : `${addQty} more at market.`).then(() => setAddQty(""))} data-testid="button-manage-add">
                Add
              </Button>
            </div>
            {(ref.addOrderIds?.length ?? 0) > 0 && (
              <p className="text-[10px] text-muted-foreground">
                {(book?.orders ?? []).filter((o) => ref.addOrderIds!.includes(o.orderId)).map((o) => `${num(o.origQty)} resting at ${num(o.price ?? 0)}`).join(" · ") || `${ref.addOrderIds!.length} add${ref.addOrderIds!.length === 1 ? "" : "s"} filled`}
              </p>
            )}
          </div>
          <Button variant="outline" className="h-9 w-full text-xs" disabled={busy || !pos}
            onClick={() => run("Closed at market", close.mutateAsync(t.id), "The position is flat and the brackets are off.")} data-testid="button-manage-close">
            Close at market
          </Button>
        </>
      )}

      {mineLog.length > 0 && (
        <ul className="space-y-0.5 border-t border-border/60 pt-2 font-mono text-[10px]" data-testid="list-manage-log">
          {mineLog.map((l) => (
            <li key={l.id} className={`truncate ${l.ok ? "text-muted-foreground" : "text-red-400"}`} title={l.response ?? ""}>
              {new Date(l.at).toLocaleTimeString(undefined, { hour: "2-digit", hourCycle: "h23", minute: "2-digit", second: "2-digit" })} {l.action} {l.ok ? "ok" : `failed — ${(l.response ?? "").slice(0, 80)}`}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  tone = "",
  className = "",
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  tone?: string;
  className?: string;
  testId: string;
}) {
  return (
    <label className={`block min-w-0 space-y-1 ${className}`}>
      <span className={`block text-[10px] uppercase tracking-wider text-muted-foreground ${tone}`}>{label}</span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        inputMode="decimal"
        className="h-8 font-mono text-sm"
        data-testid={testId}
      />
    </label>
  );
}

/** The resting brackets that carry a trade's tag. */
function bracketsOf(tag: string | null, orders: VenueOrder[]): { stop: VenueOrder | null; targets: VenueOrder[] } {
  if (!tag) return { stop: null, targets: [] };
  const mine = orders.filter((o) => o.clientOrderId.startsWith(tag));
  return {
    stop: mine.find((o) => o.type === "STOP_MARKET") ?? null,
    targets: mine.filter((o) => o.type === "TAKE_PROFIT_MARKET"),
  };
}

/* ------------------------------ the book ------------------------------ */

function Book({
  account,
  mine,
  book,
}: {
  account: string;
  mine: { t: TradeWithTags; ref: NonNullable<ReturnType<typeof parseTerminalRef>> }[];
  book: ReturnType<typeof useTerminalBook>["data"];
}) {
  const { toast } = useToast();
  const close = useCloseTerminalTrade();
  const cancel = useCancelTerminalTrade();
  const act = (what: "close" | "cancel", id: number) =>
    (what === "close" ? close : cancel)
      .mutateAsync(id)
      .then((r) => toast({ title: what === "close" ? "Closed at market" : "Cancelled", description: `Trade #${id} is ${r.trade.status}.` }))
      .catch((err: any) => toast({ title: "Not done", description: String(err?.message ?? err).slice(0, 200), variant: "destructive" }));

  const positions = book?.positions ?? [];
  const posFor = (symbol: string, side: "LONG" | "SHORT") => positions.find((p) => p.symbol === symbol && p.positionSide === side);
  const unmanaged = positions.filter((p) => !mine.some((m) => m.ref.symbol === p.symbol && m.ref.positionSide === p.positionSide));

  return (
    <Card className="space-y-3 border-card-border bg-card p-3" data-testid="card-terminal-book">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">On the book · {account}</p>
      {mine.length === 0 && unmanaged.length === 0 && <p className="text-[11px] text-muted-foreground">Nothing open.</p>}
      <ul className="divide-y divide-border/60">
        {mine.map(({ t, ref }) => {
          const p = posFor(ref.symbol, ref.positionSide);
          const br = bracketsOf(ref.tag, book?.orders ?? []);
          const waiting = t.status === "pending" ? ref.armOnFill : undefined;
          return (
            <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs" data-testid={`row-terminal-trade-${t.id}`}>
              <span className={`font-semibold ${t.direction === "long" ? "text-emerald-400" : "text-red-400"}`}>{t.direction === "long" ? "LONG" : "SHORT"}</span>
              <span className="font-mono">{ref.symbol}</span>
              <span className="font-mono text-muted-foreground">{num(p && t.status === "open" ? Math.abs(p.amt) : t.size)}</span>
              <span className="font-mono text-muted-foreground">@ {num(p && t.status === "open" && p.entryPrice ? p.entryPrice : t.entryPrice)}</span>
              {t.status === "pending" ? (
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wider">resting</span>
              ) : p ? (
                <span className={`font-mono ${p.unrealized >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtMoney(p.unrealized)}</span>
              ) : (
                <span className="text-[10px] text-muted-foreground">no position yet</span>
              )}
              <span className="flex items-center gap-1 font-mono text-[11px]">
                <ShieldX className="h-3 w-3 text-red-400" />
                {br.stop?.stopPrice != null ? num(br.stop.stopPrice) : waiting ? <span className="text-muted-foreground">{num(Number(waiting.stop.stopPrice))} on fill</span> : <span className="font-semibold text-red-400">none</span>}
              </span>
              <span className="flex items-center gap-1 font-mono text-[11px]">
                <Target className="h-3 w-3 text-emerald-400" />
                {br.targets.length ? br.targets.map((o) => num(o.stopPrice!)).join(" / ") : "—"}
              </span>
              <span className="ml-auto flex gap-1">
                {t.status === "pending" ? (
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => void act("cancel", t.id)} disabled={cancel.isPending} data-testid={`button-terminal-cancel-${t.id}`}>
                    Cancel
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => void act("close", t.id)} disabled={close.isPending} data-testid={`button-terminal-close-${t.id}`}>
                    Close at market
                  </Button>
                )}
              </span>
            </li>
          );
        })}
        {unmanaged.map((p) => (
          <li key={`${p.symbol}-${p.positionSide}`} className="flex flex-wrap items-center gap-x-3 py-2 text-xs text-muted-foreground" data-testid={`row-terminal-unmanaged-${p.symbol}`}>
            <span>{p.positionSide}</span>
            <span className="font-mono">{p.symbol}</span>
            <span className="font-mono">{num(Math.abs(p.amt))}</span>
            <span className="font-mono">@ {num(p.entryPrice)}</span>
            <span className={`font-mono ${p.unrealized >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtMoney(p.unrealized)}</span>
            <span className="text-[10px]">not from this terminal</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
