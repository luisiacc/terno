import { cn } from "@terno/ui/lib/utils";
import { avatarColor, initials } from "~/lib/format";

/** A person's initials on their color's soft tint: the ink holds 4.5:1 on that tint wherever avatars sit (rows, drafts, the reader). */
const TINT: Record<ReturnType<typeof avatarColor>, string> = {
  rose: "bg-cat-rose/15 text-cat-rose-ink",
  amber: "bg-cat-amber/15 text-cat-amber-ink",
  lime: "bg-cat-lime/15 text-cat-lime-ink",
  emerald: "bg-cat-emerald/15 text-cat-emerald-ink",
  cyan: "bg-cat-cyan/15 text-cat-cyan-ink",
  indigo: "bg-cat-indigo/15 text-cat-indigo-ink",
  violet: "bg-cat-violet/15 text-cat-violet-ink",
  slate: "bg-cat-slate/15 text-cat-slate-ink",
};

/**
 * Initials only (plan 15): Terno has no photos or logos of its own, and
 * fetching them would send addresses off the machine. A plain span, cheap
 * enough for every list row; size and type come from the caller (design variables).
 */
export function SenderAvatar({ name, email, className }: { name: string; email: string; className?: string }) {
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center rounded-full font-semibold select-none", TINT[avatarColor(email)], className)}>
      {initials(name || email)}
    </span>
  );
}
