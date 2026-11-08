import { normalizeText, type Address, type VoiceScope } from "@terno/core";
import { BULK_RECIPIENTS, CORPUS_PAGE_MAX, GENERATION_MARKERS_MAX, GENERATION_TEXT_MAX_STORE, GENERATIONS_MAX_BYTES, GENERATIONS_MAX_ROWS, PROFILES_MAX_BYTES, PROFILES_MAX_ROWS, profileFits, recipientList, SENT_SIZE_MAX, type CorpusCursor, type CorpusHeader, type GenerationCommit, type GenerationRow, type GenerationTransfer, type ProfileEdit, type ProfileJudgmentWrite, type ProfilesCommit, type SentRef, type WritingProfileRow } from "@terno/store";
import { setSetting, T, type Ctx, type R } from "./mail";

/** Plan 133 on IndexedDB, like SQL's (packages/db/src/writing.ts): see packages/store/src/writing.ts. */

const live = (m: R) => m.is_sent === 1 && m.is_draft !== 1 && m.is_spam !== 1 && m.is_trash !== 1;

const fromModel = (c: Ctx, id: number) => T(c, "writing_generations").by("fk_message_id", id).some((g) => g.final === null || g.final === undefined);

const usable = (c: Ctx, m: R) => live(m) && m.body_state !== "none" && (m.size ?? 0) <= SENT_SIZE_MAX && !fromModel(c, m.id);

export function corpusHeaders(c: Ctx, p: { accountId: number; before?: CorpusCursor; limit: number }): CorpusHeader[] {
  const before = p.before;
  const rows = T(c, "messages")
    .by("sent", p.accountId)
    .filter((m) => !before || m.date < before.date || (m.date === before.date && m.id < before.id))
    .sort((a, b) => b.date - a.date || b.id - a.id);
  const out: CorpusHeader[] = [];
  const limit = Math.min(p.limit, CORPUS_PAGE_MAX);
  for (const m of rows) {
    if (out.length >= limit) break;
    if (!usable(c, m)) continue;
    const to = recipientList(m.to_json);
    const cc = recipientList(m.cc_json);
    out.push({
      id: m.id,
      threadId: m.thread_id,
      accountId: m.account_id,
      date: m.date,
      subject: m.subject,
      to: to.addresses,
      cc: cc.addresses,
      names: { ...cc.names, ...to.names },
      isReply: (m.in_reply_to ?? null) !== null,
      bulk: (m.list_id ?? null) !== null || to.tooLong || cc.tooLong || to.addresses.length + cc.addresses.length > BULK_RECIPIENTS,
    });
  }
  return out;
}

export function corpusUsable(c: Ctx, ids: readonly number[]): number[] {
  const messages = T(c, "messages");
  return ids.filter((id) => {
    const m = messages.get(id);
    return m !== undefined && usable(c, m);
  });
}

/** Every sent id to walk, for `exactInSlice`: the list is taken once, and rows are read a slice at a time. */
export function sentIds(c: Ctx, accountId: number | undefined): number[] {
  const messages = T(c, "messages");
  if (accountId !== undefined) return [...messages.keysBy("sent", accountId)] as number[];
  return [...T(c, "accounts").all()].flatMap((a) => [...messages.keysBy("sent", a.id)] as number[]);
}

export interface ExactProgress {
  refs: SentRef[];
  sawLong: boolean;
}

/** One slice of the walk: a substring test on the normalized recipients, then an exact check on what passes it. */
export function exactInSlice(c: Ctx, ids: readonly number[], want: { addresses: ReadonlySet<string>; needles: readonly string[] }, out: ExactProgress): void {
  const messages = T(c, "messages");
  for (const id of ids) {
    const m = messages.get(id);
    if (!m || !live(m)) continue;
    const norm = String(m.recipients_norm ?? "");
    if (!want.needles.some((n) => norm.includes(n))) continue;
    const to = recipientList(m.to_json);
    const cc = recipientList(m.cc_json);
    if (to.tooLong || cc.tooLong) out.sawLong = true;
    if (!to.addresses.some((a) => want.addresses.has(a)) && !cc.addresses.some((a) => want.addresses.has(a))) continue;
    out.refs.push({ id: m.id, threadId: m.thread_id, accountId: m.account_id, date: m.date, subject: m.subject, to: to.addresses, cc: cc.addresses, isReply: (m.in_reply_to ?? null) !== null });
  }
}

export const sentNeedles = (addresses: readonly string[]): string[] => addresses.map((a) => normalizeText(a));

