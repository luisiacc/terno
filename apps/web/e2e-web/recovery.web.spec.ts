import type { MethodName, ParamsOf } from "@terno/core/rpc";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
const shots = "/tmp/terno-missing-draft-r2-shots";
mkdirSync(shots, { recursive: true });

for (const surface of ["worker", "render"] as const) for (const recovery of ["missing", "unknown"] as const) test(`${surface} failure Retry preserves ${recovery} work and Review drafts remains accessible`, async ({ page }) => {
  await page.addInitScript(`{
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(...args) { super(...args); window.failMailWorker = () => this.dispatchEvent(new ErrorEvent('error', { message: 'synthetic worker failure' })); }
    };
  }`);
  await page.goto("/?demo=200"); await page.getByTestId("thread-row").first().waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const body = page.getByTestId("compose-body"); await body.fill("retained exact work");
  await body.press("Meta+a"); await body.press("Meta+b"); await body.press("ArrowRight");
  await page.getByTestId("compose-to").fill('"Pérez, Ana" <ana@example.test>, bob@');
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  await page.evaluate(async () => { const c = window.__ternoWeb!.client, d = (await c.call("drafts.list", {}))[0]!; await c.call("drafts.delete", { id: d.id, generation: d.generation }); });
  await body.click(); await body.click(); await body.press("ArrowRight"); await body.press("Meta+ArrowRight"); await page.keyboard.type(" latest"); await expect(page.getByTestId("draft-save-copy")).toBeVisible();
  if (recovery === "unknown") {
    await page.evaluate(() => {
      const c = window.__ternoWeb!.client, call = c.call.bind(c);
      Object.defineProperty(c, "call", { value: async <M extends MethodName>(m: M, p: ParamsOf<M>) => {
        const result = await call(m, p);
        if (m === "drafts.save" && !(p && typeof p === "object" && "id" in p && p.id)) throw { code: "TIMEOUT" };
        return result;
      } });
    });
    await page.getByTestId("draft-save-copy").click();
    await expect(page.getByTestId("draft-status")).toContainText("may already exist");
  }
  await expect(body).toHaveText("retained exact work latest");
  if (surface === "worker") await page.evaluate("window.failMailWorker()");
  else await page.evaluate("window.__terno.throwIn('app')");
  await expect(page.getByTestId(surface === "worker" ? "web-fatal" : "app-boundary")).toBeVisible();
  const navigation = page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame(), timeout: 2000 }).then(() => true, () => false);
  await page.getByTestId(surface === "worker" ? "web-reload" : "app-boundary-reload").click();
  expect(await navigation).toBe(false);
  await expect(page.getByTestId("recovery-reload-warning")).toContainText("unsaved changes");
  await page.getByTestId("recovery-review").focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("recovery-workspace")).toBeVisible(); await expect(body).toHaveText("retained exact work latest");
  await expect(body.locator("b")).toHaveText("retained exact work latest");
  await expect(page.getByTestId("compose-to")).toHaveValue("");
  await expect(page.getByTestId("recovery-workspace")).toContainText("Pérez, Ana");
  await expect(page.getByTestId("recovery-workspace")).toContainText("bob@");
  await expect(body).toBeFocused();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `${shots}/${surface}-${recovery}-${theme}.png` });
  }
  await page.getByTestId("recovery-details").click();
  await page.getByTestId(surface === "worker" ? "web-reload" : "app-boundary-reload").click();
  await expect(page.getByTestId("recovery-force")).toHaveAccessibleName("Reload anyway and discard unsaved changes and pending files");
  await Promise.all([page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame() }), page.getByTestId("recovery-force").click()]);
});
