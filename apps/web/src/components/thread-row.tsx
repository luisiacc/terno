import type { CategoryColor, ThreadSummary } from "@unica/core";
import { CategoryDot } from "@unica/ui/components/category-dot";
import { cn } from "@unica/ui/lib/utils";
import { Paperclip, Star } from "lucide-react";
import { memo } from "react";
import { listDate } from "~/lib/format";
import { renderProbe } from "~/lib/render-probe";
import { pressRow, releaseRow } from "~/lib/select";
import { useApp } from "~/state/app";

const ACCOUNT_BAR: Record<CategoryColor, string> = {
  rose: "bg-cat-rose",
  amber: "bg-cat-amber",
  lime: "bg-cat-lime",
  emerald: "bg-cat-emerald",
  cyan: "bg-cat-cyan",
  indigo: "bg-cat-indigo",
  violet: "bg-cat-violet",
  slate: "bg-cat-slate",
};

export const ROW_HEIGHT = { comfortable: 68, compact: 40 } as const;

interface Props {
  thread: ThreadSummary;
  top: number;
  height: number;
  compact: boolean;
  showAccount: boolean;
}

/**
 * A list row. Cheap by design: no tooltips or Base UI primitives inside (the
 * context menu wraps the whole list); the selected/checked state is a
 * per-row selector so moving the selection re-renders exactly two rows and
 * checking one re-renders one.
 */
export const ThreadRow = memo(function ThreadRow({ thread: t, top, height, compact, showAccount }: Props) {
  renderProbe("ThreadRow");
  /** the open thread (the cursor; the listbox's active descendant) */
  const selected = useApp((s) => s.selectedId === t.id);
  // "select all N" checks every row, loaded later or not
  const checked = useApp((s) => s.scope !== null || s.checked.has(t.id));
  // what assistive tech hears as selected: the checked rows, or the open thread when nothing is checked
  const inSelection = useApp((s) => s.scope !== null || s.checked.has(t.id) || (s.selectedId === t.id && s.checked.size === 0));
  const accountColor = useApp((s) => (showAccount ? s.accounts.find((a) => a.id === t.accountId)?.color : undefined)) as CategoryColor | undefined;
  const categories = useApp((s) => s.categories);
  const cats = t.categoryIds.length ? categories.filter((c) => t.categoryIds.includes(c.id)) : [];

  return (
    <div
      role="option"
      id={`thread-${t.id}`}
      aria-selected={inSelection}
      data-cursor={selected || undefined}
      data-testid="thread-row"
      data-thread-id={t.id}
      data-unread={t.unread || undefined}
      data-checked={checked || undefined}
      onMouseDown={(e) => e.button === 0 && pressRow(t.id, { meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey })}
      onClick={(e) => !e.metaKey && !e.ctrlKey && !e.shiftKey && releaseRow(t.id)}
      className={cn(
        "absolute left-0 w-full cursor-default border-b border-border/60 px-4 select-none",
        "flex flex-col justify-center",
        selected ? "bg-row-selected text-row-selected-foreground" : checked ? "bg-accent" : "hover:bg-row-hover",
      )}
      style={{ transform: `translateY(${top}px)`, height }}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-row-rail" />}
      <span className={cn("absolute top-1/2 left-1.5 size-1.5 -translate-y-1/2 rounded-full bg-unread", !t.unread && "invisible")} />
      <div className="flex min-w-0 items-center gap-2">
        <span data-testid="row-from" className={cn("min-w-0 truncate text-sm", t.unread ? "font-semibold" : "font-normal text-foreground")}>{t.fromName}</span>
        {t.messageCount > 1 && <span className="font-mono text-2xs text-muted-foreground tabular">{t.messageCount}</span>}
        {compact && (
          <span className={cn("min-w-0 flex-1 truncate text-sm", t.unread ? "text-foreground" : "text-muted-foreground")}>
            {t.subject} <span className="text-muted-foreground">— {t.snippet}</span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {cats.map((c) => (
            <CategoryDot key={c.id} data-cat-dot={c.id} color={c.color as CategoryColor} />
          ))}
          {t.hasAttachments && <Paperclip className="size-3 text-muted-foreground" />}
          {t.starred && <Star className="size-3 fill-star text-star" />}
          {accountColor && <span data-testid="account-bar" className={cn("h-3 w-0.5 rounded-full", ACCOUNT_BAR[accountColor])} />}
          <span className={cn("font-mono text-2xs tabular", t.unread ? "text-foreground" : "text-muted-foreground")}>{listDate(t.lastDate)}</span>
        </span>
      </div>
      {!compact && (
        <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-sm">
          <span data-testid="row-subject" className={cn("shrink-0 truncate", t.unread ? "font-medium text-foreground" : "text-foreground")} style={{ maxWidth: "60%" }}>
            {t.subject || "(sin asunto)"}
          </span>
          <span className="min-w-0 truncate text-muted-foreground">{t.snippet}</span>
        </div>
      )}
    </div>
  );
});
