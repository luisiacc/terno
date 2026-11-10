// @vitest-environment jsdom
/**
 * The Review rows' buttons, laid over the rows from outside the list: a wheel over them moves the list under them, as
 * the learned offer's does (Codex series review); and the rows draw the pills, so they scroll with them in the same frame.
 */
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.resolve({}), on: () => () => {} } }));
const answerReview = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("~/lib/categorize", () => ({ answerReview, fileAlways: vi.fn(), filterNameOf: vi.fn() }));

const { ReviewButtons, ReviewControls } = await import("./review-actions");
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

it("the row draws the pills; its buttons are clear over them, and a hovered or focused one marks its pill", async () => {
  setApp({ categories: [{ id: 4, name: "Facturas" } as never], reviewCategoryId: 4 });
  const host = document.createElement("div");
  document.body.append(host);
  const scroller = createRef<HTMLDivElement>();
  const root = createRoot(host);
  await act(async () => root.render(
    <div>
      <div ref={scroller}>
        <ReviewControls threadId={7} category="Facturas" />
      </div>
      <ReviewButtons scroller={scroller} tick="a" />
    </div>,
  ));
  const slot = host.querySelector<HTMLElement>("[data-review-slot='7']")!;
  // drawn in the row, which scrolls natively: a layer placed after the scroll trails it
  expect(slot.className).not.toMatch(/\binvisible\b/);
  const [accept, always] = ["accept", "always"].map((w) => host.querySelector<HTMLElement>(`[data-testid=row-review-${w}]`)!);
  for (const b of [accept!, always!]) expect(b.className).toMatch(/\bopacity-0\b/);
  const pills = [...slot.children] as HTMLElement[];
  // (from outside the window: React makes enter / leave of an over / out whose other end it doesn't hold)
  const move = (type: string, el: HTMLElement) => act(() => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: null })));
  await move("pointerover", always!);
  expect(pills.map((p) => p.hasAttribute("data-hover"))).toEqual([false, true]);
  await move("pointerout", always!);
  await move("pointerover", accept!);
  expect(pills.map((p) => p.hasAttribute("data-hover"))).toEqual([true, false]);
  // its row drawn again (scrolled away and back): the hover comes back with it
  slot.firstElementChild!.removeAttribute("data-hover");
  await act(async () => root.render(
    <div>
      <div ref={scroller}>
        <ReviewControls threadId={7} category="Facturas" />
      </div>
      <ReviewButtons scroller={scroller} tick="b" />
    </div>,
  ));
  expect(slot.firstElementChild!.hasAttribute("data-hover")).toBe(true);
  await move("pointerout", accept!);
  expect(pills.map((p) => p.hasAttribute("data-hover"))).toEqual([false, false]);
  // focused (by Tab): the pill rings, the button stays clear (shown, it would trail its row on a scroll)
  await act(() => always!.focus());
  expect(pills.map((p) => p.hasAttribute("data-focus"))).toEqual([false, true]);
  expect(always!.className).toMatch(/\bopacity-0\b/);
  expect(always!.className).not.toMatch(/focus-(visible|reveal):/);
  await act(() => always!.blur());
  expect(pills.map((p) => p.hasAttribute("data-focus"))).toEqual([false, false]);
  await act(async () => root.unmount());
  host.remove();
});

it("a press answers the row whose pill is under the pointer, though its button hasn't caught up with a scroll yet", async () => {
  setApp({ categories: [{ id: 4, name: "Facturas" } as never], reviewCategoryId: 4 });
  const host = document.createElement("div");
  document.body.append(host);
  const scroller = createRef<HTMLDivElement>();
  const root = createRoot(host);
  const show = vi.fn();
  await act(async () => root.render(
    <div>
      <div ref={scroller}>
        <ReviewControls threadId={7} category="Facturas" />
        <ReviewControls threadId={8} category="Facturas" />
      </div>
      <ReviewButtons scroller={scroller} tick="a" show={show} />
    </div>,
  ));
  // the list scrolled: row 8's pills now lie where row 7's button still is
  const pill = (id: number, part: number) => host.querySelector(`[data-review-slot="${id}"]`)!.children[part] as HTMLElement;
  const rect = (top: number) => ({ left: 0, right: 100, top, bottom: top + 24, width: 100, height: 24, x: 0, y: top, toJSON() {} });
  pill(7, 0).getBoundingClientRect = () => rect(-60);
  pill(8, 0).getBoundingClientRect = () => rect(0);
  const accept = host.querySelector<HTMLElement>("[data-testid=row-review-accept][data-thread-id='7']")!;
  await act(() => void accept.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 50, clientY: 12 })));
  expect(answerReview).toHaveBeenLastCalledWith(8, 4, true);
  // between pills: nothing
  answerReview.mockClear();
  await act(() => void accept.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 50, clientY: 40 })));
  expect(answerReview).not.toHaveBeenCalled();
  // from the keyboard (Enter: no pointer), the focused button's own row, brought into view as Tab reached it
  await act(() => accept.focus());
  expect(show).toHaveBeenCalledWith(7);
  await act(() => void accept.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
  expect(answerReview).toHaveBeenLastCalledWith(7, 4, true);
  await act(async () => root.unmount());
  host.remove();
});
