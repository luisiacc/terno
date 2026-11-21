import type { MailStore } from "../mail-store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

/**
 * Plan 229 (Codex code review): the most a selection acts on in one command (20 conversations, the backend's one go), on
 * Gmail, each of a hundred messages with one unread, the account's flag intents on: Mark as read names each
 * conversation's newest messages too. The best of three rounds (ms), and how many messages the ops named.
 */
export async function measureLongConversationsAct(store: MailStore): Promise<{ ms: number; named: number }> {
  const [gmail] = await withAccounts(store, 1);
  const threads: number[] = [];
  for (let t = 0; t < 20; t++) {
    await ingest(store, Array.from({ length: 100 }, (_, i) => msg({ accountId: gmail!, providerMsgId: `t${t}-${i}`, rfcMessageId: `t${t}-${i}@x`, inReplyTo: i === 0 ? null : `t${t}-0@x`, isRead: i !== 99, date: 1000 + i })));
    threads.push(await threadOf(store, `t${t}-0`));
  }
  await store.sync.beginObservation!(gmail!, { authoritativeFlags: true });
  let best = Infinity, named = 0;
  for (let round = 0; round < 3; round++) {
    if (round) await store.threads.act({ threadIds: threads, action: "markUnread", signal: null, now: 2 * round });
    const started = performance.now();
    const r = await store.threads.act({ threadIds: threads, action: "markRead", signal: null, now: 2 * round + 1 });
    best = Math.min(best, performance.now() - started);
    named = (await store.debug.snapshot()).ops.filter((o) => r.opIds.includes(o.id)).reduce((n, o) => n + o.messageIds.length, 0);
  }
  return { ms: best, named };
}
