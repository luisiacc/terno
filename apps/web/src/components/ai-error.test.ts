// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

const { aiErrorCopy, hasAddress } = await import("./ai-error");
const { messageSource } = await import("./ai-card");
const { setLocale, t } = await import("@terno/i18n");
const en = (await import("@terno/i18n/locales/en")).default;
const es = (await import("@terno/i18n/locales/es")).default;

const ollama = { provider: "ollama", preset: null, local: true } as never;
const cloud = { provider: "openai", preset: null, local: false } as never;

afterEach(() => setLocale("en", en as never));

describe("plan 161, pass 2: one AI error, in plain words, never an address", () => {
  it("knows an address when it sees one", () => {
    for (const s of ["Couldn’t find Ollama at 127.0.0.1:60512. Is it open?", "Couldn’t connect to LM Studio (localhost:1234).", "http://my-box.lan/v1 refused", "Couldn’t connect to Custom (ai.example.com:8443).", "allow OLLAMA_ORIGINS=app://terno", "[::1]:11434"]) expect(hasAddress(s), s).toBe(true);
    for (const s of ["The model declined to write this.", "This conversation keeps changing. Try again in a moment.", "Draft ready, 84 words. 3:00 PM"]) expect(hasAddress(s), s).toBe(false);
  });

  it.each([["en", en], ["es", es]] as const)("no kind's words carry a host, a URL or a port (%s)", (id, locale) => {
    setLocale(id, locale as never);
    for (const kind of ["unavailable", "timeout", "auth", "rate_limited", "blocked", "invalid_output", "refused", "unsupported", "not_configured", "cancelled", "other", undefined] as const)
      for (const ai of [ollama, cloud]) {
        const copy = aiErrorCopy({ message: "Couldn’t find Ollama at 127.0.0.1:60512. Is it open?", kind }, ai);
        expect(hasAddress(`${copy.title} ${copy.help ?? ""}`), `${kind}`).toBe(false);
        expect(copy.title.length).toBeGreaterThan(0);
      }
  });

  it("a provider that can't be reached is said by name, with what to do", () => {
    const copy = aiErrorCopy({ message: "Couldn’t find Ollama at 127.0.0.1:60512. Is it open?", kind: "unavailable" }, ollama);
    expect(copy).toEqual({ title: "Couldn’t reach Ollama", help: "Open Ollama, then try again.", settings: true });
    expect(aiErrorCopy({ message: "x", kind: "unavailable" }, cloud).help).toBe("Check your connection, then try again.");
    expect(aiErrorCopy({ message: "x", kind: "auth" }, cloud)).toMatchObject({ title: "OpenAI didn’t accept the API key", settings: true });
  });

  it("the app's own sentence, with no address, is shown as it is", () => {
    expect(aiErrorCopy({ message: "The model declined to write this.", kind: "refused" }, ollama)).toMatchObject({ title: "The model declined to write this", help: "Rephrase it, or try another model." });
    expect(aiErrorCopy({ message: "This conversation keeps changing. Try again in a moment.", kind: undefined }, ollama)).toMatchObject({ title: "This conversation keeps changing. Try again in a moment", help: null, settings: false });
    // an unknown failure that names a host is the generic one
    expect(aiErrorCopy({ message: "fetch failed: 10.0.0.2:80", kind: "other" }, ollama)).toMatchObject({ title: t("ai.error.other"), help: t("ai.error.help.other") });
  });
});

describe("plan 161, pass 2: what the Codex review found", () => {
  it("6: no credit left is said as it is, not as a bad key", () => {
    const copy = aiErrorCopy({ message: "OpenAI says this account has no credit left. Add credit with OpenAI, or choose another provider in Settings → AI.", kind: "auth", key: "errors.ai.noCredit" }, cloud);
    expect(copy.title).toMatch(/no credit left/);
    expect(copy.help).toBeNull();
    expect(copy.settings).toBe(true);
  });

  it("7: a blocked redirect's host is never shown", () => {
    expect(hasAddress("Terno stopped a redirect to login.example.com")).toBe(true);
    const copy = aiErrorCopy({ message: "Terno stopped a redirect to login.example.com", kind: "blocked" }, cloud);
    expect(`${copy.title} ${copy.help}`).not.toContain("example.com");
  });

  it("5: it names the provider the task ran on, not Settings' first row", async () => {
    const { errorTarget } = await import("./ai-error");
    const settings = { provider: "ollama", preset: null, local: true } as never;
    const copy = aiErrorCopy({ message: "x", kind: "unavailable" }, errorTarget("anthropic", settings));
    expect(copy.title).toBe("Couldn’t reach Claude (Anthropic)");
    expect(copy.help).toBe("Check your connection, then try again.");
    expect(aiErrorCopy({ message: "x", kind: "unavailable" }, errorTarget("ollama", settings)).help).toBe("Open Ollama, then try again.");
  });
});

describe("plan 161, pass 2: where an AI line points", () => {
  const NOW = new Date(2026, 9, 22, 16, 0).getTime();
  const m = (id: number, name: string, email: string, date: number) => ({ id, from: { name, email }, date });
  it("named for where it goes, whose and when; nothing on a conversation of one message, which is on screen", () => {
    const messages = [m(1, "Arjun Ramírez", "arjun@x.test", new Date(2026, 9, 20, 9).getTime()), m(2, "Luis", "me@x.test", new Date(2026, 9, 22, 15).getTime())];
    // pass 3: "Arjun · Oct 20 →" read as a date, not as the message it opens
    expect(messageSource(messages, 1, ["ME@x.test"], NOW)).toBe("Arjun’s message, Oct 20");
    expect(messageSource(messages, 2, ["ME@x.test"], NOW)).toBe("Your message, 3:00 PM");
    expect(messageSource([messages[0]!], 1, [], NOW)).toBeNull();
    setLocale("es", es as never);
    expect(messageSource(messages, 1, ["ME@x.test"], NOW)).toMatch(/^Mensaje de Arjun, /);
    expect(messageSource(messages, 2, ["ME@x.test"], NOW)).toMatch(/^Tu mensaje, /);
  });
});
