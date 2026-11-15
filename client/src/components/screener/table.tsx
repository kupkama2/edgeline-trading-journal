import { useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Pin } from "lucide-react";
import { CAPTURE_BAND, TIMEFRAMES, type ScreenerRow, type Timeframe } from "@shared/screener";
import { cvdFor } from "@shared/flow";
import { sectorOf } from "@shared/sectors";
import { ACCEL_ARROW, fmtPct, fmtUsd, fmtX, heat } from "@/lib/screener";
import { useClickOrDouble } from "@/components/screener/chart";

export type Filter = "all" | "candidates" | "fast" | "weakest" | "diverging";

/** What a column header sorts by. */
type SortKey = `rs:${Timeframe}` | "coin" | "rvol" | "funding" | "oi" | "volume" | "score" | "rsi" | "cvd" | "rating" | "alpha" | "hold";

/**
 * The ranked table: one row per coin, RS change per timeframe as heat
 * cells, the acceleration arrow beside the chosen timeframe's number,
 * RVOL, funding, OI change and the flags. A click on a header sorts by
 * it; a click on a row opens the coin; the chart's set is toggled from
 * the dot at the left.
 */
type Sort = { key: SortKey; desc: boolean };

/**
 * A candidate row's sticky cells: the card's own colour with the row's green
 * wash over it, opaque so the columns scroll under. A fixed dark hex here put
 * dark text on near-black in the Paper theme.
 */
const CANDIDATE_CELL = "bg-card [background-image:linear-gradient(rgb(16_185_129/0.07),rgb(16_185_129/0.07))]";

/**
 * A column heading that sorts. At module scope and with a real button in it:
 * declared inside the table it was a new component on every render (remounted,
 * so focus and tooltips were lost), and a bare `th` could not be reached by keyboard.
 */
