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
} from "@shared/schema";

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
  kind: "setup" | "outcome",
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
