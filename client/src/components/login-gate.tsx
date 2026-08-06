import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2, Lock } from "lucide-react";
import { Logo } from "@/components/shell";

/**
 * Blocks the whole app until the shared password is accepted. When the server
 * runs without APP_PASSWORD the session endpoint reports `authed: true`
 * unconditionally, so local development never sees this screen.
 */
export function LoginGate({ children }: { children: React.ReactNode }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const session = useQuery<{ authed: boolean }>({ queryKey: ["/api/session"] });

  const login = useMutation({
    mutationFn: async (value: string) =>
      (await apiRequest("POST", "/api/login", { password: value })).json(),
    onSuccess: () => {
      setPassword("");
      setError(null);
      // Everything was fetched while locked out — start clean.
      queryClient.clear();
    },
    onError: () => setError("Wrong password"),
  });

  if (session.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (session.data?.authed) return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm border-card-border bg-card p-6" data-testid="card-login">
        <div className="mb-5 flex items-center gap-2">
          <Logo className="h-6 w-6 text-primary" />
          <span className="text-sm font-bold tracking-tight">Edgeline</span>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password) login.mutate(password);
          }}
          className="space-y-3"
        >
          <div className="space-y-1">
            <label
              htmlFor="password"
              className="text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              Password
            </label>
            <Input
              id="password"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              className="h-9 text-sm"
              data-testid="input-password"
            />
          </div>

          {error && (
            <p className="text-[11px] font-medium text-destructive" data-testid="text-login-error">
              {error}
            </p>
          )}

          <Button
            type="submit"
            className="h-9 w-full gap-1.5 text-xs font-semibold"
            disabled={!password || login.isPending}
            data-testid="button-login"
          >
            {login.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Lock className="h-3.5 w-3.5" />
            )}
            Unlock
          </Button>
        </form>
      </Card>
    </div>
  );
}
