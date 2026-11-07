import { DIGEST_ROW_ID } from "@terno/core";
import { useToday } from "~/state/today";
import "~/lib/replies";
import { folderName } from "~/lib/account-folders";
import { ReaderAttachments } from "./attachments";
import type { Account, Category, CategoryColor, MatchNeedle, MessageDetail, Reason, ThreadDetail } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { ButtonGroup, ButtonGroupItem } from "@terno/ui/components/button-group";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Separator } from "@terno/ui/components/separator";
import { Chip } from "@terno/ui/components/chip";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { IconButton } from "@terno/ui/components/icon-button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { TernoMark } from "@terno/ui/brand/terno-mark";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { Archive, Bell, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Ellipsis, FileDown, Forward, Inbox, Layers, Mail, OctagonAlert, Printer, Reply, ReplyAll, Sparkles, SquarePen, Star, Tag, Trash2 } from "@terno/ui/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { reminderShort, useReminders, useRemindPopover } from "~/lib/reminders";
import { installScrollHairline } from "~/lib/scroll-hairline";
import { cancelReaderScroll, keepInView, revealMessage } from "~/lib/reader-scroll";
import { takeHeldSent, takeSent } from "~/lib/sent-reveal";
import { Expand } from "./expand";
import { DraftSlot, draftTitle } from "./inline-draft";
import { bottomInset, usePinned } from "~/lib/pinned-draft-state";
import { ScheduledReplyLine } from "./scheduled-popover";
import { ForwardLine } from "./forward-line";
import { comingHomeKey, shownDraftKey, useDrafts } from "~/lib/drafts";
import { reachesSeveral, replyName } from "~/lib/compose-fields";
import { composeFocusPending, composeLanding, registerReaderFocusDestination, returnDraftsTo, subscribeComposeFocus } from "~/lib/compose";
import { act, cancelMarkRead, openCompose, readChosenThread, scheduleMarkRead, toggleStar } from "~/lib/actions";
import { acceptSuggestion, answerReview, rejectSuggestion, removeFromCategory } from "~/lib/categorize";
import { t } from "@terno/i18n";
import { fullDate, listDate, messageDate, messageTime } from "~/lib/format";
import { SenderAvatar } from "./sender-avatar";
import { chooseOpenThread, inSeparateTab, onThreadChosen, openedByApp, setApp, useApp } from "~/state/app";
import { hydrateSelectedThread, useThread, useThreadGone } from "~/state/threads";
import { conversationKeys } from "~/lib/conversation-keys";
import { copyThreadText } from "~/lib/copy-thread";
import { openPrint } from "~/lib/print-open";
import { isMac } from "~/lib/select";
import { HtmlBody, TextBody } from "./mail-body";
import { Marked } from "./match-mark";
import { SearchHelp } from "./search-help";
import { firstHolding, readerMarks, revealMark, useReaderMarks, useSearchMarks } from "~/lib/reader-marks";
import { MailReaderView, useMailReaderView } from "./mail-reader-view";
import { backgroundMenu, MessageActions, MessageMenu } from "./message-menu";
import { reasonText } from "~/lib/reasons";
import { useDesign, variant } from "~/lib/design";
import { Kbd } from "@terno/ui/components/kbd";
import { renderProbe } from "~/lib/render-probe";
import { useAppearance } from "~/lib/appearance";
import { goBack } from "~/lib/page";
import { move } from "~/lib/keyboard";
import { viewLabel } from "~/lib/format";
import { listKey, useList } from "~/state/list";
import { useSnack } from "~/lib/snack";
import { aiAllowed, repliesOffered, summariesOffered } from "~/lib/ai";
import { summarizable, summarize, useSummaries } from "~/lib/summaries";
import { RemindPicker } from "./remind-picker";
import DigestPage from "./digest-page";
import ReplyReady from "./reply-ready";
import ThreadFollowups from "./thread-followups";
import ThreadSummary from "./thread-summary";


/** Plan 132 §7: a summary by hand. Never in spam or trash, nor with one spam message in the thread. Open already: the block shows it. */
function SummarizeButton({ threadId }: { threadId: number }) {
  const kind = useSummaries((s) => s.byThread.get(threadId)?.kind);
  const updates = useApp((s) => kind === "stale" && !s.settings?.summaries.enabled);
  const offered = useApp(summariesOffered);
  if (!offered) return null;
  return (
    // a narrow reader (the minimum window) gives its place to the bell, as Mark as unread does; the palette keeps it
    <IconButton className={cn(tool, "@max-[420px]:hidden")} label={updates ? t("actions.updateSummary") : t("actions.summarize")} onClick={() => void summarize(threadId)} data-summarize data-testid="action-summarize" aria-busy={kind === "running" || undefined}>
      <Sparkles />
    </IconButton>
  );
}

/** Plan 87: the bell. Set: filled, in the accent, its tooltip says when. Opens the picker below it (h too). */
function RemindButton({ threadId }: { threadId: number }) {
  const open = useRemindPopover((s) => s.open);
  const reminder = useReminders((s) => s.byThread.get(threadId));
  const label = reminder ? t("remind.buttonSet", { when: reminderShort(reminder.dueAt) }) : t("remind.button");
  const close = () => useRemindPopover.setState({ open: false });
  return (
    <Popover open={open} onOpenChange={(o) => useRemindPopover.setState({ open: o })}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label}
                  data-testid="action-remind"
                  data-set={reminder ? true : undefined}
                  className={cn(tool, reminder && "text-primary hover:text-primary")}
                />
              }
            />
          }
        >
          <Bell className={cn(reminder?.due && "fill-current")} />
        </TooltipTrigger>
        <TooltipContent className="flex items-center gap-2">
          {label}
          <Shortcut keys="h" />
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="start" sideOffset={6} className="w-72 gap-2 rounded-menu p-1.5" data-testid="remind-popover" aria-label={t("remind.title")}>
        <RemindPicker threadIds={[threadId]} done={close} />
      </PopoverContent>
    </Popover>
  );
}

// the reader's toolbar icons: out of the window's drag region, at the toolbar's line weight, a size down where the reader is narrow
const tool = "no-drag size-8 rounded-md text-foreground-soft hover:text-foreground @max-[560px]:size-7 [&_svg]:[--icon-line:var(--icon-line-toolbar)]";

// one column for the toolbar and the conversation, so their edges agree at every width (narrow: less margin, for the toolbar's icons)
const COLUMN = "mx-auto w-full max-w-(--reader-max) px-(--reader-pad-x) @max-[420px]:px-4";

/** Between the toolbar's groups; a narrow reader has no room for it. */
const ToolbarDivider = ({ className }: { className?: string }) => <Separator orientation="vertical" className={cn("my-auto h-4 @max-[420px]:hidden", className)} />;