function Head({ k, sort, setSort, children, className = "", title }: { k: SortKey; sort: Sort; setSort: (s: Sort) => void; children: React.ReactNode; className?: string; title?: string }) {
  const on = sort.key === k;
  return (
    <th
      className={`select-none whitespace-nowrap px-1 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${on ? "text-foreground" : "text-muted-foreground"} ${className}`}
      aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}
    >
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-0.5 uppercase tracking-wider hover:text-foreground"
        onClick={() => setSort({ key: k, desc: on ? !sort.desc : true })}
        title={title}
        data-testid={`screener-head-${k.replace(":", "-")}`}
      >
        {children}
        {on && (sort.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    </th>
  );
}

export function ScreenerTable({
  rows,
  tf,
  filter,
  search = "",
  sector = null,
  flowNote = null,
  rvolMin,
  charted,
  onToggleChart,
  onSolo,
  onOpen,
}: {
  rows: ScreenerRow[];
  tf: Timeframe;
  filter: Filter;
  /** Part of a coin's name; empty is everything. */
  search?: string;
  /** Only this sector's coins; null is every coin. */
  sector?: string | null;
  /** Why a coin has no taker flow, when the run could not read any: said in the empty cell. */
  flowNote?: string | null;
  rvolMin: number;
  charted: Set<string>;
  onToggleChart: (coin: string) => void;
  /** A double click on a name keeps only that coin on the chart. */
  onSolo: (coin: string) => void;
  onOpen: (coin: string) => void;
}) {
  const clicks = useClickOrDouble();
  const [sort, setSort] = useState<Sort>({ key: `rs:${tf}`, desc: true });
  const [lastTf, setLastTf] = useState(tf);
  // The timeframe picker moves the default sort with it, unless a column was chosen by hand.
  if (lastTf !== tf) {
    setLastTf(tf);
    if (sort.key.startsWith("rs:")) setSort({ key: `rs:${tf}`, desc: true });
  }

  const q = search.trim().toLowerCase();
  const shown = useMemo(() => {
    const kept = rows.filter((r) => {
      if (q && !r.coin.toLowerCase().includes(q)) return false;
      if (sector && sectorOf(r.coin) !== sector) return false;
      const f = r.flags[tf];
      if (filter === "candidates") return f.candidate;
      if (filter === "fast") return f.movingFast;
      if (filter === "weakest") return f.weakest;
      if (filter === "diverging") return r.signals?.[tf]?.divergence != null;
      return true;
    });
    const value = (r: ScreenerRow): number | string | null => {
      if (sort.key === "coin") return r.coin;
      if (sort.key === "rvol") return r.tf[tf].rvol;
      if (sort.key === "funding") return r.fundingAnnual;
      if (sort.key === "oi") return r.positioning?.oi1d ?? r.oiChange;
      if (sort.key === "score") return r.signals?.[tf]?.score ?? null;
      if (sort.key === "rsi") return r.price?.[tf]?.rsi ?? null;
      if (sort.key === "cvd") return cvdFor(r.flow, r.spot, tf)?.value ?? null;
      if (sort.key === "rating") return r.strength?.rating ?? null;
      if (sort.key === "alpha") return r.price?.[tf]?.alpha ?? null;
      if (sort.key === "hold") return r.strength?.capture ?? null;
      if (sort.key === "volume") return r.volume24h;
      return r.tf[sort.key.slice(3) as Timeframe].rs;
    };
    const sorted = kept.slice().sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      // Nulls last, whichever way the sort runs.
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const c = typeof va === "string" ? va.localeCompare(String(vb)) : (va as number) - (vb as number);
      return sort.desc ? -c : c;
    });
    // Candidates first when the whole table is shown in its default order: that is what the badge is for.
    // A column chosen by hand sorts plainly, so a click on a header does what it says.
    if (filter === "all" && sort.key === `rs:${tf}` && sort.desc) {
      const cands = sorted.filter((r) => r.flags[tf].candidate);
      const rest = sorted.filter((r) => !r.flags[tf].candidate);
      return [...cands, ...rest];
    }
    return sorted;
  }, [rows, tf, filter, sort, q, sector]);

  if (shown.length === 0) {
    // In the table but filtered out is a different answer from not in the table.
    const elsewhere = q && filter !== "all" ? rows.filter((r) => r.coin.toLowerCase().includes(q)).length : 0;
    return (
      <p className="px-2 py-6 text-center text-xs text-muted-foreground" data-testid="screener-empty">
        {elsewhere ? `"${search.trim()}" is in the table, but not under this filter. Choose All to see it.` : q ? `No coin matching "${search.trim()}" in the table${sector ? ` under ${sector}` : ""}.` : "Nothing here on this timeframe with this filter."}
      </p>
    );
  }

  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[820px] border-separate border-spacing-0 text-xs" data-testid="screener-table">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 w-5 bg-card px-1" />
            <Head sort={sort} setSort={setSort} k="coin" className="sticky left-5 z-10 bg-card text-left">
              Coin
            </Head>
            {TIMEFRAMES.map((t) => (
              <Head sort={sort} setSort={setSort} key={t} k={`rs:${t}`} className={`text-right ${t === tf ? "text-foreground" : ""}`} title={`RS change vs BTC over the last ${t}`}>
                {t}
              </Head>
            ))}
            <Head sort={sort} setSort={setSort} k="rating" className="text-right" title="RS rating, 1–99: the coin's place in the table by RS change, blended over 1D, 1W and 1M. The arrow is the change from a week ago: a coin climbing the ranks.">
              Rtg
            </Head>
            <Head sort={sort} setSort={setSort} k="alpha" className="text-right" title={`Alpha on ${tf}: the coin's move with its BTC beta taken out. A high-beta coin beats BTC on every green day; this is what is left.`}>
              Alpha
            </Head>
            <Head sort={sort} setSort={setSort} k="hold" className="text-right" title="Hold: up capture minus down capture over 14 days of hours. Positive is a coin that gains more on BTC's green hours than it gives back on the red ones.">
              Hold
            </Head>
            <Head sort={sort} setSort={setSort} k="rvol" className="text-right" title={`Relative volume on ${tf}: the last period over the mean of the previous 20`}>
              RVOL
            </Head>
            <Head sort={sort} setSort={setSort} k="funding" className="text-right" title="Current funding, annualized">
              Fund.
            </Head>
            <Head sort={sort} setSort={setSort} k="score" className="text-right" title={`Six independent votes on ${tf}: momentum (RS, its acceleration, RSI and trend as one), alpha, holding up on BTC's red hours, open interest against price, funding crowding, taker flow. Each +1, 0 or −1.`}>
              Signals
            </Head>
            <Head sort={sort} setSort={setSort} k="rsi" className="text-right" title={`RSI 14 on ${tf} candles`}>
              RSI
            </Head>
            <Head sort={sort} setSort={setSort} k="cvd" className="text-right" title={`Taker flow on Binance for ${tf}'s window: net taker buying as a share of volume. The perp's when your relay read it (p), else the spot book's, read by the server (s).`}>
              CVD
            </Head>
            <Head sort={sort} setSort={setSort} k="oi" className="text-right" title="Open interest over the last 24 hours, and what it says against price">
              OI 24h
            </Head>
            <Head sort={sort} setSort={setSort} k="volume" className="text-right hidden sm:table-cell" title="24h notional volume">
              Vol 24h
            </Head>
            <th className="px-1 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Flags</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const m = r.tf[tf];
            const f = r.flags[tf];
            const cvd = cvdFor(r.flow, r.spot, tf);
            const st = r.strength;
            const rose = st?.rating != null && st.ratingWas != null ? st.rating - st.ratingWas : null;
            const alpha = r.price?.[tf]?.alpha ?? null;
            const on = charted.has(r.coin);
            return (
              <tr
                key={r.coin}
                className={`cursor-pointer border-t border-border/40 transition-colors hover:bg-secondary/40 focus-visible:bg-secondary/40 focus-visible:outline-none ${f.candidate ? "bg-emerald-500/5" : ""}`}
                onClick={() => onOpen(r.coin)}
                // A row is opened by keyboard too: Enter on it, as on a button.
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.target === e.currentTarget) onOpen(r.coin);
                }}
                aria-label={`Open ${r.coin}`}
                data-testid={`screener-row-${r.coin}`}
              >
                {/* The whole cell is the dot's target, and a near miss does not open the coin. */}
                <td className={`sticky left-0 z-10 p-0 align-middle ${f.candidate ? CANDIDATE_CELL : "bg-card"}`} onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="group/dot flex h-7 w-5 items-center justify-center"
                    onClick={() => onToggleChart(r.coin)}
                    title={on ? "Take off the chart" : "Put on the chart"}
                    aria-label={on ? `Take ${r.coin} off the chart` : `Put ${r.coin} on the chart`}
                    aria-pressed={on}
                    data-testid={`screener-chart-${r.coin}`}
                  >
                    <span className={`h-3 w-3 rounded-full border transition-colors ${on ? "border-sky-400 bg-sky-400" : "border-border group-hover/dot:border-sky-400"}`} />
                  </button>
                </td>
                <td
                  className={`sticky left-5 z-10 whitespace-nowrap px-1 py-1 font-semibold ${f.candidate ? CANDIDATE_CELL : "bg-card"}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className={`touch-manipulation rounded px-0.5 hover:text-sky-400 ${on ? "text-sky-400" : ""}`}
                    title={on ? "Click to take it off the chart; double-click to keep only it" : "Click to put it on the chart; double-click to keep only it"}
                    {...clicks(r.coin, () => onToggleChart(r.coin), () => onSolo(r.coin))}
                    data-testid={`screener-name-${r.coin}`}
                  >
                    {r.coin}
                  </button>
                  {r.pinned && (
                    <span className="ml-0.5 inline-flex text-muted-foreground" title="Pinned from the search: read whatever its volume. Unpin in the settings." data-testid={`screener-pinned-${r.coin}`}>
                      <Pin className="h-2.5 w-2.5" />
                    </span>
                  )}
                  {r.error && (
                    <span className="ml-1 inline-flex items-center gap-0.5 rounded border border-amber-500/50 px-1 text-[9px] font-medium uppercase text-amber-500" title={r.error} data-testid={`screener-error-${r.coin}`}>
                      <AlertTriangle className="h-2.5 w-2.5" /> err
                    </span>
                  )}
                </td>
                {TIMEFRAMES.map((t) => {
                  const x = r.tf[t];
                  return (
                    <td
                      key={t}
                      className={`whitespace-nowrap px-1 py-1 text-right font-mono ${t === tf ? "font-semibold" : ""}`}
                      style={{ background: heat(x.rs) }}
                      title={x.accel ? `Acceleration: ${ACCEL_ARROW[x.accel]} · ${x.breakout ? "new 20-period high" : "no breakout"}` : undefined}
                    >
                      {fmtPct(x.rs)}
                      {t === tf && x.accel && <span className="ml-0.5 text-[10px] text-foreground/70">{ACCEL_ARROW[x.accel]}</span>}
                      {t === tf && x.breakout && <span className="ml-0.5 text-[9px] text-sky-400" title="New 20-period RS high">▲</span>}
                    </td>
                  );
                })}
                <td
                  className={`whitespace-nowrap px-1 py-1 text-right font-mono ${st?.rating == null ? "text-muted-foreground" : st.rating >= 80 ? "text-emerald-400" : st.rating <= 20 ? "text-red-400" : ""}`}
                  title={st?.rating != null ? `RS rating ${st.rating} of 99${st.ratingWas != null ? `, ${st.ratingWas} a week ago` : ""}` : "No rating: too few bars"}
                  data-testid={`screener-rating-${r.coin}`}
                >
                  {st?.rating ?? "—"}
                  {rose != null && Math.abs(rose) >= 10 && <span className={`ml-0.5 text-[9px] ${rose > 0 ? "text-emerald-400" : "text-red-400"}`}>{rose > 0 ? "▲" : "▼"}{Math.abs(rose)}</span>}
                </td>
                <td className={`whitespace-nowrap px-1 py-1 text-right font-mono ${alpha == null ? "text-muted-foreground" : alpha > 0.003 ? "text-emerald-400" : alpha < -0.003 ? "text-red-400" : ""}`} title={st?.beta != null ? `Beta to BTC ${st.beta.toFixed(2)}` : undefined}>
                  {fmtPct(alpha)}
                </td>
                <td
                  className={`whitespace-nowrap px-1 py-1 text-right font-mono ${st?.capture == null ? "text-muted-foreground" : st.capture > CAPTURE_BAND ? "text-emerald-400" : st.capture < -CAPTURE_BAND ? "text-red-400" : ""}`}
                  title={st?.upCapture != null && st.downCapture != null ? `On BTC's green hours it made ${st.upCapture.toFixed(2)}× BTC's gain; on the red hours it lost ${st.downCapture.toFixed(2)}× BTC's loss` : undefined}
                >
                  {st?.capture == null ? "—" : `${st.capture > 0 ? "+" : "−"}${Math.abs(st.capture).toFixed(2)}`}
                </td>
                <td className={`whitespace-nowrap px-1 py-1 text-right font-mono ${m.rvol != null && m.rvol >= rvolMin ? "text-emerald-400" : ""}`}>{fmtX(m.rvol)}</td>
                <td className={`whitespace-nowrap px-1 py-1 text-right font-mono ${r.fundingAnnual != null && r.fundingAnnual > 0.3 ? "text-amber-500" : ""}`}>{fmtPct(r.fundingAnnual, 0)}</td>
                <td className="whitespace-nowrap px-1 py-1 text-right" title={signalTitle(r, tf)} data-testid={`screener-score-${r.coin}`}>
                  <SignalDots s={r.signals?.[tf]} />
                </td>
                <td className={`whitespace-nowrap px-1 py-1 text-right font-mono ${rsiTone(r.price?.[tf]?.rsi)}`}>{r.price?.[tf]?.rsi != null ? r.price[tf].rsi!.toFixed(0) : "—"}</td>
                <td
                  className={`whitespace-nowrap px-1 py-1 text-right font-mono ${cvd == null ? "text-muted-foreground" : cvd.value > 0.02 ? "text-emerald-400" : cvd.value < -0.02 ? "text-red-400" : ""}`}
                  title={
                    cvd
                      ? `Binance ${cvd.source === "perp" ? "perp" : "spot"} ${cvd.symbol}: net taker buying ${fmtPct(cvd.value)} of volume over ${cvd.window}${r.spot && r.flow ? `; spot 24h ${fmtPct(r.spot.cvd24h)}, perp 24h ${fmtPct(r.flow.cvd24h)}` : ""}`
                      : (flowNote ?? "No Binance spot pair or perp for this coin")
                  }
                  data-testid={`screener-cvd-${r.coin}`}
                >
                  {fmtPct(cvd?.value)}
                  {cvd && <span className="ml-0.5 text-[9px] text-muted-foreground">{cvd.source === "perp" ? "p" : "s"}</span>}
                </td>
                <td className="whitespace-nowrap px-1 py-1 text-right font-mono" title={r.positioning?.read ? OI_READ[r.positioning.read] : undefined}>
                  {fmtPct(r.positioning?.oi1d ?? r.oiChange)}
                  {r.positioning?.read && <span className={`ml-1 text-[9px] ${OI_TONE[r.positioning.read]}`}>{OI_SHORT[r.positioning.read]}</span>}
                </td>
                <td className="hidden whitespace-nowrap px-1 py-1 text-right font-mono sm:table-cell">{fmtUsd(r.volume24h)}</td>
                <td className="whitespace-nowrap px-1 py-1">
                  <span className="inline-flex gap-1">
                    {f.candidate && <Flag tone="emerald" testId={`screener-candidate-${r.coin}`} title="Candidate: top 10% and accelerating, with volume, not leverage-driven">Cand</Flag>}
                    {f.movingFast && !f.candidate && <Flag tone="sky" title="Moving fast: top 10% by RS and accelerating">Fast</Flag>}
                    {f.volumeConfirmed && <Flag tone="muted" title="Volume-confirmed">Vol</Flag>}
                    {r.leverageDriven && <Flag tone="amber" title="Leverage-driven: top-decile funding with open interest jumping">Lev</Flag>}
                    {f.weakest && <Flag tone="red" title="Weakest: bottom 10% by RS">Weak</Flag>}
                    {r.signals?.[tf]?.divergence === "bearish" && <Flag tone="red" title="Bearish divergence: price at a high that RS or RSI does not confirm">Bear</Flag>}
                    {r.signals?.[tf]?.divergence === "bullish" && <Flag tone="emerald" title="Bullish divergence: price at a low while RS or RSI holds up">Bull</Flag>}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const OI_READ = {
  "new-longs": "Price up, open interest up: new longs opening",
  "short-covering": "Price up, open interest down: shorts covering, not new demand",
  "new-shorts": "Price down, open interest up: new shorts opening",
  "longs-out": "Price down, open interest down: longs closing",
} as const;
const OI_SHORT = { "new-longs": "L+", "short-covering": "SC", "new-shorts": "S+", "longs-out": "L−" } as const;
const OI_TONE = { "new-longs": "text-emerald-400", "short-covering": "text-sky-400", "new-shorts": "text-red-400", "longs-out": "text-amber-500" } as const;

const rsiTone = (x: number | null | undefined) => (x == null ? "" : x >= 70 ? "text-amber-500" : x <= 30 ? "text-sky-400" : "");

/** The six votes the score sums. Momentum is RS, its acceleration, RSI and trend taken as one. */
export const SIGNAL_NAMES = [
  ["momentum", "Momentum (RS, accel, RSI, trend)"],
  ["alpha", "Alpha (beta taken out)"],
  ["resilience", "Holds on BTC's red hours"],
  ["oi", "Open interest vs price"],
  ["funding", "Funding crowding"],
  ["cvd", "Taker flow (CVD)"],
] as const;

/** What momentum is made of: shown, not summed apiece. */
export const MOMENTUM_PARTS = [
  ["rs", "RS vs BTC"],
  ["accel", "RS acceleration"],
  ["rsi", "RSI"],
  ["trend", "Trend (20/50 average)"],
] as const;

/** A run stored before the score was rebuilt has the old seven readings and none of the new votes: read as it was. */
const votesOf = (s: NonNullable<ScreenerRow["signals"][Timeframe]>) => SIGNAL_NAMES.map(([k]) => (s[k] ?? 0) as number);

function signalTitle(r: ScreenerRow, tf: Timeframe): string {
  const s = r.signals?.[tf];
  if (!s) return "";
  const sign = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "·");
  return SIGNAL_NAMES.map(([k, name]) => `${sign(s[k] ?? 0)} ${name}`).join("\n") + (s.divergence ? `\n${s.divergence === "bearish" ? "Bearish" : "Bullish"} divergence` : "");
}

