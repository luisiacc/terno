import type { AttachmentInfo, MessageDetail, ThreadDetail } from "@terno/core";
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
  messageTooLarge: "This message is too large for Terno to keep on this Mac (over 75 MB), so its files stay on the mail server. The user can open it from their mail provider.",
  // i18n-ignore: for the agent
  notKept: "Terno didn't keep a copy of this file on this Mac: it's past Terno's limits for attachments (18 MB of files in one message, 100 files, or 256 MB for the account). The user can open it from their mail provider.",
  // i18n-ignore: for the agent
  pending: "Terno hasn't downloaded this file yet. It will after the account's next sync: try again then.",
  // i18n-ignore: for the agent
  busy: "Terno is busy reading files for agents. Try again in a moment.",
} as const;

export type AgentPlace = AgentAttachment["place"];

/** Where a message lives for an agent: a conversation outside Spam can hold a message in it. */
export function agentPlaceOf(thread: ThreadDetail["thread"], message: Pick<MessageDetail, "isSpam" | "isTrash">): AgentPlace {
  if (thread.inTrash || message.isTrash) return "trash";
  if (thread.inSpam || message.isSpam) return "spam";
  return thread.inInbox ? "inbox" : "archive";
}

/** What get_thread shows as a file's id: the asset (immutable bytes) once kept, else its row while it isn't yet. */
export function agentAttachmentId(a: Pick<AttachmentInfo, "id" | "assetId">): string {
  return a.assetId ?? `row-${a.id}`;
}

/** The parts of a just-captured message that are the part an agent named by its row before (row ids are reused). */
function sameFile(before: AttachmentInfo, after: readonly AttachmentInfo[]): AttachmentInfo | undefined {
  const like = after.filter((a) => a.filename === before.filename && a.mime === before.mime && (a.contentId ?? null) === (before.contentId ?? null));
  if (like.length === 1) return like[0];
  const sized = like.filter((a) => a.size === before.size);
  return sized.length === 1 ? sized[0] : undefined;
}

export async function locateForAgent(
  b: Pick<BackendCore, "store" | "hydrateBody">,
  p: { threadId: number; messageId: number; attachmentId: string; includeSpamTrash: boolean },
  hydrate: (work: () => Promise<unknown>) => Promise<unknown>,
): Promise<AgentAttachment> {
  const read = async () => {
    // the message's state and files only: no body of the conversation is read
    const detail = await b.store.threads.get(p.threadId, { bodyFormat: "parts" });
    const message = detail?.messages.find((m) => m.id === p.messageId);
    if (!detail || !message) throw new RpcError("NOT_FOUND", AGENT_ATTACHMENT.stale);
    // checked on every read: a conversation can move into Spam after it was listed (Codex critique #2)
    const place = agentPlaceOf(detail.thread, message);
    if ((place === "spam" || place === "trash") && !p.includeSpamTrash) throw new RpcError("FORBIDDEN", AGENT_ATTACHMENT.spam);
    return { message, place };
  };
  let { message, place } = await read();
  const row = /^row-(\d+)$/.exec(p.attachmentId);
  let part = row ? message.attachments.find((a) => a.id === Number(row[1])) : message.attachments.find((a) => a.assetId === p.attachmentId);
  // a row id names a file not kept yet; one kept since was captured again (its row may now be another file's)
  if (!part || (row && part.assetId)) throw new RpcError("NOT_FOUND", AGENT_ATTACHMENT.stale);
  if (!part.assetId) {
    if (message.bodyUnavailable) throw new RpcError("BAD_REQUEST", AGENT_ATTACHMENT.messageTooLarge);
    if (message.attachmentState === "unavailable") throw new RpcError("BAD_REQUEST", AGENT_ATTACHMENT.notKept);
    // the one fetch opening the message in Terno makes, from the user's own mail server; never a retry loop
    if (message.bodyState !== "full") {
      await hydrate(() => b.hydrateBody(p.threadId, p.messageId));
      ({ message, place } = await read());
      const again = sameFile(part, message.attachments);
      if (!again && message.attachmentState === "complete") throw new RpcError("NOT_FOUND", AGENT_ATTACHMENT.stale);
      if (again) part = again;
    }
    if (!part.assetId) {
      if (message.bodyUnavailable) throw new RpcError("BAD_REQUEST", AGENT_ATTACHMENT.messageTooLarge);
      throw new RpcError(message.attachmentState === "unavailable" ? "BAD_REQUEST" : "UNAVAILABLE", message.attachmentState === "unavailable" ? AGENT_ATTACHMENT.notKept : AGENT_ATTACHMENT.pending);
    }
  }
  return { accountId: message.accountId, assetId: part.assetId, filename: part.filename, mime: part.mime, size: part.size, place };
}
