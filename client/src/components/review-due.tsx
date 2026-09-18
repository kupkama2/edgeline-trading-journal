import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CalendarRange } from "lucide-react";
import { useTrades } from "@/lib/data";
import { dueSentence, reviewDue, weekKey } from "@shared/review";

/**
 * The Sunday nag.
 *
 * It appears on the Sunday that ends a week and does not go away until the
 * week is gone over — a reminder that clears itself on Monday is a reminder
 * for people who were going to do it anyway. It says how many are left and
 * how old they are, and nothing else: the screen it links to is where the
 * work is, and a nag that tries to do the work is a second place to do it
 * badly.
 *
 * Unscoped on purpose. The style filter is for asking questions of the
 * record; the week you owe is the week you owe, whichever book you are
 * looking at.
 */
export function ReviewDueCard() {
  const { data: trades = [] } = useTrades();
  const due = reviewDue(trades);
  if (!due) return null;

  const old = due.weeksAgo >= 2;
  return (
    <Card
      className={`p-3.5 sm:p-4 ${
        old ? "border-destructive/60 bg-destructive/10" : "border-amber-500/40 bg-amber-500/5"
      }`}
      data-testid="card-review-due"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <CalendarRange className={`h-4 w-4 shrink-0 ${old ? "text-destructive" : "text-amber-500"}`} />
        <div className="min-w-0 flex-1">
          <p
            className={`text-sm font-semibold tracking-tight ${old ? "text-destructive" : "text-amber-500"}`}
            data-testid="text-review-due"
          >
            {dueSentence(due)}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            Read them in a row and say what you see now. It is the only part of this that makes
            the next week different.
          </p>
        </div>
        <Button asChild size="sm" className="h-8 shrink-0 text-[11px]">
          <Link href={`/review/${weekKey(due.week)}`} data-testid="link-review-week">
            Go over them
          </Link>
        </Button>
      </div>
    </Card>
  );
}
