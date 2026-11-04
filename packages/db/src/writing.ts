import type { VoiceScope } from "@terno/core";
import { BULK_RECIPIENTS, CORPUS_PAGE_MAX, GENERATION_MARKERS_MAX, GENERATION_TEXT_MAX_STORE, GENERATIONS_MAX_BYTES, GENERATIONS_MAX_ROWS, PROFILE_MAX_BYTES, PROFILES_MAX_BYTES, PROFILES_MAX_ROWS, profileFits, rankSentRefs, recipientList, recipientsMatch, SENT_SIZE_MAX, SENT_TO_CANDIDATES, SENT_TO_PAGE, type CorpusCursor, type CorpusHeader, type GenerationCommit, type GenerationRow, type GenerationTransfer, type ProfileEdit, type ProfileJudgmentWrite, type ProfilesCommit, type SentRef, type SentToResult, type WritingProfileRow } from "@terno/store";
import { setSetting } from "./repos";
import type { Db } from "./sqlite";

/** Plan 133 on SQLite (v50): see packages/store/src/writing.ts. */

const LIVE = "m.is_sent = 1 AND m.is_draft = 0 AND m.is_spam = 0 AND m.is_trash = 0";
const NOT_MODEL = "NOT EXISTS (SELECT 1 FROM writing_generations g WHERE g.message_id = m.id AND g.final IS NULL)";
const USABLE = `${LIVE} AND m.body_state != 'none' AND m.size <= ${SENT_SIZE_MAX} AND ${NOT_MODEL}`;

interface HeaderRow {
  id: number;
  thread_id: number;
  account_id: number;
  date: number;
  subject: string;
  to_json: string;
  cc_json: string;
  in_reply_to: string | null;
  list_id: string | null;
}

const HEADER = "m.id, m.thread_id, m.account_id, m.date, m.subject, m.to_json, m.cc_json, m.in_reply_to, m.list_id";

export function corpusHeaders(db: Db, p: { accountId: number; before?: CorpusCursor; limit: number }): CorpusHeader[] {
  const params: (number | string)[] = [p.accountId];
  let from = "";
  if (p.before) {
    from = " AND m.date <= ? AND (m.date < ? OR m.id < ?)";
    params.push(p.before.date, p.before.date, p.before.id);
  }
  return db
    .all<HeaderRow>(`SELECT ${HEADER} FROM messages m WHERE m.account_id = ? AND ${USABLE}${from} ORDER BY m.date DESC, m.id DESC LIMIT ?`, ...params, Math.min(p.limit, CORPUS_PAGE_MAX))
    .map((r) => {
      const to = recipientList(r.to_json);
      const cc = recipientList(r.cc_json);
      return {
        id: r.id,
        threadId: r.thread_id,
        accountId: r.account_id,
        date: r.date,
        subject: r.subject,
        to: to.addresses,
        cc: cc.addresses,
        names: { ...cc.names, ...to.names },
        isReply: r.in_reply_to !== null,
        bulk: r.list_id !== null || to.tooLong || cc.tooLong || to.addresses.length + cc.addresses.length > BULK_RECIPIENTS,
      };
    });
}

export function corpusUsable(db: Db, ids: readonly number[]): number[] {
  if (!ids.length) return [];
  return db.all<{ id: number }>(`SELECT m.id FROM messages m WHERE m.id IN (SELECT value FROM json_each(?)) AND ${USABLE}`, JSON.stringify(ids)).map((r) => r.id);
}

