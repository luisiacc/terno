import { BODY_TAIL_TOKENS, bodyMatches, fromIsAddress, normalizeText, tokenize, type Condition, type FilterRule, type TextOp } from "@terno/core";
import type { Db, Param } from "./sqlite";

const DAY_MS = 86_400_000;
/** the body of messages m, for the few rules FTS5 alone can't decide exactly */
const BODY = "(SELECT body_text FROM message_bodies WHERE message_id = m.id)";

function textSql(op: TextOp, column: string, value: string, params: Param[]): string {
  switch (op) {
    case "contains":
      params.push(value);
      return `instr(${column}, ?) > 0`;
    case "equals":
      params.push(value);
      return `${column} = ?`;
    case "startsWith":
      params.push(value, value);
      return `substr(${column}, 1, length(?)) = ?`;
    case "endsWith":
      params.push(value, value);
      return `substr(${column}, -length(?)) = ?`;
  }
}

function conditionSql(c: Condition, now: number, params: Param[], range?: { from: number; to: number }, scoped = false): string {
  switch (c.field) {
    case "hasAttachment":
      params.push(c.value ? 1 : 0);
      return "m.has_attachments = ?";
    case "account":
      params.push(c.value);
      return "m.account_id = ?";
    case "ageDays":
      params.push(now - c.value * DAY_MS);
      return c.op === "gt" ? "m.date < ?" : "m.date > ?";
    case "from": {
      const v = normalizeText(c.value);
      if (fromIsAddress(c.op, v)) return textSql(c.op, "m.from_email", v, params);
      return `(${textSql(c.op, "m.from_name_norm", v, params)} OR ${textSql(c.op, "m.from_email", v, params)})`;
    }
    case "fromDomain":
      return textSql(c.op, "m.from_domain", normalizeText(c.value), params);
    case "recipients":
      return textSql(c.op, "m.recipients_norm", normalizeText(c.value), params);
    case "subject":
      return textSql(c.op, "m.subject_norm", normalizeText(c.value), params);
    case "listId":
      return textSql(c.op, "coalesce(m.list_id, '')", normalizeText(c.value), params);
    case "body": {
      const phrase = c.value.replaceAll('"', '""');
      const fts = (query: string) => {
        params.push(query);
        // Exact probes also bound sparse batches of repaired, older messages.
        if (scoped) return "EXISTS (SELECT 1 FROM messages_fts WHERE messages_fts MATCH ? AND rowid = m.id)";
        if (range) {
          params.push(Math.trunc(range.from), Math.trunc(range.to));
          return "m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? AND rowid BETWEEN ? AND ?)";
        }
        return "m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)";
      };
      switch (c.op) {
        case "contains":
          return fts(`body : "${phrase}"`);
        case "startsWith":
          // FTS5 '^' anchors the phrase at the column's first token: exact, no verification needed
          return fts(`body : ^ "${phrase}"`);
        case "equals": {
          const candidate = fts(`body : ^ "${phrase}"`);
          params.push("equals", c.value);
          return `(${candidate} AND terno_body_match(?, ${BODY}, ?) = 1)`;
        }
        case "endsWith": {
          const needle = tokenize(c.value);
          if (needle.length > 0 && needle.length <= BODY_TAIL_TOKENS) {
            // body_tail_norm holds the last tokens space-joined: an exact suffix test on token boundaries
            const suffix = ` ${needle.join(" ")}`;
            params.push(suffix, suffix);
            return "substr(' ' || m.body_tail_norm, -length(?)) = ?";
          }
          const candidate = fts(`body : "${phrase}"`);
          params.push("endsWith", c.value);
          return `(${candidate} AND terno_body_match(?, ${BODY}, ?) = 1)`;
        }
      }
    }
  }
}

export interface CompiledRule {
  where: string;
  params: Param[];
}

/** Compiles a rule to a predicate over `messages m`. Must agree with core's evaluateRule. */
export function compileRuleToSql(rule: FilterRule, now: number, range?: { from: number; to: number }): CompiledRule {
  return compileRule(rule, now, range);
}

function compileRule(rule: FilterRule, now: number, range?: { from: number; to: number }, scoped = false): CompiledRule {
  const params: Param[] = [];
  const parts = rule.conditions.map((c) => {
    const sql = conditionSql(c, now, params, range, scoped);
    return c.negate ? `NOT (${sql})` : `(${sql})`;
  });
  const predicate = parts.join(rule.match === "all" ? " AND " : " OR ");
  return { where: rule.conditions.some((c) => c.field === "body") ? `m.body_state = 'full' AND (${predicate})` : predicate, params };
}

/** Registers SQL functions the rule compiler relies on. Called once per connection. */
export function registerFunctions(db: Db): void {
  db.function("terno_body_match", { deterministic: true }, (op, body, value) =>
    bodyMatches(op as TextOp, (body as string | null) ?? null, String(value)) ? 1 : 0,
  );
}

export interface RuleMatches {
  messageIds: number[];
  threadIds: number[];
}

/** Messages (not in trash) matching a rule; optionally restricted to a set of message ids. */
export function findRuleMatches(
  db: Db,
  rule: FilterRule,
  now: number,
  onlyMessageIds?: readonly number[],
  idRange?: { from: number; to: number },
): RuleMatches {
  if (onlyMessageIds?.length === 0 || (idRange && idRange.from > idRange.to)) return { messageIds: [], threadIds: [] };
  const { where, params } = compileRule(rule, now, idRange, onlyMessageIds !== undefined);
  let scope = "";
  const scopeParams: Param[] = [];
  if (onlyMessageIds) {
    scope = ` AND m.id IN (SELECT value FROM json_each(?))`;
    scopeParams.push(JSON.stringify(onlyMessageIds));
  }
  if (idRange) {
    scope += " AND m.id BETWEEN ? AND ?";
    scopeParams.push(idRange.from, idRange.to);
  }
  const rows = db.all<{ id: number; thread_id: number }>(
    `SELECT m.id, m.thread_id FROM messages m WHERE m.is_trash = 0 AND (${where})${scope}`,
    ...params,
    ...scopeParams,
  );
  return { messageIds: rows.map((r) => r.id), threadIds: [...new Set(rows.map((r) => r.thread_id))] };
}
