import type { Account } from "@terno/core";
import { t } from "@terno/i18n";
import { useEffect, useState } from "react";
import { dropFavorites } from "~/lib/folders";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp } from "~/state/app";
import { ConfirmDialog } from "./settings/parts";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Plan 107: Delete folder…'s confirmation. IMAP deletes the folder and its mail on the server (how much is said,
 * from this computer's copy); Gmail takes the label away and the mail stays. Subfolders go too. Lazy: out of the
 * entry chunk. Focus comes back to the folder's row, or (once it's gone) the row now in its place.
 */
export function FolderDeleteDialog({ account, folderKey, name, open, onOpenChange }: { account: Account; folderKey: string; name: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [count, setCount] = useState<{ messages: number; folders: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    client.call("folders.count", { accountId: account.id, key: folderKey }).then((c) => live && setCount(c), () => live && setCount(null));
    return () => {
      live = false;
    };
  }, [open, account.id, folderKey]);
  const gmail = account.kind === "gmail";
  const subfolders = count && count.folders > 1 ? count.folders - 1 : 0;
  // what goes under it is always said (Codex code review round 3 #3: counting may fail, and Gmail's hidden sublabels
  // go too, uncounted); a count found makes it exact
  const description = gmail
    ? subfolders
      ? t("folder.delete.gmail.withSubfolders", { count: subfolders })
      : t("folder.delete.gmail.any")
    : [
        count ? t("folder.delete.imap.messages", { count: count.messages }) : t("folder.delete.imap.counting"),
        subfolders ? t("folder.delete.imap.subfolders", { count: subfolders }) : t("folder.delete.imap.anySubfolders"),
        t("folder.delete.imap.server"),
      ]
        .filter(Boolean)
        .join(" ");
  const row = () => document.querySelector<HTMLElement>(`[data-testid="nav-own-${account.id}-${CSS.escape(folderKey)}"]`);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      testId="folder-delete-dialog"
      title={gmail ? t("folder.delete.gmail.title", { name }) : t("folder.delete.imap.title", { name })}
      description={description}
      confirm={t("folder.delete.confirm")}
      finalFocus={() => row() ?? document.querySelector<HTMLElement>(`[data-testid="nav-account-${account.id}"]`) ?? true}
      onConfirm={async () => {
        try {
          const { deleted } = await client.call("folders.delete", { accountId: account.id, key: folderKey });
          dropFavorites(account.id, deleted);
          snack.success(t("folder.deleted", { name }));
        } catch (e) {
          snack.error(t("folder.deleteFailed", { error: errorText(e) }));
          return;
        }
        // its row went with the catalog: the account's row takes the focus if nothing else did
        requestAnimationFrame(() => {
          const active = document.activeElement;
          if (active && active !== document.body && active.isConnected) return;
          const here = getApp().accounts.some((a) => a.id === account.id);
          if (here) document.querySelector<HTMLElement>(`[data-testid="nav-account-${account.id}"]`)?.focus();
        });
      }}
    />
  );
}