/** Mail to one of these addresses exactly, as far as the bounded pages reach; `sawLong`: a list too long to read had the phrase. */
async function exactSent(db: Db, p: { addresses: readonly string[]; accountId?: number }, yieldTo: () => Promise<void>): Promise<{ refs: SentRef[]; capped: boolean; sawLong: boolean }> {
  const want = new Set(p.addresses.map((a) => a.toLowerCase()));
  if (!want.size) return { refs: [], capped: false, sawLong: false };
  const match = recipientsMatch([...want]);
  const account = p.accountId === undefined ? "" : " AND m.account_id = ?";
  const accountParams = p.accountId === undefined ? [] : [p.accountId];
  const refs: SentRef[] = [];
  let seen = 0;
  let before = Number.MAX_SAFE_INTEGER;
  let sawLong = false;
  for (;;) {
    if (!db.isOpen) throw new Error("The store is closed");
    const ids = db.all<{ id: number }>("SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ? AND rowid < ? ORDER BY rowid DESC LIMIT ?", match, before, SENT_TO_PAGE).map((r) => r.id);
    if (!ids.length) return { refs, capped: false, sawLong };
    seen += ids.length;
    before = ids[ids.length - 1]!;
    for (const r of db.all<HeaderRow>(`SELECT ${HEADER} FROM messages m WHERE m.id IN (SELECT value FROM json_each(?)) AND ${LIVE}${account}`, JSON.stringify(ids), ...accountParams)) {
      const to = recipientList(r.to_json);
      const cc = recipientList(r.cc_json);
      if (to.tooLong || cc.tooLong) sawLong = true;
      if (!to.addresses.some((a) => want.has(a)) && !cc.addresses.some((a) => want.has(a))) continue;
      refs.push({ id: r.id, threadId: r.thread_id, accountId: r.account_id, date: r.date, subject: r.subject, to: to.addresses, cc: cc.addresses, isReply: r.in_reply_to !== null });
    }
    if (ids.length < SENT_TO_PAGE) return { refs, capped: false, sawLong };
    if (seen >= SENT_TO_CANDIDATES) return { refs, capped: true, sawLong };
    await yieldTo();
  }
}

function usableBodies(db: Db, ids: readonly number[]): Set<number> {
  if (!ids.length) return new Set();
  return new Set(
    db
      .all<{ id: number }>(
        `SELECT m.id FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id LEFT JOIN body_heads h ON h.message_id = m.id LEFT JOIN body_captures c ON c.id = h.capture_id
         WHERE m.id IN (SELECT value FROM json_each(?)) AND ${USABLE} AND (length(b.body_text) > 0 OR c.text_parts IS NOT NULL)`,
        JSON.stringify(ids),
      )
      .map((r) => r.id),
  );
}

export async function sentTo(db: Db, p: { addresses: readonly string[]; accountId?: number; limit: number }, yieldTo: () => Promise<void>): Promise<SentToResult> {
  const { refs, capped, sawLong } = await exactSent(db, p, yieldTo);
  if (!refs.length) {
    // past the look-alikes' cap, or a list too long to read: correspondents knows if they were ever written to
    const known = (capped || sawLong) && db.get("SELECT 1 FROM correspondents WHERE email IN (SELECT value FROM json_each(?)) AND written = 1", JSON.stringify(p.addresses.map((a) => a.toLowerCase())));
    return { refs: [], state: known ? "unavailable" : "none" };
  }
  const usable = usableBodies(db, refs.map((r) => r.id));
  const kept = refs.filter((r) => usable.has(r.id));
  return kept.length ? { refs: rankSentRefs(kept, p.limit), state: "found" } : { refs: [], state: "unavailable" };
}

/** A sender with a great many messages: the newest by id are enough to find their conversations. */
const FROM_CANDIDATES = 2000;

export async function threadsWith(db: Db, p: { address: string; accountId?: number; exclude?: number; limit: number }, yieldTo: () => Promise<void>): Promise<number[]> {
  const address = p.address.toLowerCase();
  const { refs } = await exactSent(db, { addresses: [address], ...(p.accountId !== undefined ? { accountId: p.accountId } : {}) }, yieldTo);
  const latest = new Map<number, number>();
  const note = (threadId: number, date: number) => {
    if (threadId !== p.exclude && date > (latest.get(threadId) ?? -Infinity)) latest.set(threadId, date);
  };
  for (const r of refs) note(r.threadId, r.date);
  const account = p.accountId === undefined ? "" : " AND m.account_id = ?";
  for (const r of db.all<{ thread_id: number; date: number }>(`SELECT m.thread_id, m.date FROM messages m WHERE m.from_email = ? AND m.is_draft = 0 AND m.is_spam = 0 AND m.is_trash = 0${account} ORDER BY m.id DESC LIMIT ?`, address, ...(p.accountId === undefined ? [] : [p.accountId]), FROM_CANDIDATES)) note(r.thread_id, r.date);
  if (!latest.size) return [];
  const live = new Set(db.all<{ id: number }>("SELECT id FROM threads WHERE id IN (SELECT value FROM json_each(?)) AND in_spam = 0 AND in_trash = 0", JSON.stringify([...latest.keys()])).map((r) => r.id));
  return [...latest].filter(([id]) => live.has(id)).sort((a, b) => b[1] - a[1] || b[0] - a[0]).slice(0, p.limit).map(([id]) => id);
}

