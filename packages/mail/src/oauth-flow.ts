// Plan 259: the interactive sign-in every OAuth provider shares (lifted out of withGoogleSignIn): one deadline covers
// headers and bodies, the caller's cancel ends it, answers are bounded JSON, and a token response is checked the same
// way for every provider. Each provider names its own words and checks its own scopes. Portable: the web uses Gmail's.
import type { Localized } from "@terno/i18n";
import { ProviderError } from "./types";

/** What a provider's sign-in says when it ends or can't finish. */
export interface SignInWords {
  cancelled(): Localized;
  timedOut(): Localized;
  unavailable(): Localized;
}

export interface SignInFlow {
  signal: AbortSignal;
  /** the work, or the flow's end (its deadline or its caller's cancel), whichever comes first */
  wait<T>(work: Promise<T>): Promise<T>;
}

/**
 * Plan 260: the sign-in's own end, its deadline or its caller's cancel. The person left the consent unfinished (or
 * the provider didn't answer in time): shown to them and logged, never reported as our bug. Not retryable: retrying is theirs.
 */
class SignInEnded extends ProviderError {
  override get expected(): boolean {
    return true;
  }
}

/** One deadline covers headers and bodies, including fetch implementations that ignore abort. */
export async function withSignIn<T>(options: { signal?: AbortSignal; timeoutMs?: number; words: SignInWords; keep?(error: unknown): boolean }, run: (flow: SignInFlow) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const cancel = () => abort.abort(new SignInEnded(options.words.cancelled(), false));
  const timer = setTimeout(() => abort.abort(new SignInEnded(options.words.timedOut(), false)), options.timeoutMs ?? 30_000);
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const signal = abort.signal;
  const wait = async <V,>(work: Promise<V>): Promise<V> => {
    let stop: (() => void) | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        stop = () => reject(signal.reason);
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      })]);
    } finally {
      if (stop) signal.removeEventListener("abort", stop);
    }
  };
  try {
    signal.throwIfAborted();
    const result = await run({ signal, wait });
    signal.throwIfAborted();
    return result;
  } catch (error) {
    // a provider's own verdict that must survive the flow's end (Google's quota)
    if (options.keep?.(error)) throw error;
    if (signal.aborted) throw signal.reason;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(options.words.unavailable(), true);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

/** A JSON object answer of at most `limit` bytes; anything else is the provider's invalid response. */
export async function readJsonObject(response: Response, flow: Pick<SignInFlow, "wait">, invalid: () => Error, limit = 65_536): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  let complete = false;
  try {
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let size = 0;
    while (true) {
      const chunk = await flow.wait(reader.read());
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw invalid();
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    complete = true;
    parts.push(decoder.decode());
    let value: unknown;
    try { value = JSON.parse(parts.join("")); } catch { throw invalid(); }
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
    return value as Record<string, unknown>;
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** An OAuth credential as it may travel: printable ASCII, bounded. */
export const oauthToken = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);

/**
 * RFC 6749 §5.1: an authorization-code answer every provider shares. A refresh token is required unless the caller
 * accepts its omission (an existing account that proves its stored grant instead); an omitted scope is the request's.
 */
export function validTokenResponse(tokens: Record<string, unknown>, options: { allowOmittedRefreshToken?: boolean } = {}): tokens is Record<string, unknown> & { access_token: string; token_type: string } {
  return oauthToken(tokens.access_token) &&
    (Object.hasOwn(tokens, "refresh_token") ? oauthToken(tokens.refresh_token) : !!options.allowOmittedRefreshToken) &&
    typeof tokens.token_type === "string" && tokens.token_type.toLowerCase() === "bearer" &&
    (tokens.expires_in === undefined || (typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0)) &&
    (tokens.scope === undefined || typeof tokens.scope === "string");
}
