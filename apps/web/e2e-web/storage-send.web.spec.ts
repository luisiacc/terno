import AxeBuilder from "@axe-core/playwright";
import type { Draft, MethodName, ParamsOf } from "@terno/core/rpc";
import { expect, test, type Page } from "@playwright/test";

const authored = {
  subject: "Pending exact subject",
  bodyText: "pending send exact work",
  bodyHtml: "<div><b>pending send exact work</b></div>",
  to: [{ name: "Pérez, Ana", email: "ana@example.test" }],
  cc: [{ name: "", email: "copy@example.test" }],
  bcc: [{ name: "", email: "private@example.test" }],
};
function exactWork(draft: Draft, bytes: unknown) {
  expect(draft).toMatchObject(authored);
  expect(draft.attachments).toEqual([expect.objectContaining({ filename: "pending.bin", mime: "application/octet-stream", size: 3 })]);
  expect(bytes).toEqual({ dataBase64: "AP+A" });
}
async function readWork(page: Page) {
  const drafts = await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {}));
  expect(drafts).toHaveLength(1);
  const draft = drafts[0]!;
  const bytes = await page.evaluate((d) => window.__ternoWeb!.client.call("attachments.read", { accountId: d.accountId, assetId: d.attachments![0]!.assetId, index: 0 }), draft);
  exactWork(draft, bytes);
  return draft;
}
async function storageSettings(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Meta+k");
  await page.getByTestId("palette-input").fill("settings storage");
  await page.keyboard.press("Enter");
}
async function chooseIdb(page: Page) {
  await page.getByRole("combobox", { name: "Engine" }).click();
  await page.getByTestId("storage-engine-idb").click();
  await page.getByTestId("storage-switch-dialog-confirm").click();
}
function refusal(observed: { exports: number; carry: string | null; pin: string | null; navigations: number }, pin: string | null) {
  expect(observed).toEqual({ exports: 0, carry: null, pin, navigations: 0 });
}

