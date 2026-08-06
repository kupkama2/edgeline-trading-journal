import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "./queryClient";
import type {
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

export function useStyles() {
  return useQuery<TradingStyle[]>({ queryKey: ["/api/styles"] });
}

export function useMistakeTags() {
  return useQuery<MistakeTag[]>({ queryKey: ["/api/mistake-tags"] });
}

export function useWeeklyReviews() {
  return useQuery<WeeklyReview[]>({ queryKey: ["/api/weekly-reviews"] });
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
    mutationFn: async (v: { id: number; name?: string; color?: string }) =>
      (
        await apiRequest("PATCH", `/api/styles/${v.id}`, {
          name: v.name,
          color: v.color,
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
