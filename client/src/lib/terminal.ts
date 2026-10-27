/**
 * The terminal's reads and writes, as hooks. Every write goes through
 * /api/terminal, which does not exist for anyone not on its list.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "./queryClient";
import { invalidateTrades } from "./data";
import type { SymbolRules, TerminalPlan, TerminalRef } from "@shared/terminal";
import type { TradeWithTags } from "@shared/schema";

export interface TerminalAccount {
  name: string;
  env: "live" | "testnet";
  keyHint: string;
  host: string;
  hedgeMode?: boolean;
  /** False is the one to shout about: a live key that works from any IP. */
  ipLocked?: boolean | null;
  balance?: { asset: string; balance: number; available: number } | null;
  error?: string;
}

export interface TerminalStatus {
  enabled: boolean;
  maxNotional: number | null;
  accounts: TerminalAccount[];
}

export interface VenuePosition {
  symbol: string;
  positionSide: "LONG" | "SHORT" | "BOTH";
  amt: number;
  entryPrice: number;
  markPrice: number;
  unrealized: number;
  leverage: number;
  liquidationPrice: number | null;
}

export interface VenueOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT" | "BOTH";
  type: string;
  status: string;
  price: number | null;
  stopPrice: number | null;
  origQty: number;
  executedQty: number;
  closePosition: boolean;
  reduceOnly: boolean;
  time: number;
}

export interface Book {
  positions: VenuePosition[];
  orders: VenueOrder[];
  balance: { asset: string; balance: number; available: number }[];
}

export type Candle = { t: number; o: number; h: number; l: number; c: number };

export function useTerminalStatus(enabled: boolean) {
  return useQuery<TerminalStatus>({ queryKey: ["/api/terminal/status"], enabled, refetchInterval: 30_000 });
}

export function useTerminalSymbols(account: string | null) {
  return useQuery<SymbolRules[]>({
    queryKey: [`/api/terminal/symbols?account=${encodeURIComponent(account ?? "")}`],
    enabled: !!account,
    staleTime: 60 * 60 * 1000,
  });
}

export function useTerminalBook(account: string | null) {
  return useQuery<Book>({
    queryKey: [`/api/terminal/book?account=${encodeURIComponent(account ?? "")}`],
    enabled: !!account,
    refetchInterval: 5_000,
  });
}

export function useTerminalCandles(symbol: string | null, interval: string) {
  return useQuery<{ pair: string; interval: string; candles: Candle[] }>({
    queryKey: [`/api/terminal/candles?symbol=${encodeURIComponent(symbol ?? "")}&interval=${interval}`],
    enabled: !!symbol,
    refetchInterval: 15_000,
    placeholderData: (prev: unknown) => prev as any,
  });
}

export async function fetchTerminalPage(symbol: string, interval: string, before: number): Promise<{ candles: Candle[] }> {
  const res = await apiRequest("GET", `/api/terminal/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&before=${before}`);
  return res.json();
}

const refreshBook = () => queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/terminal/book") });
const refreshTerminalTrades = () => queryClient.invalidateQueries({ queryKey: ["/api/terminal/trades"] });
const afterWrite = () => {
  invalidateTrades();
  void refreshTerminalTrades();
  void refreshBook();
};

/** The terminal's own trades, paper ones included: the journal's list leaves those out. */
export function useTerminalTrades(enabled = true) {
  return useQuery<TradeWithTags[]>({ queryKey: ["/api/terminal/trades"], enabled, refetchInterval: 5_000 });
}

export function useAdoptPosition() {
  return useMutation({
    mutationFn: async (v: { account: string; symbol: string; positionSide: "LONG" | "SHORT" }) =>
      (await apiRequest("POST", "/api/terminal/adopt", v)).json() as Promise<{ trade: TradeWithTags }>,
    onSuccess: afterWrite,
  });
}

export interface SendResult {
  trade: TradeWithTags;
  placed: TerminalRef;
  refused: { which: string; reason: string }[];
  sized: { qty: string; notional: number; riskDollars: number; margin: number };
}

