/**
 * Everything a trade only has once it is over — asked in one place, in the
 * order the answers actually become knowable.
 *
 * This used to be written twice: the entry card gated it behind "already
 * closed", and the editor rendered it unconditionally. So opening an OPEN
 * trade to correct its stop also asked you to grade an exit that had not
 * happened, offered "hit target / stopped out" for a position still running,
 * and listed demons for a trade with no outcome yet. One rule in one of two
 * places is the same as no rule.
 *
 * The staging follows the split the rest of the app already uses:
 *
 *   1. HOW IT ENDED — exit price and time. This IS closing the trade, so it
 *      is always offered; typing a price is the act.
 *   2. WHAT HAPPENED — reason, fees, excursion, the untouched-plan verdict.
 *      Facts about the close. They need an exit to be about.
 *   3. HOW IT WENT — grades, demons, green flags. Judgements ABOUT those
 *      facts, so they need the facts first: "was that exit late" is not a
 *      question until there is an exit and a reason it happened.
 *
 * Nothing is hidden that you could meaningfully answer, and nothing is asked
 * that you could not.
 */
import { Input } from "@/components/ui/input";
import { EXIT_TIMING_MEANINGFUL_R } from "@shared/metrics";
import { FormSection, LABEL_ROW, Segmented, TimeField } from "@/components/trade-shared";
import type { GradeState } from "@/components/grade-picker";
import type { MistakeTag } from "@shared/schema";

import { LevelLabel, PathBands } from "@/components/levels";
import { LogOut } from "lucide-react";
import { aftermathWindowMs } from "@shared/aftermath";

const LABEL = "text-[10px] uppercase tracking-wider text-muted-foreground";

