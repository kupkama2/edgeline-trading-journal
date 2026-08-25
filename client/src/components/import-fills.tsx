import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ArrowDownRight, ArrowUpRight, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAddFill, useCreateTrade, useStyles, useTrades } from "@/lib/data";
import { AccountPicker } from "@/components/trade-pickers";
import { styleColor, useStyleFilter } from "@/lib/style-filter";
import { num } from "@/components/trade-shared";
import { computeMetrics, fmtMoney, fmtR } from "@shared/metrics";
import { pointValueFor } from "@shared/symbols";
import {
  avgEntry,
  avgExit,
  tradesFromLog,
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
  const { trades, problems } = useMemo(() => tradesFromLog(fills), [fills]);
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
  /*
   * Which trade is being looked at. The reconstruction is an inference, and
   * a list of three invites the eye to scan and accept; one at a time is the
   * same information with the reading forced. `at === trades.length` is the
   * summary at the end, which is the only place anything gets written.
   */
  const [at, setAt] = useState(0);
  /*
   * The account, once for the whole batch.
   *
   * A batch comes off ONE screen of ONE account — that is what makes it a
   * batch — so asking per trade would be asking the same question nine times
   * and inviting one of the nine to be answered differently by accident.
   */
  const [account, setAccount] = useState("");
  /*
   * The style, per trade, because that is the one thing a batch genuinely
   * disagrees about: an afternoon's fills can hold a scalp and a swing, and
   * filing them together would put them in the same book and average two
   * edges into one.
   */
  const [styleOf, setStyleOf] = useState<Record<number, number | null>>({});
  const { toast } = useToast();
  const createTrade = useCreateTrade();
  const addFill = useAddFill();
  const { data: styles = [] } = useStyles();
  const { data: allTrades = [] } = useTrades();
  // The accounts already in use, so a batch joins one of them rather than
  // quietly inventing a tenth spelling of the same prop firm.
  const knownAccounts = useMemo(() => {
    const set = new Set<string>();
    for (const t of allTrades) if (t.account?.trim()) set.add(t.account.trim());
    return Array.from(set).sort();
  }, [allTrades]);
  // A batch imported while looking at one book belongs to that book unless
  // said otherwise — the same default the entry card uses.
  const { activeStyleId } = useStyleFilter();
  const styleFor = (i: number) => (i in styleOf ? styleOf[i] : activeStyleId);

  const levels = (i: number, t: ReconstructedTrade) => ({
    stop: plan[i]?.stop ?? (t.initialStop != null ? String(t.initialStop) : ""),
    target: plan[i]?.target ?? (t.planTarget != null ? String(t.planTarget) : ""),
  });
  const numOrNull = (v: string) => (v.trim() === "" || !isFinite(Number(v)) ? null : Number(v));

  /*
   * What this trade actually made, worked out on the spot.
   *
   * The point of showing it here is not decoration: it is the one figure the
   * trader can check against their broker without leaving the screen, and a
   * reconstruction that agrees with the statement to the dollar is a
   * reconstruction whose trade boundaries are right. A wrong boundary shows up
   * as a P&L that does not match anything.
   *
   * R follows the stop, so it appears as the stop is typed rather than sitting
   * there as a dash — which is also the fastest way to notice a stop entered
   * on the wrong side.
   */
  const previewOf = (i: number, t: ReconstructedTrade) => {
    const l = levels(i, t);
    if (t.stillOpen || t.exitPrice == null) return null;
    return computeMetrics({
      symbol: t.symbol,
      direction: t.direction,
      size: t.size,
      sizeUnit: "base",
      entryPrice: t.entryPrice,
      initialStop: numOrNull(l.stop),
      initialTarget: numOrNull(l.target),
      exitPrice: t.exitPrice,
      status: "closed",
      pointValue: pointValueFor(t.symbol),
      fees: 0,
      // The legs matter to the total: a trade scaled out of made its money at
      // several prices, and pricing all of it at the last one would be wrong
      // by exactly the amount the scaling was worth.
      fills: [
        ...t.adds.map((a, k) => ({ id: k, kind: "add", price: a.price, size: a.size, time: a.time })),
        ...t.partials.map((pt, k) => ({ id: 1000 + k, kind: "partial", price: pt.price, size: pt.size, time: pt.time })),
      ],
    } as any);
  };
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
            account: account.trim() || null,
            styleId: styleFor(i),
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

      {/* Asked once and shown throughout, because it governs the whole batch:
          a batch comes off one screen of one account, and asking per trade
          would invite one of them to be answered differently by accident. */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-[11px]">
        <span className="text-muted-foreground">Account for all {trades.length}</span>
        <div className="min-w-[10rem] flex-1">
          <AccountPicker
            value={account}
            onChange={setAccount}
            known={knownAccounts}
            testIdPrefix="fill-account"
          />
        </div>
      </div>

      {at < trades.length ? (
        (() => {
          const t = trades[at];
          const i = at;
          return (
            <div className="space-y-3" data-testid={`fill-step-${at}`}>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  Trade <span className="text-foreground">{at + 1}</span> of {trades.length}
                </span>
                <span className="flex gap-1">
                  {/* A dot per trade: how far through, and how far left, without
                      a sentence saying it. */}
                  {trades.map((_, k) => (
                    <span
                      key={k}
                      className={`h-1.5 w-1.5 rounded-full ${
                        k === at ? "bg-primary" : skip[k] ? "bg-border" : k < at ? "bg-emerald-500/60" : "bg-border"
                      }`}
                    />
                  ))}
                </span>
              </div>

          <div
            className="rounded-md border border-card-border bg-secondary/20 px-3 py-2"
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
              {/* The figure to check against the broker. A reconstruction that
                  agrees with the statement to the dollar has its boundaries
                  right; a wrong one shows up here as a total matching nothing. */}
              {(() => {
                const m = previewOf(i, t);
                if (!m || m.actualPnL == null) return null;
                return (
                  <span
                    className={`ml-auto font-mono text-xs font-semibold ${
                      m.actualPnL >= 0 ? "text-emerald-400" : "text-primary"
                    }`}
                    data-testid={`fill-pnl-${i}`}
                  >
                    {fmtMoney(m.actualPnL)}
                    {m.actualR != null && (
                      <span className="ml-2 font-normal text-muted-foreground">
                        {fmtR(m.actualR)}
                      </span>
                    )}
                  </span>
                );
              })()}
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
            {(
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
                {previewOf(i, t)?.actualR == null && numOrNull(levels(i, t).stop) == null && (
                  <span className="text-muted-foreground">R needs the stop</span>
                )}
                {!ready(i, t) && (
                  <span className="text-amber-500">
                    {t.initialStop == null
                      ? "the log cannot prove these — type what you actually set"
                      : "the log never has the target"}
                  </span>
                )}
              </div>
            )}

            {/* Per trade, unlike the account: an afternoon's fills can hold a
                scalp and a swing, and filing them together would put two
                different edges in one book and average them. */}
            {styles.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                <span className="text-muted-foreground">Style</span>
                {styles.map((st) => {
                  const on = st.id === styleFor(i);
                  const c = styleColor(st.color);
                  return (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => setStyleOf((p) => ({ ...p, [i]: on ? null : st.id }))}
                      aria-pressed={on}
                      data-testid={`chip-fill-style-${i}-${st.id}`}
                      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 transition-colors ${
                        on
                          ? c.chip
                          : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
                      {st.name}
                    </button>
                  );
                })}
                {styleFor(i) != null && (
                  <button
                    type="button"
                    onClick={() => setStyleOf((p) => ({ ...p, [i]: null }))}
                    className="rounded-full border border-border px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
                    data-testid={`button-fill-style-clear-${i}`}
                  >
                    unassigned
                  </button>
                )}
              </div>
            )}

            {/* What the broker had live, shown but not claimed.
                A level here is the level as it stood at that moment, which is
                a different thing from the plan: a stop in profit was moved, a
                target cancelled mid-trade was replaced by one this screenshot
                may never show. Both say how the trade was MANAGED. Only the
                trade that ran into its stop proves what was set at the start,
                and that one arrives already filled in above. */}
            {t.brackets.length > 0 && (
              <p className="mt-1 text-[10px] text-muted-foreground" data-testid={`fill-brackets-${i}`}>
                {t.exitReason === "stop" ? "Its bracket, still untouched when it stopped out: " : "Orders the broker held during it: "}
                {t.brackets
                  .map(
                    (b) =>
                      `${b.kind === "stop" ? "stop" : "target"} ${num(b.level)}${b.filled ? " (hit)" : ""}`,
                  )
                  .join(" · ")}
                {t.exitReason !== "stop" && " — moved during the trade, so not the plan."}
              </p>
            )}
          </div>

              <div className="flex gap-2">
                {at > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-[11px]"
                    onClick={() => setAt(at - 1)}
                    data-testid="button-fill-back"
                  >
                    Back
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-[11px]"
                  onClick={() => {
                    setSkip((p) => ({ ...p, [i]: true }));
                    setAt(at + 1);
                  }}
                  data-testid="button-fill-skip"
                >
                  Skip this one
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="flex-1 text-[11px]"
                  disabled={!ready(i, t)}
                  onClick={() => {
                    setSkip((p) => ({ ...p, [i]: false }));
                    setAt(at + 1);
                  }}
                  data-testid="button-fill-next"
                >
                  {ready(i, t)
                    ? at + 1 === trades.length
                      ? "Looks right — review them all"
                      : "Looks right — next"
                    : "Needs a stop and a target"}
                </Button>
              </div>
            </div>
          );
        })()
      ) : (
        <div className="space-y-2" data-testid="panel-fill-summary">
          <p className="text-[11px] text-muted-foreground">
            {chosen.length === 0
              ? "Nothing left to log — every trade was skipped."
              : `Ready to log ${chosen.length} of ${trades.length}.`}
          </p>
          <ul className="space-y-1 font-mono text-[10px] text-muted-foreground">
            {trades.map((t, k) => (
              <li
                key={k}
                className={`flex justify-between gap-3 ${skip[k] ? "opacity-40 line-through" : ""}`}
                data-testid={`fill-summary-${k}`}
              >
                <span>
                  {t.symbol} {t.direction} {t.size} @ {num(t.entryPrice)}
                  {t.exitPrice != null && ` → ${num(t.exitPrice)}`}
                </span>
                {(() => {
                  const m = previewOf(k, t);
                  if (!m || m.actualPnL == null) return null;
                  return (
                    <span className={m.actualPnL >= 0 ? "text-emerald-400" : "text-primary"}>
                      {fmtMoney(m.actualPnL)}
                      {m.actualR != null && ` · ${fmtR(m.actualR)}`}
                    </span>
                  );
                })()}
              </li>
            ))}
          </ul>
          {(() => {
            // What the whole batch comes to. One number to check against the
            // day's P&L on the broker, which is the cheapest possible proof
            // that none of the trade boundaries came out wrong.
            const total = chosen.reduce(
              (n, { t, i }) => n + (previewOf(i, t)?.actualPnL ?? 0),
              0,
            );
            return chosen.length > 1 ? (
              <p className="border-t border-border/60 pt-1.5 text-[11px]" data-testid="text-fill-total">
                Together they come to{" "}
                <span className={`font-mono ${total >= 0 ? "text-emerald-400" : "text-primary"}`}>
                  {fmtMoney(total)}
                </span>{" "}
                — check it against the day on your broker.
              </p>
            ) : null;
          })()}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-[11px]"
            onClick={() => setAt(0)}
            data-testid="button-fill-restart"
          >
            Go back through them
          </Button>
        </div>
      )}

      {problems.map((p) => (
        <p key={p} className="text-[10px] text-amber-500" data-testid="text-fill-log-problem">
          {p}
        </p>
      ))}

      {/* Hidden rather than disabled while stepping. A greyed-out button the
          size of the primary one still reads as the thing to press, and the
          thing to press here is "next". */}
      {at >= trades.length && (
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
      )}
      {at < trades.length && (
        <p className="text-center text-[10px] text-muted-foreground" data-testid="text-fills-progress">
          Nothing is written until you have been through them all.
        </p>
      )}
      {at >= trades.length && waiting > 0 && (
        <p className="text-center text-[10px] text-muted-foreground" data-testid="text-fills-waiting">
          {waiting} more {waiting === 1 ? "trade is" : "trades are"} waiting on a stop and a
          target. Skip any you would rather not fill in.
        </p>
      )}
    </div>
  );
}
