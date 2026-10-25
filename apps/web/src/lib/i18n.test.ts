import { getLocale, L, setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commitLanguage, installLanguageFollower, localized } from "./i18n";
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

describe("a language chosen in Settings", () => {
  // the little of the DOM applyLanguage touches
  const store = new Map<string, string>();
  vi.stubGlobal("document", { documentElement: { lang: "", classList: { add() {}, remove() {} } }, querySelectorAll: () => [] });
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  vi.stubGlobal("navigator", { languages: ["en-US"], language: "en-US" });

  it("switches at once and stays when the save works", async () => {
    await commitLanguage("es", "system", async () => {}, () => {});
    expect(getLocale()).toBe("es");
    expect(store.get("terno:language")).toBe("es");
    await commitLanguage("system", "es", async () => {}, () => {});
    expect(getLocale()).toBe("en");
  });

  it("says so and goes back when the save fails", async () => {
    const errors: unknown[] = [];
    await commitLanguage("es", "system", async () => Promise.reject(new Error("disk full")), (e) => errors.push(e));
    expect(errors).toHaveLength(1);
    expect(getLocale()).toBe("en");
    expect(store.get("terno:language")).toBe("system");
  });

  it("an older settings answer arriving while a choice is saved doesn't bounce the language", async () => {
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    let emit!: (language: "en" | "es" | "system") => void;
    const off = installLanguageFollower((listener) => ((emit = listener), () => {}));
    let finish!: () => void;
    const pending = commitLanguage("es", "en", () => new Promise<void>((resolve) => (finish = resolve)), () => {});
    // the answer to an earlier choice ("en") lands first
    emit("en");
    finish();
    await pending;
    await new Promise((r) => setTimeout(r, 0));
    expect(getLocale()).toBe("es");
    // after the saves, a change from elsewhere (an import) is followed again
    emit("en");
    await new Promise((r) => setTimeout(r, 0));
    expect(getLocale()).toBe("en");
    off();
  });

  it("a failed save doesn't undo a newer choice", async () => {
    let fail!: (e: Error) => void;
    const first = commitLanguage("es", "system", () => new Promise<void>((_, reject) => (fail = reject)), () => {});
    await commitLanguage("en", "es", async () => {}, () => {});
    fail(new Error("late"));
    await first;
    expect(getLocale()).toBe("en");
    expect(store.get("terno:language")).toBe("en");
  });
});
