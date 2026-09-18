import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ChevronDown, Ban, Undo2, Zap } from "lucide-react";
import { useCreateTrade, useDeleteTrade, useStyles, useTrades } from "@/lib/data";
import { store } from "@/lib/scoped-storage";
import { computeMetrics, fmtMoney } from "@shared/metrics";
import { describeScalp, parseScalpLine } from "@shared/scalp";
import { entriesOn } from "@shared/tilt";
import { styleColor } from "@/lib/style-filter";
import type { TradeWithTags } from "@shared/schema";

const OPEN_KEY = "edgeline.scalpLog.open";
const STYLE_KEY = "edgeline.scalpLog.style";

/**
 * The scalp log: a ticker, a result, and Enter.
 *
 * The entry form asks for four prices, which is right for a trade you
 * planned and fatal for one that lasted ninety seconds — so a day of
 * scalps never gets logged at all, and the day you most need on the record
 * is the one that is missing from it. This asks for what a scalp knows.
 *
 * It stays open until you shut it, because the point is to log six of them
 * without touching the mouse: Enter files the line, clears it and keeps
 * the cursor, and a bare number after that is another one of the same
 * ticker. The line above the box says what it is about to log, in English,
 * which is what catches the result and the risk going in the wrong order.
 *
 * Today's tape sits underneath — net, R and count — because the only
 * question a scalping day really asks is whether it is going anywhere, and
 * the answer needs to be visible without leaving the form.
 */
