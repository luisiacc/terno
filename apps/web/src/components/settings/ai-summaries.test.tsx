// @vitest-environment jsdom
import type { AppSettings } from "@terno/core/rpc";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "~/rpc/connection";
import { AiUseGroup, SummariesGroup } from "./ai-summaries";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn() } }));
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
  ({ summaries: { enabled: false }, ai: { provider: "anthropic", model: "claude-sonnet-5-5", local: false, keys: {}, profiles: {}, tasks: {}, monthlyLimitUsd: 20, ...over } }) as unknown as AppSettings;

describe("summaries on Claude", () => {
  beforeEach(() => void vi.mocked(client.call).mockResolvedValue({} as never));

  it("Use Claude picks Haiku: this runs on every new mail, so never the model drafts use", async () => {
    const update = vi.fn(async () => {});
    const host = await render(<SummariesGroup settings={settings()} update={update as never} />);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="ai-summaries-use"]')!.click());
    expect(update).toHaveBeenCalledWith({ ai: { tasks: { summary: { provider: "anthropic", model: "claude-haiku-5-5" } } } });
  });

  it("another cloud provider keeps the model it's set to", async () => {
    const update = vi.fn(async () => {});
    const host = await render(<SummariesGroup settings={settings({ provider: "compatible", model: "some-model" })} update={update as never} />);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="ai-summaries-use"]')!.click());
    expect(update).toHaveBeenCalledWith({ ai: { tasks: { summary: { provider: "compatible", model: "some-model" } } } });
  });
});

describe("AI use this month", () => {
  it("says so when part of the figure is an estimate", async () => {
    vi.mocked(client.call).mockResolvedValue({ today: { requests: 1, usd: 0.5 }, month: { requests: 2, usd: 1.5 }, monthBackgroundUsd: 1.5, estimated: true } as never);
    const host = await render(<AiUseGroup settings={settings()} update={vi.fn() as never} />);
    expect(host.querySelector('[data-testid="ai-usage-value"]')!.textContent).toMatch(/2 requests · about \$1\.50/);
    expect(host.textContent).toMatch(/counted high/);
  });

  it("states the figure outright when every price is known", async () => {
    vi.mocked(client.call).mockResolvedValue({ today: { requests: 1, usd: 0.5 }, month: { requests: 2, usd: 1.5 }, monthBackgroundUsd: 1.5, estimated: false } as never);
    const host = await render(<AiUseGroup settings={settings()} update={vi.fn() as never} />);
    expect(host.querySelector('[data-testid="ai-usage-value"]')!.textContent).toMatch(/2 requests · \$1\.50/);
    expect(host.textContent).not.toMatch(/counted high/);
  });
});
