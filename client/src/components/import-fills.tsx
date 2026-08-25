import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ArrowDownRight, ArrowUpRight, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAddFill, useCreateTrade } from "@/lib/data";
import { num } from "@/components/trade-shared";
import {
  avgEntry,
  avgExit,
  tradesFromFills,
  type LoggedFill,
  type ReconstructedTrade,
} from "@shared/order-log";

/**
 * A filled-order log, shown as the trades it turned out to be.
 *
 * The log is a list of executions; the trades are implicit in them. Nine
 * filled orders on two symbols can be nine trades, or two, or three — the
 * running position decides, and until it has been walked nobody can tell by
 * looking. So this shows the walk's answer BEFORE anything is written: the
 * legs of each trade, in order, with the entry and the exits named.
 *
 * Reviewed rather than imported silently, because the reconstruction is an
 * inference. It is a sound one, but a wrong trade boundary produces two
 * plausible trades out of one real one and there is nothing in the saved
 * record afterwards that would ever look wrong.
 */
export function FillLogReview({
  fills,
  onDone,
}: {
  fills: LoggedFill[];
  onDone: () => void;
}) {
  const { trades, problems } = useMemo(() => tradesFromFills(fills), [fills]);
  const [skip, setSkip] = useState<Record<number, boolean>>({});
  /*
   * The plan, which the log cannot know.
   *
   * A fill log records what happened, never what was intended: the stop is
   * only in it when one actually fired, and the target is never in it at all.
   * The journal requires both on any trade that opened, and rightly — without
   * a stop there is no 1R and every R this trade contributes is undefined, and
   * without a target there is nothing to compare the exit against.
   *
   * So they are asked for here rather than defaulted. A default would be a
   * made-up number sitting under every figure the trade ever produces, and
   * unlike a missing one it would never look wrong.
   */
  const [plan, setPlan] = useState<Record<number, { stop: string; target: string }>>({});
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const createTrade = useCreateTrade();
  const addFill = useAddFill();

  const levels = (i: number, t: ReconstructedTrade) => ({
    stop: plan[i]?.stop ?? (t.initialStop != null ? String(t.initialStop) : ""),
    target: plan[i]?.target ?? "",
  });
  const numOrNull = (v: string) => (v.trim() === "" || !isFinite(Number(v)) ? null : Number(v));
  const ready = (i: number, t: ReconstructedTrade) => {
    const l = levels(i, t);
    return numOrNull(l.stop) != null && numOrNull(l.target) != null;
  };

  const chosen = trades
    .map((t, i) => ({ t, i }))
    .filter(({ t, i }) => !skip[i] && ready(i, t));
  const waiting = trades.filter((t, i) => !skip[i] && !ready(i, t)).length;

  async function save() {
    setSaving(true);
    let made = 0;
    try {
      for (const { t, i } of chosen) {
        const l = levels(i, t);
        const created = await createTrade.mutateAsync({
          trade: {
            symbol: t.symbol,
            direction: t.direction,
            size: t.size,
            sizeUnit: "base",
            entryPrice: t.entryPrice,
            entryTime: t.entryTime,
            // Only where a fired stop proved it. Everything else about a trade
            // can be corrected later from memory; a stop that was never the
            // plan sets 1R wrong and quietly rescales the whole book.
            initialStop: numOrNull(l.stop),
            initialTarget: numOrNull(l.target),
            exitPrice: t.stillOpen ? null : t.exitPrice,
            exitTime: t.stillOpen ? null : t.exitTime,
            status: t.stillOpen ? "open" : "closed",
            exitReason: t.stillOpen ? null : t.exitReason,
            source: "broker-log",
          } as any,
          mistakeTagIds: [],
        });

        // The legs, in the order they happened. Adds move the average entry,
        // partials bank against it — the ledger does the rest.
        for (const leg of [
          ...t.adds.map((l) => ({ ...l, kind: "add" as const })),
          ...t.partials.map((l) => ({ ...l, kind: "partial" as const })),
        ].sort((a, b) => (a.time < b.time ? -1 : 1))) {
          await addFill.mutateAsync({
            tradeId: created.id,
            kind: leg.kind,
            price: leg.price,
            size: leg.size,
            time: new Date(leg.time).toISOString(),
            note: "from a broker order log",
          });
        }
        made++;
      }
      toast({
        title: `Logged ${made} ${made === 1 ? "trade" : "trades"}`,
        description: "Rationale, targets and anything the log could not know are still yours to add.",
      });
      onDone();
    } catch (err: any) {
      toast({
        title: made ? `Stopped after ${made}` : "Couldn't log those trades",
        description: String(err?.message ?? err).slice(0, 160),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  if (trades.length === 0) {
    return (
      <p className="py-4 text-center text-[11px] text-muted-foreground" data-testid="fills-empty">
        No positions could be built from that log. Every trade needs the fill that opened it —
        a screenshot that starts mid-position has nothing to anchor to.
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="panel-fill-log">
      <p className="text-[11px] text-muted-foreground">
        {fills.length} filled {fills.length === 1 ? "order" : "orders"} came to{" "}
        <span className="text-foreground">
          {trades.length} {trades.length === 1 ? "trade" : "trades"}
        </span>
        . Which rows belong together is decided by the position, not by the order they are
        printed in — check the legs before logging them.
      </p>

      <ul className="space-y-2">
        {trades.map((t, i) => (
          <li
            key={i}
            className={`rounded-md border px-3 py-2 ${
              skip[i] ? "border-border/40 opacity-45" : "border-card-border bg-secondary/20"
            }`}
            data-testid={`fill-trade-${i}`}
          >
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {t.direction === "long" ? (
                <ArrowUpRight className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <ArrowDownRight className="h-3.5 w-3.5 text-primary" />
              )}
              <span className="font-semibold">{t.symbol}</span>
              <span className="font-mono text-muted-foreground">
                {t.size + t.adds.reduce((n, a) => n + a.size, 0)} @ {num(avgEntry(t))}
              </span>
              {!t.stillOpen && avgExit(t) != null && (
                <span className="font-mono text-muted-foreground">→ {num(avgExit(t)!)}</span>
              )}
              {t.stillOpen && (
                <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-500">
                  still open
                </Badge>
              )}
              {t.initialStop != null && (
                <Badge variant="outline" className="border-primary/40 text-[10px] text-primary">
                  stopped at {num(t.initialStop)}
                </Badge>
              )}
              <button
                type="button"
                className="ml-auto text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => setSkip((p) => ({ ...p, [i]: !p[i] }))}
                data-testid={`button-skip-fill-trade-${i}`}
              >
                {skip[i] ? "include" : "skip"}
              </button>
            </div>

            {/* The legs, spelled out. This is the inference made checkable:
                if a boundary is wrong, it is wrong HERE and visible, rather
                than invisible in a saved trade that looks perfectly ordinary. */}
            <ol className="mt-1 space-y-0.5 font-mono text-[10px] text-muted-foreground">
              <li>
                {t.entryTime.replace("T", " ")} · entry {t.size} @ {num(t.entryPrice)}
              </li>
              {t.adds.map((a, k) => (
                <li key={`a${k}`}>
                  {a.time.replace("T", " ")} · added {a.size} @ {num(a.price)}
                </li>
              ))}
              {t.partials.map((pt, k) => (
                <li key={`p${k}`}>
                  {pt.time.replace("T", " ")} · took {pt.size} @ {num(pt.price)}
                </li>
              ))}
              {!t.stillOpen && t.exitPrice != null && (
                <li>
                  {(t.exitTime ?? "").replace("T", " ")} · closed the rest @ {num(t.exitPrice)}
                </li>
              )}
            </ol>

            {/* The plan, which no execution log contains. Pre-filled only
                where a fired stop proved the level; otherwise asked for,
                because a defaulted stop is a made-up number sitting under
                every R this trade will ever contribute — and unlike a blank
                one, it would never look wrong. */}
            {!skip[i] && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px]">
                <span className="text-muted-foreground">Stop</span>
                <Input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={levels(i, t).stop}
                  onChange={(e) =>
                    setPlan((prev) => ({ ...prev, [i]: { ...levels(i, t), stop: e.target.value } }))
                  }
                  className="h-7 w-28 font-mono text-xs"
                  data-testid={`input-fill-stop-${i}`}
                />
                <span className="text-muted-foreground">Target</span>
                <Input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={levels(i, t).target}
                  onChange={(e) =>
                    setPlan((prev) => ({ ...prev, [i]: { ...levels(i, t), target: e.target.value } }))
                  }
                  className="h-7 w-28 font-mono text-xs"
                  data-testid={`input-fill-target-${i}`}
                />
                {!ready(i, t) && (
                  <span className="text-amber-500">
                    {t.initialStop == null
                      ? "the log has neither — without them there is no R"
                      : "the log never has the target"}
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {problems.map((p) => (
        <p key={p} className="text-[10px] text-amber-500" data-testid="text-fill-log-problem">
          {p}
        </p>
      ))}

      <Button
        type="button"
        className="w-full"
        disabled={saving || chosen.length === 0}
        onClick={save}
        data-testid="button-log-fill-trades"
      >
        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Log {chosen.length} {chosen.length === 1 ? "trade" : "trades"}
      </Button>
      {waiting > 0 && (
        <p className="text-center text-[10px] text-muted-foreground" data-testid="text-fills-waiting">
          {waiting} more {waiting === 1 ? "trade is" : "trades are"} waiting on a stop and a
          target. Skip any you would rather not fill in.
        </p>
      )}
    </div>
  );
}
