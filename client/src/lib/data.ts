import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "./queryClient";
import type {
  AccountSettings,
  UpsertAccountSettings,
  DailyNote,
  TradeImage,
  InsertTrade,
  MistakeTag,
  TradeWithTags,
  TradingStyle,
  UpdateTrade,
  WeeklyReview,
  SetupParseResult,
  OutcomeParseResult,
  OrderRowParseResult,
} from "@shared/schema";
import type { InsightsBundle, WeeklyInsights } from "@shared/weekly-insights";

export function useTrades() {
  return useQuery<TradeWithTags[]>({ queryKey: ["/api/trades"] });
}

/**
 * Ask the price feed to settle any trades still waiting on a level.
 *
 * A mutation rather than a query because it WRITES — it fills in
 * noManagementOutcome on whatever it can settle — and because it should run
 * when the journal is opened, not whenever React Query feels like refetching.
 */
export function useCheckOutcomes() {
  return useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/outcomes/check", {})).json(),
    onSuccess: (res: any) => {
      // Only disturb the cache when something actually changed.
      if (res?.resolved?.length) invalidateTrades();
    },
  });
}

/** Every spot pair Binance trades, for the symbol picker. */
export function useBinanceSymbols() {
  return useQuery<
    {
      symbol: string;
      baseAsset: string;
      quoteAsset: string;
      status: string;
      market: "futures" | "spot";
    }[]
  >({
    queryKey: ["/api/binance/symbols"],
    // The pair list changes when a coin lists; once a session is plenty.
    staleTime: Infinity,
  });
}

/** Candles around one trade, or an empty set when it is not a crypto pair. */
export function useTradeCandles(tradeId: number | null, interval?: string) {
  return useQuery<{
    pair: string | null;
    market?: "futures" | "spot";
    interval?: string;
    /** How many pairs each Binance book contributed to the catalogue in use. */
    books?: { futures: number; spot: number };
    candles: { t: number; o: number; h: number; l: number; c: number }[];
    error?: string;
    feed?: { lastError: string | null; lastTriedAt: string | null; lastOkAt: string | null } | null;
  }>({
    queryKey: [
      interval ? `/api/trades/${tradeId}/candles?interval=${interval}` : `/api/trades/${tradeId}/candles`,
    ],
    enabled: tradeId != null,
    staleTime: 5 * 60 * 1000,
    /*
     * Switching timeframe changes the key, and without this the hook would
     * report "no data" for the round trip — the chart would unmount, the
     * canvas would be thrown away and rebuilt, and the timeframe buttons would
     * disappear from under the cursor that just clicked one. Holding the
     * previous answer keeps the old candles on screen until the new ones land.
     */
    placeholderData: (prev: unknown) => prev as any,
  });
}

/**
 * One page of older candles, fetched imperatively rather than through a query.
 *
 * Scrolling left off the edge of a chart is not a piece of view state — it is
 * an event, and the answer is appended to what is already drawn rather than
 * replacing it. A query keyed by scroll position would cache a page per
 * position and re-render the world on each one.
 */
export async function fetchCandlePage(
  tradeId: number,
  interval: string,
  before: number,
): Promise<{ candles: { t: number; o: number; h: number; l: number; c: number }[] }> {
  const res = await apiRequest(
    "GET",
    `/api/trades/${tradeId}/candles?interval=${encodeURIComponent(interval)}&before=${Math.floor(before)}`,
  );
  return res.json();
}

export function useStyles() {
  return useQuery<TradingStyle[]>({ queryKey: ["/api/styles"] });
}

export function useMistakeTags() {
  return useQuery<MistakeTag[]>({ queryKey: ["/api/mistake-tags"] });
}

export function useAccountSettings() {
  return useQuery<AccountSettings[]>({ queryKey: ["/api/account-settings"] });
}

export function useSaveAccountSettings() {
  return useMutation({
    mutationFn: async (v: UpsertAccountSettings) =>
      (await apiRequest("PUT", "/api/account-settings", v)).json(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["/api/account-settings"] }),
  });
}

export function useWeeklyReviews() {
  return useQuery<WeeklyReview[]>({ queryKey: ["/api/weekly-reviews"] });
}

export function useDailyNotes() {
  return useQuery<DailyNote[]>({ queryKey: ["/api/daily-notes"] });
}

export function useSaveDailyNote() {
  return useMutation({
    mutationFn: async (v: { day: string; body: string }) =>
      (await apiRequest("PUT", `/api/daily-notes/${v.day}`, { body: v.body })).json(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["/api/daily-notes"] }),
  });
}

const invalidateTrades = () =>
  queryClient.invalidateQueries({ queryKey: ["/api/trades"] });

export function useCreateTrade() {
  return useMutation({
    mutationFn: async (v: { trade: InsertTrade; mistakeTagIds?: number[] }) =>
      (await apiRequest("POST", "/api/trades", v)).json(),
    onSuccess: invalidateTrades,
  });
}

