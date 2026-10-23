import { createDemoProvider, ProviderError, type ProviderRegistry } from "@unica/mail/portable";

const DESKTOP_ONLY = "IMAP/SMTP necesita la app de escritorio: un navegador no puede abrir conexiones IMAP ni SMTP.";

/** Providers a browser can run: the demo mailbox and Gmail over REST (CORS). IMAP/SMTP needs raw sockets. */
export function webRegistry(): ProviderRegistry {
  return {
    create(ctx) {
      if (ctx.config.demo) return createDemoProvider(ctx);
      return {
        async verify() {
          throw new ProviderError(DESKTOP_ONLY, false);
        },
        async sync() {
          throw new ProviderError(DESKTOP_ONLY, false);
        },
        async execute() {
          throw new ProviderError(DESKTOP_ONLY, false);
        },
        async close() {},
      };
    },
    async verifyImap() {
      throw new ProviderError(DESKTOP_ONLY, false);
    },
    async connectGmail() {
      throw new ProviderError("En el navegador, Gmail se conecta con el inicio de sesión de Google de esta página.", false);
    },
  };
}
