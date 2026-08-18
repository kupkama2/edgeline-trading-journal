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
import { EXIT_REASON_LABELS } from "@shared/metrics";
import { EXIT_REASONS, TimeField } from "@/components/trade-shared";
import { GradePicker, type GradeState } from "@/components/grade-picker";
import { HighlightPicker } from "@/components/trade-pickers";
import type { MistakeTag } from "@shared/schema";

const LABEL = "text-[10px] uppercase tracking-wider text-muted-foreground";

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
  testPrefix: string;
  /** Prefills a price when a reason implies one ("stopped out" => the stop). */
  onPickReason?: (reason: string) => void;
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
 * What the trade's status becomes after an edit.
 *
 * Closing is editing now, so the editor has to do what the close dialog used
 * to: an exit price IS the trade being over. Without this the editor happily
 * saved an exit, a reason and a grade onto a trade that stayed "open" — every
 * number correct, the trade still sitting in the open list, and excluded from
 * every closed-trade statistic in the app.
 *
 * The inverse matters too. Clearing the exit price off a closed trade puts it
 * back to open, because "closed with no exit" is not a state the metrics can
 * read — better to reopen it than to keep a row that quietly computes nothing.
 * A pending order with no exit stays pending; one WITH an exit filled and
 * finished, so it closes like anything else.
 */
export function statusAfterEdit(
  current: string,
  exitPrice: string,
): "pending" | "open" | "closed" {
  if (outcomeStage(exitPrice, null).priced) return "closed";
  if (current === "closed") return "open";
  return current === "pending" ? "pending" : "open";
}

export function TradeOutcomeFields(p: OutcomeFieldsProps) {
  const { priced, explained } = outcomeStage(p.exitPrice, p.exitReason);

  const toggleDemon = (id: number) =>
    p.setDemonIds(
      p.demonIds.includes(id) ? p.demonIds.filter((x) => x !== id) : [...p.demonIds, id],
    );

  return (
    <div className="space-y-3" data-testid={`section-outcome-${p.testPrefix}`}>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className={LABEL}>Exit price</label>
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

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className={LABEL}>MAE (worst price)</label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={p.mae}
                onChange={(e) => p.setMae(e.target.value)}
                className="h-9 font-mono text-sm"
                data-testid={`input-${p.testPrefix}-mae`}
              />
            </div>
            <div className="space-y-1">
              <label className={LABEL}>MFE (best price)</label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={p.mfe}
                onChange={(e) => p.setMfe(e.target.value)}
                className="h-9 font-mono text-sm"
                data-testid={`input-${p.testPrefix}-mfe`}
              />
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
        </>
      )}

      {/* ---- stage 3: judgements about those facts ---- */}
      {explained && (
        <>
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
      )}

      {!priced && (
        <p className="text-[10px] leading-snug text-muted-foreground">
          Put in an exit price to record how it ended and grade it.
        </p>
      )}
    </div>
  );
}
