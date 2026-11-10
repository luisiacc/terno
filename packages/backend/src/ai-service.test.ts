/** Which model runs a task, and what happens to what's running when its key goes. A scripted model: nothing leaves this process. */
import { AiError, type CompletionRequest } from "@terno/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanUp, setup } from "./test/writing-fixture";
import type { Backend } from "./backend";

afterEach(cleanUp);

const FAKE_KEY = "sk-ant-not-a-real-key-0000";

/** A per-task choice as plan 131 stored it: the patch can't write one any more. */
async function storeTasks(backend: Backend, tasks: object) {
  await backend.store.settings.update<{ ai?: object }, void>("app", {}, (raw) => ({ value: { ...raw, ai: { ...raw.ai, tasks } }, result: undefined }));
}

async function onClaude(o: { key?: boolean } = {}) {
  const t = await setup();
  await t.client.call("settings.update", { ai: { provider: "anthropic", baseURL: "http://127.0.0.1:9", model: "claude-sonnet-5-5" } });
  if (o.key ?? true) await t.client.call("ai.setKey", { provider: "anthropic", value: FAKE_KEY });
  const hold = () => {
    t.model.answer = (req: CompletionRequest) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new AiError("stopped", "cancelled")), { once: true }));
  };
  const candidates = [{ id: "p0", name: "Tom" }];
  return { ...t, hold, candidates };
}

describe("forTask: who is this for", () => {
  it("on Anthropic with no writing target: Haiku, because it's a tiny question asked before the first word", async () => {
    const t = await onClaude();
    expect((await t.backend.aiService.forTask("intent", { foreground: true })).model).toBe("claude-haiku-5-5");
  });

  it("a task's own choice saved before plan 168 changes nothing, and the settings patch refuses a new one", async () => {
    const t = await onClaude();
    await storeTasks(t.backend, { writing: { provider: "anthropic", model: "claude-opus-5-5" }, summary: { provider: "anthropic", model: "claude-opus-5-5" } });
    expect((await t.backend.aiService.forTask("intent", { foreground: true })).model).toBe("claude-haiku-5-5");
    expect((await t.backend.aiService.forTask("writing", { foreground: true })).model).toBe("claude-sonnet-5-5");
    expect((await t.backend.aiService.forTask("summary")).model).toBe("claude-haiku-5-5");
    await expect(t.client.call("settings.update", { ai: { tasks: { writing: { provider: "anthropic", model: "x" } } } } as never)).rejects.toThrow();
    // still there, as it was: nothing deletes it
    expect((await t.backend.store.settings.get<{ ai?: { tasks?: object } }>("app", {})).ai?.tasks).toMatchObject({ writing: { model: "claude-opus-5-5" } });
  });

  it("a model saved on Claude's profile changes nothing either: Terno picks it", async () => {
    const t = await onClaude();
    await t.client.call("settings.update", { ai: { model: "claude-fable-5-1" } });
    expect((await t.backend.aiService.forTask("writing", { foreground: true })).model).toBe("claude-sonnet-5-5");
    expect((await t.backend.aiService.forTask("filter")).model).toBe("claude-opus-5-5");
  });

  it("on another provider: that provider's model, never a Claude one", async () => {
    const t = await setup();
    const ai = await t.backend.aiService.forTask("intent", { foreground: true });
    expect(ai.providerId).toBe("fake");
    expect(ai.model).not.toMatch(/claude/);
  });
});

describe("plan 168: the keys decide where a job goes", () => {
  it("a key added while a client is being built for the other provider: it starts over, and goes where routing now says (Codex critique)", async () => {
    const t = await setup();
    // OpenAI's profile on loopback, then Claude's: only OpenAI has a key, so drafting routes there for now
    await t.client.call("settings.update", { ai: { provider: "openai", baseURL: "http://127.0.0.1:9/v1" } });
    await t.client.call("settings.update", { ai: { provider: "anthropic", baseURL: "http://127.0.0.1:9" } });
    await t.client.call("ai.setKey", { provider: "openai", value: "sk-openai-not-a-real-key-0000" });
    expect((await t.backend.aiService.forTask("writing", { foreground: true })).providerId).toBe("openai");
    let release!: (v: string | null) => void;
    const reading = new Promise<string | null>((r) => (release = r));
    vi.spyOn(t.backend, "getSecret").mockImplementationOnce(() => reading);
    const building = t.backend.aiService.forTask("writing", { foreground: true });
    await new Promise((r) => setTimeout(r, 5));
    await t.client.call("ai.setKey", { provider: "anthropic", value: FAKE_KEY });
    release("sk-openai-not-a-real-key-0000");
    const ai = await building;
    expect(ai.providerId).toBe("anthropic");
    expect(ai.model).toBe("claude-sonnet-5-5");
  });

  it("a local server with no model set: refused before anything is built or sent (Codex critique)", async () => {
    const t = await setup();
    await t.client.call("settings.update", { ai: { provider: "ollama", baseURL: "http://127.0.0.1:9/v1", model: "" } });
    const config = vi.spyOn(t.backend.aiService, "config");
    await expect(t.backend.aiService.forTask("writing", { foreground: true })).rejects.toMatchObject({ kind: "not_configured", i18n: { key: "errors.ai.modelMissing" } });
    expect(config).not.toHaveBeenCalled();
    expect(t.model.requests).toHaveLength(0);
  });

  it("Claude or OpenAI chosen with no key yet: says which key to save, not that nothing is set up", async () => {
    const t = await onClaude({ key: false });
    await expect(t.backend.aiService.forTask("writing", { foreground: true })).rejects.toMatchObject({ kind: "not_configured", i18n: { key: "errors.ai.keyMissing" } });
  });
});

