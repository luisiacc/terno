import type { AiSettings } from "@terno/core/rpc";
import { setLocale, t } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { choiceLabel, errorHelp, OUTPUT_LABEL, presetLabel, privacyLine, providerName } from "./ai";

const ai = (over: Partial<AiSettings>) => ({ provider: "none", preset: null, baseURL: null, local: false, ...over }) as AiSettings;

describe("AI labels and help", () => {
  afterEach(() => setLocale("en", en));

  it("keeps brand names and reads the rest in the current language", () => {
    expect(choiceLabel("ollama")).toBe("Ollama");
    expect(choiceLabel("local-server")).toBe("Local server");
    expect(presetLabel("groq")).toBe("Groq");
    expect(providerName(ai({ provider: "compatible", preset: "custom", local: false }))).toBe("OpenAI-compatible");
    expect(t(OUTPUT_LABEL.json_schema)).toBe("structured output ✓");
    setLocale("es", es);
    expect(choiceLabel("local-server")).toBe("Servidor local");
    expect(presetLabel("custom")).toBe("Personalizado");
    expect(choiceLabel("none")).toBe("Desactivada");
  });

  it("says what leaves the machine", () => {
    expect(privacyLine(ai({ provider: "none" }))).toBe("AI is off.");
    expect(privacyLine(ai({ provider: "ollama", local: true }))).toBe("Nothing leaves this Mac.");
    expect(privacyLine(ai({ provider: "anthropic" }))).toMatch(/^Sent to api\.anthropic\.com: .* Never the content of your messages\.$/);
    setLocale("es", es);
    expect(privacyLine(ai({ provider: "ollama", local: true }))).toBe("Nada sale de este Mac.");
  });

  it("helps by the kind of failure, naming a local provider", () => {
    expect(errorHelp("unavailable", ai({ provider: "ollama", local: true }))).toBe("Open Ollama and check the endpoint.");
    expect(errorHelp("unavailable", ai({ provider: "openai" }))).toBe("Check your connection and the endpoint.");
    expect(errorHelp(undefined, ai({}))).toBeNull();
    setLocale("es", es);
    expect(errorHelp("unavailable", ai({ provider: "lmstudio", local: true }))).toBe("Abre LM Studio y comprueba el endpoint.");
  });
});
