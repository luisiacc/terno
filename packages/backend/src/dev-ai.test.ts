/** Plan 146: Dev mode's Pro AI: an overlay on a local build's environment, gone as if it never was. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiError, createAi, DEFAULT_ANTHROPIC_MODEL, type CompletionRequest, type ModelTransport, type ProviderConfig } from "@terno/ai";
import { devAiKeys, JEV_DEFAULT_MODEL, SUMMARY_DEFAULT_MODEL, WRITING_CLAUDE_MODEL, type DevAiKeys } from "@terno/core";
import { createMemoryTransportPair, RpcClient, type AppSettings } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { exportMailbox } from "./import";

// a model list or a connection test that runs until it's told to stop, with nothing sent
vi.mock("@terno/ai", async (original) => {
  const untilStopped = (_config: unknown, signal: AbortSignal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped"))));
  return { ...(await original<typeof import("@terno/ai")>()), discoverModels: untilStopped, probe: untilStopped };
});

const ALL: DevAiKeys = { anthropic: "env-anthropic", openai: "env-openai", jev: "env-jev" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** Holds every request until its signal says stop: what a toggle has to reach. */
const hanging = (): ModelTransport => ({
  complete: (req: CompletionRequest) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new AiError("stopped", "cancelled")))),
});

async function start(devAi?: DevAiKeys) {
  const dir = mkdtempSync(join(tmpdir(), "terno-dev-ai-"));
  const built: ProviderConfig[] = [];
  const held: ModelTransport[] = [];
  const backend = new Backend({
    dbPath: join(dir, "u.db"),
    version: "t",
    cipher: plaintextCipher,
    providers: demoRegistry,
    autoSync: false,
    devAi,
    // what a task would run on, and with which key, with no request made
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    aiFactory: (config, options) => {
      built.push(config);
      held.push(options.wrapTransport!(hanging()));
      return createAi(config, { ...options, transport: hanging() });
    },
  });
  await backend.store.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const on = () => client.call("settings.update", { devAi: true });
  return { backend, client, built, held, on };
}

const aiOf = (s: AppSettings) => s.ai;

const JOBS = ["summary", "followup", "digest", "categorize", "voice", "reply", "replyCheck", "writing", "ask", "askPlan", "intent"] as const;
const LOCAL_MODEL = { ai: { provider: "ollama", baseURL: "http://127.0.0.1:9/v1", model: "qwen" } } as const;

describe("what runs follows what shows (plan 150)", () => {
  it("a local build with the switch off runs nothing, whatever is saved; a click's filter still can", async () => {
    const { backend, built, client } = await start(ALL);
    await client.call("settings.update", LOCAL_MODEL);
    for (const task of JOBS) await expect(backend.aiService.forTask(task), task).rejects.toMatchObject({ kind: "not_configured", message: expect.stringContaining("Dev mode") });
    expect(built).toEqual([]);
    await backend.aiService.forTask("filter");
    expect(built).toHaveLength(1);
  });

  it("the switch on, they run, with no restart", async () => {
    const { backend, built, client, on } = await start(ALL);
    await client.call("settings.update", LOCAL_MODEL);
    await on();
    for (const task of JOBS) await backend.aiService.forTask(task);
    expect(built.length).toBeGreaterThan(0);
  });

  it("any other build: its own provider runs them, and with none nothing does", async () => {
    const own = await start();
    await own.client.call("settings.update", LOCAL_MODEL);
    for (const task of JOBS) await own.backend.aiService.forTask(task);
    expect(own.built.length).toBeGreaterThan(0);
    const none = await start();
    for (const task of JOBS) await expect(none.backend.aiService.forTask(task), task).rejects.toMatchObject({ kind: "not_configured" });
    expect(none.built).toEqual([]);
  });

  it("a toggle reaches every job, those added after plan 146 too", async () => {
    const { backend, on } = await start(ALL);
    const replies = vi.spyOn(backend.replies, "settingsChanged");
    const today = vi.spyOn(backend.today, "settingsChanged");
    await on();
    expect(replies).toHaveBeenCalled();
    expect(today).toHaveBeenCalled();
  });

  it("a no read just before the switch came on doesn't arrive after it", async () => {
    const { backend, built, client } = await start(ALL);
    const settings = backend.store.settings as unknown as { get: (...a: unknown[]) => Promise<unknown> };
    const get = settings.get.bind(settings);
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const spy = vi.spyOn(settings, "get").mockImplementationOnce(async (...a) => {
      const value = await get(...a);
      await held;
      return value;
    });
    const pending = backend.aiService.forTask("writing");
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    await client.call("settings.update", { devAi: true });
    release();
    await pending;
    expect(built.at(-1)).toMatchObject({ id: "anthropic", apiKey: "env-anthropic" });
  });
});

