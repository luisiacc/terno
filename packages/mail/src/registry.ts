import { L } from "@terno/i18n";
import { createDemoProvider } from "./demo";
import { beginGmailRenewal } from "./gmail-renewal";
import { createGmailProvider, connectGmail } from "./gmail";
import { createImapProvider, type ImapProviderOptions } from "./imap";
import { sendViaSmtp, verifySmtp } from "./smtp";
import { ProviderError, type ImapAccountConfig, type ProviderRegistry, type SendPayload } from "./types";
import { ImapFlow } from "imapflow";

export interface RegistryOptions {
  imap?: ImapProviderOptions;
  /** tests only: the demo provider sends through the real SMTP path to 127.0.0.1 on this port */
  demoSmtpPort?: number;
  gmail?: { endpoints?: Partial<import("./gmail").GmailEndpoints> };
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
      if (ctx.account.kind === "gmail") return createGmailProvider(ctx, options.gmail);
      return createImapProvider(ctx, options.imap);
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
        await c.connect();
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
    beginGmailRenewal: (o) => beginGmailRenewal({ ...o, endpoints: options.gmail?.endpoints }),
  };
}