/** What's done to a whole conversation less often than triage: print, export, copy. Their keys and the palette still reach them. */
function ToolbarMore({ threadId }: { threadId: number }) {
  return (
    <DropdownMenu onOpenChange={(open) => setApp({ menuOpen: open })}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label={t("reader.more")} data-testid="action-more" className={tool} />}
            />
          }
        >
          <Ellipsis />
        </TooltipTrigger>
        <TooltipContent>{t("reader.more")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" sideOffset={6} className="w-64" data-testid="reader-more-menu">
        <DropdownMenuItem data-testid="action-print" onClick={() => openPrint({ threadId, messageId: null, intent: "print" })}>
          <Printer />
          <span className="flex-1">{t("palette.print")}</span>
          <DropdownMenuShortcut>{isMac ? "⌘P" : "Ctrl+P"}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="action-pdf" onClick={() => openPrint({ threadId, messageId: null, intent: "pdf" })}>
          <FileDown />
          <span className="flex-1">{t("palette.exportPdf")}</span>
          <DropdownMenuShortcut>{isMac ? "⇧⌘P" : "Ctrl+Shift+P"}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="action-copy-text" onClick={() => copyThreadText(threadId)}>
          <Copy />
          <span className="flex-1">{t("threadMenu.copyText")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One way to reply, in words: Reply, Reply all beside it only when it reaches someone Reply doesn't (`a` still works: it's
 * the same as Reply then), and Forward as its glyph. No menu. The group ends on the column's edge and Reply all comes in on
 * its far side, so nothing moves between conversations. The pill also shows Reply's key.
 */
function ReplyGroup({ replyAll, page, crowded }: { replyAll: boolean; page: boolean; crowded: boolean }) {
  const pill = useDesign().variants.replyAction === "pill";
  // a choice hands focus to the draft; refused (a forward's files, say), the button that asked keeps it
  const choose = (mode: "replyAll" | "forward", button: HTMLElement) => {
    void composeLanding(mode).then((landing) => {
      if (landing.kind === "none" && document.activeElement === document.body && button.isConnected) button.focus();
    });
  };
  return (
    <ButtonGroup aria-label={t("reader.group.respond")} className={cn("no-drag ml-auto [&_svg]:[--icon-line:var(--icon-line-toolbar)]", pill && "rounded-full")}>
      {replyAll && (
        <Tooltip>
          <TooltipTrigger
            render={
              <ButtonGroupItem data-testid="action-reply-all" onClick={(e) => choose("replyAll", e.currentTarget)} className={crowded ? "aspect-square px-0" : page ? "@max-[1079px]:aspect-square @max-[1079px]:px-0" : "@max-[719px]:aspect-square @max-[719px]:px-0"}>
                <ReplyAll />
                {/* in words only on a full-width column (List's: with Back and the steps beside it), where every language fits, unless the
                    toolbar holds both of its optional buttons; else the glyph, its name for screen readers */}
                <span className={crowded ? "sr-only" : page ? "@max-[1079px]:sr-only" : "@max-[719px]:sr-only"}>{t("actions.replyAll")}</span>
              </ButtonGroupItem>
            }
          />
          <TooltipContent className="flex items-center gap-2">
            {t("actions.replyAll")}
            <Shortcut keys="a" />
          </TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <ButtonGroupItem data-testid="action-reply" onClick={() => void openCompose("reply")} className="@max-[420px]:aspect-square @max-[420px]:px-0">
              <Reply />
              {/* the name is the visible label (still read when a narrow reader shows the icon alone); the key is decoration */}
              <span className="@max-[420px]:sr-only">{t("actions.reply")}</span>
              {pill && <Kbd aria-hidden className="@max-[560px]:hidden">R</Kbd>}
            </ButtonGroupItem>
          }
        />
        <TooltipContent className="flex items-center gap-2">
          {t("actions.reply")}
          <Shortcut keys="r" />
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <ButtonGroupItem iconOnly aria-label={t("actions.forward")} data-testid="action-forward" onClick={(e) => choose("forward", e.currentTarget)} className={cn(pill && "w-9 pr-0.5")}>
              <Forward />
            </ButtonGroupItem>
          }
        />
        <TooltipContent className="flex items-center gap-2">
          {t("actions.forward")}
          <Shortcut keys="f" />
        </TooltipContent>
      </Tooltip>
    </ButtonGroup>
  );
}

/** Why the engine did or suggests something: its reasons, in plain words. */
function Reasons({ title, reasons, hint }: { title: string; reasons: Reason[]; hint?: string }) {
  return (
    <TooltipContent className="max-w-72 flex-col items-start gap-1 text-left" data-testid="category-reasons">
      <p className="font-medium">{title}</p>
      {reasons.length > 0 && <p>{reasons.map(reasonText).join(" · ")}</p>}
      {hint && <p className="text-muted-foreground">{hint}</p>}
    </TooltipContent>
  );
}

/** The extension a tile shows on its document glyph ("PDF", "XLSX"), or nothing. */


/** Who a message went to: "To: …" and, when there are any, "· Cc: …" (one truncated line). */
function Recipients({ m, className }: { m: MessageDetail; className?: string }) {
  const people = (list: typeof m.to) => list.map((a) => a.name || a.email).join(", ");
  return (
    <span data-testid="recipients" className={cn("block truncate text-xs text-muted-foreground", className)}>
      {t("reader.to")} {people(m.to)}
      {m.cc.length > 0 && ` · ${t("reader.cc")} ${people(m.cc)}`}
    </span>
  );
}

/** That a header opens and closes: the quoted text's chevron, on the dates' edge. The button says it (aria-expanded). */
const Disclosure = ({ open }: { open: boolean }) => <ChevronRight aria-hidden data-testid="message-disclosure" className={cn("size-3.5 shrink-0 self-center text-muted-foreground", open && "rotate-90")} />;

/** A long preview cut for what a screen reader says: a row's name is who, a taste and when, not the whole mail. */
const previewFor = (snippet: string) => (snippet.length > 80 ? `${snippet.slice(0, 80).trimEnd()}…` : snippet);

/**
 * `headless`: the sender card above the subject shows this message's header (Lumen, one message: plan 59), so it
 * renders its body alone and never folds. Only the header comes and goes: the body keeps its place (and its frames)
 * when a second message arrives. `timed`: another message of the conversation shares its day, so a folded row says the
 * time as well (while the row has room). `current`: N or P put you here.
 * A header is one family, open or folded: the same avatar column, the same name column, dates on the column's edge. The
 * open one's weight, recipients and body are what say it's open; its actions sit under the date, in a place kept for them.
 */
function Message({ m, threadId, expanded, onToggle, icons, headless, timed, current, onLeave, marks }: { m: MessageDetail; threadId: number; expanded: boolean; onToggle: () => void; icons: boolean; headless: boolean; timed: boolean; current: boolean; onLeave: () => void; marks: readonly MatchNeedle[] | undefined }) {
  const remoteImages = useApp((s) => s.settings?.remoteImages ?? "ask");
  const mailAppearance = useApp((s) => s.settings?.htmlMailAppearance ?? "auto");
  const name = m.from.name || m.from.email;
  const bodyId = `msg-body-${m.id}`;
  const open = headless || expanded;
  const date = messageDate(m.date);
  return (
    <article data-testid="message" data-message-id={m.id} data-expanded={open || undefined} className="hairline-b">
      {/* one heading and one button in both states, so the focused control survives expanding and collapsing; the actions sit beside it, never inside */}
      {!headless && <div className="group/mh relative">
        <h3>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={bodyId}
            title={fullDate(m.date)}
            onClick={onToggle}
            onBlur={onLeave}
            data-testid="message-toggle"
            data-current={current || undefined}
            className={cn(
              "-mx-2 flex w-[calc(100%+1rem)] gap-2.5 rounded-lg px-2 text-left outline-none transition-colors group-hover/mh:bg-tint data-current:bg-tint focus-visible:ring-2 focus-visible:ring-ring",
              expanded ? "items-start pt-3 pb-1.5" : "h-9 items-center text-sm",
            )}
          >
            {expanded ? (
              <>
                <SenderAvatar name={name} email={m.from.email} icon={icons} className="mt-px size-(--avatar-message) text-2xs" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="type-sender-name min-w-0 truncate">{name}</span>
                    {m.from.name && <span className="min-w-0 flex-1 basis-0 truncate text-xs text-muted-foreground">{m.from.email}</span>}
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular">{date}</span>
                    <Disclosure open />
                  </span>
                  <Recipients m={m} className="mt-px pr-14" />
                </span>
              </>
            ) : (
              <>
                <SenderAvatar name={name} email={m.from.email} icon={icons} className="size-(--avatar-collapsed) text-2xs" />
                <span className="max-w-[45%] shrink-0 truncate">{name}</span>
                <span aria-hidden className="min-w-0 flex-1 truncate text-[length:var(--ds-text-control)] text-muted-foreground">{m.snippet}</span>
                <span className="sr-only">{previewFor(m.snippet)}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular">
                  {listDate(m.date)}
                  {timed && <span className="@max-[560px]:hidden">{messageTime(m.date)}</span>}
                </span>
                <Disclosure open={false} />
              </>
            )}
          </button>
        </h3>
        {/* on hover and focus only, the newest's too: the reply bar is right there */}
        {expanded && <MessageActions threadId={threadId} messageId={m.id} className="absolute -right-[5px] bottom-0.5" />}
      </div>}
      {/* the region is always there (aria-controls); its content is mounted only while open */}
      <div id={bodyId}>
        <Expand open={open} onOpening={(el) => keepInView(el.closest("article") ?? el)}>
          <div className={cn("pb-4", headless ? "pt-3" : "pt-2")}>
            {m.bodyHtml ? (
              <HtmlBody marks={marks} html={m.bodyHtml} messageId={m.id} accountId={m.accountId} attachments={m.attachments} remoteImages={remoteImages} spam={!icons} appearance={mailAppearance} />
            ) : m.bodyText !== null ? (
              <TextBody text={m.bodyText} marks={marks} />
            ) : (
              <p className="text-sm text-muted-foreground italic">{m.bodyUnavailable ? t("attachments.bodyUnavailable") : m.bodyState === "full" ? t("attachments.noBody") : t("reader.downloading")}</p>
            )}
            {m.attachments.length > 0 && <ReaderAttachments messageId={m.id} accountId={m.accountId} attachments={m.attachments} />}
            <ForwardLine messageId={m.id} />
          </div>
        </Expand>
      </div>
    </article>
  );
}

/**
 * Which messages of a conversation show open. Keyed by thread (its component is): each one starts from its defaults
 * (unread messages and the last one open) on mount, so a swap never animates, and keeps each message's while it is
 * shown: the dwell's mark-read or a newer message never folds one away under the reader. Runs of 4+ collapsed ones
 * fold into one "N more messages" disclosure. Also the keyboard's way through them (N, P, ⇧E).
 */
function useFold(messages: MessageDetail[]) {
  const last = messages[messages.length - 1];
  const opensAt = (m: MessageDetail) => !m.isRead || m.id === last?.id;
  const [shown, setShown] = useState(() => new Map(messages.map((m) => [m.id, opensAt(m)])));
  // one arriving later keeps how it first showed too (a render more, only then: never on a thread switch)
  useEffect(() => {
    const unseen = messages.filter((m) => !shown.has(m.id));
    if (!unseen.length) return;
    // a reply just sent from here: the reader goes to it, open (newer mail can follow it, never folds it away)
    const sent = takeSent(unseen.map((m) => m.id)) ?? takeHeldSent(unseen);
    setShown(new Map([...shown, ...unseen.map((m) => [m.id, m.id === sent || opensAt(m)] as const)]));
    if (sent !== null) revealMessage(sent);
  }, [messages]);
  const [own, setState] = useState<{ toggled: Map<number, boolean>; revealed: Set<number> }>({ toggled: new Map(), revealed: new Set() });
  // plan 132: a summary's arrow: the message it names opens, wherever it's folded, and the reader goes to it
  const summaryReveal = useSummaries((s) => s.reveal);
  useEffect(() => {
    if (!summaryReveal || !messages.some((m) => m.id === summaryReveal.messageId)) return;
    const { messageId } = summaryReveal;
    useSummaries.setState({ reveal: null });
    setState((s) => ({ toggled: new Map(s.toggled).set(messageId, true), revealed: new Set([...s.revealed, messageId]) }));
    revealMessage(messageId);
  }, [summaryReveal, messages]);
  const isOpen = (m: MessageDetail) => own.toggled.get(m.id) ?? shown.get(m.id) ?? opensAt(m);
  const allOpen = messages.every(isOpen);
  // plan 158: opened from a search, the first message holding its words opens, wherever it's folded
  const marks = useSearchMarks()?.body;
  useEffect(() => {
    if (!marks?.length) return;
    const first = firstHolding(messages, marks);
    if (!first || isOpen(first)) return;
    setState((s) => ({ toggled: new Map(s.toggled).set(first.id, true), revealed: new Set([...s.revealed, first.id]) }));
  }, [marks, messages]);
  const toggle = (id: number, now: boolean) => setState({ ...own, toggled: new Map(own.toggled).set(id, !now) });
  // every message of a revealed run stays unfolded, whatever opens or closes around it later
  const reveal = (ids: number[]) => {
    setState({ ...own, revealed: new Set([...own.revealed, ...ids]) });
    // the button goes away: focus moves to the first message it revealed
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[aria-controls="msg-body-${ids[0]}"]`)?.focus());
  };
  // collapsing all still leaves the newest to read, and long runs fold again; what held focus may fold away with them, and focus goes to the newest then
  const toggleAll = () => {
    const held = document.activeElement;
    // a closing body keeps its controls for its last frames, inert: focus in one leaves before it closes
    if (allOpen && held?.closest(`[id^="msg-body-"]:not([id="msg-body-${last?.id}"])`)) document.querySelector<HTMLElement>(`[aria-controls="msg-body-${last?.id}"]`)?.focus({ preventScroll: true });
    setState({ toggled: new Map(messages.map((m) => [m.id, !allOpen || m.id === last?.id])), revealed: new Set(allOpen ? [] : messages.map((m) => m.id)) });
    requestAnimationFrame(() => { if (held && held !== document.body && !held.isConnected) document.querySelector<HTMLElement>(`[aria-controls="msg-body-${last?.id}"]`)?.focus({ preventScroll: true }); });
  };

  // where N and P are: the message they last went to, or the newest one open. The tint says so (no ring: a shortcut moved focus), until focus leaves it; leaving the last one for the next doesn't clear the next's
  const position = useRef<number | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const step = (delta: 1 | -1) => {
    const ids = messages.map((m) => m.id);
    const from = ids.indexOf(position.current ?? [...messages].reverse().find(isOpen)?.id ?? last?.id ?? -1);
    const id = ids[Math.max(0, Math.min(ids.length - 1, from + delta))];
    if (id === undefined) return;
    position.current = id;
    setCurrent(id);
    // the whole run it's in unfolds, as the disclosure's would: a message opened in it later doesn't fold the rest away
    const at = messages.findIndex((m) => m.id === id);
    const run = [id];
    for (let i = at - 1; i >= 0 && !isOpen(messages[i]!); i--) run.push(messages[i]!.id);
    for (let i = at + 1; i < messages.length && !isOpen(messages[i]!); i++) run.push(messages[i]!.id);
    setState({ ...own, revealed: new Set([...own.revealed, ...run]) });
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[aria-controls="msg-body-${id}"]`)?.focus({ preventScroll: true }));
    revealMessage(id);
  };
  // not while the full-message view covers it: its headers are out of reach, and folding a message would close the view
  const covered = useMailReaderView()?.active != null;
  useEffect(() => {
    if (messages.length < 2 || covered) return;
    conversationKeys.current = { step, toggleAll, allOpen: () => allOpen };
    return () => { conversationKeys.current = null; };
  });
  return { isOpen, allOpen, toggle, reveal, toggleAll, revealed: own.revealed, current, leaveCurrent: (id: number) => setCurrent((c) => (c === id ? null : c)) };
}
type Fold = ReturnType<typeof useFold>;

