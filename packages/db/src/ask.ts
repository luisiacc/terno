import { ASK_CONVERSATIONS_MAX, ASK_TURNS_MAX, searchTerms, type ResolvedSearch } from "@terno/core";
import { ASK_MATCH_MESSAGES, ASK_MATCH_PARTS, bodyTestKey, boundedTurn, turnOfRow, type AskConversationCopy, type AskHeader, type AskTurnRow, type AskTurnWrite } from "@terno/store";
import { bodyReadReference, prepareBodyMatches, sqlBodyParts, withBodyMatches } from "./body-parts";
import { searchMessagesIn } from "./search";
import type { Db } from "./sqlite";

/** Plan 141 on SQLite (v51): see packages/store/src/ask.ts. */

const LIVE = "m.is_spam = 0 AND m.is_trash = 0 AND m.is_draft = 0";
const CAPTURE_SLICE = 16;

export async function askMatching(db: Db, query: ResolvedSearch, threadIds: readonly number[], yieldTo: () => Promise<void>, signal?: { readonly aborted: boolean }): Promise<{ ids: { id: number; threadId: number }[]; incomplete: boolean }> {
  const threads = JSON.stringify(threadIds);
  const tests = searchTerms(query.query).filter((t) => t.field === "text").map((t) => ({ op: "contains" as const, value: t.value, prefix: t.prefix }));
  const captured = new Map<string, number[]>();
  let incomplete = false;
  // only a body too long to index needs reading, and only as far as the work's limit: newest first
  if (tests.length && db.get("SELECT 1 FROM body_heads LIMIT 1")) {
    const rows = db.all<{ capture_id: string; message_id: number; token_parts: number }>(
      `SELECT b.capture_id, b.message_id, c.token_parts FROM messages m INDEXED BY messages_thread JOIN body_heads b ON b.message_id = m.id JOIN body_captures c ON c.id = b.capture_id
       WHERE m.thread_id IN (SELECT value FROM json_each(?)) AND ${LIVE} AND c.ready = 1 ORDER BY m.date DESC, m.id DESC LIMIT ?`,
      threads,
      ASK_MATCH_MESSAGES,
    );
    let parts = 0;
    const reading = rows.filter((r) => {
      parts += r.token_parts;
      if (parts > ASK_MATCH_PARTS) incomplete = true;
      return parts <= ASK_MATCH_PARTS;
    });
    for (let at = 0; at < reading.length; at += CAPTURE_SLICE) {
      if (signal?.aborted) return { ids: [], incomplete: true };
      const slice = reading.slice(at, at + CAPTURE_SLICE);
      const ofCapture = new Map(slice.map((r) => [r.capture_id, r.message_id]));
      try {
        const matches = await prepareBodyMatches(db, tests, yieldTo, [...ofCapture.keys()], "selected");
        withBodyMatches(db, matches, () => {
          for (const t of tests) {
            const key = bodyTestKey("contains", t.value, t.prefix);
            const held = captured.get(key) ?? [];
            for (const r of db.all<{ id: string }>("SELECT value AS id FROM json_each(?) WHERE terno_part_match(value,'contains',?,?)", JSON.stringify([...ofCapture.keys()]), t.value, t.prefix ? 1 : 0)) held.push(ofCapture.get(r.id)!);
            captured.set(key, held);
          }
        });
      } catch {
        // mail changing under a read: what wasn't read isn't claimed, and the question isn't lost for it
        incomplete = true;
      }
      await yieldTo();
    }
  }
  const ids = searchMessagesIn(db, query, threads, captured, ASK_MATCH_MESSAGES);
  if (ids.length >= ASK_MATCH_MESSAGES) incomplete = true;
  return { ids, incomplete };
}

export function askNewest(db: Db, threadIds: readonly number[]): Map<number, number> {
  const rows = db.all<{ thread_id: number; id: number | null }>(
    `SELECT t.value AS thread_id, (SELECT m.id FROM messages m INDEXED BY messages_thread WHERE m.thread_id = t.value AND ${LIVE} ORDER BY m.date DESC, m.id DESC LIMIT 1) AS id FROM json_each(?) t`,
    JSON.stringify(threadIds),
  );
  return new Map(rows.flatMap((r) => (r.id === null ? [] : [[r.thread_id, r.id] as const])));
}

export function askHeaders(db: Db, ids: readonly number[]): Map<number, AskHeader> {
  if (!ids.length) return new Map();
  const own = new Set(db.all<{ email: string }>("SELECT lower(email) AS email FROM accounts UNION SELECT email FROM correspondents WHERE own = 1").map((r) => r.email));
  const rows = db.all<{ id: number; thread_id: number; account_id: number; from_name: string; from_email: string; subject: string; snippet: string; date: number; is_sent: number; is_spam: number; is_trash: number; is_draft: number; body_state: AskHeader["bodyState"]; attachments_captured: number }>(
    "SELECT id, thread_id, account_id, from_name, from_email, subject, snippet, date, is_sent, is_spam, is_trash, is_draft, body_state, attachments_captured FROM messages WHERE id IN (SELECT value FROM json_each(?))",
    JSON.stringify(ids),
  );
  return new Map(rows.map((r) => [r.id, { id: r.id, threadId: r.thread_id, accountId: r.account_id, fromName: r.from_name, fromEmail: r.from_email, subject: r.subject, snippet: r.snippet, date: r.date, own: r.is_sent === 1 || own.has(r.from_email.toLowerCase()), spam: r.is_spam === 1, trash: r.is_trash === 1, draft: r.is_draft === 1, bodyState: r.body_state, bodyUnavailable: r.attachments_captured === 2 && r.body_state !== "full" }]));
}

