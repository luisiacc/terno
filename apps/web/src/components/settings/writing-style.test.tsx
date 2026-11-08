// @vitest-environment jsdom
/**
 * Plan 161, pass 2 (the Codex review's second round): while a phrase's removal is out, the profile can't be edited, so
 * an editor opened on the old phrases can't save the removed one back. The backend's answer is held by the test.
 */
import type { WritingProfileView } from "@terno/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

const habits = { messages: 10, words: { median: 20, p80: 30 }, sentenceWords: 10, greetings: [], noGreeting: 0, signOffs: [], noSignOff: 0, exclamation: 0.1, emoji: 0, bullets: 0, lowercase: 0 };
const profile: WritingProfileView = { scope: "you", scopeKey: "you", language: "en", accountId: null, samples: 10, newSince: 0, edited: false, updatedAt: 1, habits: habits as never, phrases: ["let me know", "all the best"], judgment: null, model: null, provider: null };
let edited: ((v: WritingProfileView) => void) | null = null;
vi.mock("~/rpc/connection", () => ({
  client: {
    call: vi.fn(async (method: string, params: { scope?: string }) => {
      if (method === "writing.profiles.list") return { items: params.scope === "you" ? [profile] : [], next: null, status: { state: "ready", messages: 10, updatedAt: Date.now(), study: null } };
      if (method === "writing.profiles.edit") return new Promise((resolve) => (edited = resolve));
      return null;
    }),
    on: () => () => {},
    connectionVersion: 1,
  },
}));

const { default: WritingStyle } = await import("./writing-style");

it("Edit waits while a removal is out, then opens on what's left", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<WritingStyle />));
  const $ = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
  await act(async () => $("style-profile-examples-toggle").click());
  await act(async () => $("style-profile-example-remove").click());
  expect($("style-profile-edit").disabled).toBe(true);
  await act(async () => edited!({ ...profile, phrases: ["all the best"], edited: true }));
  expect($("style-profile-edit").disabled).toBe(false);
  await act(async () => $("style-profile-edit").click());
  expect((host.querySelector('[data-testid="style-edit-phrases"]') as HTMLTextAreaElement).value).toBe("all the best");
  await act(async () => root.unmount());
});
