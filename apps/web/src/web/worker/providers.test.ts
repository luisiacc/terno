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

  it("Gmail's desktop sign-in points to the page's", async () => {
    const error = await webRegistry()
      .connectGmail({} as never)
      .catch((e: unknown) => e);
    expect(toErrorPayload(error)).toMatchObject({ i18n: { key: "web.provider.gmailInPage" } });
  });
});
