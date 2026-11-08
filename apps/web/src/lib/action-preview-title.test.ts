// @vitest-environment jsdom
import type { ActionPreviewInfo } from "@terno/core";
import { describe, expect, it, vi } from "vitest";

window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
vi.mock("~/rpc/connection", () => ({ client: { call: async () => ({}), on: () => () => {}, connectionVersion: 1 } }));
const { previewTitle } = await import("./action-preview");

const preview = (over: Partial<ActionPreviewInfo>): ActionPreviewInfo => ({ previewId: "p", plan: { summary: "Archive shipping", action: { type: "archive" }, conditions: [], lookIn: "inbox", future: false, meaning: true }, count: 40, found: 40, skipped: 0, skippedIncluded: false, leftOut: 0, unchecked: 0, check: "done", keep: { kind: "ok" }, keepConditions: [], scanning: false, hidden: false, categoryName: null, forwards: false, ...over });

describe("a preview's count is said once it's final, the same in the header and the reader (plan 161, Codex review #9)", () => {
  it("while finding, the rows there are, never the backend's running count", () => {
    expect(previewTitle(preview({ scanning: true }), 20, "")).toBe("Finding… 20 so far");
    expect(previewTitle(preview({ scanning: true }), 0, "")).toBe("Still finding…");
    expect(previewTitle(preview({}), 20, "")).toBe("Archive 40 conversations");
  });
});

describe("Split's header says only the count, on one line; List's the outcome (plan 161, pass 2)", () => {
  it("the count once final, the same wait while finding", async () => {
    const { previewCount } = await import("./action-preview");
    expect(previewCount(preview({}), 20)).toBe("40 conversations");
    expect(previewCount(preview({ count: 1 }), 1)).toBe("1 conversation");
    expect(previewCount(preview({ scanning: true }), 20)).toBe("Finding… 20 so far");
  });

  it("Apply waits as a quiet button with a spinner and its verb, then is the primary with its count", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { act, createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useActionPreview } = await import("./action-preview");
    const { default: ActionPreviewHeader } = await import("~/components/action-preview-header");
    const { setApp } = await import("~/state/app");
    // a matched row open: the rule isn't on screen, so the header holds the buttons (pass 3)
    setApp({ actionPreview: "p", selectedId: 7 });
    useActionPreview.setState({ preview: preview({ scanning: true }), sentence: "Archive shipping", checking: false, applying: false });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(createElement(ActionPreviewHeader)));
    const apply = () => host.querySelector<HTMLButtonElement>("[data-testid=action-apply]")!;
    expect(apply().disabled).toBe(true);
    expect(apply().dataset.waiting).toBe("true");
    expect(apply().querySelector("[data-testid=action-finding]")).not.toBeNull();
    expect(apply().textContent).toBe("Archive");
    // the primary's faded look is what read as missing: waiting is the quiet button's
    expect(apply().className).not.toContain("from-primary-hover");
    await act(async () => useActionPreview.setState({ preview: preview({}) }));
    expect(apply().disabled).toBe(false);
    expect(apply().dataset.waiting).toBeUndefined();
    expect(apply().querySelector("[data-testid=action-finding]")).toBeNull();
    expect(apply().textContent).toBe("Archive 40");
    expect(host.querySelector("[data-testid=action-title]")!.textContent).toBe("40 conversations");
    await act(async () => root.unmount());
  });
});

describe("Apply sits with the rule, destructive where it takes mail away, and says what a large batch does (plan 161, pass 3)", () => {
  it("the consequence: Trash and Spam at any count, any verb at 100 or more, nothing while finding or for a small archive", async () => {
    const { previewConsequence } = await import("./action-preview");
    const trash = preview({ plan: { ...preview({}).plan, action: { type: "trash" }, lookIn: "everywhere" }, count: 838 });
    expect(previewConsequence(trash, "")).toEqual({ text: "838 conversations go to Trash, from all your mail except Spam and Trash.", destructive: true });
    expect(previewConsequence({ ...trash, count: 1 }, "")!.text).toBe("1 conversation goes to Trash, from all your mail except Spam and Trash.");
    expect(previewConsequence(preview({ plan: { ...preview({}).plan, action: { type: "spam" } }, count: 2 }), "")).toEqual({ text: "2 conversations go to Spam, from the Inbox.", destructive: true });
    expect(previewConsequence(preview({ count: 120 }), "")).toEqual({ text: "This archives 120 conversations, from the Inbox.", destructive: false });
    expect(previewConsequence(preview({ count: 99 }), "")).toBeNull();
    expect(previewConsequence({ ...trash, scanning: true }, "")).toBeNull();
    expect(previewConsequence({ ...trash, count: 0 }, "")).toBeNull();
  });

  it("in Split the rule holds Apply and Cancel and the header only the count; Trash is the destructive button", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { act, createElement, Fragment } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useActionPreview } = await import("./action-preview");
    const { default: ActionPreviewHeader, ActionRule } = await import("~/components/action-preview-header");
    const { setApp } = await import("~/state/app");
    setApp({ actionPreview: "p", selectedId: null, compose: null });
    const trash = preview({ plan: { ...preview({}).plan, action: { type: "trash" }, lookIn: "everywhere" }, count: 838 });
    useActionPreview.setState({ preview: trash, sentence: "Delete all newsletters", checking: false, applying: false });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(createElement(Fragment, null, createElement(ActionPreviewHeader), createElement(ActionRule, { variant: "reader" }))));
    const header = host.querySelector("[data-testid=action-preview]")!;
    const rule = host.querySelector("[data-testid=action-rule]")!;
    expect(header.querySelector("[data-testid=action-apply]")).toBeNull();
    expect(header.querySelector("[data-testid=action-cancel]")).toBeNull();
    expect(host.querySelectorAll("[data-testid=action-apply]")).toHaveLength(1);
    const apply = rule.querySelector<HTMLButtonElement>("[data-testid=action-decision] [data-testid=action-apply]")!;
    expect(apply.textContent).toBe("Move 838 to Trash");
    expect(apply.dataset.variant).toBe("destructive");
    expect(rule.querySelector("[data-testid=action-decision] [data-testid=action-cancel]")).not.toBeNull();
    expect(rule.querySelector("[data-testid=action-consequence]")!.textContent).toBe("838 conversations go to Trash, from all your mail except Spam and Trash.");
    // an archive is the primary, with no consequence line at six
    await act(async () => useActionPreview.setState({ preview: preview({ count: 6 }) }));
    expect(host.querySelector<HTMLButtonElement>("[data-testid=action-apply]")!.dataset.variant).toBe("default");
    expect(host.querySelector("[data-testid=action-consequence]")).toBeNull();
    // Codex review #7: a rule that will trash new mail, with nothing here yet, saves with the destructive button too
    await act(async () => useActionPreview.setState({ preview: { ...trash, plan: { ...trash.plan, future: true }, found: 0, count: 0 } }));
    const save = host.querySelector<HTMLButtonElement>("[data-testid=action-apply]")!;
    expect(save.textContent).toBe("Save the rule");
    expect(save.dataset.variant).toBe("destructive");
    // a row opened: the rule leaves the reader (its owner unmounts it), and the header has the buttons again
    await act(async () => setApp({ selectedId: 3 }));
    expect(header.querySelector("[data-testid=action-apply]")).not.toBeNull();
    await act(async () => root.unmount());
  });
});

