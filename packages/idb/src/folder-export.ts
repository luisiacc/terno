import { storedAddresses, type FolderView } from "@terno/core";
import type { ExportMessage, FolderExportTarget } from "@terno/store";
import { seekAfter, T, type Ctx, type R } from "./mail";

/**
 * Plan 107: what an .mbox export reads (the SQL adapter's folder-export.ts): a stretch of a place's threads at a
 * time (the smallest `limit` ids above `after`, placed as found), the messages there that are in it. The backend
 * sorts what it collected by (date, id).
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
function stretch(c: Ctx, target: FolderExportTarget, after: number, limit: number): number[] {
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

export function exportIds(c: Ctx, target: FolderExportTarget, after: number, limit: number): { messages: { id: number; date: number }[]; next: number | null } {
  const top = stretch(c, target, after, limit);
  if (!top.length) return { messages: [], next: null };
  const messages = T(c, "messages");
  const locations = T(c, "message_locations");
  const folder = target.folder;
  const test = folder !== undefined ? (m: R) => !m.is_trash && !m.is_spam && (hasLabel(m, folder) || locations.has(m.id, folder)) : PLACE[target.view];
  const out: { id: number; date: number }[] = [];
  for (const id of top) {
    for (const m of messages.by("fk_thread_id", id)) if (m.account_id === target.accountId && !m.is_draft && test(m)) out.push({ id: m.id as number, date: m.date as number });
  }
  return { messages: out, next: top.length < limit ? null : top[top.length - 1]! };
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
