import AxeBuilder from "@axe-core/playwright";
import { msg } from "@terno/store/conformance";
import { expect, selectThread, test } from "./fixtures";

const unavailable = "The original files are not ready. Wait for the download or choose Retry, then try Forward again.";

test("Forward waits for original capture and preserves reply, focus and subsequent autosave @design", async ({ app: page, server }, testInfo) => {
  const store = server.backend.store, [account] = await store.accounts.list();
  const { touched } = await store.sync.ingest([msg({ accountId: account!.id, providerMsgId: "pending-forward", subject: "Pending Forward fixture", bodyState: "none", bodyText: null, bodyHtml: null, attachments: undefined, hasAttachments: true })], { applyFilters: false, now: Date.now(), classifier: null });
  await page.reload();
  await selectThread(page, touched[0]!, 'subject:"Pending Forward fixture"');
  await page.getByTestId("action-forward").click();
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(page.getByTestId("snack-message")).toContainText(unavailable);
  expect((await store.debug.snapshot()).ops.filter((o) => o.kind === "send")).toHaveLength(0);
  await page.getByTestId("quick-reply").click();
  const body = page.getByTestId("compose-body");
  await body.fill("Keep my reply while the original downloads");
  await expect.poll(async () => (await store.drafts.list())[0]?.body_text).toBe("Keep my reply while the original downloads");
  const before = (await store.drafts.list())[0]!;
  const forward = page.getByTestId("action-forward");
  await forward.focus(); await page.keyboard.press("Enter");
  await expect(forward).toBeFocused();
  await expect(body).toHaveText(before.body_text);
  await expect(page.getByTestId("draft-attachment")).toHaveCount(0);
  await expect(page.getByTestId("snack-message")).toContainText(unavailable);
  expect(await store.drafts.list()).toEqual([before]);
  await page.getByTestId("snack-dock").hover();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    expect((await new AxeBuilder({ page }).include("[data-testid=composer]").include('[aria-label="Notifications"]').analyze()).violations).toEqual([]);
    await page.screenshot({ path: `/tmp/terno-attachments-r4-evidence/capture-${testInfo.project.name}-${theme}.png` });
  }
  await body.fill("Later typing stays saved");
  await expect.poll(async () => (await store.drafts.list())[0]?.body_text).toBe("Later typing stays saved");
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("language-select").click(); await page.getByTestId("language-es").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "es-MX");
  await page.keyboard.press("Escape");
  await forward.click();
  await expect(page.getByTestId("snack-message")).toContainText("Los archivos originales aún no están listos.");
  await page.getByTestId("snack-dock").hover();
  expect((await new AxeBuilder({ page }).include("[data-testid=composer]").include('[aria-label="Notificaciones"]').analyze()).violations).toEqual([]);
  const messageId = (await store.threads.get(touched[0]!))!.messages[0]!.id;
  await store.sync.setBody(messageId, "Original captured", null, { now: Date.now(), classifier: null, attachments: [{ filename: "exact.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) }, { filename: "empty.txt", mime: "text/plain", size: 0, bytes: new Uint8Array() }] });
  await page.reload();
  await selectThread(page, touched[0]!, 'subject:"Pending Forward fixture"');
  await expect(body).toHaveText("Later typing stays saved");
  await expect(page.getByTestId("draft-attachment")).toHaveCount(0);
  await forward.click();
  await expect(page.getByTestId("draft-attachment")).toHaveCount(2);
  await expect.poll(async () => (await store.drafts.list())[0]?.mode).toBe("forward");
  const refs = (await store.threads.get(touched[0]!))!.messages[0]!.attachments;
  expect(await store.attachments.read(account!.id, refs[0]!.assetId!, 0)).toBe("AP+A");
  expect(await store.attachments.info(account!.id, refs[1]!.assetId!)).toMatchObject({ size: 0 });
});
