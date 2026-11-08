import type { Condition, FilterAction, FilterRule } from "@terno/core";
import { getLocale, t } from "@terno/i18n";
import { conditionText } from "./rule-text";

/**
 * Plan 161: what a rule does, said from its own fields, so what AI built and what was asked can be compared (the model's
 * explanation said back the request, and hid a rule that didn't match it).
 */

type Names = { accountEmail: (id: number) => string; category: (id: number) => string; folder: (accountId: number, folder: string) => string };

function actionWords(a: FilterAction, names: Names): string {
  switch (a.type) {
    case "archive":
      return t("filters.say.archive");
    case "trash":
      return t("filters.say.trash");
    case "spam":
      return t("filters.say.spam");
    case "markRead":
      return t("filters.say.markRead");
    case "star":
      return t("filters.say.star");
    case "addCategory":
      return t("filters.say.category", { name: names.category(a.categoryId) });
    case "forward":
      return t("filters.say.forward", { to: a.to.map((x) => x.email).join(", ") });
    case "moveToFolder":
      return t("filters.say.folder", { folder: names.folder(a.accountId, a.folder) });
  }
}

const lowerFirst = (s: string) => s.charAt(0).toLocaleLowerCase(getLocale()) + s.slice(1);
const upperFirst = (s: string) => s.charAt(0).toLocaleUpperCase(getLocale()) + s.slice(1);

/** "Archives and marks as read mail that matches: domain is “uber.com” and older than 7 days." */
export function describeRule(rule: FilterRule, names: Names): string {
  const locale = getLocale();
  const actions = new Intl.ListFormat(locale, { type: "conjunction" }).format(rule.actions.map((a) => actionWords(a, names)));
  const conditions = new Intl.ListFormat(locale, { type: rule.match === "any" ? "disjunction" : "conjunction" }).format(rule.conditions.map((c) => lowerFirst(conditionText(c, names.accountEmail))));
  return upperFirst(t(rule.match === "any" && rule.conditions.length > 1 ? "filters.say.ruleAny" : "filters.say.rule", { actions, conditions }));
}

/** What a request names, by what a rule would need for it: English and Spanish, as the AI box takes both. */
const ASKS: { want: RegExp; has: (rule: FilterRule) => boolean }[] = [
  { want: /\barchiv/i, has: (r) => r.actions.some((a) => a.type === "archive" || a.type === "moveToFolder") },
  { want: /\b(delete|trash|bin)\b|\bborr[ae]|\belimin|papelera/i, has: (r) => r.actions.some((a) => a.type === "trash") },
  { want: /\bspam\b/i, has: (r) => r.actions.some((a) => a.type === "spam") },
  { want: /\bas read\b|\bmark\w*\b.{0,20}\bread\b|\ble[ií]d[oa]s?\b/i, has: (r) => r.actions.some((a) => a.type === "markRead") },
  { want: /\bstar(red|s)?\b|\bdestac|\bestrella/i, has: (r) => r.actions.some((a) => a.type === "star") },
  {
    want: /\b(older|newer) than\b|\b(more|less) than (a|an|\d+) (days?|weeks?|months?|years?)\b|\b(a|\d+) (days?|weeks?|months?) old\b|\bm[aá]s (de|antigu)|\bmenos de \d|\bhace m[aá]s/i,
    has: (r) => r.conditions.some((c) => c.field === "ageDays"),
  },
  // a sender: an address, a domain, or "from …" (in Spanish "de" says too many things to read as one)
  { want: /@|\b[\w-]+\.(com|net|org|io|dev|app|co|es|mx|me)\b|\bfrom\b|\bde parte de\b|\benviad[oa]s? por\b/i, has: (r) => r.conditions.some((c) => (c.field === "from" || c.field === "fromDomain" || c.field === "listId") && !c.negate) },
];
/** an action a request can name at all, so a rule that acts on a request naming none wasn't asked to */
const ANY_ACTION = /\barchiv|\b(delete|trash|bin|spam|read|star|label|tag|move|file|forward|put|categor)|\bborr[ae]|\belimin|papelera|le[ií]d|destac|estrella|etiquet|\bmuev|\bmover\b|reenv|\bpon(er|lo|la|los|las)?\b|categor/i;

/**
 * Plan 161: whether a built rule plainly misses its request, with no model asked: an action or an age or a sender the
 * request names that the rule lacks, or a rule that acts when the request named nothing to do. Calm by design: it says
 * to check, not that it's wrong.
 */
export function ruleMisses(prompt: string, rule: FilterRule): boolean {
  if (!ANY_ACTION.test(prompt)) return true;
  return ASKS.some((a) => a.want.test(prompt) && !a.has(rule));
}

/** A condition's operator with its sense, as the operator menu holds both (plan 161: no separate "not" toggle). */
export type SensedOp = `${"" | "not:"}${string}`;
export const sensedOp = (c: Condition): SensedOp => `${c.negate ? "not:" : ""}${c.field === "hasAttachment" || c.field === "account" ? "is" : c.op}`;
export function withSensedOp(c: Condition, value: SensedOp): Condition {
  const negate = value.startsWith("not:");
  const op = negate ? value.slice(4) : value;
  if (c.field === "hasAttachment" || c.field === "account") return { ...c, negate: negate || undefined } as Condition;
  return { ...c, op, negate: negate || undefined } as Condition;
}