export function hasBody(c: Ctx, id: number): boolean {
  const m = T(c, "messages").get(id);
  return !!m && usable(c, m);
}

export function everWrittenTo(c: Ctx, addresses: readonly string[]): boolean {
  const people = T(c, "correspondents");
  return addresses.some((a) => people.get(a.toLowerCase())?.written === 1);
}

export function fromAddress(c: Ctx, address: string, accountId: number | undefined): { threadId: number; date: number }[] {
  return T(c, "messages")
    .by("from", address.toLowerCase())
    .filter((m) => m.is_draft !== 1 && m.is_spam !== 1 && m.is_trash !== 1 && (accountId === undefined || m.account_id === accountId))
    .map((m) => ({ threadId: m.thread_id, date: m.date }));
}

export function liveThreads(c: Ctx, ids: Iterable<number>): Set<number> {
  const threads = T(c, "threads");
  const out = new Set<number>();
  for (const id of ids) {
    const t = threads.get(id);
    if (t && t.in_spam !== 1 && t.in_trash !== 1) out.add(id);
  }
  return out;
}

export function threadRecipients(c: Ctx, threadId: number): Map<number, { to: Address[]; cc: Address[] }> {
  const out = new Map<number, { to: Address[]; cc: Address[] }>();
  for (const m of T(c, "messages").by("fk_thread_id", threadId)) {
    const pick = (json: string) => {
      const list = recipientList(json);
      return list.addresses.map((email) => ({ name: list.names[email] ?? "", email }));
    };
    out.set(m.id, { to: pick(m.to_json), cc: pick(m.cc_json) });
  }
  return out;
}

// ─── profiles ──────────────────────────────────────────────────────────────

const toProfile = (r: R): WritingProfileRow => ({
  id: r.id,
  scope: r.scope as VoiceScope,
  scopeKey: r.scope_key,
  language: r.language,
  accountId: r.account_id ?? null,
  habitsJson: r.habits_json,
  phrasesJson: r.phrases_json,
  judgmentJson: r.judgment_json ?? null,
  samples: r.samples,
  newSince: r.new_since ?? 0,
  sampleHash: r.sample_hash ?? null,
  edited: r.edited === 1,
  model: r.model ?? null,
  provider: r.provider ?? null,
  promptVersion: r.prompt_version ?? null,
  updatedAt: r.updated_at,
});

const identityOf = (c: Ctx, scopeKey: string, language: string): R | undefined => T(c, "writing_profiles").by("identity", scopeKey, language)[0];

const profileSize = (r: R) => String(r.habits_json).length + String(r.phrases_json).length + String(r.judgment_json ?? "").length;

export function readProfiles(c: Ctx, keys: readonly { scopeKey: string; language: string }[]): WritingProfileRow[] {
  const out: WritingProfileRow[] = [];
  for (const k of keys) {
    const r = identityOf(c, k.scopeKey, k.language);
    if (r) out.push(toProfile(r));
  }
  return out;
}

export function listProfiles(c: Ctx, p: { scope?: VoiceScope; accountId?: number; after?: { scopeKey: string; language: string }; limit: number }): WritingProfileRow[] {
  const table = T(c, "writing_profiles");
  const rows = p.accountId !== undefined ? table.by("fk_account_id", p.accountId) : [...table.all()];
  const after = p.after;
  // bytewise, as SQLite's BINARY collation orders them
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return rows
    .filter((r) => (!p.scope || r.scope === p.scope) && (!after || compare(r.scope_key, after.scopeKey) > 0 || (r.scope_key === after.scopeKey && compare(r.language, after.language) > 0)))
    .sort((a, b) => compare(a.scope_key, b.scope_key) || compare(a.language, b.language))
    .slice(0, p.limit)
    .map(toProfile);
}

function boundProfiles(c: Ctx): void {
  const table = T(c, "writing_profiles");
  let rows = 0;
  let bytes = 0;
  const candidates: R[] = [];
  for (const r of table.all()) {
    rows++;
    bytes += profileSize(r);
    if (r.edited !== 1 && (r.scope === "person" || r.scope === "domain")) candidates.push(r);
  }
  if (rows <= PROFILES_MAX_ROWS && bytes <= PROFILES_MAX_BYTES) return;
  candidates.sort((a, b) => a.updated_at - b.updated_at || a.id - b.id);
  for (const r of candidates) {
    if (rows <= PROFILES_MAX_ROWS && bytes <= PROFILES_MAX_BYTES) break;
    table.deleteRow(r);
    rows--;
    bytes -= profileSize(r);
  }
}

