import {
  CONSUMER_DOMAINS,
  COUNT_CAP,
  decide,
  explain,
  parseReasons,
  fnv1a,
  normalizeText,
  valvePaused,
  type AutoCategorize,
  type CategorizerModel,
  type Reason,
  type CategorizeScope,
  type CategoryModelStats,
  type Prediction,
  type QuickActions,
} from "@terno/core";
import { ownAddresses, threadFeatures, vetoesFor } from "./categorize";
import { pendingSuggestionCounts } from "./queries";
import { searchThreadIds } from "./search";
import type { PendingSuggestion } from "@terno/store";
import type { Db, Param } from "./sqlite";

export type { PendingSuggestion } from "@terno/store";
export { COUNT_CAP } from "@terno/core";

/**
 * Every scope leaves out threads already in the category, trash and spam,
 * and threads the user took out of it. Sender and domain scopes match only
 * mail the user received, never their own addresses.
 */
function scopeSql(db: Db, categoryId: number, scope: CategorizeScope): { sql: string; params: Param[] } | null {
  const exclusions = `t.in_trash = 0 AND t.in_spam = 0
    AND t.id NOT IN (SELECT thread_id FROM thread_categories INDEXED BY thread_categories_c WHERE category_id = ?)
    AND NOT EXISTS (SELECT 1 FROM cls_examples e WHERE e.thread_id = t.id AND e.category_id = ? AND e.label < 0)`;
  const own = JSON.stringify([...ownAddresses(db).emails]);
  const by = (index: string, predicate: string, value: string) => ({
    sql: `SELECT t.id FROM threads t
          WHERE t.id IN (SELECT m.thread_id FROM messages m INDEXED BY ${index}
                         WHERE ${predicate} AND m.is_sent = 0 AND m.from_email NOT IN (SELECT value FROM json_each(?)))
            AND ${exclusions}`,
    params: [value, own, categoryId, categoryId] as Param[],
  });
  switch (scope.kind) {
    case "sender":
      return by("messages_from", "m.from_email = ?", normalizeText(scope.email.trim()));
    case "domain":
      return by("messages_domain", "m.from_domain = ?", normalizeText(scope.domain.trim().replace(/^@/, "")));
    case "list":
      return by("messages_list", "m.list_id = ?", normalizeText(scope.listId.trim()));
    case "query":
      return null;
  }
}

const QUERY_EXCLUSIONS = [
  // whatever the query says (in:trash, in:spam): bulk filing never reaches them
  "t.in_trash = 0 AND t.in_spam = 0",
  "t.id NOT IN (SELECT thread_id FROM thread_categories INDEXED BY thread_categories_c WHERE category_id = ?)",
  "NOT EXISTS (SELECT 1 FROM cls_examples e WHERE e.thread_id = t.id AND e.category_id = ? AND e.label < 0)",
];

/** Matching thread ids, newest first; `limit` -1 resolves every one (bulk apply). */
export function resolveScope(db: Db, categoryId: number, scope: CategorizeScope, now: number, limit = -1): number[] {
  const s = scopeSql(db, categoryId, scope);
  if (s) return db.all<{ id: number }>(`${s.sql} ORDER BY t.last_date DESC, t.id DESC LIMIT ?`, ...s.params, limit).map((r) => r.id);
  if (scope.kind !== "query") return [];
  return searchThreadIds(db, { query: scope.query, now, limit, where: QUERY_EXCLUSIONS, whereParams: [categoryId, categoryId] }).ids;
}

export function countScope(db: Db, categoryId: number, scope: CategorizeScope, now: number): { count: number; capped: boolean } {
  const s = scopeSql(db, categoryId, scope);
  const n = s
    ? db.get<{ c: number }>(`SELECT count(*) AS c FROM (${s.sql} LIMIT ?)`, ...s.params, COUNT_CAP + 1)!.c
    : resolveScope(db, categoryId, scope, now, COUNT_CAP + 1).length;
  return { count: Math.min(n, COUNT_CAP), capped: n > COUNT_CAP };
}

/** The SQL a scope count runs (query-plan tests). */
export function scopeCountSql(db: Db, categoryId: number, scope: Exclude<CategorizeScope, { kind: "query" }>): { sql: string; params: Param[] } {
  const s = scopeSql(db, categoryId, scope)!;
  return { sql: `SELECT count(*) AS c FROM (${s.sql} LIMIT ?)`, params: [...s.params, COUNT_CAP + 1] };
}

