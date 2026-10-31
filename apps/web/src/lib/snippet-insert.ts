import { fillText, nameParts, parseAddressList, SNIPPET_HTML_MAX, SNIPPET_TEXT_MAX, snippetPreview, type Account, type Snippet, type SnippetValues } from "@terno/core";
import { t } from "@terno/i18n";
import { controllerFor } from "~/components/composer/controller";
import { loadComposer } from "~/components/composer/lazy";
import { getApp, setApp } from "~/state/app";
import { openCompose } from "./compose";
import { editDraft, editDraftRecipients, useDrafts, type LocalDraft } from "./drafts";
import { registerUndo, snack } from "./snack";
import { createSnippet, newSnippetId } from "./snippets";
import { openSnippetEditor } from "./snippet-editor-state";

/**
 * Plan 93: a snippet into a draft (its fields only where the draft's are
 * empty, its text at the caret), a new message from one, and a draft saved
 * as one. Entry chunk; the editor's part goes through the composer controller.
 */

type Field = "to" | "cc" | "bcc";
const FIELDS: readonly Field[] = ["to", "cc", "bcc"];

/** The values a snippet's variables take: the first To recipient's, and the sending account's own. */
export function snippetValues(toText: string, account: Pick<Account, "senderName" | "displayName"> | undefined): SnippetValues {
  const first = parseAddressList(toText)[0];
  const them = nameParts(first?.name);
  const me = nameParts(account?.senderName || account?.displayName);
  return {
    first_name: them?.first,
    last_name: them?.last,
    full_name: them?.full,
    email: first?.email,
    my_first_name: me?.first,
    my_name: me?.full,
  };
}

const accountOf = (id: number) => getApp().accounts.find((a) => a.id === id);
const emails = (text: string) => parseAddressList(text).map((a) => a.email.toLowerCase());
const canChange = (d: LocalDraft | undefined): d is LocalDraft => !!d && !d.sending;

/**
 * Inserts a snippet into a draft that is on screen. Its recipients and
 * subject go in only where the draft's are empty (never over a reply's
 * "Re: …"); when it filled any, a snack offers Undo for all of it. False when
 * the draft can't take it now (gone, sending, its editor not there).
 */
export function insertSnippetInto(key: string, snippet: Snippet): boolean {
  const d = useDrafts.getState().drafts[key];
  const c = controllerFor(key);
  if (!canChange(d) || !c) {
    if (d && !d.sending) snack.error(t("snippets.insertFailed"));
    return false;
  }
  const filled: { field: Field | "subject"; value: string }[] = [];
  for (const field of FIELDS) {
    const value = snippet[field].trim();
    if (!value || d[`${field}Text`].trim() !== "") continue;
    if (editDraftRecipients(key, field, value, emails(value))) filled.push({ field, value });
  }
  const values = snippetValues(useDrafts.getState().drafts[key]?.toText ?? d.toText, accountOf(d.accountId));
  const subject = fillText(snippet.subject, values).trim();
  if (subject && d.subject.trim() === "" && !d.subjectEdited && editDraft(key, { subject, subjectEdited: true })) filled.push({ field: "subject", value: subject });
  const body = snippet.bodyHtml || snippet.bodyText ? c.insertSnippet(snippet.bodyHtml, snippet.bodyText, values) : null;
  if (!filled.length) return true;
  // what the snippet filled goes back to empty while it still holds what the snippet put there; the text while it's the last change
  const undo = registerUndo(() => {
    const now = useDrafts.getState().drafts[key];
    if (!canChange(now)) return;
    for (const f of filled) {
      if (f.field === "subject") {
        if (now.subject === f.value) editDraft(key, { subject: "", subjectEdited: false });
      } else if (now[`${f.field}Text`] === f.value) editDraftRecipients(key, f.field, "", []);
    }
    body?.undo();
  });
  snack({ message: t("snippets.inserted", { name: snippet.name || t("snippets.untitled") }), action: { label: t("common.undo"), undo } });
  return true;
}

/** A new message with the snippet in it (its fields and filled text in the step that creates it). */
export async function newMessageFromSnippet(snippet: Snippet): Promise<void> {
  const rich = await loadComposer();
  await openCompose("new", null, 0, (accountId) => {
    const values = snippetValues(snippet.to, accountOf(accountId));
    const body = rich.filledBody(snippet.bodyHtml, snippet.bodyText, values);
    const subject = fillText(snippet.subject, values).trim();
    return {
      toText: snippet.to.trim(),
      ccText: snippet.cc.trim(),
      bccText: snippet.bcc.trim(),
      subject,
      subjectEdited: subject !== "",
      bodyHtml: body.html,
      bodyText: body.text,
    };
  });
}

/**
 * Save as snippet…: the draft's text as the editor has it now (never the
 * draft's saved copy, which lags it), its subject and recipients when it's a
 * new message, then the editor in Settings on it, its name selected.
 */
export async function saveDraftAsSnippet(key: string): Promise<void> {
  const d = useDrafts.getState().drafts[key];
  const c = controllerFor(key);
  if (!d || !c) return void snack.error(t("snippets.saveFailed", { error: t("snippets.insertFailed") }));
  const body = c.snapshot();
  if (body.html.length > SNIPPET_HTML_MAX || body.text.length > SNIPPET_TEXT_MAX) return void snack.error(t("snippets.error.bodyTooLong"));
  const isNew = d.mode === "new";
  const name = (isNew && d.subject.trim()) || snippetPreview({ bodyText: body.text }, 40);
  try {
    const saved = await createSnippet(newSnippetId(), {
      name: name.slice(0, 80),
      bodyHtml: body.html,
      bodyText: body.text,
      subject: isNew ? d.subject.trim().slice(0, 300) : "",
      to: isNew ? d.toText.trim().slice(0, 2000) : "",
      cc: isNew ? d.ccText.trim().slice(0, 2000) : "",
      bcc: isNew ? d.bccText.trim().slice(0, 2000) : "",
    });
    openSnippetEditor(saved.id, { selectName: true });
    setApp({ dialog: "settings", settingsTab: "snippets" });
  } catch (error) {
    snack.error(t("snippets.saveFailed", { error: error instanceof Error ? error.message : String(error) }));
  }
}
