import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "@terno/ui/components/context-menu";
import { Shortcut } from "@terno/ui/components/shortcut";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Button } from "@terno/ui/components/button";
import { cn } from "@terno/ui/lib/utils";
import { t } from "@terno/i18n";
import { Copy, Ellipsis, FileDown, Forward, Printer, Reply, ReplyAll } from "@terno/ui/icons";
import { useMemo, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { composeLanding, type ComposeLanding } from "~/lib/compose";
import { identitiesIn, reachesSeveral } from "~/lib/compose-fields";
import { copyThreadText } from "~/lib/copy-thread";
import { openPrint, wantsNativeMenu, type PrintIntent } from "~/lib/print-open";
import { snack } from "~/lib/snack";
import { setApp, useApp } from "~/state/app";
import { useThread } from "~/state/threads";
import { threadPeople, type ThreadPerson } from "~/lib/thread-overview";
import { PersonItems, type PersonParts } from "./person-menu";

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

/** Who wrote this message, as their chip would show them; none when it's the user's own (plan 194) */
function useSenderOf(threadId: number, messageId: number | null): ThreadPerson | null {
  const detail = useThread(threadId);
  const emails = useApp((s) => s.accounts.map((a) => a.email).join("\n"));
  return useMemo(() => {
    const message = detail?.messages.find((m) => m.id === messageId);
    if (!detail || !message) return null;
    const mine = identitiesIn(detail, emails.split("\n"));
    if (mine(message.from.email)) return null;
    const email = message.from.email.toLowerCase();
    return threadPeople(detail.messages, mine).find((p) => p.email.toLowerCase() === email) ?? null;
  }, [detail, messageId, emails]);
}

/**
 * What a message offers, in its ⋯ menu and on a right-click alike (off a message, only the conversation's copy). Plan 194:
 * then what's done about whoever wrote it, as their chip's menu offers (a one-to-one conversation shows no chip)
 */
function MessageItems({ threadId, messageId, respond, compose, parts }: { threadId: number; messageId: number | null; respond: (mode: Respond) => void; compose: (open: () => Promise<ComposeLanding>) => void; parts: PersonParts }) {
  const { Item, Separator } = parts;
  const replyAll = useReachesSeveral(threadId, messageId);
  const detail = useThread(threadId);
  const sender = useSenderOf(threadId, messageId);
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
          {sender && detail && (
            <>
              <PersonItems person={sender} detail={detail} offerReplyOnly={false} compose={compose} parts={parts} />
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
          <Item data-testid="message-menu-print" onClick={() => print("print")}>
            <Printer />
            <span className="flex-1">{t("threadMenu.printMessage")}</span>
          </Item>
          <Item data-testid="message-menu-pdf" onClick={() => print("pdf")}>
            <FileDown />
            <span className="flex-1">{t("threadMenu.exportMessagePdf")}</span>
          </Item>
        </>
      )}
    </>
  );
}

const CONTEXT_PARTS: PersonParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator, Sub: ContextMenuSub, SubTrigger: ContextMenuSubTrigger, SubContent: ContextMenuSubContent };
const DROPDOWN_PARTS: PersonParts = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator, Sub: DropdownMenuSub, SubTrigger: DropdownMenuSubTrigger, SubContent: DropdownMenuSubContent };

/**
 * Answers this message, wherever it is in the conversation. A row chosen in a menu hands focus to the draft, so the
 * closing menu restores none (`handedOff`); refused, it does after all, or the trigger takes it if the menu has gone.
 */
function useRespond(threadId: number, messageId: number | null, fallback: () => HTMLElement | null | undefined) {
  const handedOff = useRef(false);
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
    if (open) handedOff.current = false;
    setApp({ menuOpen: open });
  };
  return { respond, compose, opened, finalFocus: () => !handedOff.current };
}

/**
 * A message's own actions, in a ⋯ menu at the end of its header (Reply to this message first), so there's no scrolling to the
 * end to answer it. Only the menu: the toolbar and the reply bar are the two ways to reply, and a third Reply on every header
 * was one too many (plan 158). It shows on hover and focus, the newest's too, in a place kept for it, so nothing moves.
 */
export function MessageActions({ threadId, messageId, label, className }: { threadId: number; messageId: number; /** plan 188: whose message it is ("More for Ana's message, …"): every message's ⋯ told apart */ label?: string; className?: string }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const { respond, compose, opened, finalFocus } = useRespond(threadId, messageId, () => trigger.current);
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
          <MessageItems threadId={threadId} messageId={messageId} respond={respond} compose={compose} parts={DROPDOWN_PARTS} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The conversation's menu: answer, print or export the message the right-click landed in (HTML mail replays its
 * frame's right-click here), and copy the conversation as text (plan 149); off a message, the header or the
 * background, only the copy. One menu around the conversation, no per-message trigger. Selected text adds Copy: the
 * desktop app has no native menu to offer it.
 */
export function MessageMenu({ threadId, children }: { threadId: number; children: ReactElement }) {
  const [messageId, setMessageId] = useState<number | null>(null);
  const [selected, setSelected] = useState("");
  const { respond, compose, opened, finalFocus } = useRespond(threadId, messageId, () => document.querySelector<HTMLElement>(`[aria-controls="msg-body-${messageId}"]`));
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
          // React bubbles through portals: the full-message view's own controls land here from outside this trigger
          if (!e.currentTarget.contains(target) || wantsNativeMenu(target, text)) {
            (e as unknown as { preventBaseUIHandler(): void }).preventBaseUIHandler();
            return;
          }
          const el = target.closest<HTMLElement>("[data-message-id]");
          setMessageId(el ? Number(el.dataset.messageId) : null);
          setSelected(text.trim() ? text : "");
        }}
      />
      <ContextMenuContent className="w-60" data-testid="message-menu" finalFocus={finalFocus}>
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
        <MessageItems threadId={threadId} messageId={messageId} respond={respond} compose={compose} parts={CONTEXT_PARTS} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