export function askText(db: Db, messageId: number, yieldTo: () => Promise<void>) {
  const reference = bodyReadReference(db, messageId);
  if (!reference) return db.get<{ text: string | null }>("SELECT body_text AS text FROM message_bodies WHERE message_id = ?", messageId)?.text ?? null;
  return reference.textParts === null ? null : sqlBodyParts(db, reference.version, 0, yieldTo);
}

export function addAskTurn(db: Db, w: AskTurnWrite): { conversationId: number; turnId: number } | null {
  return db.tx(() => {
    const b = boundedTurn(w);
    let conversationId = w.conversationId;
    if (conversationId !== null) {
      const held = db.get<{ n: number }>("SELECT (SELECT COUNT(*) FROM ai_turns WHERE conversation_id = c.id) AS n FROM ai_conversations c WHERE c.id = ?", conversationId);
      // deleted while it answered: the answer doesn't bring it back
      if (!held || held.n >= ASK_TURNS_MAX) return null;
      db.run("UPDATE ai_conversations SET updated_at = ? WHERE id = ?", w.now, conversationId);
    } else {
      conversationId = Number(db.run("INSERT INTO ai_conversations (title, created_at, updated_at) VALUES (?, ?, ?)", b.title, w.now, w.now).lastInsertRowid);
    }
    const turnId = Number(db.run(
      "INSERT INTO ai_turns (conversation_id, kind, question, answer, status, sources_json, queries_json, checks_json, account_ids_json, model, provider, prompt_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      conversationId, w.kind, b.question, b.answer, w.status, b.sourcesJson, b.queriesJson, b.checksJson, b.accountIdsJson, w.model, w.provider, w.promptVersion, w.now,
    ).lastInsertRowid);
    // "we keep the last 100, delete older", with the insert
    db.run("DELETE FROM ai_conversations WHERE id IN (SELECT id FROM ai_conversations ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?)", ASK_CONVERSATIONS_MAX);
    return { conversationId, turnId };
  });
}

export const listAskConversations = (db: Db) =>
  db.all<{ id: number; title: string; created_at: number; updated_at: number; n: number }>("SELECT c.id, c.title, c.created_at, c.updated_at, (SELECT COUNT(*) FROM ai_turns t WHERE t.conversation_id = c.id) AS n FROM ai_conversations c ORDER BY c.updated_at DESC, c.id DESC LIMIT ?", ASK_CONVERSATIONS_MAX)
    .map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, followUps: Math.max(0, r.n - 1) }));

const turnRows = (db: Db, conversationId: number) => db.all<AskTurnRow & { prompt_version: number | null }>("SELECT * FROM ai_turns WHERE conversation_id = ? ORDER BY id", conversationId);

export const askTurns = (db: Db, conversationId: number) => turnRows(db, conversationId).map(turnOfRow);

export function askTurnCount(db: Db, conversationId: number): number | null {
  return db.get<{ n: number }>("SELECT (SELECT COUNT(*) FROM ai_turns WHERE conversation_id = c.id) AS n FROM ai_conversations c WHERE c.id = ?", conversationId)?.n ?? null;
}

export function askAccountsOf(db: Db, conversationId: number): number[] {
  return db.all<{ id: number }>("SELECT DISTINCT j.value AS id FROM ai_turns t, json_each(t.account_ids_json) j WHERE t.conversation_id = ?", conversationId).map((r) => r.id);
}

export function removeAskConversation(db: Db, conversationId: number): AskConversationCopy | null {
  return db.tx(() => {
    const c = db.get<{ id: number; title: string; created_at: number; updated_at: number }>("SELECT id, title, created_at, updated_at FROM ai_conversations WHERE id = ?", conversationId);
    if (!c) return null;
    const rows = turnRows(db, conversationId);
    db.run("DELETE FROM ai_conversations WHERE id = ?", conversationId);
    return { summary: { id: c.id, title: c.title, createdAt: c.created_at, updatedAt: c.updated_at, followUps: Math.max(0, rows.length - 1) }, rows };
  });
}

export function restoreAskConversation(db: Db, copy: AskConversationCopy): void {
  db.tx(() => {
    const { summary: s, rows } = copy;
    db.run("INSERT OR REPLACE INTO ai_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", s.id, s.title, s.createdAt, s.updatedAt);
    for (const r of rows) {
      db.run(
        "INSERT OR REPLACE INTO ai_turns (id, conversation_id, kind, question, answer, status, sources_json, queries_json, checks_json, account_ids_json, model, provider, prompt_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        r.id, r.conversation_id, r.kind, r.question, r.answer, r.status, r.sources_json, r.queries_json, r.checks_json ?? null, r.account_ids_json ?? "[]", r.model, r.provider, (r as { prompt_version?: number | null }).prompt_version ?? null, r.created_at,
      );
    }
    db.run("DELETE FROM ai_conversations WHERE id IN (SELECT id FROM ai_conversations ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?)", ASK_CONVERSATIONS_MAX);
  });
}

export function removeAskForAccount(db: Db, accountId: number): number {
  return Number(db.run("DELETE FROM ai_conversations WHERE id IN (SELECT t.conversation_id FROM ai_turns t, json_each(t.account_ids_json) j WHERE j.value = ?)", accountId).changes);
}

export function clearAsk(db: Db): void {
  db.run("DELETE FROM ai_conversations");
}
