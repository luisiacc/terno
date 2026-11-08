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
