import { DIGEST_ROW_ID } from "@terno/core";
import { useToday } from "~/state/today";
import "~/lib/replies";
import { folderName } from "~/lib/account-folders";
import { ReaderAttachments } from "./attachments";
import type { Account, Category, CategoryColor, MessageDetail, Reason, ThreadDetail } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { ButtonGroup, ButtonGroupItem } from "@terno/ui/components/button-group";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Separator } from "@terno/ui/components/separator";
import { Chip } from "@terno/ui/components/chip";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { IconButton } from "@terno/ui/components/icon-button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { TernoMark } from "@terno/ui/brand/terno-mark";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { Archive, Bell, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Forward, Inbox, Layers, Mail, OctagonAlert, Printer, Reply, ReplyAll, Sparkles, SquarePen, Star, Tag, Trash2 } from "@terno/ui/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { reminderShort, useReminders, useRemindPopover } from "~/lib/reminders";
import { installScrollHairline } from "~/lib/scroll-hairline";
import { cancelReaderScroll, keepInView, revealMessage } from "~/lib/reader-scroll";
import { takeSent } from "~/lib/sent-reveal";
import { Expand } from "./expand";
import { DraftSlot } from "./inline-draft";
import { bottomInset, usePinned } from "~/lib/pinned-draft-state";
import { ScheduledReplyLine } from "./scheduled-popover";
import { ForwardLine } from "./forward-line";
import { shownDraftKey, useDrafts } from "~/lib/drafts";
import { reachesSeveral, replyName } from "~/lib/compose-fields";
import { composeFocusPending, composeLanding, registerReaderFocusDestination, subscribeComposeFocus } from "~/lib/compose";
import { act, cancelMarkRead, openCompose, readChosenThread, scheduleMarkRead, toggleStar } from "~/lib/actions";
import { acceptSuggestion, answerReview, rejectSuggestion, removeFromCategory } from "~/lib/categorize";
import { t } from "@terno/i18n";
import { fullDate, messageDate } from "~/lib/format";
import { SenderAvatar } from "./sender-avatar";
import { chooseOpenThread, inSeparateTab, onThreadChosen, openedByApp, setApp, useApp } from "~/state/app";
import { hydrateSelectedThread, useThread, useThreadGone } from "~/state/threads";
import { printCommand } from "~/lib/print-open";
import { HtmlBody, TextBody } from "./mail-body";
import { MailReaderView } from "./mail-reader-view";
import { backgroundMenu, MessageMenu } from "./message-menu";
import { reasonText } from "~/lib/reasons";
import { useDesign, variant } from "~/lib/design";
import { Kbd } from "@terno/ui/components/kbd";
import { renderProbe } from "~/lib/render-probe";
import { useAppearance } from "~/lib/appearance";
import { goBack } from "~/lib/page";
import { move } from "~/lib/keyboard";
import { viewLabel } from "~/lib/format";
import { useList } from "~/state/list";
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
                  className={cn(tool, "text-muted-foreground hover:text-foreground", reminder && "text-primary hover:text-primary")}
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
const tool = "no-drag size-8 rounded-md @max-[560px]:size-7 [&_svg]:[--icon-line:var(--icon-line-toolbar)]";

// one column for the toolbar and the conversation, so their edges agree at every width (narrow: less margin, for the toolbar's icons)
const COLUMN = "mx-auto w-full max-w-(--reader-max) px-(--reader-pad-x) @max-[420px]:px-4";

/** Between the toolbar's groups; a narrow reader has no room for it. */
const ToolbarDivider = () => <Separator orientation="vertical" className="my-auto h-4 @max-[420px]:hidden" />;

/**
 * One way to reply: Reply in words, and the others a click away beside it. Reply all only when it reaches someone Reply
 * doesn't (`a` still works: it's the same as Reply then). The pill also shows its key.
 */
