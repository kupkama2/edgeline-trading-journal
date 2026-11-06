import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "./queryClient";
import type { ExitPlan, ScreenerCandle, ScreenerRow, ScreenerSettings, Timeframe } from "@shared/screener";
import type { Anomaly } from "@shared/flow";

/** What the page reads: the latest run, the settings, and whether a refresh may be asked for. */
export interface ScreenerPage {
  run: {
    id: number;
    at: string;
    barsTo: number;
    tookMs: number;
    errors: number;
    universe: number;
    fullReads: number;
    breadth: number | null;
    btc?: { d1: number | null; w1: number | null };
    flowStatus?: { source: "relay" | "none"; account: string | null; outdated: boolean; coins: number; failed: number; mismatched?: string[]; error: string | null } | null;
    liqStatus?: { accounts: number; failed: number; error: string | null } | null;
    anomalies?: Anomaly[];
    settings: ScreenerSettings;
    rows: ScreenerRow[];
  } | null;
  settings: ScreenerSettings;
  status: { running: boolean; startedAt: string | null; progress: { done: number; total: number } | null; phase?: string | null; lastError: string | null; nextAllowedAt: string | null };
  cooldownMs: number;
}

export function useScreener() {
  return useQuery<ScreenerPage>({ queryKey: ["/api/screener"] });
}

/** The status alone while a run is on: a few hundred bytes every few seconds, not the whole table. The "screener" event brings the table when the run lands. */
export function useScreenerStatus(running: boolean) {
  return useQuery<ScreenerPage["status"]>({
    queryKey: ["/api/screener/status"],
    enabled: running,
    refetchInterval: running ? 4_000 : false,
  });
}

export const invalidateScreener = () => {
  // The prefix covers the page, the status, the lines and the coins.
  void queryClient.invalidateQueries({ queryKey: ["/api/screener"] });
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
  barsTo: number;
  audit: ScreenerAudit | null;
  stopLookback: number;
  mark: number | null;
  row: ScreenerRow | null;
  price: ScreenerCandle[];
  ratio: { t: number; r: number; v: number }[];
  plan: ExitPlan;
  snapshots: { at: string; funding: number | null; openInterest: number | null; volume: number | null; mark: number | null }[];
}

/** The coin on a timeframe. The risk is not part of this: the size for it is arithmetic the drawer does itself. */
export function useScreenerCoin(coin: string | null, tf: Timeframe) {
  return useQuery<ScreenerCoin>({
    queryKey: ["/api/screener/coin", coin, tf],
    queryFn: async () => (await apiRequest("GET", `/api/screener/coin/${encodeURIComponent(coin!)}?tf=${tf}`)).json(),
    enabled: !!coin,
    staleTime: 60_000,
  });
}

/** The size that puts exactly `risk` dollars on the structure stop, and its notional. */
export function sizeFor(risk: number, mark: number | null, stop: number | null): { size: number | null; notional: number | null } {
  if (mark == null || stop == null || !(mark > stop) || !(risk > 0)) return { size: null, notional: null };
  const size = risk / (mark - stop);
  return { size, notional: size * mark };
}

export interface ScreenerLookup {
  asked: string;
  coin: string | null;
  where: "table" | "excluded" | "under-volume" | "not-read" | "not-listed";
  volume?: number | null;
  minVolume?: number;
  reason: string;
}

/** Why a coin typed into the search is or is not in the table; asked only when the search matches no row. */
export function useScreenerLookup(coin: string | null) {
  return useQuery<ScreenerLookup>({
    queryKey: ["/api/screener/lookup", coin],
    queryFn: async () => (await apiRequest("GET", `/api/screener/lookup/${encodeURIComponent(coin!)}`)).json(),
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
  cached?: boolean;
}

/** A hostname for a link's label, without throwing on a malformed one. */
export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
};

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

/* ------------------------------- the AI read ------------------------------- */

export interface AiTip {
  coin: string;
  stance: "long" | "short" | "watch" | "avoid";
  horizon: string;
  thesis: string;
  agree: string[];
  disagree: string[];
  invalidation: string;
  confidence: "low" | "medium" | "high";
}
export interface AiAnswer {
  latest: { at: string; runId: number | null; model: string | null; read: { regime: string; tips: AiTip[]; anomalies: { coin: string; note: string }[] } | null; error: string | null } | null;
  status: { running: boolean; nextAllowedAt: string | null; enabled: boolean; model: string };
}

export function useScreenerAi() {
  return useQuery<AiAnswer>({ queryKey: ["/api/screener/ai"], refetchInterval: (q) => (q.state.data?.status.running ? 10_000 : false) });
}

export function useAskScreenerAi() {
  return useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/screener/ai")).json(),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["/api/screener/ai"] }),
  });
}
