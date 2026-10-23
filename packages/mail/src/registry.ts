import { createDemoProvider } from "./demo";
import { createGmailProvider, connectGmail } from "./gmail";
import { createImapProvider, type ImapProviderOptions } from "./imap";
import { verifySmtp } from "./smtp";
import { ProviderError, type ImapAccountConfig, type ProviderRegistry } from "./types";
import { ImapFlow } from "imapflow";

export interface RegistryOptions {
  imap?: ImapProviderOptions;
  gmail?: { endpoints?: Partial<import("./gmail").GmailEndpoints> };
}

/**
 * Production registry: real providers per account kind; accounts created by
 * the demo seed (config.demo) use the offline demo provider.
 */
export function createRegistry(options: RegistryOptions = {}): ProviderRegistry {
  return {
    create(ctx) {
      if (ctx.config.demo) return createDemoProvider(ctx);
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
        throw new ProviderError(e.authenticationFailed ? "Usuario o contraseña incorrectos (IMAP)" : `No se pudo conectar a ${config.imap.host}: ${e.message}`, false);
      }
      try {
        await verifySmtp({ ...config.smtp, password, allowInsecure: options.imap?.allowInsecure });
      } catch (error) {
        throw new ProviderError(`No se pudo conectar al SMTP ${config.smtp.host}: ${error instanceof Error ? error.message : error}`, false);
      }
    },
    connectGmail: (o) => connectGmail({ ...o, endpoints: options.gmail?.endpoints }),
  };
}
