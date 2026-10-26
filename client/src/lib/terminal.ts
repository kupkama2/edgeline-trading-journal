/**
 * The terminal's reads and writes, as hooks. Every write goes through
 * /api/terminal, which does not exist for anyone not on its list.
 */
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
const afterWrite = () => {
  invalidateTrades();
  void refreshBook();
};

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
    onSuccess: () => invalidateTrades(),
  });
}

export function useEnableHedgeMode() {
  return useMutation({
    mutationFn: async (account: string) =>
      (await apiRequest("POST", "/api/terminal/hedge-mode", { account })).json() as Promise<{ ok: boolean; hedgeMode: boolean }>,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/terminal/status"] }),
  });
}
