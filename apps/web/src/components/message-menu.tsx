import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuRadioGroup, ContextMenuRadioItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "@terno/ui/components/context-menu";
import { Shortcut } from "@terno/ui/components/shortcut";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Button } from "@terno/ui/components/button";
import { cn } from "@terno/ui/lib/utils";
import { t } from "@terno/i18n";
import { Code, Copy, Download, Ellipsis, ExternalLink, FileDown, Forward, Printer, Reply, ReplyAll, Search, SquarePen } from "@terno/ui/icons";
import { formatAddressList, messageParts } from "@terno/core";
import { useMemo, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { composeLanding, type ComposeLanding } from "~/lib/compose";
import { identitiesIn, reachesSeveral } from "~/lib/compose-fields";
import { copyThreadText } from "~/lib/copy-thread";
import { linkAt, type MenuLink } from "~/lib/menu-link";
import { menuOrigin } from "~/lib/menu-origin";
import { openLink } from "~/lib/open-link";
import { searchConversationsWith } from "~/lib/people";
import { openPrint, wantsNativeMenu, type PrintIntent } from "~/lib/print-open";
import { snack } from "~/lib/snack";
import { setApp, useApp } from "~/state/app";
import { useThread } from "~/state/threads";
import { messagePerson, type ThreadPerson } from "~/lib/thread-overview";
import { PersonItems, type PersonParts } from "./person-menu";
import { copyAddress } from "./sender-menu-items";
import { saveFile } from "./attachments";
import { formatBytes } from "~/lib/format";
import { originalBack, useOriginalOpener } from "./original-message";
import { useMailReaderView } from "./mail-reader-view";

/**
 * A right-click on the reader's background is the conversation's too, so it is passed to the trigger as a mail
 * frame's is. Only the background itself: the trigger can't simply be wider, because Base UI cancels the native menu
 * for everything inside it, and the composer below the conversation keeps its own.
 */
export function backgroundMenu(e: MouseEvent<HTMLElement>): void {
  const target = e.target as Element;
  if (!target.matches("[data-reader-scroller], [data-reader-column]") || wantsNativeMenu(target, document.getSelection()?.toString() ?? "")) return;
  const trigger = e.currentTarget.querySelector("[data-conversation-menu]");
  if (!trigger) return;
  e.preventDefault();
  trigger.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, button: 2 }));
}

type Respond = "reply" | "replyAll" | "forward";

/** Would answering everyone on this one message reach more than one other person? */
function useReachesSeveral(threadId: number, messageId: number | null): boolean {
  const detail = useThread(threadId);
  const emails = useApp((s) => s.accounts.map((a) => a.email).join("\n"));
  const message = detail?.messages.find((m) => m.id === messageId);
  return Boolean(detail && message && reachesSeveral({ ...detail, messages: [message] }, identitiesIn(detail, emails.split("\n"))));
}

/** Plan 194: whom a message's ⋯ offers (messagePerson), for the message the menu is about */
function useMessagePerson(threadId: number, messageId: number | null): { person: ThreadPerson; offerReplyOnly: boolean } | null {
  const detail = useThread(threadId);
  const emails = useApp((s) => s.accounts.map((a) => a.email).join("\n"));
  return useMemo(() => (detail && messageId !== null ? messagePerson(detail, messageId, emails.split("\n")) : null), [detail, messageId, emails]);
}

/**
 * What a message offers, in its ⋯ menu and on a right-click alike (off a message, only the conversation's copy). Plan 194:
 * then what's done about whom it's between, as their chip's menu offers (useMessagePerson)
 */
