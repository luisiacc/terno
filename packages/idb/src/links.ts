import { canonicalMessageId } from "@terno/core";
import { LINK_COPIES_MAX, type MailStore } from "@terno/store";
import { T, type Ctx, type R } from "./mail";

/** Plan 201 on IndexedDB, like SQL's (packages/db/src/links.ts). */

export function findLinked(c: Ctx, rfcMessageId: string): Awaited<ReturnType<MailStore["links"]["find"]>> {
  const id = canonicalMessageId(rfcMessageId);
  if (!id) return [];
  const messages = T(c, "messages");
  return [...T(c, "accounts").all()]
    .flatMap((a) => messages.by("rfc", a.id, id))
    .sort((a, b) => a.id - b.id)
    .slice(0, LINK_COPIES_MAX)
    .map((m) => ({ id: m.id as number, threadId: m.thread_id as number, accountId: m.account_id as number, spam: m.is_spam === 1, trash: m.is_trash === 1 }));
}

export function newestLinked(c: Ctx, threadIds: readonly number[]): Map<number, string> {
  const messages = T(c, "messages");
  const out = new Map<number, string>();
  // the same order as SQL's: outside Spam and Trash first, then one with a Message-ID, then the newest
  const rank = (m: R) => [m.is_spam || m.is_trash ? 1 : 0, m.rfc_message_id ? 0 : 1, -m.date, -m.id];
  const before = (a: R, b: R) => {
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
    return false;
  };
  for (const threadId of new Set(threadIds)) {
    let best: R | null = null;
    for (const m of messages.by("fk_thread_id", threadId)) if (!m.is_draft && (!best || before(m, best))) best = m;
    if (best?.rfc_message_id) out.set(threadId, best.rfc_message_id as string);
  }
  return out;
}
