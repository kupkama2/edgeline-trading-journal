import { createContext, useContext, useEffect, useState } from "react";
import { store } from "@/lib/scoped-storage";

/**
 * Which design the journal wears.
 *
 * Two layouts over one set of data. V1 is the original: everything the journal
 * knows about a trade, on the row, because at the time the thing being proven
 * was that it knew. V2 is the answer to having lived with that — a row says
 * the ticker, the verdict, the R and the money, and the rest is one click away
 * inside the trade.
 *
 * Both are kept rather than one replacing the other, because which one is
 * right depends on what you are doing: reading back a month wants the quiet
 * one, auditing a single bad week wants every figure on the surface. The
 * choice is remembered per account like the filters, and switching costs
 * nothing — no data is shaped differently, only drawn differently.
 */
export type LayoutVersion = "v1" | "v2";

const KEY = "edgeline.layout";

/** The quiet one, unless this browser has said otherwise. */
const DEFAULT: LayoutVersion = "v2";

function stored(): LayoutVersion {
  return store.get(KEY) === "v1" ? "v1" : DEFAULT;
}

const Ctx = createContext<{
  version: LayoutVersion;
  setVersion: (v: LayoutVersion) => void;
}>({ version: DEFAULT, setVersion: () => {} });

export const useLayout = () => useContext(Ctx);

export function LayoutProvider({ children }: { children: React.ReactNode }) {
  const [version, setVersion] = useState<LayoutVersion>(stored);

  useEffect(() => {
    store.set(KEY, version);
  }, [version]);

  return <Ctx.Provider value={{ version, setVersion }}>{children}</Ctx.Provider>;
}
