import { aiCanRun } from "@terno/core";
import type { AiSettings, AppSettings } from "@terno/core/rpc";
import { setLocale, t } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { aiReady, askOffered, choiceLabel, choiceOf, disclosureLine, draftingOffered, errorHelp, mailDestinations, followupsOffered, helperElsewhere, OUTPUT_LABEL, presetLabel, privacyLine, providerName, repliesOffered, routeOf, routingLine, summariesOffered, todayOffered, writingModel, writingTarget } from "./ai";

const ai = (over: Partial<AiSettings>) => ({ provider: "none", preset: null, baseURL: null, local: false, ...over }) as AiSettings;

describe("what the AI features offer (plan 147)", () => {
  const set = (over: Partial<AiSettings> = {}) => ({ provider: "none", model: "", preset: null, baseURL: null, local: false, hasKey: false, keyConfirmed: false, keyUnreadable: false, keys: {}, ...over }) as AiSettings;
  const settings = (ai: AiSettings, over: Partial<AppSettings> = {}) => ({ ai, ask: { enabled: true }, followups: { enabled: true }, replies: { enabled: true }, devAi: false, ...over }) as AppSettings;
  const writing = [summariesOffered, draftingOffered, askOffered, todayOffered];
  const every = [...writing, followupsOffered, repliesOffered];
  const ownKey = set({ provider: "anthropic", model: "m", hasKey: true, keyConfirmed: true, keys: { anthropic: { hasKey: true, keyHint: null } } });

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

  it("plan 168: on Claude or OpenAI, either key is enough, whichever of the two is stored; AI off with a key stays off", () => {
    const openai = { hasKey: true, keyHint: null };
    for (const offered of every) expect(offered({ devAi: null, settings: settings(set({ provider: "anthropic", keys: { openai } })) })).toBe(true);
    for (const offered of writing) expect(offered({ devAi: null, settings: settings(set({ keys: { openai } })) })).toBe(false);
  });

  it("each feature's own switch still holds", () => {
    expect(askOffered({ devAi: null, settings: settings(ownKey, { ask: { enabled: false } as AppSettings["ask"] }) })).toBe(false);
    expect(followupsOffered({ devAi: null, settings: settings(ownKey, { followups: { enabled: false } as AppSettings["followups"] }) })).toBe(false);
    expect(repliesOffered({ devAi: null, settings: settings(ownKey, { replies: { enabled: false } as AppSettings["replies"] }) })).toBe(false);
  });
});

