// @vitest-environment jsdom
// Plan 158: a saved reply stays with its conversation. Its place there is still checked before its text shows (plan 44).
import { act } from "react";
import { describe, expect, it } from "vitest";
import { deferred, gate, setup } from "./app-harness";

const state = (h: { host: HTMLElement }) => h.host.querySelector('[data-testid="draft-slot"]')?.getAttribute("data-state");
const saves = () => gate.call.mock.calls.filter(([method]) => method === "drafts.save").length;
const listed = async (ids: number[]) => { const { useList } = await import("~/state/list"); useList.setState({ index: new Map(ids.map((id, i) => [id, i])) }); };

describe("away and back", () => {
  it("keeps its row's mark and stays out of the strip while away, then shows the same draft, one line, saving nothing", async () => {
    const h = await setup("split", true);
    try {
      await listed([7, 8]);
      const before = h.drafts.useDrafts.getState().drafts[h.key]!;
      expect(before.uiState).toBe("open");
      const saved = saves();
      await act(async () => h.app.setApp({ selectedId: 8 }));
      const { draftIndex, shownDraftKey, useDrafts } = h.drafts;
      // the row and the strip follow the conversation it left; its text doesn't show anywhere until the check (plan 44)
      expect(draftIndex(useDrafts.getState().drafts).written.has(7)).toBe(true);
      expect(shownDraftKey(useDrafts.getState().drafts, 7, null)).toBeNull();
      expect(h.host.querySelector('[data-testid="strip-item"]')).toBeNull();
      await act(async () => h.app.setApp({ selectedId: 7 }));
      for (let i = 0; i < 3; i++) await h.flush();
      expect(state(h)).toBe("collapsed");
      expect(h.host.querySelector('[data-testid="draft-collapsed"]')?.textContent).toContain("exact authored work");
      expect(h.host.querySelector('[data-testid="compose-body"]')).toBeNull();
      expect(document.activeElement).toBe(document.body);
      const after = useDrafts.getState().drafts[h.key]!;
      expect(after).toMatchObject({ id: before.id, generation: before.generation, revision: before.revision, localRev: before.localRev, bodyText: before.bodyText, presentationExpired: false });
      expect(saves()).toBe(saved);
    } finally { await h.cleanup(); }
  });

  it("offers no Reply and no draft while its source is being checked", async () => {
    const h = await setup("split", true), waiting = deferred<{ threadId: number; accountId: number }>();
    try {
      await listed([7, 8]);
      await act(async () => h.app.setApp({ selectedId: 8 }));
      gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? waiting.promise : {});
      await act(async () => h.app.setApp({ selectedId: 7 }));
      expect(state(h)).toBe("returning");
      expect(h.host.querySelector('[data-testid="quick-reply"]')).toBeNull();
      await act(async () => { waiting.resolve({ threadId: 7, accountId: 1 }); await waiting.promise; });
      for (let i = 0; i < 3; i++) await h.flush();
      expect(state(h)).toBe("collapsed");
    } finally { waiting.resolve({ threadId: 7, accountId: 1 }); await h.cleanup(); }
  });

  it.each([["moved", { threadId: 9, accountId: 1 }], ["gone", null], ["unknown", "reject"]] as const)("a source %s on the way back: the conversation offers Reply, the draft goes to the strip with its words", async (_name, context) => {
    const h = await setup("split", true);
    try {
      await listed([7, 8]);
      await act(async () => h.app.setApp({ selectedId: 8 }));
      gate.call.mockImplementation(async (method: string) => {
        if (method !== "drafts.sourceContext") return {};
        if (context === "reject") throw new Error("offline");
        return context;
      });
      await act(async () => h.app.setApp({ selectedId: 7 }));
      for (let i = 0; i < 3; i++) await h.flush();
      expect(state(h)).toBe("bar");
      const { draftIndex, useDrafts } = h.drafts;
      expect(draftIndex(useDrafts.getState().drafts).written.has(7)).toBe(false);
      expect(h.host.querySelector(`[data-testid="strip-item"][data-key="${h.key}"]`)).not.toBeNull();
      expect(useDrafts.getState().drafts[h.key]).toMatchObject({ id: 81, bodyText: "exact authored work" });
    } finally { await h.cleanup(); }
  });

  it("asks once however often the reader arrives, and not at all for a conversation with no draft", async () => {
    const h = await setup("split", true), waiting = deferred<{ threadId: number; accountId: number }>();
    try {
      await act(async () => h.app.setApp({ selectedId: 8 }));
      const lookups = () => gate.call.mock.calls.filter(([method]) => method === "drafts.sourceContext").length;
      const none = lookups();
      gate.call.mockImplementation(async (method: string) => method === "drafts.sourceContext" ? waiting.promise : {});
      expect(lookups()).toBe(none);
      await act(async () => h.app.setApp({ selectedId: 7 }));
      await act(async () => h.app.setApp({ selectedId: 8 }));
      await act(async () => h.app.setApp({ selectedId: 7 }));
      expect(lookups()).toBe(none + 1);
    } finally { waiting.resolve({ threadId: 7, accountId: 1 }); await h.cleanup(); }
  });

  it("isn't in the strip while its conversation is in the list, and is while it isn't", async () => {
    const h = await setup("split", true);
    try {
      await listed([8]);
      await act(async () => h.app.setApp({ selectedId: 8 }));
      expect(h.host.querySelector(`[data-testid="strip-item"][data-key="${h.key}"]`)).not.toBeNull();
      await act(async () => { await listed([7, 8]); });
      expect(h.host.querySelector(`[data-testid="strip-item"][data-key="${h.key}"]`)).toBeNull();
    } finally { await h.cleanup(); }
  });

  it("an open under way owns the draft: the check on arriving doesn't change it under it", async () => {
    const h = await setup("split", true), { openStoredDraft } = await import("~/lib/compose"), load = deferred<typeof h.detail>();
    try {
      await listed([8]);
      await act(async () => h.app.setApp({ selectedId: 8 }));
      gate.load.mockReturnValue(load.promise);
      await act(async () => { void openStoredDraft(h.key); });
      for (let i = 0; i < 3; i++) await h.flush();
      await act(async () => { h.useThreads.setState({ details: new Map([[7, h.detail]]) }); gate.load.mockResolvedValue(h.detail); load.resolve(h.detail); });
      for (let i = 0; i < 6; i++) await h.flush();
      expect(state(h)).toBe("open");
      expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]'));
    } finally { load.resolve(h.detail); await h.cleanup(); }
  });
});

