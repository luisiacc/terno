import { storedAddresses, type FolderView } from "@terno/core";
import type { ExportMessage, FolderExportTarget } from "@terno/store";
import type { Db } from "./sqlite";

/**
 * Plan 107: what an .mbox export reads (the IndexedDB adapter's folder-export.ts). The ids are walked a stretch of
 * threads at a time by an index (a folder's memberships, an account's threads), so no read holds the backend long;
 * the backend sorts what it collected by (date, id).
 */
const PLACE: Record<FolderView, string> = {
  inbox: "m.in_inbox = 1 AND m.is_trash = 0 AND m.is_spam = 0",
  sent: "m.is_sent = 1 AND m.is_trash = 0 AND m.is_spam = 0",
  archive: "m.in_inbox = 0 AND m.is_trash = 0 AND m.is_spam = 0",
  spam: "m.is_spam = 1 AND m.is_trash = 0",
  trash: "m.is_trash = 1",
};

/** a Gmail label in its stored labels, or an IMAP location in that mailbox */
const IN_FOLDER = `m.is_trash = 0 AND m.is_spam = 0 AND (
  (m.gmail_labels IS NOT NULL AND instr(m.gmail_labels, ?2) > 0 AND json_valid(m.gmail_labels) AND EXISTS (SELECT 1 FROM json_each(m.gmail_labels) WHERE value = ?2))
  OR EXISTS (SELECT 1 FROM message_locations l WHERE l.message_id = m.id AND l.mailbox = ?2))`;

export function exportIds(db: Db, target: FolderExportTarget, after: number, limit: number): { messages: { id: number; date: number }[]; next: number | null } {
  const threads = target.folder !== undefined
    ? db.all<{ id: number }>("SELECT thread_id AS id FROM thread_folders INDEXED BY thread_folders_id WHERE account_id = ? AND folder = ? AND thread_id > ? ORDER BY thread_id LIMIT ?", target.accountId, target.folder, after, limit)
    : db.all<{ id: number }>("SELECT id FROM threads INDEXED BY threads_account_id WHERE account_id = ? AND id > ? ORDER BY id LIMIT ?", target.accountId, after, limit);
  if (!threads.length) return { messages: [], next: null };
  const json = JSON.stringify(threads.map((t) => t.id));
  const messages = target.folder !== undefined
    ? db.all<{ id: number; date: number }>(`SELECT m.id, m.date FROM messages m WHERE m.thread_id IN (SELECT value FROM json_each(?1)) AND m.is_draft = 0 AND ${IN_FOLDER}`, json, target.folder)
    : db.all<{ id: number; date: number }>(`SELECT m.id, m.date FROM messages m WHERE m.thread_id IN (SELECT value FROM json_each(?1)) AND m.account_id = ?2 AND m.is_draft = 0 AND ${PLACE[target.view]}`, json, target.accountId);
  return { messages: messages.map((m) => ({ id: m.id, date: m.date })), next: threads.length < limit ? null : threads[threads.length - 1]!.id };
}

interface Row {
  id: number;
  account_id: number;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  references_json: string;
  from_name: string;
  from_email: string;
  to_json: string;
  cc_json: string;
  reply_to_json: string;
  subject: string;
  date: number;
  list_id: string | null;
  body_state: "none" | "partial" | "full";
  body_text: string | null;
  body_html: string | null;
}

export function exportMessages(db: Db, ids: readonly number[]): ExportMessage[] {
  if (!ids.length) return [];
  const json = JSON.stringify(ids);
  const rows = new Map(db.all<Row>(
    `SELECT m.id, m.account_id, m.rfc_message_id, m.in_reply_to, m.references_json, m.from_name, m.from_email, m.to_json, m.cc_json, m.reply_to_json,
            m.subject, m.date, m.list_id, m.body_state, b.body_text, b.body_html
     FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id WHERE m.id IN (SELECT value FROM json_each(?))`,
    json,
  ).map((r) => [r.id, r]));
  const attachments = new Map<number, ExportMessage["attachments"]>();
  // the bytes are here only when the asset is complete
  for (const a of db.all<{ message_id: number; filename: string; mime: string; size: number; content_id: string | null; asset_id: string | null }>(
    `SELECT a.message_id, a.filename, a.mime, a.size, a.content_id, CASE WHEN s.complete = 1 THEN s.id END AS asset_id
     FROM attachments a LEFT JOIN attachment_assets s ON s.id = a.asset_id WHERE a.message_id IN (SELECT value FROM json_each(?)) ORDER BY a.message_id, a.id`,
    json,
  )) {
    const list = attachments.get(a.message_id) ?? [];
    list.push({ filename: a.filename, mime: a.mime, size: a.size, contentId: a.content_id, assetId: a.asset_id });
    attachments.set(a.message_id, list);
  }
  const out: ExportMessage[] = [];
  for (const id of ids) {
    const m = rows.get(id);
    if (!m) continue;
    out.push({
      id: m.id,
      accountId: m.account_id,
      rfcMessageId: m.rfc_message_id,
      inReplyTo: m.in_reply_to,
      references: parseRefs(m.references_json),
      ...storedAddresses(m),
      date: m.date,
      subject: m.subject,
      listId: m.list_id,
      bodyText: m.body_text,
      bodyHtml: m.body_html,
      bodyState: m.body_state,
      attachments: attachments.get(id) ?? [],
    });
  }
  return out;
}

export function parseRefs(json: string): string[] {
  try {
    const refs: unknown = JSON.parse(json);
    return Array.isArray(refs) ? refs.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}
