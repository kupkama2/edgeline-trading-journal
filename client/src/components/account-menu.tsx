/**
 * Who you are signed in as, and the way out.
 *
 * Small on purpose — it sits in the header next to the theme picker and is not
 * something anyone needs twice a day. Signing out clears the query cache
 * before the reload: the next person at this browser must not see a flash of
 * the previous account's trades while the session check is in flight.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, LogOut, User as UserIcon } from "lucide-react";
import { useLayout } from "@/lib/layout";
import type { SessionResponse } from "@/components/login-gate";

export function AccountMenu() {
  const session = useQuery<SessionResponse>({ queryKey: ["/api/session"] });
  const user = session.data?.user;
  const { version, setVersion } = useLayout();

  const logout = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/logout", {})).json(),
    onSuccess: () => {
      queryClient.clear();
      window.location.href = "/";
    },
  });

  if (!user) return null;

  const initial = (user.name || user.email).trim().charAt(0).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-full p-0"
          aria-label="Account"
          data-testid="button-account"
        >
          {user.picture ? (
            <img
              src={user.picture}
              alt=""
              referrerPolicy="no-referrer"
              className="h-7 w-7 rounded-full object-cover"
            />
          ) : (
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold">
              {initial || <UserIcon className="h-3.5 w-3.5" />}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <p className="truncate text-xs font-medium" data-testid="text-account-name">
            {user.name || "Signed in"}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">{user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* On a phone the header has no room for the layout switch; it lives here instead. */}
        {(["v1", "v2"] as const).map((id) => (
          <DropdownMenuItem key={id} className="sm:hidden" onClick={() => setVersion(id)} data-testid={`menu-layout-${id}`}>
            <span className="text-xs">{id === "v1" ? "Layout V1: every figure" : "Layout V2: quiet"}</span>
            {version === id && <Check className="ml-auto h-3 w-3" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator className="sm:hidden" />
        <DropdownMenuItem
          onClick={() => logout.mutate()}
          disabled={logout.isPending || session.data?.provider === "local"}
          data-testid="button-logout"
        >
          <LogOut className="mr-2 h-3.5 w-3.5" />
          <span className="text-xs">
            {session.data?.provider === "local" ? "Local account" : "Sign out"}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
