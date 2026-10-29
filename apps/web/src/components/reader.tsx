import { ReaderAttachments } from "./attachments";
import type { Account, Category, CategoryColor, MessageDetail, Reason, ThreadDetail } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { CategoryBadge, CategoryDot } from "@terno/ui/components/category-dot";
import { Shortcut } from "@terno/ui/components/shortcut";
import { TernoMark } from "@terno/ui/brand/terno-mark";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { Archive, ChevronDown, ChevronLeft, ChevronUp, Forward, Inbox, Layers, MailOpen, OctagonAlert, Printer, Reply, ReplyAll, Star, Tag, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { installScrollHairline } from "~/lib/scroll-hairline";
import { cancelReaderScroll, keepInView } from "~/lib/reader-scroll";
import { Expand } from "./expand";
import { DraftSlot } from "./inline-draft";
import { shownDraftKey, useDrafts } from "~/lib/drafts";
import { replyName } from "~/lib/compose-fields";
import { composeFocusPending, registerReaderFocusDestination, subscribeComposeFocus } from "~/lib/compose";
import { act, cancelMarkRead, openCompose, scheduleMarkRead, toggleStar } from "~/lib/actions";
import { acceptSuggestion, rejectSuggestion, removeFromCategory } from "~/lib/categorize";
import { t } from "@terno/i18n";
import { fullDate, listDate } from "~/lib/format";
import { SenderAvatar } from "./sender-avatar";
import { setApp, useApp } from "~/state/app";
import { loadThread, useThread, useThreadGone } from "~/state/threads";
import { printCommand } from "~/lib/print-open";
import { HtmlBody, TextBody } from "./mail-body";
import { MessageMenu } from "./message-menu";
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

function ToolButton({ label, keys, onClick, children, testId, active, disabled, busy }: { label: string; keys?: string; onClick: () => void; children: React.ReactNode; testId?: string; active?: boolean; disabled?: boolean; busy?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={label} data-testid={testId} onClick={onClick} disabled={disabled} aria-busy={busy || undefined} className={cn("no-drag rounded-md text-muted-foreground hover:text-foreground [&_svg]:[stroke-width:var(--icon-stroke-toolbar)]", active && "text-star hover:text-star")}>
            {children}
          </Button>
        }
      />
      <TooltipContent className="flex items-center gap-2">
        {label}
        {keys && <Shortcut keys={keys} />}
      </TooltipContent>
    </Tooltip>
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
      <span className="font-medium text-foreground">{t("reader.to")}</span> {people(m.to)}
      {m.cc.length > 0 && (
        <>
          {" · "}
          <span className="font-medium text-foreground">{t("reader.cc")}</span> {people(m.cc)}
        </>
      )}
    </span>
  );
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
            "group/mh flex w-full text-left",
            expanded ? "items-start gap-3 rounded-md pt-[18px] pb-3" : "-mx-2 my-0.5 h-11 w-[calc(100%+1rem)] items-center gap-2.5 rounded-lg px-2 text-sm transition-colors hover:bg-tint",
          )}
        >
          {expanded ? (
            <>
              <SenderAvatar name={name} email={m.from.email} icon={icons} className="size-(--avatar-message) text-xs" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="type-sender-name truncate">{name}</span>
                  {m.from.name && m.from.email.toLowerCase() !== knownEmail?.toLowerCase() && <span className="truncate text-xs text-muted-foreground opacity-0 group-hover/mh:opacity-100 group-focus-reveal/mh:opacity-100">{m.from.email}</span>}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular">{listDate(m.date)}</span>
                </span>
                <Recipients m={m} className="mt-px" />
              </span>
            </>
          ) : (
            <>
              <SenderAvatar name={name} email={m.from.email} icon={icons} className="size-(--avatar-collapsed) text-2xs" />
              <span className="shrink-0 font-medium">{name}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{m.snippet}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular">{listDate(m.date)}</span>
            </>
          )}
        </button>
      </h3>}
      {/* the region is always there (aria-controls); its content is mounted only while open */}
      <div id={bodyId}>
        <Expand open={open} onOpening={(el) => keepInView(el.closest("article") ?? el)}>
          {!headless && <div className="hairline-t ml-[calc(var(--avatar-message)+0.75rem)]" />}
          <div className={cn("pb-5", headless ? "pt-5" : "pt-3.5")}>
            {m.bodyHtml ? (
              <HtmlBody html={m.bodyHtml} messageId={m.id} accountId={m.accountId} attachments={m.attachments} remoteImages={remoteImages} appearance={mailAppearance} />
            ) : m.bodyText !== null ? (
              <TextBody text={m.bodyText} />
            ) : (
              <p className="text-sm text-muted-foreground italic">{m.bodyUnavailable ? t("attachments.bodyUnavailable") : m.bodyState === "full" ? t("attachments.noBody") : t("reader.downloading")}</p>
            )}
            {m.attachments.length > 0 && <ReaderAttachments messageId={m.id} accountId={m.accountId} attachments={m.attachments} />}
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
    if (unseen.length) setShown(new Map([...shown, ...unseen.map((m) => [m.id, opensAt(m)] as const)]));
  }, [messages]);
  const [own, setState] = useState<{ toggled: Map<number, boolean>; revealed: Set<number> }>({ toggled: new Map(), revealed: new Set() });
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
              className="-mx-2 my-0.5 flex h-9 w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-tint hover:text-foreground"
            >
              <Layers className="size-3.5" />
              {t("reader.moreMessages", { count: it.ids.length })}
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

