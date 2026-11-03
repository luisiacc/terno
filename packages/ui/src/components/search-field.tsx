import * as React from "react"
import { cn } from "cn"
import { t } from "@terno/i18n"

import { CloseButton } from "@terno/ui/components/close-button"
import { Input } from "@terno/ui/components/input"
import { Search } from "@terno/ui/icons"

type SearchFieldProps = Omit<React.ComponentProps<"input">, "value" | "onChange" | "type" | "className"> & {
  value: string
  onValueChange: (value: string) => void
  /** the clear button's name ("Clear search" unless it clears something more specific) */
  clearLabel?: string
  /** Escape empties the field (BoardUI's); off when the caller's own onKeyDown decides what Escape does */
  clearOnEscape?: boolean
  /** shown at the end while the field is empty: a key that focuses it */
  hint?: React.ReactNode
  /** the wrapper (place it); `fieldClassName` the input itself (size it) */
  className?: string
  fieldClassName?: string
}

/**
 * BoardUI's search field (plan 125): Input's filled field with the search glyph at the start and, once there is text,
 * a small round clear at the end. The clear stays out of the tab order (Escape does its job from the keyboard) and
 * keeps focus in the field. The ref and every key handler reach the input, so a caller keeps its own keys.
 */
function SearchField({
  value,
  onValueChange,
  clearLabel,
  clearOnEscape = true,
  hint,
  className,
  fieldClassName,
  onKeyDown,
  ref,
  disabled,
  ...props
}: SearchFieldProps) {
  const input = React.useRef<HTMLInputElement | null>(null)
  return (
    <div data-slot="search-field" className={cn("relative", className)}>
      <Search aria-hidden className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={(el) => {
          input.current = el
          if (typeof ref === "function") ref(el)
          else if (ref) ref.current = el
        }}
        type="text"
        value={value}
        disabled={disabled}
        className={cn("ps-8 pe-8", fieldClassName)}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          if (clearOnEscape && !e.defaultPrevented && e.key === "Escape" && value) {
            e.preventDefault()
            onValueChange("")
          }
        }}
        {...props}
      />
      {value ? (
        <CloseButton
          size="2xs"
          label={clearLabel ?? t("ui.search.clear")}
          tabIndex={-1}
          disabled={disabled}
          // focus stays in the field while the pointer clears it
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onValueChange("")
            input.current?.focus()
          }}
          className="absolute end-2 top-1/2 -translate-y-1/2"
        />
      ) : (
        hint && <span className="pointer-events-none absolute end-2 top-1/2 flex -translate-y-1/2">{hint}</span>
      )}
    </div>
  )
}

export { SearchField, type SearchFieldProps }