export function commitProfiles(c: Ctx, commit: ProfilesCommit): void {
  const table = T(c, "writing_profiles");
  const named = new Set<string>((commit.keep ?? []).map((k) => `${k.scopeKey}\n${k.language}`));
  for (const u of commit.upserts) {
    if (!profileFits(u)) continue;
    named.add(`${u.scopeKey}\n${u.language}`);
    const row = identityOf(c, u.scopeKey, u.language);
    if (!row) {
      table.insert({ scope: u.scope, scope_key: u.scopeKey, language: u.language, account_id: u.accountId, habits_json: u.habitsJson, phrases_json: u.phrasesJson, judgment_json: null, samples: u.samples, new_since: 0, sample_hash: null, edited: 0, model: null, provider: null, prompt_version: null, updated_at: commit.now });
      continue;
    }
    if (row.edited === 1) table.update(row, { samples: u.samples });
    else table.update(row, { samples: u.samples, habits_json: u.habitsJson, phrases_json: u.phrasesJson, updated_at: commit.now });
  }
  for (const i of commit.incorporated ?? []) {
    const row = identityOf(c, i.scopeKey, i.language);
    if (row) table.update(row, { new_since: (row.new_since ?? 0) + i.count });
  }
  const stale = (rows: R[]) => rows.filter((r) => r.edited !== 1 && !named.has(`${r.scope_key}\n${r.language}`));
  if (commit.replaceAccount !== undefined) for (const r of stale(table.by("fk_account_id", commit.replaceAccount))) table.deleteRow(r);
  if (commit.replaceYou) for (const r of stale(table.by("scope", "you"))) table.deleteRow(r);
  boundProfiles(c);
  for (const [key, value] of Object.entries(commit.state)) setSetting(c, key, value);
}

export function judgeProfile(c: Ctx, w: ProfileJudgmentWrite): boolean {
  const row = identityOf(c, w.scopeKey, w.language);
  if (!row || row.edited === 1 || !profileFits({ habitsJson: row.habits_json, phrasesJson: row.phrases_json, judgmentJson: w.judgmentJson })) return false;
  T(c, "writing_profiles").update(row, { judgment_json: w.judgmentJson, sample_hash: w.sampleHash, model: w.model, provider: w.provider, prompt_version: w.promptVersion, new_since: 0, updated_at: w.now });
  return true;
}

export function editProfile(c: Ctx, e: ProfileEdit): boolean {
  const row = identityOf(c, e.scopeKey, e.language);
  if (!row) return false;
  const next = {
    habitsJson: e.habitsJson ?? row.habits_json,
    phrasesJson: e.phrasesJson ?? row.phrases_json,
    judgmentJson: e.judgmentJson === undefined ? (row.judgment_json ?? null) : e.judgmentJson,
  };
  if (!profileFits(next)) return false;
  T(c, "writing_profiles").update(row, { habits_json: next.habitsJson, phrases_json: next.phrasesJson, judgment_json: next.judgmentJson, edited: 1, new_since: 0, updated_at: e.now });
  return true;
}

export function resetProfile(c: Ctx, scopeKey: string, language?: string): void {
  const table = T(c, "writing_profiles");
  for (const r of Array.from(table.all())) if (r.scope_key === scopeKey && (language === undefined || r.language === language)) table.deleteRow(r);
}

export function restoreProfiles(c: Ctx, rows: readonly WritingProfileRow[]): void {
  const table = T(c, "writing_profiles");
  for (const r of rows) {
    if (r.accountId !== null && !T(c, "accounts").get(r.accountId)) continue;
    const held = identityOf(c, r.scopeKey, r.language);
    if (held) table.deleteRow(held);
    table.insert({ scope: r.scope, scope_key: r.scopeKey, language: r.language, account_id: r.accountId, habits_json: r.habitsJson, phrases_json: r.phrasesJson, judgment_json: r.judgmentJson, samples: r.samples, new_since: r.newSince, sample_hash: r.sampleHash, edited: r.edited ? 1 : 0, model: r.model, provider: r.provider, prompt_version: r.promptVersion, updated_at: r.updatedAt });
  }
}

export function clearJudgments(c: Ctx, accountId?: number): void {
  const table = T(c, "writing_profiles");
  for (const r of Array.from(table.all())) {
    if ((r.judgment_json ?? null) !== null && r.edited !== 1 && (accountId === undefined || r.account_id === accountId)) table.update(r, { judgment_json: null, sample_hash: null, model: null, provider: null, prompt_version: null });
  }
}

