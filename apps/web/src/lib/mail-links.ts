import { t } from "@terno/i18n";
import { returnFromMailReaderView } from "~/components/mail-reader-back";
import { leaveNewDraft } from "~/lib/compose";
import { focusIntent, installFocusIntent } from "~/lib/focus-intent";
import { focusAfterDialog, messageFocusTarget } from "~/lib/focus-message";
import { openThread } from "~/lib/page";
import { snack } from "~/lib/snack";
import { revealSummaryMessage } from "~/lib/summaries";
import { client } from "~/rpc/connection";
import { getApp, getSelectionWriteRevision, setApp } from "~/state/app";

/**
 * Plan 201: a link to an email (terno://message/<Message-ID>) opens its conversation at that message, wherever it lives
 * (like an Ask source, the list stays as it is). A newer open (another link, a notification's click) or the user's own
 * move while it is looked up wins.
 */
let seq = 0;

/** a notification's click came after: a link still being looked up opens nothing */
export function supersedeMailLink(): void {
  seq++;
}

export async function openMailLink(id: string): Promise<void> {
  installFocusIntent();
  const mine = ++seq;
  const selection = getSelectionWriteRevision();
  const moved = focusIntent.seq;
  const current = () => mine === seq && selection === getSelectionWriteRevision() && moved === focusIntent.seq;
  let at: { threadId: number; messageId: number } | null;
  try {
    at = await client.call("links.resolve", { id });
  } catch {
    if (current()) snack.error(t("links.failed"), { description: t("links.failedHint") });
    return;
  }
  if (!current()) return;
  if (!at) return void snack.error(t("links.notFound"), { description: t("links.notFoundHint") });
  const { threadId, messageId } = at;
  const app = getApp();
  if (app.dialog !== null) setApp({ dialog: null });
  // a new message steps aside (kept if written), a selection ends: the message is what was asked for
  if (app.compose) leaveNewDraft();
  if (app.checked.size || app.scope !== null) setApp({ checked: new Set(), scope: null });
  // a message open on its own page (the full view) gives way to the conversation
  returnFromMailReaderView();
  openThread(threadId);
  revealSummaryMessage(messageId);
  focusAfterDialog(() => messageFocusTarget(messageId), () => mine === seq && getApp().selectedId === threadId);
}