describe("putting a draft away", () => {
  const press = (el: Element, key: string, meta = false) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: meta, bubbles: true, cancelable: true })); });

  it("with nothing written it goes, saved or not, and the reply bar is back; with words it stays", async () => {
    const h = await setup("split", true), { openCompose } = await import("~/lib/compose");
    try {
      await act(async () => h.drafts.forgetDraft(h.key));
      await act(async () => { await openCompose("reply", 7); });
      for (let i = 0; i < 3; i++) await h.flush();
      expect(state(h)).toBe("open");
      await press(h.host.querySelector('[data-testid="composer"]')!, "Escape");
      for (let i = 0; i < 3; i++) await h.flush();
      expect(state(h)).toBe("bar");
      expect(Object.keys(h.drafts.useDrafts.getState().drafts)).toEqual([]);
      expect(gate.call.mock.calls.some(([method]) => method === "drafts.save")).toBe(false);
    } finally { await h.cleanup(); }
  });

  it("the saved copy goes too when what was written was taken out again", async () => {
    const h = await setup("split", true);
    try {
      await act(async () => { h.drafts.editDraft(h.key, { bodyText: "" }); h.drafts.useDrafts.setState((s) => ({ drafts: { ...s.drafts, [h.key]: { ...s.drafts[h.key]!, status: "saved", savedRev: s.drafts[h.key]!.localRev } } })); });
      await press(h.host.querySelector('[data-testid="composer"]')!, "Escape");
      for (let i = 0; i < 3; i++) await h.flush();
      expect(h.drafts.useDrafts.getState().drafts[h.key]).toBeUndefined();
      expect(gate.call).toHaveBeenCalledWith("drafts.delete", { id: 81, generation: "stable" });
    } finally { await h.cleanup(); }
  });

  it("a refused send saves nothing, says so at the field and goes with the form", async () => {
    const h = await setup("split", true), { showNewDraft } = await import("~/lib/compose"), { newFields } = await import("~/lib/compose-fields"), { useSnack } = await import("~/lib/snack");
    try {
      await act(async () => h.drafts.forgetDraft(h.key));
      const key = h.drafts.createDraft(newFields(1));
      await act(async () => showNewDraft(key));
      for (let i = 0; i < 3; i++) await h.flush();
      const send = h.host.querySelector<HTMLButtonElement>('[data-testid="compose-send"]')!;
      expect(send.getAttribute("aria-disabled")).toBe("true");
      await press(h.host.querySelector('[data-testid="compose-to"]')!, "Enter", true);
      for (let i = 0; i < 3; i++) await h.flush();
      const problem = h.host.querySelector('[data-testid="compose-field-problem"]');
      expect(problem?.textContent).toBe("Add a recipient to send");
      expect(problem?.getAttribute("role")).toBe("alert");
      expect(h.host.querySelector('[data-testid="compose-to"]')?.getAttribute("aria-describedby")).toBe(problem?.id);
      expect(useSnack.getState().current).toBeNull();
      expect(gate.call.mock.calls.some(([method]) => method === "drafts.save")).toBe(false);
      await press(h.host.querySelector('[data-testid="compose-to"]')!, "Escape");
      for (let i = 0; i < 3; i++) await h.flush();
      expect(h.app.getApp().compose).toBeNull();
      expect(h.drafts.useDrafts.getState().drafts[key]).toBeUndefined();
      const { useSendProblem } = await import("~/lib/send-problem");
      expect(useSendProblem.getState().problem).toBeNull();
    } finally { await h.cleanup(); }
  });
});