function MessageItems({ threadId, messageId, respond, compose, showOriginal, parts }: { threadId: number; messageId: number | null; respond: (mode: Respond) => void; compose: (open: () => Promise<ComposeLanding>) => void; /** plan 272: absent where it can't open (inside another view) */ showOriginal?: () => void; parts: PersonParts }) {
  const { Item, Separator, Sub, SubTrigger, SubContent } = parts;
  const replyAll = useReachesSeveral(threadId, messageId);
  const detail = useThread(threadId);
  const message = detail?.messages.find((m) => m.id === messageId);
  // plan 220: the pictures its text shows, which its files leave out: saved from here (keyboard too, by ⋯)
  const images = message ? messageParts(message.bodyHtml, message.attachments).images : [];
  const about = useMessagePerson(threadId, messageId);
  const print = (intent: PrintIntent) => messageId !== null && openPrint({ threadId, messageId, intent });
  return (
    <>
      {messageId !== null && (
        <>
          <Item data-testid="message-menu-reply" onClick={() => respond("reply")}>
            <Reply />
            <span className="flex-1">{t("reader.message.reply")}</span>
          </Item>
          {replyAll && (
            <Item data-testid="message-menu-reply-all" onClick={() => respond("replyAll")}>
              <ReplyAll />
              <span className="flex-1">{t("actions.replyAll")}</span>
            </Item>
          )}
          <Item data-testid="message-menu-forward" onClick={() => respond("forward")}>
            <Forward />
            <span className="flex-1">{t("actions.forward")}</span>
          </Item>
          <Separator />
          {about && detail && (
            <>
              <PersonItems person={about.person} detail={detail} offerReplyOnly={about.offerReplyOnly} compose={compose} parts={parts} />
              <Separator />
            </>
          )}
        </>
      )}
      <Item data-testid="message-menu-copy-text" onClick={() => copyThreadText(threadId)}>
        <Copy />
        <span className="flex-1">{t("threadMenu.copyText")}</span>
      </Item>
      {messageId !== null && (
        <>
          <Separator />
          {message && images.length > 0 && (
            <Sub>
              <SubTrigger data-testid="message-menu-images">
                <Download />
                <span className="min-w-0 flex-1 truncate">{t("threadMenu.saveImage", { count: images.length })}</span>
              </SubTrigger>
              <SubContent className="w-max max-w-96 min-w-60" data-testid="message-menu-image-list">
                {images.map((a) => (
                  <Item key={a.id} data-testid="message-menu-image" onClick={() => void saveFile({ accountId: message.accountId, messageId: message.id, a })}>
                    <span className="min-w-0 flex-1 truncate">{a.filename}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular">{formatBytes(a.size)}</span>
                  </Item>
                ))}
              </SubContent>
            </Sub>
          )}
          <Item data-testid="message-menu-print" onClick={() => print("print")}>
            <Printer />
            <span className="flex-1">{t("threadMenu.printMessage")}</span>
          </Item>
          <Item data-testid="message-menu-pdf" onClick={() => print("pdf")}>
            <FileDown />
            <span className="flex-1">{t("threadMenu.exportMessagePdf")}</span>
          </Item>
          {showOriginal && (
            <Item data-testid="message-menu-original" onClick={showOriginal}>
              <Code />
              <span className="flex-1">{t("threadMenu.showOriginal")}</span>
            </Item>
          )}
        </>
      )}
    </>
  );
}

/** Plan 284: a link's address on the clipboard, said as Copy address says it */
function copyLink(href: string): void {
  void navigator.clipboard.writeText(href).then(
    () => snack(t("threadMenu.linkCopied"), { duration: 2000 }),
    () => snack.error(t("threadMenu.copyFailed")),
  );
}

/**
 * Plan 284: a right-click on a link is about the link, not the message it's in: an address to write to, look up or copy;
 * a page to open or copy. The message's own items are a right-click beside it, or its ⋯.
 */