export function clearWriting(c: Ctx, stateKeys: readonly string[]): void {
  for (const name of ["writing_profiles", "writing_generations"]) {
    const table = T(c, name);
    for (const r of Array.from(table.all())) table.deleteRow(r);
  }
  for (const key of stateKeys) T(c, "settings").delete(key);
}

// ─── provenance ────────────────────────────────────────────────────────────

const toGeneration = (r: R): GenerationRow => ({ id: r.id, accountId: r.account_id, draftId: r.draft_id ?? null, draftGeneration: r.draft_generation ?? null, messageId: r.message_id ?? null, opId: r.op_id ?? null, address: r.address, generated: r.generated, final: r.final ?? null, at: r.at });

/** Like SQL's: newest text rows stay; an unchanged send fades to a marker, a pair or a draft's row goes. */
function boundGenerations(c: Ctx): void {
  const table = T(c, "writing_generations");
  const rows = [...table.by("texts", 1)].sort((a, b) => b.at - a.at || b.id - a.id);
  let seen = 0;
  let bytes = 0;
  let faded = false;
  for (const r of rows) {
    seen++;
    bytes += String(r.generated).length + String(r.final ?? "").length;
    if (seen <= GENERATIONS_MAX_ROWS && bytes <= GENERATIONS_MAX_BYTES) continue;
    if ((r.message_id ?? null) !== null && (r.final ?? null) === null) {
      table.update(r, { generated: "", address: "" });
      faded = true;
    } else table.deleteRow(r);
  }
  if (!faded) return;
  const markers = table.count("markers", 1);
  if (markers <= GENERATION_MARKERS_MAX) return;
  const oldest = table.by("markers", 1).sort((a, b) => a.at - b.at || a.id - b.id);
  for (const r of oldest.slice(0, markers - GENERATION_MARKERS_MAX)) table.deleteRow(r);
}

export function commitGeneration(c: Ctx, g: GenerationCommit): boolean {
  if (!g.generated || g.generated.length > GENERATION_TEXT_MAX_STORE) return false;
  const draft = T(c, "drafts").get(g.draftId);
  if (!draft || (draft.generation ?? "") !== g.draftGeneration || draft.account_id !== g.accountId) return false;
  const table = T(c, "writing_generations");
  for (const r of table.by("fk_draft_id", g.draftId)) table.deleteRow(r);
  table.insert({ account_id: g.accountId, draft_id: g.draftId, draft_generation: g.draftGeneration, message_id: null, op_id: null, address: g.address.toLowerCase(), generated: g.generated, final: null, at: g.now, has_text: 1 });
  boundGenerations(c);
  return true;
}

export function transferGeneration(c: Ctx, p: { draftId: number; draftGeneration: string; messageId: number; opId: string; transfer: GenerationTransfer | undefined; now: number }): void {
  const table = T(c, "writing_generations");
  const row = table.by("fk_draft_id", p.draftId)[0];
  if (!row) return;
  if ((row.draft_generation ?? "") !== p.draftGeneration) {
    table.deleteRow(row);
    return;
  }
  const authored = p.transfer?.authored ?? null;
  const final = authored === null || authored === row.generated ? null : authored.slice(0, GENERATION_TEXT_MAX_STORE);
  table.update(row, { draft_id: null, draft_generation: null, message_id: p.messageId, op_id: p.opId, final, at: p.now });
  boundGenerations(c);
}

export function generationForDraft(c: Ctx, draftId: number): GenerationRow | null {
  const r = T(c, "writing_generations").by("fk_draft_id", draftId)[0];
  return r ? toGeneration(r) : null;
}

export function generationForMessage(c: Ctx, messageId: number): GenerationRow | null {
  const r = T(c, "writing_generations").by("fk_message_id", messageId)[0];
  return r ? toGeneration(r) : null;
}

export function generationPairs(c: Ctx, p: { accountId: number; address?: string; limit: number }): { generated: string; final: string; address: string; at: number }[] {
  const address = p.address?.toLowerCase();
  return T(c, "writing_generations")
    .by("fk_account_id", p.accountId)
    .filter((r) => (r.message_id ?? null) !== null && (r.final ?? null) !== null && r.generated !== "" && (address === undefined || r.address === address))
    .sort((a, b) => b.at - a.at || b.id - a.id)
    .slice(0, p.limit)
    .map((r) => ({ generated: r.generated, final: r.final, address: r.address, at: r.at }));
}