for (const scheme of ["light", "dark"] as const) test(`actual pending Send refuses Settings storage switching before export and preserves later missing work (${scheme})`, async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: scheme });
  await page.context().route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.goto("/?demo=200&storage=opfs-sqlite");
  await page.getByTestId("thread-row").first().waitFor({ timeout: 60_000 });
  expect(await page.evaluate(() => window.__ternoWeb!.storage)).toBe("opfs-sqlite");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const body = page.getByTestId("compose-body");
  await body.click(); await body.press("Meta+b"); await page.keyboard.type(authored.bodyText);
  await page.getByTestId("compose-to").fill('"Pérez, Ana" <ana@example.test>');
  await page.getByTestId("compose-show-cc").click();
  await page.getByTestId("compose-cc").fill("copy@example.test");
  await page.getByTestId("compose-show-bcc").click();
  await page.getByTestId("compose-bcc").fill("private@example.test");
  await page.getByTestId("compose-subject").fill(authored.subject);
  await page.getByTestId("compose-subject").press("Tab");
  await page.getByTestId("attachment-input").setInputFiles({ name: "pending.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 128]) });
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  const editorHtml = await body.innerHTML();
  const old = await readWork(page);
  // Each readback-only counterexample must independently trip the fixed authored oracle.
  expect(() => exactWork({ ...old, bodyHtml: "<div>lost bold</div>" }, { dataBase64: "AP+A" })).toThrow();
  expect(() => exactWork({ ...old, to: [] }, { dataBase64: "AP+A" })).toThrow();
  expect(() => exactWork(old, { dataBase64: "AP+B" })).toThrow();
  await page.evaluate(() => {
    const c = window.__ternoWeb!.client, call = c.call.bind(c);
    Object.assign(window, { sends: [], exports: 0, dispatched: 0, sendError: null, phases: [] });
    Object.defineProperty(c, "call", { configurable: true, value: <M extends MethodName>(method: M, params: ParamsOf<M>) => {
      if (method === "app.export") Reflect.set(window, "exports", Reflect.get(window, "exports") + 1);
      if (method !== "compose.send") return call(method, params);
      Reflect.get(window, "sends").push(params); Reflect.get(window, "phases").push("held");
      return new Promise((resolve, reject) => Reflect.set(window, "releaseSend", () => {
        Reflect.set(window, "dispatched", Reflect.get(window, "dispatched") + 1);
        Reflect.get(window, "phases").push("dispatched");
        call(method, params).then(resolve, (error: { code?: string; details?: unknown }) => {
          Reflect.set(window, "sendError", { code: error.code, details: error.details });
          Reflect.get(window, "phases").push("refused"); reject(error);
        });
      }));
    } });
  });
  await page.getByTestId("compose-send").click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "sends").length)).toBe(1);
  const held = await page.evaluate(() => Reflect.get(window, "sends")[0]);
  expect(held).toMatchObject({ ...authored, bodyHtml: `<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body>${authored.bodyHtml}</body></html>`, draftId: old.id, draftGeneration: old.generation, draftRevision: old.revision, attachments: old.attachments });
  expect(await readWork(page)).toEqual(old);
  expect(await page.evaluate(() => Reflect.get(window, "dispatched"))).toBe(0);
  const pin = await page.evaluate(() => localStorage.getItem("terno:storage:terno"));
  expect(pin).toBe("opfs-sqlite");
  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
  await storageSettings(page); await chooseIdb(page);
  await expect(page.getByTestId("snack-message")).toContainText("Save or discard your unsaved drafts before switching storage");
  const observation = await page.evaluate(() => ({ exports: Reflect.get(window, "exports"), carry: sessionStorage.getItem("terno:carry"), pin: localStorage.getItem("terno:storage:terno") }));
  refusal({ ...observation, navigations }, pin);
  for (const altered of [{ exports: 1 }, { carry: "lost" }, { pin: "idb" }, { navigations: 1 }]) expect(() => refusal({ ...observation, navigations, ...altered }, pin)).toThrow();
  await page.evaluate(async (draft) => {
    Reflect.get(window, "phases").push("switch-refused");
    await window.__ternoWeb!.client.call("drafts.delete", { id: draft.id, generation: draft.generation });
    Reflect.get(window, "phases").push("deleted");
  }, old);
  expect(await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {}))).toEqual([]);
  await page.evaluate(() => Reflect.get(window, "releaseSend")());
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "sendError"))).toMatchObject({ code: "STALE", details: { reason: "draftMissing" } });
  expect(await page.evaluate(() => Reflect.get(window, "dispatched"))).toBe(1);
  expect(await page.evaluate(() => window.__ternoWeb!.client.call("ops.list", {}))).toEqual([]);
  const phases = await page.evaluate(() => Reflect.get(window, "phases"));
  const expectedPhases = ["held", "switch-refused", "deleted", "dispatched", "refused"];
  expect(phases).toEqual(expectedPhases);
  expect(() => expect(["deleted", ...phases]).toEqual(expectedPhases)).toThrow();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("draft-save-copy")).toBeVisible();
  expect(await body.innerHTML()).toBe(editorHtml);
  await expect(page.getByTestId("draft-status")).toContainText("This draft is gone");
  await expect(page.getByTestId("compose-subject")).toHaveValue(authored.subject);
  for (const field of ["to", "cc", "bcc"] as const) {
    await expect(page.locator(`[data-recipient-field="compose-${field}"] [data-email]`)).toHaveAttribute("data-email", authored[field][0]!.email);
  }
  await page.screenshot({ path: testInfo.outputPath(`missing-${scheme}.png`) });
  expect((await new AxeBuilder({ page }).include('[data-testid="composer"]').analyze()).violations).toEqual([]);
  await page.getByTestId("draft-save-copy").focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  const copy = await readWork(page);
  expect(copy.generation).not.toBe(old.generation);
  expect(copy.attachments).toEqual(old.attachments);
  await storageSettings(page); await chooseIdb(page);
  await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage).catch(() => null)).toBe("idb");
  await expect.poll(() => page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {}))).toHaveLength(1);
  const imported = await readWork(page);
  expect(imported.attachments).toEqual(copy.attachments!.map((ref) => ({ ...ref, assetId: expect.any(String) })));
  expect(await page.evaluate(() => localStorage.getItem("terno:storage:terno"))).toBe("idb");
  expect(await page.evaluate(() => sessionStorage.getItem("terno:carry"))).toBeNull();
  await page.reload(); await page.getByTestId("thread-row").first().waitFor();
  expect(await page.evaluate(() => window.__ternoWeb!.storage)).toBe("idb");
  expect(await readWork(page)).toEqual(imported);
});
