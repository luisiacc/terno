import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { bytesBase64, encodeText } from "@terno/core";
import { L } from "@terno/i18n";
import { expect, test as base } from "./fixtures";

const test = base.extend<{ localRoutes: void }>({
  localRoutes: [async ({ context }, use) => {
    const unexpected: string[] = [];
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (["127.0.0.1", "localhost"].includes(url.hostname)) return route.continue();
      unexpected.push(url.origin); return route.abort();
    });
    try { await use(); } finally { expect(unexpected).toEqual([]); }
  }, { auto: true }],
});

for (const language of ["en", "es"] as const) for (const theme of ["light", "dark"] as const) test(`recipient outcomes remain discoverable (${language}, ${theme})`, async ({ app: page, server }) => {
  const externalRoutes: string[] = [];
  await page.route("**/*", (route) => { const url = new URL(route.request().url()); if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return route.continue(); externalRoutes.push(url.origin); return route.abort(); });
  const ctx = { clientId: "recipient-ui", origin: "dev" as const }, store = server.backend.store;
  let recoveryCalls = 0, clearCalls = 0, releaseRecovery!: () => void;
  const gate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  server.backend.recoverRejectedRecipients = async () => { recoveryCalls++; await gate; return crypto.randomUUID(); };
  const originalClear = server.backend.forgetRecipientReceipt.bind(server.backend);
  server.backend.forgetRecipientReceipt = async (id) => { clearCalls++; return originalClear(id); };
  const account = (await store.accounts.list()).find((entry) => entry.kind === "imap")!;
  const config = (await store.accounts.config<Record<string, unknown>>(account.id))!;
  await store.accounts.setProviderConfig(account.id, { ...config, appendToSent: false });
  const queued = await store.compose.queueSend({ accountId: account.id, to: [{ name: "", email: "accepted@example.test" }, { name: "", email: "refused@example.test" }], cc: [], bcc: [{ name: "", email: "unknown@example.test" }], subject: "Synthetic recipient receipt", bodyText: "Synthetic", recordReply: false, now: Date.now() });
  expect((await store.ops.claimReady(Date.now(), 100)).some((op) => op.id === queued.opId)).toBe(true);
  await store.sendCopies.startWire(queued.opId, 1); await store.sendCopies.appendWire(queued.opId, 0, bytesBase64(new Uint8Array([65]))); await store.sendCopies.sealWire(queued.opId);
  const warning = encodeText(L("errors.smtp.notDeliveredTo", { recipients: "refused@example.test" }));
  await store.ops.complete(queued.opId, { warning, sendAccepted: { warning, outcomes: [{ email: "accepted@example.test", outcome: "accepted" }, { email: "refused@example.test", outcome: "rejected" }, { email: "unknown@example.test", outcome: "unknown" }] } }, Date.now());
  await server.backend.server.invoke("settings.update", { theme, language, senderIcons: false }, ctx);
  await page.addInitScript((value) => localStorage.setItem("terno:language", value), language);
  await page.reload(); await page.locator("[data-ready]").waitFor();
  const warningOp = server.backend.opInfo((await store.ops.get(queued.opId))!);
  if (theme === "dark") await page.evaluate(`import("/src/lib/snack.ts").then(({ snack, registerUndo }) => {
    snack.loading("Unrelated loading", { id: "unrelated-loading" });
    snack("Unrelated Undo", { action: { label: "Undo", undo: registerUndo(() => {}) } });
  })`);
  server.backend.server.emit("op", warningOp);
  const dock = page.getByTestId("snack-dock");
  if (theme === "light") await expect(dock).toContainText("refused@example.test");
  else await expect.poll(() => page.evaluate(`import("/src/lib/snack.ts").then(({ snackRetentionForTests }) => snackRetentionForTests().queued.length)`)).toBe(1);
  await page.getByTestId("open-settings").click(); await page.getByTestId("tab-accounts").click();
  const editor = page.locator(`[data-testid=settings-account][data-account-id="${account.id}"]`); await editor.getByTestId("account-toggle").click();
  const recovery = editor.getByTestId("recipient-recovery"); await expect(recovery.getByTestId("recipient-receipt-row")).toHaveCount(1);
  await recovery.getByRole("button", { name: language === "en" ? "Show recipients" : "Mostrar destinatarios" }).click();
  await expect(recovery).toContainText("accepted@example.test"); await expect(recovery).toContainText("refused@example.test"); await expect(recovery).toContainText("unknown@example.test");
  await expect(recovery.getByRole("button", { name: language === "en" ? "Send to refused recipients" : "Enviar a destinatarios rechazados" })).toBeEnabled();
  expect((await new AxeBuilder({ page }).include("[data-testid=settings-dialog]").analyze()).violations).toEqual([]);
  await recovery.scrollIntoViewIfNeeded(); mkdirSync("/tmp/terno-w01-snack/r4/screenshots", { recursive: true }); await page.getByTestId("settings-dialog").screenshot({ path: `/tmp/terno-w01-snack/r4/screenshots/${language}-${theme}.png` });
  await recovery.getByRole("button", { name: language === "en" ? "Send to refused recipients" : "Enviar a destinatarios rechazados" }).focus(); await page.keyboard.press("Enter");
  await expect.poll(() => recoveryCalls).toBe(1);
  const clear = recovery.getByRole("button", { name: language === "en" ? "Clear details" : "Borrar detalles" });
  await expect(clear).toBeDisabled(); await clear.focus(); await page.keyboard.press("Enter");
  expect(clearCalls).toBe(0); await expect(recovery.getByTestId("recipient-receipt-row")).toHaveCount(1);
  releaseRecovery(); await expect(clear).toBeEnabled();
  await clear.focus(); await page.keyboard.press("Enter");
  await expect(recovery.getByTestId("recipient-receipt-row")).toHaveCount(0); expect(clearCalls).toBe(1);
  expect((await store.ops.get(queued.opId))?.last_error).not.toContain("refused@example.test");
  await page.keyboard.press("Escape");
  if (theme === "dark") {
    await expect(dock).toContainText("Unrelated Undo");
    await page.getByTestId("snack-close").click();
  }
  await expect(dock).not.toContainText("refused@example.test");
  let checks = 0;
  const readPart = store.recipientReceipts.readPart.bind(store.recipientReceipts);
  store.recipientReceipts.readPart = async (...args) => { checks++; return readPart(...args); };
  server.backend.server.emit("op", warningOp);
  await expect.poll(() => checks).toBeGreaterThan(0);
  await expect(dock).not.toContainText("refused@example.test");
  expect((await store.ops.sendSubmission(queued.opId))?.accepted).toBe(true);
  expect(await store.sendCopies.list(account.id)).toEqual([]);
  expect(externalRoutes).toEqual([]);
  expect((await new AxeBuilder({ page }).include("[data-testid=snack-dock]").analyze()).violations).toEqual([]);
  await page.screenshot({ path: `/tmp/terno-w01-snack/r4/screenshots/${language}-${theme}-cleared.png` });
});

