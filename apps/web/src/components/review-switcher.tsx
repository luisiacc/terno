import type { CategoryColor } from "@terno/core";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { formatNumber, t } from "@terno/i18n";
import { useEffect, useMemo, useRef } from "react";
import { reviewTotals, switchReview, type Pending } from "~/lib/review";
import { setApp, useApp } from "~/state/app";

/**
 * Plan 159: what Review is sorting, under its title: how many in all (the sidebar's number), then the category in view
 * with its own count, a choice of every category with suggestions waiting (BoardUI's select: five categories don't fit a
 * segmented control in a 360 px column).
 */
export function ReviewSwitcher() {
  const review = useApp((s) => s.reviewCategoryId);
  const categories = useApp((s) => s.categories);
  const suggestions = useApp((s) => s.counts.categorySuggestions);
  const { total, pending } = useMemo(() => reviewTotals(categories, suggestions), [categories, suggestions]);
  // open, it holds the app's shortcuts (menuOpen); gone while open (Review left under it: its category deleted in another
  // window), Base UI says nothing, so it lets go itself (Codex code review #1)
  const open = useRef(false);
  useEffect(
    () => () => {
      if (open.current) setApp({ menuOpen: false });
    },
    [],
  );
  const current = categories.find((c) => c.id === review);
  if (!current) return null;
  // the one in view stays a choice at 0 too (its last one answered, Review stays on it: an Undo brings the rows back here)
  const choices: Pending[] = pending.some((p) => p.category.id === current.id) ? pending : [{ category: current, count: 0 }, ...pending];
  const items = choices.map(({ category, count }) => ({ value: String(category.id), label: `${category.name} ${formatNumber(count)}` }));
  return (
    <div data-testid="review-bar" className="type-list-subtitle flex min-w-0 items-center gap-2 text-muted-foreground tabular">
      <span data-testid="review-total" className="shrink-0">
        {t("review.total", { count: total })}
      </span>
      <span aria-hidden>·</span>
      <Select value={String(current.id)} onValueChange={(v) => switchReview(Number(v))} onOpenChange={(on) => {
          open.current = on;
          setApp({ menuOpen: on });
        }} items={items}>
        <SelectTrigger size="sm" data-testid="review-category" aria-label={t("review.switch")} className="no-drag min-w-0 font-normal">
          <SelectValue>
            {(value: string) => {
              const c = choices.find((p) => String(p.category.id) === value);
              return c && <Choice color={c.category.color as CategoryColor} name={c.category.name} count={c.count} />;
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
          {choices.map(({ category, count }) => (
            <SelectItem key={category.id} value={String(category.id)} data-testid={`review-category-${category.id}`}>
              <Choice color={category.color as CategoryColor} name={category.name} count={count} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** A category's dot, name and how many it has waiting, the count quieter. */
function Choice({ color, name, count }: { color: CategoryColor; name: string; count: number }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <CategoryDot color={color} />
      <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
      <span className="text-muted-foreground tabular">{formatNumber(count)}</span>
    </span>
  );
}
