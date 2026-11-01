import { storedAddresses, type FolderView } from "@terno/core";
import type { ExportMessage, FolderExportCursor, FolderExportTarget } from "@terno/store";
import { seekAfter, T, type Ctx, type R } from "./mail";

/**
 * Plan 107: what an .mbox export reads (the SQL adapter's folder-export.ts): a stretch of a place's threads at a
 * time (the smallest ids above `after`, placed as found), the messages there that are in it, a long conversation a
 * stretch of its messages at a time. The backend sorts what it collected by (date, id).
 */
const PLACE: Record<FolderView, (m: R) => boolean> = {
  inbox: (m) => m.in_inbox === 1 && !m.is_trash && !m.is_spam,
  sent: (m) => m.is_sent === 1 && !m.is_trash && !m.is_spam,
  archive: (m) => !m.in_inbox && !m.is_trash && !m.is_spam,
  spam: (m) => m.is_spam === 1 && !m.is_trash,
  trash: (m) => m.is_trash === 1,
};

const hasLabel = (m: R, key: string): boolean => {
  if (typeof m.gmail_labels !== "string" || !m.gmail_labels.includes(key)) return false;
  try {
    const labels: unknown = JSON.parse(m.gmail_labels);
    return Array.isArray(labels) && labels.includes(key);
  } catch {
    return false;
  }
};

/**
 * The smallest `limit` thread ids of the place above `after`, from a seek into an ascending order (Codex code review
 * #9: every stretch walked every member again, 12.5 million visits in stretches of 200 at 50,000, and placing them by
 * splice was quadratic): a folder's kept members, the store's thread ids for an account (walked from `after` on, so
 * the stretches together walk them once).
 */
export function stretch(c: Ctx, target: FolderExportTarget, after: number, limit: number): number[] {
  if (target.folder !== undefined) {
    const ids = c.scopes.folder(c, target.accountId, target.folder);
    if (ids) {
      const from = seekAfter(ids, after);
      return ids.slice(from, from + limit);
    }
    // its order still being built (in the background): one walk and one native sort
    const memberships = T(c, "thread_folders");
    const found: number[] = [];
    for (const k of memberships.keysBy("folder", target.accountId, target.folder)) {
      const id = memberships.rows.get(k)!.thread_id as number;
      if (id > after) found.push(id);
    }
    return Array.from(Float64Array.from(found).sort().subarray(0, limit));
  }
  const threads = T(c, "threads");
  const ids = c.scopes.threads(c);
  const out: number[] = [];
  for (let i = seekAfter(ids, after); i < ids.length && out.length < limit; i++) if (threads.get(ids[i]!)?.account_id === target.accountId) out.push(ids[i]!);
  return out;
}

/**
 * A thread's messages after `from` (by id), at most `n` looked at: all of a short one as the index holds them; a long
 * one's ids sorted natively (one numeric sort, a few milliseconds at 50,000) to seek into, so a conversation of any
 * length is read a stretch a call (Codex code review round 2 #6: one of 50,000 was read whole in one call).
 */
export function threadStretch(c: Ctx, thread: number, from: number | null, n: number): { rows: R[]; more: boolean } {
  const messages = T(c, "messages");
  if (from === null && messages.count("fk_thread_id", thread) <= n) return { rows: messages.by("fk_thread_id", thread), more: false };
  const ids = Float64Array.from(messages.keysBy("fk_thread_id", thread) as IterableIterator<number>).sort();
  let at = from === null ? 0 : seekAfter(ids, from);
  const rows: R[] = [];
  for (const end = Math.min(ids.length, at + n); at < end; at++) rows.push(messages.get(ids[at]!)!);
  return { rows, more: at < ids.length };
}

export function exportIds(c: Ctx, target: FolderExportTarget, after: FolderExportCursor | null, limit: number): { messages: { id: number; date: number }[]; next: FolderExportCursor | null } {
  const locations = T(c, "message_locations");
  const folder = target.folder;
  // a pending rename's old paths are the folder's too (Codex code review round 5 #2), each under the UIDVALIDITY it
  // had; those are another folder's under its own path when the path was made again (round 6 #2)
  const aliases = (folder !== undefined && target.aliases) || [];
  const except = (folder !== undefined && target.except) || [];
  const at = (m: R, mailbox: string) => locations.get(m.id, mailbox)?.uidvalidity as number | undefined;
  const placed = (m: R, mailbox: string) => { const v = at(m, mailbox); return v !== undefined && !except.includes(v); };
  const test = folder !== undefined ? (m: R) => !m.is_trash && !m.is_spam && (hasLabel(m, folder) || placed(m, folder) || aliases.some((a) => at(m, a.mailbox) === a.uidvalidity)) : PLACE[target.view];
  const out: { id: number; date: number }[] = [];
  let budget = limit;
  /** a thread from `from`: where it stopped, or null when it's read to its end */
  const read = (thread: number, from: number | null): { id: number; date: number } | null => {
    const { rows, more } = threadStretch(c, thread, from, budget);
    for (const m of rows) if (m.account_id === target.accountId && !m.is_draft && test(m)) out.push({ id: m.id as number, date: m.date as number });
    budget -= Math.max(1, rows.length);
    const last = rows.at(-1);
    return more && last ? { id: last.id as number, date: last.date as number } : null;
  };
  if (after?.message) {
    const cut = read(after.thread, after.message.id);
    if (cut) return { messages: out, next: { thread: after.thread, message: cut } };
    if (budget <= 0) return { messages: out, next: { thread: after.thread } };
  }
  const asked = budget;
  const top = stretch(c, target, after?.thread ?? 0, asked);
  for (const id of top) {
    const cut = read(id, null);
    if (cut) return { messages: out, next: { thread: id, message: cut } };
    if (budget <= 0) return { messages: out, next: { thread: id } };
  }
  // each thread took at least one of the budget: a full stretch returned above, so this one was the last
  return { messages: out, next: null };
}

/** these messages, their bodies read ahead by the caller */
export function exportMessages(c: Ctx, ids: readonly number[]): ExportMessage[] {
  const messages = T(c, "messages");
  const attachments = T(c, "attachments");
  const assets = T(c, "attachment_assets");
  const out: ExportMessage[] = [];
  for (const id of ids) {
    const m = messages.get(id);
    if (!m) continue;
    const body = c.body(id);
    out.push({
      id,
      accountId: m.account_id,
      rfcMessageId: m.rfc_message_id ?? null,
      inReplyTo: m.in_reply_to ?? null,
      references: parseRefs(m.references_json),
      ...storedAddresses(m as Parameters<typeof storedAddresses>[0]),
      date: m.date,
      subject: m.subject,
      listId: m.list_id ?? null,
      bodyText: body?.body_text ?? null,
      bodyHtml: body?.body_html ?? null,
      bodyState: m.body_state,
      attachments: attachments
        .by("fk_message_id", id)
        .sort((x, y) => x.id - y.id)
        // the bytes are here only when the asset is complete
        .map((a) => ({ filename: a.filename, mime: a.mime, size: a.size, contentId: a.content_id ?? null, assetId: a.asset_id && assets.get(a.asset_id)?.complete === 1 ? (a.asset_id as string) : null })),
    });
  }
  return out;
}

function parseRefs(json: unknown): string[] {
  try {
    const refs: unknown = JSON.parse(typeof json === "string" ? json : "[]");
    return Array.isArray(refs) ? refs.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}
