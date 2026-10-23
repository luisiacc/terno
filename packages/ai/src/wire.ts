import { filterRuleSchema, TEXT_FIELDS, TEXT_OPS, type FilterRule } from "@unica/core";
import { z } from "zod";
import type { FilterGenerationContext } from "./types";

/**
 * Flat schema handed to the model (structured outputs work best without unions).
 * It is converted to the strict FilterRule DSL and validated afterwards.
 */
export const wireFilterSchema = z.object({
  name: z.string().describe("Short human name for the filter, in the user's language"),
  explanation: z.string().describe("One sentence explaining what the filter does, in the user's language"),
  match: z.enum(["all", "any"]),
  conditions: z.array(
    z.object({
      field: z.enum([...TEXT_FIELDS, "hasAttachment", "account", "ageDays"]),
      op: z.enum([...TEXT_OPS, "is", "gt", "lt"]),
      value: z.string().describe("Text value; 'true'/'false' for hasAttachment; account id for account; days for ageDays"),
      negate: z.boolean(),
    }),
  ),
  actions: z.array(
    z.object({
      type: z.enum(["archive", "trash", "spam", "markRead", "star", "addCategory"]),
      categoryId: z.number().int().nullable().describe("Required for addCategory, otherwise null"),
    }),
  ),
});

export type WireFilter = z.infer<typeof wireFilterSchema>;

export type ConversionResult = { ok: true; name: string; explanation: string; rule: FilterRule } | { ok: false; error: string };

/** Converts and validates model output. Errors are phrased so they can be fed back for a repair attempt. */
export function convertWireFilter(wire: WireFilter, ctx: FilterGenerationContext): ConversionResult {
  const errors: string[] = [];
  const conditions = wire.conditions.map((c, i) => {
    const negate = c.negate || undefined;
    switch (c.field) {
      case "hasAttachment":
        if (c.value !== "true" && c.value !== "false") errors.push(`conditions[${i}]: hasAttachment value must be "true" or "false"`);
        return { field: c.field, op: "is", value: c.value === "true", negate };
      case "account": {
        const id = Number(c.value);
        if (!ctx.accounts.some((a) => a.id === id)) errors.push(`conditions[${i}]: account ${c.value} does not exist`);
        return { field: c.field, op: "is", value: id, negate };
      }
      case "ageDays":
        return { field: c.field, op: c.op, value: Number(c.value), negate };
      default:
        return { field: c.field, op: c.op, value: c.value, negate };
    }
  });
  const actions = wire.actions.map((a, i) => {
    if (a.type !== "addCategory") return { type: a.type };
    if (a.categoryId === null || !ctx.categories.some((c) => c.id === a.categoryId)) {
      errors.push(`actions[${i}]: addCategory needs an existing categoryId`);
    }
    return { type: a.type, categoryId: a.categoryId ?? 0 };
  });
  const parsed = filterRuleSchema.safeParse({ match: wire.match, conditions, actions });
  if (!parsed.success) errors.push(...parsed.error.issues.map((iss) => `${iss.path.join(".")}: ${iss.message}`));
  const name = wire.name.trim().slice(0, 120);
  if (!name) errors.push("name must not be empty");
  if (errors.length > 0 || !parsed.success) return { ok: false, error: errors.join("; ") };
  return { ok: true, name, explanation: wire.explanation.trim(), rule: parsed.data };
}

export function systemPrompt(ctx: FilterGenerationContext): string {
  return [
    "You turn a user's description of an email filter into a structured rule for the Única email client.",
    "Fields: from (sender name or address), fromDomain, recipients, subject, body (whole words/phrases), listId (mailing list id), hasAttachment, account, ageDays.",
    "Text ops: contains, equals, startsWith, endsWith. hasAttachment and account use op 'is'. ageDays uses 'gt' (older than N days) or 'lt' (newer than).",
    "Actions: archive, trash, spam, markRead, star, addCategory (with categoryId). Use at most one of archive/trash/spam.",
    "Prefer precise conditions (exact sender address or domain, list id) over broad words. Use negate for exclusions.",
    "Write name and explanation in the same language as the user's request.",
    `Today is ${new Date(ctx.now).toISOString().slice(0, 10)}.`,
    `Accounts: ${JSON.stringify(ctx.accounts)}`,
    `Categories: ${JSON.stringify(ctx.categories)}`,
  ].join("\n");
}
