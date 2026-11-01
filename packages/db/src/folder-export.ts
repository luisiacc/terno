import { storedAddresses, type FolderView } from "@terno/core";
import type { ExportMessage, FolderExportCursor, FolderExportTarget } from "@terno/store";
import type { Db } from "./sqlite";

/**
 * Plan 107: what an .mbox export reads (the IndexedDB adapter's folder-export.ts). The ids are walked a stretch at
 * a time by an index (a folder's memberships, an account's threads, then each thread's messages by date and id), so
 * no read holds the backend long, even inside one long conversation; the backend sorts what it collected by (date, id).
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
  OR EXISTS (SELECT 1 FROM message_locations l WHERE l.message_id = m.id AND (l.mailbox = ?2 OR l.mailbox IN (SELECT value FROM json_each(?6)))))`;

/** before every message (dates are milliseconds) */
const FIRST = { id: 0, date: Number.MIN_SAFE_INTEGER };

export function exportIds(db: Db, target: FolderExportTarget, after: FolderExportCursor | null, limit: number): { messages: { id: number; date: number }[]; next: FolderExportCursor | null } {
  // a thread's messages past a point, in the index's order, each with whether it's in the place: what's looked at is
  // bounded by the LIMIT, never by how many match (Codex code review round 2 #6: one 50,000-message conversation was
  // read whole in one call)
  const test = target.folder !== undefined ? `m.is_draft = 0 AND ${IN_FOLDER}` : `m.account_id = ?2 AND m.is_draft = 0 AND ${PLACE[target.view]}`;
  const select = `SELECT m.id, m.date, (${test}) AS ok FROM messages m INDEXED BY messages_thread WHERE m.thread_id = ?1`;
  const key = target.folder ?? target.accountId;
  // a folder's pending rename aliases (?6), bound only where the test names them
  const aliases = target.folder !== undefined ? [JSON.stringify(target.aliases ?? [])] : [];
  // the rest of the cursor's date, then the later dates: two seeks (a row value compared whole seeks by the date
  // alone, so a run of equal dates would be walked from its start each time)
  const page = (thread: number, from: { id: number; date: number }, n: number) => {
    const same = from === FIRST ? [] : db.all<{ id: number; date: number; ok: number }>(`${select} AND m.date = ?3 AND m.id > ?4 ORDER BY m.id LIMIT ?5`, thread, key, from.date, from.id, n, ...aliases);
    return same.length >= n ? same : [...same, ...db.all<{ id: number; date: number; ok: number }>(`${select} AND m.date > ?3 ORDER BY m.date, m.id LIMIT ?5`, thread, key, from.date, from.id, n - same.length, ...aliases)];
  };
  const out: { id: number; date: number }[] = [];
  let budget = limit;
  /** a thread from `from`: where it stopped, or null when it's read to its end */
  const read = (thread: number, from: { id: number; date: number }): { id: number; date: number } | null => {
    // one more than the budget: whether the thread goes on past it
    const rows = page(thread, from, budget + 1);
    const taken = rows.length > budget ? rows.slice(0, budget) : rows;
    for (const r of taken) if (r.ok) out.push({ id: r.id, date: r.date });
    budget -= Math.max(1, taken.length);
    return rows.length > taken.length ? { id: taken.at(-1)!.id, date: taken.at(-1)!.date } : null;
  };
  if (after?.message) {
    const cut = read(after.thread, after.message);
    if (cut) return { messages: out, next: { thread: after.thread, message: cut } };
    if (budget <= 0) return { messages: out, next: { thread: after.thread } };
  }
  const from = after?.thread ?? 0;
  const asked = budget;
  const threads = target.folder !== undefined
    ? db.all<{ id: number }>("SELECT thread_id AS id FROM thread_folders INDEXED BY thread_folders_id WHERE account_id = ? AND folder = ? AND thread_id > ? ORDER BY thread_id LIMIT ?", target.accountId, target.folder, from, asked)
    : db.all<{ id: number }>("SELECT id FROM threads INDEXED BY threads_account_id WHERE account_id = ? AND id > ? ORDER BY id LIMIT ?", target.accountId, from, asked);
  for (const { id } of threads) {
    const cut = read(id, FIRST);
    if (cut) return { messages: out, next: { thread: id, message: cut } };
    if (budget <= 0) return { messages: out, next: { thread: id } };
  }
  // each thread took at least one of the budget: a full stretch returned above, so this one was the last
  return { messages: out, next: null };
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
