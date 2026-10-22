import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ArrowDownRight, ArrowUpRight, Check, CircleSlash, FileQuestion, Loader2, Scale, Unlock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  fileToDownscaledDataUrl,
  parseScreenshot,
  useAccountSettings,
  useAllTrades,
  useCreateTrade,
  useUpdateTrade,
} from "@/lib/data";
import { AccountPicker } from "@/components/trade-pickers";
import { Dropzone, num } from "@/components/trade-shared";
import { failed } from "@/lib/report";
import { fmtMoney } from "@shared/metrics";
import { missingRisk, type TradeWithTags } from "@shared/schema";
import { impliedFees } from "@shared/setup-read";
import { marketOf, mergePositions, readHistory, reconcile, type ReconRow, type VenuePosition } from "@shared/reconcile";

/**
 * The venue's week, laid against the journal's.
 *
 * For when the sync is not available — no key, or a venue that will not
 * answer this server — but the venue's own history page is one screenshot
 * away. Paste it (several, if the week needs scrolling) and every position
 * on it is placed: matched, still open in the journal, closed at another
 * exit, or not logged at all; and anything the journal has for the account
 * in that stretch that the venue does not is listed too.
 *
 * Nothing is written by the reading. Each fix is a button on its row, and
 * the one that creates a trade asks for the stop and target first, because
 * the venue's history does not have them and the journal will not invent
 * the denominator of every R.
 */
const GROUPS: { verdict: ReconRow["verdict"]; title: string; hint: string; icon: typeof Check; tone: string }[] = [
  { verdict: "close-it", title: "Still open in the journal", hint: "The venue closed these. Close them at the venue's exit.", icon: Unlock, tone: "border-amber-500/40 text-amber-500" },
  { verdict: "exit-differs", title: "Closed at a different exit", hint: "The venue's average close is the real one, partials included.", icon: Scale, tone: "border-amber-500/40 text-amber-500" },
  { verdict: "not-logged", title: "Not in the journal", hint: "Add the stop and target you used and log it. The venue's history does not have them.", icon: FileQuestion, tone: "border-destructive/50 text-destructive" },
  { verdict: "matches", title: "Logged and matching", hint: "Same market, side, entry and exit.", icon: Check, tone: "border-emerald-500/40 text-emerald-400" },
];

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", hourCycle: "h23", minute: "2-digit" }) : "—";

function feesFor(v: VenuePosition): number | null {
  if (v.realizedPnl == null || v.entryPrice == null || v.exitPrice == null || v.size == null || v.sizeUnit !== "base") return null;
  return impliedFees({ direction: v.direction, entryPrice: v.entryPrice, exitPrice: v.exitPrice, size: v.size, realizedPnl: v.realizedPnl });
}

