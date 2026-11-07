import { CheckboxMark } from "@terno/ui/components/checkbox";
import { toggleRow, useActionRows } from "~/state/action-preview";
import { listFilterOf, matchesFilter, matchFocus, mostUrgent, type CategoryColor, type RowMatch, type ThreadSummary } from "@terno/core";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { cn } from "@terno/ui/lib/utils";
import { Bell, Check, Paperclip, Star } from "@terno/ui/icons";
import { memo } from "react";
import { formatList, formatNumber, t } from "@terno/i18n";
import { listDate } from "~/lib/format";
import { renderProbe } from "~/lib/render-probe";
import { useHasDraft } from "~/lib/drafts";
import { pressRow, releaseRow } from "~/lib/select";
import { activeFilter } from "~/lib/unread-filter";
import { useApp, type AppState } from "~/state/app";
import { accountLabels, type AccountLabel } from "~/lib/account-labels";
import type { ReminderInfo } from "@terno/core/rpc";
import type { DesignVariants } from "@terno/ui/designs/index";
import { SenderAvatar } from "./sender-avatar";
import { CodeChip } from "./code-chip";
import { Marked } from "./match-mark";
import { ReviewControls } from "./review-actions";
import { useThreadCode } from "~/lib/codes";
import { reminderShort, useReminders } from "~/lib/reminders";
import { rowLine } from "~/lib/followups";
import { useFollowups } from "~/state/followups";
import { onlyOnTop } from "~/state/list";
import { useExcerpts } from "~/state/excerpts";

interface Props {
  thread: ThreadSummary;
  top: number;
  height: number;
  compact: boolean;
  /** plan 24: List's full-width list, one line with the senders in a column (Gmail's); compact density is one line already */
  wide?: boolean;
  /** List: nothing is open while the rows show, so the cursor is a place, not the selection's fill */
  quietCursor?: boolean;
  showAccount: boolean;
  /** plan 22: the sender's icon may be asked for (never in spam) */
  icons: boolean;
  /** the design's row layout (plan 15) */
  layout: DesignVariants["row"];
  /** plan 80: the category whose suggestions this list reviews (its rows answer them) */
  review?: number | null;
  /** plan 87: one of the Inbox's top (its reminder is due): its time slot says so */
  reminderTop?: boolean;
  /** the top's last row: the hairline under the top replaces its own separator */
  reminderEnd?: boolean;
  /** plan 158: in a search's results, what to mark on the row (one object per search) */
  match?: RowMatch | null;
}

/**
 * A list row. Cheap by design: no tooltips or Base UI primitives inside (the
 * context menu wraps the whole list); the selected/checked state is a
 * per-row selector so moving the selection re-renders exactly two rows and
 * checking one re-renders one. The design picks the layout inside it (classic,
 * avatar, large avatar); the shell, roles, ids and handlers are the same in all.
 */
