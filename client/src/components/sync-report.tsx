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
          <p className="py-4 text-center text-xs text-muted-foreground">
            {account.fills > 0
              ? "Nothing changed — the journal already had all of it."
              : `${venue} sent no fills for ${account.source ?? "this account"}.`}
          </p>
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
        <MarketsSeen venue={venue} account={account} />
      </DialogContent>
    </Dialog>
  );
}

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * What the venue's answer contained, market by market.
 *
 * The question this answers is the one a sync report otherwise cannot: "I
 * traded WTIOIL on Thursday — where is it?" Either the market is not in this
 * list, and the venue did not send it for the address that was asked, or it
 * is here with fills that were set aside, and the reason is in the row. A
 * count of fills read, however large, says neither.
 */
function MarketsSeen({ venue, account }: { venue: string; account: SyncSummary["accounts"][number] }) {
  const markets = account.markets ?? [];
  if (markets.length === 0) return null;
  const first = Math.min(...markets.map((m) => m.first).filter((t) => t > 0));
  const last = Math.max(...markets.map((m) => m.last));
  return (
    <div className="space-y-1.5" data-testid="sync-report-markets">
      <div className="flex items-baseline gap-2">
        <Badge variant="outline" className="text-[10px] text-muted-foreground">
          What {venue} sent{account.source ? ` for ${account.source}` : ""} · {markets.length} market{markets.length === 1 ? "" : "s"}
        </Badge>
        {Number.isFinite(first) && (
          <span className="text-[10px] text-muted-foreground">
            {when(first)} → {when(last)}
          </span>
        )}
      </div>
      <ul className="divide-y divide-border/50 rounded-md border border-card-border">
        {markets.map((m) => (
          <li
            key={m.coin}
            className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 text-xs"
            data-testid={`sync-report-market-${m.coin}`}
          >
            <span className="min-w-[6rem] font-mono font-semibold">{m.coin}</span>
            <span className="font-mono text-muted-foreground">
              {m.fills} fill{m.fills === 1 ? "" : "s"} · {m.trades} trade{m.trades === 1 ? "" : "s"}
            </span>
            {m.unreconstructed > 0 && (
              <span className="text-[10px] text-amber-500" title="The position these fills belong to was open before the venue's record begins, so its entry is not in it and nothing honest can be written.">
                {m.unreconstructed} set aside: opened before the record
              </span>
            )}
            <span className="ml-auto text-[10px] text-muted-foreground">
              {m.first === m.last || m.fills === 1 ? when(m.last) : `${when(m.first)} → ${when(m.last)}`}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[10px] leading-snug text-muted-foreground">
        A market you traded that is not in this list was not in {venue}'s answer for this account.{" "}
        {venue === "Hyperliquid"
          ? "The address has to be the account itself — an API wallet or a sub-account has a history of its own — and the venue hands over its most recent two thousand fills, no older."
          : "The key reads the futures account it was made for, and only markets with a realised P&L in the last ninety days, or a position open now, are asked about."}
      </p>
    </div>
  );
}
