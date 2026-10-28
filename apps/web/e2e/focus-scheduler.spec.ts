import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { transformWithOxc } from "vite";

// This exercises the actual small DOM scheduler with browser-trusted keys; it does not mount the App.
const sourcePath = fileURLToPath(new URL("../src/lib/compose-focus-move.ts", import.meta.url));
let script = "";
test.beforeAll(async () => {
  const source = readFileSync(sourcePath, "utf8");
  script = (await transformWithOxc(source, sourcePath, { lang: "ts", sourcemap: false })).code;
});

type Scenario = "leased-fast" | "valid-fast" | "unleased-fast" | "denied-fast" | "movement-fast" | "leased-raf" | "reentrant-ownerless" | "reentrant-ownerless-raf" | "reentrant-ordinary";
type Scheduler = {
  focusSoon(selector: string, root: HTMLElement, frames?: number, done?: () => boolean, valid?: () => boolean): void;
  prepareInlineFocusMove(valid: () => boolean, terminal: () => void): void;
};
type TestWindow = Window & {
  scheduler: Scheduler;
  frameCount(): number;
  drain(): void;
  trusted: boolean;
  done: number;
  predecessor: number;
  successor: number;
  lease: boolean;
};

for (const [name, scenario] of [
  ["leased completion then trusted key", "leased-fast"],
  ["valid completion then trusted key", "valid-fast"],
  ["unleased trusted key", "unleased-fast"],
  ["completion refuses placement", "denied-fast"],
  ["completion moves focus elsewhere", "movement-fast"],
  ["leased frame then trusted key", "leased-raf"],
] as const satisfies ReadonlyArray<readonly [string, Scenario]>) {
  test(name, async ({ page }) => {
    await page.goto("about:blank");
    await page.setContent('<!doctype html><html><body tabindex="-1"><main id="root"><input id="first"><input id="next" value="base"><input id="third"></main></body></html>');
    await page.evaluate(() => {
      const w = window as unknown as TestWindow;
      let next = 0; const callbacks = new Map<number, FrameRequestCallback>();
      window.requestAnimationFrame = (cb) => { const id = ++next; callbacks.set(id, cb); return id; };
      window.cancelAnimationFrame = (id) => { callbacks.delete(id); };
      w.frameCount = () => callbacks.size;
      w.drain = () => { const batch = [...callbacks.values()]; callbacks.clear(); for (const cb of batch) cb(0); };
      w.trusted = false;
      document.addEventListener("keydown", (event) => { if (event.key === "r") w.trusted = event.isTrusted; }, true);
      document.querySelector<HTMLInputElement>("#next")!.setSelectionRange(4, 4);
      document.body.focus();
    });
    await page.addScriptTag({ type: "module", content: `${script}\nwindow.scheduler = { focusSoon, prepareInlineFocusMove };` });
    const ready = await page.evaluate((kind) => {
      const w = window as unknown as TestWindow, root = document.querySelector<HTMLElement>("#root")!, target = document.querySelector<HTMLInputElement>("#next")!;
      if (!w.scheduler || document.activeElement !== document.body || target.value !== "base" || target.selectionStart !== 4 || target.selectionEnd !== 4) return false;
      w.done = 0; w.predecessor = 0; w.successor = 0; w.lease = true;
      if (kind === "leased-fast" || kind === "leased-raf") w.scheduler.focusSoon("#next", root, 12, () => { w.done++; w.lease = false; return true; }, () => w.lease);
      else if (kind === "valid-fast") w.scheduler.focusSoon("#next", root, 12, () => { w.done++; return true; }, () => true);
      else if (kind === "denied-fast") w.scheduler.focusSoon("#next", root, 12, () => { w.done++; return false; }, () => true);
      else if (kind === "movement-fast") w.scheduler.focusSoon("#next", root, 12, () => { w.done++; document.querySelector<HTMLElement>("#third")!.focus(); return true; }, () => true);
      else if (kind === "unleased-fast") w.scheduler.focusSoon("#next", root);
      else {
        w.scheduler.focusSoon("#first", root, 12, () => { w.predecessor++; w.scheduler.focusSoon("#next", root, 12, () => { w.successor++; return true; }); return true; });
        if (kind === "reentrant-ownerless" || kind === "reentrant-ownerless-raf") w.scheduler.prepareInlineFocusMove(() => true, () => {});
        else w.scheduler.focusSoon("#third", root);
      }
      return w.frameCount() === 1 && document.activeElement === document.body && (!kind.startsWith("reentrant-") || w.predecessor === 1 && w.successor === 0);
    }, scenario);
    expect(ready).toBe(true);
    if (scenario === "leased-raf" || scenario === "reentrant-ownerless-raf") await page.evaluate(() => (window as unknown as TestWindow).drain());
    await page.keyboard.press("r");
    const result = await page.evaluate(() => {
      const w = window as unknown as TestWindow;
      return { trusted: w.trusted, target: (document.activeElement as HTMLElement | null)?.id, value: document.querySelector<HTMLInputElement>("#next")!.value, otherValue: document.querySelector<HTMLInputElement>("#third")!.value, done: w.done, predecessor: w.predecessor, successor: w.successor, frames: w.frameCount() };
    });
    expect(result.trusted).toBe(true);
    if (scenario === "denied-fast") {
      expect(result.target).toBe(""); expect(result.value).toBe("base"); expect(result.done).toBe(1);
    } else if (scenario === "movement-fast") {
      expect(result.target).toBe("third"); expect(result.value).toBe("base"); expect(result.otherValue).toBe("r"); expect(result.done).toBe(1);
    } else {
      expect(result.target).toBe("next"); expect(result.value).toBe("baser");
      if (scenario === "leased-fast" || scenario === "leased-raf") expect(result.done).toBe(1);
      if (scenario.startsWith("reentrant-")) { expect(result.predecessor).toBe(1); expect(result.successor).toBe(1); }
    }
    expect(result.frames).toBe(0);
  });
}