export function VenueCheck() {
  const { toast } = useToast();
  const { data: trades = [] } = useAllTrades();
  const { data: settings = [] } = useAccountSettings();
  const update = useUpdateTrade();
  const create = useCreateTrade();
  const [account, setAccount] = useState("");
  const [positions, setPositions] = useState<VenuePosition[]>([]);
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [levels, setLevels] = useState<Record<string, { stop: string; target: string }>>({});

  const known = useMemo(
    () =>
      Array.from(new Set([...settings.map((s) => s.name), ...trades.map((t) => t.account ?? "").filter(Boolean)])).sort(),
    [settings, trades],
  );
  const result = useMemo(() => reconcile(positions, trades, { account: account || null }), [positions, trades, account]);

  async function read(file: File) {
    setBusy(true);
    try {
      const dataUrl = await fileToDownscaledDataUrl(file);
      setImage(dataUrl);
      const got = readHistory(await parseScreenshot(dataUrl, "history"));
      if (got.length === 0) {
        toast({ title: "No positions found", description: "Try the Position History tab, or Trade History with the Direction column in view.", variant: "destructive" });
      } else {
        setPositions((prev) => mergePositions(prev, got));
        toast({ title: `${got.length} ${got.length === 1 ? "position" : "positions"} read`, description: "Add another screenshot if the week runs past this one." });
      }
    } catch (err) {
      failed("Reading the screenshot")(err);
    } finally {
      setBusy(false);
      setImage(null);
    }
  }

  const keyOf = (v: VenuePosition) => `${marketOf(v.symbol)}|${v.direction}|${v.entryTime ?? v.entryPrice}`;

  function closeIt(t: TradeWithTags, v: VenuePosition) {
    const fees = t.fees ?? feesFor(v);
    update.mutate(
      {
        id: t.id,
        trade: {
          status: "closed",
          exitPrice: v.exitPrice,
          exitTime: v.exitTime ?? new Date().toISOString(),
          exitReason: (t.exitReason as any) ?? "other",
          ...(t.fees == null && fees != null ? { fees } : {}),
        } as any,
      },
      {
        onSuccess: () => toast({ title: `${t.symbol} closed`, description: `At ${num(v.exitPrice)}, from the venue. Say how it ended when you review it.` }),
        onError: failed(`Closing ${t.symbol}`),
      },
    );
  }

  function applyExit(t: TradeWithTags, v: VenuePosition) {
    update.mutate(
      { id: t.id, trade: { exitPrice: v.exitPrice, ...(v.exitTime ? { exitTime: v.exitTime } : {}) } as any },
      {
        onSuccess: () => toast({ title: `${t.symbol} exit corrected`, description: `${num(t.exitPrice)} → ${num(v.exitPrice)}.` }),
        onError: failed(`Correcting ${t.symbol}`),
      },
    );
  }

  function logIt(v: VenuePosition) {
    const l = levels[keyOf(v)] ?? { stop: "", target: "" };
    const stop = l.stop.trim() ? Number(l.stop) : null;
    const target = l.target.trim() ? Number(l.target) : null;
    if (v.entryPrice == null || v.size == null) {
      toast({ title: "The screenshot has no entry or size for this one", description: "Log it from the journal instead.", variant: "destructive" });
      return;
    }
    if (missingRisk({ status: "closed", initialStop: stop, initialTarget: target }).length || !Number.isFinite(stop!) || !Number.isFinite(target!)) {
      toast({ title: "A stop and a target are needed", description: "1R is measured entry-to-stop; the venue's history does not have them.", variant: "destructive" });
      return;
    }
    const fees = feesFor(v);
    create.mutate(
      {
        trade: {
          symbol: marketOf(v.symbol),
          direction: v.direction,
          size: v.size,
          sizeUnit: v.sizeUnit ?? "base",
          entryPrice: v.entryPrice,
          entryTime: v.entryTime ?? v.exitTime ?? new Date().toISOString(),
          initialStop: stop,
          initialTarget: target,
          status: v.closed ? "closed" : "open",
          ...(v.closed
            ? { exitPrice: v.exitPrice, exitTime: v.exitTime ?? new Date().toISOString(), exitReason: "other", fees }
            : {}),
          account: account || null,
          source: null,
        } as any,
        mistakeTagIds: [],
      },
      {
        onSuccess: () => toast({ title: `${marketOf(v.symbol)} logged`, description: "Rationale and the review are still yours to add." }),
        onError: failed(`Logging ${marketOf(v.symbol)}`),
      },
    );
  }

  const groups = GROUPS.map((g) => ({ ...g, rows: result.rows.filter((r) => r.verdict === g.verdict) })).filter((g) => g.rows.length);

  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-venue-check">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Scale className="h-4 w-4" />
            Check against the venue
          </h2>
          <p className="mt-0.5 max-w-prose text-[11px] leading-snug text-muted-foreground">
            Paste a screenshot of the venue's history — Binance Position History, or Hyperliquid
            Trade History with the Direction column — and each position is placed against what you
            logged. Nothing changes until you press a button on a row.
          </p>
        </div>
        <div className="w-56 shrink-0">
          <AccountPicker value={account} onChange={setAccount} known={known} testIdPrefix="venue-check-account" emptyLabel="Any account" />
        </div>
      </div>

      <div className="mt-3">
        <Dropzone
          label={positions.length ? "Add another screenshot" : "Drop or paste the venue's history"}
          hint="Several screenshots of one week are merged; a position read twice counts once."
          image={image}
          busy={busy}
          onFile={read}
          onClear={() => setImage(null)}
          testId="venue-check-drop"
        />
      </div>

      {busy && (
        <p className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading…
        </p>
      )}

      {positions.length > 0 && (
        <div className="mt-4 space-y-4">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span data-testid="text-venue-check-summary">
              {positions.length} on the venue · {result.rows.filter((r) => r.trade).length} matched to the journal
              {account ? ` (${account})` : ""}
            </span>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => setPositions([])} data-testid="button-venue-check-clear">
              Start again
            </Button>
          </div>

          {groups.map((g) => {
            const Icon = g.icon;
            return (
              <div key={g.verdict} className="space-y-1.5" data-testid={`venue-check-${g.verdict}`}>
                <Badge variant="outline" className={`text-[10px] ${g.tone}`}>
                  <Icon className="mr-1 h-3 w-3" />
                  {g.title} · {g.rows.length}
                </Badge>
                <p className="text-[10px] text-muted-foreground">{g.hint}</p>
                <ul className="divide-y divide-border/50 rounded-md border border-card-border">
                  {g.rows.map((r) => {
                    const v = r.venue;
                    const k = keyOf(v);
                    const lv = levels[k] ?? { stop: "", target: "" };
                    return (
                      <li key={k} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-xs" data-testid={`venue-row-${marketOf(v.symbol)}`}>
                        {v.direction === "long" ? (
                          <ArrowUpRight className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <ArrowDownRight className="h-3.5 w-3.5 text-primary" />
                        )}
                        <span className="min-w-[4rem] font-mono font-semibold">{marketOf(v.symbol)}</span>
                        <span className="font-mono text-muted-foreground">
                          {num(v.entryPrice)} → {v.closed ? num(v.exitPrice) : "open"}
                        </span>
                        {v.realizedPnl != null && <span className="font-mono">{fmtMoney(v.realizedPnl)}</span>}
                        <span className="text-[10px] text-muted-foreground">{when(v.entryTime)}</span>
                        {r.trade && (
                          <Link href={`/trade/${r.trade.id}`} className="text-[10px] text-primary hover:underline">
                            journal: {num(r.trade.entryPrice)} → {r.trade.status === "closed" ? num(r.trade.exitPrice) : r.trade.status}
                          </Link>
                        )}
                        <span className="ml-auto flex items-center gap-1.5">
                          {r.verdict === "close-it" && r.trade && v.exitPrice != null && (
                            <Button size="sm" className="h-7 text-[11px]" disabled={update.isPending} onClick={() => closeIt(r.trade!, v)} data-testid={`button-venue-close-${r.trade.id}`}>
                              Close at {num(v.exitPrice)}
                            </Button>
                          )}
                          {r.verdict === "exit-differs" && r.trade && (
                            <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={update.isPending} onClick={() => applyExit(r.trade!, v)} data-testid={`button-venue-exit-${r.trade.id}`}>
                              Use {num(v.exitPrice)}
                            </Button>
                          )}
                          {r.verdict === "not-logged" && (
                            <>
                              <Input
                                value={lv.stop}
                                onChange={(e) => setLevels((x) => ({ ...x, [k]: { ...lv, stop: e.target.value } }))}
                                placeholder="stop"
                                inputMode="decimal"
                                className="h-7 w-24 font-mono text-[11px]"
                                data-testid={`input-venue-stop-${marketOf(v.symbol)}`}
                              />
                              <Input
                                value={lv.target}
                                onChange={(e) => setLevels((x) => ({ ...x, [k]: { ...lv, target: e.target.value } }))}
                                placeholder="target"
                                inputMode="decimal"
                                className="h-7 w-24 font-mono text-[11px]"
                                data-testid={`input-venue-target-${marketOf(v.symbol)}`}
                              />
                              <Button size="sm" className="h-7 text-[11px]" disabled={create.isPending} onClick={() => logIt(v)} data-testid={`button-venue-log-${marketOf(v.symbol)}`}>
                                Log it
                              </Button>
                            </>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}

          {result.journalOnly.length > 0 && (
            <div className="space-y-1.5" data-testid="venue-check-journal-only">
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                <CircleSlash className="mr-1 h-3 w-3" />
                In the journal, not on this history · {result.journalOnly.length}
              </Badge>
              <p className="text-[10px] text-muted-foreground">
                Logged on {account} in the same stretch, and nowhere on the screenshot — on another
                account, logged twice, or simply off the edge of the crop.
              </p>
              <ul className="divide-y divide-border/50 rounded-md border border-card-border">
                {result.journalOnly.map((t) => (
                  <li key={t.id}>
                    <Link href={`/trade/${t.id}`} className="flex items-center gap-3 px-3 py-2 text-xs hover:bg-secondary/40">
                      <span className="min-w-[4rem] font-mono font-semibold">{t.symbol}</span>
                      <span className="font-mono text-muted-foreground">
                        {num(t.entryPrice)} → {t.status === "closed" ? num(t.exitPrice) : t.status}
                      </span>
                      <span className="ml-auto text-[10px] text-muted-foreground">{when(t.entryTime)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!account && (
            <p className="text-[10px] text-muted-foreground">
              Pick the account this history is from to see what the journal has that the venue does not.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
