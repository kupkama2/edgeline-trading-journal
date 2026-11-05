import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "./queryClient";
import type { ExitPlan, ScreenerCandle, ScreenerRow, ScreenerSettings, Timeframe } from "@shared/screener";

/** What the page reads: the latest run, the settings, and whether a refresh may be asked for. */
export interface ScreenerPage {
  run: { id: number; at: string; tookMs: number; errors: number; universe: number; settings: ScreenerSettings; rows: ScreenerRow[] } | null;
  settings: ScreenerSettings;
  status: { running: boolean; startedAt: string | null; progress: { done: number; total: number } | null; lastError: string | null; nextAllowedAt: string | null };
  cooldownMs: number;
}

export function useScreener() {
  return useQuery<ScreenerPage>({
    queryKey: ["/api/screener"],
    // While a run is on, the progress line moves; otherwise the "screener" event refreshes it.
    refetchInterval: (q) => (q.state.data?.status.running ? 5_000 : false),
  });
}

export const invalidateScreener = () => {
  void queryClient.invalidateQueries({ queryKey: ["/api/screener"] });
  void queryClient.invalidateQueries({ queryKey: ["/api/screener/series"] });
  void queryClient.invalidateQueries({ queryKey: ["/api/screener/coin"] });
};

export function useScreenerRefresh() {
  return useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/screener/run");
      return res.json();
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["/api/screener"] }),
  });
}

export function useSaveScreenerSettings() {
  return useMutation({
    mutationFn: async (patch: Partial<ScreenerSettings>) => (await apiRequest("PUT", "/api/screener/settings", patch)).json() as Promise<ScreenerSettings>,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["/api/screener"] }),
  });
}

export interface ScreenerLines {
  tf: Timeframe;
  now: number;
  lines: Record<string, { t: number; pct: number }[]>;
}

export function useScreenerLines(tf: Timeframe, coins: string[]) {
  const key = coins.slice().sort().join(",");
  return useQuery<ScreenerLines>({
    queryKey: ["/api/screener/series", tf, key],
    queryFn: async () => (await apiRequest("GET", `/api/screener/series?tf=${tf}&coins=${encodeURIComponent(key)}`)).json(),
    enabled: coins.length > 0,
    staleTime: 60_000,
  });
}

export interface ScreenerAudit {
  tf: Timeframe;
  lookbackBars: number;
  base: "1h" | "1d";
  now: { t: number; alt: number; btc: number; ratio: number };
  then: { t: number; alt: number; btc: number; ratio: number };
  rs: number;
}

export interface ScreenerCoin {
  coin: string;
  tf: Timeframe;
  audit: ScreenerAudit | null;
  stopLookback: number;
  row: ScreenerRow | null;
  price: ScreenerCandle[];
  ratio: { t: number; r: number; v: number }[];
  plan: ExitPlan;
  snapshots: { at: string; funding: number | null; openInterest: number | null; volume: number | null; mark: number | null }[];
}

export function useScreenerCoin(coin: string | null, tf: Timeframe, risk: number) {
  return useQuery<ScreenerCoin>({
    queryKey: ["/api/screener/coin", coin, tf, risk],
    queryFn: async () => (await apiRequest("GET", `/api/screener/coin/${encodeURIComponent(coin!)}?tf=${tf}&risk=${risk}`)).json(),
    enabled: !!coin,
    staleTime: 60_000,
  });
}

export interface ScreenerNews {
  coin: string;
  links: { label: string; url: string }[];
  summary: string[] | null;
  sources: { url: string; title: string | null }[];
  reason: string | null;
}

export function useScreenerNews() {
  return useMutation({
    mutationFn: async (coin: string) => (await apiRequest("POST", `/api/screener/news/${encodeURIComponent(coin)}`)).json() as Promise<ScreenerNews>,
  });
}

/* ------------------------------- formatting ------------------------------- */

export const fmtPct = (x: number | null | undefined, digits = 1) => (x == null || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`);
export const fmtX = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : `${x.toFixed(x >= 10 ? 0 : 1)}×`);
export const fmtUsd = (x: number | null | undefined) => {
  if (x == null || !Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(x / 1e3).toFixed(0)}K`;
  return `$${x.toFixed(0)}`;
};
export const fmtPx = (x: number | null | undefined) => {
  if (x == null || !Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  const d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 7;
  return x.toFixed(d);
};
export const fmtPrague = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/Prague", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const ACCEL_ARROW = { up: "↑", steady: "→", down: "↓" } as const;

/** A heat colour for an RS change: green for up, red for down, stronger with size (±10% saturates). */
export function heat(rs: number | null): string | undefined {
  if (rs == null) return undefined;
  const a = Math.min(1, Math.abs(rs) / 0.1);
  const alpha = 0.08 + 0.42 * a;
  return rs >= 0 ? `rgba(16, 185, 129, ${alpha.toFixed(3)})` : `rgba(239, 68, 68, ${alpha.toFixed(3)})`;
}
