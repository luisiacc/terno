import { type PreparedReply, type ReplyState } from "@terno/core";
import { replyBodyOf, replyEvictions, summaryBlocked, type ReplyFinish, type ReplyWrite } from "@terno/store";
import { summarySources } from "./ai-summaries";
import type { Db } from "./sqlite";

/** Plan 144 on SQLite (v53): see packages/store/src/replies.ts. */

interface Raw {
  thread_id: number;
  row_id: string;
  source_stamp: string;
  generation_key: string;
  answering_message_id: number;
  state: ReplyState;
  body: string | null;
  used_json: string | null;
  checks_json: string | null;
  to_json: string;
  cc_json: string;
  model: string | null;
  provider: string | null;
  prompt_version: number | null;
  generated_at: number;
  revision: number;
}

const rowOf = (r: Raw): PreparedReply => ({
  rowId: r.row_id,
  threadId: r.thread_id,
  sourceStamp: r.source_stamp,
  generationKey: r.generation_key,
  answeringMessageId: r.answering_message_id,
  state: r.state,
  body: r.body,
  used: r.used_json ? JSON.parse(r.used_json) : null,
  checks: r.checks_json ? JSON.parse(r.checks_json) : null,
  to: JSON.parse(r.to_json),
  cc: JSON.parse(r.cc_json),
  model: r.model,
  provider: r.provider,
  promptVersion: r.prompt_version,
  generatedAt: r.generated_at,
  revision: r.revision,
});

export function getReply(db: Db, threadId: number): PreparedReply | null {
  const r = db.get<Raw>("SELECT * FROM ai_prepared_replies WHERE thread_id = ?", threadId);
  return r ? rowOf(r) : null;
}

export function finishReply(db: Db, w: ReplyWrite): ReplyFinish {
  return db.tx(() => {
    const sources = summarySources(db, w.threadId);
    if (!sources) return "gone";
    if (summaryBlocked(sources) || sources.stamp !== w.sourceStamp) return "moved";
    const prior = db.get<{ row_id: string; revision: number }>("SELECT row_id, revision FROM ai_prepared_replies WHERE thread_id = ?", w.threadId);
    if ((prior?.row_id ?? null) !== (w.expect?.rowId ?? null) || (prior && prior.revision !== w.expect?.revision)) return "moved";
    db.run(
      `INSERT OR REPLACE INTO ai_prepared_replies (thread_id, row_id, source_stamp, generation_key, answering_message_id, state, body, used_json, checks_json, to_json, cc_json, model, provider, prompt_version, generated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      w.threadId, w.rowId, w.sourceStamp, w.generationKey, w.answeringMessageId, w.state, replyBodyOf(w.body), w.used ? JSON.stringify(w.used) : null, w.checks ? JSON.stringify(w.checks) : null, JSON.stringify(w.to), JSON.stringify(w.cc), w.model, w.provider, w.promptVersion, w.generatedAt,
    );
    const rows = db.all<{ thread_id: number; state: ReplyState; has_body: number; generated_at: number }>("SELECT thread_id, state, body IS NOT NULL AS has_body, generated_at FROM ai_prepared_replies");
    const { drop, forgetBody } = replyEvictions(rows.map((r) => ({ threadId: r.thread_id, state: r.state, hasBody: !!r.has_body, generatedAt: r.generated_at })));
    if (drop.length) db.run("DELETE FROM ai_prepared_replies WHERE thread_id IN (SELECT value FROM json_each(?))", JSON.stringify(drop));
    if (forgetBody.length) db.run("UPDATE ai_prepared_replies SET body = NULL WHERE thread_id IN (SELECT value FROM json_each(?))", JSON.stringify(forgetBody));
    return "written";
  });
}

export function transitionReply(db: Db, threadId: number, from: { rowId: string; state: ReplyState; revision: number }, to: ReplyState): PreparedReply | null {
  return db.tx(() => {
    const moved = db.run("UPDATE ai_prepared_replies SET state = ?, revision = revision + 1 WHERE thread_id = ? AND row_id = ? AND state = ? AND revision = ?", to, threadId, from.rowId, from.state, from.revision);
    return Number(moved.changes) ? getReply(db, threadId) : null;
  });
}

export function clearReplies(db: Db): void {
  db.run("DELETE FROM ai_prepared_replies");
}