export function threadRecipients(db: Db, threadId: number): Map<number, { to: import("@terno/core").Address[]; cc: import("@terno/core").Address[] }> {
  const out = new Map<number, { to: import("@terno/core").Address[]; cc: import("@terno/core").Address[] }>();
  for (const r of db.all<{ id: number; to_json: string; cc_json: string }>("SELECT id, to_json, cc_json FROM messages WHERE thread_id = ?", threadId)) {
    const pick = (json: string) => {
      const list = recipientList(json);
      return list.addresses.map((email) => ({ name: list.names[email] ?? "", email }));
    };
    out.set(r.id, { to: pick(r.to_json), cc: pick(r.cc_json) });
  }
  return out;
}

// ─── profiles ──────────────────────────────────────────────────────────────

interface ProfileRaw {
  id: number;
  scope: VoiceScope;
  scope_key: string;
  language: string;
  account_id: number | null;
  habits_json: string;
  phrases_json: string;
  judgment_json: string | null;
  samples: number;
  new_since: number;
  sample_hash: string | null;
  edited: number;
  model: string | null;
  provider: string | null;
  prompt_version: number | null;
  updated_at: number;
}

const toProfile = (r: ProfileRaw): WritingProfileRow => ({
  id: r.id,
  scope: r.scope,
  scopeKey: r.scope_key,
  language: r.language,
  accountId: r.account_id,
  habitsJson: r.habits_json,
  phrasesJson: r.phrases_json,
  judgmentJson: r.judgment_json,
  samples: r.samples,
  newSince: r.new_since,
  sampleHash: r.sample_hash,
  edited: r.edited === 1,
  model: r.model,
  provider: r.provider,
  promptVersion: r.prompt_version,
  updatedAt: r.updated_at,
});

const PROFILE_SIZE = "length(habits_json) + length(phrases_json) + coalesce(length(judgment_json), 0)";

export function readProfiles(db: Db, keys: readonly { scopeKey: string; language: string }[]): WritingProfileRow[] {
  const out: WritingProfileRow[] = [];
  for (const k of keys) {
    const r = db.get<ProfileRaw>("SELECT * FROM writing_profiles WHERE scope_key = ? AND language = ?", k.scopeKey, k.language);
    if (r) out.push(toProfile(r));
  }
  return out;
}

export function listProfiles(db: Db, p: { scope?: VoiceScope; accountId?: number; after?: { scopeKey: string; language: string }; limit: number }): WritingProfileRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (p.scope) {
    where.push("scope = ?");
    params.push(p.scope);
  }
  if (p.accountId !== undefined) {
    where.push("account_id = ?");
    params.push(p.accountId);
  }
  if (p.after) {
    where.push("(scope_key > ? OR (scope_key = ? AND language > ?))");
    params.push(p.after.scopeKey, p.after.scopeKey, p.after.language);
  }
  return db.all<ProfileRaw>(`SELECT * FROM writing_profiles${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY scope_key, language LIMIT ?`, ...params, p.limit).map(toProfile);
}

