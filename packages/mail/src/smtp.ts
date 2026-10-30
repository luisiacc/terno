import { L } from "@terno/i18n";
import nodemailer from "nodemailer";
import { buildRaw, checkSmtpWire, envelopeOf } from "./compose";
import { isNetworkError } from "./net-errors";
import { ProviderAuthError, ProviderError, type SendPayload } from "./types";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  /** tests use self-signed / plaintext servers */
  allowInsecure?: boolean;
  /** tests only: shorter socket timeout (a stall after DATA still reads as ambiguous) */
  socketTimeoutMs?: number;
}

interface SmtpLikeError extends Error {
  code?: string;
  command?: string;
  responseCode?: number;
}

/**
 * Maps a nodemailer failure to retry semantics:
 *  - the login refused (535, or EAUTH without a temporary 4xx) → a sign-in to redo (plan 25): the send waits
 *  - rejected recipients / 5xx → permanent
 *  - failures before the message was handed over (connect, EHLO, a temporary AUTH 454, 4xx) → retry
 *  - connection lost during or after DATA → ambiguous: the server may have accepted it
 */
export function classifySmtpError(error: unknown, dataStarted = false): ProviderError {
  const e = error as SmtpLikeError;
  const message = e?.message ?? String(error);
  // the password was refused (EAUTH comes before DATA: never ambiguous); a 454 is "try again later"
  if (e.code === "EAUTH" && !(e.responseCode && e.responseCode >= 400 && e.responseCode < 500)) return new ProviderAuthError(L("errors.smtp.authFailed", { detail: message }));
  // An explicit reply code is a definitive answer: 5xx permanent, 4xx temporary (retry),
  // whether it came for a recipient (450/550) or after the body (451/554).
  if (e.responseCode && e.responseCode >= 500) return new ProviderError(e.code === "EENVELOPE" ? L("errors.smtp.recipientRejected", { detail: message }) : message, false);
  if (e.responseCode && e.responseCode >= 400) return new ProviderError(message, true);
  if (e.code === "EENVELOPE") return new ProviderError(L("errors.smtp.recipientRejected", { detail: message }), false);
  // No answer after the server said "354": it may have accepted the message.
  if (dataStarted) return new ProviderError(L("errors.smtp.connectionLost", { detail: message }), false, true);
  // before the body: the server couldn't be reached (the network, a VPN switch), nothing was handed over
  if (isNetworkError(error)) return ProviderError.network(message);
  return new ProviderError(message, true);
}

/** Sends a message; returns the raw source so the caller can APPEND it to Sent. */
export async function sendViaSmtp(config: SmtpConfig, payload: SendPayload, hooks?: { prepare?(raw: Uint8Array): Promise<Uint8Array>; accepted?(): void; beforeSubmission?(): Promise<void> }): Promise<{ raw: Buffer; rejected: string[]; recipientOutcomeUnknown?: true }> {
  let raw = await buildRaw(payload, { smtp: true });
  if (hooks?.prepare) {
    const prepared = await hooks.prepare(raw);
    raw = Buffer.from(prepared.buffer, prepared.byteOffset, prepared.byteLength);
  }
  if (hooks?.prepare) {
    await checkSmtpWire(raw);
    // Re-enter preparation's lifetime/credential fence after the yielding scan.
    const confirmed = await hooks.prepare(raw);
    const snapshot = Buffer.from(confirmed.buffer, confirmed.byteOffset, confirmed.byteLength);
    if (!snapshot.equals(raw)) throw new ProviderError(L("errors.sentCopy.unavailable"), false);
    raw = snapshot;
  }
  await hooks?.beforeSubmission?.();
  let accepted = false;
  // nodemailer reports a dropped connection as "CONN" no matter the stage, so we
  // follow the SMTP transcript to know whether the body was already handed over.
  let dataStarted = false;
  const watch = (entry: { tnx?: string } | undefined, message: string) => {
    // server replies arrive as their own log lines, e.g. "354 Go ahead"
    if ((entry?.tnx === "server" || entry?.tnx === undefined) && /^354\b/.test(String(message))) dataStarted = true;
  };
  const noop = () => {};
  const logger = { level: noop, trace: noop, debug: watch, info: noop, warn: noop, error: noop, fatal: noop };
  const transport = nodemailer.createTransport({
    logger: logger as never,
    debug: true,
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure && !config.allowInsecure,
    ignoreTLS: config.allowInsecure,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: config.socketTimeoutMs ?? 60_000,
    tls: config.allowInsecure ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const info = (await transport.sendMail({ envelope: envelopeOf(payload), raw })) as { rejected?: (string | { address: string })[] };
    accepted = true;
    hooks?.accepted?.();
    const rejected = (info.rejected ?? []).map((r) => (typeof r === "string" ? r : r.address));
    // nodemailer resolves when at least one recipient was accepted; report the rest
    return { raw, rejected };
  } catch (error) {
    if (accepted) return { raw, rejected: [], recipientOutcomeUnknown: true };
    throw classifySmtpError(error, dataStarted);
  } finally {
    try { transport.close(); } catch { /* Closing a transport cannot undo acceptance. */ }
  }
}

export async function verifySmtp(config: SmtpConfig): Promise<void> {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure && !config.allowInsecure,
    ignoreTLS: config.allowInsecure,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 15_000,
    tls: config.allowInsecure ? { rejectUnauthorized: false } : undefined,
  });
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}