/** `icons`: senders' icons may be asked for (never in spam: plan 22); `headless`: the card above shows the one message's header (plan 59) */
function Conversation({ threadId, messages, fold, icons, headless }: { threadId: number; messages: MessageDetail[]; fold: Fold; icons: boolean; headless: boolean }) {
  const marks = useSearchMarks()?.body;
  renderProbe("Conversation");
  const { isOpen, toggle, reveal, revealed, current, leaveCurrent } = fold;
  const days = new Map<string, number>();
  for (const m of messages) days.set(listDate(m.date), (days.get(listDate(m.date)) ?? 0) + 1);

  const items: ({ kind: "message"; m: MessageDetail } | { kind: "more"; ids: number[] })[] = [];
  for (let i = 0; i < messages.length; ) {
    let j = i;
    while (j < messages.length && !isOpen(messages[j]!)) j++;
    const run = j - i;
    const ids = messages.slice(i, j).map((m) => m.id);
    if (run >= 4 && !ids.some((id) => revealed.has(id))) {
      items.push({ kind: "more", ids });
      i = j;
    } else if (run > 0) {
      for (; i < j; i++) items.push({ kind: "message", m: messages[i]! });
    } else {
      items.push({ kind: "message", m: messages[i]! });
      i++;
    }
  }
  return (
    // the stronger hairline: these lines are what tell one message from the next
    <div className="hairline-t [--hairline-color:var(--border)]">
      {items.map((it) =>
        it.kind === "message" ? (
          <Message key={it.m.id} m={it.m} marks={marks} threadId={threadId} icons={icons} headless={headless && messages.length === 1} timed={(days.get(listDate(it.m.date)) ?? 0) > 1} current={current === it.m.id} onLeave={() => leaveCurrent(it.m.id)} expanded={isOpen(it.m)} onToggle={() => toggle(it.m.id, isOpen(it.m))} />
        ) : (
          <div key={`more-${it.ids[0]}`} className="hairline-b">
            <button
              type="button"
              aria-expanded="false"
              aria-controls={`more-${it.ids[0]}`}
              onClick={() => reveal(it.ids)}
              data-testid="more-messages"
              className="-mx-2 flex h-9 w-[calc(100%+1rem)] items-center gap-2.5 rounded-lg px-2 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-tint hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {/* on the avatars' column, its words on the names' */}
              <span className="flex size-(--avatar-collapsed) shrink-0 items-center justify-center"><Layers className="size-3.5" /></span>
              <span className="min-w-0 flex-1 truncate">{t("reader.moreMessages", { count: it.ids.length })}</span>
              <Disclosure open={false} />
            </button>
            <div id={`more-${it.ids[0]}`} />
          </div>
        ),
      )}
    </div>
  );
}

