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
    setApp({ actionPreview: "p" });
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
