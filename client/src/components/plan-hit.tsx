/**
 * Which level the plan would have hit first, left alone — logged in one click.
 *
 * It is the question that makes a closed trade comparable against simply
 * leaving it: without it the fixed-target replay, the management verdicts and
 * "did I help or hurt by touching it" all skip the trade. And it is the one
 * most often left blank, because the editor asked it at the bottom of a long
 * form. So a closed trade that has not answered it asks right under its
 * chart, where the answer is sitting on screen, with two buttons that save as
 * they are pressed.
 */
import { useState, type ReactNode } from "react";
import { ShieldX, Target, Undo2 } from "lucide-react";
import { useUpdateTrade } from "@/lib/data";
import { useToast } from "@/hooks/use-toast";
import { outcomeUnknown } from "@shared/aftermath";
import type { TradeWithTags } from "@shared/schema";
import { num } from "@/components/trade-shared";

export type PlanHit = "target_first" | "stop_first" | "undetermined";

const LABEL: Record<PlanHit, string> = {
  stop_first: "Stop hit first",
  target_first: "Target hit first",
  undetermined: "Neither yet",
};

/**
 * The two answers as real buttons, stop on the left like on a chart read
 * left to right from risk to reward. Shared by the quick prompt and the
 * editor, so the question looks the same wherever it is asked.
 */
export function PlanHitButtons({
  value,
  onPick,
  stop,
  target,
  disabled,
  size = "md",
  testPrefix,
}: {
  value: PlanHit | null;
  onPick: (v: PlanHit) => void;
  stop?: number | null;
  target?: number | null;
  disabled?: boolean;
  size?: "md" | "lg";
  testPrefix: string;
}) {
  const h = size === "lg" ? "h-10 text-sm" : "h-8 text-xs";
  const btn = (id: PlanHit, icon: ReactNode, text: string, level: number | null | undefined, on: string, idle: string) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPick(id)}
      aria-pressed={value === id}
      data-testid={`button-${testPrefix}-${id}`}
      className={`flex min-w-0 flex-1 items-center justify-center gap-2 rounded-md border px-3 font-medium transition-colors disabled:opacity-50 ${h} ${
        value === id ? on : idle
      }`}
    >
      {icon}
      <span className="truncate">{text}</span>
      {level != null && <span className="hidden font-mono text-[11px] opacity-70 sm:inline">{num(level)}</span>}
    </button>
  );
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="flex min-w-0 flex-1 gap-2">
        {btn(
          "stop_first",
          <ShieldX className="h-4 w-4 shrink-0" />,
          "Stop hit",
          stop,
          "border-red-500/60 bg-red-500/15 text-red-400",
          "border-red-500/25 bg-red-500/5 text-red-400/90 hover:border-red-500/50 hover:bg-red-500/10",
        )}
        {btn(
          "target_first",
          <Target className="h-4 w-4 shrink-0" />,
          "Target hit",
          target,
          "border-emerald-500/60 bg-emerald-500/15 text-emerald-400",
          "border-emerald-500/25 bg-emerald-500/5 text-emerald-400/90 hover:border-emerald-500/50 hover:bg-emerald-500/10",
        )}
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPick("undetermined")}
        aria-pressed={value === "undetermined"}
        title="Price has reached neither level yet — the market check finishes the question later"
        data-testid={`button-${testPrefix}-undetermined`}
        className={`rounded-md px-2 text-[11px] transition-colors ${size === "lg" ? "h-10" : "h-8"} ${
          value === "undetermined" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        Neither yet
      </button>
    </div>
  );
}

/**
 * Under the chart of a closed trade whose plan outcome is still open. Saves
 * on the press and gets out of the way; the confirmation stays long enough to
 * take it back.
 */
export function PlanHitPrompt({ trade }: { trade: TradeWithTags }) {
  const update = useUpdateTrade();
  const { toast } = useToast();
  // What was just logged here, so the card can say so (and offer an undo)
  // instead of vanishing the instant the refetch lands.
  const [logged, setLogged] = useState<{ v: PlanHit; before: string | null } | null>(null);

  // Scalps are counted, not replayed against their plan.
  if (!logged && (trade.scalp || !outcomeUnknown(trade))) return null;

  const save = async (v: PlanHit | null, before: string | null) => {
    try {
      await update.mutateAsync({ id: trade.id, trade: { noManagementOutcome: v } as any });
      setLogged(v == null ? null : { v, before });
    } catch (err: any) {
      toast({
        title: "That didn't save",
        description: String(err?.message ?? err).slice(0, 160),
        variant: "destructive",
      });
    }
  };

  if (logged) {
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-secondary/20 px-3 py-2 text-xs"
        data-testid="plan-hit-logged"
      >
        <span className="text-muted-foreground">Left alone:</span>
        <span
          className={
            logged.v === "target_first" ? "font-medium text-emerald-400" : logged.v === "stop_first" ? "font-medium text-red-400" : "font-medium"
          }
        >
          {LABEL[logged.v]}
        </span>
        <button
          type="button"
          onClick={() => {
            const back = logged.before;
            setLogged(null);
            void save((back as PlanHit | null) ?? null, null);
          }}
          className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          data-testid="button-plan-hit-undo"
        >
          <Undo2 className="h-3 w-3" />
          Undo
        </button>
      </div>
    );
  }

  const parked = trade.noManagementOutcome === "undetermined";
  return (
    <div
      className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-3"
      data-testid="plan-hit-prompt"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="text-sm font-medium">Without management, which did it hit first?</p>
        <p className="text-[11px] text-muted-foreground">
          {parked ? "Logged as neither yet — has it reached one since?" : "Not logged yet. Read it off the chart above."}
        </p>
      </div>
      <PlanHitButtons
        size="lg"
        value={null}
        disabled={update.isPending}
        stop={trade.initialStop}
        target={trade.initialTarget}
        onPick={(v) => void save(v, trade.noManagementOutcome ?? null)}
        testPrefix="plan-hit"
      />
    </div>
  );
}
