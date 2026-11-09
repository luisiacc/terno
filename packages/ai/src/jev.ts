import { L } from "@terno/i18n";
import { resolveBaseURL } from "./providers";
import { AiError, type AiTasks, type ClassifyInput, type ModelInfo, type ModelTransport, type ProviderConfig, type Usage } from "./types";
import type { AiOptions } from "./tasks";

/** The choice meaning none of the offered labels fits: JEV must be able to abstain. */
const NONE_LABEL = "none_of_these";

interface JevAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

const INFO = { label: "JEV" };

function failure(status: number): AiError {
  if (status === 401 || status === 403) return new AiError(L("errors.ai.keyRejected", { provider: INFO.label }), "auth");
  if (status === 429) return new AiError(L("errors.ai.rateLimited", { provider: INFO.label }), "rate_limited");
  if (status === 400 || status === 422) return new AiError(L("errors.ai.invalidOutput", { detail: String(status) }), "invalid_output");
  return new AiError(L("errors.ai.cannotConnect", { provider: INFO.label, host: "api.typesafe.ai" }), "unavailable");
}

async function call<T>(config: ProviderConfig, path: string, signal: AbortSignal | undefined, init: RequestInit = {}): Promise<T> {
  const base = resolveBaseURL(config)!.replace(/\/+$/, "");
  // the whole of it, through the last byte of the body: a stalled response would otherwise hold AiAssist's only drain
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  // what a body read may not notice itself
  const givenUp = new Promise<never>((_, reject) => {
    combined.addEventListener("abort", () => reject(combined.reason), { once: true });
  });
  givenUp.catch(() => {});
  try {
    const res = await Promise.race([
      config.fetch(`${base}${path}`, {
        ...init,
        signal: combined,
        redirect: "error",
        headers: { authorization: `Bearer ${config.apiKey ?? ""}`, "content-type": "application/json", ...init.headers },
      }),
      givenUp,
    ]);
    if (!res.ok) throw failure(res.status);
    return (await Promise.race([res.json(), givenUp])) as T;
  } catch (error) {
    if (error instanceof AiError) throw error;
    if (signal?.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
    if (deadline.aborted) throw new AiError(L("errors.ai.timeout", { provider: INFO.label }), "timeout");
    if (error instanceof SyntaxError) throw new AiError(L("errors.ai.invalidOutput", { detail: error.name }), "invalid_output");
    if ((error as { name?: string })?.name === "NetworkPolicyError") throw new AiError(L("errors.ai.cannotConnect", { provider: INFO.label, host: "api.typesafe.ai" }), "blocked");
    throw new AiError(L("errors.ai.cannotConnect", { provider: INFO.label, host: "api.typesafe.ai" }), "unavailable");
  }
}

/** Discovery and the connection test: free, and proves the key. */
export function jevModels(config: ProviderConfig): ModelTransport {
  return {
    complete: () => {
      // i18n-ignore: a caller's bug: JEV writes no text
      throw new AiError("JEV writes no text", "unsupported");
    },
    async listModels(signal) {
      const { models } = await call<{ models: { name: string; description?: string }[] }>(config, "/v1/models", signal);
      return models.map((m): ModelInfo => ({ id: m.name, label: m.name }));
    },
  };
}

/**
 * TypeSafe AI's System One model: picks among fixed options and reports a
 * probability for each. It writes nothing, so only `classify` works. Plain
 * fetch through the policy fetch: one endpoint isn't worth another SDK.
 */
export function jevTasks(config: ProviderConfig, options: AiOptions = {}): AiTasks {
  // the permits and the meter see each request as they see any other
  const transport: ModelTransport = {
    async complete(req) {
      const body = JSON.parse(typeof req.system === "string" ? req.system : "{}") as unknown;
      const response = await call<JevResponse>(config, "/v1/systemone", req.signal, { method: "POST", body: JSON.stringify(body) });
      const usage: Usage | undefined = response.usage ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } : undefined;
      return { text: JSON.stringify(response), stop: "end", usage };
    },
  };
  const wrapped = options.wrapTransport ? options.wrapTransport(transport) : transport;
  return {
    providerId: "jev",
    local: false,
    model: config.model,
    calibrated: true,
    contextTokens: null,
    endpoint: resolveBaseURL(config) ?? null,
    generateFilter() {
      // i18n-ignore: a caller's bug: forTask never offers JEV for filters
      throw new AiError("JEV can't write filters", "unsupported");
    },
    summarize() {
      // i18n-ignore: a caller's bug: the settings row never offers JEV for summaries
      throw new AiError("JEV writes no text", "unsupported");
    },
    compose() {
      // i18n-ignore: a caller's bug: the settings row never offers JEV for drafting
      throw new AiError("JEV writes no text", "unsupported");
    },
    judgeVoice() {
      // i18n-ignore: a caller's bug: the settings row never offers JEV for drafting
      throw new AiError("JEV writes no text", "unsupported");
    },
    digestNewsletters() {
      // i18n-ignore: a caller's bug: JEV only picks among choices
      throw new AiError("JEV writes no text", "unsupported");
    },
    needsReply() {
      // i18n-ignore: a caller's bug: JEV only picks among choices
      throw new AiError("JEV writes no text", "unsupported");
    },
    planAction() {
      // i18n-ignore: a caller's bug: JEV only picks among choices
      throw new AiError("JEV writes no text", "unsupported");
    },
    checkCandidates() {
      // i18n-ignore: a caller's bug: JEV only picks among choices
      throw new AiError("JEV writes no text", "unsupported");
    },
    readSentMail() {
      // i18n-ignore: a caller's bug: JEV only picks among choices
      throw new AiError("JEV writes no text", "unsupported");
    },
    planAsk() {
      // i18n-ignore: a caller's bug: JEV only picks among choices
      throw new AiError("JEV writes no text", "unsupported");
    },
    answerFromMail() {
      // i18n-ignore: a caller's bug: JEV only picks among choices
      throw new AiError("JEV writes no text", "unsupported");
    },
    parseIntent() {
      // i18n-ignore: a caller's bug: the settings row never offers JEV for drafting
      throw new AiError("JEV writes no text", "unsupported");
    },
    readDraft() {
      // i18n-ignore: a caller's bug: the settings row never offers JEV for drafting
      throw new AiError("JEV writes no text", "unsupported");
    },
    fill() {
      // i18n-ignore: a caller's bug: the settings row never offers JEV for drafting
      throw new AiError("JEV writes no text", "unsupported");
    },
    async classify<K extends string>(input: ClassifyInput<K>, signal?: AbortSignal) {
      if (input.labels.length === 0 || input.labels.length > 254) {
        // i18n-ignore: a caller's bug: the backend caps what it offers
        throw new AiError("classify needs 1 to 254 labels", "invalid_output");
      }
      const criteria: Record<string, string | null> = {};
      for (const label of input.labels) {
        const evidence = input.evidence?.[label];
        criteria[label] = evidence ? JSON.stringify(evidence) : null;
      }
      criteria[NONE_LABEL] = "None of the other options clearly fits";
      const results = [];
      for (const item of input.items) {
        const request = {
          model: config.model,
          state: { message: item.text },
          questions: { label: { type: "choice", instructions: `${input.instructions} Which option does \`message\` belong to?`, criteria } },
        };
        const completion = await wrapped.complete({
          // the wire body travels as the request's system text, so the wrapped transport stays one shape
          system: JSON.stringify(request),
          messages: [],
          output: "json_schema",
          maxTokens: 1,
          signal: signal ?? new AbortController().signal,
        });
        const answer = (JSON.parse(completion.text) as JevResponse).answers.label;
        if (!answer || typeof answer.choice !== "string") throw new AiError(L("errors.ai.emptyAnswer", { provider: INFO.label }), "invalid_output");
        const known = answer.choice !== NONE_LABEL && (input.labels as readonly string[]).includes(answer.choice);
        // the top option's probability, not `confidence`, which rescales by how many options there are
        const p = answer.probabilities?.[answer.choice] ?? 0;
        results.push({ id: item.id, label: known ? (answer.choice as K) : null, confidence: Math.max(0, Math.min(1, p)) });
      }
      return results;
    },
  };
}
