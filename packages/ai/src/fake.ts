import { normalizeText } from "@unica/core";
import { generateWithRepair, type WireCall } from "./generate";
import type { AiProvider } from "./types";
import type { WireFilter } from "./wire";

/**
 * Deterministic offline provider for tests, demos and visual flows. It
 * understands a handful of Spanish/English patterns so flows look real.
 */
export function createFakeProvider(options: { failFirstAttempt?: boolean } = {}): AiProvider {
  let calls = 0;
  const call: WireCall = async ({ prompt, ctx, repair }) => {
    calls++;
    const p = normalizeText(prompt);
    const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(prompt)?.[0];
    const domain = /\b([\w-]+\.(?:com|io|dev|app|mx|co|es|biz|top|click|win))\b/.exec(prompt)?.[1];
    const quoted = /"([^"]+)"|“([^”]+)”/.exec(prompt);
    const conditions: WireFilter["conditions"] = [];
    if (email) conditions.push({ field: "from", op: "equals", value: email.toLowerCase(), negate: false });
    else if (domain) conditions.push({ field: "fromDomain", op: "equals", value: domain.toLowerCase(), negate: false });
    if (quoted) conditions.push({ field: "subject", op: "contains", value: (quoted[1] ?? quoted[2])!, negate: false });
    if (/newsletter|boletin|bolet/.test(p)) conditions.push({ field: "listId", op: "contains", value: ".", negate: false });
    const days = /(\d+)\s*(dias|days)/.exec(p);
    if (days) conditions.push({ field: "ageDays", op: "gt", value: days[1]!, negate: false });
    if (/adjunto|attachment/.test(p)) conditions.push({ field: "hasAttachment", op: "is", value: "true", negate: false });
    if (conditions.length === 0) conditions.push({ field: "subject", op: "contains", value: prompt.split(/\s+/).slice(-1)[0] ?? "x", negate: false });

    const actions: WireFilter["actions"] = [];
    if (/spam/.test(p)) actions.push({ type: "spam", categoryId: null });
    else if (/borra|elimina|delete|trash|papelera/.test(p)) actions.push({ type: "trash", categoryId: null });
    else if (/archiv/.test(p)) actions.push({ type: "archive", categoryId: null });
    if (/leid|read/.test(p)) actions.push({ type: "markRead", categoryId: null });
    const category = ctx.categories.find((c) => p.includes(normalizeText(c.name)));
    if (category) actions.push({ type: "addCategory", categoryId: category.id });
    if (actions.length === 0) actions.push({ type: "archive", categoryId: null });

    const es = /[áéíóúñ¿¡]|\b(los|las|de|que|correos|todos)\b/i.test(prompt);
    const wire: WireFilter = {
      name: (email ?? domain ?? category?.name ?? (es ? "Filtro" : "Filter")).slice(0, 60),
      explanation: es ? `Aplica ${actions.map((a) => a.type).join(", ")} a los correos que coinciden.` : `Applies ${actions.map((a) => a.type).join(", ")} to matching mail.`,
      match: "all",
      conditions,
      actions,
    };
    // Simulates a model mistake to exercise the repair loop.
    if (options.failFirstAttempt && !repair) return { ...wire, actions: [{ type: "archive", categoryId: null }, { type: "trash", categoryId: null }] };
    return wire;
  };
  return {
    id: "fake",
    generateFilter: (prompt, ctx, signal) => generateWithRepair(call, prompt, ctx, signal),
    get calls() {
      return calls;
    },
  } as AiProvider & { calls: number };
}
