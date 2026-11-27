import { loggedImapConnect } from "./login-log";
import { L } from "@terno/i18n";
import { createDemoProvider } from "./demo";
import { beginGmailRenewal } from "./gmail-renewal";
import { createGmailProvider, connectGmail } from "./gmail";
import { revokeGoogleToken } from "./google-revoke";
import { createImapProvider, type ImapProviderOptions } from "./imap";
import { connectMicrosoft, type MicrosoftEndpoints } from "./microsoft";
import { createGraphProvider } from "./graph-api";
import { buildRaw } from "./compose";
import { sendViaSmtp, verifySmtp } from "./smtp";
import { unhandled } from "@terno/core";
import { ProviderError, type ImapAccountConfig, type ProviderRegistry, type SendPayload } from "./types";
import { ImapFlow } from "imapflow";

export interface RegistryOptions {
  imap?: ImapProviderOptions;
  /** tests only: the demo provider sends through the real SMTP path to 127.0.0.1 on this port */
  demoSmtpPort?: number;
  /** unitsPerSecond: Gmail quota units a second (default Google's per-user limit; synthetic servers lift it) */
  gmail?: { endpoints?: Partial<import("./gmail").GmailEndpoints>; unitsPerSecond?: number };
  /** plan 259: a synthetic Microsoft (sign-in, token and Graph moved); requestsPerSecond: Graph's pace (synthetic servers lift it) */
  microsoft?: { endpoints?: Partial<MicrosoftEndpoints>; requestsPerSecond?: number };
}

/** The demo provider, except that a send is built and sent over SMTP to a local test server (the packaged smoke). */
function demoOverSmtp(ctx: Parameters<typeof createDemoProvider>[0], port: number) {
  const demo = createDemoProvider(ctx);
  return {
    ...demo,
    async execute(op: Parameters<typeof demo.execute>[0]) {
      if (op.kind !== "send") return demo.execute(op);
      await sendViaSmtp({ host: "127.0.0.1", port, secure: false, user: "smoke", password: "smoke", allowInsecure: true }, op.payload as SendPayload);
      return { providerMsgId: `smtp-${op.id}` };
    },
  };
}

/**
 * Production registry: real providers per account kind; accounts created by
 * the demo seed (config.demo) use the offline demo provider.
 */
export function createRegistry(options: RegistryOptions = {}): ProviderRegistry {
  return {
    create(ctx) {
      if (ctx.config.demo) return options.demoSmtpPort ? demoOverSmtp(ctx, options.demoSmtpPort) : createDemoProvider(ctx);
      const kind = ctx.account.kind;
      switch (kind) {
      case "gmail": return createGmailProvider(ctx, options.gmail);
      // plan 259: Outlook over Microsoft Graph; a send's MIME is nodemailer's, its Bcc kept (Graph reads the headers)
      case "outlook": return createGraphProvider(ctx, { ...options.microsoft, buildRaw: (payload) => buildRaw(payload, { keepBcc: true }) });
      case "imap": return createImapProvider(ctx, options.imap);
      default: return unhandled(kind);
      }
    },
    async verifyImap(config: ImapAccountConfig, password: string) {
      const c = new ImapFlow({
        host: config.imap.host,
        port: config.imap.port,
        secure: config.imap.secure,
        doSTARTTLS: options.imap?.allowInsecure ? false : config.imap.secure ? undefined : true,
        auth: { user: config.imap.user, pass: password },
        logger: false,
        tls: options.imap?.allowInsecure ? { rejectUnauthorized: false } : undefined,
        connectionTimeout: 15_000,
      });
      c.on("error", () => {});
      try {
        await loggedImapConnect(() => c.connect());
        await c.logout();
      } catch (error) {
        const e = error as { authenticationFailed?: boolean; message?: string };
        throw new ProviderError(e.authenticationFailed ? L("errors.imap.badLogin") : L("errors.imap.cannotConnect", { host: config.imap.host, detail: String(e.message) }), false);
      }
      try {
        await verifySmtp({ ...config.smtp, password, allowInsecure: options.imap?.allowInsecure });
      } catch (error) {
        throw new ProviderError(L("errors.smtp.cannotConnect", { host: config.smtp.host, detail: error instanceof Error ? error.message : String(error) }), false);
      }
    },
    connectGmail: (o) => connectGmail({ ...o, endpoints: options.gmail?.endpoints }),
    connectMicrosoft: (o) => connectMicrosoft({ ...o, endpoints: options.microsoft?.endpoints }),
    beginGmailRenewal: (o) => beginGmailRenewal({ ...o, endpoints: options.gmail?.endpoints }),
    // plan 125: a synthetic Google (endpoints moved) has no grant to withdraw, and must never reach the real one
    ...(!options.gmail?.endpoints && { revokeGoogle: revokeGoogleToken }),
  };
}
