import { removable, storageBucket, type StorageBucket, type StorageThreadRow } from "@terno/core";
import type { StorageRemoval } from "@terno/store";
import { idbAssets } from "./attachments";
import { deleteMessages, seekAfter, T, type Ctx } from "./mail";

const PENDING = new Set(["queued", "running", "unknown"]);

/** Threads a draft is on: its own, or the one of the message it answers or forwards (drafts are few). */
function drafted(c: Ctx): Set<number> {
  const messages = T(c, "messages");
  const out = new Set<number>();
  for (const d of T(c, "drafts").all()) {
    if (d.thread_id != null) out.add(d.thread_id as number);
    for (const ref of [d.in_reply_to_message_id, d.forward_of_message_id]) {
      const m = ref == null ? undefined : messages.get(ref);
      if (m) out.add(m.thread_id as number);
    }
  }
  return out;
}

/** Accounts that must sign in again: what is stored may be stale for long, so their mail stays (Codex R2). */
function signedOut(c: Ctx): Set<number> {
  const out = new Set<number>();
  for (const a of T(c, "accounts").all()) {
    try {
      const s = JSON.parse(a.sync_state as string) as { authRequired?: boolean; authScope?: string | null };
      if (s.authRequired && s.authScope !== "send") out.add(a.id as number);
    } catch {
      out.add(a.id as number);
    }
  }
  return out;
}

/** A message that must stay: starred, a draft, local or unsent, an op not settled, a flag not yet confirmed (Codex R4). */
function held(c: Ctx, m: Record<string, unknown>): boolean {
  const provider = m.provider_msg_id as string | null;
  // a star counts even in Trash, where the thread's own flag ignores it
  if (m.is_draft === 1 || m.is_starred === 1 || provider == null || provider.startsWith("local:")) return true;
  const ops = T(c, "ops");
  for (const t of T(c, "op_targets").by("message", m.id)) if (PENDING.has(ops.get(t.op_id)?.state as string)) return true;
  for (const f of T(c, "message_flag_intents").by("fk_message_id", m.id)) if ((f.pending_count as number) > 0 || f.needs_snapshot === 1) return true;
  return false;
}

function row(c: Ctx, id: number, drafts: Set<number>, out: Set<number>): StorageThreadRow | null {
  const t = T(c, "threads").get(id);
  if (!t) return null;
  const messages = T(c, "messages");
  let count = 0;
  let bytes = 0;
  let keep = t.is_starred === 1 || t.has_sent === 1 || drafts.has(id) || out.has(t.account_id as number);
  // by key: a thread of thousands of messages is never copied into an array
  for (const key of messages.keysBy("fk_thread_id", id)) {
    const m = messages.rows.get(key);
    if (!m) continue;
    count++;
    bytes += (m.size as number) || 0;
    if (!keep && held(c, m)) keep = true;
  }
  return {
    id,
    accountId: t.account_id as number,
    bucket: storageBucket({ inInbox: t.in_inbox === 1, inTrash: t.in_trash === 1, inSpam: t.in_spam === 1, hasSent: t.has_sent === 1 }),
    lastDate: t.last_date as number,
    kept: keep,
    messages: count,
    bytes,
  };
}

/** Ascending through the scope index's sorted ids (no scan or sort per call: Codex R6). */
export function storageThreads(c: Ctx, after: number, limit: number): StorageThreadRow[] {
  const ids = c.scopes.threads(c);
  const drafts = drafted(c);
  const out = signedOut(c);
  const rows: StorageThreadRow[] = [];
  for (let i = seekAfter(ids, after); i < ids.length && rows.length < limit; i++) {
    const r = row(c, ids[i]!, drafts, out);
    if (r) rows.push(r);
  }
  return rows;
}

/** One unit (the caller's command): the threads that may go now, then at most `maxMessages` of their messages, oldest first. */
export function removeStorage(c: Ctx, r: { threadIds: readonly number[]; buckets: readonly StorageBucket[]; cutoff: number; maxMessages: number }): StorageRemoval {
  const drafts = drafted(c);
  const out = signedOut(c);
  const eligible = [...new Set(r.threadIds)].map((id) => row(c, id, drafts, out)).filter((t): t is StorageThreadRow => !!t && removable(t, r.buckets, r.cutoff));
  const total = eligible.reduce((n, t) => n + t.messages, 0);
  if (!eligible.length || r.maxMessages <= 0) return { touched: [], threads: 0, messages: 0, remaining: total, removed: [] };
  const messages = T(c, "messages");
  const victims: Record<string, unknown>[] = [];
  for (const t of eligible) for (const key of messages.keysBy("fk_thread_id", t.id)) victims.push(messages.rows.get(key)!);
  victims.sort((a, b) => (a.date as number) - (b.date as number) || (a.id as number) - (b.id as number));
  victims.length = Math.min(victims.length, r.maxMessages);
  const messageIds = victims.map((m) => m.id as number);
  const links = T(c, "attachment_links");
  const assets = new Set<string>();
  for (const id of messageIds) for (const l of links.by("fk_message_id", id)) assets.add(l.asset_id as string);
  const touched = deleteMessages(c, messageIds);
  // what they alone pinned is collectable now: nothing can bring these messages back to claim it (Codex R3)
  idbAssets(c.db).expireGrace([...assets]);
  const threads = T(c, "threads");
  const removed = new Map<number, string[]>();
  for (const m of victims) {
    let list = removed.get(m.account_id as number);
    if (!list) removed.set(m.account_id as number, (list = []));
    list.push(m.provider_msg_id as string);
  }
  return {
    touched: [...touched],
    threads: eligible.filter((t) => !threads.get(t.id)).length,
    messages: messageIds.length,
    remaining: total - messageIds.length,
    removed: [...removed].map(([accountId, providerMsgIds]) => ({ accountId, providerMsgIds })),
  };
}