describe("a key taken back", () => {
  it("removing it aborts what's in flight, even on an instance a worker already holds, and that instance sends nothing more", async () => {
    const t = await onClaude();
    const ai = await t.backend.aiService.forTask("writing", { foreground: true });
    t.hold();
    const running = ai.parseIntent({ instruction: "tell tom", candidates: t.candidates }, new AbortController().signal).catch((e: unknown) => e);
    await vi.waitFor(() => expect(t.model.requests).toHaveLength(1));
    await t.client.call("ai.setKey", { provider: "anthropic", value: "" });
    expect(t.model.requests[0]!.signal.aborted).toBe(true);
    await expect(running).resolves.toMatchObject({ kind: "cancelled" });
    await expect(ai.parseIntent({ instruction: "tell tom", candidates: t.candidates }, new AbortController().signal)).rejects.toMatchObject({ kind: "cancelled" });
    expect(t.model.requests).toHaveLength(1);
  });

  it("replacing it does the same, and the next caller gets a working client on the new one", async () => {
    const t = await onClaude();
    const ai = await t.backend.aiService.forTask("writing", { foreground: true });
    t.hold();
    const running = ai.parseIntent({ instruction: "tell tom", candidates: t.candidates }, new AbortController().signal).catch((e: unknown) => e);
    await vi.waitFor(() => expect(t.model.requests).toHaveLength(1));
    await t.client.call("ai.setKey", { provider: "anthropic", value: `${FAKE_KEY}-new` });
    await expect(running).resolves.toMatchObject({ kind: "cancelled" });
    t.model.answer = () => ({ text: JSON.stringify({ recipient: null }), stop: "end" });
    const next = await t.backend.aiService.forTask("writing", { foreground: true });
    expect(next).not.toBe(ai);
    await expect(next.parseIntent({ instruction: "tell tom", candidates: t.candidates }, new AbortController().signal)).resolves.toMatchObject({ recipient: null });
  });

  it("another provider's key leaves this one's work alone", async () => {
    const t = await onClaude();
    const ai = await t.backend.aiService.forTask("writing", { foreground: true });
    t.hold();
    const running = ai.parseIntent({ instruction: "tell tom", candidates: t.candidates }, new AbortController().signal).catch((e: unknown) => e);
    await vi.waitFor(() => expect(t.model.requests).toHaveLength(1));
    await t.client.call("ai.setKey", { provider: "openai", value: "sk-openai-not-a-real-key-0000" });
    expect(t.model.requests[0]!.signal.aborted).toBe(false);
    await t.client.call("ai.setKey", { provider: "anthropic", value: "" });
    await running;
  });

  it("a client being built while the key changes isn't handed out holding the old one", async () => {
    const t = await onClaude();
    t.model.answer = () => ({ text: JSON.stringify({ recipient: null }), stop: "end" });
    let release!: (v: string | null) => void;
    const reading = new Promise<string | null>((r) => (release = r));
    vi.spyOn(t.backend, "getSecret").mockImplementationOnce(() => reading);
    const building = t.backend.aiService.forTask("writing", { foreground: true });
    await new Promise((r) => setTimeout(r, 5));
    await t.client.call("ai.setKey", { provider: "anthropic", value: `${FAKE_KEY}-new` });
    release(FAKE_KEY);
    const ai = await building;
    await expect(ai.parseIntent({ instruction: "tell tom", candidates: t.candidates }, new AbortController().signal)).resolves.toMatchObject({ recipient: null });
    expect(t.model.requests[0]!.signal.aborted).toBe(false);
  });
});
