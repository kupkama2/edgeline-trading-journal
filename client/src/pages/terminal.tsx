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
import { AlertTriangle, Crosshair, Loader2, ShieldX, Target } from "lucide-react";
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
  useCancelTerminalTrade,
  useCloseTerminalTrade,
  useEnableHedgeMode,
  useMoveBracket,
  useReconcile,
  useSendPlan,
  useTerminalBook,
  useTerminalCandles,
  useTerminalStatus,
  useTerminalSymbols,
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
  const candles = candlesQ.data?.candles ?? [];
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
  useEffect(() => {
    if (entryType === "market" && last != null) setEntry(String(last));
  }, [entryType, last]);
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
      const out: Level[] = [{ price: t.entryPrice, label: t.status === "pending" ? "entry · resting" : "entry", color: "entry", dashed: t.status === "pending" }];
      if (liveBrackets.stop) out.push({ price: liveBrackets.stop.stopPrice!, label: "stop", color: "stop", dashed: false, field: "initialStop" });
      else if (t.initialStop != null) out.push({ price: t.initialStop, label: "stop · not resting", color: "stop", dashed: true, faint: true });
      for (const o of liveBrackets.targets) out.push({ price: o.stopPrice!, label: "target", color: "target", dashed: false, field: "initialTarget" });
      return out;
    }
    const out: Level[] = [];
    const e = numOrNull(entry);
    const s = numOrNull(stop);
    if (e != null) out.push({ price: e, label: entryType === "market" ? "entry · market" : "entry", color: "entry", dashed: entryType === "market", field: entryType === "limit" ? "entryPrice" : undefined });
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
  const onLevel = (field: LevelField, price: number, done: boolean) => {
    const p = rule ? Number(price.toFixed(Math.max(0, Math.round(-Math.log10(rule.tickSize))))) : price;
    if (live) {
      if (!done) return;
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
            <span className="font-mono text-sm" data-testid="text-terminal-last">
              {num(last)}
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
            Managing trade #{live.t.id} — drag the stop or target to move the resting order.
            {live.ref.unprotected && <span className="ml-2 font-semibold text-red-400">No stop is resting on this position.</span>}
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
            />
          </Suspense>
        )}
      </Card>

      {/* ------------------------------ ticket + book ------------------------------ */}
      <div className="space-y-4">
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
            {live ? `Already in ${symbol} — close it first` : `Send ${side} ${rule?.baseAsset ?? symbol}`}
          </Button>
        </Card>

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
          return (
            <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs" data-testid={`row-terminal-trade-${t.id}`}>
              <span className={`font-semibold ${t.direction === "long" ? "text-emerald-400" : "text-red-400"}`}>{t.direction === "long" ? "LONG" : "SHORT"}</span>
              <span className="font-mono">{ref.symbol}</span>
              <span className="font-mono text-muted-foreground">{num(t.size)}</span>
              <span className="font-mono text-muted-foreground">@ {num(t.entryPrice)}</span>
              {t.status === "pending" ? (
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wider">resting</span>
              ) : p ? (
                <span className={`font-mono ${p.unrealized >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtMoney(p.unrealized)}</span>
              ) : (
                <span className="text-[10px] text-muted-foreground">no position yet</span>
              )}
              <span className="flex items-center gap-1 font-mono text-[11px]">
                <ShieldX className="h-3 w-3 text-red-400" />
                {br.stop?.stopPrice != null ? num(br.stop.stopPrice) : <span className="font-semibold text-red-400">none</span>}
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
