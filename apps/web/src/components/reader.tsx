import type { CategoryColor, MessageDetail } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { CategoryBadge, CategoryDot } from "@terno/ui/components/category-dot";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { Archive, Forward, Inbox, Layers, MailOpen, OctagonAlert, Printer, Reply, ReplyAll, Star, Tag, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { installScrollHairline } from "~/lib/scroll-hairline";
import { cancelReaderScroll, keepInView } from "~/lib/reader-scroll";
import { Expand } from "./expand";
import { DraftSlot } from "./inline-draft";
import { shownDraftKey, useDrafts } from "~/lib/drafts";
import { act, cancelMarkRead, openCompose, scheduleMarkRead, toggleStar } from "~/lib/actions";
import { acceptSuggestion, rejectSuggestion, removeFromCategory } from "~/lib/categorize";
import { t } from "@terno/i18n";
import { avatarColor, formatBytes, fullDate, initials, listDate } from "~/lib/format";
import { setApp, useApp } from "~/state/app";
import { loadThread, useThread } from "~/state/threads";
import { printCommand } from "~/lib/print-open";
import { HtmlBody, TextBody } from "./mail-body";
import { MessageMenu } from "./message-menu";

const AVATAR_BG: Record<string, string> = {
  rose: "bg-cat-rose/15 text-cat-rose-ink",
  amber: "bg-cat-amber/15 text-cat-amber-ink",
  lime: "bg-cat-lime/15 text-cat-lime-ink",
  emerald: "bg-cat-emerald/15 text-cat-emerald-ink",
  cyan: "bg-cat-cyan/15 text-cat-cyan-ink",
  indigo: "bg-cat-indigo/15 text-cat-indigo-ink",
  violet: "bg-cat-violet/15 text-cat-violet-ink",
  slate: "bg-cat-slate/15 text-cat-slate-ink",
};

function ToolButton({ label, keys, onClick, children, testId, active }: { label: string; keys?: string; onClick: () => void; children: React.ReactNode; testId?: string; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={label} data-testid={testId} onClick={onClick} className={cn("no-drag rounded-md text-muted-foreground hover:text-foreground [&_svg]:stroke-[1.75]", active && "text-star hover:text-star")}>
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
function Reasons({ title, reasons, hint }: { title: string; reasons: string[]; hint?: string }) {
  return (
    <TooltipContent className="max-w-72 flex-col items-start gap-1 text-left" data-testid="category-reasons">
      <p className="font-medium">{title}</p>
      {reasons.length > 0 && <p>{reasons.join(" · ")}</p>}
      {hint && <p className="text-muted-foreground">{hint}</p>}
    </TooltipContent>
  );
}

/** The extension a tile shows on its document glyph ("PDF", "XLSX"), or nothing. */
/** Who a reply goes to, by first name: the last person who wrote. */
function replyTo(messages: MessageDetail[]): string {
  const last = [...messages].reverse().find((m) => !m.isSent) ?? messages[messages.length - 1];
  return last ? (last.from.name || last.from.email).split(/\s+/)[0]! : "";
}

function fileType(name: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1];
  return ext ? ext.toUpperCase() : "";
}

function Message({ m, expanded, onToggle }: { m: MessageDetail; expanded: boolean; onToggle: () => void }) {
  const remoteImages = useApp((s) => s.settings?.remoteImages ?? "ask");
  const localMode = useApp((s) => s.settings?.localMode ?? true);
  const mailAppearance = useApp((s) => s.settings?.htmlMailAppearance ?? "auto");
  const color = avatarColor(m.from.email);
  const name = m.from.name || m.from.email;
  const bodyId = `msg-body-${m.id}`;
  const people = (list: typeof m.to) => list.map((a) => a.name || a.email).join(", ");
  return (
    <article data-testid="message" data-message-id={m.id} data-expanded={expanded || undefined} className="hairline-b">
      {/* one heading and one button in both states, so the focused control survives expanding and collapsing */}
      <h3>
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
              <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold", AVATAR_BG[color])}>{initials(name)}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-base font-semibold">{name}</span>
                  {m.from.name && <span className="truncate text-xs text-muted-foreground opacity-0 group-hover/mh:opacity-100 group-focus-visible/mh:opacity-100">{m.from.email}</span>}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular">{listDate(m.date)}</span>
                </span>
                <span className="mt-px block truncate text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{t("reader.to")}</span> {people(m.to)}
                  {m.cc.length > 0 && (
                    <>
                      {" · "}
                      <span className="font-medium text-foreground">{t("reader.cc")}</span> {people(m.cc)}
                    </>
                  )}
                </span>
              </span>
            </>
          ) : (
            <>
              <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold", AVATAR_BG[color])}>{initials(name)}</span>
              <span className="shrink-0 font-medium">{name}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{m.snippet}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular">{listDate(m.date)}</span>
            </>
          )}
        </button>
      </h3>
      {/* the region is always there (aria-controls); its content is mounted only while open */}
      <div id={bodyId}>
        <Expand open={expanded} onOpening={(el) => keepInView(el.closest("article") ?? el)}>
          <div className="hairline-t ml-12" />
          <div className="pt-3.5 pb-5">
            {m.bodyHtml ? (
              <HtmlBody html={m.bodyHtml} messageId={m.id} remoteImages={remoteImages} localMode={localMode} appearance={mailAppearance} />
            ) : m.bodyText !== null ? (
              <TextBody text={m.bodyText} />
            ) : (
              <p className="text-sm text-muted-foreground italic">{t("reader.downloading")}</p>
            )}
            {m.attachments.length > 0 && (
              // view-only tiles: opening and saving attachments needs content Terno doesn't fetch yet
              <ul aria-label={t("reader.attachments")} className="mt-4 flex flex-wrap gap-2">
                {m.attachments.map((a) => (
                  <li key={a.id} data-testid="attachment" className="flex h-14 w-[260px] items-center gap-3 rounded-[10px] bg-tint px-2.5">
                    <span className="relative flex h-[34px] w-[27px] shrink-0 items-end justify-center rounded-[3px] rounded-tr-lg bg-card pb-1 shadow-hairline">
                      <span className="text-[7px] leading-none font-bold tracking-wide text-muted-foreground uppercase">{fileType(a.filename)}</span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-sm leading-4 font-medium break-all">{a.filename}</span>
                      <span className="block text-xs text-muted-foreground tabular">{formatBytes(a.size)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Expand>
      </div>
    </article>
  );
}

/**
 * The conversation: every message, with runs of 4+ collapsed ones folded into
 * one "N more messages" disclosure. Expansion state belongs to the thread
 * shown; a different thread starts from its defaults (unread messages and the
 * last one open), computed during render so a swap never animates.
 */
function Conversation({ messages, threadId }: { messages: MessageDetail[]; threadId: number }) {
  const [state, setState] = useState<{ thread: number; toggled: Map<number, boolean>; revealed: Set<number> }>({ thread: threadId, toggled: new Map(), revealed: new Set() });
  const own = state.thread === threadId ? state : { thread: threadId, toggled: new Map<number, boolean>(), revealed: new Set<number>() };
  const last = messages[messages.length - 1];
  const isOpen = (m: MessageDetail) => own.toggled.get(m.id) ?? (!m.isRead || m.id === last?.id);
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
          <Message key={it.m.id} m={it.m} expanded={isOpen(it.m)} onToggle={() => toggle(it.m.id, isOpen(it.m))} />
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
        <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-xl bg-tint text-lg font-semibold text-muted-foreground">T</div>
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
            <Shortcut keys={k} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function Reader() {
  const selectedId = useApp((s) => s.selectedId);
  const detail = useThread(selectedId);
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

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" data-testid="reader">
      <div ref={toolbarRef} className="drag-region scroll-hairline flex h-[52px] shrink-0 items-center gap-3 px-3.5">
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
          <ToolButton label={t("actions.reply")} keys="r" onClick={() => openCompose("reply")} testId="action-reply">
            <Reply />
          </ToolButton>
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
      </div>
      <div ref={scrollerRef} data-reader-scroller data-keep-scroll="reader" className="relative min-h-0 flex-1 overflow-y-auto">
        <div ref={sentinelRef} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" />
        <div className="mx-auto max-w-[860px] px-7 pt-5 pb-16">
          {!detail ? (
            <div className="space-y-3">
              <div className="h-6 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-32 animate-pulse rounded-xl bg-muted/70" />
            </div>
          ) : (
            <>
              <h2 data-testid="reader-subject" className="text-xl font-semibold tracking-display text-balance">
                {thread!.subject || t("common.noSubject")}
              </h2>
              <div className="mt-2 mb-5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {account && <span>{account.email}</span>}
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
                                aria-label={t("reader.auto.label", { category: c.name, reasons: auto.reasons.join("; ") })}
                                className="rounded-sm bg-foreground/10 px-1 text-[10px] font-medium uppercase focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                              >
                                {t("reader.auto")}
                              </button>
                            }
                          />
                          <Reasons title={t("reader.auto.title", { category: c.name })} reasons={auto.reasons} hint={t("reader.auto.hint", { category: c.name })} />
                        </Tooltip>
                      )}
                      <button type="button" aria-label={auto ? t("reader.category.notIt", { category: c.name }) : t("reader.category.remove", { category: c.name })} className="text-muted-foreground hover:text-foreground" onClick={() => void removeFromCategory(c.id, [thread!.id])}>
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
                            <button type="button" data-testid="suggestion-accept" onClick={() => void acceptSuggestion(thread!.id, c.id)} className="inline-flex h-full items-center gap-1 rounded-l-full pr-1 pl-1.5 hover:bg-accent">
                              <CategoryDot color={c.color as CategoryColor} />{t("reader.suggestion", { category: c.name })}{i === 0 && <Shortcut keys="y" className="ml-0.5 [&_kbd]:h-3.5 [&_kbd]:min-w-3.5 [&_kbd]:text-[10px]" />}
                            </button>
                          }
                        />
                        <Reasons title={t("reader.suggestion.title", { category: c.name, percent: Math.round(sg.p * 100) })} reasons={sg.reasons} hint={i === 0 ? t("reader.suggestion.hint") : undefined} />
                      </Tooltip>
                      <button type="button" aria-label={t("reader.category.notIt", { category: c.name })} data-testid="suggestion-reject" onClick={() => void rejectSuggestion(thread!.id, c.id)} className="inline-flex h-full items-center rounded-r-full px-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                        <X className="size-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
              <MessageMenu threadId={detail.thread.id}>
                <div>
                  <Conversation messages={detail.messages} threadId={detail.thread.id} />
                </div>
              </MessageMenu>
              <DraftSlot key={detail.thread.id} threadId={detail.thread.id} draftKey={draftKey} replyTo={replyTo(detail.messages)} account={account} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