export function useUpdateTrade() {
  return useMutation({
    mutationFn: async (v: {
      id: number;
      trade: UpdateTrade;
      mistakeTagIds?: number[];
    }) =>
      (
        await apiRequest("PATCH", `/api/trades/${v.id}`, {
          trade: v.trade,
          mistakeTagIds: v.mistakeTagIds,
        })
      ).json(),
    onSuccess: invalidateTrades,
  });
}

/** Commit confirmed paste-import candidates as pending trades. */
export function useImportTrades() {
  return useMutation({
    mutationFn: async (v: {
      styleId?: number | null;
      trades: {
        symbol: string;
        direction: "long" | "short";
        size: number;
        sizeUnit: "base" | "quote";
        entryPrice: number;
        initialStop?: number | null;
        initialTarget?: number | null;
        entryTime?: string | null;
      }[];
    }) => (await apiRequest("POST", "/api/trades/import", v)).json(),
    onSuccess: invalidateTrades,
  });
}

/** Backfill from a broker CSV. Rows carrying an exit land as closed history. */
export function useImportCsv() {
  return useMutation({
    mutationFn: async (v: {
      styleId?: number | null;
      trades: {
        symbol: string;
        direction: "long" | "short";
        size: number;
        sizeUnit?: "base" | "quote";
        entryPrice: number;
        initialStop?: number | null;
        initialTarget?: number | null;
        exitPrice?: number | null;
        entryTime: string;
        exitTime?: string | null;
        notes?: string | null;
      }[];
    }) => (await apiRequest("POST", "/api/trades/import-csv", v)).json(),
    onSuccess: invalidateTrades,
  });
}

/** Log a scaling event on a running trade. */
export function useAddFill() {
  return useMutation({
    mutationFn: async (v: {
      tradeId: number;
      kind: "add" | "partial";
      price: number;
      size: number;
      time?: string;
      note?: string | null;
    }) =>
      (
        await apiRequest("POST", `/api/trades/${v.tradeId}/fills`, {
          kind: v.kind,
          price: v.price,
          size: v.size,
          time: v.time,
          note: v.note,
        })
      ).json(),
    onSuccess: invalidateTrades,
  });
}

export function useDeleteFill() {
  return useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/fills/${id}`);
    },
    onSuccess: invalidateTrades,
  });
}

/** Fetched per trade, only when a detail view opens — never with the list. */
export function useTradeImages(tradeId: number | null) {
  return useQuery<TradeImage[]>({
    queryKey: ["/api/trades", tradeId, "images"],
    queryFn: async () =>
      (await apiRequest("GET", `/api/trades/${tradeId}/images`)).json(),
    enabled: tradeId != null,
  });
}

export function useAddTradeImage() {
  return useMutation({
    mutationFn: async (v: { tradeId: number; kind?: "setup" | "outcome" | "other"; data: string }) =>
      (
        await apiRequest("POST", `/api/trades/${v.tradeId}/images`, {
          kind: v.kind,
          data: v.data,
        })
      ).json(),
    onSuccess: (_d, v) => {
      queryClient.invalidateQueries({ queryKey: ["/api/trades", v.tradeId, "images"] });
      invalidateTrades(); // the list's imageCount changed
    },
  });
}

export function useDeleteTradeImage() {
  return useMutation({
    mutationFn: async (v: { id: number; tradeId: number }) => {
      await apiRequest("DELETE", `/api/images/${v.id}`);
    },
    onSuccess: (_d, v) => {
      queryClient.invalidateQueries({ queryKey: ["/api/trades", v.tradeId, "images"] });
      invalidateTrades();
    },
  });
}

/** What the screenshots cost, in bytes, against the free tier's 512 MB. */
export function useStorageUsage() {
  return useQuery<{ images: number; bytes: number }>({
    queryKey: ["/api/storage-usage"],
  });
}

export function useDeleteTrade() {
  return useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/trades/${id}`);
    },
    onSuccess: invalidateTrades,
  });
}

const invalidateStyles = () =>
  queryClient.invalidateQueries({ queryKey: ["/api/styles"] });

export function useCreateStyle() {
  return useMutation({
    mutationFn: async (v: { name: string; color: string; sortOrder: number }) =>
      (await apiRequest("POST", "/api/styles", v)).json(),
    onSuccess: invalidateStyles,
  });
}

export function useUpdateStyle() {
  return useMutation({
    mutationFn: async (v: {
      id: number;
      name?: string;
      color?: string;
      sessionStart?: string | null;
      sessionEnd?: string | null;
    }) =>
      (
        await apiRequest("PATCH", `/api/styles/${v.id}`, {
          name: v.name,
          color: v.color,
          sessionStart: v.sessionStart,
          sessionEnd: v.sessionEnd,
        })
      ).json(),
    onSuccess: invalidateStyles,
  });
}