/**
 * Plan 158: a search's words in the open conversation: how many, which one's in hand, the next and the previous (⌘G, ⇧⌘G,
 * as a Mac's find does). Opening a result goes to the first; once the user has moved, it stays out of the way. Keyed by
 * thread and search, so each starts over.
 */
function ReaderMatches({ scroller, bottomInset }: { scroller: React.RefObject<HTMLDivElement | null>; bottomInset: number }) {
  const version = useReaderMarks((s) => s.version);
  const marks = useRef<HTMLElement[]>([]);
  const [shown, setShown] = useState({ at: 0, count: 0 });
  const moved = useRef(false);
  const go = (at: number) => {
    const list = marks.current;
    const mark = list[at];
    if (!mark || !scroller.current) return;
    for (const m of list) delete m.dataset.readerCurrent;
    mark.dataset.readerCurrent = "";
    revealMark(scroller.current, mark, bottomInset);
    setShown({ at, count: list.length });
  };
  const step = (by: number) => {
    const n = marks.current.length;
    if (!n) return;
    moved.current = true;
    go((shown.at + by + n) % n);
  };
  // counted again when a frame loads or a message opens; until the user moves, the first in reading order is the one
  useEffect(() => {
    const column = scroller.current?.querySelector("[data-reader-column]");
    if (!column) return;
    const list = readerMarks(column);
    marks.current = list;
    if (!moved.current && list.length) return go(0);
    // the one in hand stays the one in hand, wherever it now counts; gone with what was folded, its neighbour takes over, nothing scrolls
    let at = list.findIndex((m) => m.dataset.readerCurrent !== undefined);
    if (at < 0) at = Math.min(shown.at, Math.max(0, list.length - 1));
    if (list[at]) list[at]!.dataset.readerCurrent = "";
    setShown({ at, count: list.length });
  }, [version]);
  useEffect(() => {
    const el = scroller.current;
    const stay = () => (moved.current = true);
    // from a wheel, a key or a press on, the reader is the user's (folding a message counts again, and scrolls nowhere)
    for (const type of ["wheel", "keydown", "pointerdown"]) el?.addEventListener(type, stay, { passive: true });
    return () => {
      for (const type of ["wheel", "keydown", "pointerdown"]) el?.removeEventListener(type, stay);
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  if (shown.count === 0) return null;
  return (
    <div role="group" aria-label={t("reader.match.group")} data-testid="reader-matches" className={cn(COLUMN, "flex h-7 shrink-0 items-center gap-1 text-xs text-muted-foreground")}>
      <span role="status" data-testid="reader-matches-count" className="tabular">{t("reader.match.count", { at: shown.at + 1, count: shown.count })}</span>
      <IconButton className="size-6" label={t("reader.match.previous")} shortcut="mod+shift+g" onClick={() => step(-1)} data-testid="reader-match-previous">
        <ChevronUp />
      </IconButton>
      <IconButton className="size-6" label={t("reader.match.next")} shortcut="mod+g" onClick={() => step(1)} data-testid="reader-match-next">
        <ChevronDown />
      </IconButton>
    </div>
  );
}

/**
 * Plan 158: once the header has scrolled away (a short window replying, a long thread read down), one line under the
 * toolbar keeps the subject and, while a draft is open, who it's to. It takes over the toolbar's hairline and covers the
 * scroller's head (its scroll-padding-top, which reveals clear). What the heading says already: hidden from screen readers.
 * Keyed by thread and header variant (another design's header is another heading). One IntersectionObserver, no scroll handler.
 */
function ReaderContext({ scroller, toolbar, subject, draftKey }: { scroller: React.RefObject<HTMLDivElement | null>; toolbar: React.RefObject<HTMLDivElement | null>; subject: string; draftKey: string | null }) {
  const [shown, setShown] = useState(false);
  const writing = useDrafts((s) => {
    const d = draftKey ? s.drafts[draftKey] : undefined;
    return d?.uiState === "open" ? draftTitle(d) : null;
  });
  useEffect(() => {
    const root = scroller.current;
    const heading = root?.querySelector("#reader-subject");
    if (!root || !heading) return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        // wholly above the view (never below it): the header in sight, however little, has no line over it
        if (e) setShown(!e.isIntersecting && e.boundingClientRect.bottom <= (e.rootBounds?.top ?? 0) + 1);
      },
      { root },
    );
    io.observe(heading);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    toolbar.current?.toggleAttribute("data-context", shown);
    return () => toolbar.current?.removeAttribute("data-context");
  }, [shown]);
  return (
    <div aria-hidden className="pointer-events-none sticky top-0 z-10 h-0">
      <div data-testid="reader-context" data-shown={shown || undefined} className={cn("hairline-b bg-background transition-opacity duration-fast", shown ? "pointer-events-auto" : "invisible opacity-0")}>
        <div className={cn(COLUMN, "flex items-center gap-2 text-[length:var(--ds-text-control)]")} style={{ height: CONTEXT_H }}>
          <span className="min-w-0 truncate font-medium">{subject}</span>
          {writing && (
            <>
              <span className="shrink-0 text-muted-foreground">·</span>
              <span data-testid="reader-context-draft" className="max-w-[50%] shrink-0 truncate text-muted-foreground">{writing}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
/** The context line's height: the scroller's scroll-padding-top too. */
const CONTEXT_H = 32;

/** Plan 158: nothing open while searching: no greeting. With no results, what a search understands; with some, which to do next. */
function SearchReaderEmpty() {
  const none = useList((s) => !s.loading && s.items.length === 0 && s.itemsKey === listKey());
  return (
    <div className="flex h-full flex-col items-center justify-center p-10" data-testid="reader-search-empty" data-results={none ? undefined : true}>
      {none ? (
        <div className="w-full max-w-sm">
          <SearchHelp />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("reader.search.pick")}</p>
      )}
    </div>
  );
}

function Welcome() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-10 text-center" data-testid="reader-empty">
      <div>
        <TernoMark className="mx-auto mb-4 size-10 text-muted-foreground" data-testid="reader-empty-mark" />
        <p className="text-lg font-semibold tracking-tight">Terno</p>
        <p className="mt-1 text-sm text-muted-foreground">{t("reader.welcome.tagline")}</p>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs text-muted-foreground">
        {(
          [
            ["j k", "reader.welcome.navigate"],
            ["e", "reader.welcome.archive"],
            ["/", "reader.welcome.search"],
            ["mod+k", "reader.welcome.commands"],
            ["c", "reader.welcome.compose"],
            ["?", "reader.welcome.shortcuts"],
          ] as const
        ).map(([k, label]) => (
          <div key={k} className="flex items-center justify-between gap-4">
            <span>{t(label)}</span>
            {/* j and k are two keys, not a sequence ("j then k") */}
            {k === "j k" ? (
              <span className="inline-flex items-center gap-1">
                <Shortcut keys="j" />
                <Shortcut keys="k" />
              </span>
            ) : (
              <Shortcut keys={k} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The account a conversation is in, as the list's row says it: its color and its name. Information, so no chip (those can be removed). */
function AccountMark({ account }: { account: Account }) {
  const label = t("reader.account", { name: account.displayName || account.email, email: account.email });
  return (
    <span data-testid="reader-account" title={label} className="inline-flex min-w-0 items-center gap-1.5">
      <CategoryDot color={account.color as CategoryColor} />
      <span className="sr-only">{label}</span>
      <span aria-hidden className="truncate">{account.displayName || account.email}</span>
    </span>
  );
}

/** How many messages, and all of them open or folded at once. The count gives way first where the reader is narrow. */
function MessageCount({ count, fold }: { count: number; fold: Fold }) {
  const label = t(fold.allOpen ? "reader.collapseAll" : "reader.expandAll");
  return (
    <span className="inline-flex items-center gap-1.5" data-testid="message-count">
      <span className="tabular @max-[560px]:hidden">{t("reader.messageCount", { count })}</span>
      <span aria-hidden className="@max-[560px]:hidden">·</span>
      <Tooltip>
        <TooltipTrigger render={<Button variant="link-secondary" size="xs" onClick={fold.toggleAll} data-testid="expand-all" className="font-normal text-foreground-soft hover:text-foreground" />}>{label}</TooltipTrigger>
        <TooltipContent className="flex items-center gap-2">
          {label}
          <Shortcut keys="shift+e" />
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

/** The account, the categories (with why and how to undo) and the engine's suggestions (y / n): the same in every design. */
function ThreadChips({ detail, account, cats, fold, className }: { detail: ThreadDetail; account: Account | undefined; cats: Category[]; fold: Fold; className?: string }) {
  const categories = useApp((s) => s.categories);
  /** plan 80: in a category's Review list, its chip is the one y and n answer, and an answer takes the row out of the list */
  const reviewing = useApp((s) => s.reviewCategoryId);
  const answer = (categoryId: number, yes: boolean) =>
    categoryId === reviewing ? answerReview(detail.thread.id, categoryId, yes) : yes ? acceptSuggestion(detail.thread.id, categoryId) : rejectSuggestion(detail.thread.id, categoryId);
  const keyed = (i: number, categoryId: number) => (reviewing !== null && detail.categorization?.suggestions.some((x) => x.categoryId === reviewing) ? categoryId === reviewing : i === 0);
  const thread = detail.thread;
  return (
    <div data-testid="thread-chips" className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-muted-foreground", className)}>
      {account && <AccountMark account={account} />}
      {detail.messages.length > 1 && <MessageCount count={detail.messages.length} fold={fold} />}
      {cats.map((c) => {
        const auto = detail.categorization?.auto.find((a) => a.categoryId === c.id);
        return (
          <Chip
            key={c.id}
            data-testid="category-chip"
            dot={<CategoryDot color={c.color as CategoryColor} />}
            onRemove={() => void removeFromCategory(c.id, [thread.id])}
            removeLabel={auto ? t("reader.category.notIt", { category: c.name }) : t("reader.category.remove", { category: c.name })}
          >
            <span className="truncate">{c.name}</span>
            {auto && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      data-testid="auto-mark"
                      aria-label={t("reader.auto.label", { category: c.name, reasons: auto.reasons.map(reasonText).join("; ") })}
                      className="rounded-sm bg-foreground/10 px-1 text-[10px] font-medium uppercase focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {t("reader.auto")}
                    </button>
                  }
                />
                <Reasons title={t("reader.auto.title", { category: c.name })} reasons={auto.reasons} hint={t("reader.auto.hint", { category: c.name })} />
              </Tooltip>
            )}
          </Chip>
        );
      })}
      {detail.categorization?.suggestions.map((sg, i) => {
        const c = categories.find((x) => x.id === sg.categoryId);
        if (!c) return null;
        return (
          // not filed yet: the chip's outline, dashed in the accent, around its accept half and its ×
          <Chip
            key={sg.categoryId}
            data-testid="suggestion-chip"
            className="border border-dashed border-primary/40 bg-transparent ps-0"
            onRemove={() => void answer(c.id, false)}
            removeLabel={t("reader.category.notIt", { category: c.name })}
            removeProps={{ "data-testid": "suggestion-reject" }}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <button type="button" data-testid="suggestion-accept" onClick={() => void answer(c.id, true)} className="inline-flex h-full min-w-0 items-center gap-1.5 rounded-s-[inherit] ps-2 pe-0.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
                    <CategoryDot color={c.color as CategoryColor} />{t("reader.suggestion", { category: c.name })}{keyed(i, c.id) && <Shortcut keys="y" className="ml-0.5 [&_kbd]:h-3.5 [&_kbd]:min-w-3.5 [&_kbd]:text-[10px]" />}
                  </button>
                }
              />
              {/* plan 134: the AI's own confidence, not the engine's score: said as such */}
              <Reasons title={t(sg.reasons.some((r) => typeof r !== "string" && (r.k === "reason.aiLocal" || r.k === "reason.aiCloud")) ? "reader.suggestion.aiTitle" : "reader.suggestion.title", { category: c.name, percent: Math.round(sg.p * 100) })} reasons={sg.reasons} hint={keyed(i, c.id) ? t("reader.suggestion.hint") : undefined} />
            </Tooltip>
          </Chip>
        );
      })}
    </div>
  );
}

/** When a message was sent: the list's short form, the full date for the tooltip and screen readers. */
function MessageDate({ ms, className }: { ms: number; className?: string }) {
  const full = fullDate(ms);
  return (
    <time data-testid="message-date" dateTime={new Date(ms).toISOString()} title={full} className={cn("tabular", className)}>
      <span aria-hidden>{messageDate(ms)}</span>
      <span className="sr-only">{full}</span>
    </time>
  );
}

// a narrow reader keeps the mail's first line high: less around a smaller subject
const HEADER = "mb-3 @max-[560px]:mb-2";

/** The subject, chips and (Lumen, one message) sender above the conversation: the design arranges the same parts, and the mail starts soon after them. */
function ReaderHeader({ detail, account, cats, fold }: { detail: ThreadDetail; account: Account | undefined; cats: Category[]; fold: Fold }) {
  const design = useDesign();
  const subject = detail.thread.subject || t("common.noSubject");
  const marks = useSearchMarks()?.subject;
  const heading = <h2 id="reader-subject" data-testid="reader-subject" className="type-reader-subject min-w-0 @max-[560px]:text-lg @max-[560px]:tracking-[-0.01em]"><Marked text={subject} needles={marks} testId="reader-subject-match" /></h2>;
  // on the subject's line, at the dates' edge, while they fit; on a line of their own when they don't
  const titled = (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      {heading}
      <ThreadChips detail={detail} account={account} cats={cats} fold={fold} />
    </div>
  );
  return variant(design.variants.readerHeader, {
    classic: <div className={HEADER}>{titled}</div>,
    "chips-display": (
      <div className={HEADER}>
        <ThreadChips detail={detail} account={account} cats={cats} fold={fold} className="mb-1.5 @max-[560px]:mb-1" />
        {heading}
      </div>
    ),
    "sender-card": (() => {
      // one message: the card is its header (who wrote it, to whom, when), so the message shows no second one (plan 59). More: each message has its own, and a card would say one of them twice
      const one = detail.messages.length === 1 ? detail.messages[0]! : null;
      if (!one) return <div className={HEADER}>{titled}</div>;
      const name = one.from.name || one.from.email;
      return (
        <div className={HEADER}>
          {titled}
          {/* the message's id: a right-click here is a right-click on the message (Print this message, Copy) */}
          <div data-testid="sender-card" data-message-id={one.id} className="group/mh relative mt-1.5 flex items-start gap-2.5">
            <SenderAvatar name={name} email={one.from.email} icon={iconsFor(detail.thread)} className="size-(--avatar-sender) text-xs" />
            <div className="flex min-h-(--avatar-sender) min-w-0 flex-1 flex-col justify-center">
              <span className="flex items-baseline gap-2">
                <span className="type-sender-name min-w-0 truncate">{name}</span>
                {name !== one.from.email && <span className="min-w-0 flex-1 basis-0 truncate text-xs text-muted-foreground">{one.from.email}</span>}
                <MessageDate ms={one.date} className="ml-auto shrink-0 text-xs text-muted-foreground" />
              </span>
              <Recipients m={one} className="mt-px pr-14" />
            </div>
            <MessageActions threadId={detail.thread.id} messageId={one.id} className="absolute -right-[5px] -bottom-1" />
          </div>
        </div>
      );
    })(),
  });
}

/** Where Back goes: the list's own title ("Inbox", "Invoices", "Review · Invoices", a search's “query”). */
function useListTitle(): string {
  return useApp((s) => {
    const review = s.categories.find((c) => c.id === s.reviewCategoryId);
    if (review) return t("list.reviewTitle", { category: review.name });
    if (s.query.trim()) return t("list.scope.quoted", { label: s.query.trim() });
    return folderName(s) ?? s.categories.find((c) => c.id === s.categoryId)?.name ?? viewLabel(s.view);
  });
}

// a wide pane has room beside the column: Back and the steps hang just outside its edges, so the toolbar on the column is the
// one Split has and they still read as part of it (never out at the pane's edges, a screen away)
const BESIDE = "@min-[1080px]:absolute @min-[1080px]:top-0 @min-[1080px]:h-[52px]";

/** List's page (plan 24): Back to the list, at the toolbar's start, and saying where to once there's room. */
function BackButton() {
  const title = useListTitle();
  const label = t("reader.back", { mailbox: title });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" size="sm" aria-label={label} onClick={goBack} data-testid="reader-back" className={cn(tool, "w-auto gap-1 px-1.5 @max-[1079px]:w-8 @max-[1079px]:px-0 @max-[560px]:w-7")}>
            <ChevronLeft className="size-4" />
            <span className="max-w-24 truncate @max-[1079px]:hidden">{title}</span>
          </Button>
        }
      />
      <TooltipContent className="flex items-center gap-2">
        {label}
        <Shortcut keys="escape" />
      </TooltipContent>
    </Tooltip>
  );
}

/** List's page: the newer and older conversations (k and j), at the toolbar's end; nothing to step from a thread the list doesn't hold. */
function StepButtons({ id }: { id: number }) {
  const at = useList((s) => s.index.get(id));
  const last = useList((s) => s.items.length - 1);
  const more = useList((s) => s.nextCursor !== null);
  const busy = useList((s) => s.loadingMore);
  return (
    // the toolbar's last glyph, on the column's right edge
    <div className={cn("-mr-2 flex items-center gap-0.5 @max-[560px]:-mr-1.5 @min-[1080px]:left-full @min-[1080px]:mr-0", BESIDE)} role="group" aria-label={t("reader.group.navigate")}>
      <IconButton className={tool} label={t("reader.newer")} shortcut="k" onClick={() => move(-1)} data-testid="reader-newer" disabled={at === undefined || at === 0}>
        <ChevronUp />
      </IconButton>
      <IconButton label={t("reader.older")} shortcut="j" onClick={() => move(1)} data-testid="reader-older" className={tool} disabled={at === undefined || (at >= last && !more)} aria-busy={(busy && at === last) || undefined}>
        <ChevronDown />
      </IconButton>
    </div>
  );
}

/** Plan 22: never icons for spam: a thread in Spam, or one with spam mail wherever it is now (trashed spam too). */
const iconsFor = (t: { inSpam: boolean; hasSpam?: boolean }) => !t.inSpam && !t.hasSpam;

export function Reader() {
  const selectedId = useApp((s) => s.selectedId);
  const focusRequest = useApp((s) => s.draftFocus?.seq ?? null);
  // plan 145: the digest's row reads here, and isn't a thread
  if (selectedId === DIGEST_ROW_ID) return <DigestPage />;
  return <MailReaderView identity={selectedId} focusRequest={focusRequest}><ReaderContent /></MailReaderView>;
}

/** One conversation, from its subject to its last message: keyed by thread, so what's open starts afresh with each. */
function Thread({ detail, account, cats, summaryShown }: { detail: ThreadDetail; account: Account | undefined; cats: Category[]; summaryShown: boolean }) {
  const fold = useFold(detail.messages);
  const cardHeader = useDesign().variants.readerHeader === "sender-card";
  return (
    <MessageMenu threadId={detail.thread.id}>
      <div data-conversation-menu>
        {/* inside the menu: Lumen's card can stand for the message (plan 59) */}
        <ReaderHeader detail={detail} account={account} cats={cats} fold={fold} />
        <ThreadFollowups detail={detail} />
        {summaryShown && <ThreadSummary detail={detail} />}
        <Conversation threadId={detail.thread.id} messages={detail.messages} fold={fold} icons={iconsFor(detail.thread)} headless={cardHeader} />
      </div>
    </MessageMenu>
  );
}

function ReaderContent() {
  const selectedId = useApp((s) => s.selectedId);
  const page = useAppearance((s) => s.layout === "list");
  // List's page: the dock sits over the conversation's foot, so its end (the reply bar) scrolls clear of it
  // plan 115: and the pinned draft sits over its foot in either layout: the last message scrolls clear of the taller one
  const dock = bottomInset(useSnack((s) => (page ? s.inset : 0)), usePinned((s) => s.inset));
  const sectionRef = useRef<HTMLElement>(null);
  const destination = useRef({});
  useLayoutEffect(() => selectedId === null ? undefined : registerReaderFocusDestination(selectedId, destination.current), [selectedId]);
  // List's page opened: focus starts on the conversation (named by its subject), unless something in it already took it (a draft asked for)
  useEffect(() => {
    if (!page) return;
    let unsubscribe = () => {};
    const activeAtMount = document.activeElement;
    let focusMoved = false;
    const moved = (event: FocusEvent) => {
      if (event.target instanceof Node && event.target.isConnected && event.target !== document.body && event.target !== activeAtMount) focusMoved = true;
    };
    document.addEventListener("focusin", moved, true);
    const frame = requestAnimationFrame(() => {
      document.removeEventListener("focusin", moved, true);
      const section = sectionRef.current;
      const state = useApp.getState();
      const threadId = state.selectedId;
      if (!section || focusMoved || threadId === null || state.dialog || state.fatal || useDrafts.getState().held || section.closest("[inert]")) return;
      if (composeFocusPending(threadId)) {
        const active = document.activeElement;
        unsubscribe = subscribeComposeFocus((finishedThread, fallback) => {
          if (finishedThread !== threadId) return;
          unsubscribe();
          const state = useApp.getState();
          if (fallback && section.isConnected && !section.closest("[inert]") && state.selectedId === threadId && !state.dialog && !state.fatal && !useDrafts.getState().held && !composeFocusPending(threadId) && document.activeElement === active && !section.contains(active)) section.focus({ preventScroll: true });
        });
        return;
      }
      if (!section.contains(document.activeElement)) section.focus({ preventScroll: true });
    });
    return () => { cancelAnimationFrame(frame); document.removeEventListener("focusin", moved, true); unsubscribe(); };
  }, [page]);
  const design = useDesign();
  const detail = useThread(selectedId);
  const gone = useThreadGone(selectedId);
  const categories = useApp((s) => s.categories);
  const accounts = useApp((s) => s.accounts);
  useEffect(() => {
    if (selectedId === null) return;
    // the header renders from the cached row immediately; the body follows (debounced while holding j)
    let current = true;
    const t = setTimeout(() => void hydrateSelectedThread(selectedId, () => current), detail ? 0 : 40);
    // plan 158: what the app opened by itself waits for the user to choose it
    if (openedByApp(selectedId)) cancelMarkRead();
    else scheduleMarkRead(selectedId);
    return () => { current = false; clearTimeout(t); };
  }, [selectedId]);
  useEffect(() => onThreadChosen(readChosenThread), []);

  // a dwell only counts while the reader shows the thread
  useEffect(() => cancelMarkRead, []);

  // a scroll in flight belongs to the thread it started in; focus left in a draft goes back to the list
  useEffect(
    () => () => {
      cancelReaderScroll();
      if (document.activeElement?.closest("[data-testid=draft-slot]")) (document.activeElement as HTMLElement).blur();
    },
    [selectedId],
  );
  const draftShown = useApp((s) => s.draftShown);
  const draftKey = useDrafts((s) => (selectedId === null ? null : shownDraftKey(s.drafts, selectedId, draftShown)));
  const repliesOn = useApp(repliesOffered);
  const summarizeOffered = useApp(summariesOffered);
  // plan 147: Dev mode's switch off, what's stored stays out of sight too; elsewhere reading is never gated (plan 132)
  const summaryShown = useApp(aiAllowed);
  const fromDigest = useToday((s) => s.fromDigest);

  useEffect(() => {
    if (draftShown?.threadId === selectedId && draftShown.key !== draftKey) setApp({ draftShown: null });
  }, [draftShown, selectedId, draftKey]);
  // what was written here comes back with the conversation (plan 158), before the slot's first paint offers a blank Reply;
  // and when one turns up late (the stored drafts still loading) or changes under the check
  const homing = useDrafts((s) => (selectedId === null ? "" : comingHomeKey(s.drafts, selectedId)));
  useLayoutEffect(() => (selectedId === null ? undefined : returnDraftsTo(selectedId)), [selectedId, homing]);

  const toolbarRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const open = selectedId !== null;
  const searching = useApp((s) => s.query.trim() !== "" && s.reviewCategoryId === null);
  const bodyMarks = useSearchMarks()?.body;
  useEffect(() => {
    const [root, sentinel, bar] = [scrollerRef.current, sentinelRef.current, toolbarRef.current];
    return open && root && sentinel && bar ? installScrollHairline(root, sentinel, bar) : undefined;
  }, [open]);

  if (selectedId === null) return searching ? <SearchReaderEmpty /> : <Welcome />;
  const thread = detail?.thread;
  const cats = thread ? categories.filter((c) => thread.categoryIds.includes(c.id)) : [];
  const account = thread ? accounts.find((a) => a.id === thread.accountId) : undefined;
  const myEmails = accounts.map((a) => a.email);
  const replyAll = detail ? reachesSeveral(detail, myEmails) : false;
  // Move to Inbox (out of a tab) and Summarize both in the toolbar: no room left for Reply all's words in every language
  const crowded = summarizeOffered && summarizable(thread) && inSeparateTab(thread!, accounts);

  return (
    <section ref={sectionRef} tabIndex={page ? -1 : undefined} aria-labelledby={page && detail ? "reader-subject" : undefined} onPointerDownCapture={chooseOpenThread} className="@container flex h-full min-h-0 flex-col bg-background outline-none" data-testid="reader">
      {/* the same gutter as the conversation below, so the two columns share their edges */}
      <div ref={toolbarRef} className="drag-region scroll-hairline data-context:after:opacity-0! relative shrink-0 overflow-hidden [scrollbar-gutter:stable]">
        {/* on the conversation's column: the first glyph on its left edge, the last control on its right, whatever the width */}
        <div data-reader-toolbar className={cn(COLUMN, "relative flex h-[52px] items-center gap-2 @max-[420px]:gap-1 [&>:first-child]:-ml-2 @max-[560px]:[&>:first-child]:-ml-1.5")}>
        {page && (
          <div className={cn("flex items-center gap-2 @max-[420px]:gap-1 @min-[1080px]:right-full", BESIDE)}>
            <BackButton />
            {/* List's page hides the list, and with it the one place this design has New message */}
            {design.variants.compose === "list-header" && (
              <IconButton className={tool} label={t("list.compose")} shortcut="c" onClick={() => void openCompose("new")} data-testid="reader-compose">
                <SquarePen />
              </IconButton>
            )}
          </div>
        )}
        {page && <ToolbarDivider className="@min-[1080px]:hidden" />}
        <div className={cn("flex items-center gap-0.5", page && "@min-[1080px]:-ml-2")} role="group" aria-label={t("reader.group.organize")}>
        {thread?.inTrash || thread?.inSpam ? (
          <IconButton className={tool} label={t("actions.moveToInbox")} onClick={() => act(thread.inSpam ? "notSpam" : "moveToInbox")} data-testid="action-inbox">
            <Inbox />
          </IconButton>
        ) : (
          <>
            {/* plan 86: in Promotions or Social, out of the tab into the Inbox (Gmail learns from it) */}
            {thread && inSeparateTab(thread, accounts) && (
              <IconButton className={tool} label={t("actions.moveToInbox")} onClick={() => act("moveToInbox")} data-testid="action-inbox">
                <Inbox />
              </IconButton>
            )}
            <IconButton className={tool} label={t("actions.archive")} shortcut="e" onClick={() => act("archive")} data-testid="action-archive">
              <Archive />
            </IconButton>
          </>
        )}
        <IconButton className={tool} label={t("actions.trash")} shortcut="#" onClick={() => act("trash")} data-testid="action-trash">
          <Trash2 />
        </IconButton>
        <IconButton className={tool} label={t("reader.markSpam")} shortcut="!" onClick={() => act("spam")} data-testid="action-spam">
          <OctagonAlert />
        </IconButton>
        </div>
        <ToolbarDivider />
        <div className="flex items-center gap-0.5" role="group" aria-label={t("reader.group.mark")}>
        <IconButton className={tool} label={t("actions.category")} shortcut="l" onClick={() => setApp({ dialog: "categoryPicker", pickerMode: "toggle" })} data-testid="action-category">
          <Tag />
        </IconButton>
        {/* plan 87: a narrow reader (the minimum window) gives its place to the bell; the menu, the palette and ⌘⇧U keep it */}
        <IconButton label={t("actions.markUnread")} shortcut="mod+shift+u" onClick={() => act("markUnread")} data-testid="action-unread" className={cn(tool, "@max-[420px]:hidden")}>
          <Mail />
        </IconButton>
        {/* keyed by thread: moving to a starred thread swaps the button instead of fading its color (navigation never animates) */}
        <IconButton key={thread?.id ?? "none"} label={thread?.starred ? t("actions.unstar") : t("actions.star")} shortcut="s" onClick={() => toggleStar()} data-testid="action-star" className={cn(tool, thread?.starred && "text-star hover:text-star")}>
          <Star className={cn(thread?.starred && "fill-star")} />
        </IconButton>
        <RemindButton key={`remind-${selectedId}`} threadId={selectedId} />
        {summarizable(thread) && <SummarizeButton threadId={selectedId} />}
        <ToolbarMore threadId={selectedId} />
        </div>
        <ReplyGroup replyAll={replyAll} page={page} crowded={crowded} />
        {page && <ToolbarDivider className="@min-[1080px]:hidden" />}
        {page && <StepButtons id={selectedId} />}
        </div>
      </div>
      {bodyMarks?.length ? <ReaderMatches key={`${selectedId}:${JSON.stringify(bodyMarks)}`} scroller={scrollerRef} bottomInset={dock} /> : null}
      <div ref={scrollerRef} data-reader-scroller data-keep-scroll="reader" className="relative min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]" style={{ scrollPaddingTop: CONTEXT_H, ...(dock ? { paddingBottom: dock, scrollPaddingBottom: dock } : {}) }} onContextMenu={backgroundMenu}>
        <div ref={sentinelRef} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" />
        {detail && <ReaderContext key={`c${detail.thread.id}:${design.variants.readerHeader}`} scroller={scrollerRef} toolbar={toolbarRef} subject={detail.thread.subject || t("common.noSubject")} draftKey={draftKey} />}
        <div data-reader-column className={cn(COLUMN, "pt-2 pb-16 @max-[560px]:pt-0")}>
          {!detail && gone ? (
            <p data-testid="reader-gone" role="status" className="pt-8 text-center text-sm text-muted-foreground">
              {t("errors.threadGone")}
            </p>
          ) : !detail ? (
            <div className="space-y-3" data-testid="reader-skeleton">
              <div className="h-6 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-32 animate-pulse rounded-xl bg-muted/70" />
            </div>
          ) : (
            <>
              {fromDigest && <Button variant="link-secondary" size="xs" className="mb-2" data-testid="back-to-digest" onClick={() => { useToday.setState({ fromDigest: false }); setApp({ selectedId: DIGEST_ROW_ID }); }}>{t("today.digest.back")}</Button>}
              <Thread key={`t${detail.thread.id}`} detail={detail} account={account} cats={cats} summaryShown={summaryShown} />
              {/* plan 144: off, it never shows; a draft here means it's out of the way */}
              {repliesOn && !draftKey && <ReplyReady key={`r${detail.thread.id}`} threadId={detail.thread.id} />}
              <ScheduledReplyLine threadId={detail.thread.id} />
              <DraftSlot key={detail.thread.id} threadId={detail.thread.id} draftKey={draftKey} replyTo={replyName(detail, myEmails)} replyAll={replyAll} account={account} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
