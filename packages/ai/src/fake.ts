import { normalizeText } from "@terno/core";
import type { ModelTransport } from "./types";
import type { WireFilter } from "./wire";

function filterFor(prompt: string, categories: { id: number; name: string }[]): WireFilter {
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
  const category = categories.find((c) => p.includes(normalizeText(c.name)));
  if (category) actions.push({ type: "addCategory", categoryId: category.id });
  if (actions.length === 0) actions.push({ type: "archive", categoryId: null });

  const es = /[áéíóúñ¿¡]|\b(los|las|de|que|correos|todos)\b/i.test(prompt);
  return {
    name: (email ?? domain ?? category?.name ?? (es ? "Filtro" : "Filter")).slice(0, 60),
    explanation: es ? `Aplica ${actions.map((a) => a.type).join(", ")} a los correos que coinciden.` : `Applies ${actions.map((a) => a.type).join(", ")} to matching mail.`,
    match: "all",
    conditions,
    actions,
  };
}

const jsonLine = <T,>(text: string, label: string, fallback: T): T => {
  const line = new RegExp(`^${label}: (.*)$`, "m").exec(text)?.[1];
  return line ? (JSON.parse(line) as T) : fallback;
};

/**
 * Deterministic offline model for tests, demos and visual flows. It reads the
 * same prompts a real model gets (so the ladder and repairs run for real) and
 * understands a handful of Spanish/English filter descriptions.
 */
export function fakeTransport(options: { failFirstAttempt?: boolean } = {}): ModelTransport & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async complete({ system, messages, schema }) {
      calls++;
      const prompt = messages[0]?.content ?? "";
      const repairing = messages.length > 1;
      if (schema?.name === "classification") {
        const items = jsonLine<{ id: string; text: string }[]>(prompt, "Items", []);
        const labels = jsonLine<string[]>(prompt, "Labels", []);
        const results = items.map((it) => {
          const label = labels.find((l) => normalizeText(it.text).includes(normalizeText(l))) ?? null;
          return { id: it.id, label, confidence: label ? 0.9 : 0.2 };
        });
        return { text: JSON.stringify({ results }), stop: "end" };
      }
      if (schema?.name === "probe") return { text: '{"ok":true}', stop: "end" };
      const wire = filterFor(prompt, jsonLine(system, "Categories", []));
      // Simulates a model mistake to exercise the repair loop.
      const out = options.failFirstAttempt && !repairing ? { ...wire, actions: [{ type: "archive", categoryId: null }, { type: "trash", categoryId: null }] } : wire;
      return { text: JSON.stringify(out), stop: "end" };
    },
    async listModels() {
      return [{ id: "demo", label: "Modelo de demostración", contextTokens: 32_768, loaded: true }];
    },
  };
}
