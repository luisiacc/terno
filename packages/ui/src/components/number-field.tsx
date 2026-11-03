"use client"

import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field"
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
}

/**
 * BoardUI's number field (plan 125) on Base UI's NumberField: Input's filled field (its wash, the border on hover,
 * focus and error, its unavailable look) with − and + at its end. Base UI parses and formats the number for the locale
 * (pass `format`, e.g. `{ useGrouping: false }` for ports), steps it with the arrows and the steppers within `min` and
 * `max`, and reports it on blur (`onValueCommitted`). `id`, the label's target, lands on the input. The input is
 * a text field (Base UI's), named by its label: find it by its label, not as a spinbutton.
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
  ...props
}: NumberFieldProps) {
  return (
    <NumberFieldPrimitive.Root data-slot="number-field" className="contents" {...props}>
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
          onKeyDown={onKeyDown}
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