export const ThreadRow = memo(function ThreadRow({ thread, top, height, compact, wide = false, quietCursor = false, showAccount, icons, layout, review = null, reminderTop = false, reminderEnd = false, match = null }: Props) {
  renderProbe("ThreadRow");
  /** the open thread (the cursor; the listbox's active descendant) */
  const selected = useApp((s) => s.selectedId === thread.id);
  // "select all N" checks every row, loaded later or not ("all N unread": not a read row the filter kept in place)
  // plan 87: nor a row the Inbox shows only for its reminder
  const inScope = (s: AppState) => s.scope !== null && matchesFilter(listFilterOf(s.scope.scope), thread) && !onlyOnTop(thread);
  const checked = useApp((s) => inScope(s) || s.checked.has(thread.id));
  // what assistive tech hears as selected: the checked rows, or the open thread when nothing is checked
  const inSelection = useApp((s) => inScope(s) || s.checked.has(thread.id) || (s.selectedId === thread.id && s.checked.size === 0));
  // one object per account, kept while it doesn't change (accountLabels): sync-state events re-render no row
  const account = useApp((s) => (showAccount ? accountLabels(s.accounts).get(thread.accountId) : undefined));
  const categories = useApp((s) => s.categories);
  /** kept in a filtered list only because it's open: it says so, or it reads as the filter's mistake (only the open row looks) */
  const kept = useApp((s) => {
    if (s.selectedId !== thread.id) return false;
    const filter = activeFilter(s);
    return filter !== undefined && !matchesFilter(filter, thread);
  });
  /** the category this list is: its rows needn't say so */
  const inCategory = useApp((s) => (s.query.trim() ? null : s.categoryId));
  /** a draft with something written in it (one boolean: only this row renders when it changes) */
  const hasDraft = useHasDraft(thread.id);
  /** plan 72: a verification code in fresh mail, one click from the clipboard */
  const code = useThreadCode(thread);
  /** plan 87: its reminder (one Map read; a row without one never re-renders for them) */
  const reminder = useReminders((s) => s.byThread.get(thread.id));
  /** the Reminders list's date is the reminder's */
  const remindersList = useApp((s) => s.reminders);
  /** plan 143: in a sentence's preview, whether this row is in it (only this row renders when it changes) */
  const previewing = useApp((s) => s.actionPreview !== null);
  const unticked = useActionRows((s) => previewing && s.unticked.has(thread.id));
  /** plan 158: the sentence it matched in, when its own words don't show it (one Map read: only this row renders when it comes) */
  const excerpt = useExcerpts((s) => (match && s.match === match ? s.byThread.get(thread.id) : undefined));
  return (
    <ThreadRowView
      thread={thread}
      top={top}
      height={height}
      compact={compact}
      wide={wide}
      quietCursor={quietCursor}
      icons={icons}
      layout={layout}
      reminderTop={reminderTop}
      reminderEnd={reminderEnd}
      selected={selected}
      checked={checked}
      included={previewing ? !unticked : undefined}
      inSelection={inSelection}
      account={account}
      categories={categories}
      inCategory={inCategory}
      kept={kept}
      hasDraft={hasDraft}
      code={code}
      reminder={reminder}
      remindersList={remindersList}
      review={review}
      match={match}
      excerpt={excerpt}
      interactive
    />
  );
});

type ViewProps = Omit<Props, "showAccount" | "wide" | "review" | "reminderTop" | "reminderEnd" | "match"> & {
  match?: RowMatch | null;
  excerpt?: string;
  wide: boolean;
  review: number | null;
  reminderTop: boolean;
  reminderEnd: boolean;
  selected: boolean;
  checked: boolean;
  /** plan 143: the row of a preview, in or out; its check is its own */
  included?: boolean;
  inSelection: boolean;
  account: AccountLabel | undefined;
  categories: AppState["categories"];
  inCategory?: number | null;
  kept?: boolean;
  hasDraft: boolean;
  code: string | null;
  reminder: ReminderInfo | undefined;
  remindersList: boolean;
  /** the list's rows press and release (selection); a preview's never do */
  interactive: boolean;
};

/**
 * A row's markup from explicit state, nothing read from the stores: the list
 * renders it through ThreadRow (its selectors), plan 98's first-run preview
 * with sample mail.
 */
/**
 * The row's second line. Plan 142: on the Inbox's top and in its own list, what's owed takes its place, in the attention
 * ink. One Map read: a row with nothing owed never re-renders for follow-ups.
 */
function useOwed(thread: Pick<ThreadSummary, "id">, reminderTop?: boolean) {
  const followupsList = useApp((s) => s.followups);
  const owed = useFollowups((s) => s.byThread.get(thread.id));
  const shows = !!owed && (followupsList || (reminderTop && owed.some((r) => r.inboxState === "onTop")));
  return { line: shows ? rowLine(owed) : null, dueAt: shows ? (mostUrgent(owed)?.dueAt ?? null) : null };
}

/** How far into its line a match may stand: near the start, so it shows whole on the narrowest row (a 1100 px window, an account beside it). */
const LEAD = { own: 12, wide: 40 };

/** The row's words after the subject in a search: from near the match, the match marked. */
function matchLine(match: RowMatch | null | undefined, text: string, lead: number) {
  return match ? <Marked text={matchFocus(text, match.body, lead)} needles={match.body} /> : text;
}

function RowSnippet({ thread, reminderTop, ink, quiet, match, excerpt, lead }: { thread: ThreadSummary; reminderTop?: boolean; ink: string; quiet: string; match?: RowMatch | null; excerpt?: string; lead: number }) {
  const { line } = useOwed(thread, reminderTop);
  return (
    <span data-testid="row-snippet" data-followup={line ? true : undefined} data-excerpt={!line && excerpt ? true : undefined} className={cn("type-row-snippet min-w-0 truncate", line ? ink : quiet)}>
      {line ?? matchLine(match, excerpt ?? thread.snippet, lead)}
    </span>
  );
}

