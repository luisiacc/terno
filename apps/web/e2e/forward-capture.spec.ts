/**
 * Plan 60: Forward never waits for the original’s files. It opens at once (what
 * was written stays, autosave goes on); files not on the device yet are asked for
 * again and join the draft when they come; ones that never come are named, with
 * Try again, and the forward still sends without them.
 */
import AxeBuilder from "@axe-core/playwright";
import { msg } from "@terno/store/conformance";
import { parseRaw } from "@terno/mail";
import { expect, selectThread, test } from "./fixtures";

test.use({ backendOptions: { smtpCapture: true } });

test("Forward opens while the original downloads; its files join when captured, and what was written survives @design", async ({ app: page, server }, testInfo) => {
  const store = server.backend.store, [account] = await store.accounts.list();
  // the account's sync never captures it on its own here: the files come when the test says
  (server.backend as unknown as { syncAccount: () => Promise<void> }).syncAccount = async () => {};
  const { touched } = await store.sync.ingest([msg({ accountId: account!.id, providerMsgId: "pending-forward", subject: "Pending Forward fixture", bodyState: "none", bodyText: null, bodyHtml: null, attachments: undefined, hasAttachments: true })], { applyFilters: false, now: Date.now(), classifier: null });
  await page.reload();
  await selectThread(page, touched[0]!, 'subject:"Pending Forward fixture"');
  await page.getByTestId("quick-reply").click();
  const body = page.getByTestId("compose-body");
  await body.fill("Keep my reply while the original downloads");
  await expect.poll(async () => (await store.drafts.list())[0]?.body_text).toBe("Keep my reply while the original downloads");

  const forward = page.getByTestId("action-forward");
  await forward.focus(); await page.keyboard.press("Enter");
  // at once: a forward, focus in To, the text kept, and the draft says the files are coming
  await expect(page.getByTestId("compose-to")).toBeFocused();
  await expect(body).toHaveText("Keep my reply while the original downloads");
  const status = page.getByTestId("forward-files");
  await expect(status).toHaveText("Getting the original’s files…");
  await expect.poll(async () => (await store.drafts.list())[0]?.mode).toBe("forward");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    expect((await new AxeBuilder({ page }).include("[data-testid=composer]").analyze()).violations).toEqual([]);
    await page.getByTestId("composer").screenshot({ path: `/tmp/terno-forward-files/fetching-${testInfo.project.name}-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });

  // the capture lands (as a sync would bring it): the files join the forward, and are saved with it
  const messageId = (await store.threads.get(touched[0]!))!.messages[0]!.id;
  await store.sync.setBody(messageId, "Original captured", null, { now: Date.now(), classifier: null, attachments: [{ filename: "exact.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) }, { filename: "empty.txt", mime: "text/plain", size: 0, bytes: new Uint8Array() }] });
  server.backend.notifyChanged(touched);
  await expect(page.getByTestId("draft-attachment")).toHaveCount(2);
  await expect(status).toHaveCount(0);
  await expect.poll(async () => JSON.parse((await store.drafts.list())[0]?.attachments_json ?? "[]").length).toBe(2);
  await expect(body).toHaveText("Keep my reply while the original downloads");

  // later typing stays saved, and a reload keeps the forward with its files
  await body.fill("Later typing stays saved");
  await expect.poll(async () => (await store.drafts.list())[0]?.body_text).toBe("Later typing stays saved");
  await page.reload();
  await selectThread(page, touched[0]!, 'subject:"Pending Forward fixture"');
  await expect(body).toHaveText("Later typing stays saved");
  await expect(page.getByTestId("draft-attachment")).toHaveCount(2);
  const refs = (await store.threads.get(touched[0]!))!.messages[0]!.attachments;
  expect(await store.attachments.read(account!.id, refs[0]!.assetId!, 0)).toBe("AP+A");
});

test("files that never come are named with Try again, and the forward sends without them", async ({ app: page, server }, testInfo) => {
  test.setTimeout(90_000);
  const store = server.backend.store, [account] = await store.accounts.list();
  // nothing captures it: every retry (and sync) leaves it where it is
  (server.backend as unknown as { syncAccount: () => Promise<void> }).syncAccount = async () => {};
  let retries = 0;
  const retry = store.attachments.retry.bind(store.attachments);
  store.attachments.retry = async (...args) => { retries++; return retry(...args); };
  const { touched } = await store.sync.ingest([msg({ accountId: account!.id, providerMsgId: "lost-forward", subject: "Lost files fixture", bodyText: "The report is attached.", attachments: [{ filename: "report.pdf", mime: "application/pdf", size: 1200 }], hasAttachments: true })], { applyFilters: false, now: Date.now(), classifier: null });
  await page.reload();
  await selectThread(page, touched[0]!, 'subject:"Lost files fixture"');
  await page.getByTestId("action-forward").click();
  await expect(page.getByTestId("compose-to")).toBeFocused();
  const status = page.getByTestId("forward-files");
  await expect(status).toHaveText("Getting report.pdf from the original…");
  // three tries (now, ~4 s, ~15 s), then it says so and stops
  await expect(status).toHaveAttribute("data-status", "failed", { timeout: 40_000 });
  await expect(status).toContainText("Couldn’t get report.pdf, so this forward won’t include it.");
  expect(retries).toBe(3);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    expect((await new AxeBuilder({ page }).include("[data-testid=composer]").analyze()).violations).toEqual([]);
    await page.getByTestId("composer").screenshot({ path: `/tmp/terno-forward-files/failed-${testInfo.project.name}-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
  // Try again: three more tries
  await page.getByTestId("forward-files-retry").click();
  await expect(status).toHaveAttribute("data-status", "fetching");
  await expect.poll(() => retries).toBe(4);

  await page.getByTestId("compose-to").fill("recipient@test.com");
  await page.getByTestId("compose-send").click();
  await expect.poll(() => server.smtp.length).toBe(1);
  expect((await parseRaw(server.smtp[0]!.raw)).attachments).toEqual([]);
});
