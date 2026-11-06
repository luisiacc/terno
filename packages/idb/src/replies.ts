import { type PreparedReply, type ReplyState } from "@terno/core";
import { replyBodyOf, replyEvictions, summaryBlocked, type ReplyFinish, type ReplyWrite } from "@terno/store";
import { summarySources } from "./ai-summaries";
import { T, type Ctx, type R } from "./mail";

/** Plan 144 on IndexedDB: see packages/store/src/replies.ts. */

const rowOf = (r: R): PreparedReply => ({
  threadId: r.thread_id,
  sourceStamp: r.source_stamp,
  generationKey: r.generation_key,
  answeringMessageId: r.answering_message_id,
  state: r.state,
  body: r.body ?? null,
  used: r.used_json ? JSON.parse(r.used_json) : null,
  checks: r.checks_json ? JSON.parse(r.checks_json) : null,
  to: JSON.parse(r.to_json),
  cc: JSON.parse(r.cc_json),
  model: r.model ?? null,
  provider: r.provider ?? null,
  promptVersion: r.prompt_version ?? null,
  generatedAt: r.generated_at,
  revision: r.revision,
});

export function getReply(c: Ctx, threadId: number): PreparedReply | null {
  const r = T(c, "ai_prepared_replies").get(threadId);
  return r ? rowOf(r) : null;
}

export function finishReply(c: Ctx, w: ReplyWrite): ReplyFinish {
  const sources = summarySources(c, w.threadId);
  if (!sources) return "gone";
  if (summaryBlocked(sources) || sources.stamp !== w.sourceStamp) return "moved";
  const table = T(c, "ai_prepared_replies");
  const prior = table.get(w.threadId);
  if (prior) table.delete(w.threadId);
  table.insert({ thread_id: w.threadId, source_stamp: w.sourceStamp, generation_key: w.generationKey, answering_message_id: w.answeringMessageId, state: w.state, body: replyBodyOf(w.body), used_json: w.used ? JSON.stringify(w.used) : null, checks_json: w.checks ? JSON.stringify(w.checks) : null, to_json: JSON.stringify(w.to), cc_json: JSON.stringify(w.cc), model: w.model, provider: w.provider, prompt_version: w.promptVersion, generated_at: w.generatedAt, revision: (prior?.revision ?? -1) + 1 });
  const { drop, forgetBody } = replyEvictions([...table.all()].map((r) => ({ threadId: r.thread_id, state: r.state, hasBody: r.body !== null && r.body !== undefined, generatedAt: r.generated_at })));
  for (const id of drop) table.delete(id);
  for (const id of forgetBody) {
    const r = table.get(id);
    if (r) table.update(r, { body: null });
  }
  return "written";
}

export function transitionReply(c: Ctx, threadId: number, from: { state: ReplyState; revision: number }, to: ReplyState): PreparedReply | null {
  const table = T(c, "ai_prepared_replies");
  const r = table.get(threadId);
  if (!r || r.state !== from.state || r.revision !== from.revision) return null;
  table.update(r, { state: to, revision: r.revision + 1 });
  return getReply(c, threadId);
}

export function clearReplies(c: Ctx): void {
  const table = T(c, "ai_prepared_replies");
  for (const r of table.all()) table.delete(r.thread_id);
}
