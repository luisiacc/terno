import { toErrorPayload } from "@terno/core/rpc";
import { ProviderError } from "@terno/mail/portable";
import { describe, expect, it } from "vitest";
import { webRegistry } from "./providers";

describe("webRegistry: what a browser can't connect says so in the catalog", () => {
  it("IMAP/SMTP: an English message with a key the renderer translates", async () => {
    const error = await webRegistry()
      .verifyImap({} as never, "")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(false);
    expect(toErrorPayload(error)).toMatchObject({
      message: "IMAP/SMTP needs the desktop app: a browser can’t open IMAP or SMTP connections.",
      i18n: { key: "web.provider.desktopOnly" },
    });
  });

  it("plan 259 (Codex review #6): Outlook says it isn't supported yet, never that it's IMAP", async () => {
    const provider = webRegistry().create({ account: { id: 1, kind: "outlook", email: "o@outlook.test" }, config: {} } as never);
    const error = await provider.sync({} as never).catch((e: unknown) => e);
    expect(toErrorPayload(error)).toMatchObject({ i18n: { key: "errors.microsoft.notYet" } });
  });

  it("Gmail's desktop sign-in points to the page's", async () => {
    const error = await webRegistry()
      .connectGmail({} as never)
      .catch((e: unknown) => e);
    expect(toErrorPayload(error)).toMatchObject({ i18n: { key: "web.provider.gmailInPage" } });
  });
});
