import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

const read = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
};

/**
 * A section of a page that folds away under its own name, and stays the
 * way it was left: the choice is kept in the browser, per section. Folded,
 * only the name shows, with a word on what is inside.
 */
export function Fold({ id, title, hint, defaultOpen = true, children }: { id: string; title: string; hint?: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const key = `edgeline.fold.${id}`;
  const [open, setOpen] = useState(() => read(key, defaultOpen));
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(key, o ? "0" : "1");
      } catch {
        /* fine */
      }
      return !o;
    });
  return (
    <section data-testid={`fold-${id}`} data-open={open ? "1" : "0"}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`flex w-full items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground ${open ? "mb-1.5 px-1" : "rounded-lg border border-border bg-card px-3 py-2.5"}`}
        title={open ? `Fold ${title} away` : `Open ${title}`}
        data-testid={`fold-toggle-${id}`}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        {title}
        {!open && hint && <span className="truncate font-normal normal-case tracking-normal">· {hint}</span>}
      </button>
      {open && children}
    </section>
  );
}
