import { L, setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { localized } from "./i18n";
import { reasonText } from "./reasons";

afterEach(() => setLocale("en", en));

describe("text the backend sent with its catalog reference", () => {
  it("shows the reference in the active language, else the text as sent", () => {
    const ref = L("errors.gmailClientIdMissing");
    setLocale("es", es);
    expect(localized(ref.message, ref)).toBe(es["errors.gmailClientIdMissing"]);
    expect(localized("Server said no", undefined)).toBe("Server said no");
    expect(localized(null, null)).toBeNull();
    // a key this build doesn't know (a newer backend): the text as sent
    expect(localized("Something new", { key: "errors.fromTheFuture" })).toBe("Something new");
    // garbage from the wire is ignored
    expect(localized("As sent", { key: 3 } as never)).toBe("As sent");
  });

  it("reasons: descriptors translate, strings stored before stay as they are", () => {
    setLocale("es", es);
    expect(reasonText("remitente nuevo")).toBe("remitente nuevo");
    expect(reasonText({ k: "view.inbox" as never })).toBe("Entrada");
    expect(reasonText({ k: "reason.gone" as never })).toBe("reason.gone");
  });
});
