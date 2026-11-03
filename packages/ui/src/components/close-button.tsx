import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { t } from "@terno/i18n"
import { X } from "@terno/ui/icons"

// BoardUI's close button (plan 125): round, on the field wash, the glyph muted until hovered. The × is the iconset's,
// sized so its bars span what BoardUI's do, at a 1.5 px line whatever the size
const closeButtonVariants = cva(
  "inline-flex shrink-0 items-center justify-center rounded-full bg-field text-muted-foreground transition-colors outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:[--icon-line:1.5px]",
  {
    variants: {
      size: {
        "2xs": "size-4 [&_svg]:size-2.5",
        xs: "size-5 [&_svg]:size-3",
        sm: "size-6 [&_svg]:size-3.5",
        md: "size-8 [&_svg]:size-5",
      },
    },
    defaultVariants: { size: "xs" },
  }
)

/** `label` names it for screen readers (there is no visible one): "Close" unless it closes something more specific. */
function CloseButton({
  className,
  size = "xs",
  label,
  ...props
}: Omit<ButtonPrimitive.Props, "children"> & VariantProps<typeof closeButtonVariants> & { label?: string }) {
  return (
    <ButtonPrimitive
      data-slot="close-button"
      aria-label={label ?? t("common.close")}
      className={cn(closeButtonVariants({ size }), className)}
      {...props}
    >
      <X />
    </ButtonPrimitive>
  )
}

export { CloseButton, closeButtonVariants }