export function useSendPlan() {
  return useMutation({
    mutationFn: async (v: { account: string; plan: TerminalPlan }) =>
      (await apiRequest("POST", "/api/terminal/send", v)).json() as Promise<SendResult>,
    onSuccess: afterWrite,
  });
}

export function useMoveBracket() {
  return useMutation({
    mutationFn: async (v: { tradeId: number; kind: "stop" | "target"; price: number }) =>
      (await apiRequest("POST", `/api/terminal/trades/${v.tradeId}/${v.kind}`, { price: v.price })).json() as Promise<{
        trade: TradeWithTags;
        order: VenueOrder;
      }>,
    onSuccess: afterWrite,
  });
}

export function useCancelTerminalTrade() {
  return useMutation({
    mutationFn: async (tradeId: number) =>
      (await apiRequest("POST", `/api/terminal/trades/${tradeId}/cancel`, {})).json() as Promise<{ trade: TradeWithTags }>,
    onSuccess: afterWrite,
  });
}

export function useCloseTerminalTrade() {
  return useMutation({
    mutationFn: async (tradeId: number) =>
      (await apiRequest("POST", `/api/terminal/trades/${tradeId}/close`, {})).json() as Promise<{ trade: TradeWithTags }>,
    onSuccess: afterWrite,
  });
}

export function useReconcile() {
  return useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/terminal/reconcile", {})).json() as Promise<{
        checked: { id: number; status: string; error?: string }[];
      }>,
    onSuccess: () => {
      invalidateTrades();
      void refreshTerminalTrades();
    },
  });
}

export function useEnableHedgeMode() {
  return useMutation({
    mutationFn: async (account: string) =>
      (await apiRequest("POST", "/api/terminal/hedge-mode", { account })).json() as Promise<{ ok: boolean; hedgeMode: boolean }>,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/terminal/status"] }),
  });
}

export function useReduce() {
  return useMutation({
    mutationFn: async (v: { tradeId: number; qty?: number; fraction?: number }) =>
      (await apiRequest("POST", `/api/terminal/trades/${v.tradeId}/reduce`, { qty: v.qty, fraction: v.fraction })).json() as Promise<{
        trade: TradeWithTags;
        order: VenueOrder;
      }>,
    onSuccess: afterWrite,
  });
}

export function useAddSize() {
  return useMutation({
    mutationFn: async (v: { tradeId: number; qty: number; price?: number | null }) =>
      (await apiRequest("POST", `/api/terminal/trades/${v.tradeId}/add`, { qty: v.qty, price: v.price ?? null })).json() as Promise<{
        trade: TradeWithTags;
        order: VenueOrder;
      }>,
    onSuccess: afterWrite,
  });
}

export function useMoveEntry() {
  return useMutation({
    mutationFn: async (v: { tradeId: number; price: number }) =>
      (await apiRequest("POST", `/api/terminal/trades/${v.tradeId}/entry`, { price: v.price })).json() as Promise<{
        trade: TradeWithTags;
        order: VenueOrder | null;
      }>,
    onSuccess: afterWrite,
  });
}

export interface TerminalLogRow {
  id: number;
  at: string;
  account: string;
  action: string;
  tradeId: number | null;
  request: string | null;
  response: string | null;
  ok: boolean;
}

export function useTerminalLog(enabled: boolean) {
  return useQuery<TerminalLogRow[]>({ queryKey: ["/api/terminal/log"], enabled, refetchInterval: 5_000 });
}

/*
 * The tape, live: the venue's public kline stream, straight into the
 * browser. Market data needs no key and no proxy, and it is the same prices
 * whichever host the account trades on. The server's bars are the history;
 * the stream keeps the last bar moving and adds the next.
 */
const KLINE_WS = (import.meta as any).env?.VITE_BINANCE_FUTURES_WS ?? "wss://fstream.binance.com";

