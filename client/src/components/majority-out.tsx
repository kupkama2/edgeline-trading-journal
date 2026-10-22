import { CheckCheck, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUpdateTrade } from "@/lib/data";
import { failed } from "@/lib/report";
import type { TradeWithTags } from "@shared/schema";

/**
 * "Majority out": most of it is off and the rest is running.
 *
 * One click, no numbers — the partials can be recorded properly later, or
 * never. The trade stays open and counted; it only drops below the ones
 * still to manage (shared/managed.ts). Pressed again, it comes back.
 */
export function MajorityOutButton({
  trade,
  compact = false,
}: {
  trade: TradeWithTags;
  /** The row's size: a short label at the row's height. */
  compact?: boolean;
}) {
  const update = useUpdateTrade();
  const marked = Boolean(trade.managedAt);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={compact ? "h-6 px-1.5 text-[10px]" : "h-8 text-[11px]"}
      disabled={update.isPending}
      onClick={(e) => {
        e.stopPropagation();
        update.mutate(
          { id: trade.id, trade: { managedAt: marked ? null : new Date().toISOString() } as any },
          { onError: failed("Majority out") },
        );
      }}
      title={
        marked
          ? "Move it back up with the trades still to manage"
          : "Most of it is off and the rest is running: keep it open, lower down"
      }
      data-testid={`button-majority-out-${trade.id}${compact ? "" : "-view"}`}
    >
      {marked ? (
        <>
          <RotateCcw className={compact ? "mr-0.5 h-3 w-3" : "mr-1 h-3 w-3"} /> Manage again
        </>
      ) : (
        <>
          <CheckCheck className={compact ? "mr-0.5 h-3 w-3" : "mr-1 h-3 w-3"} /> Majority out
        </>
      )}
    </Button>
  );
}
