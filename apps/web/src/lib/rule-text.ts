import { patternTemplate, type Condition } from "@terno/core";
import { t, type TextKey } from "@terno/i18n";

const FIELD = {
  from: "filters.field.from",
  fromDomain: "filters.field.fromDomain",
  subject: "filters.field.subject",
  body: "filters.field.body",
  text: "filters.field.text",
  opening: "filters.field.opening",
  recipients: "filters.field.recipients",
  listId: "filters.field.listIdShort",
  hasAttachment: "filters.field.hasAttachment",
  account: "filters.field.account",
  ageDays: "filters.field.ageDays",
} as const satisfies Record<Condition["field"], string>;
/** each text operator, said plainly and negated */
const OP: Record<string, readonly [`filters.op.${string}` & TextKey, `filters.op.${string}` & TextKey]> = {
  contains: ["filters.op.contains", "filters.op.notContains"],
  equals: ["filters.op.equals", "filters.op.notEquals"],
  startsWith: ["filters.op.startsWith", "filters.op.notStartsWith"],
  endsWith: ["filters.op.endsWith", "filters.op.notEndsWith"],
  matches: ["filters.op.matches", "filters.op.notMatches"],
};

/** One line for a condition, in the builder's words. */
export function conditionText(c: Condition, accountEmail: (id: number) => string): string {
  const not = Boolean(c.negate);
  if (c.field === "hasAttachment") return c.value !== not ? t("filters.cond.withAttachments") : t("filters.cond.withoutAttachments");
  if (c.field === "account") return t(not ? "filters.cond.notInAccount" : "filters.cond.inAccount", { email: accountEmail(c.value) });
  if (c.field === "ageDays") {
    const key = c.op === "gt" ? (not ? "filters.cond.notOlderThan" : "filters.cond.olderThan") : not ? "filters.cond.notNewerThan" : "filters.cond.newerThan";
    return t(key, { count: c.value });
  }
  // plan 89: a word "mentions"; a generated subject pattern reads as its template ("Tu pedido # está en camino")
  if (c.field === "text") return t("filters.cond.mentions", { value: c.value });
  const template = c.op === "matches" ? patternTemplate(c.value) : null;
  if (template !== null) return t(not ? "filters.cond.notLike" : "filters.cond.like", { field: t(FIELD[c.field]), template });
  const op = OP[c.op];
  return t("filters.cond.text", { field: t(FIELD[c.field]), op: op ? t(op[not ? 1 : 0]) : not ? t("filters.cond.notOp", { op: c.op }) : c.op, value: c.value });
}
