// @vitest-environment jsdom
// Plan 175: the drafts row at the top of the list counts every draft, wherever it is, and opens several as a dropdown.
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledInfo } from "@terno/core/rpc";

const mocks = vi.hoisted(() => ({ open: vi.fn(async (_key: string) => {}) }));
vi.mock("~/lib/compose", () => ({ openStoredDraft: mocks.open, composeIntent: () => 0, focusDraftOnScreen: () => false }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

const { DraftsStrip } = await import("./drafts-strip");
const { createDraft, editDraft, forgetDraft, markSending, useDrafts } = await import("~/lib/drafts");
const { newFields } = await import("~/lib/compose-fields");
const { useScheduled } = await import("~/lib/scheduled");
const { markSelectionIntent } = await import("~/state/app");

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const written = (subject: string, at: number, fields: Partial<Parameters<typeof createDraft>[0]> = {}) => {
  const key = createDraft({ ...newFields(1), subject, toText: "Ana Torres <ana@example.com>", ...fields });
  editDraft(key, { bodyText: `${subject} body` });
  useDrafts.setState((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, updatedAt: at } } }));
  return key;
};
const scheduled = (draftId: number, subject: string): ScheduledInfo => ({ draftId, subject, mode: "new", to: [{ name: "Ana", email: "ana@example.com" }], sendAt: Date.now() + 3_600_000, threadId: null, error: null }) as unknown as ScheduledInfo;
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const all = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const render = async () => act(async () => root.render(<DraftsStrip />));
const openMenu = async () => {
  const summary = q("[data-testid=strip-summary]")!;
  await act(async () => summary.click());
  await act(async () => {});
};

beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key);
  useScheduled.setState({ items: [], byDraft: new Map() });
  host.remove(); vi.clearAllMocks();
});

describe("the drafts row (plan 175)", () => {
  it("isn't there with nothing written, and an untouched draft isn't counted", async () => {
    createDraft({ ...newFields(1), subject: "" });
    await render();
    expect(q("[data-testid=drafts-strip]")).toBeNull();
  });

  it("one draft is the row itself, wherever the draft is (on a row, open, pinned): a click opens it", async () => {
    // a reply on a listed conversation's row was left out before (plan 158); every draft counts now
    const key = written("Re: Concierto", 1, { mode: "reply", threadId: 7, inReplyToMessageId: 3 });
    await render();
    expect(all("[data-testid=strip-item]")).toHaveLength(1);
    const item = q(`[data-testid=strip-item][data-key="${key}"]`)!;
    expect(item.textContent).toContain("Re: Concierto");
    expect(item.textContent).toContain("To Ana Torres");
    expect(q("[data-testid=strip-summary]")).toBeNull();
    await act(async () => item.click());
    expect(mocks.open).toHaveBeenCalledWith(key);
  });

  it("several are one row that says how many; its dropdown lists them newest first, and a choice opens it", async () => {
    const older = written("Primera nota", 1), newer = written("Segunda nota", 2);
    await render();
    expect(all("[data-testid=strip-item]")).toHaveLength(0);
    expect(q("[data-testid=strip-summary]")!.textContent).toBe("2 drafts");
    await openMenu();
    expect(all("[data-testid=strip-item]").map((el) => el.dataset.key)).toEqual([newer, older]);
    await act(async () => q(`[data-testid=strip-item][data-key="${older}"]`)!.click());
    expect(mocks.open).toHaveBeenCalledWith(older);
  });

  it("counts scheduled sends beside the drafts, and lists them after", async () => {
    written("Borrador", 1);
    useScheduled.setState({ items: [scheduled(90, "Programado")], byDraft: new Map() });
    await render();
    expect(q("[data-testid=strip-summary]")!.textContent).toBe("1 draft·1 scheduled");
    await openMenu();
    expect(all("[data-testid=strip-item], [data-testid=strip-scheduled]").map((el) => el.dataset.testid)).toEqual(["strip-item", "strip-scheduled"]);
  });

  it("only scheduled sends: one is its own row, several say how many", async () => {
    useScheduled.setState({ items: [scheduled(90, "Programado")], byDraft: new Map() });
    await render();
    expect(q("[data-testid=strip-scheduled]")!.textContent).toContain("Programado");
    await act(async () => useScheduled.setState({ items: [scheduled(90, "Programado"), scheduled(91, "Otro")], byDraft: new Map() }));
    expect(q("[data-testid=strip-summary]")!.textContent).toBe("2 scheduled");
  });

  it("a send in flight stays until it's sent: it can be opened again (plan 158)", async () => {
    const key = written("Enviando", 1);
    await render();
    await act(async () => markSending(key, true));
    expect(q(`[data-testid=strip-item][data-key="${key}"]`)).not.toBeNull();
  });

  it("of drafts from the same moment, the one begun later comes first", async () => {
    const first = written("Primera", 5), second = written("Segunda", 5), third = written("Tercera", 5);
    await render();
    await openMenu();
    expect(all("[data-testid=strip-item]").map((el) => el.dataset.key)).toEqual([third, second, first]);
  });

  it("typing in a draft's body renders nothing here, in one draft's row or in the count of several; a new subject does", async () => {
    let commits = 0;
    const counted = async () => act(async () => root.render(<Profiler id="strip" onRender={() => { commits++; }}><DraftsStrip /></Profiler>));
    const older = written("Asunto", 1);
    await counted();
    commits = 0;
    await act(async () => editDraft(older, { bodyText: "más texto" }));
    expect(commits).toBe(0);
    // several: editing the older one makes it the newest, which only the open dropdown's order follows
    const newer = written("Otro", 2);
    await act(async () => useDrafts.setState((s) => ({ drafts: { ...s.drafts, [older]: { ...s.drafts[older]!, updatedAt: 1 } } })));
    expect(q("[data-testid=strip-summary]")!.textContent).toBe("2 drafts");
    commits = 0;
    await act(async () => editDraft(older, { bodyText: "aún más texto" }));
    await act(async () => editDraft(older, { bodyText: "y más" }));
    expect(useDrafts.getState().drafts[older]!.updatedAt).toBeGreaterThan(useDrafts.getState().drafts[newer]!.updatedAt);
    expect(commits).toBe(0);
    await act(async () => forgetDraft(newer));
    expect(q(`[data-testid=strip-item][data-key="${older}"]`)).not.toBeNull();
    await act(async () => editDraft(older, { subject: "Otro asunto" }));
    expect(q("[data-testid=strip-item]")!.textContent).toContain("Otro asunto");
  });
});

