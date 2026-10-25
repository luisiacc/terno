import type { CategoryColor, ThreadSummary } from "@terno/core";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { cn } from "@terno/ui/lib/utils";
import { Paperclip, Star } from "lucide-react";
import { memo } from "react";
import { listDate } from "~/lib/format";
import { renderProbe } from "~/lib/render-probe";
import { useHasDraft } from "~/lib/drafts";
import { pressRow, releaseRow } from "~/lib/select";
import { useApp, type AppState } from "~/state/app";

/** The account, in "Todas las cuentas": a small ring in its color (category dots are filled). */
const ACCOUNT_MARK: Record<CategoryColor, string> = {
  rose: "border-cat-rose",
  amber: "border-cat-amber",
  lime: "border-cat-lime",
  emerald: "border-cat-emerald",
  cyan: "border-cat-cyan",
  indigo: "border-cat-indigo",
  violet: "border-cat-violet",
  slate: "border-cat-slate",
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
  // "select all N" checks every row, loaded later or not ("all N unread": not a read row the filter kept)
  const inScope = (s: AppState) => s.scope !== null && (t.unread || !s.scope.scope.unreadOnly);
  const checked = useApp((s) => inScope(s) || s.checked.has(t.id));
  // what assistive tech hears as selected: the checked rows, or the open thread when nothing is checked
  const inSelection = useApp((s) => inScope(s) || s.checked.has(t.id) || (s.selectedId === t.id && s.checked.size === 0));
  const accountColor = useApp((s) => (showAccount ? s.accounts.find((a) => a.id === t.accountId)?.color : undefined)) as CategoryColor | undefined;
  const categories = useApp((s) => s.categories);
  /** a draft with something written in it (one boolean: only this row renders when it changes) */
  const hasDraft = useHasDraft(t.id);
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
      data-messages={t.messageCount > 1 ? t.messageCount : undefined}
      data-checked={checked || undefined}
      onMouseDown={(e) => e.button === 0 && pressRow(t.id, { meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey })}
      onClick={(e) => !e.metaKey && !e.ctrlKey && !e.shiftKey && releaseRow(t.id)}
      className={cn(
        "group/row absolute left-0 w-full cursor-default px-5 select-none",
        "flex flex-col justify-center",
        // the selection is an inset, rounded shape; one hairline separator, hidden under it
        "before:absolute before:inset-x-2 before:inset-y-px before:rounded-md",
        "after:absolute after:right-4 after:bottom-0 after:left-5 after:h-(--hairline-w) after:bg-hairline",
        // and above it (rows render in list order, so the next sibling is the next row)
        "[&:has(+[data-cursor])]:after:hidden [&:has(+[data-checked])]:after:hidden",
        selected ? "text-row-selected-foreground before:bg-row-selected after:hidden" : checked ? "before:bg-accent after:hidden" : "hover:before:bg-row-hover",
      )}
      style={{ transform: `translateY(${top}px)`, height }}
    >
      <span className={cn("absolute top-1/2 left-[11px] size-1.5 -translate-y-1/2 rounded-full bg-unread", !t.unread && "invisible")} />
      <div className="relative flex min-w-0 items-center gap-2">
        <span data-testid="row-from" className={cn("min-w-0 truncate text-sm", t.unread ? "font-semibold" : "font-normal text-foreground")}>{t.fromName}</span>
        {t.messageCount > 1 && <span className="text-xs text-muted-foreground tabular">{t.messageCount}</span>}
        {compact && (
          <span className={cn("min-w-0 flex-1 truncate text-sm", t.unread ? "text-foreground" : "text-muted-foreground")}>
            {t.subject} {hasDraft && <span className="font-medium text-draft-foreground">Borrador</span>} <span className="text-muted-foreground">— {t.snippet}</span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {cats.map((c) => (
            <CategoryDot key={c.id} data-cat-dot={c.id} color={c.color as CategoryColor} />
          ))}
          {t.hasAttachments && <Paperclip className="size-3 text-muted-foreground" />}
          {t.starred && <Star className="size-3 fill-star text-star" />}
          {accountColor && <span data-testid="account-mark" className={cn("size-1.5 shrink-0 rounded-full border-[1.5px]", ACCOUNT_MARK[accountColor])} />}
          <span className={cn("text-xs tabular", t.unread ? "text-foreground" : "text-muted-foreground")}>{listDate(t.lastDate)}</span>
        </span>
      </div>
      {!compact && (
        <div className="relative mt-0.5 flex min-w-0 items-baseline gap-1.5 text-sm">
          <span data-testid="row-subject" className={cn("shrink-0 truncate", t.unread ? "font-medium text-foreground" : "text-foreground")} style={{ maxWidth: "60%" }}>
            {t.subject || "(sin asunto)"}
          </span>
          {hasDraft && <span className="shrink-0 font-medium text-draft-foreground">Borrador</span>}
          <span className="min-w-0 truncate text-muted-foreground">{t.snippet}</span>
        </div>
      )}
    </div>
  );
});
