import type { MessageDetail, ThreadDetail } from "@terno/core";
import { RpcError, type AgentAttachment } from "@terno/core/rpc";
import type { BackendCore } from "./core";

/**
 * Plan 185: which kept file an agent asked for. Messages here are for the agent, which tells the user: English,
 * like plan 183's refusals.
 */
export const AGENT_ATTACHMENT = {
  // i18n-ignore: for the agent
  spam: "This conversation or message is in Spam or Trash. Read it only if the user asked about Spam or Trash: then call again with includeSpamTrash: true.",
  // i18n-ignore: for the agent
  stale: "That file isn't on that message anymore. Read the conversation again with get_thread: its files may have been downloaded again since.",
  // i18n-ignore: for the agent
  busy: "Terno is busy reading files for agents. Try again in a moment.",
} as const;

export type AgentPlace = AgentAttachment["place"];

/** A copy for an agent that was cut off (agents turned off, the token changed) before it was written. */
export class AgentFileCancelled extends Error {}

/** Where a message lives for an agent: a conversation outside Spam can hold a message in it. */
export function agentPlaceOf(thread: ThreadDetail["thread"], message: Pick<MessageDetail, "isSpam" | "isTrash">): AgentPlace {
  if (thread.inTrash || message.isTrash) return "trash";
  if (thread.inSpam || message.isSpam) return "spam";
  return thread.inInbox ? "inbox" : "archive";
}

/**
 * Which kept file an agent asked for, by its asset (immutable: a recaptured message's rows are reused, its assets
 * never). A message not downloaded yet has no file rows at all (ingest.ts): its files come with the account's
 * background sync, so there is nothing here to fetch.
 */
export async function locateForAgent(
  b: Pick<BackendCore, "store">,
  p: { threadId: number; messageId: number; attachmentId: string; includeSpamTrash: boolean },
): Promise<AgentAttachment> {
  // the message's state and files only: no body of the conversation is read
  const detail = await b.store.threads.get(p.threadId, { bodyFormat: "parts" });
  const message = detail?.messages.find((m) => m.id === p.messageId);
  if (!detail || !message) throw new RpcError("NOT_FOUND", AGENT_ATTACHMENT.stale);
  // checked on every read: a conversation can move into Spam after it was listed (Codex critique #2)
  const place = agentPlaceOf(detail.thread, message);
  if ((place === "spam" || place === "trash") && !p.includeSpamTrash) throw new RpcError("FORBIDDEN", AGENT_ATTACHMENT.spam);
  const part = message.attachments.find((a) => a.assetId === p.attachmentId);
  if (!part?.assetId) throw new RpcError("NOT_FOUND", AGENT_ATTACHMENT.stale);
  return { accountId: message.accountId, assetId: part.assetId, filename: part.filename, mime: part.mime, size: part.size, place };
}