function ReplyGroup({ replyAll }: { replyAll: boolean }) {
  const pill = useDesign().variants.replyAction === "pill";
  const trigger = useRef<HTMLButtonElement>(null);
  // a choice hands focus to the draft, and any focus moved meanwhile would cancel that; refused (a forward's files, say), the button takes it back
  const chosen = useRef(false);
  const choose = (mode: "replyAll" | "forward") => {
    chosen.current = true;
    void composeLanding(mode).then((landing) => {
      if (landing.kind === "none" && document.activeElement === document.body) trigger.current?.focus();
    });
  };
  return (
    <ButtonGroup aria-label={t("reader.group.respond")} className={cn("no-drag [&_svg]:[--icon-line:var(--icon-line-toolbar)]", pill && "rounded-full")}>
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
      <DropdownMenu onOpenChange={(open) => setApp({ menuOpen: open })}>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={<ButtonGroupItem ref={trigger} iconOnly aria-label={t("reader.replyMenu")} data-testid="action-reply-menu" className={cn("w-7", pill && "w-8 pr-0.5")} />}
              />
            }
          >
            <ChevronDown className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>{t("reader.replyMenu")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="w-48"
          data-testid="reply-menu"
          finalFocus={() => {
            const handedOff = chosen.current;
            chosen.current = false;
            return !handedOff;
          }}
        >
          <DropdownMenuGroup>
            {replyAll && (
              <DropdownMenuItem data-testid="action-reply-all" onClick={() => choose("replyAll")}>
                <ReplyAll />
                <span className="flex-1">{t("actions.replyAll")}</span>
                <DropdownMenuShortcut>A</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem data-testid="action-forward" onClick={() => choose("forward")}>
              <Forward />
              <span className="flex-1">{t("actions.forward")}</span>
              <DropdownMenuShortcut>F</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
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

/** A message header's state, at the column's edge: it turns as the message opens. */
function Disclosure({ open }: { open: boolean }) {
  return <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 self-center text-muted-foreground transition-transform duration-base ease-motion group-hover/mh:text-foreground", open && "rotate-90 self-start mt-1")} />;
}

/**
 * `headless`: the sender card above the subject shows this message's header (Lumen, one message: plan 59), so it
 * renders its body alone and never folds. Only the header comes and goes: the body keeps its place (and its frames)
 * when a second message arrives. `knownEmail`: an address already on screen (the card's), not revealed again on hover.
 */
function Message({ m, expanded, onToggle, icons, headless, knownEmail }: { m: MessageDetail; expanded: boolean; onToggle: () => void; icons: boolean; headless: boolean; knownEmail: string | null }) {
  const remoteImages = useApp((s) => s.settings?.remoteImages ?? "ask");
  const mailAppearance = useApp((s) => s.settings?.htmlMailAppearance ?? "auto");
  const name = m.from.name || m.from.email;
  const bodyId = `msg-body-${m.id}`;
  const open = headless || expanded;
  return (
    <article data-testid="message" data-message-id={m.id} data-expanded={open || undefined} className="hairline-b">
      {/* one heading and one button in both states, so the focused control survives expanding and collapsing */}
      {!headless && <h3>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          title={fullDate(m.date)}
          onClick={onToggle}
          data-testid="message-toggle"
          className={cn(
            "group/mh -mx-2 flex w-[calc(100%+1rem)] gap-2.5 rounded-lg px-2 text-left outline-none transition-colors hover:bg-tint focus-visible:ring-2 focus-visible:ring-ring",
            expanded ? "items-start pt-2.5 pb-1.5" : "h-9 items-center text-sm",
          )}
        >
          {expanded ? (
            <>
              <SenderAvatar name={name} email={m.from.email} icon={icons} className="mt-px size-(--avatar-message) text-2xs" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="type-sender-name min-w-0 truncate">{name}</span>
                  {m.from.name && m.from.email.toLowerCase() !== knownEmail?.toLowerCase() && <span className="min-w-0 flex-1 basis-0 truncate text-xs text-muted-foreground opacity-0 group-hover/mh:opacity-100 group-focus-reveal/mh:opacity-100">{m.from.email}</span>}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular">{messageDate(m.date)}</span>
                </span>
                <Recipients m={m} className="mt-px" />
              </span>
              <Disclosure open />
            </>
          ) : (
            <>
              <SenderAvatar name={name} email={m.from.email} icon={icons} className="size-(--avatar-collapsed) text-2xs" />
              <span className="shrink-0 font-medium">{name}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{m.snippet}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular">{messageDate(m.date)}</span>
              <Disclosure open={false} />
            </>
          )}
        </button>
      </h3>}
      {/* the region is always there (aria-controls); its content is mounted only while open */}
      <div id={bodyId}>
        <Expand open={open} onOpening={(el) => keepInView(el.closest("article") ?? el)}>
          <div className={cn("pb-5", headless ? "pt-4" : "pt-1.5")}>
            {m.bodyHtml ? (
              <HtmlBody html={m.bodyHtml} messageId={m.id} accountId={m.accountId} attachments={m.attachments} remoteImages={remoteImages} spam={!icons} appearance={mailAppearance} />
            ) : m.bodyText !== null ? (
              <TextBody text={m.bodyText} />
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
 * The conversation: every message, with runs of 4+ collapsed ones folded into
 * one "N more messages" disclosure. Keyed by thread: each one starts from its
 * defaults (unread messages and the last one open) on mount, so a swap never
 * animates, and keeps each message's while it is shown: the dwell's mark-read
 * or a newer message never folds one away under the reader.
 */
/** `icons`: senders' icons may be asked for (never in spam: plan 22) */
/** `headless`: the card above shows the one message's header (plan 59); `knownEmail`: the card's address */
function Conversation({ messages, icons, headless, knownEmail }: { messages: MessageDetail[]; icons: boolean; headless: boolean; knownEmail: string | null }) {
  renderProbe("Conversation");
  const last = messages[messages.length - 1];
  const opensAt = (m: MessageDetail) => !m.isRead || m.id === last?.id;
  const [shown, setShown] = useState(() => new Map(messages.map((m) => [m.id, opensAt(m)])));
  // one arriving later keeps how it first showed too (a render more, only then: never on a thread switch)
  useEffect(() => {
    const unseen = messages.filter((m) => !shown.has(m.id));
    if (!unseen.length) return;
    // a reply just sent from here: the reader goes to it, open (newer mail can follow it, never folds it away)
    const sent = takeSent(unseen.map((m) => m.id));
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
  const toggle = (id: number, now: boolean) => setState({ ...own, toggled: new Map(own.toggled).set(id, !now) });
  // every message of a revealed run stays unfolded, whatever opens or closes around it later
  const reveal = (ids: number[]) => {
    setState({ ...own, revealed: new Set([...own.revealed, ...ids]) });
    // the button goes away: focus moves to the first message it revealed
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[aria-controls="msg-body-${ids[0]}"]`)?.focus());
  };

  const items: ({ kind: "message"; m: MessageDetail } | { kind: "more"; ids: number[] })[] = [];
  for (let i = 0; i < messages.length; ) {
    let j = i;
    while (j < messages.length && !isOpen(messages[j]!)) j++;
    const run = j - i;
    const ids = messages.slice(i, j).map((m) => m.id);
    if (run >= 4 && !ids.some((id) => own.revealed.has(id))) {
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
    <div className="hairline-t">
      {items.map((it) =>
        it.kind === "message" ? (
          <Message key={it.m.id} m={it.m} icons={icons} headless={headless && messages.length === 1} knownEmail={knownEmail} expanded={isOpen(it.m)} onToggle={() => toggle(it.m.id, isOpen(it.m))} />
        ) : (
          <div key={`more-${it.ids[0]}`} className="hairline-b">
            <button
              type="button"
              aria-expanded="false"
              aria-controls={`more-${it.ids[0]}`}
              onClick={() => reveal(it.ids)}
              data-testid="more-messages"
              className="group/mh -mx-2 flex h-9 w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-tint hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Layers className="size-3.5" />
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

/** The account, the categories (with why and how to undo) and the engine's suggestions (y / n): the same in every design. */
function ThreadChips({ detail, account, cats, className }: { detail: ThreadDetail; account: Account | undefined; cats: Category[]; className?: string }) {
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

/** Who the conversation is with: the last person who wrote who isn't you (or its sender when every message is yours). */
function senderOf(detail: ThreadDetail): { name: string; email: string } {
  const last = [...detail.messages].reverse().find((m) => !m.isSent);
  return last ? { name: last.from.name || last.from.email, email: last.from.email } : { name: detail.thread.fromName || detail.thread.fromEmail, email: detail.thread.fromEmail };
}

/** The subject, chips and (Lumen) sender above the conversation: the design arranges the same parts, and the mail starts soon after them. */
function ReaderHeader({ detail, account, cats }: { detail: ThreadDetail; account: Account | undefined; cats: Category[] }) {
  const design = useDesign();
  const subject = detail.thread.subject || t("common.noSubject");
  const heading = <h2 id="reader-subject" data-testid="reader-subject" className="type-reader-subject min-w-0">{subject}</h2>;
  // on the subject's line, at the dates' edge, while they fit; on a line of their own when they don't
  const titled = (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      {heading}
      <ThreadChips detail={detail} account={account} cats={cats} />
    </div>
  );
  return variant(design.variants.readerHeader, {
    classic: <div className="mb-3">{titled}</div>,
    "chips-display": (
      <div className="mb-3">
        <ThreadChips detail={detail} account={account} cats={cats} className="mb-1.5" />
        {heading}
      </div>
    ),
    "sender-card": (() => {
      // one message: the card is its header (who wrote it, to whom, when), so the message shows no second one (plan 59)
      const one = detail.messages.length === 1 ? detail.messages[0]! : null;
      const who = one ? { name: one.from.name || one.from.email, email: one.from.email } : senderOf(detail);
      return (
        <div className="mb-3">
          {titled}
          {/* the message's id: a right-click here is a right-click on the message (Print this message, Copy) */}
          <div data-testid="sender-card" data-message-id={one?.id} className="mt-1.5 flex items-start gap-2.5">
            <SenderAvatar name={who.name} email={who.email} icon={iconsFor(detail.thread)} className="size-(--avatar-sender) text-xs" />
            <div className="flex min-h-(--avatar-sender) min-w-0 flex-1 flex-col justify-center">
              <span className="flex items-baseline gap-2">
                <span className="type-sender-name min-w-0 truncate">{who.name}</span>
                {who.name !== who.email && <span className="min-w-0 flex-1 basis-0 truncate text-xs text-muted-foreground">{who.email}</span>}
                {one && <MessageDate ms={one.date} className="ml-auto shrink-0 text-xs text-muted-foreground" />}
              </span>
              {one && <Recipients m={one} className="mt-px" />}
            </div>
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

/** List's page (plan 24): Back to the list, at the toolbar's start. */
function BackButton() {
  const title = useListTitle();
  return (
    <IconButton className={tool} label={t("reader.back", { mailbox: title })} shortcut="escape" onClick={goBack} data-testid="reader-back">
      <ChevronLeft />
    </IconButton>
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
    <div className="-mr-2 flex items-center gap-0.5 @max-[560px]:-mr-1.5" role="group" aria-label={t("reader.group.navigate")}>
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
  // plan 147: Dev mode's switch off, what's stored stays out of sight too; elsewhere reading is never gated (plan 132)
  const summaryShown = useApp(aiAllowed);
  const fromDigest = useToday((s) => s.fromDigest);

  useEffect(() => {
    if (draftShown?.threadId === selectedId && draftShown.key !== draftKey) setApp({ draftShown: null });
  }, [draftShown, selectedId, draftKey]);

  const toolbarRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const open = selectedId !== null;
  useEffect(() => {
    const [root, sentinel, bar] = [scrollerRef.current, sentinelRef.current, toolbarRef.current];
    return open && root && sentinel && bar ? installScrollHairline(root, sentinel, bar) : undefined;
  }, [open]);

  if (selectedId === null) return <Welcome />;
  const thread = detail?.thread;
  const cats = thread ? categories.filter((c) => thread.categoryIds.includes(c.id)) : [];
  const account = thread ? accounts.find((a) => a.id === thread.accountId) : undefined;
  const cardHeader = design.variants.readerHeader === "sender-card";
  const myEmails = accounts.map((a) => a.email);
  const replyAll = detail ? reachesSeveral(detail, myEmails) : false;

  return (
    <section ref={sectionRef} tabIndex={page ? -1 : undefined} aria-labelledby={page && detail ? "reader-subject" : undefined} onPointerDownCapture={chooseOpenThread} className="@container flex h-full min-h-0 flex-col bg-background outline-none" data-testid="reader">
      <div ref={toolbarRef} className="drag-region scroll-hairline shrink-0">
        {/* on the conversation's column: the first glyph on its left edge, the last control on its right, whatever the width */}
        <div data-reader-toolbar className={cn(COLUMN, "flex h-[52px] items-center gap-2 @max-[420px]:gap-1 [&>:first-child]:-ml-2 @max-[560px]:[&>:first-child]:-ml-1.5")}>
        {page && <BackButton />}
        {/* List's page hides the list, and with it the one place this design has New message */}
        {page && design.variants.compose === "list-header" && (
          <IconButton className={tool} label={t("list.compose")} shortcut="c" onClick={() => void openCompose("new")} data-testid="reader-compose">
            <SquarePen />
          </IconButton>
        )}
        {page && <ToolbarDivider />}
        <div className="flex items-center gap-0.5" role="group" aria-label={t("reader.group.organize")}>
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
        <IconButton className={tool} label={t("actions.spam")} shortcut="!" onClick={() => act("spam")} data-testid="action-spam">
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
        </div>
        <div className="ml-auto flex items-center" role="group" aria-label={t("reader.group.print")}>
          <IconButton className={tool} label={t("actions.print")} shortcut="mod+p" onClick={() => printCommand("print")} data-testid="action-print">
            <Printer />
          </IconButton>
        </div>
        <ReplyGroup replyAll={replyAll} />
        {page && <ToolbarDivider />}
        {page && <StepButtons id={selectedId} />}
        </div>
      </div>
      <div ref={scrollerRef} data-reader-scroller data-keep-scroll="reader" className="relative min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]" style={dock ? { paddingBottom: dock, scrollPaddingBottom: dock, "--reader-dock": `${dock}px` } as React.CSSProperties : undefined} onContextMenu={backgroundMenu}>
        <div ref={sentinelRef} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" />
        <div data-reader-column className={cn(COLUMN, "pt-2 pb-16")}>
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
              <MessageMenu threadId={detail.thread.id}>
                <div data-conversation-menu>
                  {/* inside the menu: Lumen's card can stand for the message (plan 59) */}
                  <ReaderHeader detail={detail} account={account} cats={cats} />
                  <ThreadFollowups key={`f${detail.thread.id}`} detail={detail} />
                  {summaryShown && <ThreadSummary key={`s${detail.thread.id}`} detail={detail} />}
                  <Conversation key={detail.thread.id} messages={detail.messages} icons={iconsFor(detail.thread)} headless={cardHeader} knownEmail={cardHeader ? senderOf(detail).email : null} />
                </div>
              </MessageMenu>
              {/* plan 144: off, it never shows; a draft here means it's out of the way */}
              {repliesOn && !draftKey && <ReplyReady key={`r${detail.thread.id}`} threadId={detail.thread.id} />}
              <ScheduledReplyLine threadId={detail.thread.id} />
              <DraftSlot key={detail.thread.id} threadId={detail.thread.id} draftKey={draftKey} replyTo={replyName(detail, myEmails)} replyAll={replyAll} account={account} icons={iconsFor(detail.thread)} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