function boundProfiles(db: Db): void {
  const total = db.get<{ n: number; bytes: number | null }>(`SELECT count(*) AS n, sum(${PROFILE_SIZE}) AS bytes FROM writing_profiles`)!;
  let rows = total.n;
  let bytes = total.bytes ?? 0;
  if (rows <= PROFILES_MAX_ROWS && bytes <= PROFILES_MAX_BYTES) return;
  // the rarest levels, oldest first; nothing the user edited, and never the general ones
  const gone: number[] = [];
  for (const r of db.all<{ id: number; size: number }>(`SELECT id, ${PROFILE_SIZE} AS size FROM writing_profiles WHERE edited = 0 AND scope IN ('person', 'domain') ORDER BY updated_at, id`)) {
    if (rows <= PROFILES_MAX_ROWS && bytes <= PROFILES_MAX_BYTES) break;
    gone.push(r.id);
    rows--;
    bytes -= r.size;
  }
  if (gone.length) db.run("DELETE FROM writing_profiles WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(gone));
}

export function commitProfiles(db: Db, c: ProfilesCommit): void {
  db.tx(() => {
    const named = new Set<string>((c.keep ?? []).map((k) => `${k.scopeKey}\n${k.language}`));
    for (const u of c.upserts) {
      if (!profileFits(u)) continue;
      named.add(`${u.scopeKey}\n${u.language}`);
      db.run(
        `INSERT INTO writing_profiles (scope, scope_key, language, account_id, habits_json, phrases_json, samples, new_since, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT (scope_key, language) DO UPDATE SET
           samples = excluded.samples,
           habits_json = CASE WHEN edited = 1 THEN habits_json ELSE excluded.habits_json END,
           phrases_json = CASE WHEN edited = 1 THEN phrases_json ELSE excluded.phrases_json END,
           updated_at = CASE WHEN edited = 1 THEN updated_at ELSE excluded.updated_at END`,
        u.scope,
        u.scopeKey,
        u.language,
        u.accountId,
        u.habitsJson,
        u.phrasesJson,
        u.samples,
        c.now,
      );
    }
    for (const i of c.incorporated ?? []) db.run("UPDATE writing_profiles SET new_since = new_since + ? WHERE scope_key = ? AND language = ?", i.count, i.scopeKey, i.language);
    const stale = (rows: { id: number; scope_key: string; language: string }[]) => rows.filter((r) => !named.has(`${r.scope_key}\n${r.language}`)).map((r) => r.id);
    const gone = [
      ...(c.replaceAccount !== undefined ? stale(db.all("SELECT id, scope_key, language FROM writing_profiles WHERE account_id = ? AND edited = 0", c.replaceAccount)) : []),
      ...(c.replaceYou ? stale(db.all("SELECT id, scope_key, language FROM writing_profiles WHERE scope = 'you' AND edited = 0")) : []),
    ];
    if (gone.length) db.run("DELETE FROM writing_profiles WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(gone));
    boundProfiles(db);
    for (const [key, value] of Object.entries(c.state)) setSetting(db, key, value);
  });
}

export function judgeProfile(db: Db, w: ProfileJudgmentWrite): boolean {
  const r = db.run(
    `UPDATE writing_profiles SET judgment_json = ?, sample_hash = ?, model = ?, provider = ?, prompt_version = ?, new_since = 0, updated_at = ? WHERE scope_key = ? AND language = ? AND edited = 0 AND length(habits_json) + length(phrases_json) + length(?) <= ${PROFILE_MAX_BYTES}`,
    w.judgmentJson,
    w.sampleHash,
    w.model,
    w.provider,
    w.promptVersion,
    w.now,
    w.scopeKey,
    w.language,
    w.judgmentJson,
  );
  return r.changes > 0;
}

export function editProfile(db: Db, e: ProfileEdit): boolean {
  return db.tx(() => {
    const row = db.get<ProfileRaw>("SELECT * FROM writing_profiles WHERE scope_key = ? AND language = ?", e.scopeKey, e.language);
    if (!row) return false;
    const next = {
      habitsJson: e.habitsJson ?? row.habits_json,
      phrasesJson: e.phrasesJson ?? row.phrases_json,
      judgmentJson: e.judgmentJson === undefined ? row.judgment_json : e.judgmentJson,
    };
    if (!profileFits(next)) return false;
    db.run("UPDATE writing_profiles SET habits_json = ?, phrases_json = ?, judgment_json = ?, edited = 1, new_since = 0, updated_at = ? WHERE id = ?", next.habitsJson, next.phrasesJson, next.judgmentJson, e.now, row.id);
    return true;
  });
}

export function resetProfile(db: Db, scopeKey: string, language?: string): void {
  if (language === undefined) db.run("DELETE FROM writing_profiles WHERE scope_key = ?", scopeKey);
  else db.run("DELETE FROM writing_profiles WHERE scope_key = ? AND language = ?", scopeKey, language);
}

export function clearJudgments(db: Db, accountId?: number): void {
  const where = accountId === undefined ? "" : " AND account_id = ?";
  db.run(`UPDATE writing_profiles SET judgment_json = NULL, sample_hash = NULL, model = NULL, provider = NULL, prompt_version = NULL WHERE judgment_json IS NOT NULL AND edited = 0${where}`, ...(accountId === undefined ? [] : [accountId]));
}

export function clearWriting(db: Db, stateKeys: readonly string[]): void {
  db.tx(() => {
    db.run("DELETE FROM writing_profiles");
    db.run("DELETE FROM writing_generations");
    for (const key of stateKeys) db.run("DELETE FROM settings WHERE key = ?", key);
  });
}

// ─── provenance ────────────────────────────────────────────────────────────

interface GenerationRaw {
  id: number;
  account_id: number;
  draft_id: number | null;
  draft_generation: string | null;
  message_id: number | null;
  op_id: string | null;
  address: string;
  generated: string;
  final: string | null;
  at: number;
}

const toGeneration = (r: GenerationRaw): GenerationRow => ({ id: r.id, accountId: r.account_id, draftId: r.draft_id, draftGeneration: r.draft_generation, messageId: r.message_id, opId: r.op_id, address: r.address, generated: r.generated, final: r.final, at: r.at });

/**
 * Newest text rows stay. Past the bound an unchanged send keeps a marker (no text), so its message stays out of the
 * corpus; a pair goes, and so does a draft's row: that draft then reads as the user's own.
 */
function boundGenerations(db: Db): void {
  let rows = 0;
  let bytes = 0;
  const gone: number[] = [];
  const faded: number[] = [];
  for (const r of db.all<{ id: number; message_id: number | null; final: string | null; size: number }>("SELECT id, message_id, final, length(generated) + coalesce(length(final), 0) AS size FROM writing_generations WHERE generated <> '' ORDER BY at DESC, id DESC")) {
    rows++;
    bytes += r.size;
    if (rows <= GENERATIONS_MAX_ROWS && bytes <= GENERATIONS_MAX_BYTES) continue;
    if (r.message_id !== null && r.final === null) faded.push(r.id);
    else gone.push(r.id);
  }
  if (gone.length) db.run("DELETE FROM writing_generations WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(gone));
  if (!faded.length) return;
  db.run("UPDATE writing_generations SET generated = '', address = '' WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(faded));
  const markers = db.get<{ n: number }>("SELECT count(*) AS n FROM writing_generations WHERE generated = ''")!.n;
  if (markers > GENERATION_MARKERS_MAX) db.run("DELETE FROM writing_generations WHERE id IN (SELECT id FROM writing_generations WHERE generated = '' ORDER BY at, id LIMIT ?)", markers - GENERATION_MARKERS_MAX);
}

export function commitGeneration(db: Db, c: GenerationCommit): boolean {
  if (!c.generated || c.generated.length > GENERATION_TEXT_MAX_STORE) return false;
  return db.tx(() => {
    const draft = db.get<{ generation: string | null; account_id: number }>("SELECT generation, account_id FROM drafts WHERE id = ?", c.draftId);
    if (!draft || (draft.generation ?? "") !== c.draftGeneration || draft.account_id !== c.accountId) return false;
    db.run("DELETE FROM writing_generations WHERE draft_id = ?", c.draftId);
    db.run("INSERT INTO writing_generations (account_id, draft_id, draft_generation, address, generated, at) VALUES (?, ?, ?, ?, ?, ?)", c.accountId, c.draftId, c.draftGeneration, c.address.toLowerCase(), c.generated, c.now);
    boundGenerations(db);
    return true;
  });
}

/** In `queueSend`'s transaction, before the draft goes: its generation becomes the message's. */
export function transferGeneration(db: Db, p: { draftId: number; draftGeneration: string; messageId: number; opId: string; transfer: GenerationTransfer | undefined; now: number }): void {
  const row = db.get<GenerationRaw>("SELECT * FROM writing_generations WHERE draft_id = ?", p.draftId);
  if (!row) return;
  if ((row.draft_generation ?? "") !== p.draftGeneration) {
    db.run("DELETE FROM writing_generations WHERE id = ?", row.id);
    return;
  }
  const authored = p.transfer?.authored ?? null;
  // nobody said what was typed (an agent's send): nothing shows the user wrote it, so it stays out of the corpus
  const final = authored === null || authored === row.generated ? null : authored.slice(0, GENERATION_TEXT_MAX_STORE);
  db.run("UPDATE writing_generations SET draft_id = NULL, draft_generation = NULL, message_id = ?, op_id = ?, final = ?, at = ? WHERE id = ?", p.messageId, p.opId, final, p.now, row.id);
  boundGenerations(db);
}

export function generationForDraft(db: Db, draftId: number): GenerationRow | null {
  const r = db.get<GenerationRaw>("SELECT * FROM writing_generations WHERE draft_id = ?", draftId);
  return r ? toGeneration(r) : null;
}

export function generationForMessage(db: Db, messageId: number): GenerationRow | null {
  const r = db.get<GenerationRaw>("SELECT * FROM writing_generations WHERE message_id = ?", messageId);
  return r ? toGeneration(r) : null;
}

export function generationPairs(db: Db, p: { accountId: number; address?: string; limit: number }): { generated: string; final: string; address: string; at: number }[] {
  const address = p.address === undefined ? "" : " AND address = ?";
  return db.all<{ generated: string; final: string; address: string; at: number }>(
    `SELECT generated, final, address, at FROM writing_generations WHERE account_id = ?${address} AND message_id IS NOT NULL AND final IS NOT NULL AND generated <> '' ORDER BY at DESC, id DESC LIMIT ?`,
    p.accountId,
    ...(p.address === undefined ? [] : [p.address.toLowerCase()]),
    p.limit,
  );
}
