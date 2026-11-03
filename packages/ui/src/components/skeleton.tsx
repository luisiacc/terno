import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

// BoardUI's skeleton (plan 125): a tint of the ink rather than the muted fill, so it reads on muted surfaces too. The
// pulse stays (no sheen): a sheen repaints every placeholder all the time, and Terno's waits are short
const skeletonVariants = cva("block animate-pulse bg-foreground/8", {
  variants: {
    shape: {
      rect: "rounded-xl",
      text: "h-3 rounded-md",
      circle: "rounded-full",
    },
  },
  defaultVariants: { shape: "rect" },
})

function Skeleton({ className, shape, ...props }: React.ComponentProps<"div"> & VariantProps<typeof skeletonVariants>) {
  return (
    <div
      data-slot="skeleton"
      data-shape={shape ?? "rect"}
      aria-hidden
      className={cn(skeletonVariants({ shape }), className)}
      {...props}
    />
  )
}

/** Lines of text to come: `lines` of them 10 px apart, the last 60% wide; `lineClassName` matches the text's height */
function SkeletonText({ lines = 3, lineClassName, className, ...props }: React.ComponentProps<"div"> & { lines?: number; lineClassName?: string }) {
  return (
    <div data-slot="skeleton-text" aria-hidden className={cn("flex w-full flex-col gap-2.5", className)} {...props}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} shape="text" className={cn(i === lines - 1 && lines > 1 ? "w-3/5" : "w-full", lineClassName)} />
      ))}
    </div>
  )
}

export { Skeleton, SkeletonText }
