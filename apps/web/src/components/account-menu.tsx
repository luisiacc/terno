import { CATEGORY_COLORS, type Account, type CategoryColor } from "@terno/core";
import { AccountRing } from "@terno/ui/components/category-dot";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@terno/ui/components/context-menu";
import { t } from "@terno/i18n";
import { ArrowLeft, Focus, FolderPlus, KeyRound, MailOpen, PenLine, RefreshCw, Settings2, SquarePen, Trash2 } from "@terno/ui/icons";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { focusAccount, leaveFocus } from "~/lib/account-folders";
import { patchAccount } from "~/lib/accounts";
import { startCreate } from "~/lib/folders";
import { markAccountRead, openCompose } from "~/lib/actions";
import { COLOR_LABEL } from "~/lib/color-labels";
import { needsSignIn } from "~/lib/sign-in";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { openSignInMarker } from "./sign-in-notice";
import { AccountRemoveDialog } from "./account-remove-dialog";


const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * An account's right-click menu in the sidebar (plan 106): what you do to one mailbox without opening Settings.
 * Its trigger is marked `data-context-menu`, so ⇧F10 and the menu key on the focused row open it too.
 */
export function AccountMenu({ account, unread, onRename, solo = false, children }: { account: Account; unread: number; onRename: () => void; /** plan 108: the focused sidebar's header */ solo?: boolean; children: ReactElement }) {
  // plan 108: focus is offered with more than one account (with one, the sidebar already shows only it)
  const several = useApp((s) => s.accounts.length > 1);
  // mounted from the first Remove… on, so the dialog can animate out after
  const [removing, setRemoving] = useState<boolean | null>(null);
  // an item that moves focus itself (the rename field, the composer, a dialog, the sign-in panel) keeps the
  // closing menu from handing it back to the row first (Codex R6: the field would blur, and save, at once)
  // state, not a function: a function would override Base UI's own check that the user hasn't clicked elsewhere
  // (Codex code review round 5 #1); set in the same click that closes, so the close reads it
  const [handOff, setHandOff] = useState(false);
  // plan 108 (Codex R7): focusing or leaving swaps the sidebar, so this menu may go while open: shortcuts never stay
  // blocked behind it
  const open = useRef(false);
  useEffect(() => () => {
    if (open.current) setApp({ menuOpen: false });
  }, []);
  const away = (run: () => void) => () => {
    setHandOff(true);
    run();
  };
  return (
    <>
      <ContextMenu
        onOpenChange={(next) => {
          if (next) setHandOff(false);
          open.current = next;
          setApp({ menuOpen: next });
        }}
      >
        <ContextMenuTrigger data-context-menu render={children} />
        <ContextMenuContent className="w-56" data-testid={`account-menu-${account.id}`} finalFocus={handOff ? false : undefined}>
          <ContextMenuItem data-testid="account-menu-compose" onClick={away(() => void openCompose("new", null, 0, undefined, account.id))}>
            <SquarePen />
            <span className="flex-1">{t("compose.newMessage")}</span>
          </ContextMenuItem>
          <ContextMenuItem data-testid="account-menu-sync" onClick={() => void checkNow(account)}>
            <RefreshCw />
            <span className="flex-1">{t("account.menu.sync")}</span>
          </ContextMenuItem>
          <ContextMenuItem data-testid="account-menu-read-all" disabled={!unread} onClick={() => void markAccountRead(account.id, unread)}>
            <MailOpen />
            <span className="flex-1">{t("account.menu.readAll")}</span>
          </ContextMenuItem>
          {needsSignIn(account) && (
            <ContextMenuItem data-testid="account-menu-sign-in" onClick={away(() => void openSignInMarker(account))}>
              <KeyRound />
              <span className="flex-1">{t("account.menu.signIn")}</span>
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          {/* plan 108: the sidebar shows only this account, or all of them again */}
          {solo ? (
            <ContextMenuItem data-testid="account-menu-unfocus" onClick={away(() => leaveSoloKeepingFocus(account.id))}>
              <ArrowLeft />
              <span className="flex-1">{t("account.menu.unfocus")}</span>
            </ContextMenuItem>
          ) : (
            several && (
              <ContextMenuItem data-testid="account-menu-focus" onClick={away(() => enterSolo(account.id))}>
                <Focus />
                <span className="flex-1">{t("account.menu.focus")}</span>
              </ContextMenuItem>
            )
          )}
          <ContextMenuItem data-testid="account-menu-rename" onClick={away(onRename)}>
            <PenLine />
            <span className="flex-1">{t("account.menu.rename")}</span>
          </ContextMenuItem>
          {/* plan 107: the keyboard's way to the open row's "+" */}
          <ContextMenuItem data-testid="account-menu-new-folder" onClick={away(() => startCreate(account.id, null))}>
            <FolderPlus />
            <span className="flex-1">{t("account.menu.newFolder")}</span>
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger data-testid="account-menu-color">
              <Swatch color={account.color as CategoryColor} />
              <span className="flex-1">{t("settings.color")}</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-40" data-testid={`account-menu-colors-${account.id}`}>
              <ContextMenuRadioGroup value={account.color} onValueChange={(color) => void recolor(account, color as CategoryColor)}>
                {CATEGORY_COLORS.map((c) => (
                  <ContextMenuRadioItem key={c} value={c} closeOnClick data-testid={`account-menu-color-${c}`}>
                    <Swatch color={c} />
                    <span className="flex-1">{t(COLOR_LABEL[c])}</span>
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem data-testid="account-menu-settings" onClick={away(() => setApp({ dialog: "settings", settingsTab: "accounts", settingsAccount: account.id }))}>
            <Settings2 />
            <span className="flex-1">{t("account.menu.settings")}</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* a plain item, as in macOS menus: the confirmation is where it reads as destructive */}
          <ContextMenuItem data-testid="account-menu-remove" onClick={away(() => setRemoving(true))}>
            <Trash2 />
            <span className="flex-1">{t("account.menu.remove")}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {removing !== null && (
        <AccountRemoveDialog account={account} open={removing} onOpenChange={setRemoving} from="sidebar" />
      )}
    </>
  );
}

/** plan 108: focused from the menu, the keyboard goes to the back row (the row it came from is gone) */
function enterSolo(id: number): void {
  focusAccount(id);
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="solo-back"]')?.focus());
}

/** plan 108: back to all accounts from the header's menu; the keyboard goes to the account's row */
export function leaveSoloKeepingFocus(id: number): void {
  leaveFocus();
  // scrolled into view if the sidebar's own scroll (restored) leaves it out (Codex code review round 2 #2)
  requestAnimationFrame(() => (document.querySelector<HTMLElement>(`[data-testid="nav-account-${id}"]`) ?? document.querySelector<HTMLElement>('[data-testid="nav-inbox"]'))?.focus());
}

/** A color as the account will wear it (a ring, plan 194), in an icon's box, so its label starts on the other items' line */
function Swatch({ color }: { color: CategoryColor }) {
  return (
    <span aria-hidden className="flex size-[1.15em] shrink-0 items-center justify-center">
      <AccountRing color={color} />
    </span>
  );
}

/** Check for new mail: the pills show the work; the snack says the click was heard. */
async function checkNow(account: Account): Promise<void> {
  const id = snack(t("account.menu.syncing", { account: account.displayName }));
  try {
    await client.call("sync.now", { accountId: account.id, reason: "user" });
  } catch (e) {
    snack.error(t("account.menu.syncFailed", { account: account.displayName, error: errorText(e) }), { id });
  }
}

async function recolor(account: Account, color: CategoryColor): Promise<void> {
  if (color === account.color) return;
  try {
    await patchAccount(account.id, { color });
  } catch (e) {
    snack.error(errorText(e));
  }
}
