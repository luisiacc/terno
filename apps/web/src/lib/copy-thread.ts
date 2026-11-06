/**
 * Plan 149: "Copy conversation as text". Every way in (the reader's menu, the
 * list's, the palette) ends here.
 */
import { DIGEST_ROW_ID, type ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { printableThread } from "~/lib/print-open";
import { dismissSnack, snack } from "~/lib/snack";
import { threadText } from "~/lib/thread-text";
import { client } from "~/rpc/connection";
import { loadThread } from "~/state/threads";

/** The bodies too: a conversation copied from the list may never have been opened. What doesn't arrive, the text marks. */
async function downloaded(threadId: number): Promise<ThreadDetail | null> {
  const detail = await loadThread(threadId, true);
  const pending = detail?.messages.filter((m) => m.bodyState !== "full" && !m.bodyUnavailable) ?? [];
  if (pending.length === 0) return detail;
  const notice = snack(t("reader.downloading"));
  try {
    for (const m of pending) await client.call("reader.hydrate", { threadId, messageId: m.id });
  } catch {
    /* offline, or the server said no: copy what there is */
  } finally {
    dismissSnack(notice);
  }
  return (await loadThread(threadId, true)) ?? detail;
}

async function build(threadId: number) {
  const detail = await downloaded(threadId);
  if (!detail) throw new Error("The conversation could not be read");
  return threadText(detail);
}

export function copyThreadText(threadId: number): void {
  const built = build(threadId);
  // the write starts inside the click and holds a promise of the text: a browser may refuse one that starts after a wait.
  // Both forms: a document takes the links and the bold, an AI's composer the text with its addresses written out
  const item = new ClipboardItem({
    "text/plain": built.then(({ text }) => new Blob([text], { type: "text/plain" })),
    "text/html": built.then(({ html }) => new Blob([html], { type: "text/html" })),
  });
  void navigator.clipboard.write([item]).then(
    () => built.then(({ messages, missing }) => snack(missing ? t("threadText.copiedMissing", { count: missing }) : t("threadText.copied", { count: messages }), { duration: 2000 })),
    () => snack.error(t("threadText.copyFailed")),
  );
}

/** The palette: the open conversation, when there is one (the digest's row isn't). */
export function copyOpenThread(): void {
  const id = printableThread();
  if (id !== null && id !== DIGEST_ROW_ID) copyThreadText(id);
}
