import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { cn } from "cn"
import { Check as CheckIcon, Minus as MinusIcon } from "@terno/ui/icons"

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      // The checkbox (plan 118): white over a contact shadow, its border firming on hover (plan 125), then the accent lit
      // from the top, checked or partly (indeterminate)
      className={cn(
        "group/checkbox peer relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input transition-colors outline-none group-has-disabled/field:opacity-50 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-input after:absolute after:-inset-x-3 after:-inset-y-2 hover:not-data-checked:not-data-indeterminate:border-foreground/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary bg-card shadow-xs dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        "data-checked:border-primary data-checked:bg-primary data-checked:bg-linear-to-b data-checked:from-highlight data-checked:to-transparent data-checked:text-primary-foreground data-checked:shadow-[inset_0_1px_var(--highlight)] group-has-[:focus-visible]/field-label:data-checked:border-primary dark:data-checked:bg-primary",
        "data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:bg-linear-to-b data-indeterminate:from-highlight data-indeterminate:to-transparent data-indeterminate:text-primary-foreground data-indeterminate:shadow-[inset_0_1px_var(--highlight)] dark:data-indeterminate:bg-primary",
        className
      )}
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

export { Checkbox }
