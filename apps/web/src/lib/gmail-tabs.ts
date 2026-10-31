import { separatesTabs } from "@terno/core";
import { t } from "@terno/i18n";
import { client } from "~/rpc/connection";
import { undoAction } from "~/lib/actions";
import { registerUndo, snack } from "~/lib/snack";
import { getApp, setAccounts } from "~/state/app";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Plan 86: whether a Gmail account keeps Promotions and Social out of the
 * Inbox. The Inbox shows them (or not) as soon as the backend has it (it says
 * so with a list reload); the snack's Undo sets the value it had.
 */
export async function setSeparateTabs(accountId: number, on: boolean): Promise<boolean> {
  const before = getApp().accounts.find((a) => a.id === accountId);
  if (!before) return false;
  const was = separatesTabs(before);
  try {
    await apply(accountId, on);
  } catch (error) {
    snack.error(t("category.inboxFailed", { error: errorText(error) }));
    return false;
  }
  if (was === on) return true;
  const undo = registerUndo(() => apply(accountId, was));
  const text = on ? t("account.tabs.hidden", { account: before.displayName }) : t("account.tabs.shown");
  snack.success(text, { duration: 6000, action: undoAction(undo, t("common.undo")) });
  return true;
}

async function apply(accountId: number, on: boolean): Promise<void> {
  const next = await client.call("accounts.update", { id: accountId, separateTabs: on });
  setAccounts(getApp().accounts.map((a) => (a.id === next.id ? next : a)));
}
