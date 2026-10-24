import { createDemoProvider, createGmailTokenBroker, ProviderError, type ProviderRegistry } from "@terno/mail/portable";

const DESKTOP_ONLY = "IMAP/SMTP necesita la app de escritorio: un navegador no puede abrir conexiones IMAP ni SMTP.";

/**
 * Providers a browser can run: the demo mailbox and Gmail over REST (CORS),
 * with Google's token model (the page signs in; tokens stay in this
 * worker's memory). IMAP/SMTP needs raw sockets.
 */
export function webRegistry(): ProviderRegistry {
  const gmail = createGmailTokenBroker();
  return {
    gmailTokens: gmail,
    create(ctx) {
      if (ctx.config.demo) return createDemoProvider(ctx);
      if (ctx.account.kind === "gmail") return gmail.provider(ctx);
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
