/**
 * Plan 41: the notification smoke's synthetic IMAP account talks plain IMAP
 * and SMTP to the test's own servers on this machine. Behind
 * TERNO_TEST_IMAP_INSECURE in the demo mailbox only (print-policy.ts), and
 * even then only for an account whose two servers are loopback: any other
 * account keeps TLS and certificate checks (Codex code review #6).
 */
import type { ImapAccountConfig, ProviderRegistry } from "@terno/mail";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export const isLoopbackHost = (host: unknown): boolean => typeof host === "string" && LOOPBACK.has(host.trim().toLowerCase());

/** Both servers on this machine. */
export function loopbackServers(config: unknown): boolean {
  const c = config as Partial<ImapAccountConfig> | null;
  return isLoopbackHost(c?.imap?.host) && isLoopbackHost(c?.smtp?.host);
}

/** `insecure` for accounts on loopback servers, `secure` for everything else. */
export function loopbackInsecure(secure: ProviderRegistry, insecure: ProviderRegistry): ProviderRegistry {
  return {
    ...secure,
    create: (ctx) => (loopbackServers(ctx.config) ? insecure : secure).create(ctx),
    verifyImap: (config, password) => (loopbackServers(config) ? insecure : secure).verifyImap(config, password),
  };
}
