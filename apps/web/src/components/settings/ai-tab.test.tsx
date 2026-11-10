// @vitest-environment jsdom
import type { AppSettings } from "@terno/core/rpc";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";
import { AiTab } from "./ai-tab";

/** Plan 168: Terno picks the model on Claude, OpenAI, Pro and Dev mode; only a local server or a service of the user's keeps a model field. */

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(), on: vi.fn(() => () => {}) } }));
vi.hoisted(() => Object.assign(globalThis, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }));

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  vi.useRealTimers();
});

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}

const key = { hasKey: true, keyHint: "abcd", keyUnreadable: false, keyConfirmed: true, keyOrigin: null };
const settings = (over: Partial<AppSettings["ai"]> = {}) =>
  ({
    summaries: { enabled: true },
    ask: { enabled: true },
    followups: { enabled: false, nudgeAfterDays: 3, scanAnswered: true },
    replies: { enabled: false },
    today: { digest: false, show: true },
    devAi: false,
    ai: { provider: "anthropic", model: "claude-opus-5-5", baseURL: null, preset: null, local: false, hasKey: true, keyHint: "abcd", keyOrigin: null, keyConfirmed: true, keyUnreadable: false, capabilities: null, keys: { anthropic: key }, profiles: {}, monthlyLimitUsd: 20, ...over },
  }) as unknown as AppSettings;

const calls = () => vi.mocked(client.call).mock.calls;
const answer = (tests: Record<string, unknown> = {}) =>
  vi.mocked(client.call).mockImplementation((async (method: string, params: { provider?: string }) => {
    if (method === "ai.providers") return { providers: [{ id: "anthropic", needsKey: true }, { id: "openai", needsKey: true }, { id: "ollama", needsKey: false }], presets: [] };
    if (method === "ai.test") return tests[params.provider!] ?? { ok: true, latencyMs: 120, capabilities: { output: "json_schema" } };
    if (method === "ai.listModels") return { models: [{ id: "qwen3:8b" }], tookMs: 1 };
    if (method === "today.notNewsletters") return { senders: [] };
    if (method === "writing.prefs.get") return { global: { enabled: true, instructions: "", useSentMail: true }, accounts: {} };
    if (method === "ai.usage") return { today: { requests: 0, usd: 0 }, month: { requests: 0, usd: 0 }, monthAsk: { requests: 0, usd: 0 }, monthBackgroundUsd: 0, estimated: false };
    return {};
  }) as never);