// ───────────────────────────── quick actions ─────────────────────────────

const MAX_TERMS = 6;

/**
 * What the snackbar offers after threads were filed: everything from the
 * same sender, domain or list (only what all of them share), and the words
 * that best tell this category apart, ranked by the model. Words that are
 * too rare (< 2 threads) or too common (> 20%) are skipped, and so is the
 * sender's own brand, which its chip already covers.
 */
export function quickActions(db: Db, categoryId: number, threadIds: readonly number[], model: CategorizerModel | null): QuickActions {
  const own = ownAddresses(db);
  const sets = [...threadFeatures(db, threadIds.slice(0, 200), own).values()];
  const empty: QuickActions = { sender: null, domain: null, list: null, terms: [], filterDraft: null };
  if (sets.length === 0) return empty;
  const shared = <T>(pick: (s: (typeof sets)[number]) => T | null): T | null => {
    const first = pick(sets[0]!);
    return first !== null && sets.every((s) => pick(s) === first) ? first : null;
  };
  const senderEmail = shared((s) => s.features.sender);
  const sender = senderEmail ? { email: senderEmail, name: sets[0]!.root.source.fromName || senderEmail } : null;
  const domain = shared((s) => s.features.domain);
  const list = shared((s) => s.features.list);

  // words every selected thread has (one thread: all of its words)
  let words = new Map<string, string>(sets[0]!.features.tokens.filter((t) => !t.slice(2).startsWith("#")).map((t) => [t.slice(2), t]));
  for (const s of sets.slice(1)) {
    const mine = new Set(s.features.tokens.map((t) => t.slice(2)));
    words = new Map([...words].filter(([w]) => mine.has(w)));
  }
  const brand = new Set(normalizeText(`${senderEmail ?? ""} ${sets[0]!.root.source.fromName}`).split(/[^a-z0-9]+/).filter((w) => w.length > 1));
  const total = Math.max(1, model?.trainingThreads ?? 0);
  const ranked = [...words.entries()]
    .filter(([w]) => !brand.has(w))
    .map(([w, key]) => {
      const hashes = [fnv1a(`s:${w}`), fnv1a(`b:${w}`), fnv1a(key)];
      const support = model ? Math.max(...hashes.map((h) => model.support(h))) : 2;
      const llr = model ? Math.max(...hashes.map((h) => model.featureStats(h, categoryId).llr)) : 0;
      return { term: w, support, llr, subject: key.startsWith("s:") };
    })
    .filter((x) => !model || (x.support >= 2 && x.support <= total * 0.2))
    .sort((a, b) => b.llr - a.llr || Number(b.subject) - Number(a.subject) || a.term.localeCompare(b.term))
    .slice(0, MAX_TERMS);

  const strongest: { field: "from" | "listId" | "fromDomain"; value: string; label: string } | null = sender
    ? { field: "from", value: sender.email, label: sender.name }
    : list
      ? { field: "listId", value: list, label: list }
      : domain
        ? { field: "fromDomain", value: domain, label: `@${domain}` }
        : null;
  return {
    sender,
    domain: domain && !CONSUMER_DOMAINS.has(domain) && !own.domains.has(domain) ? domain : null,
    list,
    terms: ranked.map((r, i) => ({ term: r.term, preselected: i < 2 })),
    filterDraft: strongest
      ? {
          name: strongest.label.slice(0, 120),
          rule: { match: "all", conditions: [{ field: strongest.field, op: "equals", value: strongest.value }], actions: [{ type: "addCategory", categoryId }] },
        }
      : null,
  };
}

// ───────────────────────────── predictions, suggestions, stats ─────────────────────────────

