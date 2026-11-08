import type * as React from "react"
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { cn } from "cn"
import { Check as CheckIcon, Minus as MinusIcon } from "@terno/ui/icons"

const BOX = [
        "group/checkbox peer relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-control-edge transition-colors outline-none group-has-disabled/field:opacity-50 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-control-edge after:absolute after:-inset-x-3 after:-inset-y-2 hover:not-data-checked:not-data-indeterminate:border-control-edge-hover focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary bg-card shadow-xs dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        "data-checked:border-primary data-checked:bg-primary data-checked:bg-linear-to-b data-checked:from-highlight data-checked:to-transparent data-checked:text-primary-foreground data-checked:shadow-[inset_0_1px_var(--highlight)] group-has-[:focus-visible]/field-label:data-checked:border-primary dark:data-checked:bg-primary",
        "data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:bg-linear-to-b data-indeterminate:from-highlight data-indeterminate:to-transparent data-indeterminate:text-primary-foreground data-indeterminate:shadow-[inset_0_1px_var(--highlight)] dark:data-indeterminate:bg-primary",
].join(" ")

/**
 * The box drawn inside a 24 px target (plan 161): the same box, its states read from the target (`group/checkbox`), so the
 * control a pointer hits and a screen reader names is the 24 px element itself, not a pseudo-element around a 16 px one.
 */
const TARGET_BOX = [
  "relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-control-edge bg-card shadow-xs transition-colors",
  "group-focus-visible/checkbox:border-ring group-focus-visible/checkbox:ring-3 group-focus-visible/checkbox:ring-ring group-disabled/checkbox:opacity-50",
  "group-data-checked/checkbox:border-primary group-data-checked/checkbox:bg-primary group-data-checked/checkbox:bg-linear-to-b group-data-checked/checkbox:from-highlight group-data-checked/checkbox:to-transparent group-data-checked/checkbox:text-primary-foreground group-data-checked/checkbox:shadow-[inset_0_1px_var(--highlight)] dark:group-data-checked/checkbox:bg-primary",
].join(" ")

function Checkbox({ className, target, ...props }: CheckboxPrimitive.Root.Props & { /** a 24 px target of its own, its hover a fill the target's size (plan 161) */ target?: boolean }) {
  if (target)
    return (
      <CheckboxPrimitive.Root
        data-slot="checkbox-target"
        className={cn("group/checkbox grid size-6 shrink-0 place-items-center rounded-md outline-none transition-colors hover:not-disabled:bg-row-hover disabled:cursor-not-allowed", className)}
        {...props}
      >
        <span data-slot="checkbox" className={TARGET_BOX}>
          <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="grid place-content-center text-current transition-none [&>svg]:size-4 [&>svg]:[--icon-line:2px]">
            <CheckIcon />
          </CheckboxPrimitive.Indicator>
        </span>
      </CheckboxPrimitive.Root>
    )
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      // The checkbox (plan 118): white over a contact shadow, its border firming on hover (plan 125), then the accent lit
      // from the top, checked or partly (indeterminate)
      className={cn(BOX, className)}
      {...props}
    >
      {/* BoardUI's marks (plan 125): the tick or the dash filling the box, at a 2 px line */}
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-4 [&>svg]:[--icon-line:2px]"
      >
        <CheckIcon className="group-data-indeterminate/checkbox:hidden" />
        <MinusIcon className="hidden group-data-indeterminate/checkbox:block" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

/**
 * The same box as a picture, for a row that is itself the control (an option's children can't be focusable: plan 143).
 * The pointer's way in; the row's own state and key are what a keyboard and a screen reader get.
 */
function CheckboxMark({ checked, className, ...props }: React.ComponentProps<"span"> & { checked: boolean }) {
  return (
    <span aria-hidden data-slot="checkbox" data-checked={checked ? "" : undefined} className={cn(BOX, className)} {...props}>
      {checked && (
        <span data-slot="checkbox-indicator" className="grid place-content-center text-current [&>svg]:size-4 [&>svg]:[--icon-line:2px]">
          <CheckIcon />
        </span>
      )}
    </span>
  )
}

export { Checkbox, CheckboxMark }
