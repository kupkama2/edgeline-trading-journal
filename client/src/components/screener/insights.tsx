import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { fmtPrague, useAskScreenerAi, useScreenerAi, type ScreenerPage } from "@/lib/screener";

const STANCE = {
  long: "border-emerald-500/60 bg-emerald-500/15 text-emerald-400",
  short: "border-red-500/60 bg-red-500/15 text-red-400",
  watch: "border-sky-500/50 bg-sky-500/10 text-sky-400",
  avoid: "border-amber-500/50 bg-amber-500/10 text-amber-500",
} as const;
const SEV = ["", "bg-muted-foreground/50", "bg-amber-500", "bg-red-500"] as const;

/**
 * The top of the screener: the AI's read of the last scheduled run — the
 * tape, the coins where readings line up, what argues against each — and
 * the anomalies the run itself flagged, which need no AI. A coin's name
 * opens it.
 */
export function ScreenerInsights({ run, onOpen }: { run: NonNullable<ScreenerPage["run"]>; onOpen: (coin: string) => void }) {
  const ai = useScreenerAi();
  const ask = useAskScreenerAi();
  const { toast } = useToast();
  const [showAll, setShowAll] = useState(false);
  const latest = ai.data?.latest;
  const read = latest?.read;
  const status = ai.data?.status;
  const anomalies = run.anomalies ?? [];
  const shown = showAll ? anomalies : anomalies.filter((a) => a.severity >= 2).slice(0, 8);
  const flow = run.flowStatus;
  const liq = run.liqStatus;
  const wait = status?.nextAllowedAt ? Math.max(0, new Date(status.nextAllowedAt).getTime() - Date.now()) : 0;

  const onAsk = async () => {
    try {
      await ask.mutateAsync();
      toast({ title: "Reading the run", description: "The read appears here when it lands, in a minute or two." });
    } catch (err: any) {
      toast({ title: "Not now", description: String(err?.message ?? err).replace(/^\d+:\s*/, "").replace(/^\{"message":"|".*$/g, "").slice(0, 160), variant: "destructive" });
    }
  };

  const Coin = ({ c }: { c: string }) => (
    <button type="button" className="font-semibold hover:text-sky-400" onClick={() => onOpen(c)} data-testid={`insight-coin-${c}`}>
      {c}
    </button>
  );

  return (
    <Card className="border-card-border bg-card p-3 sm:p-4" data-testid="screener-insights">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="h-3.5 w-3.5 text-sky-400" /> The read
          {latest && <span className="text-[11px] font-normal text-muted-foreground">· {fmtPrague(latest.at)} Prague{latest.runId && latest.runId !== run.id ? " · from an earlier run" : ""}</span>}
        </h2>
        {status?.enabled && (
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={status.running || ask.isPending || wait > 0} onClick={onAsk} title={wait > 0 ? `Again in ${Math.ceil(wait / 60_000)} min` : "Read the latest run now"} data-testid="screener-ai-ask">
            {status.running || ask.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Sparkles className="mr-1 h-3 w-3" />}
            {status.running ? "Reading…" : wait > 0 ? `Again in ${Math.ceil(wait / 60_000)} min` : "Read now"}
          </Button>
        )}
      </div>

      <p className="mt-1 text-[11px] text-muted-foreground" data-testid="screener-flow-status">
        {flow?.source === "relay"
          ? `Binance flow through your relay (${flow.account}): ${flow.coins} coins${flow.failed ? `, ${flow.failed} failed` : ""}${flow.mismatched?.length ? `; ${flow.mismatched.join(", ")} left out — the Binance namesake is a different token` : ""}.`
          : flow
            ? `Binance flow off: ${flow.error ?? "no relay"}`
            : "Binance flow arrives with the next run."}{" "}
        {liq ? (liq.error ? `Liquidation map off: ${liq.error}.` : `Liquidation map from ${liq.accounts} of Hyperliquid's largest accounts.`) : ""}
      </p>

      {!status?.enabled && <p className="mt-2 text-xs text-muted-foreground">The AI read needs ANTHROPIC_API_KEY on the server. The anomalies below need nothing.</p>}
      {status?.enabled && !latest && <p className="mt-2 text-xs text-muted-foreground">No read yet. It comes after the 08:00 and 13:30 runs, or ask for one.</p>}
      {latest?.error && !read && <p className="mt-2 text-xs text-amber-500">The last read failed: {latest.error}</p>}

      {read && (
        <div className="mt-2 space-y-2" data-testid="screener-ai-read">
          <p className="text-xs leading-relaxed text-foreground/90">{read.regime}</p>
          <ul className="space-y-2">
            {read.tips.map((t, i) => (
              <li key={`${t.coin}-${i}`} className="rounded-md border border-border/60 p-2 text-xs" data-testid={`screener-ai-tip-${t.coin}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Coin c={t.coin} />
                  <span className={`rounded border px-1 text-[10px] font-semibold uppercase ${STANCE[t.stance]}`}>{t.stance}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {t.horizon} · {t.confidence} confidence
                  </span>
                </div>
                <p className="mt-1 text-foreground/90">{t.thesis}</p>
                <div className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
                  <ul className="text-[11px] text-emerald-400/90">
                    {t.agree.map((a, j) => (
                      <li key={j}>+ {a}</li>
                    ))}
                  </ul>
                  <ul className="text-[11px] text-red-400/90">
                    {t.disagree.map((a, j) => (
                      <li key={j}>− {a}</li>
                    ))}
                  </ul>
                </div>
                {t.invalidation && <p className="mt-1 text-[11px] text-muted-foreground">Wrong if: {t.invalidation}</p>}
              </li>
            ))}
          </ul>
          {read.anomalies.length > 0 && (
            <ul className="space-y-0.5 text-[11px] text-muted-foreground">
              {read.anomalies.map((a, i) => (
                <li key={i}>
                  <Coin c={a.coin} />: {a.note}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {anomalies.length > 0 && (
        <div className="mt-3 border-t border-border/50 pt-2" data-testid="screener-anomalies">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">What stands out this run · {anomalies.length}</p>
            {anomalies.length > shown.length || showAll ? (
              <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setShowAll((x) => !x)} data-testid="screener-anomalies-all">
                {showAll ? "Only the notable" : "All of them"}
              </button>
            ) : null}
          </div>
          <ul className="mt-1 space-y-0.5 text-[11px]">
            {shown.map((a, i) => (
              <li key={`${a.coin}-${a.kind}-${i}`} className="flex items-baseline gap-1.5">
                <span className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${SEV[a.severity]}`} />
                <span>
                  <Coin c={a.coin} /> <span className="text-foreground/85">{a.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