const $ = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("Settings → AI", () => {
  beforeEach(() => {
    vi.mocked(client.call).mockReset();
    answer();
  });

  it("Claude or OpenAI: both key rows, the routing line, and no model field or list, whatever model was saved", async () => {
    const s = settings({ keys: { anthropic: key, openai: { ...key, keyHint: "wxyz" } } });
    useApp.setState({ devAi: null, settings: s } as never);
    const host = await render(<AiTab settings={s} update={vi.fn() as never} />);
    expect($(host, "ai-provider")!.textContent).toContain("Claude or OpenAI");
    expect($(host, "ai-key-row-anthropic")).not.toBeNull();
    expect($(host, "ai-key-row-openai")).not.toBeNull();
    expect($(host, "ai-model")).toBeNull();
    expect($(host, "ai-models")).toBeNull();
    expect($(host, "ai-routing")!.textContent).toBe("Drafting, Ask your mail and rules run on Claude (Anthropic); summaries, follow-ups and the digest on OpenAI. Terno picks the model for each.");
    // nothing asks which models exist there: Terno doesn't offer them
    await act(async () => new Promise((r) => setTimeout(r, 450)));
    expect(calls().some(([method]) => method === "ai.listModels")).toBe(false);
  });

  it("with no key yet, says either will do; a key saved for OpenAI goes to OpenAI", async () => {
    const s = settings({ provider: "anthropic", hasKey: false, keyHint: null, keys: {} });
    useApp.setState({ devAi: null, settings: s } as never);
    const host = await render(<AiTab settings={s} update={vi.fn() as never} />);
    expect($(host, "ai-routing")!.textContent).toBe("Add either key, or both. Terno picks the model for each feature.");
    expect(($(host, "ai-test") as HTMLButtonElement).disabled).toBe(true);
    const input = $(host, "ai-key-openai") as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "sk-test-not-a-real-key");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    vi.mocked(client.call).mockImplementationOnce((async () => s) as never);
    await act(async () => input.form!.requestSubmit());
    expect(calls().find(([method]) => method === "ai.setKey")?.[1]).toEqual({ provider: "openai", preset: undefined, value: "sk-test-not-a-real-key" });
  });

  it("Test connection tries each saved key on the model Terno would use there, and says which one failed", async () => {
    answer({ openai: { ok: false, latencyMs: 80, error: { kind: "auth", message: "That key was refused" } } });
    const s = settings({ keys: { anthropic: key, openai: key } });
    useApp.setState({ devAi: null, settings: s } as never);
    const host = await render(<AiTab settings={s} update={vi.fn() as never} />);
    await act(async () => $(host, "ai-test")!.click());
    const asked = calls().filter(([method]) => method === "ai.test").map(([, p]) => p);
    expect(asked).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5-5", baseURL: undefined, preset: undefined },
      // with both keys OpenAI runs only Luna, so that's what its key is tested on (Codex review)
      { provider: "openai", model: "gpt-6-luna", baseURL: undefined, preset: undefined },
    ]);
    expect($(host, "ai-test-result")!.textContent!.trim()).toMatch(/^Claude \(Anthropic\): Connected · 120 ms/);
    expect($(host, "ai-test-error")!.textContent).toMatch(/^OpenAI: That key was refused/);
  });

  it("with only an OpenAI key, its test is on Sol, drafting's model there", async () => {
    answer({});
    const s = settings({ hasKey: false, keys: { openai: key } });
    useApp.setState({ devAi: null, settings: s } as never);
    const host = await render(<AiTab settings={s} update={vi.fn() as never} />);
    await act(async () => $(host, "ai-test")!.click());
    expect(calls().filter(([method]) => method === "ai.test").map(([, p]) => (p as { model: string }).model)).toEqual(["gpt-6-sol"]);
  });

  it("a key confirmed for its endpoint makes an old test's failure stale (Codex code review)", async () => {
    answer({ anthropic: { ok: false, latencyMs: 80, error: { kind: "not_configured", message: "Saved for another endpoint" } } });
    const moved = settings({ keyConfirmed: false, keys: { anthropic: { ...key, keyConfirmed: false, keyOrigin: "https://old.example.test" } } });
    useApp.setState({ devAi: null, settings: moved } as never);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<AiTab settings={moved} update={vi.fn() as never} />));
    cleanup = () => {
      act(() => root.unmount());
      host.remove();
    };
    await act(async () => $(host, "ai-test")!.click());
    expect($(host, "ai-test-error")).not.toBeNull();
    const confirmed = settings({ keys: { anthropic: { ...key, keyOrigin: "https://api.anthropic.com" } } });
    await act(async () => root.render(<AiTab settings={confirmed} update={vi.fn() as never} />));
    expect($(host, "ai-test-error")).toBeNull();
  });

  it("a local server keeps its model field and the list of what's installed: Terno can't know it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = settings({ provider: "ollama", model: "qwen3:8b", local: true, hasKey: false, keyHint: null, baseURL: null, keys: {} });
    useApp.setState({ devAi: null, settings: s } as never);
    const host = await render(<AiTab settings={s} update={vi.fn() as never} />);
    expect(($(host, "ai-model") as HTMLInputElement).value).toBe("qwen3:8b");
    expect($(host, "ai-key-row-anthropic")).toBeNull();
    expect($(host, "ai-routing")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(450));
    expect(calls().some(([method, p]) => method === "ai.listModels" && (p as { provider: string }).provider === "ollama")).toBe(true);
    expect(host.querySelectorAll('[data-testid="ai-model-option"]')).toHaveLength(1);
  });

  it("Dev mode's Pro AI: no provider, key or model to choose, and the line saying who runs what", async () => {
    const s = settings({ fromEnv: true, keys: { anthropic: key, openai: key, jev: key } });
    useApp.setState({ devAi: { anthropic: true, openai: true, jev: true }, settings: { ...s, devAi: true } } as never);
    const host = await render(<AiTab settings={{ ...s, devAi: true }} update={vi.fn() as never} />);
    for (const id of ["ai-provider", "ai-model", "ai-key-anthropic", "ai-key-openai", "ai-test"]) expect($(host, id), id).toBeNull();
    expect($(host, "ai-routing")!.textContent).toBe("Drafting, Ask your mail and rules run on Claude (Anthropic); summaries, follow-ups and the digest on OpenAI. Terno picks the model for each. Smart categories run on JEV.");
    expect(host.querySelector('[data-testid$="-target"]')).toBeNull();
  });
});
