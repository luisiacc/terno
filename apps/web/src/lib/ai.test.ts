import type { AiSettings, AppSettings } from "@terno/core/rpc";
import { setLocale, t } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { aiReady, askOffered, choiceLabel, draftingOffered, errorHelp, followupsOffered, OUTPUT_LABEL, presetLabel, privacyLine, providerName, repliesOffered, summariesOffered, todayOffered } from "./ai";

const ai = (over: Partial<AiSettings>) => ({ provider: "none", preset: null, baseURL: null, local: false, ...over }) as AiSettings;

describe("what the AI features offer (plan 147)", () => {
  const set = (over: Partial<AiSettings> = {}) => ({ provider: "none", model: "", preset: null, baseURL: null, local: false, hasKey: false, keyConfirmed: false, keyUnreadable: false, keys: {}, tasks: {}, ...over }) as AiSettings;
  const settings = (ai: AiSettings, over: Partial<AppSettings> = {}) => ({ ai, ask: { enabled: true }, followups: { enabled: true }, replies: { enabled: true }, devAi: false, ...over }) as AppSettings;
  const writing = [summariesOffered, draftingOffered, askOffered, todayOffered];
  const every = [...writing, followupsOffered, repliesOffered];
  const ownKey = set({ provider: "anthropic", model: "m", hasKey: true, keyConfirmed: true });

  it("a free install with nothing set up sees no writing feature", () => {
    for (const offered of writing) expect(offered({ devAi: null, settings: settings(set()) })).toBe(false);
    for (const offered of every) expect(offered({ devAi: null, settings: null })).toBe(false);
  });

  it("the user's own key or local model shows them, with no Pro (plan 85 decision 9)", () => {
    for (const offered of every) {
      expect(offered({ devAi: null, settings: settings(ownKey) })).toBe(true);
      expect(offered({ devAi: null, settings: settings(set({ provider: "ollama", model: "m", local: true })) })).toBe(true);
    }
  });

  it("on a local build the switch decides, whatever the profile has saved", () => {
    const devAi = { anthropic: true, openai: true, jev: true };
    for (const offered of every) {
      expect(offered({ devAi, settings: settings(ownKey) })).toBe(false);
      expect(offered({ devAi, settings: settings(set({ provider: "fake", model: "demo", local: true })) })).toBe(false);
      expect(offered({ devAi, settings: settings(ownKey, { devAi: true }) })).toBe(true);
    }
    // the switch on with only JEV's key: the overlay has no writing provider
    for (const offered of writing) expect(offered({ devAi, settings: settings(set({ keys: { jev: { hasKey: true, keyHint: null } } }), { devAi: true }) })).toBe(false);
  });

  it("summaries: an OpenAI key alone is enough, and a task's own choice never falls back", () => {
    const openai = { hasKey: true, keyHint: null };
    expect(summariesOffered({ devAi: null, settings: settings(set({ keys: { openai } })) })).toBe(true);
    const gone = { ...ownKey, tasks: { summary: { provider: "openai", model: "m" } } } as AiSettings;
    expect(summariesOffered({ devAi: null, settings: settings(gone) })).toBe(false);
    expect(summariesOffered({ devAi: null, settings: settings({ ...gone, keys: { openai } }) })).toBe(true);
  });

  it("each feature's own switch still holds", () => {
    expect(askOffered({ devAi: null, settings: settings(ownKey, { ask: { enabled: false } as AppSettings["ask"] }) })).toBe(false);
    expect(followupsOffered({ devAi: null, settings: settings(ownKey, { followups: { enabled: false } as AppSettings["followups"] }) })).toBe(false);
    expect(repliesOffered({ devAi: null, settings: settings(ownKey, { replies: { enabled: false } as AppSettings["replies"] }) })).toBe(false);
  });
});

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

  it("counts the AI as ready only when it can really run: a model, and its key where one is needed", () => {
    const keyed = { model: "m", hasKey: true, keyConfirmed: true, keyUnreadable: false };
    expect(aiReady(undefined)).toBe(false);
    expect(aiReady(ai({ provider: "none", model: "m" }))).toBe(false);
    // a local server needs only a model
    expect(aiReady(ai({ provider: "ollama", model: "" }))).toBe(false);
    expect(aiReady(ai({ provider: "ollama", model: "qwen3:8b", hasKey: false }))).toBe(true);
    expect(aiReady(ai({ provider: "compatible", preset: "custom", baseURL: "http://127.0.0.1:8080/v1", model: "m", hasKey: false }))).toBe(true);
    expect(aiReady(ai({ provider: "compatible", preset: null, baseURL: "http://127.0.0.1:8080/v1", model: "m", hasKey: false }))).toBe(true);
    // a compatible server without its address can't be reached (Codex review)
    expect(aiReady(ai({ provider: "compatible", preset: "custom", model: "m", hasKey: false }))).toBe(false);
    expect(aiReady(ai({ provider: "compatible", preset: "azure", model: "m", hasKey: true, keyConfirmed: true, keyUnreadable: false }))).toBe(false);
    expect(aiReady(ai({ provider: "compatible", preset: "azure", baseURL: "https://x.openai.azure.com/openai/v1", model: "m", hasKey: true, keyConfirmed: true, keyUnreadable: false }))).toBe(true);
    // a saved key that can't be opened fails even where a key is optional (Codex review)
    expect(aiReady(ai({ provider: "ollama", model: "qwen3:8b", hasKey: true, keyUnreadable: true }))).toBe(false);
    // a cloud provider needs its key, readable and confirmed for this endpoint
    expect(aiReady(ai({ provider: "anthropic", model: "claude-opus-5-5", hasKey: false }))).toBe(false);
    expect(aiReady(ai({ provider: "anthropic", ...keyed }))).toBe(true);
    expect(aiReady(ai({ provider: "openai", ...keyed, model: " " }))).toBe(false);
    expect(aiReady(ai({ provider: "openai", ...keyed, keyConfirmed: false }))).toBe(false);
    expect(aiReady(ai({ provider: "openai", ...keyed, keyUnreadable: true }))).toBe(false);
    expect(aiReady(ai({ provider: "compatible", preset: "groq", model: "m", hasKey: false }))).toBe(false);
    expect(aiReady(ai({ provider: "compatible", preset: "groq", ...keyed }))).toBe(true);
  });
});