/** "2 hours", "3 days" — how long a trade's aftermath window runs. */
function fmtWindow(ms: number): string {
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.round(hours / 24)} days`;
}

/** An empty box is not a price of zero. */
const numOrNull = (v: string) => {
  const t = (v ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export interface OutcomeFieldsProps {
  exitPrice: string;
  setExitPrice: (v: string) => void;
  exitTime: string;
  setExitTime: (v: string) => void;
  exitReason: string | null;
  setExitReason: (v: string | null) => void;
  mae: string;
  setMae: (v: string) => void;
  mfe: string;
  setMfe: (v: string) => void;
  postExitPeak: string;
  setPostExitPeak: (v: string) => void;
  postExitAdverse: string;
  setPostExitAdverse: (v: string) => void;
  nmo: string | null;
  setNmo: (v: string | null) => void;
  fees: string;
  setFees: (v: string) => void;
  grades: GradeState;
  setGrades: (g: GradeState) => void;
  demons: MistakeTag[];
  demonIds: number[];
  setDemonIds: (ids: number[]) => void;
  highlights: string[];
  setHighlights: (h: string[]) => void;
  /** Custom green flags already in use elsewhere in the journal. */
  extraHighlights?: string[];
  /** One-click fee suggestions from the account's schedule, when it has one. */
  feeChips?: { label: string; amount: number }[];
  /**
   * The position is still open.
   *
   * Everything else in this form needs an exit to be about — but how far
   * price has gone with you and against you is knowable while the trade is
   * running, and it is the number you most want to write down before you
   * forget it. Gating the excursion pair behind an exit price meant a live
   * trade had nowhere to record its own high, which is exactly backwards:
   * that is the trade you are still watching.
   */
  live?: boolean;
  testPrefix: string;
  /**
   * Rendered inside the exit tile, under the price and time.
   *
   * The average-close solver used to float above this whole component as a
   * loose panel. It writes the exit price and disambiguates what that field
   * means, so it belongs in the box with it — a helper for a field, sitting
   * outside the section that field is in, reads as an unrelated warning.
   */
  exitExtra?: React.ReactNode;
  /** Prefills a price when a reason implies one ("stopped out" => the stop). */
  onPickReason?: (reason: string) => void;
  /**
   * Enough of the plan to turn the excursion fields into R, so the form can
   * say what the numbers think of the exit while it is being graded — the
   * moment a mislog is cheapest to catch.
   */
  timing?: {
    direction: "long" | "short";
    entryPrice: number | null;
    initialStop: number | null;
    initialTarget?: number | null;
  };
  /**
   * How it ended, in the trader's words. Read into the fields below when
   * the box is left; the pickers stay one click away to correct a reading.
   * Without a setter the form is the pickers, as it was.
   */
  note?: string;
  setNote?: (v: string) => void;
  /** The market measures the path for this instrument after the save, so the boxes fold away. */
  autoPath?: boolean;
  /** A read is in flight — parents hold the save until it lands. */
  onReading?: (busy: boolean) => void;
  /** The execution verdict: waited for it, sized it, left it alone. */
  wellTraded?: boolean;
  setWellTraded?: (v: boolean) => void;
  /** Set on a tilt trade, which can never also be traded well. */
  tilt?: boolean;
  /** For the line saying when the archive will have the aftermath. */
  entryTime?: string;
}

/**
 * How far into the outcome the trade has got — the rule, on its own, so it can
 * be tested and cannot quietly differ between the two surfaces that use it.
 *
 *   priced    — there is an exit, so the facts about it are answerable
 *   explained — and a reason for it, so judgements about it are answerable
 */
export function outcomeStage(
  exitPrice: string,
  exitReason: string | null,
): { priced: boolean; explained: boolean } {
  const t = exitPrice.trim();
  // "abc" and "" are both "no exit yet"; 0 is a real price on a spread.
  const priced = t !== "" && isFinite(Number(t));
  return { priced, explained: priced && exitReason != null };
}

/**
 * Which halves of "what price did" the trade can answer.
 *
 * The two are not the same question and they became knowable at different
 * times, which is the whole reason this exists as a rule rather than as one
 * `priced &&` around both. How far a position has run either way is readable
 * off the chart while it is still open — and is the number most easily lost
 * by tomorrow. What happened AFTER the exit needs an exit to be after.
 *
 * Gating both on the exit price meant an open trade had nowhere to record its
 * own high: the field existed on the read-only view and vanished the moment
 * you opened the editor to type into it.
 */
export function pathQuestions(
  exitPrice: string,
  live: boolean,
): { held: boolean; after: boolean } {
  const { priced } = outcomeStage(exitPrice, null);
  return { held: priced || live, after: priced };
}

export type Lifecycle = "pending" | "open" | "closed";

/**
 * Reconcile the lifecycle you picked with the exit price you typed.
 *
 * The two can contradict each other, and silently preferring one is how a
 * trade ends up closed with no exit (every metric reads nothing) or open with
 * an exit price sitting on it (invisible to every closed-trade statistic).
 * Neither state is reachable through this: the contradiction is reported and
 * the save is refused, so the trader decides which half they meant.
 */
export function resolveLifecycle(
  picked: Lifecycle,
  exitPrice: string,
): { status: Lifecycle } | { error: string } {
  const { priced } = outcomeStage(exitPrice, null);
  if (picked === "closed" && !priced) {
    return { error: "A closed trade needs an exit price — or mark it open again." };
  }
  if (picked !== "closed" && priced) {
    return {
      error: `Clear the exit price to mark this ${picked === "pending" ? "waiting to fill" : "open"}.`,
    };
  }
  return { status: picked };
}

export function TradeOutcomeFields(p: OutcomeFieldsProps) {
  const { priced } = outcomeStage(p.exitPrice, p.exitReason);
  const path = pathQuestions(p.exitPrice, p.live === true);

  /**
   * What the stop did, said at the moment of logging.
   *
   * Only for stop-outs, and only once the aftermath is written down — it is
   * the one read in this form that can come out in the exit's favour, and
   * offering it on a discretionary close would be flattery rather than
   * information. Saving R outranks the recovery: money the stop kept is
   * banked, the comeback is a counterfactual a wider stop would have had to
   * sit through.
   */
  const stopRead = (() => {
    if (!p.timing || p.exitReason !== "stop") return null;
    const { direction, entryPrice, initialStop } = p.timing;
    const exit = Number(p.exitPrice);
    if (entryPrice == null || initialStop == null || !isFinite(exit)) return null;
    const risk = Math.abs(entryPrice - initialStop);
    if (!(risk > 0)) return null;
    const sign = direction === "short" ? -1 : 1;
    const num = (raw: string) => {
      const v = Number(raw);
      return raw.trim() !== "" && isFinite(v) ? v : null;
    };
    const worse = num(p.postExitAdverse);
    const back = num(p.postExitPeak);
    const saved = worse != null ? Math.max(0, (sign * (exit - worse)) / risk) : null;
    const came = back != null ? Math.max(0, (sign * (back - exit)) / risk) : null;
    if (saved == null && came == null) return null;
    if (saved != null && saved >= EXIT_TIMING_MEANINGFUL_R) {
      return { tone: "good" as const, text: `The stop saved ${saved.toFixed(1)}R — it kept going.` };
    }
    if (came != null && came >= EXIT_TIMING_MEANINGFUL_R) {
      return {
        tone: "bad" as const,
        text: `Wicked out: barely went further, then came back ${came.toFixed(1)}R without you.`,
      };
    }
    return { tone: "flat" as const, text: "Stop was about right — it went nowhere either way." };
  })();

  /*
   * The four prices are named by direction. "Highest" is the best a long
   * saw and the worst a short did; a form that says "fell to" on a short
   * has the sign backwards, and the sign is the whole question.
   */
  const short = p.timing?.direction === "short";
  const hi = short ? "highest" : "lowest";
  const lo = short ? "lowest" : "highest";

  /** A price box with a coloured label, the same everywhere in this block. */
  const box = (kind: Parameters<typeof LevelLabel>[0]["kind"], text: string, value: string, set: (v: string) => void, id: string, title?: string) => (
    <div className="min-w-0 space-y-1" title={title}>
      <LevelLabel kind={kind} text={text} />
      <Input
        type="number"
        step="any"
        inputMode="decimal"
        value={value}
        onChange={(e) => set(e.target.value)}
        className="h-8 font-mono text-sm"
        data-testid={`input-${p.testPrefix}-${id}`}
      />
    </div>
  );

  /*
   * One block, read left to right: where you got out, then how far price
   * went against you and with you while you held. Once there is an exit,
   * what it cost and what it did after you were out sit in the row under it.
   * The explanations that used to run under each box live in the labels'
   * tooltips — the boxes are the same four questions every time.
   */
  return (
    <div className="space-y-3" data-testid={`section-outcome-${p.testPrefix}`}>
      <FormSection
        icon={LogOut}
        title={priced ? "Exit & price path" : "Exit & price so far"}
        hint={
          priced
            ? "where you got out, and how far price went either way while you held and after"
            : "type an exit price to close it; the high and low so far are worth writing down now"
        }
        testId={`section-${p.testPrefix}-exit`}
        tone="exit"
      >
        <div className="grid grid-cols-2 items-start gap-x-3 gap-y-2.5 sm:grid-cols-4" data-testid={`section-${p.testPrefix}-path`}>
          <div className="min-w-0 space-y-1">
            <LevelLabel kind="exit" text="Exit price" />
            <Input
              type="number"
              step="any"
              inputMode="decimal"
              value={p.exitPrice}
              onChange={(e) => p.setExitPrice(e.target.value)}
              className="h-8 font-mono text-sm"
              data-testid={`input-${p.testPrefix}-exit-price`}
            />
          </div>
          <TimeField
            label="Exit time"
            value={p.exitTime}
            onChange={p.setExitTime}
            testId={`input-${p.testPrefix}-exit-time`}
          />
          {path.held && (
            <>
              {box("mae", `${priced ? "Worst while in" : "Worst so far"} · ${hi}`, p.mae, p.setMae, "mae", "How far it went against you while you held — MAE.")}
              {box("mfe", `${priced ? "Best while in" : "Best so far"} · ${lo}`, p.mfe, p.setMfe, "mfe", "How far it went your way while you held — MFE.")}
            </>
          )}
          {priced && (
            <>
              {/* Last on a phone, so the after-exit pair sits under the in-trade pair. */}
              <div className="order-last min-w-0 space-y-1 sm:order-none" title="Both sides, in dollars. R and P&L go net of it.">
                <label className={`${LABEL} ${LABEL_ROW}`}>Fees</label>
                <Input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={p.fees}
                  onChange={(e) => p.setFees(e.target.value)}
                  className="h-8 font-mono text-sm"
                  data-testid={`input-${p.testPrefix}-fees`}
                />
                {!!p.feeChips?.length && (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {p.feeChips.map((c) => (
                      <button
                        key={c.label}
                        type="button"
                        onClick={() => p.setFees(String(c.amount))}
                        className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-primary/40 hover:text-foreground"
                        data-testid={`chip-${p.testPrefix}-fee-${c.label}`}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span className="hidden sm:block" />
              {box(
                "fellAfter",
                "After: against",
                p.postExitAdverse,
                p.setPostExitAdverse,
                "post-exit-adverse",
                `Once you were out: how far it turned against you (the ${hi} price). On a stop-out, what the stop saved you.`,
              )}
              {box(
                "ranAfter",
                "After: your way",
                p.postExitPeak,
                p.setPostExitPeak,
                "post-exit-peak",
                `Once you were out: how far it kept going your way (the ${lo} price), before the stop level broke. What leaving cost you.`,
              )}
            </>
          )}
        </div>

        {p.exitExtra}

        {path.held && (
          <PathBands
            direction={p.timing?.direction ?? "long"}
            entry={p.timing?.entryPrice ?? null}
            stop={p.timing?.initialStop ?? null}
            exit={numOrNull(p.exitPrice)}
            mae={numOrNull(p.mae)}
            mfe={numOrNull(p.mfe)}
            postExitPeak={numOrNull(p.postExitPeak)}
            postExitAdverse={numOrNull(p.postExitAdverse)}
          />
        )}
        {/* What the plan would have done if left alone — a fact about the
            market once the trade is over, so it is logged here with the exit
            rather than read out of the note. "Ask the market" can fill it. */}
        {path.after && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid={`group-${p.testPrefix}-nmo`}>
            <span className={LABEL} title="If you had left the stop and target untouched, which would price have reached first?">
              Untouched plan hit
            </span>
            {/* Clicking the chosen answer again takes it back: "I don't know" is an answer too. */}
            <Segmented
              size="sm"
              value={p.nmo as "target_first" | "stop_first" | "undetermined" | null}
              onChange={(id) => p.setNmo(p.nmo === id ? null : id)}
              ariaLabel="Untouched plan hit"
              options={[
                { id: "target_first", label: "Target first", tone: "text-emerald-400", testId: `button-${p.testPrefix}-nmo-target_first` },
                { id: "stop_first", label: "Stop first", tone: "text-red-400", testId: `button-${p.testPrefix}-nmo-stop_first` },
                { id: "undetermined", label: "Neither yet", testId: `button-${p.testPrefix}-nmo-undetermined` },
              ]}
            />
          </div>
        )}
        {stopRead && (
          <p
            className={`text-[11px] leading-snug ${
              stopRead.tone === "good" ? "text-emerald-500" : stopRead.tone === "bad" ? "text-amber-500" : "text-muted-foreground"
            }`}
            data-testid={`text-${p.testPrefix}-stop-read`}
          >
            {stopRead.text}
          </p>
        )}
        {p.autoPath && priced && (
          <p className="text-[10px] text-muted-foreground" data-testid={`text-${p.testPrefix}-auto-path`}>
            Blank path prices are filled from the market
            {p.entryTime
              ? ` — the after-exit pair about ${fmtWindow(aftermathWindowMs({ entryTime: p.entryTime, exitTime: p.exitTime }))} after the exit.`
              : "."}
          </p>
        )}
      </FormSection>
    </div>
  );
}
