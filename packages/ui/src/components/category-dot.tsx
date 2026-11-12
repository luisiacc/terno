import { cn } from "cn"
import type { CategoryColor } from "@terno/core"

const DOT: Record<CategoryColor, string> = {
  rose: "bg-cat-rose",
  amber: "bg-cat-amber",
  lime: "bg-cat-lime",
  emerald: "bg-cat-emerald",
  cyan: "bg-cat-cyan",
  brown: "bg-cat-brown",
  violet: "bg-cat-violet",
  slate: "bg-cat-slate",
}

const SOFT: Record<CategoryColor, string> = {
  rose: "bg-cat-rose/15 text-cat-rose-ink",
  amber: "bg-cat-amber/15 text-cat-amber-ink",
  lime: "bg-cat-lime/15 text-cat-lime-ink",
  emerald: "bg-cat-emerald/15 text-cat-emerald-ink",
  cyan: "bg-cat-cyan/15 text-cat-cyan-ink",
  brown: "bg-cat-brown/15 text-cat-brown-ink",
  violet: "bg-cat-violet/15 text-cat-violet-ink",
  slate: "bg-cat-slate/15 text-cat-slate-ink",
}

/** A category's mark: a small filled dot. */
function CategoryDot({ color, className, ...props }: { color: CategoryColor } & React.ComponentProps<"span">) {
  return <span data-slot="category-dot" aria-hidden {...props} className={cn("inline-block size-2 shrink-0 rounded-full", DOT[color] ?? DOT.slate, className)} />
}

/**
 * An account's mark (plan 194, the owner's call): a small filled diamond, so an account never reads as a category's dot
 * where the two share a color. A 7 px square turned 45°: about the dot's area, so neither weighs more.
 */
function AccountMark({ color, className, ...props }: { color: CategoryColor } & React.ComponentProps<"span">) {
  return <span data-slot="account-mark" aria-hidden {...props} className={cn("inline-block size-1.75 shrink-0 rotate-45 rounded-[1px]", DOT[color] ?? DOT.slate, className)} />
}

/** Soft pill with a category name. */
function CategoryBadge({ color, children, className, ...props }: { color: CategoryColor; children: React.ReactNode } & React.ComponentProps<"span">) {
  return (
    <span data-slot="category-badge" {...props} className={cn("inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-2xs font-medium", SOFT[color] ?? SOFT.slate, className)}>
      {children}
    </span>
  )
}

export { AccountMark, CategoryDot, CategoryBadge }
