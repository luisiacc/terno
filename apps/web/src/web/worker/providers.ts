import { L, type Localized } from "@terno/i18n";
import { createDemoProvider, createGmailTokenBroker, ProviderError, type ProviderRegistry } from "@terno/mail/portable";

/** A provider error in the catalog: its message is English, `i18n` lets the renderer show it in the user's language. */
const providerError = (text: Localized) => Object.assign(new ProviderError(text.message, false), { i18n: text });
const desktopOnly = () => providerError(L("web.provider.desktopOnly"));

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
      // plan 259: Outlook's own words, never IMAP's (its web sign-in is a later plan)
      if (ctx.account.kind === "outlook") {
        const notYet = async (): Promise<never> => { throw providerError(L("errors.microsoft.notYet")); };
        return { verify: notYet, sync: notYet, execute: notYet, async close() {} };
      }
      return {
        async verify() {
          throw desktopOnly();
        },
        async sync() {
          throw desktopOnly();
        },
        async execute() {
          throw desktopOnly();
        },
        async close() {},
      };
    },
    async verifyImap() {
      throw desktopOnly();
    },
    async connectGmail() {
      throw providerError(L("web.provider.gmailInPage"));
    },
    // plan 259: Microsoft's sign-in is the desktop's loopback; the web's own flow is a later plan (stage 4)
    async connectMicrosoft() {
      throw providerError(L("errors.microsoft.needsDesktop"));
    },
  };
}
