import { describe, expect, it } from "vitest";
import { aiCanRun, aiReady, AI_JOBS, routeFor, type AiJob } from "./ai-routing";
import type { AiSettings } from "./rpc/contract";

/** Plan 168: Terno picks the model. One table, read by the backend, the gates and Settings. */

const key = (over = {}) => ({ hasKey: true, keyHint: null, ...over });
const ai = (over: Partial<AiSettings> = {}) =>
  ({ provider: "none", model: "", baseURL: null, preset: null, hasKey: false, keyUnreadable: false, keyHint: null, keyOrigin: null, keyConfirmed: true, local: false, capabilities: null, profiles: {}, keys: {}, monthlyLimitUsd: 10, ...over }) as AiSettings;
const table = (settings: AiSettings) => Object.fromEntries(AI_JOBS.map((job) => [job, routeFor(job, settings) && `${routeFor(job, settings)!.provider}/${routeFor(job, settings)!.model}`]));

const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const LUNA = "openai/gpt-6-luna";

describe("on keys (Claude, OpenAI, Pro, Dev mode's Pro AI)", () => {
  it("both keys, and JEV: Pro's routing, as the rating records it", () => {
    expect(table(ai({ provider: "anthropic", keys: { anthropic: key(), openai: key(), jev: key() } }))).toEqual({
      summary: LUNA,
      writing: SONNET,
      voice: SONNET,
      reply: SONNET,
      intent: HAIKU,
      replyCheck: HAIKU,
      ask: SONNET,
      askPlan: HAIKU,
      followup: HAIKU,
      digest: HAIKU,
      filter: OPUS,
      categorize: "jev/jev-latest",
    });
  });

  it("only Claude: everything there, summaries on Haiku (they run on every new mail), filters and categories on Opus", () => {
    expect(table(ai({ provider: "anthropic", keys: { anthropic: key() } }))).toEqual({ summary: HAIKU, writing: SONNET, voice: SONNET, reply: SONNET, intent: HAIKU, replyCheck: HAIKU, ask: SONNET, askPlan: HAIKU, followup: HAIKU, digest: HAIKU, filter: OPUS, categorize: OPUS });
  });

  it("only OpenAI: every job on Luna, the one OpenAI model Terno knows the price of", () => {
    for (const route of Object.values(table(ai({ provider: "anthropic", keys: { openai: key() } })))) expect(route).toBe(LUNA);
  });

  it("which of the two is stored decides nothing, and neither does a saved model", () => {
    const keys = { anthropic: key(), openai: key() };
    expect(table(ai({ provider: "openai", model: "gpt-6-sol", keys }))).toEqual(table(ai({ provider: "anthropic", model: "claude-fable-5-1", keys })));
  });

  it("a task's choice saved before plan 168 is never read", () => {
    const old = ai({ provider: "anthropic", keys: { anthropic: key() }, tasks: { summary: { provider: "ollama", model: "local" }, writing: { provider: "openai", model: "x" } } } as Partial<AiSettings>);
    expect(routeFor("summary", old)).toEqual({ provider: "anthropic", model: "claude-haiku-5-5" });
    expect(routeFor("writing", old)).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
  });

  it("no key yet: nothing routes, and nothing can run", () => {
    for (const job of AI_JOBS) expect(routeFor(job, ai({ provider: "anthropic" })), job).toBeNull();
    expect(aiReady(ai({ provider: "anthropic" }))).toBe(false);
  });

  it("a key that can't be read, or is saved for another endpoint, leaves its jobs to the other key (Codex critique)", () => {
    expect(routeFor("summary", ai({ provider: "anthropic", keys: { anthropic: key(), openai: key({ keyUnreadable: true }) } }))).toEqual({ provider: "anthropic", model: "claude-haiku-5-5" });
    expect(routeFor("writing", ai({ provider: "anthropic", keys: { anthropic: key({ keyConfirmed: false }), openai: key() } }))).toEqual({ provider: "openai", model: "gpt-6-luna" });
    expect(routeFor("categorize", ai({ provider: "anthropic", keys: { anthropic: key(), jev: key({ keyUnreadable: true }) } }))).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
    expect(aiReady(ai({ provider: "anthropic", keys: { anthropic: key({ keyUnreadable: true }) } }))).toBe(false);
    expect(aiReady(ai({ provider: "anthropic", keyUnreadable: true, keys: { anthropic: key({ keyUnreadable: true }), openai: key() } }))).toBe(true);
  });
});

describe("on a local server or a service of the user's (Terno can't know its models)", () => {
  it.each(["ollama", "lmstudio", "compatible", "fake"] as const)("%s: the configured provider and the model the user set, for every job", (provider) => {
    const settings = ai({ provider, model: "qwen3:8b", baseURL: "http://127.0.0.1:8080/v1", preset: provider === "compatible" ? "custom" : null, keys: { openai: key(), anthropic: key() } });
    for (const job of AI_JOBS) expect(routeFor(job, settings), job).toEqual({ provider, model: "qwen3:8b" });
    expect(aiCanRun("summary", settings)).toBe(true);
  });

  it("JEV still categorizes with its key; nothing else goes there", () => {
    const settings = ai({ provider: "ollama", model: "m", keys: { jev: key() } });
    expect(routeFor("categorize", settings)).toEqual({ provider: "jev", model: "jev-latest" });
    expect(routeFor("summary", settings)).toEqual({ provider: "ollama", model: "m" });
  });

  it("a model, its endpoint and a needed key decide whether it can run", () => {
    expect(aiCanRun("writing", ai({ provider: "ollama", model: " " }))).toBe(false);
    expect(aiCanRun("writing", ai({ provider: "compatible", preset: "custom", model: "m" }))).toBe(false);
    expect(aiCanRun("writing", ai({ provider: "compatible", preset: "groq", model: "m" }))).toBe(false);
    expect(aiCanRun("writing", ai({ provider: "compatible", preset: "groq", model: "m", hasKey: true }))).toBe(true);
    expect(aiCanRun("writing", ai({ provider: "compatible", preset: "groq", model: "m", hasKey: true, keyConfirmed: false }))).toBe(false);
  });
});

describe("none, or only JEV", () => {
  it("only categorizing runs, on JEV with its key; keys left saved send nothing else", () => {
    const settings = ai({ keys: { jev: key(), openai: key(), anthropic: key() } });
    for (const job of AI_JOBS.filter((j): j is Exclude<AiJob, "categorize"> => j !== "categorize")) expect(routeFor(job, settings), job).toBeNull();
    expect(routeFor("categorize", settings)).toEqual({ provider: "jev", model: "jev-latest" });
    expect(aiCanRun("categorize", settings)).toBe(true);
    expect(aiReady(settings)).toBe(false);
  });
});
