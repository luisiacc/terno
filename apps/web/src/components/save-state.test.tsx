// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { LocalDraft } from "~/lib/drafts";
vi.hoisted(() => { (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }); });
vi.mock("~/rpc/connection", () => ({ client: { call: () => new Promise(() => {}), on: () => () => {} } }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const { SaveState } = await import("./inline-draft");

afterEach(() => vi.useRealTimers());

const draft = (status: LocalDraft["status"], id: number | null): LocalDraft => ({ key: "k", status, id, localRev: 1 } as unknown as LocalDraft);

// plan 158: "Saving…" at every pause in typing read as stuck: within a second, what was there stays
it("a save under a second keeps Saved on screen; Saving… is for one that takes longer", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const status = () => host.querySelector("[data-testid=draft-status]")!;
  const live = () => status().querySelector("[aria-live]")!.textContent;
  try {
    await act(async () => root.render(<SaveState d={draft("saved", 7)} />));
    expect(status().textContent).toBe("Saved");
    expect(live()).toBe("Saved");
    // typed: still Saved on screen, but not said aloud as if this were saved
    await act(async () => root.render(<SaveState d={draft("dirty", 7)} />));
    expect(status().textContent).toBe("Saved");
    expect(live()).toBe("");
    expect(status().getAttribute("data-status")).toBe("dirty");
    await act(async () => { vi.advanceTimersByTime(999); });
    expect(status().textContent).toBe("Saved");
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(status().textContent).toBe("Saving…");
    await act(async () => root.render(<SaveState d={draft("saved", 7)} />));
    expect(status().textContent).toBe("Saved");
    // a first save claims nothing yet, then says Saving… only if it takes a while
    await act(async () => root.render(<SaveState d={{ ...draft("dirty", null), key: "k2" }} />));
    expect(status().textContent).toBe("");
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(status().textContent).toBe("Saving…");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
