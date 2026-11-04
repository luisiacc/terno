/** Which model runs a task, and what happens to what's running when its key goes. A scripted model: nothing leaves this process. */
import { AiError, type CompletionRequest } from "@terno/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanUp, setup } from "./test/writing-fixture";

afterEach(cleanUp);

const FAKE_KEY = "sk-ant-not-a-real-key-0000";

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

  it("with a writing target: the target's model", async () => {
    const t = await onClaude();
    await t.client.call("settings.update", { ai: { tasks: { writing: { provider: "anthropic", model: "claude-opus-5-5" } } } });
    expect((await t.backend.aiService.forTask("intent", { foreground: true })).model).toBe("claude-opus-5-5");
  });

  it("on another provider: that provider's model, never a Claude one", async () => {
    const t = await setup();
    const ai = await t.backend.aiService.forTask("intent", { foreground: true });
    expect(ai.providerId).toBe("fake");
    expect(ai.model).not.toMatch(/claude/);
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
