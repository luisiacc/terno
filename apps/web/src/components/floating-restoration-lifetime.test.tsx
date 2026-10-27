// @vitest-environment jsdom
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { act, StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const requireUi = createRequire(resolve(process.cwd(), "packages/ui/package.json"));
const requireBase = createRequire(requireUi.resolve("@base-ui/react/popover"));
const esmManager = await import(pathToFileURL(requireBase.resolve("../floating-ui-react/index.mjs")).href);
const esmFrames = await import(pathToFileURL(requireBase.resolve("@base-ui/utils/useAnimationFrame").replace(/\.js$/, ".mjs")).href);
const cjsManager = requireBase("../floating-ui-react/index.js");
const cjsFrames = requireBase("@base-ui/utils/useAnimationFrame");
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

function trackRestoreObservers() {
  const live = new Map<EventListenerOrEventListenerObject, string>();
  let added = 0, removed = 0;
  const add = document.addEventListener, remove = document.removeEventListener;
  const relevant = (args: unknown[]) => {
    const [type, listener, options] = args;
    return (type === "focus" || type === "focusin") && typeof listener === "function" && listener.name === "recordFocusChoice" &&
      (options === true || (options !== null && typeof options === "object" && "capture" in options && options.capture === true));
  };
  vi.spyOn(document, "addEventListener").mockImplementation(function (this: Document, ...args: unknown[]) {
    if (relevant(args)) { live.set(args[1] as EventListener, args[0] as string); added++; }
    return Reflect.apply(add, this, args);
  });
  vi.spyOn(document, "removeEventListener").mockImplementation(function (this: Document, ...args: unknown[]) {
    if (relevant(args) && live.get(args[1] as EventListener) === args[0]) { live.delete(args[1] as EventListener); removed++; }
    return Reflect.apply(remove, this, args);
  });
  return { live, balance: () => ({ added, removed }) };
}

for (const [format, manager, frameModule] of [["ESM", esmManager, esmFrames], ["CJS", cjsManager, cjsFrames]] as const) {
  const { FloatingFocusManager, useFloatingRootContext } = manager;
  for (const strict of [false, true]) {
    for (const teardown of ["restoreFocus", "closeOnFocusOut"] as const) {
      for (const phase of ["queued-microtask", "pending-frame", "detached-frame"] as const) {
        it(`${format} rejects ${phase} after ${teardown} changes (StrictMode: ${strict}) MODEL`, async () => {
          const frames = new Map<number, FrameRequestCallback>();
          let seq = 0, enabled = true;
          frameModule.resetAnimationFrameScheduler();
          const raf = vi.spyOn(globalThis.window, "requestAnimationFrame").mockImplementation((cb) => { frames.set(++seq, cb); return seq; });
          const cancel = vi.spyOn(globalThis.window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
          const observers = trackRestoreObservers();
          const host = document.createElement("div");
          const popup = document.createElement("div"); popup.tabIndex = -1; popup.setAttribute("role", "dialog");
          const removed = document.createElement("button"); removed.textContent = "Remove"; popup.append(removed);
          document.body.append(host, popup);
          const root = createRoot(host);
          function Manager() {
            const context = useFloatingRootContext({ open: true, elements: { floating: popup } });
            return <FloatingFocusManager context={context} modal={false} initialFocus={false} returnFocus={false} restoreFocus={teardown === "restoreFocus" && !enabled ? false : "popup"} closeOnFocusOut={teardown !== "closeOnFocusOut" || enabled}><span /></FloatingFocusManager>;
          }
          const render = () => root.render(strict ? <StrictMode><Manager /></StrictMode> : <Manager />);
          const disable = () => { enabled = false; flushSync(render); };
          const frame = async () => {
            const current = [...frames.values()]; frames.clear();
            await act(async () => { for (const cb of current) cb(performance.now()); });
          };
          try {
            await act(async () => render());
            expect(observers.live.size).toBe(1);
            await act(async () => removed.focus());
            if (phase === "detached-frame") frameModule.AnimationFrame.create().request(disable);
            await act(async () => {
              removed.blur(); removed.remove();
              if (phase === "queued-microtask") disable();
            });
            if (phase !== "queued-microtask") {
              expect(document.activeElement).toBe(popup);
              expect(frames.size).toBeGreaterThan(0);
              await act(async () => popup.blur());
              if (phase === "pending-frame") await act(async () => disable());
            }
            const popupFocus = vi.spyOn(popup, "focus");
            await frame();
            expect(observers.live.size).toBe(0);
            expect(document.activeElement).toBe(document.body);
            expect(popupFocus).not.toHaveBeenCalled();
          } finally {
            await act(async () => root.unmount());
            const liveObservers = observers.live.size, balance = observers.balance();
            popup.remove(); host.remove();
            frameModule.resetAnimationFrameScheduler(); frames.clear();
            vi.restoreAllMocks(); raf.mockRestore(); cancel.mockRestore();
            expect(liveObservers).toBe(0);
            expect(balance.removed).toBe(balance.added);
          }
        });
      }
    }
  }
  it.each([false, true])(`${format} removes and rearms only its open restoration observer (StrictMode: %s) MODEL`, async (strict) => {
    const observers = trackRestoreObservers();
    const host = document.createElement("div"), popup = document.createElement("div");
    popup.tabIndex = -1; popup.setAttribute("role", "dialog"); document.body.append(host, popup);
    const root = createRoot(host);
    let open = false;
    function Manager() {
      const context = useFloatingRootContext({ open, elements: { floating: popup } });
      return <FloatingFocusManager context={context} modal={false} initialFocus={false} returnFocus={false} restoreFocus="popup"><span /></FloatingFocusManager>;
    }
    const render = () => root.render(strict ? <StrictMode><Manager /></StrictMode> : <Manager />);
    try {
      await act(async () => render()); expect(observers.live.size).toBe(0);
      for (const next of [true, false, true]) {
        open = next; await act(async () => render()); expect(observers.live.size).toBe(next ? 1 : 0);
      }
    } finally {
      await act(async () => root.unmount());
      const live = observers.live.size, balance = observers.balance();
      host.remove(); popup.remove(); frameModule.resetAnimationFrameScheduler(); vi.restoreAllMocks();
      expect(live).toBe(0); expect(balance.removed).toBe(balance.added);
    }
  });
}
