/**
 * Who can sign in — the allowlist, editable from inside the app.
 *
 * It used to live only in ALLOWED_EMAILS on Render, which meant adding a
 * friend was a dashboard visit and a restart. The env var still works and is
 * still authoritative for the owner, because a journal whose owner can lock
 * themselves out of their own history is one bad click from unrecoverable.
 * Everything added here goes to the database instead.
 *
 * Owner only. The endpoints answer 404 rather than 403 to anyone else, so
 * they don't confirm they exist to someone who may not use them.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Lock, Mail, UserPlus, X } from "lucide-react";
import type { SessionResponse } from "@/components/login-gate";

interface Member {
  id: number;
  email: string;
  name: string | null;
  picture: string | null;
  isOwner: boolean;
  lastLoginAt: string | null;
}

interface MembersResponse {
  members: Member[];
  pending: string[];
  fromEnv: string[];
}

export function MembersCard() {
  const session = useQuery<SessionResponse>({ queryKey: ["/api/session"] });
  const isOwner = session.data?.user?.isOwner === true;
  const { toast } = useToast();
  const [email, setEmail] = useState("");

  const members = useQuery<MembersResponse>({
    queryKey: ["/api/members"],
    enabled: isOwner,
  });

  const invite = useMutation({
    mutationFn: async (e: string) => (await apiRequest("POST", "/api/members", { email: e })).json(),
    onSuccess: (r: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/members"] });
      setEmail("");
      toast({
        title: "Invited",
        description: `${r.email} can sign in with Google now.`,
      });
    },
    onError: (err: any) =>
      toast({
        title: "Couldn't invite",
        description: String(err?.message ?? err).slice(0, 160),
        variant: "destructive",
      }),
  });

  const revoke = useMutation({
    mutationFn: async (e: string) =>
      (await apiRequest("DELETE", `/api/members/${encodeURIComponent(e)}`, {})).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/members"] });
      toast({ title: "Access removed", description: "Their journal is untouched." });
    },
  });

  // Not the owner: this panel is not theirs to see, and saying so would still
  // tell them it exists.
  if (!isOwner) return null;

  const data = members.data;
  const envOnly = (e: string) =>
    (data?.fromEnv ?? []).some((x) => x.toLowerCase() === e.toLowerCase());

  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-members">
      <div className="flex items-center gap-2">
        <Lock className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold tracking-tight">Who can sign in</h2>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Invite by Google address. Everyone gets their own journal — nobody can see anyone
        else's trades, including you.
      </p>

      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) invite.mutate(email.trim());
        }}
      >
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="friend@gmail.com"
          className="h-9 w-64 text-sm"
          data-testid="input-invite-email"
        />
        <Button
          type="submit"
          size="sm"
          className="h-9 text-xs"
          disabled={invite.isPending || !email.trim()}
          data-testid="button-invite"
        >
          {invite.isPending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <UserPlus className="mr-1.5 h-3.5 w-3.5" />
          )}
          Invite
        </Button>
      </form>

      {members.isLoading ? (
        <p className="mt-4 text-xs text-muted-foreground">Loading…</p>
      ) : (
        <div className="mt-4 space-y-1.5">
          {data?.members.map((m) => (
            <Row
              key={m.email}
              email={m.email}
              label={m.name ?? undefined}
              badge={m.isOwner ? "owner" : m.lastLoginAt ? "signed in" : "invited"}
              locked={m.isOwner || envOnly(m.email)}
              onRemove={() => revoke.mutate(m.email)}
              testId={`member-${m.email}`}
            />
          ))}
          {data?.pending.map((e) => (
            <Row
              key={e}
              email={e}
              badge="not signed in yet"
              locked={envOnly(e)}
              onRemove={() => revoke.mutate(e)}
              testId={`member-${e}`}
            />
          ))}
        </div>
      )}

      <p className="mt-3 text-[10px] leading-snug text-muted-foreground">
        Removing someone stops them signing in — immediately, not at their next visit — and
        leaves everything they logged exactly where it is. Entries that come from the
        ALLOWED_EMAILS environment variable are shown but can only be changed in Render.
      </p>
    </Card>
  );
}

function Row({
  email,
  label,
  badge,
  locked,
  onRemove,
  testId,
}: {
  email: string;
  label?: string;
  badge: string;
  locked: boolean;
  onRemove: () => void;
  testId: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5"
      data-testid={testId}
    >
      <Mail className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-xs">{label ? `${label} · ${email}` : email}</span>
      <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
        {badge}
      </span>
      {!locked && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-auto text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${email}`}
          data-testid={`button-remove-${email}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
