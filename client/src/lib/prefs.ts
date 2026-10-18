import { useMutation, useQuery } from "@tanstack/react-query";
import { DEFAULT_PREFS, type UserPrefs } from "@shared/schema";
import { apiRequest, queryClient } from "./queryClient";

/** The signed-in person's own settings, kept on the server so every device agrees. */
export function usePrefs(): UserPrefs {
  const { data } = useQuery<UserPrefs>({ queryKey: ["/api/prefs"] });
  return data ?? DEFAULT_PREFS;
}

export function useSetPrefs() {
  return useMutation({
    mutationFn: async (patch: Partial<Pick<UserPrefs, "reviewMode">>) =>
      (await apiRequest("PATCH", "/api/prefs", patch)).json() as Promise<UserPrefs>,
    onSuccess: (next) => queryClient.setQueryData(["/api/prefs"], next),
  });
}
