// @vitest-environment jsdom
import type { AppSettings } from "@terno/core/rpc";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";
import { AiUseGroup, AskGroup, DigestGroup, FollowupsGroup, SummariesGroup } from "./ai-summaries";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(), on: vi.fn(() => () => {}) } }));
vi.hoisted(() => Object.assign(globalThis, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }));

let cleanup: (() => void) | null = null;
afterEach(() => cleanup?.());

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

const settings = (over: Partial<AppSettings["ai"]> = {}) =>
  ({ summaries: { enabled: true }, ask: { enabled: true }, followups: { enabled: true, nudgeAfterDays: 3, scanAnswered: true }, today: { digest: true }, devAi: false, ai: { provider: "anthropic", model: "claude-sonnet-5-5", local: false, hasKey: true, keyConfirmed: true, keyUnreadable: false, keys: { anthropic: { hasKey: true, keyHint: null }, openai: { hasKey: true, keyHint: null } }, profiles: {}, monthlyLimitUsd: 20, ...over } }) as unknown as AppSettings;

describe("plan 168: no feature chooses its provider or model", () => {
  beforeEach(() => {
    vi.mocked(client.call).mockImplementation((async (method: string) => (method === "today.notNewsletters" ? { senders: [] } : method === "followups.scanOffer" ? { count: 0, usd: null } : {})) as never);
    useApp.setState({ devAi: null, settings: settings() } as never);
  });

  it("summaries, Ask, follow-ups and the digest show their switch and name where they run, with no select and no model field", async () => {
    const s = settings();
    const host = await render(
      <>
        <SummariesGroup settings={s} update={vi.fn() as never} />
        <AskGroup settings={s} update={vi.fn() as never} />
        <FollowupsGroup settings={s} update={vi.fn() as never} />
        <DigestGroup settings={s} update={vi.fn() as never} />
      </>,
    );
    for (const id of ["ai-summaries-switch", "ai-ask-switch", "ai-followups-switch", "ai-digest-switch"]) expect(host.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    expect(host.querySelectorAll('[role="combobox"]')).toHaveLength(1); // the nudge's days, which chooses no model
    expect(host.querySelector('[data-testid$="-target"], [data-testid$="-model"], [data-testid$="-model-input"], [data-testid$="-provider"]')).toBeNull();
    expect(host.textContent).toContain("Sends the text of each new conversation to OpenAI");
    expect(vi.mocked(client.call).mock.calls.some(([method]) => method === "ai.listModels")).toBe(false);
  });

  it("without AI, summaries' group isn't there: the provider group above is the way in", async () => {
    const off = settings({ provider: "none", hasKey: false, keys: {} });
    useApp.setState({ settings: off } as never);
    const host = await render(<SummariesGroup settings={off} update={vi.fn() as never} />);
    expect(host.querySelector('[data-testid="ai-summaries"]')).toBeNull();
  });
});

describe("AI use this month", () => {
  it("says so when part of the figure is an estimate", async () => {
    vi.mocked(client.call).mockResolvedValue({ today: { requests: 1, usd: 0.5 }, month: { requests: 2, usd: 1.5 }, monthAsk: { requests: 0, usd: 0 }, monthBackgroundUsd: 1.5, estimated: true } as never);
    const host = await render(<AiUseGroup settings={settings()} update={vi.fn() as never} />);
    expect(host.querySelector('[data-testid="ai-usage-value"]')!.textContent).toMatch(/2 requests · about \$1\.50/);
    expect(host.textContent).toMatch(/counted high/);
  });

  it("states the figure outright when every price is known", async () => {
    vi.mocked(client.call).mockResolvedValue({ today: { requests: 1, usd: 0.5 }, month: { requests: 2, usd: 1.5 }, monthAsk: { requests: 0, usd: 0 }, monthBackgroundUsd: 1.5, estimated: false } as never);
    const host = await render(<AiUseGroup settings={settings()} update={vi.fn() as never} />);
    expect(host.querySelector('[data-testid="ai-usage-value"]')!.textContent).toMatch(/2 requests · \$1\.50/);
    expect(host.textContent).not.toMatch(/counted high/);
  });
});
