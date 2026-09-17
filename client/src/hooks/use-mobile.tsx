import * as React from "react"

const MOBILE_BREAKPOINT = 768

/**
 * Is there room to stand the entry form and the open trades side by side?
 *
 * Width alone got this wrong on a monitor turned on its side. A portrait
 * 1080-wide screen clears any sensible width breakpoint, so the page split
 * into two columns and squeezed the form into six hundred pixels — four
 * fields to a row in a column too narrow for them, which is what the layout
 * looked like when it looked broken. A tall screen wants one wide column and
 * to scroll, which is the thing it is good at.
 */
const SIDE_BY_SIDE = "(min-width: 1280px) and (orientation: landscape)";

export function useSideBySide() {
  const [ok, setOk] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia(SIDE_BY_SIDE).matches,
  );
  React.useEffect(() => {
    const mql = window.matchMedia(SIDE_BY_SIDE);
    const onChange = () => setOk(mql.matches);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return ok;
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
