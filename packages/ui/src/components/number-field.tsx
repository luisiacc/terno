"use client"

import { createGenericEventDetails } from "@base-ui/react/internals/createBaseUIEventDetails"
import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field"
import { useRef } from "react"
import { cn } from "cn"
import { t } from "@terno/i18n"
import { Minus, Plus } from "@terno/ui/icons"

// BoardUI's steppers: quiet glyphs that take the hover wash, unusable at either limit
const STEPPER =
  "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors select-none hover:bg-muted hover:text-foreground data-pressed:bg-muted data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:size-3.5"

type NumberFieldProps = Omit<NumberFieldPrimitive.Root.Props, "className" | "render" | "children" | "onKeyDown" | "aria-label" | "aria-labelledby" | "aria-describedby" | "aria-invalid"> & {
  /** the field's shell (width, height) */
  className?: string
  inputClassName?: string
  /** BoardUI's − and + at the end (default); without them the arrow keys still step it */
  steppers?: boolean
  placeholder?: string
  "aria-label"?: string
  "aria-labelledby"?: string
  "aria-describedby"?: string
  "aria-invalid"?: boolean
  "data-testid"?: string
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
  /** Enter commits as leaving the field does (the same parsing), focus staying in the field */
  commitOnEnter?: boolean
  /**
   * The field was left (or Enter committed it) with edited text that isn't a number (".", "-"): Base UI then keeps
   * the text and commits nothing, so this is the caller's chance to say why.
   */
  onUnparsed?: (text: string) => void
}

/**
 * BoardUI's number field (plan 125) on Base UI's NumberField: Input's filled field (its wash, the border on hover,
 * focus and error, its unavailable look) with − and + at its end. Base UI parses and formats the number for the locale
 * (pass `format`, e.g. `{ useGrouping: false }` for ports), steps it with the arrows and the steppers within `min` and
 * `max`, and reports it on blur (`onValueCommitted`). `id`, the label's target, lands on the input. The input is
 * a text field (Base UI's), named by its label: find it by its label, not as a spinbutton. `commitOnEnter` and
 * `onUnparsed` go through that same commit, so Enter and Tab read a number the same way (Codex code review #4, #5).
 */
function NumberField({
  className,
  inputClassName,
  steppers = true,
  placeholder,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  "data-testid": testId,
  onKeyDown,
  commitOnEnter = false,
  onUnparsed,
  onValueCommitted,
  onValueChange,
  value,
  defaultValue,
  ...props
}: NumberFieldProps) {
  // between an edit and the blur that follows it: did Base UI commit anything?
  const edit = useRef({ edited: false, committed: false })
  // commits and unparsed reports so far (an Enter checks whether its blur produced either)
  const seen = useRef({ commits: 0, unparsed: 0 })
  // the number as Base UI last parsed it (uncontrolled; a controlled field reads `value`)
  const parsed = useRef<number | null>(defaultValue ?? null)
  const unparsed = (text: string) => {
    seen.current.unparsed++
    onUnparsed?.(text)
  }
  return (
    <NumberFieldPrimitive.Root
      data-slot="number-field"
      className="contents"
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next, details) => {
        parsed.current = next
        onValueChange?.(next, details)
      }}
      onValueCommitted={(next, details) => {
        edit.current.committed = true
        seen.current.commits++
        onValueCommitted?.(next, details)
      }}
      {...props}
    >
      <NumberFieldPrimitive.Group
        data-slot="number-field-group"
        className={cn(
          "group/number-field flex h-8 w-full min-w-0 items-center rounded-lg border border-transparent bg-field transition-colors hover:border-input has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring has-[input[aria-invalid=true]]:border-destructive has-[input[aria-invalid=true]]:ring-3 has-[input[aria-invalid=true]]:ring-destructive/20 data-disabled:pointer-events-none dark:has-[input[aria-invalid=true]]:ring-destructive/40",
          steppers && "pe-1",
          className
        )}
      >
        <NumberFieldPrimitive.Input
          data-slot="number-field-input"
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          // Base UI says "Number field" in English whatever the language
          aria-roledescription={t("ui.numberField.role")}
          data-testid={testId}
          onKeyDown={(e) => {
            onKeyDown?.(e)
            if (!commitOnEnter || e.key !== "Enter" || e.defaultPrevented) return
            // Base UI commits on blur only: leave and come back, in the same frame
            const input = e.currentTarget
            const before = { ...seen.current }
            input.blur()
            input.focus({ preventScroll: true })
            // a blur after no edit commits nothing (Base UI's): an Enter still commits the number in the field, so
            // one after a save that failed tries again (Codex code review, second pass #2). After the blur's own check
            const native = e.nativeEvent
            queueMicrotask(() => {
              if (seen.current.commits !== before.commits || seen.current.unparsed !== before.unparsed) return
              onValueCommitted?.(value !== undefined ? value : parsed.current, createGenericEventDetails("keyboard", native))
            })
          }}
          onChange={() => {
            edit.current = { edited: true, committed: false }
          }}
          onBlur={(e) => {
            const input = e.currentTarget
            // edited to text with no digit at all (".", "-") and a caller to say why: Base UI would keep the text only
            // until its next render (then put the last number back); skipping its blur keeps it the user's, still
            // edited, so leaving again checks it again (this handler runs before Base UI's). With no one to say why,
            // Base UI's own blur runs, so the value the form sets later shows (Codex code review, second pass #1)
            if (onUnparsed && edit.current.edited && input.value.trim() !== "" && !/\p{Nd}/u.test(input.value)) {
              e.preventBaseUIHandler()
              unparsed(input.value)
              return
            }
            // anything else after Base UI's own blur, which parses the text and commits it if it can
            queueMicrotask(() => {
              const { edited, committed } = edit.current
              edit.current = { edited: false, committed: false }
              if (onUnparsed && edited && !committed && input.value.trim() !== "") unparsed(input.value)
            })
          }}
          className={cn(
            "h-full w-full min-w-0 flex-1 bg-transparent px-2.5 text-base tabular-nums outline-none placeholder:text-muted-foreground disabled:text-muted-foreground md:text-sm",
            steppers && "pe-1",
            inputClassName
          )}
        />
        {steppers && (
          <span className="flex shrink-0 items-center gap-0.5">
            <NumberFieldPrimitive.Decrement data-slot="number-field-decrement" aria-label={t("ui.numberField.decrease")} className={STEPPER}>
              <Minus />
            </NumberFieldPrimitive.Decrement>
            <NumberFieldPrimitive.Increment data-slot="number-field-increment" aria-label={t("ui.numberField.increase")} className={STEPPER}>
              <Plus />
            </NumberFieldPrimitive.Increment>
          </span>
        )}
      </NumberFieldPrimitive.Group>
    </NumberFieldPrimitive.Root>
  )
}

export { NumberField }