export function useLiveKlines(symbol: string | null, interval: string, history: Candle[]): { candles: Candle[]; live: boolean } {
  const [tail, setTail] = useState<Map<number, Candle>>(new Map());
  const [live, setLive] = useState(false);
  useEffect(() => {
    setTail(new Map());
    setLive(false);
    if (!symbol) return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let gone = false;
    const open = () => {
      if (gone) return;
      try {
        socket = new WebSocket(`${KLINE_WS}/ws/${symbol.toLowerCase()}@kline_${interval}`);
      } catch {
        return;
      }
      socket.onopen = () => setLive(true);
      socket.onmessage = (ev) => {
        try {
          const k = JSON.parse(ev.data).k;
          if (!k) return;
          const bar: Candle = { t: Number(k.t), o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c) };
          setTail((was) => {
            const next = new Map(was);
            next.set(bar.t, bar);
            // Only the last few bars live here; history is the server's.
            for (const key of Array.from(next.keys()).sort((a, b) => a - b).slice(0, -5)) next.delete(key);
            return next;
          });
        } catch {
          /* not a kline */
        }
      };
      socket.onclose = () => {
        setLive(false);
        if (!gone) retry = setTimeout(open, 5_000);
      };
      socket.onerror = () => socket?.close();
    };
    open();
    return () => {
      gone = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [symbol, interval]);

  const candles = useMemo(() => {
    if (tail.size === 0) return history;
    const byT = new Map(history.map((k) => [k.t, k]));
    const lastHistory = history.length ? history[history.length - 1].t : 0;
    for (const [t, bar] of Array.from(tail.entries())) if (t >= lastHistory) byT.set(t, bar);
    return Array.from(byT.values()).sort((a, b) => a.t - b.t);
  }, [history, tail]);
  return { candles, live };
}

export function useReviewTrade() {
  return useMutation({
    mutationFn: async (tradeId: number) =>
      (await apiRequest("POST", `/api/terminal/trades/${tradeId}/review`, {})).json() as Promise<{ trade: TradeWithTags; review: unknown }>,
    onSuccess: () => invalidateTrades(),
  });
}

/*
 * The original levels being reached, said out loud: a toast in the terminal
 * and, when allowed, a notification that reaches a tab in the background.
 * Each hit is said once; what was already said is remembered in the browser.
 */
const ALERTS_KEY = "edgeline.terminal.planAlerts";

export function notificationsAllowed(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

export function usePlanAlerts(
  mine: { t: TradeWithTags; ref: TerminalRef }[],
  say: (title: string, body: string, tone: "stop" | "target") => void,
): void {
  useEffect(() => {
    let seen: string[] = [];
    try {
      seen = JSON.parse(localStorage.getItem(ALERTS_KEY) ?? "[]");
    } catch {
      /* say it again, then */
    }
    const seenSet = new Set(seen);
    let changed = false;
    for (const { t, ref } of mine) {
      const w = ref.planWatch;
      if (!w) continue;
      const idea = ref.idea;
      for (const kind of ["stop", "target"] as const) {
        const at = kind === "stop" ? w.stopHitAt : w.targetHitAt;
        if (!at) continue;
        const key = `${t.id}:${kind}:${at}`;
        if (seenSet.has(key)) continue;
        seenSet.add(key);
        changed = true;
        // Only news from the last day is worth a sound: an old hit on a first open is history.
        if (Date.now() - new Date(at).getTime() > 24 * 60 * 60_000) continue;
        const price = kind === "stop" ? w.stopHitPrice : w.targetHitPrice;
        const planR = kind === "stop" ? -1 : idea && idea.stop != null && idea.targets[0] != null ? Math.abs(idea.targets[0] - idea.entry) / Math.abs(idea.entry - idea.stop) : null;
        say(
          `Original ${kind} hit — ${ref.symbol} #${t.id}`,
          `The tape reached ${price ?? "the level"}${planR != null ? `; set and forget would be ${planR >= 0 ? "+" : ""}${planR.toFixed(2)}R` : ""}. The position is ${t.status === "open" ? "still on" : t.status}.`,
          kind,
        );
      }
    }
    if (changed) {
      try {
        localStorage.setItem(ALERTS_KEY, JSON.stringify(Array.from(seenSet).slice(-200)));
      } catch {
        /* nothing to do */
      }
    }
  }, [mine, say]);
}
