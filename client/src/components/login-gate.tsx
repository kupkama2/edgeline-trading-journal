import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { Logo } from "@/components/shell";
import type { SessionUser } from "@shared/schema";

export interface SessionResponse {
  user: SessionUser | null;
  provider: "google" | "local";
}

/** Google's mark, inlined — a CDN request just to draw a logo is a tracker. */
function GoogleMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  );
}

/**
 * Blocks the whole app until Google says who you are.
 *
 * There is no password field and no sign-up link, both on purpose: the account
 * list is an allowlist held by the server, so the only thing this screen can
 * do is hand you to Google and wait. A rejected address gets the same message
 * as a mistyped one — the screen must not become a way to find out which
 * addresses have journals here.
 *
 * When the server runs without Google configured it reports a local account
 * and this screen never appears, which keeps `npm run dev` friction-free.
 */
/**
 * Read once, at module load. The router normalises the hash away within a tick
 * of mounting, so a component that looks for the flag when the session query
 * resolves finds a URL that no longer mentions it.
 */
const DENIED = typeof window !== "undefined" && window.location.href.includes("auth=denied");

import { setStorageScope } from "@/lib/scoped-storage";

export function LoginGate({ children }: { children: React.ReactNode }) {
  const session = useQuery<SessionResponse>({ queryKey: ["/api/session"] });
  const denied = DENIED;

  if (session.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  /* Storage is per account, and this is the only place that knows which one
     before the app renders: nothing below here mounts until the session has
     resolved, so every key read downstream is already scoped. */
  if (session.data?.user) {
    setStorageScope(session.data.user.id);
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm border-card-border bg-card p-6" data-testid="card-login">
        <div className="mb-5 flex items-center gap-2">
          <Logo className="h-6 w-6 text-primary" />
          <span className="text-sm font-bold tracking-tight">Edgeline</span>
        </div>

        <p className="mb-4 text-[11px] leading-snug text-muted-foreground">
          Your trading record is private to your account. Sign in to open it.
        </p>

        {denied && (
          <p
            className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-[11px] leading-snug text-destructive"
            data-testid="text-login-error"
          >
            That account can&apos;t open this journal. If it should be able to, it needs adding
            to the allowlist first.
          </p>
        )}

        {/* A plain link, not fetch: the OAuth handshake is a browser redirect,
            and an XHR to it would only ever be blocked by CORS. */}
        <Button asChild className="h-10 w-full gap-2 text-xs font-semibold">
          <a href="/api/auth/google" data-testid="button-login-google">
            {/* The mark sits on white, as Google's guidelines require — and
                because its red stroke is invisible against our red button. */}
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white">
              <GoogleMark className="h-3.5 w-3.5 shrink-0" />
            </span>
            Continue with Google
          </a>
        </Button>
      </Card>
    </div>
  );
}