/** A wide row's preview: a column of its own, a step smaller than the subject and in the quiet ink, and the first thing cut. */
function WideSnippet({ thread, reminderTop, ink, quiet, match, excerpt }: { thread: ThreadSummary; reminderTop?: boolean; ink: string; quiet: string; match?: RowMatch | null; excerpt?: string }) {
  const { line } = useOwed(thread, reminderTop);
  return (
    <span data-testid="row-snippet" data-followup={line ? true : undefined} data-excerpt={!line && excerpt ? true : undefined} className={cn("min-w-0 flex-1 truncate text-xs", line ? ink : quiet)}>
      {line ?? matchLine(match, excerpt ?? thread.snippet, LEAD.wide)}
    </span>
  );
}

/** A one-line row's words after the subject: the same line, where it reads the same; apart from the subject by ink and space, no dash (subjects have their own). */
function RowTail({ thread, reminderTop, ink, quiet, match, excerpt }: { thread: ThreadSummary; reminderTop?: boolean; ink: string; quiet: string; match?: RowMatch | null; excerpt?: string }) {
  const { line } = useOwed(thread, reminderTop);
  return <span data-testid="row-snippet" data-followup={line ? true : undefined} className={cn("type-row-snippet ml-2", line ? ink : quiet)}>{line ?? matchLine(match, excerpt ?? thread.snippet, LEAD.wide)}</span>;
}

/** On the Inbox's top and in its own list, the date a row shows is when it's owed. */
function RowDate({ thread, reminderTop, fallback, className, title }: { thread: ThreadSummary; reminderTop?: boolean; fallback: string; className: string; title?: string }) {
  const { dueAt } = useOwed(thread, reminderTop);
  return <span data-testid="row-date" data-due-at={dueAt ?? undefined} title={title} className={className}>{dueAt !== null ? reminderShort(dueAt) : fallback}</span>;
}

