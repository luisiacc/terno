import { cn } from "cn"

import { CloseButton } from "@terno/ui/components/close-button"

type ChipProps = React.ComponentProps<"span"> & {
  /** before the text: a CategoryDot, an avatar, a file's glyph */
  dot?: React.ReactNode
} & (
    | { onRemove?: undefined; removeLabel?: never; removeProps?: never }
    | {
        /** shows a small round × at the end */
        onRemove: (event: React.MouseEvent<HTMLButtonElement>) => void
        /** names the × after the chip: "Remove Work", "Not Work" */
        removeLabel: string
        removeProps?: Omit<React.ComponentProps<typeof CloseButton>, "label" | "onClick" | "size"> & { "data-testid"?: string }
      }
  )

/**
 * BoardUI's chip (plan 125): a label on the field wash, medium caption text, an optional leading dot and an optional
 * remove button named after it. A styled span (not a widget): the recipient field's chips stay its own.
 */
function Chip({ dot, onRemove, removeLabel, removeProps, className, children, ...props }: ChipProps) {
  return (
    <span
      data-slot="chip"
      className={cn(
        "inline-flex h-6 max-w-full min-w-0 shrink-0 items-center gap-1.5 rounded-md bg-field px-2 text-xs font-medium whitespace-nowrap text-foreground",
        onRemove && "pe-1",
        className
      )}
      {...props}
    >
      {dot}
      {/* one line (BoardUI's chip): a label longer than its room ends in "…", inside the box, before the × */}
      <span data-slot="chip-label" className="min-w-0 truncate">{children}</span>
      {onRemove && <CloseButton size="2xs" label={removeLabel} onClick={onRemove} {...removeProps} />}
    </span>
  )
}

export { Chip, type ChipProps }
