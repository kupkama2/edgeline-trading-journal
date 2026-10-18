import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

/** A path on the API, on whichever origin it is served from. */
export const apiUrl = (path: string) => `${API_BASE}${path}`;

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    // A session that expired mid-visit: the sign-in gate is told, rather than
    // every request failing with "401" while the page carries on as if fine.
    if (res.status === 401 && !res.url.endsWith("/api/session")) {
      void queryClient.invalidateQueries({ queryKey: ["/api/session"] });
    }
    const raw = (await res.text()) || res.statusText;
    // A proxy's error page is HTML; its whole body in a toast says nothing.
    const text = /^\s*</.test(raw) ? res.statusText || "the server did not answer" : raw.slice(0, 300);
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    // Carries the session cookie when API_BASE points at a different origin.
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