export function ThreadRowView({ thread, top, height, compact, wide, quietCursor = false, icons, layout, review, reminderTop, reminderEnd, selected, checked, included, inSelection, account, categories, inCategory = null, kept = false, hasDraft, code, reminder, remindersList, interactive, match, excerpt }: ViewProps) {
  const cats = thread.categoryIds.length ? categories.filter((c) => c.id !== inCategory && thread.categoryIds.includes(c.id)) : [];
  const classic = layout === "classic";
  const big = layout === "large-avatar";
  /** the open thread's fill and ink: not List's cursor, which only marks a place */
  const opened = selected && !quietCursor;
  /** one line: compact density, or a wide list */
  const line = compact || wide;
  /** where it lives when that isn't where mail usually is (Trash wins: trashed spam is in the trash) */
  const place = thread.inTrash ? "trash" : thread.inSpam ? "spam" : null;

  // unread reads first: a stronger sender and subject, one dot. Read is quieter
  const readInk = "text-row-read";
  const quiet = "text-muted-foreground";
  const from = (
    <span data-testid="row-from" className={cn("min-w-0 truncate", thread.unread ? "type-row-from-strong" : cn("type-row-from", readInk))}>
      <Marked text={thread.fromName} needles={match?.from} />
    </span>
  );
  const count = thread.messageCount > 1 && <span className="text-xs text-muted-foreground tabular">{formatNumber(thread.messageCount)}</span>;
  const clip = thread.hasAttachments && <Paperclip className="size-3 text-muted-foreground" />;
  const star = thread.starred && <Star className="size-3 fill-star text-star" />;
  const dots = cats.map((c) => <CategoryDot key={c.id} data-cat-dot={c.id} color={c.color as CategoryColor} title={c.name} />);
  // plan 87: due, in the accent (the Inbox's top); set, quiet
  const bell = reminder && <Bell aria-hidden data-testid="row-reminder" data-due={reminder.due || undefined} className={cn("size-3 shrink-0", opened || checked ? "" : reminder.due ? "text-primary" : "text-muted-foreground")} />;
  // plan 64: a search looks everywhere, so a row in Spam or Trash says so (quiet, before the date; said once at the end)
  const placeTag = place && (
    <span aria-hidden data-testid="row-place" data-place={place} className={"shrink-0 text-2xs text-muted-foreground"}>
      {t(place === "spam" ? "list.place.spam" : "list.place.trash")}
    </span>
  );
  const keptTag = kept && <span data-testid="row-kept" className="shrink-0 text-2xs text-muted-foreground">{t("list.kept")}</span>;
  const marks = (
    <>
      {dots}
      {clip}
      {star}
      {!reminderTop && bell}
      {placeTag}
      {keptTag}
    </>
  );
  // a wide row has the room to name a category, not only to color it; narrower, its dot is the column
  const wideCategory = wide && (
    <span title={cats.map((c) => c.name).join(", ") || undefined} className="flex w-[5.5rem] items-center gap-1.5 @max-[58rem]/rows:w-[1.375rem]">
      {/* two at most in this slot: every name is in the title and said to a screen reader */}
      {dots.slice(0, 2)}
      {cats[0] && <span aria-hidden className={cn("min-w-0 truncate text-xs @max-[58rem]/rows:hidden", quiet)}>{cats[0].name}</span>}
    </span>
  );
  // Apple Mail's "to which account" (plan 23): quiet text, at the end of the preview's line (a column of its own in a wide list, the first to go there when width is short, before the date in
  // compact), within a share of the line so the preview keeps the rest; an address truncates its local part first (shrink 100 to 1: a factor under 1 leaves overflow unresolved), then its @domain. Screen readers get it once, at the end.
  const accountTag = account && (
    <span
      aria-hidden
      data-testid="account-label"
      title={account.email}
      className={cn(
        "flex min-w-0 shrink-0 items-center self-center text-xs",
        quiet,
        wide ? "w-20 @max-[52rem]/rows:hidden" : line ? "max-w-[min(7rem,32%)]" : "ml-auto max-w-[min(8rem,40%)] pl-2",
      )}
    >
      {account.local !== undefined ? (
        <>
          <span className="min-w-[1ch] shrink-[100] truncate">{account.local}</span>
          <span className="min-w-0 truncate">{account.domain}</span>
        </>
      ) : (
        <span className="min-w-0 truncate">{account.text}</span>
      )}
    </span>
  );
  const date =
    reminderTop && reminder?.due ? (
      // plan 87: on the Inbox's top, the time it came back, in the attention ink (the mail's own date would read as out of order)
      <span data-testid="row-date" data-reminder className={cn("flex items-center gap-1 text-xs font-medium tabular", opened || checked ? "" : "text-unread-ink")}>
        <Bell aria-hidden data-testid="row-reminder" data-due className="size-3" />
        {listDate(reminder.dueAt)}
      </span>
    ) : (
      <RowDate thread={thread} reminderTop={reminderTop} title={remindersList && reminder?.kind === "noReply" ? t("remind.noReplySuffix") : undefined} className={cn("text-xs tabular", thread.unread ? "text-foreground" : "text-muted-foreground")} fallback={remindersList && reminder ? reminderShort(reminder.dueAt) : listDate(thread.lastDate)} />
    );
  // a small tag at the row's own scale: its line box is no taller than the subject's, so no line moves for it
  const draft = hasDraft && <span data-testid="row-draft" className="shrink-0 text-xs leading-none font-medium text-draft-foreground">{t("list.draft")}</span>;
  // the subject leads a read row: the sender's quieter ink, the preview quieter still
  const subjectInk = thread.unread ? "type-row-subject-strong text-foreground" : "type-row-subject text-foreground";
  // its own line: only a very long subject truncates
  const subject = (
    <span data-testid="row-subject" className={cn("min-w-0 truncate", subjectInk)}>
      {thread.subject ? <Marked text={thread.subject} needles={match?.subject} /> : t("common.noSubject")}
    </span>
  );
  // plan 142: gated on the row's every state, as Draft's ink is (contrast.ts)
  const owedInk = "text-draft-foreground";
  const snippet = <RowSnippet thread={thread} reminderTop={reminderTop} ink={owedInk} quiet={quiet} match={match} excerpt={excerpt} lead={LEAD.own} />;
  const chip = code && <CodeChip threadId={thread.id} code={code} />;
  const reviewed = review !== null ? categories.find((c) => c.id === review) : undefined;
  const answer = reviewed && <ReviewControls threadId={thread.id} categoryId={reviewed.id} category={reviewed.name} />;
  const avatar = !classic && (
    <span className={cn("shrink-0", !line && !big && "self-start mt-0.5")}>
      <SenderAvatar
        name={thread.fromName}
        email={thread.fromEmail}
        // plan 22: never an icon for spam, whatever the view or the search (nor until the backend says a row stopped being spam)
        icon={icons && !thread.inSpam && !thread.hasSpam && !thread.spamHeld}
        person={thread.person === true}
        className={
          compact
            ? "size-(--avatar-row-compact) text-[length:calc(var(--avatar-row-compact)*0.42)]"
            : wide
              ? "size-(--avatar-row-wide) text-[length:calc(var(--avatar-row-wide)*0.38)]"
              : "size-(--avatar-row) text-[length:calc(var(--avatar-row)*0.34)]"
        }
      />
    </span>
  );
  // one mark in every design and layout: in the gutter, on the sender's line, never on an avatar. In the batch, a check
  // takes the unread dot's place, centered where it is, moving nothing (the row's weight still says unread)
  const onSenderLine = line ? "top-1/2" : "top-[calc(var(--type-row-from-leading)/2)]";
  const dot =
    checked && included === undefined ? (
      <Check aria-hidden data-testid="row-check" className={cn("absolute -left-[13px] size-[11px] -translate-y-1/2 text-row-selected-foreground [--icon-line:1.5px]", onSenderLine)} />
    ) : (
      thread.unread && included === undefined && <span data-testid="row-unread-dot" className={cn("absolute -left-[11px] size-[7px] -translate-y-1/2 rounded-full bg-unread", onSenderLine)} />
    );
  // a three-line row's first line: its marks and date hold the right edge
  const firstLine = (
    <div className="flex min-w-0 items-center gap-1.5">
      {from}
      {count}
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
        {chip}
        {marks}
        {date}
      </span>
    </div>
  );
  // Apple Mail's three lines: who, what about, how it starts (plan 80: in Review, the answers take the preview's place, so they have the width)
  const lines = (
    <>
      {firstLine}
      <div className="flex min-w-0 items-baseline gap-1.5">
        {subject}
        {draft}
      </div>
      <div className="flex min-w-0 items-baseline">
        {answer || snippet}
        {!answer && accountTag}
      </div>
    </>
  );

  return (
    <div
      role="option"
      id={`thread-${thread.id}`}
      aria-selected={included ?? inSelection}
      data-cursor={selected || undefined}
      data-opened={opened || undefined}
      data-testid="thread-row"
      data-thread-id={thread.id}
      data-unread={thread.unread || undefined}
      data-messages={thread.messageCount > 1 ? thread.messageCount : undefined}
      data-checked={checked || undefined}
      data-included={included}
      data-layout={layout}
      data-wide={(wide && !compact) || undefined}
      onMouseDown={interactive ? (e) => e.button === 0 && pressRow(thread.id, { meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey }) : undefined}
      onClick={interactive ? (e) => !e.metaKey && !e.ctrlKey && !e.shiftKey && releaseRow(thread.id) : undefined}
      className={cn(
        "group/row absolute left-0 w-full cursor-default px-5 select-none",
        "flex flex-col justify-center",
        // the selection is an inset, rounded shape (the design's radius)
        "before:absolute before:inset-x-2 before:inset-y-px before:rounded-(--row-radius)",
        // classic rows: one hairline separator, hidden under the selection and above it (rows render in list order, so the next sibling is the next row)
        classic && "after:absolute after:right-4 after:bottom-0 after:left-5 after:h-(--hairline-w) after:bg-hairline [&:has(+[data-checked])]:after:hidden [&:has(+[data-cursor])]:after:hidden",
        // plan 158: one selection, one look: every checked row, the first too, is the open row's shape and ink. Among
        // several, a cursor that's outside them only shows where it is, and by keys it's outlined (the list says when)
        opened || checked ? "text-row-selected-foreground before:bg-row-selected after:hidden" : selected ? "before:bg-muted after:hidden" : "hover:before:bg-row-hover",
        selected && !checked && "group-data-many/list:text-foreground group-data-many/list:before:bg-row-hover",
        selected && "group-data-keyed/list:before:shadow-[inset_0_0_0_1px_var(--ring)]",
        reminderEnd && "after:hidden",
        // the check takes the gutter, and the content line moves over as one
        included !== undefined && "pl-10",
        // left out: quiet, without going under the contrast a row's text must hold
        included === false && "[&>*:not([data-slot=checkbox])_*]:text-muted-foreground",
      )}
      style={{ transform: `translateY(${top}px)`, height }}
    >
      {included !== undefined && (
        // the row is the option and `x` its key: this is for the pointer, and says nothing the row doesn't
        <CheckboxMark data-testid="row-include" checked={included} className="absolute top-1/2 left-5 -translate-y-1/2" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); toggleRow(thread.id); }} />
      )}
      {wide ? (
        // a table: sender, subject, preview, then fixed columns on the right edge (account, category, attachment, star,
        // date), so the eye runs down each. What's narrow gives way from the left of them, the preview's width first
        <div className="relative flex min-w-0 items-center gap-3">
          {dot}
          {avatar}
          {/* the full-width list's code sits with the sender, out of the subject's way (plan 72) */}
          <span className="flex w-[clamp(8rem,15%,12rem)] shrink-0 items-center gap-1.5">
            {from}
            {count}
            {chip}
          </span>
          <span className="flex w-[clamp(11rem,30%,24rem)] shrink-0 items-center gap-1.5">
            <span data-testid="row-subject" className={cn("min-w-0 truncate", subjectInk)}>{thread.subject ? <Marked text={thread.subject} needles={match?.subject} /> : t("common.noSubject")}</span>
            {draft}
            {/* what a row is, not a column: beside the subject, so the columns on the right never move */}
            {keptTag}
            {placeTag}
            {reminder && !reminderTop && bell}
          </span>
          {answer ? <span className="flex min-w-0 flex-1 justify-end">{answer}</span> : <WideSnippet thread={thread} reminderTop={reminderTop} ink={owedInk} quiet={quiet} match={match} excerpt={excerpt} />}
          {accountTag}
          <span data-testid="row-marks" className="flex shrink-0 items-center justify-end gap-1.5">
            {wideCategory}
            <span className="flex w-3 justify-center">{clip}</span>
            <span className="flex w-3 justify-center">{star}</span>
          </span>
          <span className="flex w-[3.75rem] shrink-0 justify-end">{date}</span>
        </div>
      ) : line ? (
        <div className={cn("relative flex min-w-0 items-center", classic ? "gap-2" : "gap-2.5")}>
          {dot}
          {avatar}
          {from}
          {count}
          <span className="min-w-0 flex-1 truncate">
            <span data-testid="row-subject" className={subjectInk}>{thread.subject ? <Marked text={thread.subject} needles={match?.subject} /> : t("common.noSubject")}</span>
            {draft && <span className="ml-1.5">{draft}</span>}
            <RowTail thread={thread} reminderTop={reminderTop} ink={owedInk} quiet={quiet} match={match} excerpt={excerpt} />
          </span>
          {answer}
          {accountTag}
          {chip}
          <span className={cn("flex shrink-0 items-center gap-1.5", !answer && "ml-auto")}>
            {marks}
            {date}
          </span>
        </div>
      ) : classic ? (
        <div className="relative flex min-w-0 flex-col">
          {dot}
          {lines}
        </div>
      ) : (
        <div className={cn("relative flex min-w-0", big ? "items-center gap-3" : "gap-2.5")}>
          {dot}
          {avatar}
          <div className="flex min-w-0 flex-1 flex-col">{lines}</div>
        </div>
      )}
      {cats.length > 0 && <span className="sr-only">{formatList(cats.map((c) => c.name))}</span>}
      {place && <span className="sr-only">{t(place === "spam" ? "list.place.spam.sr" : "list.place.trash.sr")}</span>}
      {account && <span className="sr-only">{t("list.accountLabel.sr", { account: account.text })}</span>}
      {code && <span className="sr-only">{t("codes.sr", { code })}</span>}
      {reminder && <span className="sr-only">{reminder.due ? t("remind.due") : t("remind.pending")}</span>}
    </div>
  );
}
