import { messageOf } from "@terno/core";
import { L, plainText } from "@terno/i18n";
import { AiError, type AiProviderId } from "./types";

/** The error classes both Stainless-generated SDKs (Anthropic, OpenAI) export. */
interface SdkErrors {
  APIError: abstract new (...args: never[]) => Error & { status?: number | undefined };
  APIUserAbortError: abstract new (...args: never[]) => Error;
  APIConnectionError: abstract new (...args: never[]) => Error;
  APIConnectionTimeoutError: abstract new (...args: never[]) => Error;
}

function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let e = error; e && chain.length < 6; e = (e as { cause?: unknown }).cause) chain.push(e);
  return chain;
}

/** A schema the server can't (or won't) honour: the ladder downgrades instead of failing. */
const UNSUPPORTED_OUTPUT = /response_format|json_schema|json_object|structured output|schema|grammar/i;

export interface ErrorInfo {
  label: string;
  local: boolean;
  host: string;
  provider?: AiProviderId;
  /** the page's origin, in a browser */
  browserOrigin?: string;
}

/**
 * A browser hides why a request failed: a server that is down and one that
 * refuses this page's origin (CORS) both look like "Failed to fetch". Local
 * servers only answer origins they were told to allow, so say how.
 */
function browserConnectionError(info: ErrorInfo, origin: string): AiError {
  const where = { provider: info.label, host: info.host, origin };
  if (info.provider === "ollama") return new AiError(L("errors.ai.cannotConnectOllama", where), "unavailable");
  if (info.provider === "lmstudio") return new AiError(L("errors.ai.cannotConnectLmStudio", where), "unavailable");
  if (info.local) return new AiError(L("errors.ai.cannotConnectLocal", where), "unavailable");
  return new AiError(L("errors.ai.cannotConnectWeb", { provider: info.label, host: info.host }), "unavailable");
}

function connectionError(chain: unknown[], info: ErrorInfo): AiError {
  const refused = chain.some((e) => (e as { code?: string })?.code === "ECONNREFUSED");
  if (refused && info.local) return new AiError(L("errors.ai.notRunning", { provider: info.label, host: info.host }), "unavailable");
  if (info.browserOrigin) return browserConnectionError(info, info.browserOrigin);
  return new AiError(L("errors.ai.cannotConnect", { provider: info.label, host: info.host }), "unavailable");
}

/** the network policy refused the request inside our fetch: no socket was opened */
function policyError(chain: unknown[]): AiError | null {
  const policy = chain.find((e) => (e as { name?: string })?.name === "NetworkPolicyError");
  return policy ? new AiError(messageOf(policy), "blocked") : null;
}

/** Errors from a plain fetch (native discovery endpoints). */
export function mapNetworkError(error: unknown, info: ErrorInfo): AiError {
  if (error instanceof AiError) return error;
  const chain = causes(error);
  const name = (error as { name?: string })?.name;
  if (name === "AbortError") return new AiError(L("errors.ai.cancelled"), "cancelled");
  if (name === "TimeoutError") return new AiError(L("errors.ai.timeout", { provider: info.label }), "timeout");
  return policyError(chain) ?? connectionError(chain, info);
}

export function mapSdkError(error: unknown, sdk: SdkErrors, info: ErrorInfo): AiError {
  if (error instanceof AiError) return error;
  const chain = causes(error);
  const blocked = policyError(chain);
  if (blocked) return blocked;
  if (error instanceof sdk.APIUserAbortError) return new AiError(L("errors.ai.cancelled"), "cancelled");
  if (error instanceof sdk.APIConnectionTimeoutError) return new AiError(L("errors.ai.timeout", { provider: info.label }), "timeout");
  if (error instanceof sdk.APIConnectionError) return connectionError(chain, info);
  if (error instanceof sdk.APIError) {
    const status = error.status;
    if (status === 401 || status === 403) return new AiError(L("errors.ai.keyRejected", { provider: info.label }), "auth");
    if (status === 429) return new AiError(L("errors.ai.rateLimited", { provider: info.label }), "rate_limited");
    if ((status === 400 || status === 422) && UNSUPPORTED_OUTPUT.test(error.message)) return new AiError(`${info.label}: ${error.message}`, "unsupported");
    if (status === 404) return new AiError(L("errors.ai.notFound", { provider: info.label, detail: error.message }), "unavailable");
    return new AiError(`${plainText(info.label)}: ${error.message}`, "unavailable");
  }
  return new AiError(`${plainText(info.label)}: ${error instanceof Error ? error.message : String(error)}`, "unavailable");
}
