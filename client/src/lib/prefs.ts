import { useMutation, useQuery } from "@tanstack/react-query";
import { DEFAULT_PREFS, type UpdateUserPrefs, type UserPrefs } from "@shared/schema";
import type { GuardRails } from "@shared/guardrails";
import { apiRequest, queryClient } from "./queryClient";

/** The signed-in person's own settings, kept on the server so every device agrees. */
export function usePrefs(): UserPrefs {
  const { data } = useQuery<UserPrefs>({ queryKey: ["/api/prefs"] });
  return data ?? DEFAULT_PREFS;
}

/** Their loss and tilt limits: the daily guard, the meter and the entry form all read these. */
export function useGuardRails(): GuardRails {
  return usePrefs().guard;
}

export function useSetPrefs() {
  return useMutation({
    mutationFn: async (patch: UpdateUserPrefs) =>
      (await apiRequest("PATCH", "/api/prefs", patch)).json() as Promise<UserPrefs>,
    onSuccess: (next) => queryClient.setQueryData(["/api/prefs"], next),
  });
}
