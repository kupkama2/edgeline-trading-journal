import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Loader2, Sparkles, Undo2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { fmtPct, fmtPrague, useAskScreenerAi, useScreenerAi, useScreenerAiTrack, type ScreenerPage } from "@/lib/screener";
import { TRACK_KEYS, type CallStance, type TrackKey, type TrackedCall } from "@shared/ai-track";

const TRACK_LABEL: Record<TrackKey, string> = { "4h": "4h", "24h": "1 day", "3d": "3 days", "1w": "1 week", now: "now" };
/** Green when the move went the call's way, red when against it; a watch is coloured by the price move itself. */
const scoreTone = (x: number | null | undefined) => (x == null ? "text-muted-foreground" : x > 0 ? "text-emerald-400" : x < 0 ? "text-red-400" : "");

/** The scorecard: per stance, how many calls went its way and the mean move in its direction, at each horizon. */
function TrackRecord({ onOpen }: { onOpen: (coin: string) => void }) {
  const track = useScreenerAiTrack();
  const [showCalls, setShowCalls] = useState(false);
  const d = track.data;
  if (!d) return null;
  const scored = d.calls.filter((c) => c.entry);
  if (scored.length === 0) return <p className="mt-3 border-t border-border/50 pt-2 text-[11px] text-muted-foreground">Track record: each call is priced at 4 hours, a day, three days and a week after the read. The first scores show four hours after the first read.</p>;
  const rows: { stance: CallStance; label: string }[] = [
    { stance: "long", label: "Long" },
    { stance: "short", label: "Short" },
    { stance: "avoid", label: "Avoid, as a short" },
    { stance: "watch", label: "Watch, price move" },
  ];
  return (
    <div className="mt-3 border-t border-border/50 pt-2" data-testid="screener-ai-track">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Track record · last 30 days · {scored.length} calls</p>
        <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setShowCalls((x) => !x)} data-testid="screener-ai-track-calls">
          {showCalls ? "Hide the calls" : "Every call"}
        </button>
      </div>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full min-w-[520px] text-[11px]">
          <thead className="text-[10px] text-muted-foreground">
            <tr>
              <th className="py-0.5 text-left font-normal" />
              {TRACK_KEYS.map((k) => (
                <th key={k} className="py-0.5 text-right font-normal">
                  {TRACK_LABEL[k]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ stance, label }) => (
              <tr key={stance} className="border-t border-border/30" data-testid={`screener-ai-track-${stance}`}>
                <td className="py-1 pr-2">{label}</td>
                {TRACK_KEYS.map((k) => {
                  const c = d.summary[stance][k];
                  return (
                    <td key={k} className="py-1 text-right font-mono" title={c.n ? `${c.hits} of ${c.n} ${stance === "watch" ? "rose" : "went the call's way"}; mean ${fmtPct(c.avg)}${c.avgRs != null ? `, against BTC ${fmtPct(c.avgRs)}` : ""}` : "No call has reached this yet"}>
                      {c.n ? (
                        <>
                          <span className="text-muted-foreground">{stance === "watch" ? "" : `${Math.round((c.hits / c.n) * 100)}% · `}</span>
                          <span className={stance === "watch" ? "" : scoreTone(c.avg)}>{fmtPct(c.avg)}</span>
                          <span className="ml-1 text-[9px] text-muted-foreground">n{c.n}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">Share of calls that went their way, then the mean move in the call's direction. "Avoid" is scored as if it had been a short; hover a cell for the move against BTC.</p>
      {showCalls && (
        <div className="mt-2 max-h-80 overflow-auto">
          <table className="w-full min-w-[620px] text-[11px]" data-testid="screener-ai-track-list">
            <thead className="sticky top-0 bg-card text-[10px] text-muted-foreground">
              <tr>
                <th className="py-0.5 text-left font-normal">Read</th>
                <th className="py-0.5 text-left font-normal">Coin</th>
                <th className="py-0.5 text-left font-normal">Call</th>
                <th className="py-0.5 text-right font-normal">At</th>
                {TRACK_KEYS.map((k) => (
                  <th key={k} className="py-0.5 text-right font-normal">
                    {TRACK_LABEL[k]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.calls.map((c, i) => (
                <tr key={`${c.readId}-${c.coin}-${i}`} className="border-t border-border/30">
                  <td className="py-0.5 text-muted-foreground">{fmtPrague(c.readAt)}</td>
                  <td className="py-0.5">
                    <button type="button" className="font-semibold hover:text-sky-400" onClick={() => onOpen(c.coin)}>
                      {c.coin}
                    </button>
                  </td>
                  <td className="py-0.5">
                    <span className={`rounded border px-1 text-[9px] font-semibold uppercase ${STANCE[c.stance]}`}>{c.stance}</span>
                  </td>
                  <td className="py-0.5 text-right font-mono text-muted-foreground">{c.entry ? c.entry.px.toPrecision(5) : "—"}</td>
                  {TRACK_KEYS.map((k) => {
                    const m = c.moves[k];
                    return (
                      <td key={k} className={`py-0.5 text-right font-mono ${scoreTone(m ? (m.score ?? m.ret) : null)}`} title={m ? `Price ${fmtPct(m.ret)}${m.rs != null ? `, against BTC ${fmtPct(m.rs)}` : ""}` : "Not reached yet"}>
                        {m ? fmtPct(m.ret) : "·"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[10px] text-muted-foreground">The price move since the call; green when it went the call's way.</p>
        </div>
      )}
    </div>
  );
}

/** Under a tip of the current read: how the coin has moved since the call. */
function SinceCall({ call }: { call: TrackedCall | undefined }) {
  const m = call?.moves.now;
  if (!call?.entry || !m) return null;
  return (
    <p className="mt-1 text-[11px]" data-testid={`screener-ai-since-${call.coin}`}>
      <span className="text-muted-foreground">Since the call: </span>
      <span className={scoreTone(m.score ?? m.ret)}>{fmtPct(m.ret)}</span>
      {m.rs != null && <span className="text-muted-foreground"> · against BTC {fmtPct(m.rs)}</span>}
      {call.stance === "avoid" && m.score != null && <span className="text-muted-foreground"> · as a short {fmtPct(m.score)}</span>}
    </p>
  );
}

const STANCE = {
  long: "border-emerald-500/60 bg-emerald-500/15 text-emerald-400",
  short: "border-red-500/60 bg-red-500/15 text-red-400",
  watch: "border-sky-500/50 bg-sky-500/10 text-sky-400",
  avoid: "border-amber-500/50 bg-amber-500/10 text-amber-500",
} as const;
const SEV = ["", "bg-muted-foreground/50", "bg-amber-500", "bg-red-500"] as const;

const OPEN_KEY = "edgeline.screener.readOpen";
const DONE_KEY = "edgeline.screener.readDone";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function keep(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not remembered; still applied */
  }
}

/**
 * Below the chart: the AI's read of the last scheduled run — the
 * tape, the coins where readings line up, what argues against each — and
 * the anomalies the run itself flagged, which need no AI. A coin's name
 * opens it.
 */
export function ScreenerInsights({ run, onOpen }: { run: NonNullable<ScreenerPage["run"]>; onOpen: (coin: string) => void }) {
  const ai = useScreenerAi();
  const track = useScreenerAiTrack();
  const ask = useAskScreenerAi();
  const { toast } = useToast();
  const [showAll, setShowAll] = useState(false);
  const latest = ai.data?.latest;
  const read = latest?.read;
  /*
   * The whole read folds away, and each coin can be marked done: done ones
   * are out of the list until "show" brings them back. Both are kept in
   * this browser; the done marks belong to one read and a new read starts
   * with none.
   */
  const [open, setOpen] = useState<boolean>(() => load(OPEN_KEY, true));
  const [done, setDone] = useState<{ at: string | null; coins: string[] }>(() => load(DONE_KEY, { at: null, coins: [] }));
  const [showDone, setShowDone] = useState(false);
  const doneHere = new Set(latest && done.at === latest.at ? done.coins : []);
  const toggleOpen = () =>
    setOpen((x) => {
      keep(OPEN_KEY, !x);
      return !x;
    });
  const markDone = (coin: string, on: boolean) => {
    if (!latest) return;
    const next = new Set(doneHere);
    if (on) next.add(coin);
    else next.delete(coin);
    const value = { at: latest.at, coins: Array.from(next) };
    keep(DONE_KEY, value);
    setDone(value);
  };
  const tips = read?.tips ?? [];
  const doneCount = tips.filter((t) => doneHere.has(t.coin)).length;
  const visibleTips = showDone ? tips : tips.filter((t) => !doneHere.has(t.coin));
  const callFor = (coin: string) => track.data?.calls.find((c) => latest && c.readAt === latest.at && c.coin === coin);
  const status = ai.data?.status;
  const anomalies = run.anomalies ?? [];
  const shown = showAll ? anomalies : anomalies.filter((a) => a.severity >= 2).slice(0, 8);
  const flow = run.flowStatus;
  const liq = run.liqStatus;
  const wait = status?.nextAllowedAt ? Math.max(0, new Date(status.nextAllowedAt).getTime() - Date.now()) : 0;

  const onAsk = async () => {
    try {
      const r = (await ask.mutateAsync()) as { refreshing?: boolean };
      toast(
        r?.refreshing
          ? { title: "Refreshing the data first", description: "The last run is over an hour old. The read follows the new run, in a few minutes." }
          : { title: "Reading the run", description: "The read appears here when it lands, in a minute or two." },
      );
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
        <button type="button" onClick={toggleOpen} className="flex items-center gap-1.5 text-left text-sm font-semibold hover:text-sky-400" aria-expanded={open} title={open ? "Fold the read away" : "Open the read"} data-testid="screener-read-toggle">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Sparkles className="h-3.5 w-3.5 text-sky-400" /> The read
          {latest && <span className="text-[11px] font-normal text-muted-foreground">· {fmtPrague(latest.at)} Prague{latest.runId && latest.runId !== run.id ? " · from an earlier run" : ""}</span>}
          {!open && (tips.length > 0 || anomalies.length > 0) && (
            <span className="text-[11px] font-normal text-muted-foreground">
              · {tips.length - doneCount} of {tips.length} coins to go{anomalies.length ? ` · ${anomalies.length} standing out` : ""}
            </span>
          )}
        </button>
        {status?.enabled && (
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={status.running || ask.isPending || wait > 0} onClick={onAsk} title={wait > 0 ? `Again in ${Math.ceil(wait / 60_000)} min` : "Read the latest run now"} data-testid="screener-ai-ask">
            {status.running || ask.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Sparkles className="mr-1 h-3 w-3" />}
            {status.running ? "Reading…" : wait > 0 ? `Again in ${Math.ceil(wait / 60_000)} min` : "Read now"}
          </Button>
        )}
      </div>

      {open && (
      <>
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
            {visibleTips.map((t, i) => {
              const isDone = doneHere.has(t.coin);
              return (
              <li key={`${t.coin}-${i}`} className={`rounded-md border border-border/60 p-2 text-xs ${isDone ? "opacity-50" : ""}`} data-testid={`screener-ai-tip-${t.coin}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Coin c={t.coin} />
                  <span className={`rounded border px-1 text-[10px] font-semibold uppercase ${STANCE[t.stance]}`}>{t.stance}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {t.horizon} · {t.confidence} confidence
                  </span>
                  <button
                    type="button"
                    onClick={() => markDone(t.coin, !isDone)}
                    className="ml-auto inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-foreground/40 hover:text-foreground"
                    title={isDone ? "Back into the list" : "Seen to: take it out of the list until you show the done ones"}
                    data-testid={`screener-ai-done-${t.coin}`}
                  >
                    {isDone ? <Undo2 className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                    {isDone ? "Undo" : "Done"}
                  </button>
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
                <SinceCall call={callFor(t.coin)} />
              </li>
              );
            })}
          </ul>
          {tips.length > 0 && visibleTips.length === 0 && <p className="text-[11px] text-muted-foreground">Every coin in this read is done.</p>}
          {doneCount > 0 && (
            <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setShowDone((x) => !x)} data-testid="screener-ai-show-done">
              {showDone ? "Hide the done ones" : `${doneCount} done · show them`}
            </button>
          )}
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

      {status?.enabled && <TrackRecord onOpen={onOpen} />}

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
      </>
      )}
    </Card>
  );
}
