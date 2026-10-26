import { listFilterOf, matchesFilter, type CategoryColor, type ThreadSummary } from "@terno/core";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { cn } from "@terno/ui/lib/utils";
import { Paperclip, Star } from "lucide-react";
import { memo } from "react";
import { formatNumber, t } from "@terno/i18n";
import { listDate } from "~/lib/format";
import { renderProbe } from "~/lib/render-probe";
import { useHasDraft } from "~/lib/drafts";
import { pressRow, releaseRow } from "~/lib/select";
import { useApp, type AppState } from "~/state/app";
import { accountLabels } from "~/lib/account-labels";
import type { DesignVariants } from "@terno/ui/designs/index";
import { SenderAvatar } from "./sender-avatar";

/** The account, in all-accounts views: a small ring in its color (category dots are filled) before its name (plan 23). */
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

interface Props {
  thread: ThreadSummary;
  top: number;
  height: number;
  compact: boolean;
  showAccount: boolean;
  /** plan 22: the sender's icon may be asked for (never in spam) */
  icons: boolean;
  /** the design's row layout (plan 15) */
  layout: DesignVariants["row"];
}

/**
 * A list row. Cheap by design: no tooltips or Base UI primitives inside (the
 * context menu wraps the whole list); the selected/checked state is a
 * per-row selector so moving the selection re-renders exactly two rows and
 * checking one re-renders one. The design picks the layout inside it (classic,
 * avatar, large avatar); the shell, roles, ids and handlers are the same in all.
 */
