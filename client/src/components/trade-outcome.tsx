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
import { Button } from "@/components/ui/button";
import { EXIT_REASON_LABELS, EXIT_TIMING_MEANINGFUL_R, exitTimingVerdict } from "@shared/metrics";
import { gradeLabel } from "@shared/grades";
import { EXIT_REASONS, FormSection, TimeField } from "@/components/trade-shared";
import { GradePicker, type GradeState } from "@/components/grade-picker";
import { HighlightPicker } from "@/components/trade-pickers";
import type { MistakeTag } from "@shared/schema";

import { LevelLabel, PathBands } from "@/components/levels";
import { Activity, Gavel, LogOut } from "lucide-react";

const LABEL = "text-[10px] uppercase tracking-wider text-muted-foreground";

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
  };
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
  const { priced, explained } = outcomeStage(p.exitPrice, p.exitReason);
  const path = pathQuestions(p.exitPrice, p.live === true);

  /**
   * The arithmetic reading of this exit, from the form's own fields.
   *
   * Both legs clamp at zero: MFE below the exit or a post-exit peak on the
   * wrong side mean "that cost was nothing", never negative. Null legs stay
   * null — an unmeasured leg is not a zero-cost leg, and the verdict function
   * knows the difference.
   */
  const timingRead = (() => {
    if (!p.timing) return null;
    const { direction, entryPrice, initialStop } = p.timing;
    const exit = Number(p.exitPrice);
    if (entryPrice == null || initialStop == null || !isFinite(exit)) return null;
    const risk = Math.abs(entryPrice - initialStop);
    if (!(risk > 0)) return null;
    const sign = direction === "short" ? -1 : 1;
    const leg = (raw: string) => {
      const v = Number(raw);
      return raw.trim() !== "" && isFinite(v) ? Math.max(0, (sign * (v - exit)) / risk) : null;
    };
    return exitTimingVerdict(leg(p.mfe), leg(p.postExitPeak));
  })();

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
   * Whether "your read" has been answered, and what it says.
   *
   * The exit axis does not apply to a stop-out — a trade that hit its stop
   * never went near its target, so an ungraded exit there is a question that
   * does not arise, not one you skipped. Folding on "all three answered"
   * would leave every stopped-out trade permanently open on a question it
   * cannot be asked; axisApplies is the same rule the statistics use.
   */
  const wantsExitGrade = p.exitReason !== "stop";
  const graded =
    p.grades.entry != null &&
    p.grades.stop != null &&
    (!wantsExitGrade || p.grades.exit != null);
  const gradeSummary = (() => {
    const said = (
      [
        ["entry", p.grades.entry],
        ["stop", p.grades.stop],
        ["exit", wantsExitGrade ? p.grades.exit : null],
      ] as const
    )
      .map(([axis, g]) => (g ? `${axis} ${gradeLabel(axis, g)?.toLowerCase()}` : null))
      .filter(Boolean);
    const extras = [
      p.demonIds.length ? `${p.demonIds.length} demon${p.demonIds.length === 1 ? "" : "s"}` : null,
      p.highlights.length ? `${p.highlights.length} green flag${p.highlights.length === 1 ? "" : "s"}` : null,
    ].filter(Boolean);
    return [...said, ...extras].join(" · ") || "not graded yet";
  })();

  const toggleDemon = (id: number) =>
    p.setDemonIds(
      p.demonIds.includes(id) ? p.demonIds.filter((x) => x !== id) : [...p.demonIds, id],
    );

  return (
    <div className="space-y-5" data-testid={`section-outcome-${p.testPrefix}`}>
      <FormSection
        icon={LogOut}
        title="The exit"
        hint="where and when you actually got out"
        testId={`section-${p.testPrefix}-exit`}
        tone="exit"
      >
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          {/* The fourth decision, marked like the other three. */}
          <LevelLabel kind="exit" text="Exit price" />
          <Input
            type="number"
            step="any"
            inputMode="decimal"
            value={p.exitPrice}
            onChange={(e) => p.setExitPrice(e.target.value)}
            className="h-9 font-mono text-sm"
            data-testid={`input-${p.testPrefix}-exit-price`}
          />
        </div>
        <TimeField
          label="Exit time"
          value={p.exitTime}
          onChange={p.setExitTime}
          testId={`input-${p.testPrefix}-exit-time`}
        />
      </div>

      {p.exitExtra}

      {/* ---- stage 2: facts about the close ---- */}
      {priced && (
        <>
          <div>
            <p className={`mb-1.5 ${LABEL}`}>How did it end?</p>
            <div className="flex flex-wrap gap-1.5">
              {EXIT_REASONS.map((r) => (
                <Button
                  key={r}
                  type="button"
                  size="sm"
                  variant={p.exitReason === r ? "default" : "outline"}
                  className="h-8 text-[11px]"
                  onClick={() => {
                    if (p.exitReason === r) p.setExitReason(null);
                    else if (p.onPickReason) p.onPickReason(r);
                    else p.setExitReason(r);
                  }}
                  data-testid={`button-${p.testPrefix}-exit-${r}`}
                >
                  {EXIT_REASON_LABELS[r]}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <label className={LABEL}>Fees $ (both sides · optional — R and P&L go net)</label>
            <Input
              type="number"
              step="any"
              inputMode="decimal"
              value={p.fees}
              onChange={(e) => p.setFees(e.target.value)}
              className="h-9 font-mono text-sm"
              data-testid={`input-${p.testPrefix}-fees`}
            />
            {!!p.feeChips?.length && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {p.feeChips.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    onClick={() => p.setFees(String(c.amount))}
                    className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-primary/40 hover:text-foreground"
                    data-testid={`chip-${p.testPrefix}-fee-${c.label}`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      </FormSection>

      {/*
        Shown while the trade is still running too, with only the half that
        makes sense: how far it has gone either way is knowable now, and it is
        the number most likely to be lost by tomorrow. What happened AFTER the
        exit needs an exit to be after.
      */}
      {path.held && (
        <FormSection
          icon={Activity}
          title={priced ? "What price did" : "What price has done"}
          hint={
            priced
              ? "how far it went with you, and how far without you"
              : "how far it has gone either way, so far"
          }
          testId={`section-${p.testPrefix}-path`}
          tone="path"
        >
        <>
          {/*
            Four prices, two questions, one row.

            They were two stacked grids with a caption between them and a
            three-line explainer under each of the bottom pair — around 260px
            of form for four numbers. The split is real and worth keeping (in
            the trade is what you lived through, after the exit is what you
            missed), so it survives as two labelled boxes side by side rather
            than as two rows: same grouping, half the height, and the pairing
            is now something you SEE instead of something a caption asserts.

            Adverse left, favourable right, in both boxes — the same way round
            as the bands below and as every R in the app.
          */}
          <div className={`grid gap-2.5 ${path.after ? "sm:grid-cols-2" : ""}`}>
            {[
              {
                key: "in" as const,
                /* Past tense only once it is past. On a running trade this is
                   a live reading, and calling it "while you were in" reads as
                   a question about a trade that is over. */
                title: priced ? "While you were in" : "So far, in the trade",
                left: {
                  kind: "mae" as const,
                  text: priced ? "Worst held" : "Worst so far",
                  value: p.mae,
                  set: p.setMae,
                  id: "mae",
                },
                right: {
                  kind: "mfe" as const,
                  text: priced ? "Best held" : "Best so far",
                  value: p.mfe,
                  set: p.setMfe,
                  id: "mfe",
                },
              },
              // What happened after the exit needs an exit to be after.
              ...(path.after
                ? [
                    {
                      key: "after" as const,
                      title: "Once you were out",
                      left: {
                        kind: "fellAfter" as const,
                        text: "Fell to",
                        value: p.postExitAdverse,
                        set: p.setPostExitAdverse,
                        id: "post-exit-adverse",
                      },
                      right: {
                        kind: "ranAfter" as const,
                        text: "Ran on to",
                        value: p.postExitPeak,
                        set: p.setPostExitPeak,
                        id: "post-exit-peak",
                      },
                    },
                  ]
                : []),
            ].map((group) => (
              <div
                key={group.key}
                className="space-y-1.5 rounded-lg border border-border/60 bg-secondary/20 px-2.5 py-2"
                data-testid={`group-${p.testPrefix}-path-${group.key}`}
              >
                <p className={LABEL}>{group.title}</p>
                <div className="grid grid-cols-2 gap-2.5">
                  {[group.left, group.right].map((fld) => (
                    <div key={fld.id} className="space-y-1">
                      <LevelLabel kind={fld.kind} text={fld.text} />
                      <Input
                        type="number"
                        step="any"
                        inputMode="decimal"
                        value={fld.value}
                        onChange={(e) => fld.set(e.target.value)}
                        className="h-9 font-mono text-sm"
                        data-testid={`input-${p.testPrefix}-${fld.id}`}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* The pair on the right is the half a journal usually never asks
              for, so it gets the one line of explanation the four boxes no
              longer carry each. Both directions, deliberately: a form that
              only ever asks how much further it ran can only ever conclude
              "hold longer". */}
          <p className="text-[10px] leading-snug text-muted-foreground">
            {priced ? (
              <>
                After you were out, both ways — one prices what leaving cost you, the other what
                it saved you. On a stop-out, "fell to" is what the stop was worth.
              </>
            ) : (
              <>
                Worth writing down now rather than reconstructing later — the high and the low
                this position has seen are what decide whether the exit was early or late, and
                they are hardest to recover once the chart has moved on.
              </>
            )}
          </p>

          <div className="space-y-1">
            {/* The two ranges on one axis, which is where the comparison
                lives: "it did most of its work after I left" and "I sat
                through the whole move and took the middle" are different
                problems with different fixes, and four numbers in four boxes
                say neither out loud. */}
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

            {stopRead && (
              <p
                className={`pt-0.5 text-[11px] leading-snug ${
                  stopRead.tone === "good"
                    ? "text-emerald-500"
                    : stopRead.tone === "bad"
                      ? "text-amber-500"
                      : "text-muted-foreground"
                }`}
                data-testid={`text-${p.testPrefix}-stop-read`}
              >
                {stopRead.text}
              </p>
            )}
          </div>

          {/* Which level the untouched plan would have reached first is a
              question about a finished trade. On a running one it has not
              happened yet, and answering it early would be a forecast getting
              stored as a fact. */}
          {path.after && (
          <div>
            <p className={`mb-1.5 ${LABEL}`}>Untouched plan would have hit…</p>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["target_first", "Target first"],
                  ["stop_first", "Stop first"],
                  ["undetermined", "Undetermined"],
                ] as const
              ).map(([id, label]) => (
                <Button
                  key={id}
                  type="button"
                  size="sm"
                  variant={p.nmo === id ? "default" : "outline"}
                  className="h-8 text-[11px]"
                  onClick={() => p.setNmo(p.nmo === id ? null : id)}
                  data-testid={`button-${p.testPrefix}-nmo-${id}`}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          )}
        </>
        </FormSection>
      )}

      {/* ---- stage 3: judgements about those facts ---- */}
      {explained && (
        <FormSection
          icon={Gavel}
          title="Your read"
          hint="what you make of all that"
          testId={`section-${p.testPrefix}-read`}
          tone="read"
          collapsible
          /* Open while there is something to answer; folded once it has been
             answered, with the answer in the header. Re-reading a trade you
             already graded should not cost you four rows of buttons. */
          defaultOpen={!graded}
          summary={gradeSummary}
        >
        <>
          {/* What the numbers say, right where the grade is picked. The grade
              stays yours — but a post-exit run typed into MFE flips "early"
              into "late", and the cheapest moment to catch that is while both
              answers are on the same screen. */}
          {timingRead && (
            <p
              className={`rounded-md border px-2.5 py-1.5 text-[11px] leading-snug ${
                timingRead.verdict === "clean"
                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-400"
                  : "border-amber-500/30 bg-amber-500/5 text-amber-500"
              }`}
              data-testid={`text-${p.testPrefix}-timing-read`}
            >
              {timingRead.verdict === "early" &&
                `Numbers read this exit as EARLY — it ran another ${timingRead.leftBehindR!.toFixed(1)}R after you left${
                  (timingRead.giveBackR ?? 0) > 0.05
                    ? ` (and ${timingRead.giveBackR!.toFixed(1)}R was given back before it)`
                    : ""
                }.`}
              {timingRead.verdict === "late" &&
                `Numbers read this exit as LATE — it reached ${timingRead.giveBackR!.toFixed(1)}R above your exit while you were in and came back.`}
              {timingRead.verdict === "clean" &&
                "Numbers read this exit as clean — nothing meaningful given back or left behind."}
              {timingRead.verdict !== "clean" &&
                p.grades.exit != null &&
                p.grades.exit !== timingRead.verdict && (
                  <span className="font-semibold">
                    {" "}Your grade says {gradeLabel("exit", p.grades.exit)?.toLowerCase()} — one of
                    the two is wrong.
                  </span>
                )}
            </p>
          )}

          <GradePicker
            value={p.grades}
            onChange={p.setGrades}
            testPrefix={`grade-${p.testPrefix}`}
            exitReason={p.exitReason}
          />

          <div>
            <p className={`mb-1.5 ${LABEL}`}>Demons on this trade</p>
            <div className="flex flex-wrap gap-1.5">
              {p.demons.map((d) => {
                const on = p.demonIds.includes(d.id);
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => toggleDemon(d.id)}
                    data-testid={`chip-${p.testPrefix}-demon-${d.id}`}
                    className={`rounded-full border px-2.5 py-1 text-[11px] leading-tight transition-colors ${
                      on
                        ? "border-primary/60 bg-primary/15 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                    }`}
                  >
                    {d.name}
                  </button>
                );
              })}
            </div>
          </div>

          <HighlightPicker
            selected={p.highlights}
            onToggle={(h) =>
              p.setHighlights(
                p.highlights.includes(h)
                  ? p.highlights.filter((x) => x !== h)
                  : [...p.highlights, h],
              )
            }
            extra={(p.extraHighlights ?? []).filter((h) => !p.highlights.includes(h))}
            testIdPrefix={`highlight-${p.testPrefix}`}
          />
        </>
        </FormSection>
      )}

      {!priced && (
        <p className="text-[10px] leading-snug text-muted-foreground">
          Put in an exit price to record how it ended and grade it.
        </p>
      )}
    </div>
  );
}