/** What the engine thinks of one thread right now, for every category, with reasons. */
export function predictThread(db: Db, threadId: number, model: CategorizerModel, mode: AutoCategorize, now: number): Prediction[] {
  const set = threadFeatures(db, [threadId]).get(threadId);
  if (!set) return [];
  const scores = model.score(set.encoded);
  const categories = new Map(
    db.all<{ id: number; name: string; auto_apply: number }>("SELECT id, name, auto_apply FROM categories").map((c) => [c.id, { name: c.name, autoApply: c.auto_apply === 1, ...valveStats(db).get(c.id) ?? { kept: 0, reverted: 0 } }]),
  );
  const decisions = decide({
    mode,
    autoEligible: true,
    scores,
    categories,
    vetoes: vetoesFor(db, threadId, set.features.sender, scores.map((s) => s.categoryId), now),
    lookAlike: model.lookAlike(set.encoded),
    senderSupport: model.senderSupport(set.encoded),
  });
  return decisions
    .map((d) => ({
      categoryId: d.categoryId,
      p: d.p,
      decision: d.decision,
      reasons: explain(model, set.features, d.categoryId, categories.get(d.categoryId)?.name ?? "", set.root.source.fromName || set.features.sender),
    }))
    .sort((a, b) => b.p - a.p);
}

function valveStats(db: Db): Map<number, { kept: number; reverted: number }> {
  return new Map(
    db
      .all<{ category_id: number; kept: number; reverted: number }>(
        `SELECT category_id, coalesce(sum(outcome = 'kept'), 0) AS kept, coalesce(sum(outcome = 'reverted'), 0) AS reverted
         FROM cls_decisions INDEXED BY cls_decisions_outcomes WHERE kind = 'auto' AND outcome IS NOT NULL GROUP BY category_id`,
      )
      .map((r) => [r.category_id, { kept: r.kept, reverted: r.reverted }]),
  );
}


/** Suggestions waiting for an answer (threads still outside the category, not in trash or spam). */
export function pendingSuggestions(db: Db, options: { categoryId?: number; threadId?: number; limit: number }): PendingSuggestion[] {
  const where = ["d.kind = 'suggest'", "d.outcome IS NULL", "t.in_trash = 0", "t.in_spam = 0"];
  const params: Param[] = [];
  if (options.categoryId !== undefined) {
    where.push("d.category_id = ?");
    params.push(options.categoryId);
  }
  if (options.threadId !== undefined) {
    where.push("d.thread_id = ?");
    params.push(options.threadId);
  }
  return db
    .all<{ thread_id: number; category_id: number; p: number; explain_json: string; at: number }>(
      `SELECT d.thread_id, d.category_id, d.p, d.explain_json, d.at FROM cls_decisions d JOIN threads t ON t.id = d.thread_id
       WHERE ${where.join(" AND ")}
         AND NOT EXISTS (SELECT 1 FROM thread_categories tc WHERE tc.thread_id = d.thread_id AND tc.category_id = d.category_id)
       ORDER BY t.last_date DESC, t.id DESC, d.p DESC LIMIT ?`,
      ...params,
      options.limit,
    )
    .map((r) => ({ threadId: r.thread_id, categoryId: r.category_id, p: r.p, reasons: parseReasons(r.explain_json), at: r.at }));
}

/** Why the engine filed a thread on its own (auto decisions still in force). */
export function autoReasons(db: Db, threadId: number): { categoryId: number; reasons: Reason[] }[] {
  return db
    .all<{ category_id: number; explain_json: string }>(
      `SELECT d.category_id, d.explain_json FROM cls_decisions d
       JOIN thread_categories tc ON tc.thread_id = d.thread_id AND tc.category_id = d.category_id AND tc.added_by = 'auto'
       WHERE d.thread_id = ? AND d.kind = 'auto'`,
      threadId,
    )
    .map((r) => ({ categoryId: r.category_id, reasons: parseReasons(r.explain_json) }));
}

export function categoryStats(db: Db): CategoryModelStats[] {
  const valve = valveStats(db);
  const pending = pendingSuggestionCounts(db);
  const examples = new Map(
    db.all<{ category_id: number; n: number }>("SELECT category_id, count(*) AS n FROM cls_examples WHERE label > 0 AND weight > 0 GROUP BY category_id").map((r) => [r.category_id, r.n]),
  );
  return db.all<{ id: number; auto_apply: number }>("SELECT id, auto_apply FROM categories ORDER BY position, id").map((c) => {
    const v = valve.get(c.id) ?? { kept: 0, reverted: 0 };
    return {
      categoryId: c.id,
      examples: examples.get(c.id) ?? 0,
      autoApply: c.auto_apply === 1,
      kept: v.kept,
      reverted: v.reverted,
      autoPrecision: v.kept + v.reverted > 0 ? v.kept / (v.kept + v.reverted) : null,
      paused: valvePaused(v.kept, v.reverted),
      pendingSuggestions: pending[c.id] ?? 0,
    };
  });
}
