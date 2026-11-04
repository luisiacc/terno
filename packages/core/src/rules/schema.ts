import { L, type TextKey } from "@terno/i18n";
import { z } from "zod";

import { isValidEmail } from "../address";
import { FORWARD_ADDRESSES_MAX_CHARS } from "../forwarding";
import { checkPattern, type PatternIssue } from "./pattern";

/** plan 89: `text` is the subject or the body, by words (it only "mentions") */
export const TEXT_FIELDS = ["from", "fromDomain", "recipients", "subject", "body", "listId", "text"] as const;
/** plan 89: `matches` is a regular expression over the field's normalized text */
export const TEXT_OPS = ["contains", "equals", "startsWith", "endsWith", "matches"] as const;
/** The fields a pattern may run on: not bodies (large, and FTS-backed). */
export const PATTERN_FIELDS = ["from", "fromDomain", "recipients", "subject", "listId"] as const;
/** plan 128: one place a rule sends mail: a folder is a place too */
export const LOCATION_ACTIONS = ["archive", "trash", "spam", "moveToFolder"] as const;

export type TextField = (typeof TEXT_FIELDS)[number];
export type TextOp = (typeof TEXT_OPS)[number];

const negate = z.boolean().optional();

export const textConditionSchema = z.object({
  field: z.enum(TEXT_FIELDS),
  op: z.enum(TEXT_OPS),
  value: z.string().trim().min(1).max(500),
  negate,
});

export const attachmentConditionSchema = z.object({
  field: z.literal("hasAttachment"),
  op: z.literal("is"),
  value: z.boolean(),
  negate,
});

export const accountConditionSchema = z.object({
  field: z.literal("account"),
  op: z.literal("is"),
  value: z.number().int().positive(),
  negate,
});

export const ageConditionSchema = z.object({
  field: z.literal("ageDays"),
  op: z.enum(["gt", "lt"]),
  value: z.number().int().min(0).max(36500),
  negate,
});

export const conditionSchema = z.union([
  textConditionSchema,
  attachmentConditionSchema,
  accountConditionSchema,
  ageConditionSchema,
]);

/** plan 116: a forward's address (the composer's recipient shape) */
const forwardAddress = z.object({ name: z.string().max(300), email: z.string().trim().max(320).refine(isValidEmail, "Invalid email address") });

export const actionSchema = z.union([
  z.object({ type: z.enum(["archive", "trash", "spam", "markRead", "star"]) }),
  z.object({ type: z.literal("addCategory"), categoryId: z.number().int().positive() }),
  // plan 116: new mail it matches is forwarded there (never mail it is applied to later, nor old mail)
  z.object({ type: z.literal("forward"), to: z.array(forwardAddress).min(1) }),
  // plan 128: into one of an account's folders. A key means nothing without its account, and only that account's mail moves
  z.object({ type: z.literal("moveToFolder"), accountId: z.number().int().positive(), folder: z.string().min(1).max(1000) }),
]);

export const filterRuleSchema = z
  .object({
    match: z.enum(["all", "any"]),
    conditions: z.array(conditionSchema).min(1).max(20),
    actions: z.array(actionSchema).min(1).max(6),
  })
  .superRefine((rule, ctx) => {
    const locations = rule.actions.filter((a) =>
      (LOCATION_ACTIONS as readonly string[]).includes(a.type),
    );
    if (locations.length > 1) ctx.addIssue(ruleIssue("filters.invalid.oneLocation", ["actions"]));
    rule.conditions.forEach((c, i) => {
      if (c.field === "text" && (c.op !== "contains" || c.negate)) ctx.addIssue(ruleIssue("filters.invalid.text", ["conditions", i]));
      if (c.field === "hasAttachment" || c.field === "account" || c.field === "ageDays" || c.op !== "matches") return;
      if (!(PATTERN_FIELDS as readonly string[]).includes(c.field)) ctx.addIssue(ruleIssue("filters.invalid.patternField", ["conditions", i]));
      else {
        const issue = checkPattern(c.value);
        if (issue) ctx.addIssue(ruleIssue(PATTERN_ISSUE[issue], ["conditions", i, "value"]));
      }
    });
    const seen = new Set<string>();
    rule.actions.forEach((action, i) => {
      const key = action.type === "addCategory" ? `cat:${action.categoryId}` : action.type;
      if (action.type === "forward" && JSON.stringify(action.to).length > FORWARD_ADDRESSES_MAX_CHARS) ctx.addIssue(ruleIssue("filters.invalid.forwardTooMany", ["actions", i]));
      if (seen.has(key)) ctx.addIssue(ruleIssue("filters.invalid.duplicate", ["actions", i]));
      seen.add(key);
    });
  });

