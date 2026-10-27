/**
 * A new web build never drops the page over an unsaved draft (Codex review of
 * plan 11): a slow or failing save holds the reload and says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.reject(new Error("not in tests")) } }));

const { createDraft, draftsSaved, editDraft, markDraftMissing, setDraftTransport, useDrafts } = await import("~/lib/drafts");
const { newFields } = await import("~/lib/compose-fields");
const { whenDraftsSaved } = await import("./reload");

type Answer = "ok" | "fail" | "never";
let answer: Answer;

beforeEach(() => {
  vi.useFakeTimers();
  useDrafts.setState({ drafts: {} });
  answer = "ok";
  let id = 1;
  setDraftTransport(
    (_method, params) =>
      new Promise((resolve, reject) => {
        if (answer === "ok") resolve({ ...(params as object), id: id++, revision: 1 });
        else if (answer === "fail") reject(new Error("offline"));
      }),
    () => Date.now(),
  );
});
afterEach(() => vi.useRealTimers());

function dirtyDraft() {
  const k = createDraft({ ...newFields(1), toText: "Ana <ana@example.com>" });
  editDraft(k, { bodyText: "lo que escribía" });
  return k;
}

describe("web updates: reloading only once drafts are saved", () => {
  it("nothing written, or everything saved: true", async () => {
    expect(await draftsSaved()).toBe(true);
    dirtyDraft();
    const saved = draftsSaved();
    await vi.advanceTimersByTimeAsync(0);
    expect(await saved).toBe(true);
  });

  it.each(["fail", "never"] as const)("a save that %s: false", async (a) => {
    answer = a;
    dirtyDraft();
    const saved = draftsSaved(5000);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await saved).toBe(false);
  });

  it("held: no reload, a warning with Try Again (which reloads once saved) and Reload Anyway", async () => {
    let reloads = 0;
    let warning: { retry: () => void; anyway: () => void } | null = null;
    let saved = false;
    const deps = { saved: async () => saved, warn: (w: { retry: () => void; anyway: () => void }) => void (warning = w) };
    expect(await whenDraftsSaved(() => reloads++, deps)).toBe(false);
    expect(reloads).toBe(0);
    saved = true;
    warning!.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(reloads).toBe(1);
    warning!.anyway();
    // An obsolete warning cannot force a second transition after a successful retry.
    expect(reloads).toBe(1);
  });

  it("terminal recovery holds a clean draft too; only an explicitly warned forced reload can continue", async () => {
    const k = dirtyDraft(); await draftsSaved(); markDraftMissing(k);
    let reloads = 0; let warning: { retry(): void; anyway(): void } | undefined;
    const deps = { saved: () => draftsSaved(), warn: (w: typeof warning) => { warning = w; } };
    expect(await whenDraftsSaved(() => reloads++, deps)).toBe(false);
    expect(reloads).toBe(0); warning!.retry(); await vi.advanceTimersByTimeAsync(0);
    expect(reloads).toBe(0); warning!.anyway(); expect(reloads).toBe(1);
  });

  it("saved: reloads at once, no warning", async () => {
    let reloads = 0;
    const warn = vi.fn();
    expect(await whenDraftsSaved(() => reloads++, { saved: async () => true, warn })).toBe(true);
    expect(reloads).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
