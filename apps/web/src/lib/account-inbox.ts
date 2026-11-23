import { inAllInbox } from "@terno/core";
import { t } from "@terno/i18n";
import { undoAction } from "~/lib/actions";
import { patchAccount } from "~/lib/accounts";
import { registerUndo, snack } from "~/lib/snack";
import { getApp } from "~/state/app";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Plan 238: whether an account's mail is in the all-accounts Inbox and its unread count. The account's mark shows
 * at once; the Inbox follows the backend's reload. The snack's Undo sets the value it had.
 */
export async function setInAllInbox(accountId: number, on: boolean): Promise<boolean> {
  const before = getApp().accounts.find((a) => a.id === accountId);
  if (!before) return false;
  const was = inAllInbox(before);
  if (was === on) return true;
  try {
    await patchAccount(accountId, { unified: on });
  } catch (error) {
    snack.error(t("category.inboxFailed", { error: errorText(error) }));
    return false;
  }
  const undo = registerUndo(() => patchAccount(accountId, { unified: was }));
  const text = on ? t("account.allInbox.shown", { account: before.displayName }) : t("account.allInbox.hidden", { account: before.displayName });
  snack.success(text, { duration: 6000, action: undoAction(undo, t("common.undo")) });
  return true;
}
