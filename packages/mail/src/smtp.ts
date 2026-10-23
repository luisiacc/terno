import nodemailer from "nodemailer";
import { buildRaw, envelopeOf } from "./compose";
import { ProviderError, type SendPayload } from "./types";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  /** tests use self-signed / plaintext servers */
  allowInsecure?: boolean;
}

interface SmtpLikeError extends Error {
  code?: string;
  command?: string;
  responseCode?: number;
}

/**
 * Maps a nodemailer failure to retry semantics:
 *  - rejected recipients / auth / 5xx → permanent
 *  - failures before the message was handed over (connect, EHLO, AUTH, 4xx) → retry
 *  - connection lost during or after DATA → ambiguous: the server may have accepted it
 */
export function classifySmtpError(error: unknown, dataStarted = false): ProviderError {
  const e = error as SmtpLikeError;
  // Once the server said "354" the body may have been accepted even if the connection then died.
  if (dataStarted && !(e.responseCode && e.responseCode >= 400)) {
    return new ProviderError(`Connection lost while sending: ${e?.message ?? String(error)}`, false, true);
  }
  const message = e?.message ?? String(error);
  if (e.code === "EAUTH") return new ProviderError(`SMTP authentication failed: ${message}`, false);
  if (e.code === "EENVELOPE") return new ProviderError(`Recipient rejected: ${message}`, false);
  const duringData = e.command === "DATA" || e.command === "DATA_END" || /after DATA|message body/i.test(message);
  if (e.responseCode && e.responseCode >= 500) return new ProviderError(message, false);
  if (e.responseCode && e.responseCode >= 400 && !duringData) return new ProviderError(message, true);
  if (duringData || e.code === "ETIMEDOUT" && e.command === "DATA") return new ProviderError(`Connection lost while sending: ${message}`, false, true);
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED", "ECONNRESET"].includes(e.code ?? "")) return new ProviderError(message, true);
  return new ProviderError(message, true);
}

/** Sends a message; returns the raw source so the caller can APPEND it to Sent. */
export async function sendViaSmtp(config: SmtpConfig, payload: SendPayload): Promise<Buffer> {
  const raw = await buildRaw(payload);
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
    socketTimeout: 60_000,
    tls: config.allowInsecure ? { rejectUnauthorized: false } : undefined,
  });
  try {
    await transport.sendMail({ envelope: envelopeOf(payload), raw });
    return raw;
  } catch (error) {
    throw classifySmtpError(error, dataStarted);
  } finally {
    transport.close();
  }
}

export async function verifySmtp(config: SmtpConfig): Promise<void> {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
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