for (const language of ["en", "es"] as const) for (const theme of ["light", "dark"] as const) test(`deferred warning preserves failed Clear and newer feedback (${language}, ${theme})`, async ({ app: page, server }) => {
  const externalRoutes: string[] = [];
  await page.route("**/*", (route) => { const url = new URL(route.request().url()); if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return route.continue(); externalRoutes.push(url.origin); return route.abort(); });
  const store = server.backend.store, ctx = { clientId: "warning-race-ui", origin: "dev" as const };
  const account = (await store.accounts.list()).find((entry) => entry.kind === "imap")!;
  const config = (await store.accounts.config<Record<string, unknown>>(account.id))!;
  await store.accounts.setProviderConfig(account.id, { ...config, appendToSent: false });
  const queue = async (subject: string) => store.compose.queueSend({ accountId: account.id, to: [{ name: "", email: "accepted@example.test" }, { name: "", email: "refused@example.test" }], cc: [], bcc: [], subject, bodyText: "Synthetic", recordReply: false, now: Date.now() });
  const a = await queue("Warning A");
  await store.ops.claimReady(Date.now(), 100);
  for (const id of [a.opId]) { await store.sendCopies.startWire(id, 1); await store.sendCopies.appendWire(id, 0, "YQ=="); await store.sendCopies.sealWire(id); }
  const warning = encodeText(L("errors.smtp.notDeliveredTo", { recipients: "refused@example.test" }));
  await store.ops.complete(a.opId, { warning, sendAccepted: { warning, outcomes: [{ email: "accepted@example.test", outcome: "accepted" }, { email: "refused@example.test", outcome: "rejected" }] } }, Date.now());
  const warningA = server.backend.opInfo((await store.ops.get(a.opId))!);
  await server.backend.server.invoke("settings.update", { theme, language, senderIcons: false }, ctx);
  await page.addInitScript((value) => localStorage.setItem("terno:language", value), language);
  await page.reload(); await page.locator("[data-ready]").waitFor();
  const read = store.recipientReceipts.readPart.bind(store.recipientReceipts);
  let release!: () => void, reads = 0, settled = 0;
  let gate = new Promise<void>((resolve) => { release = resolve; });
  store.recipientReceipts.readPart = async (...args) => {
    const part = await read(...args);
    if (args[0] === a.opId && args[1] === "envelope" && args[2] === 0) { reads++; if (reads === 1) await gate; settled++; }
    return part;
  };
  const retire = store.recipientReceipts.retireSlice.bind(store.recipientReceipts);
  let clearCalls = 0;
  store.recipientReceipts.retireSlice = async (...args) => { clearCalls++; if (clearCalls === 1) throw new Error("Synthetic retirement refused"); return retire(...args); };
  try {
    server.backend.server.emit("op", warningA);
    await expect.poll(() => reads).toBe(1);
    await page.getByTestId("open-settings").click(); await page.getByTestId("tab-accounts").click();
    const editor = page.locator(`[data-testid=settings-account][data-account-id="${account.id}"]`);
    await editor.getByTestId("account-toggle").click();
    const recovery = editor.getByTestId("recipient-recovery");
    const clear = recovery.getByRole("button", { name: language === "en" ? "Clear details" : "Borrar detalles" }).first();
    await expect(clear).toBeEnabled(); await clear.focus(); await page.keyboard.press("Enter");
    await expect(recovery.getByRole("alert")).toBeVisible();
    expect(clearCalls).toBe(1);
    await expect.poll(() => settled).toBe(1); // advisory retirement validation is live; the original warning remains held
    release(); await expect.poll(() => settled).toBe(2);
    await page.keyboard.press("Escape");
    const dock = page.getByTestId("snack-dock");
    await expect(dock).toContainText("refused@example.test");
    expect((await new AxeBuilder({ page }).include("[data-testid=snack-dock]").analyze()).violations).toEqual([]);
    mkdirSync("/tmp/terno-w01-snack/r4/screenshots", { recursive: true });
    await page.screenshot({ path: `/tmp/terno-w01-snack/r4/screenshots/${language}-${theme}-failed-clear.png` });
    await page.getByTestId("snack-close").click();
    reads = 0; settled = 0; gate = new Promise<void>((resolve) => { release = resolve; });
    server.backend.server.emit("op", warningA); await expect.poll(() => reads).toBe(1);
    const b = await queue("Newer B");
    await store.ops.claimReady(Date.now(), 100);
    await store.sendCopies.startWire(b.opId, 1); await store.sendCopies.appendWire(b.opId, 0, "YQ=="); await store.sendCopies.sealWire(b.opId);
    await store.ops.complete(b.opId, theme === "dark" ? { warning: "Synthetic B copy failure" } : {}, Date.now());
    server.backend.server.emit("op", server.backend.opInfo((await store.ops.get(b.opId))!));
    const message = theme === "dark" ? "Synthetic B copy failure" : language === "en" ? "Message sent" : "Correo enviado";
    await expect(dock).toContainText(message);
    release(); await expect.poll(() => settled).toBe(1);
    await expect(dock).toContainText(message); await expect(dock).not.toContainText("refused@example.test");
    expect((await new AxeBuilder({ page }).include("[data-testid=snack-dock]").analyze()).violations).toEqual([]);
    await page.screenshot({ path: `/tmp/terno-w01-snack/r4/screenshots/${language}-${theme}-newer-feedback.png` });
    expect(externalRoutes).toEqual([]);
  } finally { release(); store.recipientReceipts.readPart = read; store.recipientReceipts.retireSlice = retire; }
});
