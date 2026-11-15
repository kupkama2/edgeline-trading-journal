import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "./queryClient";
import type { SigilAsset, SigilChange, SigilSnapshot } from "@shared/sigil";
import type { AstekzChange, AstekzSnapshot } from "@shared/astekz";
import type { LuloAccount, LuloRates } from "@shared/lulo";

export interface SigilState {
  latest: (SigilSnapshot & { day: string }) | null;
  previous: { day: string; valueUsd: number } | null;
  history: { date: string; valueUsd: number; positionCount: number }[];
  changes: SigilChange[];
  assets: Record<string, SigilAsset>;
  watchlist: Record<string, unknown> | null;
  entryUsd: number | null;
  enrich: { enabled: boolean; running: string[]; error: string | null };
  lists: { segments: string[]; ecos: string[]; kinds: string[] };
}

export interface SigilUploadResult {
  day: string;
  change: SigilChange;
  report: string[];
  enriching: string[];
}

export interface AstekzState {
  enabled: boolean;
  page: string;
  latest: (AstekzSnapshot & { day: string }) | null;
  history: { date: string; valueUsd: number; progressPct: number; pnlPct: number | null; cashPct: number }[];
  changes: AstekzChange[];
  failed: { at: string; error: string } | null;
  reading: boolean;
  stale: boolean;
}

const SIGIL = ["/api/sigil"];
const ASTEKZ = ["/api/astekz"];

/** Both portfolios are told about on one channel: an upload landing, an asset described, a day read. */
export const invalidateFollowed = () => {
  void queryClient.invalidateQueries({ queryKey: ["/api/networth"] });
  void queryClient.invalidateQueries({ queryKey: SIGIL });
  void queryClient.invalidateQueries({ queryKey: ASTEKZ });
};

export const useSigil = () => useQuery<SigilState>({ queryKey: SIGIL });
export const useAstekz = () => useQuery<AstekzState>({ queryKey: ASTEKZ });

export function useSigilUpload() {
  return useMutation({
    mutationFn: async (file: File) => (await apiRequest("POST", "/api/sigil/upload", { filename: file.name, text: await file.text() })).json() as Promise<SigilUploadResult>,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SIGIL }),
  });
}

/** A zip, sent as base64: the seed pack is small, and the server already takes JSON. */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}

export function useSigilSeed() {
  return useMutation({
    mutationFn: async (file: File) => (await apiRequest("POST", "/api/sigil/seed", { zip: await base64Of(file) })).json() as Promise<{ snapshots: number; changes: number; history: number; assets: number }>,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SIGIL }),
  });
}

export function useSaveSigilAsset() {
  return useMutation({
    mutationFn: async (v: { symbol: string; patch: Partial<Pick<SigilAsset, "tldr" | "segment" | "eco" | "link" | "note" | "kind">> }) => (await apiRequest("PUT", `/api/sigil/assets/${encodeURIComponent(v.symbol)}`, v.patch)).json() as Promise<SigilAsset>,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SIGIL }),
  });
}

export function useSaveSigilEntry() {
  return useMutation({
    mutationFn: async (valueUsd: number | null) => (await apiRequest("PUT", "/api/sigil/entry", { valueUsd })).json(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SIGIL }),
  });
}

export function useEnrichSigilAsset() {
  return useMutation({
    mutationFn: async (symbol: string) => (await apiRequest("POST", `/api/sigil/assets/${encodeURIComponent(symbol)}/enrich`)).json(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SIGIL }),
  });
}

export function useRefreshAstekz() {
  return useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/astekz/refresh")).json() as Promise<AstekzState>,
    onSuccess: (d) => queryClient.setQueryData(ASTEKZ, d),
  });
}

export interface LuloState {
  at: string;
  wallets: { address: string; label: string | null; account: LuloAccount | null; error: string | null }[];
  total: LuloAccount;
  rates: LuloRates;
  rate: number | null;
  history: { date: string; valueUsd: number }[];
  followed: number;
}

export interface TypedPosition {
  id: number;
  name: string;
  entryUsd: number | null;
  group: string | null;
  values: { date: string; valueUsd: number }[];
}

const LULO = ["/api/lulo"];
const TYPED = ["/api/typed-positions"];

export const useLulo = () => useQuery<LuloState>({ queryKey: LULO });
export function useRefreshLulo() {
  return useMutation({
    mutationFn: async () => (await apiRequest("GET", "/api/lulo?fresh=1")).json() as Promise<LuloState>,
    onSuccess: (d) => queryClient.setQueryData(LULO, d),
  });
}

export const useTypedPositions = () => useQuery<TypedPosition[]>({ queryKey: TYPED });
const typed = <V,>(run: (v: V) => Promise<Response>) => ({
  mutationFn: async (v: V) => (await run(v)).json() as Promise<TypedPosition[]>,
  onSuccess: (d: TypedPosition[]) => {
    queryClient.setQueryData(TYPED, d);
    void queryClient.invalidateQueries({ queryKey: ["/api/networth"] });
  },
});
export const useAddTyped = () => useMutation(typed((v: { name: string; entryUsd: number | null; group?: "sigil" | null }) => apiRequest("POST", "/api/typed-positions", v)));
export const useSaveTyped = () => useMutation(typed((v: { id: number; name: string; entryUsd: number | null }) => apiRequest("PUT", `/api/typed-positions/${v.id}`, { name: v.name, entryUsd: v.entryUsd })));
export const useRemoveTyped = () => useMutation(typed((id: number) => apiRequest("DELETE", `/api/typed-positions/${id}`)));
export const useTypedValue = () => useMutation(typed((v: { id: number; valueUsd: number }) => apiRequest("PUT", `/api/typed-positions/${v.id}/value`, { valueUsd: v.valueUsd })));
