import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@terno/ui/components/context-menu";
import { t } from "@terno/i18n";
import { Copy, FileDown, Printer } from "@terno/ui/icons";
import { useState, type MouseEvent, type ReactElement } from "react";
import { copyThreadText } from "~/lib/copy-thread";
import { openPrint, wantsNativeMenu, type PrintIntent } from "~/lib/print-open";
import { isMac } from "~/lib/select";
import { snack } from "~/lib/snack";
import { setApp } from "~/state/app";

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

/**
 * The conversation's menu: copy it as text (plan 149), and print or export the
 * message the right-click landed in (HTML mail replays its frame's right-click
 * here; off a message, the header or the background, only the first). One menu
 * around the conversation, no per-message trigger. Selected text adds Copy: the
 * desktop app has no native menu to offer it.
 */
export function MessageMenu({ threadId, children }: { threadId: number; children: ReactElement }) {
  const [messageId, setMessageId] = useState<number | null>(null);
  const [selected, setSelected] = useState("");
  const print = (intent: PrintIntent) => messageId !== null && openPrint({ threadId, messageId, intent });
  return (
    <ContextMenu onOpenChange={(open) => setApp({ menuOpen: open })}>
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
      <ContextMenuContent className="w-60" data-testid="message-menu">
        {selected && (
          <>
            <ContextMenuItem data-testid="message-menu-copy" onClick={() => void navigator.clipboard.writeText(selected).catch(() => snack.error(t("threadMenu.copyFailed")))}>
              <Copy />
              <span className="flex-1">{t("common.copy")}</span>
              <ContextMenuShortcut>{isMac ? "⌘C" : "Ctrl+C"}</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem data-testid="message-menu-copy-text" onClick={() => copyThreadText(threadId)}>
          <Copy />
          <span className="flex-1">{t("threadMenu.copyText")}</span>
        </ContextMenuItem>
        {messageId !== null && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem data-testid="message-menu-print" onClick={() => print("print")}>
              <Printer />
              <span className="flex-1">{t("threadMenu.printMessage")}</span>
            </ContextMenuItem>
            <ContextMenuItem data-testid="message-menu-pdf" onClick={() => print("pdf")}>
              <FileDown />
              <span className="flex-1">{t("threadMenu.exportMessagePdf")}</span>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