describe("focus as the row changes shape (plan 175)", () => {
  it("on the one draft's row when another arrives: the row that counts both takes it", async () => {
    written("Primera", 1);
    await render();
    q("[data-testid=strip-item]")!.focus();
    await act(async () => { written("Segunda", 2); });
    expect(document.activeElement).toBe(q("[data-testid=strip-summary]"));
  });

  it("elsewhere when another arrives: it stays there", async () => {
    written("Primera", 1);
    const other = document.createElement("button"); document.body.append(other);
    try {
      await render();
      other.focus();
      await act(async () => { written("Segunda", 2); });
      expect(document.activeElement).toBe(other);
    } finally { other.remove(); }
  });

  it("in the open dropdown when a draft leaves and one is left: that draft's row takes it", async () => {
    const first = written("Primera", 1), second = written("Segunda", 2);
    await render();
    await openMenu();
    q(`[data-testid=strip-item][data-key="${first}"]`)!.focus();
    await act(async () => forgetDraft(second));
    expect(document.activeElement).toBe(q(`[data-testid=strip-item][data-key="${first}"]`));
  });
});

describe("a draft chosen in the dropdown that doesn't open (plan 175)", () => {
  it.each([false, true])("gives focus back to the row, unless the selection moved meanwhile (%s)", async (moved) => {
    written("Primera", 1); const second = written("Segunda", 2);
    let finish!: () => void;
    mocks.open.mockImplementationOnce(() => new Promise<void>((done) => { finish = done; }));
    await render();
    await openMenu();
    await act(async () => q(`[data-testid=strip-item][data-key="${second}"]`)!.click());
    await act(async () => {});
    (document.activeElement as HTMLElement | null)?.blur();
    // j meanwhile (Codex review): what it did has the focus, not the drafts row
    if (moved) markSelectionIntent();
    await act(async () => finish());
    if (moved) expect(document.activeElement).toBe(document.body);
    else expect(document.activeElement).toBe(q("[data-testid=strip-summary]"));
  });
});

describe("a scheduled send chosen in the dropdown (plan 175)", () => {
  it("opens Send later under the row, follows its send, and goes with it", async () => {
    // two drafts besides: the row stays the count of several when the send leaves
    written("Borrador", 1); written("Otro", 2);
    useScheduled.setState({ items: [scheduled(90, "Programado")], byDraft: new Map() });
    await render();
    await openMenu();
    await act(async () => q("[data-testid=strip-menu] [data-testid=strip-scheduled]")!.click());
    await act(async () => {});
    expect(q("[data-testid=scheduled-popover]")).not.toBeNull();
    // moved to another time meanwhile (Codex review): it says the new one
    const said = q("[data-testid=scheduled-popover]")!.textContent;
    await act(async () => useScheduled.setState({ items: [{ ...scheduled(90, "Programado"), sendAt: Date.now() + 3 * 86_400_000 } as ScheduledInfo], byDraft: new Map() }));
    expect(q("[data-testid=scheduled-popover]")!.textContent).not.toBe(said);
    // sent elsewhere: its Send later goes, and doesn't come back if a send with its id does
    await act(async () => useScheduled.setState({ items: [], byDraft: new Map() }));
    await act(async () => {});
    expect(q("[data-testid=scheduled-popover]")).toBeNull();
    await act(async () => useScheduled.setState({ items: [scheduled(90, "Programado")], byDraft: new Map() }));
    await act(async () => {});
    expect(q("[data-testid=scheduled-popover]")).toBeNull();
  });
});