function LinkItems({ threadId, link, compose }: { threadId: number; link: MenuLink; compose: (open: () => Promise<ComposeLanding>) => void }) {
  const accountId = useThread(threadId)?.thread.accountId;
  if (link.kind === "web") {
    return (
      <>
        <ContextMenuItem data-testid="link-menu-open" onClick={() => openLink(link.href)}>
          <ExternalLink />
          <span className="flex-1">{t("compose.link.open")}</span>
        </ContextMenuItem>
        <ContextMenuItem data-testid="link-menu-copy-link" onClick={() => copyLink(link.href)}>
          <Copy />
          <span className="flex-1">{t("threadMenu.copyLink")}</span>
        </ContextMenuItem>
      </>
    );
  }
  // (from the conversation's account, as a person's New message is; with the subject the link gives)
  const prefill = () => ({ toText: formatAddressList([{ name: "", email: link.to }]), ...(link.subject ? { subject: link.subject } : {}) });
  return (
    <>
      <ContextMenuItem data-testid="link-menu-new-message" onClick={() => compose(() => composeLanding("new", null, 0, prefill, accountId))}>
        <SquarePen />
        <span className="min-w-0 flex-1 truncate">{t("people.newMessage", { name: link.to })}</span>
      </ContextMenuItem>
      <ContextMenuItem data-testid="link-menu-conversations" onClick={() => searchConversationsWith(link.to)}>
        <Search />
        <span className="min-w-0 flex-1 truncate">{t("people.conversations", { name: link.to })}</span>
      </ContextMenuItem>
      <ContextMenuItem data-testid="link-menu-copy-address" onClick={() => copyAddress(link.to)}>
        <Copy />
        <span className="flex-1">{t("threadMenu.copyAddress")}</span>
      </ContextMenuItem>
    </>
  );
}

const CONTEXT_PARTS: PersonParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator, Sub: ContextMenuSub, SubTrigger: ContextMenuSubTrigger, SubContent: ContextMenuSubContent, RadioGroup: ContextMenuRadioGroup, RadioItem: ContextMenuRadioItem };
const DROPDOWN_PARTS: PersonParts = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator, Sub: DropdownMenuSub, SubTrigger: DropdownMenuSubTrigger, SubContent: DropdownMenuSubContent, RadioGroup: DropdownMenuRadioGroup, RadioItem: DropdownMenuRadioItem };

/**
 * Answers this message, wherever it is in the conversation. A row chosen in a menu hands focus to the draft, so the
 * closing menu restores none (`handedOff`); refused, it does after all, or the trigger takes it if the menu has gone.
 */
function useRespond(threadId: number, messageId: number | null, fallback: () => HTMLElement | null | undefined) {
  const handedOff = useRef(false);
  /** plan 272: a view opened from the menu takes focus once the menu has closed */
  const handedTo = useRef<(() => HTMLElement | null) | null>(null);
  const originals = useOriginalOpener();
  const view = useMailReaderView();
  const compose = (open: () => Promise<ComposeLanding>) => {
    handedOff.current = true;
    void open().then((landing) => {
      if (landing.kind !== "none") return;
      handedOff.current = false;
      if (document.activeElement === document.body) fallback()?.focus();
    });
  };
  const respond = (mode: Respond) => {
    if (messageId === null) return;
    compose(() => composeLanding(mode, threadId, 0, undefined, undefined, { sourceId: messageId }));
  };
  const opened = (open: boolean) => {
    if (open) { handedOff.current = false; handedTo.current = null; }
    setApp({ menuOpen: open });
  };
  /** Show original (plan 272), from the conversation only: one view over it at a time. `trigger`: where focus goes back. */
  const showOriginal = (trigger: () => HTMLElement | null | undefined) => {
    if (!originals || view?.active || messageId === null) return undefined;
    return () => {
      const back = trigger();
      if (!back) return;
      handedTo.current = originalBack;
      originals.open(threadId, messageId, back);
    };
  };
  return { respond, compose, opened, showOriginal, finalFocus: () => handedTo.current?.() ?? !handedOff.current };
}

/**
 * A message's own actions, in a ⋯ menu at the end of its header (Reply to this message first), so there's no scrolling to the
 * end to answer it. Only the menu: the toolbar and the reply bar are the two ways to reply, and a third Reply on every header
 * was one too many (plan 158). It shows on hover and focus, the newest's too, in a place kept for it, so nothing moves.
 */
