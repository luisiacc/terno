import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@terno/ui/components/context-menu";
import { t } from "@terno/i18n";
import { Copy, FileDown, Printer } from "lucide-react";
import { useState, type ReactElement } from "react";
import { openPrint, wantsNativeMenu, type PrintIntent } from "~/lib/print-open";
import { isMac } from "~/lib/select";
import { snack } from "~/lib/snack";
import { setApp } from "~/state/app";

/**
 * A message's own menu: print or export just that message. One menu around
 * the conversation (no per-message trigger); the message is the one the
 * right-click landed in (HTML mail replays its frame's right-click here).
 * Selected text adds Copy: the desktop app has no native menu to offer it.
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
          const el = (e.target as Element).closest<HTMLElement>("[data-message-id]");
          // a right-click replayed from an HTML mail lands on its frame: the selection is the frame's
          const text = (e.target instanceof HTMLIFrameElement ? e.target.contentDocument : document)?.getSelection()?.toString() ?? "";
          if (!el || wantsNativeMenu(e.target, text)) {
            (e as unknown as { preventBaseUIHandler(): void }).preventBaseUIHandler();
            return;
          }
          setMessageId(Number(el.dataset.messageId));
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
        <ContextMenuItem data-testid="message-menu-print" onClick={() => print("print")}>
          <Printer />
          <span className="flex-1">{t("threadMenu.printMessage")}</span>
        </ContextMenuItem>
        <ContextMenuItem data-testid="message-menu-pdf" onClick={() => print("pdf")}>
          <FileDown />
          <span className="flex-1">{t("threadMenu.exportMessagePdf")}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
