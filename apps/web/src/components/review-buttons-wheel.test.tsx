// @vitest-environment jsdom
/** A wheel over a Review row's buttons moves the list under them, as the learned offer's does (Codex series review). */
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.resolve({}), on: () => () => {} } }));

const { ReviewButtons } = await import("./review-actions");
const { setApp } = await import("~/state/app");

it("pixels as they are, lines and pages in the list's own measure", async () => {
  setApp({ categories: [{ id: 4, name: "Facturas" } as never], reviewCategoryId: 4 });
  const host = document.createElement("div");
  document.body.append(host);
  const scroller = createRef<HTMLDivElement>();
  const root = createRoot(host);
  await act(async () => root.render(
    <div>
      <div ref={scroller} style={{ lineHeight: "20px" }}>
        <span data-review-slot="7"><span /><span /></span>
      </div>
      <ReviewButtons scroller={scroller} tick="a" />
    </div>,
  ));
  const list = scroller.current!;
  Object.defineProperty(list, "clientHeight", { value: 300 });
  const button = host.querySelector<HTMLElement>("[data-testid=row-review-accept]")!;
  const wheel = (deltaY: number, deltaMode: number) => button.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode, bubbles: true }));
  wheel(50, 0);
  expect(list.scrollTop).toBe(50);
  wheel(3, 1);
  expect(list.scrollTop).toBe(110);
  wheel(1, 2);
  expect(list.scrollTop).toBe(410);
  await act(async () => root.unmount());
  host.remove();
});