/** Six dots, one per reading, and their sum. */
export function SignalDots({ s }: { s?: ScreenerRow["signals"][Timeframe] }) {
  if (!s) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-flex gap-px">
        {votesOf(s).map((v, i) => (
          <span key={SIGNAL_NAMES[i][0]} className={`inline-block h-1.5 w-1.5 rounded-full ${v > 0 ? "bg-emerald-400" : v < 0 ? "bg-red-400" : "bg-muted-foreground/30"}`} />
        ))}
      </span>
      <span className={`w-6 text-right font-mono text-[11px] font-semibold ${s.score >= 3 ? "text-emerald-400" : s.score <= -3 ? "text-red-400" : "text-foreground/80"}`}>
        {s.score > 0 ? `+${s.score}` : s.score}
      </span>
    </span>
  );
}

function Flag({ tone, children, testId, title }: { tone: "emerald" | "sky" | "amber" | "red" | "muted"; children: React.ReactNode; testId?: string; title?: string }) {
  const cls = {
    emerald: "border-emerald-500/60 bg-emerald-500/15 text-emerald-400",
    sky: "border-sky-500/50 bg-sky-500/10 text-sky-400",
    amber: "border-amber-500/50 bg-amber-500/10 text-amber-500",
    red: "border-red-500/50 bg-red-500/10 text-red-400",
    muted: "border-border text-muted-foreground",
  }[tone];
  return (
    <span className={`whitespace-nowrap rounded border px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${cls}`} data-testid={testId} title={title}>
      {children}
    </span>
  );
}
