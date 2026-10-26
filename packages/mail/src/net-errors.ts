/**
 * Plan 19: is this failure "the server couldn't be reached" (the network, a VPN switch, DNS)?
 * Those wait for the network instead of spending attempts, and a network change retries them
 * at once. A server's answer (NO/BAD, 4xx/5xx, a failed login) and a configuration problem (a
 * certificate) are never one: they read structured codes, never messages.
 */

/** Node socket and resolver errnos */
const ERRNOS = new Set(["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ETIMEDOUT", "EHOSTUNREACH", "EHOSTDOWN", "ENETUNREACH", "ENETDOWN", "ENETRESET", "EPIPE", "EADDRNOTAVAIL", "ENOTCONN"]);
/** imapflow's connection codes */
const IMAPFLOW = new Set(["NoConnection", "EConnectionClosed", "ETIMEOUT", "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT", "ClosedAfterConnectTLS", "ClosedAfterConnectText"]);
/** nodemailer's codes that always mean the connection (ESOCKET also wraps TLS errors: only with an errno under it) */
const NODEMAILER = new Set(["ECONNECTION", "EDNS"]);
/** undici's (Node fetch) socket codes, on the TypeError's cause */
const UNDICI = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CLOSED"]);

type ErrorLike = { code?: unknown; originalCode?: unknown; errno?: unknown; cause?: unknown; name?: unknown } | null | undefined;

/** the error and its causes, at most 4 deep */
function* chain(error: unknown): Generator<NonNullable<ErrorLike>> {
  let e = error as ErrorLike;
  for (let depth = 0; e && typeof e === "object" && depth < 4; depth++) {
    yield e;
    e = e.cause as ErrorLike;
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** True when the error (or a cause of it) is a connection-level failure. */
export function isNetworkError(error: unknown): boolean {
  for (const e of chain(error)) {
    const code = str(e.code);
    if (code && (ERRNOS.has(code) || IMAPFLOW.has(code) || NODEMAILER.has(code) || UNDICI.has(code))) return true;
    // nodemailer: ESOCKET/ETIMEDOUT carry what happened underneath (originalCode, errno); a TLS code there is configuration
    if (code === "ESOCKET" && [str(e.originalCode), str(e.errno)].some((c) => c !== null && ERRNOS.has(c))) return true;
    // our own deadline or reset abort, or the platform's timeout
    if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  }
  return false;
}

/**
 * fetch threw. Node's fetch says why on its cause (a network code, or a certificate code, which
 * isn't connectivity); a browser's TypeError says nothing more, and offline is what it usually means.
 */
export function isFetchNetworkFailure(error: unknown): boolean {
  if (isNetworkError(error)) return true;
  if (!(error instanceof TypeError)) return false;
  return !(error.cause && typeof error.cause === "object" && "code" in error.cause);
}

/**
 * Failures that can only happen before a request is written (a name that didn't resolve, a
 * connection refused or never established): a send that failed so never left, and is safe to
 * retry. Anything later (a reset, a timeout) may come after the server accepted it.
 */
const BEFORE_REQUEST = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "UND_ERR_CONNECT_TIMEOUT"]);

export function failedBeforeRequest(error: unknown): boolean {
  for (const e of chain(error)) if (typeof e.code === "string" && BEFORE_REQUEST.has(e.code)) return true;
  return false;
}
