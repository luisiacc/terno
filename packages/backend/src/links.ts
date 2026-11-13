import { MESSAGE_ID_MAX } from "@terno/core";
import type { MailStore } from "@terno/store";

/**
 * Plan 201: links to emails. A click opens the message its Message-ID names: the same message can be in several
 * accounts, so the first copy stored outside Spam and Trash, else the first stored. First, not newest: a sender can
 * reuse a Message-ID, and a copy that arrives later never takes over a link that already opened something.
 */
export async function resolveLink(store: Pick<MailStore, "links">, id: string): Promise<{ threadId: number; messageId: number } | null> {
  if (id.length > MESSAGE_ID_MAX) return null;
  const found = await store.links.find(id);
  const m = found.find((x) => !x.spam && !x.trash) ?? found[0];
  return m ? { threadId: m.threadId, messageId: m.id } : null;
}

/** The ids links name, for the MCP: each conversation's (its newest message) and each message's; one without is left out. */
export async function linksOf(store: Pick<MailStore, "links" | "drafts">, p: { threadIds: readonly number[]; messageIds: readonly number[] }): Promise<{ threads: Record<number, string>; messages: Record<number, string> }> {
  const threads = Object.fromEntries(await store.links.newest(p.threadIds));
  const messages: Record<number, string> = {};
  for (const id of new Set(p.messageIds)) {
    const ref = await store.drafts.messageRef(id);
    if (ref) messages[id] = ref;
  }
  return { threads, messages };
}
