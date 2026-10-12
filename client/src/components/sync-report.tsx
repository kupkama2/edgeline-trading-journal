import { useLocation } from "wouter";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ArrowDownRight, ArrowUpRight, Link2, Plus, RefreshCw } from "lucide-react";
import type { SyncSummary } from "@/lib/data";
import { num } from "@/components/trade-shared";

/**
 * What a sync just did, trade by trade.
 *
 * A toast saying "3 new, 1 matched" is a receipt; this is the delivery. The
 * list exists mostly for the MATCHED ones — the trades the sync decided were
 * the same as something you had logged by hand, which is the one judgement
 * it makes rather than a fact it copies. Each row opens the trade, so a match
 * that looks wrong is one click from being looked at and, if need be, undone
 * by clearing its external id in the editor.
 */
type Row = SyncSummary["accounts"][number]["written"][number];

const HOW: Record<Row["how"], { label: string; hint: string; icon: typeof Plus; tone: string }> = {
  claimed: {
    label: "Matched to a trade you had logged",
    hint: "Stamped with the venue's id and filled in where blank. Your entry and levels were kept.",
    icon: Link2,
    tone: "border-sky-500/40 text-sky-400",
  },
  created: {
    label: "New from the venue",
    hint: "Written as a fact. Style, rationale and any stop the venue could not see are still yours to add.",
    icon: Plus,
    tone: "border-emerald-500/40 text-emerald-400",
  },
  updated: {
    label: "Brought up to date",
    hint: "An exit, a size, or a stop the orders now reveal — never a field you could have typed.",
    icon: RefreshCw,
    tone: "border-amber-500/40 text-amber-400",
  },
};

export function SyncReportDialog({
  venue,
  account,
  onClose,
}: {
  venue: string;
  account: SyncSummary["accounts"][number] | null;
  onClose: () => void;
}) {
  const [, navigate] = useLocation();
  if (!account) return null;
  const groups = (["claimed", "created", "updated"] as const)
    .map((how) => ({ how, rows: account.written.filter((w) => w.how === how) }))
    .filter((g) => g.rows.length > 0);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto" data-testid="dialog-sync-report">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {venue} — {account.account}
          </DialogTitle>
        </DialogHeader>
        <p className="text-[11px] text-muted-foreground" data-testid="text-sync-report-summary">
          {account.fills} fills read · {account.created} new · {account.claimed} matched · {account.updated} updated ·{" "}
          {account.unchanged} unchanged
          {account.unreconstructed
            ? ` · ${account.unreconstructed} fill${account.unreconstructed === 1 ? "" : "s"} from before the record, left alone`
            : ""}
        </p>
        {account.error && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-500" data-testid="text-sync-report-error">
            {account.error}
          </p>
        )}
        {groups.length === 0 && (
          <p className="py-4 text-center text-xs text-muted-foreground">Nothing changed — the journal already had all of it.</p>
        )}
        {groups.map(({ how, rows }) => {
          const meta = HOW[how];
          const Icon = meta.icon;
          return (
            <div key={how} className="space-y-1.5" data-testid={`sync-report-${how}`}>
              <div className="flex items-baseline gap-2">
                <Badge variant="outline" className={`text-[10px] ${meta.tone}`}>
                  <Icon className="mr-1 h-3 w-3" />
                  {meta.label} · {rows.length}
                </Badge>
              </div>
              <p className="text-[10px] leading-snug text-muted-foreground">{meta.hint}</p>
              <ul className="divide-y divide-border/50 rounded-md border border-card-border">
                {rows.map((w) => (
                  <li key={w.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        navigate(`/trade/${w.id}`);
                      }}
                      className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-secondary/40"
                      data-testid={`sync-report-trade-${w.id}`}
                    >
                      {w.direction === "long" ? (
                        <ArrowUpRight className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <ArrowDownRight className="h-3.5 w-3.5 text-primary" />
                      )}
                      <span className="min-w-[4rem] font-mono font-semibold">{w.symbol}</span>
                      <span className="font-mono text-muted-foreground">
                        {num(w.entryPrice)}
                        {w.exitPrice != null ? ` → ${num(w.exitPrice)}` : " · open"}
                      </span>
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {new Date(w.entryTime).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </DialogContent>
    </Dialog>
  );
}
