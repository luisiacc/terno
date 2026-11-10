// @vitest-environment jsdom
import type { AppSettings } from "@terno/core/rpc";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useApp } from "~/state/app";
import { CategoriesTab } from "./categories-tab";

/** Plan 168 (Codex code review): the categorize switch names where its mail really goes, by the backend's routing. */

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => []), on: vi.fn(() => () => {}) } }));
vi.hoisted(() => Object.assign(globalThis, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }));

let cleanup: (() => void) | null = null;
afterEach(() => cleanup?.());

async function hintFor(ai: Partial<AppSettings["ai"]>) {
  const settings = { autoCategorize: "suggest", aiCategorize: false, ai: { provider: "anthropic", model: "", local: false, hasKey: false, keyConfirmed: true, keyUnreadable: false, keys: {}, profiles: {}, ...ai } } as unknown as AppSettings;
  useApp.setState({ categories: [], settings } as never);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<CategoriesTab settings={settings} update={vi.fn() as never} />));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  const row = host.querySelector('[data-testid="ai-categorize-switch"]')!.closest("[data-settings-row], div")!.parentElement!.parentElement!;
  return { text: row.textContent ?? "", disabled: host.querySelector(`[data-testid="ai-categorize-switch"]`)!.hasAttribute("data-disabled") };
}

describe("smart categories' switch", () => {
  const key = (over = {}) => ({ hasKey: true, keyHint: null, ...over });

  it("Claude stored, only an OpenAI key: says OpenAI, where it goes", async () => {
    expect((await hintFor({ keys: { openai: key() } })).text).toContain("Sends each one to OpenAI");
  });

  it("a JEV key that can't be read: says where it falls to, not JEV", async () => {
    const { text } = await hintFor({ keys: { anthropic: key(), jev: key({ keyUnreadable: true }) } });
    expect(text).toContain("Sends each one to Claude (Anthropic)");
    expect(text).not.toContain("JEV,");
  });

  it("Claude or OpenAI with no key yet: nothing to run it, so it's off", async () => {
    expect((await hintFor({ keys: {} })).disabled).toBe(true);
  });
});
