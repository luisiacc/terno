import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, focusList, openRow, test } from "./fixtures";

const ctx = { clientId: "early-input", origin: "dev" as const };
for (const scheme of ["light", "dark"] as const) for (const selection of ["caret", "backward"] as const) test(`rapid native input belongs to the source-validated reply (${scheme}, ${selection}) @design`, async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { theme: scheme }, ctx);
  await page.reload(); await page.locator("[data-ready]").waitFor();
  await openRow(page, 0); await focusList(page); await page.keyboard.press("r");
  const body = page.getByTestId("compose-body");
  await expect(body).toBeFocused(); await page.keyboard.type("Baseline");
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  await page.keyboard.press("Escape");
  const before = await server.backend.server.invoke("drafts.list", {}, ctx);
  const handlers = (server.backend.server as unknown as { handlers: Record<string, (...args: unknown[]) => unknown> }).handlers;
  const source = handlers["drafts.sourceContext"]!;
  let release!: () => void, entered = 0;
  const gate = new Promise<void>((r) => { release = r; });
  handlers["drafts.sourceContext"] = async (...args) => { entered++; await gate; return source(...args); };
  try {
    await focusList(page); await page.keyboard.press("r");
    await expect.poll(() => entered).toBe(1);
    await page.keyboard.type("Rápido jca/");
    await page.keyboard.press(selection === "caret" ? "ArrowLeft" : "Shift+ArrowLeft");
    expect(await server.backend.server.invoke("drafts.list", {}, ctx)).toEqual(before);
    await expect(page.locator("textarea.sr-only")).toHaveValue("Rápido jca/");
    release();
    await expect(body).toHaveText("Rápido jca/Baseline");
    await expect(body).toBeFocused();
    const finalText = selection === "caret" ? "Rápido jca!/Baseline" : "Rápido jca!Baseline";
    await page.keyboard.type("!"); await expect(body).toHaveText(finalText);
    await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
    const after = await server.backend.server.invoke("drafts.list", {}, ctx);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before[0]!.id, generation: before[0]!.generation, inReplyToMessageId: before[0]!.inReplyToMessageId, bodyText: finalText });
    expect((await new AxeBuilder({ page }).include('[data-testid="composer"]').analyze()).violations).toEqual([]);
    mkdirSync("/tmp/terno-early-compose/shots", { recursive: true });
    await page.screenshot({ path: `/tmp/terno-early-compose/shots/${scheme}-${selection}.png` });
  } finally { release(); handlers["drafts.sourceContext"] = source; }
});

for (const exit of ["Escape", "focus", "navigation"] as const) test(`early input cannot take over after ${exit} @design`, async ({ app: page, server }) => {
  let response!: () => void, sourceId: number | undefined, watching = false;
  const received = new Promise<void>((resolve) => { response = resolve; });
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => { const frame = JSON.parse(String(payload)) as { t: string; m?: string; id: number }; if (watching && frame.t === "req" && frame.m === "drafts.sourceContext") sourceId = frame.id; });
    socket.on("framereceived", ({ payload }) => { const frame = JSON.parse(String(payload)) as { t: string; id: number }; if (sourceId !== undefined && frame.t === "res" && frame.id === sourceId) response(); });
  });
  await page.reload(); await page.locator("[data-ready]").waitFor();
  await openRow(page, 0); await focusList(page); await page.keyboard.press("r");
  const body = page.getByTestId("compose-body"); await expect(body).toBeFocused();
  await page.keyboard.type("Keep"); await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  await page.keyboard.press("Escape");
  const before = await server.backend.server.invoke("drafts.list", {}, ctx);
  const handlers = (server.backend.server as unknown as { handlers: Record<string, (...args: unknown[]) => unknown> }).handlers;
  const source = handlers["drafts.sourceContext"]!;
  let release!: () => void, entered = 0;
  const gate = new Promise<void>((r) => { release = r; });
  handlers["drafts.sourceContext"] = async (...args) => { entered++; await gate; return source(...args); };
  try {
    watching = true;
    await focusList(page); await page.keyboard.press("r"); await expect.poll(() => entered).toBe(1);
    await page.keyboard.type("uncommitted");
    if (exit === "Escape") await page.keyboard.press("Escape");
    else if (exit === "focus") await page.getByTestId("compose-button").focus();
    else await openRow(page, 1);
    release();
    await received;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    if (exit === "Escape") await expect(page.getByTestId("draft-collapsed")).toBeVisible();
    else if (exit === "focus") await expect(page.getByTestId("compose-button")).toBeFocused();
    expect(await server.backend.server.invoke("drafts.list", {}, ctx)).toEqual(before);
  } finally { release(); handlers["drafts.sourceContext"] = source; }
});

test("input after scheduling the focus frame still belongs to that reply @design", async ({ app: page }) => {
  await openRow(page, 0); await focusList(page); await page.keyboard.press("r");
  const body = page.getByTestId("compose-body"); await expect(body).toBeFocused();
  await page.keyboard.type("Keep"); await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  await page.keyboard.press("Escape"); await expect(page.getByTestId("draft-collapsed")).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __focusFrames: FrameRequestCallback[]; __releaseFocusFrames(): void };
    const raf = window.requestAnimationFrame.bind(window); w.__focusFrames = [];
    window.requestAnimationFrame = (callback) => {
      if (new Error().stack?.includes("compose-focus-move")) { w.__focusFrames.push(callback); return -w.__focusFrames.length; }
      return raf(callback);
    };
    w.__releaseFocusFrames = () => { window.requestAnimationFrame = raf; for (const callback of w.__focusFrames.splice(0)) raf(callback); };
  });
  try {
    await focusList(page); await page.keyboard.press("r");
    await expect.poll(() => page.evaluate(() => (window as unknown as { __focusFrames: unknown[] }).__focusFrames.length)).toBeGreaterThan(0);
    await page.keyboard.type("j");
    await expect(page.locator("textarea.sr-only")).toHaveValue("j");
    await page.evaluate(() => (window as unknown as { __releaseFocusFrames(): void }).__releaseFocusFrames());
    await expect(body).toHaveText("jKeep"); await expect(body).toBeFocused();
  } finally { await page.evaluate(() => (window as unknown as { __releaseFocusFrames(): void }).__releaseFocusFrames()); }
});
