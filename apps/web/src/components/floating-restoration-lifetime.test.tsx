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
            expect(document.activeElement).toBe(document.body);
            expect(popupFocus).not.toHaveBeenCalled();
          } finally {
            await act(async () => root.unmount());
            popup.remove(); host.remove();
            frameModule.resetAnimationFrameScheduler(); frames.clear();
            vi.restoreAllMocks(); raf.mockRestore(); cancel.mockRestore();
          }
        });
      }
    }
  }
}
