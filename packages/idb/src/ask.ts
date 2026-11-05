import { ASK_CONVERSATIONS_MAX, ASK_TURNS_MAX } from "@terno/core";
import { boundedTurn, turnOfRow, type AskConversationCopy, type AskHeader, type AskTurnRow, type AskTurnWrite } from "@terno/store";
import { T, type Ctx, type R } from "./mail";

/** Plan 141 on IndexedDB, like SQL's (packages/db/src/ask.ts). */

const live = (m: R) => !m.is_spam && !m.is_trash && !m.is_draft;

/** The messages to check in these threads, newest first, never Spam or Trash, nor drafts. */
export function askCandidates(c: Ctx, threadIds: readonly number[]): R[] {
  const messages = T(c, "messages");
  return threadIds.flatMap((id) => messages.by("fk_thread_id", id).filter(live)).sort((a, b) => b.date - a.date || b.id - a.id);
}

export function askNewest(c: Ctx, threadIds: readonly number[]): Map<number, number> {
  const messages = T(c, "messages");
  const out = new Map<number, number>();
  for (const threadId of threadIds) {
    let best: R | null = null;
    for (const m of messages.by("fk_thread_id", threadId)) if (live(m) && (!best || m.date > best.date || (m.date === best.date && m.id > best.id))) best = m;
    if (best) out.set(threadId, best.id);
  }
  return out;
}

export function askHeaders(c: Ctx, ids: readonly number[]): Map<number, AskHeader> {
  if (!ids.length) return new Map();
  const own = new Set<string>();
  for (const a of T(c, "accounts").all()) own.add(String(a.email).toLowerCase());
  for (const k of T(c, "correspondents").keysBy("own", 1)) own.add(String(k).toLowerCase());
  const messages = T(c, "messages");
  const out = new Map<number, AskHeader>();
  for (const id of ids) {
    const m = messages.get(id);
    if (!m) continue;
    out.set(id, { id: m.id, threadId: m.thread_id, accountId: m.account_id, fromName: m.from_name, fromEmail: m.from_email, subject: m.subject, snippet: m.snippet, date: m.date, own: !!m.is_sent || own.has(String(m.from_email).toLowerCase()), spam: !!m.is_spam, trash: !!m.is_trash, draft: !!m.is_draft, bodyState: m.body_state, bodyUnavailable: m.attachments_captured === 2 && m.body_state !== "full" });
  }
  return out;
}

const recent = (a: R, b: R) => b.updated_at - a.updated_at || b.id - a.id;

function bound(c: Ctx): void {
  const conversations = T(c, "ai_conversations");
  const all = [...conversations.all()].sort(recent);
  for (const r of all.slice(ASK_CONVERSATIONS_MAX)) conversations.deleteRow(r);
}

export function addAskTurn(c: Ctx, w: AskTurnWrite): { conversationId: number; turnId: number } | null {
  const conversations = T(c, "ai_conversations");
  const turns = T(c, "ai_turns");
  const b = boundedTurn(w);
  let conversationId = w.conversationId;
  if (conversationId !== null) {
    const held = conversations.get(conversationId);
    // deleted while it answered: the answer doesn't bring it back
    if (!held || turns.count("fk_conversation_id", conversationId) >= ASK_TURNS_MAX) return null;
    conversations.update(held, { updated_at: w.now });
  } else {
    conversationId = conversations.put({ title: b.title, created_at: w.now, updated_at: w.now }).id as number;
  }
  const turn = turns.put({ conversation_id: conversationId, kind: w.kind, question: b.question, answer: b.answer, status: w.status, sources_json: b.sourcesJson, queries_json: b.queriesJson, checks_json: b.checksJson, account_ids_json: b.accountIdsJson, model: w.model, provider: w.provider, prompt_version: w.promptVersion, created_at: w.now });
  bound(c);
  return { conversationId, turnId: turn.id as number };
}

export function listAskConversations(c: Ctx) {
  const turns = T(c, "ai_turns");
  return [...T(c, "ai_conversations").all()].sort(recent).slice(0, ASK_CONVERSATIONS_MAX).map((r) => ({ id: r.id as number, title: r.title as string, createdAt: r.created_at as number, updatedAt: r.updated_at as number, followUps: Math.max(0, turns.count("fk_conversation_id", r.id) - 1) }));
}

const rowsOf = (c: Ctx, conversationId: number): AskTurnRow[] => (T(c, "ai_turns").by("fk_conversation_id", conversationId) as unknown as AskTurnRow[]).sort((a, b) => a.id - b.id);

export const askTurns = (c: Ctx, conversationId: number) => rowsOf(c, conversationId).map(turnOfRow);

export function askTurnCount(c: Ctx, conversationId: number): number | null {
  return T(c, "ai_conversations").get(conversationId) ? T(c, "ai_turns").count("fk_conversation_id", conversationId) : null;
}

const accountsOfRow = (r: AskTurnRow): number[] => {
  try {
    return JSON.parse(r.account_ids_json ?? "[]") as number[];
  } catch {
    return [];
  }
};

export function askAccountsOf(c: Ctx, conversationId: number): number[] {
  return [...new Set(rowsOf(c, conversationId).flatMap(accountsOfRow))];
}

export function removeAskConversation(c: Ctx, conversationId: number): AskConversationCopy | null {
  const conversations = T(c, "ai_conversations");
  const row = conversations.get(conversationId);
  if (!row) return null;
  const rows = rowsOf(c, conversationId).map((r) => ({ ...r }));
  conversations.delete(conversationId);
  return { summary: { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, followUps: Math.max(0, rows.length - 1) }, rows };
}

export function restoreAskConversation(c: Ctx, copy: AskConversationCopy): void {
  const { summary: s, rows } = copy;
  T(c, "ai_conversations").put({ id: s.id, title: s.title, created_at: s.createdAt, updated_at: s.updatedAt });
  const turns = T(c, "ai_turns");
  for (const r of rows) turns.put({ ...r } as unknown as R);
  bound(c);
}

export function removeAskForAccount(c: Ctx, accountId: number): number {
  const conversations = T(c, "ai_conversations");
  const gone = new Set<number>();
  for (const r of T(c, "ai_turns").all()) if (accountsOfRow(r as unknown as AskTurnRow).includes(accountId)) gone.add(r.conversation_id);
  for (const id of gone) conversations.delete(id);
  return gone.size;
}

export function clearAsk(c: Ctx): void {
  const conversations = T(c, "ai_conversations");
  for (const r of conversations.all()) conversations.deleteRow(r);
}
