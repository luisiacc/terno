import { AiError } from "./types";

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
}

function connectionError(chain: unknown[], info: ErrorInfo): AiError {
  const refused = chain.some((e) => (e as { code?: string })?.code === "ECONNREFUSED");
  if (refused && info.local) return new AiError(`No encontramos ${info.label} en ${info.host}. ¿Está abierto?`, "unavailable");
  return new AiError(`No se pudo conectar con ${info.label} (${info.host}).`, "unavailable");
}

/** the network policy refused the request inside our fetch: no socket was opened */
function policyError(chain: unknown[]): AiError | null {
  const policy = chain.find((e) => (e as { name?: string })?.name === "NetworkPolicyError") as Error | undefined;
  return policy ? new AiError(policy.message, "blocked") : null;
}

/** Errors from a plain fetch (native discovery endpoints). */
export function mapNetworkError(error: unknown, info: ErrorInfo): AiError {
  if (error instanceof AiError) return error;
  const chain = causes(error);
  const name = (error as { name?: string })?.name;
  if (name === "AbortError") return new AiError("Cancelado.", "cancelled");
  if (name === "TimeoutError") return new AiError(`${info.label} no respondió a tiempo.`, "timeout");
  return policyError(chain) ?? connectionError(chain, info);
}

export function mapSdkError(error: unknown, sdk: SdkErrors, info: ErrorInfo): AiError {
  if (error instanceof AiError) return error;
  const chain = causes(error);
  const blocked = policyError(chain);
  if (blocked) return blocked;
  if (error instanceof sdk.APIUserAbortError) return new AiError("Cancelado.", "cancelled");
  if (error instanceof sdk.APIConnectionTimeoutError) return new AiError(`${info.label} no respondió a tiempo.`, "timeout");
  if (error instanceof sdk.APIConnectionError) return connectionError(chain, info);
  if (error instanceof sdk.APIError) {
    const status = error.status;
    if (status === 401 || status === 403) return new AiError(`${info.label} rechazó la API key.`, "auth");
    if (status === 429) return new AiError(`${info.label} está limitando las peticiones; prueba en un momento.`, "rate_limited");
    if ((status === 400 || status === 422) && UNSUPPORTED_OUTPUT.test(error.message)) return new AiError(`${info.label}: ${error.message}`, "unsupported");
    if (status === 404) return new AiError(`${info.label}: modelo o endpoint no encontrado (${error.message}).`, "unavailable");
    return new AiError(`${info.label}: ${error.message}`, "unavailable");
  }
  return new AiError(`${info.label}: ${error instanceof Error ? error.message : String(error)}`, "unavailable");
}
