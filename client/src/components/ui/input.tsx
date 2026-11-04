import * as React from "react"

import { cn } from "@/lib/utils"
import { cleanNumberText } from "@shared/loose-number"

/**
 * A number pasted into a number field, read as the number it was.
 *
 * A native number input hands a pasted "79,582.3" to the browser's own
 * reading of it, and a browser whose locale writes decimals with a comma
 * drops the "." and keeps 79.5823. So on a number field the pasted text is
 * read first (shared/loose-number.ts) and the field is given the plain
 * figure, through the element's own setter so React sees it as typed.
 */
function pasteAsNumber(e: React.ClipboardEvent<HTMLInputElement>): boolean {
  const raw = e.clipboardData?.getData("text") ?? ""
  const cleaned = cleanNumberText(raw)
  if (!cleaned || cleaned === raw.trim()) return false
  e.preventDefault()
  const el = e.currentTarget
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
  if (set) set.call(el, cleaned)
  else el.value = cleaned
  el.dispatchEvent(new Event("input", { bubbles: true }))
  return true
}

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, onPaste, ...props }, ref) => {
    const numeric = type === "number" || props.inputMode === "decimal" || props.inputMode === "numeric"
    // h-9 to match icon buttons and default buttons.
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-ring/60 focus-visible:ring-1 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className
        )}
        ref={ref}
        onPaste={(e) => {
          if (numeric && pasteAsNumber(e)) return
          onPaste?.(e)
        }}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
