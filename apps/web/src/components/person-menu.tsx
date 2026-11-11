import { formatAddressList, type ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Copy, Reply, Search, SquarePen } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { composeLanding, type ComposeLanding } from "~/lib/compose";
import type { ThreadPerson } from "~/lib/thread-overview";
import { setApp, useApp } from "~/state/app";
import { copyAddress, SenderItems, type MenuParts } from "./sender-menu-items";

const PARTS: MenuParts = { Item: DropdownMenuItem, Sub: DropdownMenuSub, SubTrigger: DropdownMenuSubTrigger, SubContent: DropdownMenuSubContent };

/** The person's full name and address as one line: what their chip stands for. */
export const fullName = (p: ThreadPerson) => (p.name === p.email ? p.email : `${p.name} <${p.email}>`);

/**
 * Plan 180: a person's menu, on their chip under the subject: write to them, reply to them alone, their conversations, what's
 * done with their mail, their address. A click, Enter, Space or ↓ opens it under the chip; so do a right-click (only this
 * menu, not the conversation's around it) and ⇧F10 (`data-context-menu`, plan 106).
 */
export function PersonMenu({ person, detail, offerReplyOnly, className, children }: { person: ThreadPerson; detail: ThreadDetail; offerReplyOnly: boolean; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // an item that opens a draft hands focus to it: the closing menu gives none back (message-menu's useRespond)
  const handedOff = useRef(false);
  // shortcuts wait while a menu is open; a menu that goes while open (a new message takes the reader) never leaves them waiting
  const shown = useRef(false);
  useEffect(() => () => {
    if (shown.current) setApp({ menuOpen: false });
  }, []);
  const change = (next: boolean) => {
    if (next) handedOff.current = false;
    shown.current = next;
    setOpen(next);
    setApp({ menuOpen: next });
  };
  const categories = useApp((s) => s.categories);
  const filedIn = categories.filter((c) => detail.thread.categoryIds.includes(c.id));
  const address = { name: person.name === person.email ? "" : person.name, email: person.email };
  // refused or failed: focus comes back to the chip while it's still here
  const compose = (open: () => Promise<ComposeLanding>) => {
    handedOff.current = true;
    void open().then((landing) => {
      if (landing.kind !== "none") return;
      handedOff.current = false;
      if (document.activeElement === document.body && trigger.current?.isConnected) trigger.current.focus();
    });
  };
  return (
    <DropdownMenu open={open} onOpenChange={change}>
      <DropdownMenuTrigger
        ref={trigger}
        data-testid="thread-person"
        data-context-menu
        title={fullName(person)}
        className={cn("group/person flex max-w-full min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
        onContextMenu={(e) => {
          // this menu, not the conversation's (MessageMenu's trigger is around the header) nor the system's
          e.preventDefault();
          e.stopPropagation();
          change(true);
        }}
      >
        {children}
      </DropdownMenuTrigger>
      {/* as wide as what it says, not as the chip (a first name is narrower than "Conversations with …") */}
      <DropdownMenuContent className="w-auto max-w-80 min-w-56" data-testid="person-menu" aria-label={fullName(person)} finalFocus={() => !handedOff.current}>
        <div className="px-2 pt-1 pb-1.5 text-xs" data-testid="person-menu-who">
          <p className="truncate font-semibold">{person.name}</p>
          {person.name !== person.email && <p className="truncate text-muted-foreground">{person.email}</p>}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="person-new-message" onClick={() => compose(() => composeLanding("new", null, 0, () => ({ toText: formatAddressList([address]) }), detail.thread.accountId))}>
          <SquarePen />
          <span className="min-w-0 flex-1 truncate">{t("people.newMessage", { name: person.short })}</span>
        </DropdownMenuItem>
        {offerReplyOnly && (
          <DropdownMenuItem
            data-testid="person-reply-only"
            // their newest message is what it answers; someone only written to: the reply's usual one
            onClick={() => compose(() => composeLanding("reply", detail.thread.id, 0, undefined, undefined, { only: address, ...(person.lastSent ? { sourceId: person.lastSent.id } : {}) }))}
          >
            <Reply />
            <span className="min-w-0 flex-1 truncate">{t("people.replyOnly", { name: person.short })}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {/* plan 140: an address is mail they sent or were sent, everywhere (plan 64) */}
        <DropdownMenuItem data-testid="person-conversations" onClick={() => setApp({ query: person.email, view: "all", categoryId: null, reviewCategoryId: null, checked: new Set(), scope: null })}>
          <Search />
          <span className="min-w-0 flex-1 truncate">{t("people.conversations", { name: person.short })}</span>
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="person-copy" onClick={() => copyAddress(person.email)}>
          <Copy />
          <span className="min-w-0 flex-1 truncate">{t("threadMenu.copyAddress")}</span>
        </DropdownMenuItem>
        {/* about mail from them: only someone who wrote here */}
        {person.wrote && (
          <>
            <DropdownMenuSeparator />
            <SenderItems sender={{ email: person.email, name: person.name }} categories={categories} filedIn={filedIn} parts={PARTS} />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
