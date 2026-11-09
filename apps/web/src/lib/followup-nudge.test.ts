// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
const compose = vi.hoisted(() => ({ openStoredDraft: vi.fn(async () => {}), composeLanding: vi.fn(async () => ({ kind: "none" })) }));
const ai = vi.hoisted(() => ({ key: "k-nudge" as string | null }));
vi.mock("~/lib/compose", () => compose);
vi.mock("~/lib/ai-draft", () => ({ openRow: vi.fn(async () => {}), rowKeyOf: () => ai.key, setInstruction: vi.fn(), submit: vi.fn(async () => {}) }));
vi.mock("~/lib/drafts", async () => {
  const { create } = await import("zustand");
  return { editDraftRecipients: vi.fn(), useDrafts: create(() => ({ drafts: {} as Record<string, unknown> })) };
});

const { nudge, nudgeDraft, nudgeState, openNudge } = await import("./followup-nudge");
const { useDrafts } = await import("~/lib/drafts");

it("plan 161, pass 2 (Codex review): Open your follow-up opens that draft, by its key, not whichever the conversation shows", async () => {
  await nudge({ threadId: 7, personEmail: null, personName: null } as never);
  useDrafts.setState({ drafts: { "k-nudge": {}, "k-other": {} } as never });
  expect(nudgeDraft(7)).toBe("k-nudge");
  await openNudge(7);
  expect(compose.openStoredDraft).toHaveBeenCalledWith("k-nudge");
  expect(compose.composeLanding).not.toHaveBeenCalled();
  // gone (sent or discarded): there's no nudge to offer
  useDrafts.setState({ drafts: { "k-other": {} } as never });
  expect(nudgeDraft(7)).toBeNull();
});

it("plan 162 (after ai162-r03): Open your follow-up only once it's written, never while the composer asks or writes", () => {
  // a question for the user (who it's for): nothing is drafted yet
  expect(nudgeState("question")).toBe("waiting");
  expect(nudgeState("writing")).toBe("writing");
  expect(nudgeState("resolving")).toBe("writing");
  expect(nudgeState("strip")).toBe("written");
  expect(nudgeState(undefined)).toBe("written");
});
