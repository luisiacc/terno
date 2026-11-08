// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

vi.mock("~/rpc/connection", () => ({ client: { connectionVersion: 1, call: () => new Promise(() => {}), on: () => () => {} } }));
window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
const { getApp, setApp } = await import("~/state/app");

// plan 158: typing in the search field in Review changed nothing (its suggestions don't answer a query)
it("a search typed in Review leaves it; an empty field or a write that names Review keeps it", () => {
  setApp({ reviewCategoryId: 3, query: "" });
  setApp({ query: "  " });
  expect(getApp().reviewCategoryId).toBe(3);
  setApp({ selectedId: 9 });
  expect(getApp().reviewCategoryId).toBe(3);
  setApp({ query: "from:stripe" });
  expect(getApp()).toMatchObject({ reviewCategoryId: null, query: "from:stripe" });
  setApp({ query: "", reviewCategoryId: 4 });
  setApp({ query: "x", reviewCategoryId: 4 });
  expect(getApp().reviewCategoryId).toBe(4);
});