export function useDeleteStyle() {
  return useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/styles/${id}`);
    },
    onSuccess: () => {
      invalidateStyles();
      // Trades of a deleted style become unassigned.
      invalidateTrades();
    },
  });
}

const invalidateTags = () =>
  queryClient.invalidateQueries({ queryKey: ["/api/mistake-tags"] });

export function useCreateTag() {
  return useMutation({
    mutationFn: async (v: { name: string; sortOrder: number }) =>
      (await apiRequest("POST", "/api/mistake-tags", v)).json(),
    onSuccess: invalidateTags,
  });
}

export function useUpdateTag() {
  return useMutation({
    mutationFn: async (v: { id: number; name: string }) =>
      (await apiRequest("PATCH", `/api/mistake-tags/${v.id}`, { name: v.name })).json(),
    onSuccess: invalidateTags,
  });
}

export function useDeleteTag() {
  return useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/mistake-tags/${id}`);
    },
    onSuccess: () => {
      invalidateTags();
      invalidateTrades();
    },
  });
}

export function useSubmitWeeklyReview() {
  return useMutation({
    mutationFn: async (v: { weekStart: string; plans: string; submittedAt: string }) =>
      (await apiRequest("POST", "/api/weekly-reviews", v)).json(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["/api/weekly-reviews"] }),
  });
}

export async function parseScreenshot(
  image: string,
  kind: "orders",
  context?: Record<string, unknown>,
): Promise<{ orders: OrderRowParseResult[]; skipped: number }>;
export async function parseScreenshot(
  image: string,
  kind: "setup",
  context?: Record<string, unknown>,
): Promise<SetupParseResult>;
export async function parseScreenshot(
  image: string,
  kind: "outcome",
  context?: Record<string, unknown>,
): Promise<OutcomeParseResult>;
export async function parseScreenshot(
  image: string,
  kind: "setup" | "outcome" | "orders",
  context?: Record<string, unknown>,
): Promise<any> {
  const res = await apiRequest("POST", "/api/parse-screenshot", {
    image,
    kind,
    context,
  });
  const json = await res.json();
  return json.result;
}

/** Generate (or fetch the cached) AI reading of this week's notes vs its numbers. */
export function useWeeklyInsights() {
  return useMutation({
    mutationFn: async (v: { weekStart?: string; force?: boolean } = {}) =>
      (await apiRequest("POST", "/api/weekly-insights", v)).json() as Promise<{
        ok: boolean;
        cached?: boolean;
        weekStart: string;
        bundle?: InsightsBundle;
        insights?: WeeklyInsights;
        message?: string;
      }>,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["/api/weekly-reviews"] }),
  });
}

export async function analyzeRationale(text: string): Promise<string[]> {
  try {
    const res = await apiRequest("POST", "/api/analyze-rationale", { text });
    const json = await res.json();
    return Array.isArray(json.tags) ? json.tags : [];
  } catch {
    return [];
  }
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Longest edge, in pixels, that a screenshot is scaled down to before upload.
 *
 * Vision models bill by pixel count — Perplexity charges width×height/750 — so
 * a 2560×1440 screenshot costs four times what the same chart costs at 1280×720
 * while carrying no extra information: the numbers being read are axis labels,
 * which stay legible well below native resolution. 1280 is the size of the QA
 * chart the parser is tested against.
 */
const MAX_UPLOAD_EDGE = 1280;

/**
 * Scale an image down to MAX_UPLOAD_EDGE on its longest side. Images already at
 * or under it are returned untouched rather than re-encoded, which would cost
 * quality for nothing. Any failure falls back to the original — a larger upload
 * is a worse bill, but a failed parse is a worse product.
 */
/**
 * Re-encode an image for ARCHIVAL — the copy that lands in the database.
 *
 * Two qualities exist for two jobs. The parse copy (below) is PNG at full
 * detail because a model reads axis digits off it, and it is thrown away
 * after one request. This one is kept forever on a 512 MB Neon free tier, so
 * it optimises for "readable on review": ≤1100 px wide, WebP at 0.72 (JPEG
 * where the browser can't encode WebP). A dark chart lands around 40–90 KB —
 * five-to-ten thousand screenshots before storage is a conversation, instead
 * of a few hundred.
 */
export async function archiveDataUrl(dataUrl: string): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = dataUrl;
  });

  const MAX = 1100;
  const scale = Math.min(1, MAX / Math.max(img.width, img.height, 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const webp = canvas.toDataURL("image/webp", 0.72);
  // Browsers that can't encode WebP hand back PNG — fall through to JPEG.
  const out = webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.72);
  // Never archive something LARGER than what came in.
  return out.length < dataUrl.length ? out : dataUrl;
}

export async function fileToDownscaledDataUrl(file: File): Promise<string> {
  const original = await fileToDataUrl(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = original;
    });

    const longest = Math.max(img.width, img.height);
    if (!longest || longest <= MAX_UPLOAD_EDGE) return original;

    const scale = MAX_UPLOAD_EDGE / longest;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return original;
    // Chart text is thin; smoothing preserves it far better than nearest.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // PNG rather than JPEG: chart screenshots are flat colour with sharp text,
    // where JPEG ringing lands directly on the digits being read.
    return canvas.toDataURL("image/png");
  } catch {
    return original;
  }
}
