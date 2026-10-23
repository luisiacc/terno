import { cn } from "cn"
import type { CategoryColor } from "@unica/core"

const DOT: Record<CategoryColor, string> = {
  rose: "bg-cat-rose",
  amber: "bg-cat-amber",
  lime: "bg-cat-lime",
  emerald: "bg-cat-emerald",
  cyan: "bg-cat-cyan",
  indigo: "bg-cat-indigo",
  violet: "bg-cat-violet",
  slate: "bg-cat-slate",
}

const SOFT: Record<CategoryColor, string> = {
  rose: "bg-cat-rose/15 text-cat-rose",
  amber: "bg-cat-amber/15 text-cat-amber",
  lime: "bg-cat-lime/15 text-cat-lime",
  emerald: "bg-cat-emerald/15 text-cat-emerald",
  cyan: "bg-cat-cyan/15 text-cat-cyan",
  indigo: "bg-cat-indigo/15 text-cat-indigo",
  violet: "bg-cat-violet/15 text-cat-violet",
  slate: "bg-cat-slate/15 text-cat-slate",
}

/** Small colored dot used for categories and accounts. */
function CategoryDot({ color, className }: { color: CategoryColor; className?: string }) {
  return <span data-slot="category-dot" aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", DOT[color] ?? DOT.slate, className)} />
}

/** Soft pill with a category name. */
function CategoryBadge({ color, children, className, ...props }: { color: CategoryColor; children: React.ReactNode } & React.ComponentProps<"span">) {
  return (
    <span data-slot="category-badge" {...props} className={cn("inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-2xs font-medium", SOFT[color] ?? SOFT.slate, className)}>
      {children}
    </span>
  )
}

export { CategoryDot, CategoryBadge }
