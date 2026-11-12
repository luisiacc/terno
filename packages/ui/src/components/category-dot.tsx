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

// plan 194: an account's mark is a ring, a category's a dot, so the two never read as one thing where they share a color
const RING: Record<CategoryColor, string> = {
  rose: "ring-cat-rose",
  amber: "ring-cat-amber",
  lime: "ring-cat-lime",
  emerald: "ring-cat-emerald",
  cyan: "ring-cat-cyan",
  brown: "ring-cat-brown",
  violet: "ring-cat-violet",
  slate: "ring-cat-slate",
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

/** An account's mark: the dot's box, hollow, a ring in the account's color. */
function AccountRing({ color, className, ...props }: { color: CategoryColor } & React.ComponentProps<"span">) {
  return <span data-slot="account-ring" aria-hidden {...props} className={cn("inline-block size-2 shrink-0 rounded-full ring-[1.5px] ring-inset", RING[color] ?? RING.slate, className)} />
}

/** Soft pill with a category name. */
function CategoryBadge({ color, children, className, ...props }: { color: CategoryColor; children: React.ReactNode } & React.ComponentProps<"span">) {
  return (
    <span data-slot="category-badge" {...props} className={cn("inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-2xs font-medium", SOFT[color] ?? SOFT.slate, className)}>
      {children}
    </span>
  )
}

export { AccountRing, CategoryDot, CategoryBadge }