describe("what runs, by plan 168's routing", () => {
  const set = (over: Partial<AiSettings>) => ai({ model: "m", keys: {}, hasKey: false, keyConfirmed: true, keyUnreadable: false, profiles: {}, ...over });
  const claude = { hasKey: true, keyHint: null };
  const openai = { hasKey: true, keyHint: null };

  it("Codex review: a helper job on another provider than its feature is named for the disclosure, and only then", () => {
    const both = set({ provider: "anthropic", hasKey: true, keys: { anthropic: claude, openai } });
    expect(helperElsewhere("replyCheck", "reply", both)).toBe("OpenAI");
    expect(helperElsewhere("intent", "writing", both)).toBe("OpenAI");
    expect(helperElsewhere("replyCheck", "reply", set({ provider: "anthropic", hasKey: true, keys: { anthropic: claude } }))).toBeNull();
    expect(helperElsewhere("intent", "writing", set({ provider: "ollama", local: true }))).toBeNull();
  });

  it("summaries: wherever AI runs, a paid provider the user set up included; a model on this Mac keeps them here", () => {
    expect(aiCanRun("summary", set({}))).toBe(false);
    expect(aiCanRun("summary", set({ provider: "anthropic", hasKey: true, keys: { anthropic: claude } }))).toBe(true);
    expect(routeOf("summary", set({ provider: "anthropic", keys: { anthropic: claude } }))).toEqual({ provider: "anthropic", model: "claude-haiku-5-5" });
    expect(aiCanRun("summary", set({ provider: "ollama", local: true }))).toBe(true);
    // chosen, with no model picked yet: nothing to run on
    expect(aiCanRun("summary", set({ provider: "ollama", local: true, model: "" }))).toBe(false);
    // an OpenAI key under Ollama isn't where the user said mail goes
    expect(routeOf("summary", set({ provider: "ollama", local: true, keys: { openai } }))).toEqual({ provider: "ollama", model: "m" });
    // AI off: a key left saved runs nothing
    expect(aiCanRun("summary", set({ keys: { openai } }))).toBe(false);
  });

  it("drafting: a model on a local server or a service; on keys, Terno's model, whatever was saved", () => {
    expect(aiCanRun("writing", set({}))).toBe(false);
    expect(aiCanRun("writing", set({ provider: "ollama", local: true, model: " " }))).toBe(false);
    expect(aiCanRun("writing", set({ provider: "ollama", local: true }))).toBe(true);
    expect(aiCanRun("writing", set({ provider: "anthropic" }))).toBe(false);
    expect(aiCanRun("writing", set({ provider: "anthropic", hasKey: true, keys: { anthropic: claude } }))).toBe(true);
    expect(aiCanRun("writing", set({ provider: "compatible", preset: "custom" }))).toBe(false);
    const both = set({ provider: "openai", model: "", keys: { anthropic: claude, openai } });
    expect(writingModel(both)).toBe("claude-sonnet-5-5");
    expect(writingTarget(both)).toEqual({ ready: true, provider: "anthropic", local: false });
    expect(writingModel(set({ provider: "anthropic", model: "claude-fable-5-1", keys: { anthropic: claude } }))).toBe("claude-sonnet-5-5");
  });

  it("a key that can't be sent leaves the job to the other one, and with neither nothing is ready", () => {
    const both = (over: object) => set({ provider: "anthropic", hasKey: true, keys: { anthropic: { ...claude, ...over }, openai } });
    expect(routeOf("writing", both({ keyUnreadable: true }))).toEqual({ provider: "openai", model: "gpt-6-sol" });
    expect(routeOf("writing", both({ keyConfirmed: false }))).toEqual({ provider: "openai", model: "gpt-6-sol" });
    expect(aiCanRun("writing", set({ provider: "anthropic", keys: { anthropic: { ...claude, keyUnreadable: true } } }))).toBe(false);
  });

  it("the Claude or OpenAI item holds both, and names each by itself where it's named", () => {
    expect(choiceOf(set({ provider: "anthropic" }))).toBe("keys");
    expect(choiceOf(set({ provider: "openai" }))).toBe("keys");
    expect(providerName(set({ provider: "openai" }))).toBe("OpenAI");
    expect(choiceLabel("keys")).toBe("Claude or OpenAI");
  });

  it("says in one line who runs what, from the routing", () => {
    expect(routingLine(set({ provider: "ollama", local: true }))).toBeNull();
    expect(routingLine(set({ provider: "anthropic" }))).toBeNull();
    expect(routingLine(set({ provider: "anthropic", keys: { anthropic: claude } }))).toBe("Every AI feature runs on Claude (Anthropic). Terno picks the model for each.");
    expect(routingLine(set({ provider: "anthropic", keys: { openai } }))).toBe("Every AI feature runs on OpenAI. Terno picks the model for each.");
    expect(routingLine(set({ provider: "anthropic", keys: { anthropic: claude, openai, jev: claude } }))).toBe("Drafting, Ask your mail and rules run on Claude (Anthropic); summaries, follow-ups and the digest on OpenAI. Terno picks the model for each. Smart categories run on JEV.");
    setLocale("es", es);
    expect(routingLine(set({ provider: "anthropic", keys: { anthropic: claude, openai } }))).toBe("Redactar, Pregunta a tu correo y las reglas usan Claude (Anthropic); los resúmenes, los seguimientos y el resumen de boletines, OpenAI. Terno elige el modelo para cada una.");
    setLocale("en", en);
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
    // plan 162 (after ai162-r03): the provider by name, as every other AI surface says it, never its host
    expect(privacyLine(ai({ provider: "anthropic" }))).toMatch(/^Sent to Claude \(Anthropic\): .* Never the content of your messages\.$/);
    // plan 168 (Codex critique): where a filter's description really goes, OpenAI stored and only Claude's key saved
    expect(privacyLine(ai({ provider: "openai", keys: { anthropic: { hasKey: true, keyHint: null } }, profiles: {} } as Partial<AiSettings>))).toMatch(/^Sent to Claude \(Anthropic\): /);
    setLocale("es", es);
    expect(privacyLine(ai({ provider: "ollama", local: true }))).toBe("Nada sale de este Mac.");
  });

  it("plan 131: Settings → AI names every cloud provider mail may go to, by the backend's rules, and what goes", () => {
    const full = (over: Partial<AiSettings>) => ai({ keys: {}, model: "m", profiles: {}, ...over });
    const key = { hasKey: true, keyHint: null };
    expect(mailDestinations(full({ provider: "none" }))).toEqual([]);
    expect(mailDestinations(full({ provider: "ollama", local: true }))).toEqual([]);
    // on keys before one is saved: whichever comes first receives it
    expect(mailDestinations(full({ provider: "anthropic" }))).toEqual(["Claude (Anthropic)", "OpenAI"]);
    expect(mailDestinations(full({ provider: "anthropic", keys: { anthropic: key } }))).toEqual(["Claude (Anthropic)"]);
    expect(mailDestinations(full({ provider: "anthropic", keys: { anthropic: key, openai: key } }))).toEqual(["Claude (Anthropic)", "OpenAI"]);
    // plan 168: OpenAI's key under a local model sends nothing; AI off with keys saved sends nothing
    expect(mailDestinations(full({ provider: "ollama", local: true, keys: { openai: key } }))).toEqual([]);
    expect(mailDestinations(full({ provider: "none", keys: { openai: key, anthropic: key } }))).toEqual([]);
    expect(mailDestinations(full({ provider: "anthropic", keys: { anthropic: key, jev: key } }))).toEqual(["Claude (Anthropic)", "JEV"]);
    expect(mailDestinations(full({ provider: "ollama", local: true, keys: { jev: key } }))).toEqual(["JEV"]);
    // a stored task choice (plan 131) names nothing: nothing runs on it
    expect(mailDestinations(full({ provider: "ollama", local: true, tasks: { ask: { provider: "openai", model: "m" } } } as Partial<AiSettings>))).toEqual([]);
    // Codex critique: a local kind on another machine isn't local, and a routed profile is named by where it goes
    expect(mailDestinations(full({ provider: "ollama", local: false, baseURL: "http://gpu.lan:11434/v1" }))).toEqual(["gpu.lan:11434"]);
    expect(mailDestinations(full({ provider: "compatible", preset: "openrouter" }))).toEqual(["OpenRouter"]);
    expect(mailDestinations(full({ provider: "compatible", preset: "custom", baseURL: "https://ai.example.test/v1" }))).toEqual(["ai.example.test"]);
    expect(mailDestinations(full({ provider: "compatible", preset: "custom", baseURL: "http://127.0.0.1:8080/v1", local: true }))).toEqual([]);
    // Codex code review: a named provider at an endpoint that isn't its own says where, the other key's profile too
    expect(mailDestinations(full({ provider: "anthropic", keys: { anthropic: key, openai: key }, profiles: { openai: { model: "", baseURL: "https://relay.example.test/v1" } } }))).toEqual(["Claude (Anthropic)", "OpenAI (relay.example.test)"]);
    expect(mailDestinations(full({ provider: "compatible", preset: "openrouter", baseURL: "https://proxy.example.test/v1" }))).toEqual(["OpenRouter (proxy.example.test)"]);
    expect(mailDestinations(full({ provider: "openai", baseURL: "https://api.openai.com/v1", keys: { openai: key } }))).toEqual(["OpenAI"]);
    expect(disclosureLine(full({ provider: "none" }))).toBe("AI is off.");
    expect(disclosureLine(full({ provider: "ollama", local: true }))).toBe("Nothing leaves this Mac.");
    expect(disclosureLine(full({ provider: "openai", keys: { openai: key } }))).toBe("OpenAI receives a conversation’s text when you use an AI feature on it, and mail as it comes in or goes out for the background features you turn on below.");
    expect(disclosureLine(full({ provider: "anthropic", keys: { anthropic: key, openai: key } }))).toMatch(/^Claude \(Anthropic\) and OpenAI receive a conversation’s text/);
    setLocale("es", es);
    expect(disclosureLine(full({ provider: "anthropic", keys: { anthropic: key, openai: key } }))).toMatch(/^Claude \(Anthropic\) y OpenAI reciben el texto de una conversación/);
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
    const key = (over = {}) => ({ hasKey: true, keyHint: null, ...over });
    expect(aiReady(undefined)).toBe(false);
    expect(aiReady(ai({ provider: "none", model: "m" }))).toBe(false);
    // a local server needs only a model
    expect(aiReady(ai({ provider: "ollama", model: "" }))).toBe(false);
    expect(aiReady(ai({ provider: "ollama", model: "qwen3:8b", hasKey: false }))).toBe(true);
    expect(aiReady(ai({ provider: "compatible", preset: "custom", baseURL: "http://127.0.0.1:8080/v1", model: "m", hasKey: false }))).toBe(true);
    expect(aiReady(ai({ provider: "compatible", preset: null, baseURL: "http://127.0.0.1:8080/v1", model: "m", hasKey: false }))).toBe(true);
    // Codex critique: an optional key bound elsewhere is dropped by the backend, which runs without it
    expect(aiReady(ai({ provider: "compatible", preset: "custom", baseURL: "http://127.0.0.1:8080/v1", model: "m", hasKey: true, keyConfirmed: false }))).toBe(true);
    // a compatible server without its address can't be reached (Codex review)
    expect(aiReady(ai({ provider: "compatible", preset: "custom", model: "m", hasKey: false }))).toBe(false);
    expect(aiReady(ai({ provider: "compatible", preset: "azure", model: "m", hasKey: true, keyConfirmed: true, keyUnreadable: false }))).toBe(false);
    expect(aiReady(ai({ provider: "compatible", preset: "azure", baseURL: "https://x.openai.azure.com/openai/v1", model: "m", hasKey: true, keyConfirmed: true, keyUnreadable: false }))).toBe(true);
    // a saved key that can't be opened fails even where a key is optional (Codex review)
    expect(aiReady(ai({ provider: "ollama", model: "qwen3:8b", hasKey: true, keyUnreadable: true }))).toBe(false);
    // on keys: a key, readable and confirmed for its endpoint; no model needed, since Terno picks it (plan 168)
    expect(aiReady(ai({ provider: "anthropic", model: "claude-opus-5-5", hasKey: false, keys: {} }))).toBe(false);
    expect(aiReady(ai({ provider: "anthropic", ...keyed, keys: { anthropic: key() } }))).toBe(true);
    expect(aiReady(ai({ provider: "openai", ...keyed, model: " ", keys: { openai: key() } }))).toBe(true);
    expect(aiReady(ai({ provider: "openai", ...keyed, keys: { openai: key({ keyConfirmed: false }) } }))).toBe(false);
    expect(aiReady(ai({ provider: "openai", ...keyed, keys: { openai: key({ keyUnreadable: true }) } }))).toBe(false);
    expect(aiReady(ai({ provider: "compatible", preset: "groq", model: "m", hasKey: false }))).toBe(false);    expect(aiReady(ai({ provider: "compatible", preset: "groq", model: "m", hasKey: false }))).toBe(false);
    expect(aiReady(ai({ provider: "compatible", preset: "groq", ...keyed }))).toBe(true);
  });
});
