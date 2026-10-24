import { BODY_TAIL_TOKENS, bodyMatches, normalizeText, tokenize, type Condition, type FilterRule, type TextOp } from "@terno/core";
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

function conditionSql(c: Condition, now: number, params: Param[], range?: { from: number; to: number }): string {
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
      // a windowed scan constrains the FTS rowids too, so it never materializes global hits
      const fts = range
        ? `m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? AND rowid BETWEEN ${Math.trunc(range.from)} AND ${Math.trunc(range.to)})`
        : "m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)";
      switch (c.op) {
        case "contains":
          params.push(`body : "${phrase}"`);
          return fts;
        case "startsWith":
          // FTS5 '^' anchors the phrase at the column's first token: exact, no verification needed
          params.push(`body : ^ "${phrase}"`);
          return fts;
        case "equals":
          params.push(`body : ^ "${phrase}"`, "equals", c.value);
          return `(${fts} AND unica_body_match(?, ${BODY}, ?) = 1)`;
        case "endsWith": {
          const needle = tokenize(c.value);
          if (needle.length > 0 && needle.length <= BODY_TAIL_TOKENS) {
            // body_tail_norm holds the last tokens space-joined: an exact suffix test on token boundaries
            const suffix = ` ${needle.join(" ")}`;
            params.push(suffix, suffix);
            return "substr(' ' || m.body_tail_norm, -length(?)) = ?";
          }
          params.push(`body : "${phrase}"`, "endsWith", c.value);
          return `(${fts} AND unica_body_match(?, ${BODY}, ?) = 1)`;
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
  const params: Param[] = [];
  const parts = rule.conditions.map((c) => {
    const sql = conditionSql(c, now, params, range);
    return c.negate ? `NOT (${sql})` : `(${sql})`;
  });
  return { where: parts.join(rule.match === "all" ? " AND " : " OR "), params };
}

/** Registers SQL functions the rule compiler relies on. Called once per connection. */
export function registerFunctions(db: Db): void {
  db.function("unica_body_match", { deterministic: true }, (op, body, value) =>
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
  const { where, params } = compileRuleToSql(rule, now, idRange);
  let scope = "";
  const scopeParams: Param[] = [];
  if (onlyMessageIds) {
    if (onlyMessageIds.length === 0) return { messageIds: [], threadIds: [] };
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