/** The account a conversation is in, as a chip: its color and its address (or name). */
function AccountChip({ account, full }: { account: Account; full: boolean }) {
  return (
    <span data-testid="reader-account" className="inline-flex h-6 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs text-muted-foreground">
      <CategoryDot color={account.color as CategoryColor} />
      {full ? account.email : account.displayName}
    </span>
  );
}

/** The account, the categories (with why and how to undo) and the engine's suggestions (y / n): the same in every design. */
function ThreadChips({ detail, account, cats, accountChip, className }: { detail: ThreadDetail; account: Account | undefined; cats: Category[]; accountChip: false | "address" | "name"; className?: string }) {
  const categories = useApp((s) => s.categories);
  const thread = detail.thread;
  return (
    <div data-testid="thread-chips" className={cn("flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground", className)}>
      {account && (accountChip ? <AccountChip account={account} full={accountChip === "address"} /> : <span>{account.email}</span>)}
      {cats.map((c) => {
        const auto = detail.categorization?.auto.find((a) => a.categoryId === c.id);
        return (
          <CategoryBadge key={c.id} color={c.color as CategoryColor}>
            {c.name}
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
            <button type="button" aria-label={auto ? t("reader.category.notIt", { category: c.name }) : t("reader.category.remove", { category: c.name })} className="text-muted-foreground hover:text-foreground" onClick={() => void removeFromCategory(c.id, [thread.id])}>
              <X className="size-3" />
            </button>
          </CategoryBadge>
        );
      })}
      {detail.categorization?.suggestions.map((sg, i) => {
        const c = categories.find((x) => x.id === sg.categoryId);
        if (!c) return null;
        return (
          <span key={sg.categoryId} data-testid="suggestion-chip" className="inline-flex h-5 items-center rounded-full border border-dashed border-primary/40 text-xs text-foreground">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button type="button" data-testid="suggestion-accept" onClick={() => void acceptSuggestion(thread.id, c.id)} className="inline-flex h-full items-center gap-1 rounded-l-full pr-1 pl-1.5 hover:bg-accent">
                    <CategoryDot color={c.color as CategoryColor} />{t("reader.suggestion", { category: c.name })}{i === 0 && <Shortcut keys="y" className="ml-0.5 [&_kbd]:h-3.5 [&_kbd]:min-w-3.5 [&_kbd]:text-[10px]" />}
                  </button>
                }
              />
              <Reasons title={t("reader.suggestion.title", { category: c.name, percent: Math.round(sg.p * 100) })} reasons={sg.reasons} hint={i === 0 ? t("reader.suggestion.hint") : undefined} />
            </Tooltip>
            <button type="button" aria-label={t("reader.category.notIt", { category: c.name })} data-testid="suggestion-reject" onClick={() => void rejectSuggestion(thread.id, c.id)} className="inline-flex h-full items-center rounded-r-full px-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="size-3" />
            </button>
          </span>
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
      <span aria-hidden>{listDate(ms)}</span>
      <span className="sr-only">{full}</span>
    </time>
  );
}

/** Who the conversation is with: the last person who wrote who isn't you (or its sender when every message is yours). */
function senderOf(detail: ThreadDetail): { name: string; email: string } {
  const last = [...detail.messages].reverse().find((m) => !m.isSent);
  return last ? { name: last.from.name || last.from.email, email: last.from.email } : { name: detail.thread.fromName || detail.thread.fromEmail, email: detail.thread.fromEmail };
}

/** The subject, chips and (Lumen) sender above the conversation: the design arranges the same parts. */
function ReaderHeader({ detail, account, cats }: { detail: ThreadDetail; account: Account | undefined; cats: Category[] }) {
  const design = useDesign();
  const subject = detail.thread.subject || t("common.noSubject");
  return variant(design.variants.readerHeader, {
    classic: (
      <>
        <h2 id="reader-subject" data-testid="reader-subject" className="text-xl font-semibold tracking-display text-balance">
          {subject}
        </h2>
        <ThreadChips detail={detail} account={account} cats={cats} accountChip={false} className="mt-2 mb-5" />
      </>
    ),
    "chips-display": (
      <>
        <ThreadChips detail={detail} account={account} cats={cats} accountChip="address" className="mt-4" />
        <h2 id="reader-subject" data-testid="reader-subject" className="type-reader-subject mt-4 mb-8 text-balance">
          {subject}
        </h2>
      </>
    ),
    "sender-card": (() => {
      // one message: the card is its header (who wrote it, to whom, when), so the message shows no second one (plan 59)
      const one = detail.messages.length === 1 ? detail.messages[0]! : null;
      const who = one ? { name: one.from.name || one.from.email, email: one.from.email } : senderOf(detail);
      return (
        <>
          {/* the message's id: a right-click here is a right-click on the message (Print this message, Copy) */}
          <div data-testid="sender-card" data-message-id={one?.id} className="mt-2 flex items-center gap-4">
            <SenderAvatar name={who.name} email={who.email} icon={iconsFor(detail.thread)} className="size-(--avatar-sender) text-lg" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-baseline gap-3">
                <span className="type-sender-name min-w-0 truncate">{who.name}</span>
                {one && <MessageDate ms={one.date} className="ml-auto shrink-0 text-sm text-muted-foreground" />}
              </span>
              {who.name !== who.email && <span className="truncate text-sm text-muted-foreground">{who.email}</span>}
              {one && <Recipients m={one} className="mt-0.5" />}
              <ThreadChips detail={detail} account={account} cats={cats} accountChip="name" className="mt-1.5" />
            </div>
          </div>
          <h2 id="reader-subject" data-testid="reader-subject" className="type-reader-subject mt-8 mb-6 text-balance">
            {subject}
          </h2>
        </>
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
    return s.categories.find((c) => c.id === s.categoryId)?.name ?? viewLabel(s.view);
  });
}

/** List's page (plan 24): Back to the list, at the toolbar's start. */
function BackButton() {
  const title = useListTitle();
  return (
    <ToolButton label={t("reader.back", { mailbox: title })} keys="escape" onClick={goBack} testId="reader-back">
      <ChevronLeft />
    </ToolButton>
  );
}

/** List's page: the newer and older conversations (k and j), at the toolbar's end; nothing to step from a thread the list doesn't hold. */
function StepButtons({ id }: { id: number }) {
  const at = useList((s) => s.index.get(id));
  const last = useList((s) => s.items.length - 1);
  const more = useList((s) => s.nextCursor !== null);
  const busy = useList((s) => s.loadingMore);
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label={t("reader.group.navigate")}>
      <ToolButton label={t("reader.newer")} keys="k" onClick={() => move(-1)} testId="reader-newer" disabled={at === undefined || at === 0}>
        <ChevronUp />
      </ToolButton>
      <ToolButton label={t("reader.older")} keys="j" onClick={() => move(1)} testId="reader-older" disabled={at === undefined || (at >= last && !more)} busy={busy && at === last}>
        <ChevronDown />
      </ToolButton>
    </div>
  );
}

/** Plan 22: never icons for spam: a thread in Spam, or one with spam mail wherever it is now (trashed spam too). */
const iconsFor = (t: { inSpam: boolean; hasSpam?: boolean }) => !t.inSpam && !t.hasSpam;

export function Reader() {
  const selectedId = useApp((s) => s.selectedId);
  const page = useAppearance((s) => s.layout === "list");
  // List's page: the dock sits over the conversation's foot, so its end (the reply bar) scrolls clear of it
  const dock = useSnack((s) => (page ? s.inset : 0));
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
    const t = setTimeout(() => void loadThread(selectedId), detail ? 0 : 40);
    scheduleMarkRead(selectedId);
    return () => clearTimeout(t);
  }, [selectedId]);

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

  return (
    <section ref={sectionRef} tabIndex={page ? -1 : undefined} aria-labelledby={page && detail ? "reader-subject" : undefined} className="@container flex h-full min-h-0 flex-col bg-background outline-none" data-testid="reader">
      <div ref={toolbarRef} className="drag-region scroll-hairline flex h-[52px] shrink-0 items-center gap-3 px-3.5">
        {page && <BackButton />}
        <div className="flex items-center gap-0.5" role="group" aria-label={t("reader.group.organize")}>
        {thread?.inTrash || thread?.inSpam ? (
          <ToolButton label={t("actions.moveToInbox")} onClick={() => act(thread.inSpam ? "notSpam" : "moveToInbox")} testId="action-inbox">
            <Inbox />
          </ToolButton>
        ) : (
          <ToolButton label={t("actions.archive")} keys="e" onClick={() => act("archive")} testId="action-archive">
            <Archive />
          </ToolButton>
        )}
        <ToolButton label={t("actions.trash")} keys="#" onClick={() => act("trash")} testId="action-trash">
          <Trash2 />
        </ToolButton>
        <ToolButton label={t("actions.spam")} keys="!" onClick={() => act("spam")} testId="action-spam">
          <OctagonAlert />
        </ToolButton>
        </div>
        <div className="flex items-center gap-0.5" role="group" aria-label={t("reader.group.mark")}>
        <ToolButton label={t("actions.category")} keys="l" onClick={() => setApp({ dialog: "categoryPicker", pickerMode: "toggle" })} testId="action-category">
          <Tag />
        </ToolButton>
        <ToolButton label={t("actions.markUnread")} keys="u" onClick={() => act("markUnread")} testId="action-unread">
          <MailOpen />
        </ToolButton>
        {/* keyed by thread: moving to a starred thread swaps the button instead of fading its color (navigation never animates) */}
        <ToolButton key={thread?.id ?? "none"} label={thread?.starred ? t("actions.unstar") : t("actions.star")} keys="s" onClick={() => toggleStar()} testId="action-star" active={thread?.starred}>
          <Star className={cn(thread?.starred && "fill-star")} />
        </ToolButton>
        </div>
        <div className="ml-auto flex items-center gap-0.5" role="group" aria-label={t("reader.group.respond")}>
          {design.variants.replyAction === "pill" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="outline" size="sm" data-testid="action-reply" onClick={() => openCompose("reply")} className="no-drag mr-1 h-8 gap-2 rounded-full px-3.5 font-semibold shadow-none @max-[560px]:w-8 @max-[560px]:px-0 [&_svg]:[stroke-width:var(--icon-stroke-toolbar)]">
                    <Reply />
                    {/* the name is the visible label (still read when a narrow reader shows the icon alone); the key is decoration */}
                    <span className="@max-[560px]:sr-only">{t("actions.reply")}</span>
                    <Kbd aria-hidden className="@max-[560px]:hidden">R</Kbd>
                  </Button>
                }
              />
              <TooltipContent className="flex items-center gap-2">
                {t("actions.reply")}
                <Shortcut keys="r" />
              </TooltipContent>
            </Tooltip>
          ) : (
            <ToolButton label={t("actions.reply")} keys="r" onClick={() => openCompose("reply")} testId="action-reply">
              <Reply />
            </ToolButton>
          )}
          <ToolButton label={t("actions.replyAll")} keys="a" onClick={() => openCompose("replyAll")} testId="action-reply-all">
            <ReplyAll />
          </ToolButton>
          <ToolButton label={t("actions.forward")} keys="f" onClick={() => openCompose("forward")} testId="action-forward">
            <Forward />
          </ToolButton>
        </div>
        <div className="flex items-center" role="group" aria-label={t("reader.group.print")}>
          <ToolButton label={t("actions.print")} keys="mod+p" onClick={() => printCommand("print")} testId="action-print">
            <Printer />
          </ToolButton>
        </div>
        {page && <StepButtons id={selectedId} />}
      </div>
      <div ref={scrollerRef} data-reader-scroller data-keep-scroll="reader" className="relative min-h-0 flex-1 overflow-y-auto" style={dock ? { paddingBottom: dock, scrollPaddingBottom: dock } : undefined}>
        <div ref={sentinelRef} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" />
        <div className="mx-auto max-w-(--reader-max) px-(--reader-pad-x) pt-5 pb-16">
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
              <MessageMenu threadId={detail.thread.id}>
                <div>
                  {/* inside the menu: Lumen's card can stand for the message (plan 59) */}
                  <ReaderHeader detail={detail} account={account} cats={cats} />
                  <Conversation key={detail.thread.id} messages={detail.messages} icons={iconsFor(detail.thread)} headless={cardHeader} knownEmail={cardHeader ? senderOf(detail).email : null} />
                </div>
              </MessageMenu>
              <DraftSlot key={detail.thread.id} threadId={detail.thread.id} draftKey={draftKey} replyTo={replyName(detail, accounts.map((a) => a.email))} account={account} icons={iconsFor(detail.thread)} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