describe("Dev mode's keys", () => {
  it("reads only what's set, and only those names", () => {
    expect(devAiKeys({ ANTHROPIC_API_KEY: " a ", OPENAI_API_KEY: "", JEV_API_KEY: undefined, OTHER: "x" })).toEqual({ anthropic: "a" });
  });
});

describe("outside a local build", () => {
  it("has no section, refuses the switch, and ignores a flag already stored", async () => {
    const { backend, client } = await start();
    expect((await client.call("app.bootstrap", {})).devAi).toBeNull();
    await expect(client.call("settings.update", { devAi: true })).rejects.toThrow();
    // a profile that was once used by a local build
    await backend.store.settings.update<Record<string, unknown>, void>("app", {}, (s) => ({ value: { ...s, devAi: true }, result: undefined }));
    const { settings } = await client.call("app.bootstrap", {});
    expect(settings.devAi).toBe(false);
    expect(settings.ai.fromEnv).toBeUndefined();
    expect(settings.ai.provider).toBe("none");
  });
});

describe("on a local build", () => {
  it("tells the renderer which variables are set, and never a value", async () => {
    const { client } = await start({ anthropic: "env-anthropic" });
    const boot = await client.call("app.bootstrap", {});
    expect(boot.devAi).toEqual({ anthropic: true, openai: false, jev: false });
    expect(boot.settings.devAi).toBe(false);
    expect(JSON.stringify(boot)).not.toContain("env-anthropic");
    expect(JSON.stringify(await client.call("settings.update", { devAi: true }))).not.toContain("env-anthropic");
    expect(JSON.stringify(await client.call("app.bootstrap", {}))).not.toContain("env-anthropic");
  });

  it("changes nothing until it's on", async () => {
    const { client } = await start(ALL);
    expect(aiOf((await client.call("app.bootstrap", {})).settings)).toMatchObject({ provider: "none", hasKey: false });
  });

  it("on, runs with no provider set up; off, gives back exactly what was saved", async () => {
    const { client, on } = await start(ALL);
    await client.call("settings.update", { ai: { provider: "ollama", baseURL: "http://127.0.0.1:9/v1", model: "qwen" } });
    await client.call("ai.setKey", { provider: "anthropic", value: "saved-anthropic-key" });
    const saved = aiOf((await client.call("app.bootstrap", {})).settings);

    const overlaid = aiOf(await on());
    expect(overlaid).toMatchObject({ fromEnv: true, provider: "anthropic", model: DEFAULT_ANTHROPIC_MODEL, hasKey: true, keyConfirmed: true, local: false, baseURL: null, keyHint: null });
    expect(overlaid.keys.openai).toEqual({ hasKey: true, keyHint: null });
    expect(overlaid.keys.jev).toEqual({ hasKey: true, keyHint: null });

    expect(aiOf(await client.call("settings.update", { devAi: false }))).toEqual(saved);
  });

  it("routes each task the way Pro will, on the environment's keys", async () => {
    const { backend, built, on } = await start(ALL);
    await on();
    const target = async (task: Parameters<typeof backend.aiService.forTask>[0]) => {
      await backend.aiService.forTask(task);
      const { id, model, apiKey } = built.at(-1)!;
      return { id, model, apiKey };
    };
    expect(await target("writing")).toEqual({ id: "anthropic", model: WRITING_CLAUDE_MODEL, apiKey: "env-anthropic" });
    expect(await target("summary")).toEqual({ id: "openai", model: SUMMARY_DEFAULT_MODEL, apiKey: "env-openai" });
    expect(await target("categorize")).toEqual({ id: "jev", model: JEV_DEFAULT_MODEL, apiKey: "env-jev" });
  });

  it("falls to OpenAI with no Anthropic key, and refuses summaries' default with no OpenAI one", async () => {
    const openai = await start({ openai: "env-openai" });
    expect(aiOf(await openai.on())).toMatchObject({ provider: "openai", model: SUMMARY_DEFAULT_MODEL, hasKey: true });
    const anthropic = await start({ anthropic: "env-anthropic" });
    await anthropic.on();
    await expect(anthropic.backend.aiService.forTask("summary")).rejects.toThrow();
  });

  it("with only JEV, categorizes and offers nothing that writes", async () => {
    const { backend, built, client, on } = await start({ jev: "env-jev" });
    await client.call("settings.update", { ai: { provider: "anthropic", model: "x" } });
    expect(aiOf(await on())).toMatchObject({ provider: "none", hasKey: false, model: "" });
    await backend.aiService.forTask("categorize");
    expect(built.at(-1)).toMatchObject({ id: "jev", apiKey: "env-jev" });
    await expect(backend.aiService.forTask("writing")).rejects.toThrow();
  });

  it("sends a key only to its provider's own endpoint", async () => {
    const { backend, built, client, on } = await start(ALL);
    await client.call("settings.update", { ai: { provider: "anthropic", baseURL: "https://elsewhere.example/v1", model: "m" } });
    await on();
    await backend.aiService.forTask("writing");
    expect(built.at(-1)!.baseURL).not.toContain("elsewhere");
    // even asked outright
    expect((await backend.aiService.config({ provider: "anthropic", model: "m", baseURL: "https://elsewhere.example/v1" })).baseURL).not.toContain("elsewhere");
  });

  it("drops a task's choice on a provider the environment doesn't hold, and keeps one it does", async () => {
    const { client, on } = await start({ anthropic: "env-anthropic" });
    await client.call("settings.update", { ai: { tasks: { summary: { provider: "ollama", model: "local" }, ask: { provider: "anthropic", model: "chosen" } } } });
    const { tasks } = aiOf(await on());
    expect(tasks.summary).toBeUndefined();
    expect(tasks.ask).toEqual({ provider: "anthropic", model: "chosen" });
  });

  it("won't save a key around the overlay, and leaves the saved one alone", async () => {
    const { backend, client, on } = await start(ALL);
    await client.call("ai.setKey", { provider: "openai", value: "saved-openai-key" });
    await on();
    await expect(client.call("ai.setKey", { provider: "openai", value: "another" })).rejects.toThrow(/environment/);
    expect(await backend.getSecret("ai:openai:apiKey")).toBe("saved-openai-key");
  });

  it("uses the saved key again once it's off", async () => {
    const { backend, built, client, on } = await start(ALL);
    await client.call("settings.update", { ai: { provider: "anthropic", model: "m" } });
    await client.call("ai.setKey", { provider: "anthropic", value: "saved-anthropic-key" });
    await on();
    await backend.aiService.forTask("filter");
    expect(built.at(-1)!.apiKey).toBe("env-anthropic");
    await client.call("settings.update", { devAi: false });
    await backend.aiService.forTask("filter");
    expect(built.at(-1)!.apiKey).toBe("saved-anthropic-key");
  });

  it("keeps the overlay and the switch out of an export", async () => {
    const { backend, client, on } = await start(ALL);
    await client.call("settings.update", { ai: { provider: "ollama", baseURL: "http://127.0.0.1:9/v1", model: "qwen" } });
    await on();
    const { settings } = await exportMailbox(backend);
    expect(settings.ai).toMatchObject({ provider: "ollama", model: "qwen" });
    expect(settings).not.toHaveProperty("devAi");
    expect(JSON.stringify(settings)).not.toContain("env-");
  });

  it("a task still working out its target when it's toggled starts over, and never reaches the old setup", async () => {
    const { backend, built, client } = await start(ALL);
    await client.call("settings.update", { ai: { provider: "ollama", baseURL: "http://127.0.0.1:9/v1", model: "qwen" } });
    const service = backend.aiService as unknown as { targetFor: (...a: unknown[]) => Promise<unknown> };
    const targetFor = service.targetFor.bind(service);
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const spy = vi.spyOn(service, "targetFor").mockImplementationOnce(async (...a) => {
      const target = await targetFor(...a);
      await held;
      return target;
    });
    const pending = backend.aiService.forTask("filter");
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    await client.call("settings.update", { devAi: true });
    release();
    await pending;
    expect(built.at(-1)).toMatchObject({ id: "anthropic", apiKey: "env-anthropic" });
  });

  it("toggling stops a model list and a connection test using the environment's key", async () => {
    const { backend, client, on } = await start(ALL);
    await on();
    const listing = backend.aiService.listModels({ provider: "anthropic" }).then(() => null, (e: unknown) => e);
    const testing = backend.aiService.test({ provider: "anthropic", model: "m" });
    await new Promise((r) => setTimeout(r, 20));
    await client.call("settings.update", { devAi: false });
    expect(await listing).toBeInstanceOf(Error);
    expect((await testing).ok).toBe(false);
  });

  it("toggling stops what's in flight, filters included, and revokes what a worker holds", async () => {
    const { backend, client, held, on } = await start(ALL);
    await on();
    const generating = backend.aiService.generateFilter("archive uber", "renderer").then(() => null, (e: unknown) => e);
    await backend.aiService.forTask("writing");
    await new Promise((r) => setTimeout(r, 20));
    await client.call("settings.update", { devAi: false });
    expect(await generating).toBeInstanceOf(Error);
    // a worker keeps the instance it got
    await expect(held.at(-1)!.complete({ signal: new AbortController().signal } as CompletionRequest)).rejects.toMatchObject({ kind: "cancelled" });
  });
});