export function MessageActions({ threadId, messageId, label, className }: { threadId: number; messageId: number; /** plan 188: whose message it is ("More for Ana's message, …"): every message's ⋯ told apart */ label?: string; className?: string }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const { respond, compose, opened, showOriginal, finalFocus } = useRespond(threadId, messageId, () => trigger.current);
  return (
    <div
      role="group"
      aria-label={t("reader.message.actions")}
      data-testid="message-actions"
      className={cn("flex items-center gap-px opacity-0 transition-opacity duration-fast group-hover/mh:opacity-100 group-has-[:focus-visible]/mh:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100", className)}
    >
      <DropdownMenu onOpenChange={opened}>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={<Button ref={trigger} variant="ghost" size="icon-sm" aria-label={label ?? t("reader.message.more")} data-testid="message-more" className="text-muted-foreground hover:text-foreground" />}
              />
            }
          >
            <Ellipsis className="size-4" />
          </TooltipTrigger>
          <TooltipContent>{t("reader.message.more")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" sideOffset={4} className="w-60" data-testid="message-actions-menu" finalFocus={finalFocus}>
          <MessageItems threadId={threadId} messageId={messageId} respond={respond} compose={compose} showOriginal={showOriginal(() => trigger.current)} parts={DROPDOWN_PARTS} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The conversation's menu: answer, print or export the message the right-click landed in (HTML mail replays its
 * frame's right-click here), and copy the conversation as text (plan 149); off a message, the header or the
 * background, only the copy. One menu around the conversation, no per-message trigger. Selected text adds Copy: the
 * desktop app has no native menu to offer it. On a link, the link's own items instead of the message's (plan 284).
 */
export function MessageMenu({ threadId, children }: { threadId: number; children: ReactElement }) {
  const [messageId, setMessageId] = useState<number | null>(null);
  const [selected, setSelected] = useState("");
  const [link, setLink] = useState<MenuLink | null>(null);
  const { respond, compose, opened, showOriginal, finalFocus } = useRespond(threadId, messageId, () => document.querySelector<HTMLElement>(`[aria-controls="msg-body-${messageId}"]`));
  return (
    <ContextMenu onOpenChange={opened}>
      {/* the trigger wraps the whole conversation: mail stays selectable (the primitive defaults to select-none) */}
      <ContextMenuTrigger
        render={children}
        className="select-text"
        onContextMenu={(e) => {
          const target = e.target as Element;
          // a right-click replayed from an HTML mail lands on its frame: the selection is the frame's
          const text = (e.target instanceof HTMLIFrameElement ? e.target.contentDocument : document)?.getSelection()?.toString() ?? "";
          // React bubbles through portals: the full-message view's own controls land here from outside this trigger. One the
          // app replays (a mail's frame, ⇧F10) has no browser menu behind it: it was decided where it began
          if (!e.currentTarget.contains(target) || (e.nativeEvent.isTrusted && wantsNativeMenu(target, text))) {
            (e as unknown as { preventBaseUIHandler(): void }).preventBaseUIHandler();
            return;
          }
          const el = target.closest<HTMLElement>("[data-message-id]");
          setMessageId(el ? Number(el.dataset.messageId) : null);
          setSelected(text.trim() ? text : "");
          setLink(linkAt(menuOrigin(e.nativeEvent)));
        }}
      />
      {/* an address is long: the menu grows for it, to a point */}
      <ContextMenuContent className={link?.kind === "mail" ? "w-max max-w-[min(24rem,var(--available-width))] min-w-60" : "w-60"} data-testid="message-menu" finalFocus={finalFocus}>
        {selected && (
          <>
            <ContextMenuItem data-testid="message-menu-copy" onClick={() => void navigator.clipboard.writeText(selected).catch(() => snack.error(t("threadMenu.copyFailed")))}>
              <Copy />
              <span className="flex-1">{t("common.copy")}</span>
              <ContextMenuShortcut><Shortcut keys="mod+c" /></ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {link ? (
          <LinkItems threadId={threadId} link={link} compose={compose} />
        ) : (
          // the message's ⋯ is where focus goes back to (its header while it's folded)
          <MessageItems threadId={threadId} messageId={messageId} respond={respond} compose={compose} showOriginal={showOriginal(() => document.querySelector<HTMLElement>(`[data-message-id="${messageId}"] [data-testid="message-more"]`) ?? document.querySelector<HTMLElement>(`[aria-controls="msg-body-${messageId}"]`))} parts={CONTEXT_PARTS} />
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
