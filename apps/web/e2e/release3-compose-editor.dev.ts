import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, focusList, openRow, test } from "./fixtures";

for (const scheme of ["light", "dark"] as const) for (const from of ["list", "collapsed"] as const) test(`Escape after reply publication before its focus frame collapses the authored draft (${scheme}, ${from}) @design`, async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { theme: scheme }, { clientId: "release3", origin: "dev" });
  await page.reload(); await page.locator("[data-ready]").waitFor();
  await openRow(page, 0); await focusList(page); await page.keyboard.press("r");
  const body = page.getByTestId("compose-body");
  await expect(body).toBeFocused(); await page.keyboard.type("Rápido");
  await page.keyboard.press("Escape"); await expect(page.getByTestId("draft-collapsed")).toContainText("Rápido");
  if (from === "list") await focusList(page);
  else await expect(page.getByTestId("draft-collapsed")).toBeFocused();
  await page.evaluate(() => {
    const w = window as unknown as { __releaseFocusFrames(): void; __pendingFocusFrames(): number };
    const raf = window.requestAnimationFrame.bind(window), frames: FrameRequestCallback[] = [];
    window.requestAnimationFrame = (callback) => {
      if (new Error().stack?.includes("compose-focus-move")) { frames.push(callback); return -frames.length; }
      return raf(callback);
    };
    w.__pendingFocusFrames = () => frames.length;
    w.__releaseFocusFrames = () => { window.requestAnimationFrame = raf; for (const callback of frames.splice(0)) raf(callback); };
  });
  try {
    await page.keyboard.press("r");
    await expect(body).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __pendingFocusFrames(): number }).__pendingFocusFrames())).toBeGreaterThan(0);
    await expect(body).not.toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("draft-collapsed")).toContainText("Rápido");
  } finally { await page.evaluate(() => (window as unknown as { __releaseFocusFrames(): void }).__releaseFocusFrames()); }
  await expect(page.getByTestId("draft-collapsed")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-focus-ring"))).toBe(false);
  expect((await new AxeBuilder({ page }).include('[data-testid="draft-slot"]').analyze()).violations).toEqual([]);
  mkdirSync("/tmp/terno-release3-compose-editor/shots", { recursive: true });
  await page.screenshot({ path: `/tmp/terno-release3-compose-editor/shots/${scheme}-${from}.png` });
  await page.keyboard.press("Enter"); await expect(body).toBeFocused();
  await expect(body).toHaveText("Rápido");
  await page.keyboard.press("ControlOrMeta+z"); await expect(body).toHaveText("");
  await page.keyboard.press("ControlOrMeta+Shift+z"); await expect(body).toHaveText("Rápido");
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  const saved = await server.backend.server.invoke("drafts.list", {}, { clientId: "release3", origin: "dev" });
  expect(saved).toHaveLength(1); expect(saved[0]!.bodyText).toBe("Rápido");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-focus-ring"))).toBe(true);
  expect(await page.evaluate(() => document.activeElement?.matches(':focus-visible'))).toBe(true);
});
