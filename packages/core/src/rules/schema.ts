import { z } from "zod";

export const TEXT_FIELDS = ["from", "fromDomain", "recipients", "subject", "body", "listId"] as const;
export const TEXT_OPS = ["contains", "equals", "startsWith", "endsWith"] as const;
export const LOCATION_ACTIONS = ["archive", "trash", "spam"] as const;

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

export const actionSchema = z.union([
  z.object({ type: z.enum(["archive", "trash", "spam", "markRead", "star"]) }),
  z.object({ type: z.literal("addCategory"), categoryId: z.number().int().positive() }),
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
    if (locations.length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["actions"],
        message: "A filter can only move mail to one place (archive, trash or spam).",
      });
    }
    const seen = new Set<string>();
    for (const action of rule.actions) {
      const key = action.type === "addCategory" ? `cat:${action.categoryId}` : action.type;
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: ["actions"], message: `Duplicate action ${key}.` });
      }
      seen.add(key);
    }
  });

export type Condition = z.infer<typeof conditionSchema>;
export type TextCondition = z.infer<typeof textConditionSchema>;
export type FilterAction = z.infer<typeof actionSchema>;
export type FilterRule = z.infer<typeof filterRuleSchema>;

export interface Filter {
  id: number;
  name: string;
  enabled: boolean;
  source: "manual" | "ai" | "learned";
  rule: FilterRule;
  hits: number;
  createdAt: number;
}
