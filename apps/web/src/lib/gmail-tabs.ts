import { separatesTabs } from "@terno/core";
import { t } from "@terno/i18n";
import { client } from "~/rpc/connection";
import { undoAction } from "~/lib/actions";
import { registerUndo, snack } from "~/lib/snack";
import { getApp, setAccounts } from "~/state/app";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Plan 86: whether a Gmail account keeps Promotions and Social (plan 275: an
 * Outlook account its Other) out of the Inbox. The Inbox shows them (or not) as soon as the backend has it (it says
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
  // plan 275: an Outlook account's is its Other
  const other = before.kind === "outlook";
  const text = on ? t(other ? "account.otherTab.hidden" : "account.tabs.hidden", { account: before.displayName }) : t(other ? "account.otherTab.shown" : "account.tabs.shown");
  snack.success(text, { duration: 6000, action: undoAction(undo, t("common.undo")) });
  return true;
}

async function apply(accountId: number, on: boolean): Promise<void> {
  const next = await client.call("accounts.update", { id: accountId, separateTabs: on });
  setAccounts(getApp().accounts.map((a) => (a.id === next.id ? next : a)));
}

/**
 * Plan 275: Focused Inbox's sender override: these conversations move now (to the Inbox, or to Other), and Outlook
 * sorts the sender's future mail the same way. Its Undo takes back both.
 */
export async function classifySender(threadIds: readonly number[], sender: { email: string; name: string }, as: "focused" | "other"): Promise<void> {
  const label = sender.name || sender.email;
  try {
    const r = await client.call("threads.classifySender", { threadIds: [...threadIds], address: sender.email, as });
    const undo = registerUndo(async () => { await client.call("threads.undo", { undoId: r.undoId }); });
    snack.success(t(as === "other" ? "senderOverride.doneOther" : "senderOverride.doneInbox", { sender: label }), { duration: 6000, action: undoAction(undo, t("senderOverride.undo")) });
  } catch (error) {
    snack.error(t("actions.failed", { error: errorText(error) }));
  }
}
