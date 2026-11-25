// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

let motion = 75;
vi.mock("~/lib/appearance", () => ({ motionMs: () => motion }));
const { morph } = await import("./morph");

/** A scroller 0–300 (its foot bar's 60 as scroll padding) and rows laid at these tops, 40 tall. */
function rows(tops: number[]): HTMLElement[] {
  document.body.innerHTML = "";
  const clip = document.createElement("div");
  clip.setAttribute("data-morph-clip", "");
  clip.style.scrollPaddingBottom = "60px";
  clip.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300 }) as DOMRect;
  document.body.append(clip);
  return tops.map((top, i) => {
    const el = document.createElement("div");
    el.dataset.morph = `row-${i}`;
    el.dataset.morphClass = "morph-crop";
    el.getBoundingClientRect = () => ({ top, bottom: top + 40, height: 40 }) as DOMRect;
    clip.append(el);
    return el;
  });
}

const names = (els: HTMLElement[]) => els.map((el) => el.style.getPropertyValue("view-transition-name"));

/** the document's API, stubbed or removed (jsdom has none) */
const setApi = (fn: unknown) => Object.defineProperty(document, "startViewTransition", { value: fn, configurable: true, writable: true });
const dropApi = () => Reflect.deleteProperty(document, "startViewTransition");
let finish: () => void;
let calls: number;
let skipped: number;
let pending: (() => void) | null;

beforeEach(() => {
  motion = 75;
  calls = 0;
  skipped = 0;
  pending = null;
  setApi((update: () => void) => {
    calls++;
    pending = update;
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    finish = done;
    return { finished, skipTransition: () => skipped++ };
  });
});
afterEach(() => {
  dropApi();
});

test("motion off: the update runs at once, nothing named", () => {
  const els = rows([0]);
  motion = 0;
  const update = vi.fn();
  morph(update);
  expect(update).toHaveBeenCalledOnce();
  expect(names(els)).toEqual([""]);
  expect(calls).toBe(0);
});

test("no API (motion on): the update runs at once, nothing named", () => {
  const els = rows([0]);
  dropApi();
  const update = vi.fn();
  morph(update);
  expect(update).toHaveBeenCalledOnce();
  expect(names(els)).toEqual([""]);
});

test("names only what's wholly in view above the foot, in the old state and again in the new, and clears them after", async () => {
  // in view; cut by the top; under the foot bar (260 > 300 - 60); wholly in view
  const els = rows([10, -20, 230, 150]);
  let during: string[] = [];
  morph(() => {
    // the new state: the third row moved into view, the first out of it
    els[0]!.getBoundingClientRect = () => ({ top: 400, bottom: 440, height: 40 }) as DOMRect;
    els[2]!.getBoundingClientRect = () => ({ top: 100, bottom: 140, height: 40 }) as DOMRect;
    during = names(els);
  });
  // the old state is named before the frame; the update waits for it
  expect(calls).toBe(1);
  expect(names(els)).toEqual(["row-0", "", "", "row-3"]);
  expect(els[0]!.style.getPropertyValue("view-transition-class")).toBe("morph-crop");
  pending!();
  // inside the update, the old names were cleared before it ran; after it, the new state's are set
  expect(during).toEqual(["", "", "", ""]);
  expect(names(els)).toEqual(["", "", "row-2", "row-3"]);
  finish();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(names(els)).toEqual(["", "", "", ""]);
  expect(els[3]!.style.getPropertyValue("view-transition-class")).toBe("");
});

test("a change while one runs ends it and goes at once", async () => {
  rows([10]);
  const first = vi.fn();
  morph(first);
  const second = vi.fn();
  morph(second);
  expect(skipped).toBe(1);
  expect(second).toHaveBeenCalledOnce();
  expect(calls).toBe(1);
  // and once it's over, the next one transitions again
  pending!();
  finish();
  await new Promise((r) => setTimeout(r, 0));
  morph(() => {});
  expect(calls).toBe(2);
});

/** plan 271: a pair's element, its box as given, in a reader's scroller 0–300 */
function pairEl(box: { top: number; height: number; width?: number }, id = "a"): HTMLElement {
  let scroller = document.querySelector<HTMLElement>("[data-reader-scroller]");
  if (!scroller) {
    scroller = document.createElement("div");
    scroller.setAttribute("data-reader-scroller", "");
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300, width: 640 }) as DOMRect;
    document.body.append(scroller);
  }
  const el = document.createElement("article");
  el.id = id;
  el.getBoundingClientRect = () => ({ top: box.top, bottom: box.top + box.height, height: box.height, width: box.width ?? 640 }) as DOMRect;
  scroller.append(el);
  return el;
}
const still = () => document.documentElement.hasAttribute("data-morph-still");
/** an earlier test's transition, ended: morph runs a change at once while one runs */
async function idle(): Promise<void> {
  finish?.();
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

test("plan 271: a pair of the same size glides with its new picture at once; the change isn't still", async () => {
  await idle();
  document.body.innerHTML = "";
  let el = pairEl({ top: 100, height: 104 }, "held");
  const pair = { name: "sent-message", find: () => el };
  morph(() => {
    el.remove();
    el = pairEl({ top: 122, height: 104 }, "copy");
  }, [pair]);
  expect(el.style.getPropertyValue("view-transition-name")).toBe("sent-message");
  pending!();
  expect(el.id).toBe("copy");
  expect(el.style.getPropertyValue("view-transition-name")).toBe("sent-message");
  expect(el.style.getPropertyValue("view-transition-class")).toBe("morph-swap");
  expect(still()).toBe(false);
  finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(el.style.getPropertyValue("view-transition-name")).toBe("");
});

test("plan 271: a pair drawn otherwise after (another size), or not wholly in view before (Codex code review #3): the change is still", async () => {
  for (const [before, after] of [
    [{ top: 100, height: 104 }, { top: 122, height: 160 }],
    [{ top: 100, height: 400 }, { top: 122, height: 400 }],
  ] as const) {
    await idle();
    document.body.innerHTML = "";
    let el = pairEl(before);
    morph(() => {
      el.remove();
      el = pairEl(after);
    }, [{ name: "sent-message", find: () => el }]);
    pending!();
    expect(still()).toBe(true);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(still()).toBe(false);
  }
});