export function ScalpLog() {
  const { data: trades = [] } = useTrades();
  const { data: styles = [] } = useStyles();
  const create = useCreateTrade();
  const del = useDeleteTrade();
  const inputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(() => store.get(OPEN_KEY) === "1");
  const [line, setLine] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  /*
   * The ticker just logged, remembered here rather than read back off the
   * log. A bare number is meant to be another of the same, and typed at
   * speed it arrives before the save it would have learnt the ticker from.
   */
  const [justLogged, setJustLogged] = useState<string | null>(null);
  const [styleId, setStyleId] = useState<number | null>(() => {
    const raw = Number(store.get(STYLE_KEY));
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  });

  useEffect(() => {
    if (open) store.set(OPEN_KEY, "1");
    else store.remove(OPEN_KEY);
  }, [open]);
  useEffect(() => {
    if (styleId != null) store.set(STYLE_KEY, String(styleId));
  }, [styleId]);

  /* The book this log writes into: the one you used last, else the first
     that calls itself scalps, else the first there is. */
  const style = useMemo(() => {
    const picked = styles.find((s) => s.id === styleId);
    if (picked) return picked;
    return styles.find((s) => /scalp/i.test(s.name)) ?? styles[0] ?? null;
  }, [styles, styleId]);

  const today = useMemo(() => {
    const mine = entriesOn(trades, new Date()).filter((t) => t.scalp);
    return mine.slice().reverse();
  }, [trades]);

  const totals = useMemo(() => {
    let pnl = 0;
    let r = 0;
    let measured = 0;
    for (const t of today) {
      const m = computeMetrics(t);
      pnl += m.actualPnL ?? 0;
      if (m.actualR != null) {
        r += m.actualR;
        measured++;
      }
    }
    return { pnl, r, measured, count: today.length };
  }, [today]);

  const lastSymbol = justLogged ?? today[0]?.symbol ?? null;
  const parsed = useMemo(
    () =>
      line.trim()
        ? parseScalpLine(line, { lastSymbol, defaultRisk: style?.defaultRisk ?? null })
        : null,
    [line, lastSymbol, style],
  );

  /* The book's own limit, said where it can still change the next one. */
  const cap = style?.maxTradesPerDay ?? null;
  const overCap = cap != null && totals.count >= cap;

  async function log() {
    if (!parsed?.ok) return;
    const s = parsed.scalp;
    const typed = line;
    /*
     * Cleared before the save, not after it.
     *
     * The first save of a session can take a couple of seconds, and a box
     * that holds its text until the server answers eats everything typed in
     * the meantime — the second scalp of a burst lands appended to the
     * first. So the line goes now and comes back only if the save fails,
     * which is the one case where you need it back.
     */
    setLine("");
    setFailed(null);
    setJustLogged(s.symbol);
    inputRef.current?.focus();
    const now = new Date().toISOString();
    try {
      await create.mutateAsync({
      trade: {
        symbol: s.symbol,
        direction: s.direction,
        // A scalp is a result, not a position: there are no prices to store,
        // and zeroes here are only ever read behind the scalp flag.
        size: 0,
        entryPrice: 0,
        entryTime: now,
        exitTime: now,
        status: "closed",
        scalp: true,
        netPnl: s.netPnl,
        riskAmount: s.riskAmount,
        styleId: style?.id ?? null,
        notes: s.note,
        exitReason: "other",
      } as any,
      });
    } catch {
      setLine(typed);
      setFailed("That one did not save. The line is back — press Enter to try again.");
    }
  }

  return (
    <Card className="border-card-border bg-card p-3 sm:p-4" data-testid="card-scalp-log">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-2 text-left"
          data-testid="button-toggle-scalp-log"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`}
          />
          <Zap className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          <span className="text-sm font-semibold tracking-tight">Log a scalp</span>
          {!open && (
            <span className="truncate text-[11px] text-muted-foreground" data-testid="text-scalp-hint">
              ticker, result, Enter
            </span>
          )}
        </button>

        {/* Today, wherever the log is open or shut: the only question a
            scalping day asks. */}
        {totals.count > 0 && (
          <span className="ml-auto flex flex-wrap items-center gap-x-2.5 font-mono text-[11px]" data-testid="text-scalp-today">
            <span className="text-muted-foreground">
              {totals.count} {totals.count === 1 ? "scalp" : "scalps"} today
            </span>
            <span className={totals.pnl > 0 ? "text-emerald-400" : totals.pnl < 0 ? "text-primary" : ""}>
              {fmtMoney(totals.pnl)}
            </span>
            {totals.measured > 0 && (
              <span className={totals.r > 0 ? "text-emerald-400" : totals.r < 0 ? "text-primary" : ""}>
                {totals.r > 0 ? "+" : ""}
                {totals.r.toFixed(2)}R
              </span>
            )}
          </span>
        )}
      </div>

      {open && (
        <div className="mt-3 space-y-2">
          <Input
            ref={inputRef}
            value={line}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void log();
              }
            }}
            placeholder={`btc 100 50${style?.defaultRisk ? "" : "   (ticker, result, risk)"}`}
            className="h-10 font-mono text-sm"
            spellCheck={false}
            autoComplete="off"
            data-testid="input-scalp-line"
          />

          {/* What it is about to log, in English. The safety net for the two
              numbers arriving in the wrong order. */}
          <p
            className={`text-[11px] leading-snug ${
              parsed == null
                ? "text-muted-foreground"
                : parsed.ok
                  ? "text-foreground"
                  : "text-amber-500"
            }`}
            data-testid="text-scalp-preview"
          >
            {parsed == null
              ? `Ticker, what it made, and what it risked. ${
                  style?.defaultRisk
                    ? `Leave the risk off and ${style.name} assumes $${style.defaultRisk}.`
                    : "Set a usual risk on this book in Settings and you can leave it off."
                }`
              : parsed.ok
                ? describeScalp(parsed.scalp)
                : parsed.hint}
          </p>

          {failed && (
            <p className="text-[11px] font-semibold text-destructive" data-testid="text-scalp-failed">
              {failed}
            </p>
          )}

          {overCap && (
            <p className="flex items-start gap-1.5 text-[11px] font-semibold text-amber-500" data-testid="text-scalp-cap">
              <Ban className="mt-px h-3.5 w-3.5 shrink-0" />
              That would be number {totals.count + 1} today, on a book that allows {cap}.
            </p>
          )}

          {totals.count >= 3 && totals.pnl < 0 && (
            <p className="text-[11px] font-semibold text-primary" data-testid="text-scalp-down">
              {totals.count} scalps and {fmtMoney(totals.pnl)} down. Is the next one a trade, or just
              the next one?
            </p>
          )}

          {styles.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="scalp-style-picker">
              {styles.map((s) => {
                const on = style?.id === s.id;
                const c = styleColor(s.color);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setStyleId(s.id)}
                    aria-pressed={on}
                    className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] leading-tight transition-colors ${
                      on ? c.chip : "border-border text-muted-foreground hover:border-primary/40"
                    }`}
                    data-testid={`button-scalp-style-${s.id}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
                    {s.name}
                  </button>
                );
              })}
            </div>
          )}

          {/* The tape. Newest first, each one a click from being un-logged,
              because a typo at this speed is the normal case. */}
          {today.length > 0 && (
            <ul className="flex flex-wrap gap-1.5 border-t border-border/60 pt-2" data-testid="list-scalps-today">
              {today.map((t) => (
                <li key={t.id}>
                  <ScalpChip trade={t} onUndo={() => del.mutate(t.id)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function ScalpChip({ trade, onUndo }: { trade: TradeWithTags; onUndo: () => void }) {
  const m = computeMetrics(trade);
  const up = (m.actualPnL ?? 0) >= 0;
  return (
    <span
      className={`group flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] ${
        up ? "border-emerald-500/40 text-emerald-400" : "border-primary/40 text-primary"
      }`}
      data-testid={`chip-scalp-${trade.id}`}
    >
      <span className="font-semibold">{trade.symbol}</span>
      <span>{fmtMoney(m.actualPnL)}</span>
      {m.actualR != null && (
        <span className="opacity-70">
          {m.actualR > 0 ? "+" : ""}
          {m.actualR.toFixed(1)}R
        </span>
      )}
      <button
        type="button"
        onClick={onUndo}
        aria-label={`Un-log ${trade.symbol}`}
        title="Un-log this one"
        className="text-muted-foreground transition-colors hover:text-foreground"
        data-testid={`button-undo-scalp-${trade.id}`}
      >
        <Undo2 className="h-3 w-3" />
      </button>
    </span>
  );
}