export const ThreadRow = memo(function ThreadRow({ thread, top, height, compact, showAccount, icons, layout }: Props) {
  renderProbe("ThreadRow");
  /** the open thread (the cursor; the listbox's active descendant) */
  const selected = useApp((s) => s.selectedId === thread.id);
  // "select all N" checks every row, loaded later or not ("all N unread": not a read row the filter kept in place)
  const inScope = (s: AppState) => s.scope !== null && matchesFilter(listFilterOf(s.scope.scope), thread);
  const checked = useApp((s) => inScope(s) || s.checked.has(thread.id));
  // what assistive tech hears as selected: the checked rows, or the open thread when nothing is checked
  const inSelection = useApp((s) => inScope(s) || s.checked.has(thread.id) || (s.selectedId === thread.id && s.checked.size === 0));
  // one object per account, kept while it doesn't change (accountLabels): sync-state events re-render no row
  const account = useApp((s) => (showAccount ? accountLabels(s.accounts).get(thread.accountId) : undefined));
  const categories = useApp((s) => s.categories);
  /** a draft with something written in it (one boolean: only this row renders when it changes) */
  const hasDraft = useHasDraft(thread.id);
  const cats = thread.categoryIds.length ? categories.filter((c) => thread.categoryIds.includes(c.id)) : [];
  const classic = layout === "classic";
  const big = layout === "large-avatar";

  const from = (
    <span data-testid="row-from" className={cn("min-w-0 truncate", thread.unread ? "type-row-from-strong" : "type-row-from text-foreground")}>
      {thread.fromName}
    </span>
  );
  const count = thread.messageCount > 1 && <span className="text-xs text-muted-foreground tabular">{formatNumber(thread.messageCount)}</span>;
  const marks = (
    <>
      {cats.map((c) => (
        <CategoryDot key={c.id} data-cat-dot={c.id} color={c.color as CategoryColor} />
      ))}
      {thread.hasAttachments && <Paperclip className="size-3 text-muted-foreground" />}
      {thread.starred && <Star className="size-3 fill-star text-star" />}
    </>
  );
  // Apple Mail's "to which account" (plan 23): muted, under the date (before it in compact), within a share of the line so the
  // subject always keeps the rest; an address truncates its local part before its @domain. Screen readers get it once, at the end.
  const accountTag = account && (
    <span
      aria-hidden
      data-testid="account-label"
      title={account.email}
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1 self-center text-2xs",
        // a checked row is on the accent (muted text isn't checked there): its own foreground
        checked && !selected ? "text-accent-foreground" : "text-muted-foreground",
        compact ? "max-w-[min(7rem,32%)]" : "ml-auto max-w-[min(9rem,45%)] pl-1",
      )}
    >
      <span data-testid="account-mark" className={cn("size-1.5 shrink-0 rounded-full border-[1.5px]", ACCOUNT_MARK[account.color])} />
      {account.local !== undefined ? (
        <>
          <span className="min-w-[1ch] truncate">{account.local}</span>
          <span className="min-w-0 shrink-[0.01] truncate">{account.domain}</span>
        </>
      ) : (
        <span className="min-w-0 truncate">{account.text}</span>
      )}
    </span>
  );
  const date = (
    <span data-testid="row-date" className={cn("text-xs tabular", thread.unread ? "text-foreground" : "text-muted-foreground")}>
      {listDate(thread.lastDate)}
    </span>
  );
  const draft = hasDraft && <span className="shrink-0 font-medium text-draft-foreground">{t("list.draft")}</span>;
  const subject = (
    <span data-testid="row-subject" className={cn("truncate", classic && "shrink-0", thread.unread ? "type-row-subject-strong text-foreground" : "type-row-subject text-foreground")} style={classic ? { maxWidth: "60%" } : undefined}>
      {thread.subject || t("common.noSubject")}
    </span>
  );
  const snippet = (
    <span data-testid="row-snippet" className="type-row-snippet min-w-0 truncate text-muted-foreground">
      {thread.snippet}
    </span>
  );
  const avatar = !classic && (
    <span className={cn("relative shrink-0", !compact && !big && "self-start mt-0.5")}>
      <SenderAvatar
        name={thread.fromName}
        email={thread.fromEmail}
        icon={icons}
        className={compact ? "size-(--avatar-row-compact) text-[length:calc(var(--avatar-row-compact)*0.42)]" : "size-(--avatar-row) text-[length:calc(var(--avatar-row)*0.3)]"}
      />
      {/* Lumen: what's new sits on the person, ringed in what's behind the row */}
      {big && !compact && thread.unread && (
        <span data-testid="row-unread-dot" className={cn("absolute -top-0.5 -left-0.5 size-3 rounded-full bg-unread ring-2", selected ? "ring-row-selected" : checked ? "ring-accent" : "ring-pane")} />
      )}
    </span>
  );

  return (
    <div
      role="option"
      id={`thread-${thread.id}`}
      aria-selected={inSelection}
      data-cursor={selected || undefined}
      data-testid="thread-row"
      data-thread-id={thread.id}
      data-unread={thread.unread || undefined}
      data-messages={thread.messageCount > 1 ? thread.messageCount : undefined}
      data-checked={checked || undefined}
      data-layout={layout}
      onMouseDown={(e) => e.button === 0 && pressRow(thread.id, { meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey })}
      onClick={(e) => !e.metaKey && !e.ctrlKey && !e.shiftKey && releaseRow(thread.id)}
      className={cn(
        "group/row absolute left-0 w-full cursor-default px-5 select-none",
        "flex flex-col justify-center",
        // the selection is an inset, rounded shape (the design's radius)
        "before:absolute before:inset-x-2 before:inset-y-px before:rounded-(--row-radius)",
        // classic rows: one hairline separator, hidden under the selection and above it (rows render in list order, so the next sibling is the next row)
        classic && "after:absolute after:right-4 after:bottom-0 after:left-5 after:h-(--hairline-w) after:bg-hairline [&:has(+[data-checked])]:after:hidden [&:has(+[data-cursor])]:after:hidden",
        selected ? "text-row-selected-foreground before:bg-row-selected after:hidden" : checked ? "before:bg-accent after:hidden" : "hover:before:bg-row-hover",
      )}
      style={{ transform: `translateY(${top}px)`, height }}
    >
      {!(big && !compact) && <span className={cn("absolute top-1/2 left-[11px] size-1.5 -translate-y-1/2 rounded-full bg-unread", !thread.unread && "invisible")} />}
      {compact ? (
        <div className={cn("relative flex min-w-0 items-center", classic ? "gap-2" : "gap-2.5")}>
          {avatar}
          {from}
          {count}
          <span className={cn("type-row-subject min-w-0 flex-1 truncate", thread.unread ? "text-foreground" : "text-muted-foreground")}>
            {thread.subject} {draft} <span className="text-muted-foreground">— {thread.snippet}</span>
          </span>
          {accountTag}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {marks}
            {date}
          </span>
        </div>
      ) : classic ? (
        <>
          <div className="relative flex min-w-0 items-center gap-2">
            {from}
            {count}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {marks}
              {date}
            </span>
          </div>
          <div className="relative mt-0.5 flex min-w-0 items-baseline gap-1.5 text-sm">
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              {subject}
              {draft}
              {snippet}
            </span>
            {accountTag}
          </div>
        </>
      ) : (
        <div className={cn("relative flex min-w-0", big ? "items-center gap-3.5" : "gap-3")}>
          {avatar}
          <div className={cn("flex min-w-0 flex-1 flex-col", !big && "gap-0.5")}>
            <div className="flex min-w-0 items-center gap-1.5">
              {from}
              {count}
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {!big && marks}
                {date}
              </span>
            </div>
            <div className="flex min-w-0 items-baseline gap-1.5 text-sm">
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                {subject}
                {draft}
              </span>
              {accountTag}
            </div>
            <div className={cn("flex min-w-0 items-center gap-1.5", big && "mt-0.5")}>
              {snippet}
              {big && <span className="ml-auto flex shrink-0 items-center gap-1.5">{marks}</span>}
            </div>
          </div>
        </div>
      )}
      {account && <span className="sr-only">{t("list.accountLabel.sr", { account: account.text })}</span>}
    </div>
  );
});
