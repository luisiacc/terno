import { CheckboxMark } from "@terno/ui/components/checkbox";
import { toggleRow, useActionPreview, useActionRows } from "~/state/action-preview";
import { listFilterOf, matchesFilter, matchFocus, mostUrgent, type CategoryColor, type RowMatch, type ThreadSummary } from "@terno/core";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { cn } from "@terno/ui/lib/utils";
import { Bell, Check, Paperclip, Star } from "@terno/ui/icons";
import { memo } from "react";
import { formatList, formatNumber, t } from "@terno/i18n";
import { listDate } from "~/lib/format";
import { renderProbe } from "~/lib/render-probe";
import { useHasDraft } from "~/lib/drafts";
import { pickRow, pressRow, releaseRow } from "~/lib/select";
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
import { useToday } from "~/state/today";
import { onlyOnTop } from "~/state/list";
import { useExcerpts } from "~/state/excerpts";

interface Props {
  thread: ThreadSummary;
  top: number;
  height: number;
  compact: boolean;
  /** plan 24: List's full-width list, one line with the senders in a column (Gmail's); compact density is one line already */
  wide?: boolean;
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
  /** plan 24: List's rows offer the pointer a checkbox, in the avatar's place or the marks' column */
  pick?: boolean;
  /** plan 162 (Codex review): the first row of a Today section says the section's name to assistive tech (a heading can't sit in a listbox) */
  section?: string;
}

/**
 * A list row. Cheap by design: no tooltips or Base UI primitives inside (the
 * context menu wraps the whole list); the selected/checked state is a
 * per-row selector so moving the selection re-renders exactly two rows and
 * checking one re-renders one. The design picks the layout inside it (classic,
 * avatar, large avatar); the shell, roles, ids and handlers are the same in all.
 */
