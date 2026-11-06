import { REPLY_BODIES_MAX, REPLY_BODY_MAX, REPLY_DECISIONS_MAX, type PreparedReply, type ReplyState } from "@terno/core";

/**
 * Plan 144's table, the part both stores share (`packages/db/src/replies.ts`, `packages/idb/src/replies.ts`): a cached
 * suggestion, never a draft. Not in drafts, counts, export, search or MCP.
 */
export interface ReplyWrite extends Omit<PreparedReply, "revision"> {
  /** the row it read at the start, if any: a Dismiss or anything else since wins */
  expect: { rowId: string; revision: number } | null;
  /** `replies.clearGeneration()` before it read anything: a clear since refuses the write */
  clearGeneration: number;
}

export type ReplyFinish = "written" | "gone" | "moved" | "cleared";

export interface ReplyStore {
  get(threadId: number): Promise<PreparedReply | null>;
  /** in one command: the thread is still as it was read, and not in Spam or Trash; then the bounds */
  finish(row: ReplyWrite): Promise<ReplyFinish>;
  /** only from this state and revision. The new row, or null when it was refused */
  transition(threadId: number, from: { rowId: string; state: ReplyState; revision: number }, to: ReplyState): Promise<PreparedReply | null>;
  clear(): Promise<void>;
  clearGeneration(): number;
}

export const replyBodyOf = (body: string | null): string | null => (body === null ? null : body.slice(0, REPLY_BODY_MAX));

/** What the bounds take: words beyond the newest 200, keeping a decision without them; decisions beyond 5,000. */
export function replyEvictions(rows: readonly { threadId: number; state: ReplyState; hasBody: boolean; generatedAt: number }[]): { drop: number[]; forgetBody: number[] } {
  const newest = [...rows].sort((a, b) => b.generatedAt - a.generatedAt || b.threadId - a.threadId);
  const drop: number[] = [];
  const forgetBody: number[] = [];
  let bodies = 0;
  let decisions = 0;
  for (const r of newest) {
    if (r.hasBody && ++bodies > REPLY_BODIES_MAX) {
      // nothing was decided about a ready one: without its words it's simply gone
      if (r.state === "ready") {
        drop.push(r.threadId);
        continue;
      }
      forgetBody.push(r.threadId);
      if (++decisions > REPLY_DECISIONS_MAX) drop.push(r.threadId);
      continue;
    }
    if (!r.hasBody && ++decisions > REPLY_DECISIONS_MAX) drop.push(r.threadId);
  }
  return { drop, forgetBody };
}
