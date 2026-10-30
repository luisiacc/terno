import type { MethodName, ParamsOf } from "@terno/core/rpc";
import { expect, test } from "@playwright/test";

test("actual pending Send refuses Settings storage switching before export and preserves later missing work", async ({ page }) => {
  await page.goto("/?demo=200"); await page.getByTestId("thread-row").first().waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Compose", exact: true }).click(); const body = page.getByTestId("compose-body");
  await body.click(); await body.press("Meta+b"); await page.keyboard.type("pending send exact work");
  await page.getByTestId("compose-to").fill('"Pérez, Ana" <ana@example.test>');
  await page.getByTestId("attachment-input").setInputFiles({ name: "pending.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 128]) });
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  const html = await body.innerHTML();
  await page.evaluate(async () => {
    const c = window.__ternoWeb!.client, old = (await c.call("drafts.list", {}))[0]!;
    await c.call("drafts.delete", { id: old.id, generation: old.generation });
    const call = c.call.bind(c); Object.assign(window, { sendReached: false, exportCalls: 0 });
    Object.defineProperty(c, "call", { value: <M extends MethodName>(method: M, params: ParamsOf<M>) => {
      if (method === "app.export") Reflect.set(window, "exportCalls", Reflect.get(window, "exportCalls") + 1);
      if (method !== "compose.send") return call(method, params);
      Reflect.set(window, "sendReached", true);
      return new Promise((resolve, reject) => Reflect.set(window, "releaseSend", () => call(method, params).then(resolve, reject)));
    } });
  });
  await page.getByTestId("compose-send").click(); await expect.poll(() => page.evaluate(() => Reflect.get(window, "sendReached"))).toBe(true);
  const pin = await page.evaluate(() => localStorage.getItem("terno:storage:terno"));
  let navigations = 0; page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations++; });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.keyboard.press("Meta+k");
  await page.getByTestId("palette-input").fill("settings storage"); await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: "Engine" }).click(); await page.getByTestId("storage-engine-idb").click();
  await page.getByTestId("storage-switch-dialog-confirm").click();
  await expect(page.getByTestId("snack-message")).toContainText("Save or discard your unsaved drafts before switching storage");
  expect(await page.evaluate(() => Reflect.get(window, "exportCalls"))).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem("terno:carry"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("terno:storage:terno"))).toBe(pin); expect(navigations).toBe(0);
  await page.evaluate(() => Reflect.get(window, "releaseSend")()); await page.keyboard.press("Escape");
  await expect(page.getByTestId("draft-save-copy")).toBeVisible(); expect(await body.innerHTML()).toBe(html);
  await expect(page.getByTestId("draft-status")).toContainText("This draft is gone");
  await page.getByTestId("draft-save-copy").click(); await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  const copy = (await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]!;
  expect(copy.bodyText).toBe("pending send exact work"); expect(copy.bodyHtml).toContain("<b>");
  expect(copy.to).toEqual([{ name: "Pérez, Ana", email: "ana@example.test" }]);
  expect(await page.evaluate((d) => window.__ternoWeb!.client.call("attachments.read", { accountId: d.accountId, assetId: d.attachments![0]!.assetId, index: 0 }), copy)).toEqual({ dataBase64: "AP+A" });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.keyboard.press("Meta+k");
  await page.getByTestId("palette-input").fill("settings storage"); await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: "Engine" }).click(); await page.getByTestId("storage-engine-idb").click();
  await Promise.all([page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame() }), page.getByTestId("storage-switch-dialog-confirm").click()]);
  await page.getByTestId("thread-row").first().waitFor(); expect(await page.evaluate(() => window.__ternoWeb!.storage)).toBe("idb");
  expect((await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]!.bodyText).toBe("pending send exact work");
});
