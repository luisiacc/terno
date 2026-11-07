import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@terno/ui/components/context-menu";
import { Shortcut } from "@terno/ui/components/shortcut";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { IconButton } from "@terno/ui/components/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Button } from "@terno/ui/components/button";
import { cn } from "@terno/ui/lib/utils";
import { t } from "@terno/i18n";
import { Copy, Ellipsis, FileDown, Forward, Printer, Reply, ReplyAll } from "@terno/ui/icons";
import { useRef, useState, type ComponentType, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { composeLanding } from "~/lib/compose";
import { identitiesIn, reachesSeveral } from "~/lib/compose-fields";
import { copyThreadText } from "~/lib/copy-thread";
import { openPrint, wantsNativeMenu, type PrintIntent } from "~/lib/print-open";
import { snack } from "~/lib/snack";
import { setApp, useApp } from "~/state/app";
import { useThread } from "~/state/threads";

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
interface ItemParts {
  Item: ComponentType<{ "data-testid"?: string; onClick?: () => void; children: ReactNode }>;
  Separator: ComponentType;
}

/** Would answering everyone on this one message reach more than one other person? */
function useReachesSeveral(threadId: number, messageId: number | null): boolean {
  const detail = useThread(threadId);
  const emails = useApp((s) => s.accounts.map((a) => a.email).join("\n"));
  const message = detail?.messages.find((m) => m.id === messageId);
  return Boolean(detail && message && reachesSeveral({ ...detail, messages: [message] }, identitiesIn(detail, emails.split("\n"))));
}

/** What a message offers, in its ⋯ menu and on a right-click alike (off a message, only the conversation's copy). */
function MessageItems({ threadId, messageId, respond, parts: { Item, Separator } }: { threadId: number; messageId: number | null; respond: (mode: Respond) => void; parts: ItemParts }) {
  const replyAll = useReachesSeveral(threadId, messageId);
  const print = (intent: PrintIntent) => messageId !== null && openPrint({ threadId, messageId, intent });
  return (
    <>
      {messageId !== null && (
        <>
          <Item data-testid="message-menu-reply" onClick={() => respond("reply")}>
            <Reply />
            <span className="flex-1">{t("actions.reply")}</span>
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

const CONTEXT_PARTS: ItemParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator };
const DROPDOWN_PARTS: ItemParts = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator };

/**
 * Answers this message, wherever it is in the conversation. A row chosen in a menu hands focus to the draft, so the
 * closing menu restores none (`handedOff`); refused, it does after all, or the trigger takes it if the menu has gone.
 */
function useRespond(threadId: number, messageId: number | null, fallback: () => HTMLElement | null | undefined) {
  const handedOff = useRef(false);
  const respond = (mode: Respond, fromMenu = true) => {
    if (messageId === null) return;
    handedOff.current = fromMenu;
    void composeLanding(mode, threadId, 0, undefined, undefined, { sourceId: messageId }).then((landing) => {
      if (landing.kind !== "none") return;
      handedOff.current = false;
      if (document.activeElement === document.body) fallback()?.focus();
    });
  };
  const opened = (open: boolean) => {
    if (open) handedOff.current = false;
    setApp({ menuOpen: open });
  };
  return { respond, opened, finalFocus: () => !handedOff.current };
}

/**
 * A message's own actions at the end of its header, so there's no scrolling to the end to answer it. They show on hover and
 * focus, the newest's too (the reply bar is right below it), in a place kept for them, so nothing moves when they come.
 */
export function MessageActions({ threadId, messageId, className }: { threadId: number; messageId: number; className?: string }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const { respond, opened, finalFocus } = useRespond(threadId, messageId, () => trigger.current);
  return (
    <div
      role="group"
      aria-label={t("reader.message.actions")}
      data-testid="message-actions"
      className={cn("flex items-center gap-px opacity-0 transition-opacity duration-fast group-hover/mh:opacity-100 group-has-[:focus-visible]/mh:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100", className)}
    >
      <IconButton size="icon-sm" label={t("reader.message.reply")} onClick={() => respond("reply", false)} data-testid="message-reply">
        <Reply className="size-4" />
      </IconButton>
      <DropdownMenu onOpenChange={opened}>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={<Button ref={trigger} variant="ghost" size="icon-sm" aria-label={t("reader.message.more")} data-testid="message-more" className="text-muted-foreground hover:text-foreground" />}
              />
            }
          >
            <Ellipsis className="size-4" />
          </TooltipTrigger>
          <TooltipContent>{t("reader.message.more")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" sideOffset={4} className="w-60" data-testid="message-actions-menu" finalFocus={finalFocus}>
          <MessageItems threadId={threadId} messageId={messageId} respond={respond} parts={DROPDOWN_PARTS} />
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
  const { respond, opened, finalFocus } = useRespond(threadId, messageId, () => document.querySelector<HTMLElement>(`[aria-controls="msg-body-${messageId}"]`));
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
        <MessageItems threadId={threadId} messageId={messageId} respond={respond} parts={CONTEXT_PARTS} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
