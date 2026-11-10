import * as React from "react"
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

import { Spinner } from "@terno/ui/components/spinner"

const WORDED: ("default" | "outline" | "secondary" | "destructive")[] = ["default", "outline", "secondary", "destructive"]

const buttonVariants = cva(
  "group/button relative inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[background-color,color,box-shadow,transform] outline-none select-none focus-visible:ring-2 focus-visible:ring-ring active:not-aria-[haspopup]:scale-[0.98] unavailable:active:scale-100 disabled:pointer-events-none aria-busy:pointer-events-none aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[1.15em]",
  {
    variants: {
      variant: {
        // The primary (plan 118): lit from the top between two fills its text is checked on (primary-hover is the
        // lighter of the two in light palettes, the darker in dark ones). Plan 173: hover and open are primary-hover, flat
        // (its text checked on it; a step toward the ink did nothing where the primary is the ink, Lumen's and Graphite's),
        // and press is a step of the ink beyond it, which only takes its label further off it. Unavailable (plan 125,
        // BoardUI): the muted fill and its text, flat, and no press colour (`press` skips it)
        default: "bg-primary bg-linear-to-b from-primary-hover to-primary text-primary-foreground shadow-[inset_0_1px_var(--highlight),0_1px_2px_var(--shadow-color)] dark:from-primary dark:to-primary-hover hover:bg-primary-hover hover:bg-none aria-expanded:bg-primary-hover aria-expanded:bg-none press:bg-[color-mix(in_oklab,var(--primary-hover)_75%,var(--foreground))] press:bg-none unavailable:bg-muted unavailable:bg-none unavailable:text-muted-foreground unavailable:shadow-none",
        // The secondary: its own 1 px border (no size change) firming up on hover, over a contact shadow, on the muted fill;
        // pressed, a step of the ink deeper (plan 173); unavailable, the field wash under its border, flat (plan 125)
        outline:
          "border-border bg-card shadow-xs hover:border-input hover:bg-muted hover:text-foreground press:border-input press:bg-[color-mix(in_oklab,var(--muted),var(--foreground)_6%)] aria-expanded:border-input aria-expanded:bg-muted aria-expanded:text-foreground [&_svg:not([class*='text-'])]:text-muted-foreground hover:[&_svg:not([class*='text-'])]:text-foreground aria-expanded:[&_svg:not([class*='text-'])]:text-foreground unavailable:border-border unavailable:bg-field unavailable:text-muted-foreground unavailable:shadow-none",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] press:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_10%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground unavailable:bg-muted unavailable:text-muted-foreground",
        // Terno's quiet toolbar button (BoardUI has no transparent one): its icons are muted at rest, so unavailable it fades;
        // pressed, a step deeper than its hover (plan 173)
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50 press:bg-[color-mix(in_oklab,var(--muted),var(--foreground)_6%)] dark:press:bg-muted unavailable:opacity-50",
        // BoardUI's danger (plan 125): solid, lit from the top from the red to its shade, its own text (contrast.ts)
        destructive: "bg-destructive bg-linear-to-b from-destructive to-destructive-shade text-destructive-foreground shadow-xs hover:bg-[color-mix(in_oklab,var(--destructive)_90%,var(--foreground))] hover:bg-none press:bg-destructive-shade press:bg-none focus-visible:ring-destructive/40 unavailable:bg-muted unavailable:bg-none unavailable:text-muted-foreground unavailable:shadow-none",
        link: "text-primary underline-offset-3 hover:underline press:text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))] unavailable:opacity-50",
        // BoardUI's secondary link, in the ink: for surfaces the accent isn't checked on (the tint, a draft)
        "link-secondary": "text-foreground underline-offset-3 hover:underline press:text-muted-foreground unavailable:opacity-50",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs font-semibold in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[length:var(--ds-text-control)] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8 [&_svg:not([class*='size-'])]:size-4",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-4",
        "icon-lg": "size-9 [&_svg:not([class*='size-'])]:size-4",
      },
    },
    // BoardUI's link button: text, no box
    compoundVariants: [
      { variant: ["link", "link-secondary"], class: "h-auto rounded-sm border-0 p-0 has-data-[icon=inline-end]:pr-0 has-data-[icon=inline-start]:pl-0" },
      // Plan 137: a button with words on it is a pill where the design says so (the floor is 0 elsewhere). Outline too: it
      // sits beside the primary in every dialog footer. Icon-only and quiet buttons keep the ladder
      { variant: WORDED, size: ["default", "lg"], class: "rounded-[max(var(--cta-floor),var(--ds-radius-lg))]" },
      { variant: WORDED, size: "sm", class: "rounded-[max(var(--cta-floor),min(var(--ds-radius-md),12px))]" },
      { variant: WORDED, size: "xs", class: "rounded-[max(var(--cta-floor),min(var(--ds-radius-md),10px))]" },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/** an icon from @terno/ui/icons (each is named after itself) */
const isIcon = (node: React.ReactNode) =>
  React.isValidElement(node) && typeof node.type === "function" && Boolean((node.type as { displayName?: string }).displayName)

/**
 * `loading` (plan 125): a spinner in place of the leading icon (over the label when there is none), the button busy and
 * unusable but still focusable, its width and fill unchanged.
 */
function Button({
  className,
  variant = "default",
  size = "default",
  loading = false,
  disabled,
  focusableWhenDisabled,
  children,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants> & { loading?: boolean }) {
  let content = children
  if (loading) {
    const kids = React.Children.toArray(children as React.ReactNode)
    content = isIcon(kids[0]) ? (
      <>
        <Spinner aria-hidden />
        {kids.slice(1)}
      </>
    ) : (
      <>
        {/* hidden by opacity, not visibility: it holds the width and still names the button */}
        <span className="inline-flex items-center gap-[inherit] opacity-0">{children as React.ReactNode}</span>
        <span className="absolute inset-0 grid place-items-center">
          <Spinner aria-hidden />
        </span>
      </>
    )
  }
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled || loading}
      focusableWhenDisabled={focusableWhenDisabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {content}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants }
