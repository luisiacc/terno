import { expect, it, vi } from "vitest";
import { attachBody, createDraft, forgetDraft, materialize, setDraftTransport, useDrafts } from "./drafts";
import { newFields } from "./compose-fields";

it.each(["replacement direct", "replacement during save", "ordinary"] as const)("autosaves the current editor after %s materialization", async (scenario) => {
  vi.useFakeTimers();
  const key = createDraft(newFields(1));
  const saves: Record<string, unknown>[] = [];
  setDraftTransport(async (_method, params) => {
    const saved = params as Record<string, unknown>;
    saves.push(saved);
    return { ...saved, id: 9, generation: "stable", revision: 1, updatedAt: 0 };
  });
  let replacement: ReturnType<typeof attachBody> | undefined;
  const original = attachBody(key, () => {
    if (scenario !== "ordinary") {
      replacement = attachBody(key, () => ({ text: "newer editor work", html: "<p>newer editor work</p>" }));
      replacement.changed();
    }
    return { text: "original work", html: "<p>original work</p>" };
  });
  try {
    original.changed();
    if (scenario === "replacement direct") expect(() => materialize(key)).toThrow();
    await vi.advanceTimersByTimeAsync(scenario === "replacement during save" ? 1600 : 800);
    const body = scenario === "ordinary" ? "original work" : "newer editor work";
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ bodyText: body, bodyHtml: `<p>${body}</p>` });
    expect(useDrafts.getState().drafts[key]).toMatchObject({ id: 9, status: "saved", bodyText: body });
  } finally {
    original.dispose(); replacement?.dispose(); forgetDraft(key); setDraftTransport(async () => null); vi.useRealTimers();
  }
});
