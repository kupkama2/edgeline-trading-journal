import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { store } from "@/lib/scoped-storage";
import { amountsHidden, hideAmounts } from "@shared/redact";

/**
 * A journal you can show someone.
 *
 * Everything worth showing about a trading record is scale-free — R, the
 * verdicts, the win rate, the expectancy, the SHAPE of the equity curve, the
 * discipline. Everything that makes it nobody else's business is an amount in
 * the account's own currency. The two are printed side by side on every row,
 * so showing the first has always meant showing the second.
 *
 * This takes the second away. Not by deleting anything and not by building a
 * second set of pages: the amounts are masked at the point they are formatted,
 * so R still reads +2.4R, a losing day is still red, the curve still has its
 * drawdown in the same place, and what the position was worth is withheld.
 *
 * A device preference, remembered per account like the layout and the filters.
 * It changes nothing that is stored, and turning it off shows the same numbers
 * that were there all along.
 */

const KEY = "edgeline.public";

const stored = () => store.get(KEY) === "1";

const Ctx = createContext<{ isPublic: boolean; setPublic: (on: boolean) => void }>({
  isPublic: false,
  setPublic: () => {},
});

export const usePublicMode = () => useContext(Ctx);

export function PublicModeProvider({ children }: { children: React.ReactNode }) {
  const [isPublic, set] = useState<boolean>(stored);

  /*
   * Set during the render, not in an effect.
   *
   * An effect runs AFTER the children have painted, which on the first frame
   * after a reload is a frame with every figure on it — the one frame a
   * screenshot might catch and the whole mode exists to prevent. Assigning a
   * module flag is idempotent and order-dependent in exactly the way this
   * needs: the provider renders before anything under it, so by the time a
   * formatter is called the answer is already in.
   */
  if (amountsHidden() !== isPublic) hideAmounts(isPublic);

  /* Writing is a real side effect, so it stays in an effect. */
  useEffect(() => {
    store.set(KEY, isPublic ? "1" : "0");
  }, [isPublic]);

  const value = useMemo(() => ({ isPublic, setPublic: set }), [isPublic]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
