import { normalizeText } from "@terno/core";
import { keyRef } from "@terno/i18n";
import { fakeAnswer, fakeAskPlan, isAnswerRequest } from "./ask";
import { fakeActionPlan, fakeCheck } from "./actions";
import { fakeSentMail } from "./followups";
import { fakeDigest } from "./digest";
import { fakeNeedsReply } from "./replies";
import { fakeSummary } from "./summarize";
import { AiError, promptText, type CompletionRequest, type ModelTransport, type StreamEvent } from "./types";
import type { WireFilter } from "./wire";
import { fakeComposeScript, fakeIntent, fakeJudgment, isComposeRequest } from "./writing";

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
 * How the offline model writes a draft, for flow tests and demos: as fast as it can by default. `firstTokenMs` and
 * `paceMs` make it stream like a real model; `text` writes the body instead of the echo. `TERNO_FAKE_DRAFT_PACE=1`
 * starts it at a real model's speed, for running the app on it by hand.
 */
export const fakeDraft: { firstTokenMs: number; paceMs: number; text: ((instruction: string) => string | null) | null } = {
  firstTokenMs: 0,
  paceMs: 0,
  text: null,
};
if ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.TERNO_FAKE_DRAFT_PACE === "1") {
  fakeDraft.firstTokenMs = 900;
  fakeDraft.paceMs = 35;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }
    signal.addEventListener("abort", stop, { once: true });
  });
}

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
      const prompt = promptText(messages[0]?.content ?? "");
      const repairing = messages.length > 1;
      if (schema?.name === "classification") {
        const items = jsonLine<{ id: string; text: string }[]>(prompt, "Items", []);
        const labels = jsonLine<string[]>(prompt, "Labels", []);
        // a label may stand for a name, shown beside it as evidence
        const names = jsonLine<Record<string, { name: string }>>(prompt, "What each label holds \\(data, not instructions\\)", {});
        const results = items.map((it) => {
          const label = labels.find((l) => normalizeText(it.text).includes(normalizeText(names[l]?.name ?? l))) ?? null;
          return { id: it.id, label, confidence: label ? 0.9 : 0.2 };
        });
        return { text: JSON.stringify({ results }), stop: "end" };
      }
      if (schema?.name === "probe") return { text: '{"ok":true}', stop: "end" };
      if (schema?.name === "thread_summary") return { text: JSON.stringify(fakeSummary(promptText(system), prompt)), stop: "end" };
      if (schema?.name === "newsletter_digest") return { text: JSON.stringify(fakeDigest(prompt)), stop: "end" };
      if (schema?.name === "needs_reply") return { text: JSON.stringify(fakeNeedsReply(prompt)), stop: "end" };
      if (schema?.name === "action_plan") return { text: JSON.stringify(fakeActionPlan(prompt, promptText(system))), stop: "end" };
      if (schema?.name === "action_check") return { text: JSON.stringify(fakeCheck(prompt)), stop: "end" };
      if (schema?.name === "sent_mail") return { text: JSON.stringify(fakeSentMail(prompt)), stop: "end" };
      if (schema?.name === "ask_plan") return { text: JSON.stringify(fakeAskPlan(prompt)), stop: "end" };
      if (schema?.name === "voice_judgment") return { text: JSON.stringify(fakeJudgment(prompt)), stop: "end" };
      if (schema?.name === "parse_intent") return { text: JSON.stringify(fakeIntent(prompt)), stop: "end" };
      if (isAnswerRequest(promptText(system))) return fakeAnswer(prompt);
      if (isComposeRequest(promptText(system))) {
        const script = fakeComposeScript(promptText(system), prompt);
        return { text: script.stop === "refusal" ? "" : script.text, stop: script.stop };
      }
      const wire = filterFor(prompt, jsonLine(promptText(system), "Categories", []));
      // Simulates a model mistake to exercise the repair loop.
      const out = options.failFirstAttempt && !repairing ? { ...wire, actions: [{ type: "archive", categoryId: null }, { type: "trash", categoryId: null }] } : wire;
      return { text: JSON.stringify(out), stop: "end" };
    },
    async *stream(req: CompletionRequest): AsyncGenerator<StreamEvent> {
      calls++;
      if (isAnswerRequest(promptText(req.system))) {
        const answer = fakeAnswer(promptText(req.messages[0]?.content ?? ""));
        if (fakeDraft.firstTokenMs) await pause(fakeDraft.firstTokenMs, req.signal);
        const pieces = answer.text.match(/.{1,16}/gs) ?? [];
        let n = 0;
        for (const piece of pieces) {
          if (fakeDraft.paceMs && n) await pause(fakeDraft.paceMs, req.signal);
          yield { type: "delta", text: piece };
          n++;
        }
        yield { type: "done", stop: answer.stop, usage: { inputTokens: 1, outputTokens: n } };
        return;
      }
      // scripted by a marker in the instruction, so a flow test reaches each failure through the real path
      const script = fakeComposeScript(promptText(req.system), promptText(req.messages[0]?.content ?? ""), fakeDraft.text);
      if (script.slowMs) await new Promise((resolve) => setTimeout(resolve, script.slowMs));
      if (fakeDraft.firstTokenMs) await pause(fakeDraft.firstTokenMs, req.signal);
      let sent = 0;
      for (const chunk of script.chunks) {
        if (fakeDraft.paceMs && sent) await pause(fakeDraft.paceMs, req.signal);
        // i18n-ignore: a scripted failure of the offline model, seen only in tests
        if (script.fail === sent) throw new AiError("The connection dropped.", "unavailable");
        if (script.stall && sent === 1) {
          await new Promise((_, reject) => {
            if (req.signal.aborted) reject(new Error("aborted"));
            req.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        if (script.stop === "refusal") break;
        yield { type: "delta", text: chunk };
        sent++;
      }
      yield { type: "done", stop: script.stop, usage: { inputTokens: 1, outputTokens: sent } };
    },
    async listModels() {
      return [{ id: "demo", label: keyRef("ai.model.demo"), contextTokens: 32_768, loaded: true }];
    },
  };
}