const PATTERN_ISSUE = {
  syntax: "filters.invalid.pattern.syntax",
  length: "filters.invalid.pattern.length",
  unsupported: "filters.invalid.pattern.unsupported",
  complex: "filters.invalid.pattern.complex",
} as const satisfies Record<PatternIssue, TextKey>;

const RULE_ISSUES = [
  "filters.invalid.oneLocation",
  "filters.invalid.duplicate",
  "filters.invalid.text",
  "filters.invalid.patternField",
  "filters.invalid.forwardTooMany",
  ...Object.values(PATTERN_ISSUE),
] as const satisfies readonly TextKey[];
type RuleIssueKey = (typeof RULE_ISSUES)[number];

/** A rule check's issue: English text for the AI's repair loop and agents, the key for the filter builder (it says it in the user's language). */
function ruleIssue(key: RuleIssueKey, path: (string | number)[]) {
  return { code: "custom" as const, path, message: L(key).message, params: { i18n: key } };
}

/** What the filter builder says about an invalid rule: a rule check's own message, else "fill in every field". */
export function filterIssueKey(issues: readonly z.core.$ZodIssue[]): RuleIssueKey | "filters.incomplete" {
  const issue = issues[0];
  const key: unknown = issue?.code === "custom" ? issue.params?.i18n : undefined;
  return RULE_ISSUES.find((k) => k === key) ?? "filters.incomplete";
}

export type Condition = z.infer<typeof conditionSchema>;
export type TextCondition = z.infer<typeof textConditionSchema>;
export type FilterAction = z.infer<typeof actionSchema>;
export type FilterRule = z.infer<typeof filterRuleSchema>;

export interface Filter {
  id: number;
  name: string;
  enabled: boolean;
  source: "manual" | "ai" | "learned";
  /** plan 90: Terno made it when the user sorted mail (Settings lists it under "Created for you") */
  auto: boolean;
  rule: FilterRule;
  hits: number;
  createdAt: number;
  /** plan 116: its forward action is paused ("Stop" at the cap); saving it from the builder turns it on again */
  forwardPaused?: boolean;
}

/** What a filter's owner can change: an automatic write compares it before it writes (plan 90). */
export interface FilterState {
  name: string;
  enabled: boolean;
  rule: FilterRule;
  auto: boolean;
}

export const filterState = (f: Filter): FilterState => ({ name: f.name, enabled: f.enabled, rule: f.rule, auto: f.auto });
/** Two states are the same (a rule compared as stored). */
export const sameFilterState = (a: FilterState, b: FilterState): boolean =>
  a.name === b.name && a.enabled === b.enabled && a.auto === b.auto && JSON.stringify(a.rule) === JSON.stringify(b.rule);

/** A filter as a store saves it. */
export interface FilterSave {
  id?: number;
  name: string;
  enabled: boolean;
  source: Filter["source"];
  rule: FilterRule;
  learnedKey?: string;
  /** plan 90: false on insert when absent; an update keeps the stored value when absent */
  auto?: boolean;
  /** plan 90: a retarget keeps what the filter was applied to (old mail is never re-filed into the new target) */
  keepApplications?: boolean;
  /** plan 90: refused (CANCELLED) unless the filter is still exactly this (an edit made meanwhile wins) */
  expect?: FilterState;
}