export const ThreadRow = memo(function ThreadRow({ thread, top, height, compact, wide = false, showAccount, icons, layout, review = null, reminderTop = false, reminderEnd = false, match = null, pick = false, section }: Props) {
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
  /** plan 162 (after ai162-r03): while the AI check waits, a row is a candidate, not yet what Apply takes */
  const pending = useActionPreview((s) => previewing && s.preview?.check === "needed");
  /** plan 158: the sentence it matched in, when its own words don't show it (one Map read: only this row renders when it comes) */
  const excerpt = useExcerpts((s) => (match && s.match === match ? s.byThread.get(thread.id) : undefined));
  return (
    <ThreadRowView
      thread={thread}
      top={top}
      height={height}
      compact={compact}
      wide={wide}
      icons={icons}
      layout={layout}
      reminderTop={reminderTop}
      reminderEnd={reminderEnd}
      selected={selected}
      checked={checked}
      included={previewing ? !unticked : undefined}
      pending={pending || undefined}
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
      pick={pick}
      section={section}
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
  /** plan 162 (after ai162-r03): a preview's row the AI check hasn't decided yet: quiet, as a left-out row */
  pending?: boolean;
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

/**
 * Plan 158, one selection language. Every chosen row has the same fill (`ROW_SHAPE`, from 4 px: the gutter it leaves
 * before the 20 px text line is the marks' column). The marks share that column, centred 12 px in: the unread dot or a
 * checked row's check, never both. The open row is its fill alone (no rail: the owner's call). What keys or a menu act on is outlined in the focus ring.
 */
export const ROW_SHAPE = "before:absolute before:inset-y-px before:right-2 before:left-1 before:rounded-(--row-radius)";
/** j/k's place among several checked rows, and the row a menu is for: the focus ring, inside the shape */
export const ROW_OUTLINE = "inset 0 0 0 2px var(--ring)";

/** How far into its line a match may stand: near the start, so it shows whole on the narrowest row (a 1100 px window, an account beside it). */
const LEAD = { own: 12, wide: 40 };

/** The row's words after the subject in a search: from near the match, the match marked. */
function matchLine(match: RowMatch | null | undefined, text: string, lead: number) {
  return match ? <Marked text={matchFocus(text, match.body, lead)} needles={match.body} /> : text;
}

/**
 * Plan 161, pass 2: why Today lists a waiting row ("Your turn"), a label of its own before the row's words, so it doesn't
 * read as the mail's first words. Pass 3: in the row's secondary ink at medium weight. Plan 162: in the ink at the row's
 * own weight, under the subject (medium) in strength and over the snippet in colour. One Map read.
 */
function useReason(thread: Pick<ThreadSummary, "id">): string | undefined {
  const inToday = useApp((s) => s.today);
  const today = useToday((s) => (inToday ? s.reasons.get(thread.id) : undefined));
  // plan 162 (after ai162-r05): in an action's preview, why a shown row isn't plainly a match, in the same place and
  // look as Today's reason (the left-out and the starred or replied rows read as the matches: two reports)
  // only inside a preview: a page that answers after Cancel can't put a tag on an ordinary mailbox's row (Codex review)
  const previewing = useApp((s) => s.actionPreview !== null);
  const tag = useActionRows((s) => (previewing ? s.tags.get(thread.id) : undefined));
  return today ?? (tag ? t(`action.row.${tag}`) : undefined);
}

/** The row's words, with Today's reason ahead of them when there is one: the reason keeps its place, the words truncate. */
function withReason(reason: string | undefined, quiet: string, ink: string, words: React.ReactNode): React.ReactNode {
  if (!reason) return words;
  return (
    <>
      {/* plan 162 (after ai162-r02): the reason is words, never a box (the outlined tag was the loudest thing in every row),
          then a "·", then the mail's words. After ai162-r04: in the row's ink at medium weight, so it leads the line and
          never reads as the snippet's first words (eight reports: the same grey as the preview) */}
      {/* after ai162-r05: the two reasons say the user's next step, and look apart: "Your turn: they replied" in the ink,
          "Waiting for your reply" in the quiet one, both at medium weight (they were one look: four reports) */}
      <span data-testid="row-why" className={cn(reason === t("today.why.newFrom") || reason === t("action.row.leftOut") ? quiet : ink, "font-medium")}>{reason}</span>
      <span aria-hidden className={quiet}> · </span>
      <span className={quiet}>{words}</span>
    </>
  );
}

function RowSnippet({ thread, reminderTop, ink, quiet, match, excerpt, lead }: { thread: ThreadSummary; reminderTop?: boolean; ink: string; quiet: string; match?: RowMatch | null; excerpt?: string; lead: number }) {
  const { line } = useOwed(thread, reminderTop);
  const reason = useReason(thread);
  return (
    <span data-testid="row-snippet" data-followup={line ? true : undefined} data-excerpt={!line && excerpt ? true : undefined} className={cn("type-row-snippet min-w-0 truncate", line ? ink : reason ? undefined : quiet)}>
      {line ?? withReason(reason, quiet, ink, matchLine(match, excerpt ?? thread.snippet, lead))}
    </span>
  );
}

/** A wide row's preview: after the subject's column, a step smaller and in the quiet ink, and the first thing cut. */
function WideSnippet({ thread, reminderTop, ink, quiet, match, excerpt }: { thread: ThreadSummary; reminderTop?: boolean; ink: string; quiet: string; match?: RowMatch | null; excerpt?: string }) {
  const { line } = useOwed(thread, reminderTop);
  const reason = useReason(thread);
  return (
    <span data-testid="row-snippet" data-followup={line ? true : undefined} data-excerpt={!line && excerpt ? true : undefined} className={cn("min-w-0 flex-1 truncate text-xs", line ? ink : reason ? undefined : quiet)}>
      {line ?? withReason(reason, quiet, ink, matchLine(match, excerpt ?? thread.snippet, LEAD.wide))}
    </span>
  );
}

/** A one-line row's words after the subject's column: the same line, where it reads the same; apart from the subject by ink and space, no dash (subjects have their own). */
function RowTail({ thread, reminderTop, ink, quiet, match, excerpt }: { thread: ThreadSummary; reminderTop?: boolean; ink: string; quiet: string; match?: RowMatch | null; excerpt?: string }) {
  const { line } = useOwed(thread, reminderTop);
  const reason = useReason(thread);
  return <span data-testid="row-snippet" data-followup={line ? true : undefined} className={cn("type-row-snippet min-w-0 flex-1 truncate", line ? ink : reason ? undefined : quiet)}>{line ?? withReason(reason, quiet, ink, matchLine(match, excerpt ?? thread.snippet, LEAD.wide))}</span>;
}

/**
 * Plan 160: a one-line row's subject sits in a column of the list's width (cqw: the same on every row, whatever its
 * sender or marks take), its Draft, place and reminder marks at the column's end, so every preview starts at one x and
 * the eye runs down subjects and previews apart. CSS only: no row measures anything. Short of room the preview goes
 * first (it has no basis), then the column shrinks: nothing paints over the date.
 */
const SUBJECT_COLUMN = "flex w-[clamp(9rem,30cqw,26rem)] min-w-0 shrink items-center gap-1.5";
/** A compact row's sender, a column of the list's width too (a wide row's is the table's own) */
const SENDER_COLUMN = "flex w-[clamp(5rem,24cqw,11rem)] min-w-0 shrink items-center gap-1.5";
const COMPACT_SUBJECT = "flex w-[clamp(6rem,30cqw,22rem)] min-w-0 shrink items-center gap-1.5";

/** On the Inbox's top and in its own list, the date a row shows is when it's owed. */
function RowDate({ thread, reminderTop, fallback, className, title }: { thread: ThreadSummary; reminderTop?: boolean; fallback: string; className: string; title?: string }) {
  const { dueAt } = useOwed(thread, reminderTop);
  return <span data-testid="row-date" data-due-at={dueAt ?? undefined} title={title} className={className}>{dueAt !== null ? reminderShort(dueAt) : fallback}</span>;
}

export function ThreadRowView({ thread, top, height, compact, wide, icons, layout, review, reminderTop, reminderEnd, selected, checked, included, pending, inSelection, account, categories, inCategory = null, kept = false, hasDraft, code, reminder, remindersList, interactive, match, excerpt, pick = false, section }: ViewProps) {
  const cats = thread.categoryIds.length ? categories.filter((c) => c.id !== inCategory && thread.categoryIds.includes(c.id)) : [];
  const classic = layout === "classic";
  const big = layout === "large-avatar";
  /** the open thread's fill, ink and rail: List's cursor too, the row Enter opens (plan 158: one look in both layouts) */
  const opened = selected;
  /** one line: compact density, or a wide list */
  const line = compact || wide;
  /** where it lives when that isn't where mail usually is (Trash wins: trashed spam is in the trash) */
  const place = thread.inTrash ? "trash" : thread.inSpam ? "spam" : null;

  // plan 158: who, then what, then how it starts: sender and subject in the row's ink (the sender a step heavier), the
  // preview and meta quiet. Unread reads first, by more than one cue: a stronger sender and subject, the dot (8 px), and
  // its date in the ink at medium where a read row's is quiet
  const quiet = "text-muted-foreground";
  const from = (
    <span data-testid="row-from" className={cn("min-w-0 truncate", thread.unread ? "type-row-from-strong" : "type-row-from")}>
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
  // a wide row names its category, never only colors it (plan 158): narrower, the account column goes first, and on the
  // narrowest the name is shorter, not gone
  const wideCategory = wide && (
    <span title={cats.map((c) => c.name).join(", ") || undefined} className="flex w-[5.5rem] items-center gap-1.5 @max-[46rem]/rows:w-16">
      {/* two at most in this slot: every name is in the title and said to a screen reader */}
      {dots.slice(0, 2)}
      {cats[0] && <span aria-hidden data-testid="row-category" className={cn("min-w-0 truncate text-xs", quiet)}>{cats[0].name}</span>}
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
        wide ? "w-20 @max-[58rem]/rows:hidden" : line ? "max-w-[min(7rem,32%)]" : "ml-auto max-w-[min(8rem,40%)] pl-2",
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
      <RowDate thread={thread} reminderTop={reminderTop} title={remindersList && reminder?.kind === "noReply" ? t("remind.noReplySuffix") : undefined} className={cn("text-xs tabular", thread.unread ? "font-medium text-foreground" : "text-muted-foreground")} fallback={remindersList && reminder ? reminderShort(reminder.dueAt) : listDate(thread.lastDate)} />
    );
  // a small tag at the row's own scale: its line box is no taller than the subject's, so no line moves for it
  const draft = hasDraft && <span data-testid="row-draft" className="shrink-0 text-xs leading-none font-medium text-draft-foreground">{t("list.draft")}</span>;
  // the row's own ink (the open row's on its fill), so sender and subject never drift apart
  const subjectInk = thread.unread ? "type-row-subject-strong" : "type-row-subject";
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
  const answer = reviewed && <ReviewControls threadId={thread.id} category={reviewed.name} />;
  // plan 24: List gives the pointer a checkbox. It takes the avatar's place while the avatar is under the pointer, and on
  // every row once one is checked (the list's data-many: CSS, so starting a selection re-renders only the row checked);
  // with no avatar, a slot of the avatar's size under a hovered row. Instant, nothing moves. The row is the option and `x` its key:
  // this is for the pointer, and says nothing the row doesn't (no control inside an option)
  const picking = pick && interactive && included === undefined;
  const pickBox = (className: string) => (
    <CheckboxMark
      data-testid="row-pick"
      data-row-control
      checked={checked}
      className={cn("invisible group-data-many/list:visible", className)}
      // no row press (no cursor move, no drag), no text selected by ⇧; the keys go to the list, as a row's press sends
      // them (x and Esc act on what was checked, not on a search field), without scrolling it
      onMouseDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        e.currentTarget.closest<HTMLElement>("[role=listbox]")?.focus({ preventScroll: true });
      }}
      onClick={(e) => {
        e.stopPropagation();
        pickRow(thread.id, e.shiftKey);
      }}
    />
  );
  // plan 161: in a preview the avatar beside the check is the check column too
  const toggles = included !== undefined && interactive;
  const avatar = !classic && (
    <span
      className={cn("shrink-0", !line && !big && "self-start mt-0.5", picking && "group/pick relative")}
      data-testid={toggles ? "row-include-avatar" : undefined}
      onMouseDown={toggles ? (e) => { e.stopPropagation(); e.preventDefault(); e.currentTarget.closest<HTMLElement>("[role=listbox]")?.focus({ preventScroll: true }); } : undefined}
      onClick={toggles ? (e) => { e.stopPropagation(); toggleRow(thread.id); } : undefined}
    >
      <SenderAvatar
        name={thread.fromName}
        email={thread.fromEmail}
        // plan 22: never an icon for spam, whatever the view or the search (nor until the backend says a row stopped being spam)
        icon={icons && !thread.inSpam && !thread.hasSpam && !thread.spamHeld}
        person={thread.person === true}
        className={cn(
          compact
            ? "size-(--avatar-row-compact) text-[length:calc(var(--avatar-row-compact)*0.42)]"
            : wide
              ? "size-(--avatar-row-wide) text-[length:calc(var(--avatar-row-wide)*0.38)]"
              : "size-(--avatar-row) text-[length:calc(var(--avatar-row)*0.34)]",
          picking && "group-hover/pick:invisible group-data-many/list:invisible",
        )}
      />
      {/* (the box's hit area runs past it, never as far as the sender) */}
      {picking && pickBox("absolute inset-0 m-auto group-hover/pick:visible")}
    </span>
  );
  // one mark in every design and layout: on the marks' column (12 px into the row, 8 before the text), on the sender's
  // line, never on an avatar. A check takes the dot's place, moving nothing (the row's weight still says unread)
  const onSenderLine = line ? "top-1/2" : "top-[calc(var(--type-row-from-leading)/2)]";
  // List's checkbox says checked, so it needs no check beside it
  const dot =
    checked && included === undefined && !picking ? (
      <Check aria-hidden data-testid="row-check" className={cn("absolute -left-[14px] size-3 -translate-y-1/2 text-row-selected-foreground [--icon-line:1.5px]", onSenderLine)} />
    ) : (
      thread.unread && included === undefined && <span data-testid="row-unread-dot" className={cn("absolute -left-[12px] size-2 -translate-y-1/2 rounded-full bg-unread", onSenderLine)} />
    );
  // With no avatar, List's rows keep a slot of Lumen's wide avatar's size where one would be, at rest too, so nothing
  // moves for the box: the unread dot sits in it, and over a hovered row or while a selection is made the full box
  // takes its place (one mark per slot)
  const slot = picking && classic && (
    <span data-testid="row-pick-slot" className={cn("relative flex w-6 shrink-0 items-center justify-center", line ? "self-stretch" : "h-(--type-row-from-leading) self-start")}>
      {thread.unread && <span data-testid="row-unread-dot" className="size-2 rounded-full bg-unread group-hover/row:invisible group-data-many/list:invisible" />}
      {pickBox("absolute inset-0 m-auto group-hover/row:visible")}
    </span>
  );
  /** the marks' column, or the slot that holds them */
  const lead = slot || dot;
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
      aria-selected={inSelection}
      // plan 161, pass 2: in a preview, whether the row is in it: checked, as its check shows (the cursor is aria-selected)
      aria-checked={included}
      data-cursor={selected || undefined}
      data-opened={opened || undefined}
      data-testid="thread-row"
      data-thread-id={thread.id}
      data-unread={thread.unread || undefined}
      data-messages={thread.messageCount > 1 ? thread.messageCount : undefined}
      data-checked={checked || undefined}
      data-included={included}
      data-pending={pending || undefined}
      data-layout={layout}
      data-wide={(wide && !compact) || undefined}
      onMouseDown={interactive ? (e) => e.button === 0 && pressRow(thread.id, { meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey }) : undefined}
      onClick={interactive ? (e) => !e.metaKey && !e.ctrlKey && !e.shiftKey && releaseRow(thread.id) : undefined}
      className={cn(
        "group/row absolute left-0 w-full cursor-default px-5 select-none",
        "flex flex-col justify-center",
        // the selection is an inset, rounded shape (the design's radius), wider at the start for the marks' column
        ROW_SHAPE,
        // classic rows: one hairline separator, hidden under the selection and above it (rows render in list order, so the next sibling is the next row)
        classic && "after:absolute after:right-4 after:bottom-0 after:left-5 after:h-(--hairline-w) after:bg-hairline [&:has(+[data-checked])]:after:hidden [&:has(+[data-cursor])]:after:hidden",
        // plan 158: one family. Open (List's cursor too) and checked share the selection's fill; the open row's mark is its
        // rail (none while several are checked: the reader shows them, not it), a checked row's its check. Among several,
        // a cursor outside them is only a place: the hover's fill, outlined once j/k moved it
        opened || checked ? "text-row-selected-foreground before:bg-row-selected after:hidden" : "text-foreground hover:before:bg-row-hover",
        selected && !checked && "group-data-many/list:text-foreground group-data-many/list:before:bg-row-hover",
        // (ROW_OUTLINE, written out for the class scanner)
        selected && "group-data-keyed/list:before:shadow-[inset_0_0_0_2px_var(--ring)]",
        reminderEnd && "after:hidden",
        // the check takes the gutter, and the content line moves over as one
        included !== undefined && "pl-10",
        // left out: quiet, without going under the contrast a row's text must hold
        (included === false || pending) && "[&>*:not([data-slot=checkbox])_*]:text-muted-foreground",
      )}
      style={{ transform: `translateY(${top}px)`, height }}
    >
      {section && <span className="sr-only">{section}, </span>}
      {/* plan 158: the open row's mark, straight inside the selection's rounded edge; none while several are checked */}
      {/* (a checked row's mark is its check, on the same column) */}
      {included !== undefined && (
        // the row is the option and `x` its key: this is for the pointer, and says nothing the row doesn't. Plan 161: the
        // whole check column at the row's height is the target (the body opens the mail, to check it before Apply)
        // (a checkbox to assistive tech, for the pointer: not in the Tab order, the row and x are the keyboard's way)
        <span role="checkbox" aria-checked={included} aria-label={t("action.row.include", { subject: thread.subject || t("common.noSubject") })} data-testid="row-include" data-row-control data-checked={included || undefined} className="absolute inset-y-0 left-0 w-10" onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); e.currentTarget.closest<HTMLElement>("[role=listbox]")?.focus({ preventScroll: true }); }} onClick={(e) => { e.stopPropagation(); toggleRow(thread.id); }}>
          {/* plan 162 (after ai162-r01): the digest's quiet box, the one tick for picking mail for a batch (six solid squares were the loudest thing on screen) */}
          <CheckboxMark quiet checked={included} className="absolute top-1/2 left-5 -translate-y-1/2" />
        </span>
      )}
      {wide ? (
        // a table: sender, then subject and preview as one line, then fixed columns on the right edge (account, category,
        // attachment, star, date), so the eye runs down each. What's narrow gives way from the left of them, the preview first
        <div className="relative flex min-w-0 items-center gap-3">
          {lead}
          {avatar}
          {/* the full-width list's code sits with the sender, out of the subject's way (plan 72) */}
          <span className="flex w-[clamp(8rem,15%,12rem)] shrink-0 items-center gap-1.5">
            {from}
            {count}
            {chip}
          </span>
          {/* plan 160: the subject in its column, the preview from one x on every row (plan 158's flowing line zigzagged);
              the preview is what gives way; the meta columns follow it on the right */}
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <span className={SUBJECT_COLUMN}>
              <span data-testid="row-subject" className={cn("min-w-0 truncate", subjectInk)}>{thread.subject ? <Marked text={thread.subject} needles={match?.subject} /> : t("common.noSubject")}</span>
              {/* what a row is, not a column: at the subject column's end, so neither the preview nor the columns on the right move */}
              <span className="ml-auto flex shrink-0 items-center gap-1.5 empty:hidden">
                {draft}
                {keptTag}
                {placeTag}
                {reminder && !reminderTop && bell}
              </span>
            </span>
            {answer ? <span className="flex min-w-0 flex-1 justify-end">{answer}</span> : <WideSnippet thread={thread} reminderTop={reminderTop} ink={owedInk} quiet={quiet} match={match} excerpt={excerpt} />}
          </span>
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
          {lead}
          {avatar}
          {/* plan 160: the sender and the subject in columns, the preview from one x */}
          <span className={SENDER_COLUMN}>
            {from}
            {count}
          </span>
          {/* (a few characters of subject stay whatever the width: the sender's column gives way first) */}
          <span className="flex min-w-16 flex-1 items-center gap-2">
            <span className={COMPACT_SUBJECT}>
              <span data-testid="row-subject" className={cn("min-w-0 truncate", subjectInk)}>{thread.subject ? <Marked text={thread.subject} needles={match?.subject} /> : t("common.noSubject")}</span>
              {draft && <span className="ml-auto shrink-0">{draft}</span>}
            </span>
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
      ) : classic && !slot ? (
        <div className="relative flex min-w-0 flex-col">
          {dot}
          {lines}
        </div>
      ) : classic ? (
        <div className="relative flex min-w-0 gap-2">
          {slot}
          <div className="flex min-w-0 flex-1 flex-col">{lines}</div>
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
      {/* what the dot, the star and the clip show, said as well (plan 158) */}
      {thread.unread && <span className="sr-only">{t("list.state.unread.sr")}</span>}
      {thread.starred && <span className="sr-only">{t("list.state.starred.sr")}</span>}
      {thread.hasAttachments && <span className="sr-only">{t("list.state.attachments.sr")}</span>}
      {account && <span className="sr-only">{t("list.accountLabel.sr", { account: account.text })}</span>}
      {code && <span className="sr-only">{t("codes.sr", { code })}</span>}
      {reminder && <span className="sr-only">{reminder.due ? t("remind.due") : t("remind.pending")}</span>}
    </div>
  );
}
