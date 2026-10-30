import type { ReplyContext } from "@terno/core/rpc";

/** A reply prefix alone does not change the intended conversation. */
export function replySubject(subject: string): string {
  return subject.trim().replace(/^(?:re:\s*)+/i, "").trim();
}

export function detachedReply(subject: string, context: ReplyContext): boolean {
  return replySubject(subject) !== replySubject(context.subject);
}
