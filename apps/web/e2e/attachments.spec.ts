import { parseRaw } from "@terno/mail";
import { msg } from "@terno/store/conformance";
import type { IncomingMessage } from "@terno/store";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { expect, openRow, selectThread, stabilize, test } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

test.use({ backendOptions: { smtpCapture: true } });

test("last attachment removal keeps From locked until acknowledgement, then edits autosave across reload @design", async ({ app: page, server }, testInfo) => {
  await openRow(page, 0);
  await page.getByTestId("quick-reply").click();
  await page.getByTestId("attachment-input").setInputFiles({ name: "remove.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 128]) });
  await expect.poll(async () => JSON.parse((await server.backend.store.drafts.list())[0]?.attachments_json ?? "[]").length).toBe(1);
  await page.reload();
  const from = page.getByTestId("compose-from");
  await expect(from).toBeDisabled();
  const saved = (await server.backend.store.drafts.list())[0]!;
  const accounts = await server.backend.store.accounts.list();
  const other = accounts.find((a) => a.id !== saved.account_id)!;
  const save = server.backend.store.drafts.save;
  let release!: () => void; let reached!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const waiting = new Promise<void>((r) => { reached = r; });
  server.backend.store.drafts.save = async (...args) => {
    if (args[0].id === saved.id && args[0].attachments?.length === 0) { reached(); await gate; }
    return save(...args);
  };
  try {
    await page.getByRole("button", { name: "Remove remove.bin" }).click();
    await expect(from).toBeDisabled();
    await expect(page.getByTestId("compose-body")).toBeFocused();
    await page.keyboard.type("typed during removal");
    await waiting;
    await expect(from).toBeDisabled();
    release();
    await expect(from).toBeEnabled();
    await from.focus();
    await page.keyboard.press("Space");
    await page.getByRole("option", { name: `${other.displayName} · ${other.email}`, exact: true }).click();
    await expect(from).toContainText(other.email);
    await page.getByTestId("compose-body").fill("later edit survives account change");
    await expect.poll(async () => (await server.backend.store.drafts.list())[0]?.body_text).toBe("later edit survives account change");
    expect((await server.backend.store.drafts.list())[0]!.account_id).toBe(other.id);
    await page.reload();
    await expect(page.getByTestId("compose-body")).toHaveText("later edit survives account change");
    await expect(page.getByTestId("compose-from")).toContainText(other.email);
    await expect(page.getByTestId("draft-attachment")).toHaveCount(0);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await stabilize(page);
      expect((await new AxeBuilder({ page }).include("[data-testid=composer]").analyze()).violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`from-${theme}.png`) });
    }
  } finally { release(); server.backend.store.drafts.save = save; }
});

test("attachments attach/remove/reload/send/download exact bytes @design", async ({ app: page, server }, testInfo) => {
  await openRow(page, 0);
  await page.getByTestId("quick-reply").click();
  const bytes = Buffer.from([0, 255, 128, 1, 2, 13, 10]);
  await page.getByTestId("attachment-input").setInputFiles([{ name: "résumé.bin", mimeType: "application/octet-stream", buffer: bytes }, { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) }]);
  await expect(page.getByTestId("draft-attachment")).toHaveCount(2);
  await expect.poll(() => sqlDb(server.backend.store).get<{ n: number }>("SELECT count(*) AS n FROM drafts WHERE json_array_length(attachments_json) = 2")?.n).toBe(1);
  await page.reload();
  await expect(page.getByTestId("draft-attachment")).toHaveCount(2);
  await page.getByRole("button", { name: "Remove empty.txt" }).click();
  await expect(page.getByTestId("draft-attachment")).toHaveCount(1);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    await stabilize(page);
    expect((await new AxeBuilder({ page }).include("[data-testid=composer]").analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`composer-${theme}.png`) });
  }
  await page.getByTestId("compose-send").click();
  await expect(page.getByTestId("composer")).toHaveCount(0);
  const tile = page.getByTestId("message").last().getByRole("button", { name: "Download résumé.bin" });
  const download = page.waitForEvent("download");
  await tile.click();
  const result = await download;
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await stabilize(page);
    await page.screenshot({ path: testInfo.outputPath(`reader-${theme}.png`) });
  }
  expect(result.suggestedFilename()).toBe("résumé.bin");
  expect(readFileSync((await result.path())!)).toEqual(bytes);
  await expect.poll(() => server.smtp.length).toBe(1);
  expect((await parseRaw(server.smtp[0]!.raw)).attachments[0]!.bytes).toEqual(new Uint8Array(bytes));
  const sent = (await server.backend.store.debug.snapshot()).ops.find((o) => o.kind === "send")!;
  const op = (await server.backend.store.ops.get(sent.id))!;
  expect(JSON.parse(op.payload_json).attachments).toHaveLength(1);
  expect(op.payload_json).not.toContain("dataBase64");
});


test("offline CID consent and forwarding retain exact account-owned bytes @design", async ({ app: page, server }) => {
  const [account] = await server.backend.store.accounts.list();
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVuoAAAAASUVORK5CYII=", "base64");
  const now = Date.now();
  const incoming: IncomingMessage = {
    accountId: account!.id, providerMsgId: "inline-bytes", providerThreadId: null, rfcMessageId: "inline@test.com", inReplyTo: null, references: [],
    from: { name: "Image", email: "image@test.com" }, to: [{ name: "Me", email: account!.email }], cc: [], bcc: [], subject: "Attachment fixture", date: now, snippet: "Inline image", bodyText: "Inline image", bodyHtml: '<p>Inline image</p><img src="cid:PHOTO%40TEST" alt="Local photo"><img src="https://pixel.invalid/track" alt="Remote pixel">', bodyState: "full", listId: null,
    isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: bytes.length,
    attachments: [{ filename: "photo.png", mime: "image/png", size: bytes.length, contentId: "photo@test", bytes }],
  };
  const { touched } = await server.backend.store.sync.ingest([incoming], { applyFilters: false, now, classifier: null });
  await server.backend.server.invoke("settings.update", { localMode: true }, { clientId: "setup", origin: "dev" });
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  const remote: string[] = [];
  await page.route("https://pixel.invalid/**", async (route) => { remote.push(route.request().url()); await route.abort(); });
  await selectThread(page, touched[0]!, 'subject:"Attachment fixture"');
  const image = page.getByTestId("message").locator("iframe").contentFrame().getByAltText("Local photo");
  await expect(image).not.toHaveAttribute("src", /^data:/);
  expect(remote).toEqual([]);
  await page.getByTestId("inline-load").click();
  await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/);
  expect(remote).toEqual([]);
  await page.getByTestId("action-forward").click();
  await expect(page.getByTestId("draft-attachment")).toHaveCount(1);
  await page.getByTestId("compose-to").fill("recipient@test.com");
  await page.getByTestId("compose-send").click();
  await expect.poll(() => server.smtp.length).toBe(1);
  expect((await parseRaw(server.smtp[0]!.raw)).attachments[0]!.bytes).toEqual(new Uint8Array(bytes));
});


test("sending during attachment staging refuses a partial revision @design", async ({ app: page, server }) => {
  await openRow(page, 0);
  await page.getByTestId("quick-reply").click();
  const store = server.backend.store;
  const seal = store.attachments.seal;
  let release!: () => void; let reached!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const sealing = new Promise<void>((r) => { reached = r; });
  store.attachments.seal = async (...args) => { reached(); await gate; return seal(...args); };
  try {
    await page.getByTestId("attachment-input").setInputFiles({ name: "racing.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0,255,128]) });
    await sealing;
    await page.getByTestId("compose-body").focus();
    await page.keyboard.press("Meta+Enter");
    await expect(page.getByTestId("composer")).toBeVisible();
    expect((await store.debug.snapshot()).ops.filter((o) => o.kind === "send")).toHaveLength(0);
    release();
    await expect(page.getByTestId("draft-attachment")).toHaveCount(1);
    await page.getByTestId("compose-send").click();
    await expect.poll(() => server.smtp.length).toBe(1);
    expect((await parseRaw(server.smtp[0]!.raw)).attachments[0]!.bytes).toEqual(new Uint8Array([0,255,128]));
  } finally { release(); store.attachments.seal = seal; }
});


test("attachment-only reply survives reload and mode conversion with exact Undo @design", async ({ app: page, server }, testInfo) => {
  await openRow(page, 0);
  await page.getByTestId("quick-reply").click();
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  await page.getByTestId("attachment-input").setInputFiles({ name: "authored.bin", mimeType: "application/octet-stream", buffer: bytes });
  const saved = () => sqlDb(server.backend.store).get<{ id: string; attachments_json: string; mode: string }>("SELECT id, attachments_json, mode FROM drafts WHERE json_array_length(attachments_json) = 1");
  await expect.poll(() => saved()?.mode).toBe("reply");
  const refs = JSON.parse(saved()!.attachments_json);
  await page.reload();
  await expect(page.getByTestId("draft-attachment")).toHaveCount(1);
  await page.getByTestId("action-reply-all").click();
  await expect(page.getByTestId("draft-attachment")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Undo convert to reply all" })).toBeVisible();
  await page.getByRole("button", { name: "Undo convert to reply all" }).click();
  await expect(page.getByTestId("composer")).toHaveAttribute("data-mode", "reply");
  await page.getByTestId("action-reply-all").click();
  await expect.poll(() => saved()?.mode).toBe("replyAll");
  expect(JSON.parse(saved()!.attachments_json)).toEqual(refs);
  await page.reload();
  await expect(page.getByTestId("composer")).toHaveAttribute("data-mode", "replyAll");
  await expect(page.getByTestId("draft-attachment")).toHaveCount(1);
  expect(JSON.parse(saved()!.attachments_json)).toEqual(refs);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await stabilize(page);
    await page.screenshot({ path: testInfo.outputPath(`conversion-${theme}.png`) });
  }
  await page.getByTestId("compose-send").click();
  await expect.poll(() => server.smtp.length).toBe(1);
  expect((await parseRaw(server.smtp[0]!.raw)).attachments[0]!.bytes).toEqual(new Uint8Array(bytes));
});

test("Forward refuses foreign account refs before changing authored work, with keyboard recovery @design", async ({ app: page, server }, testInfo) => {
  const accounts = await server.backend.store.accounts.list();
  const source = accounts[0]!, other = accounts[1]!;
  const { touched } = await server.backend.store.sync.ingest([msg({ accountId: source.id, providerMsgId: "from-convert", subject: "From conversion fixture", attachments: [
    { filename: "binary.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) },
    { filename: "empty.txt", mime: "text/plain", size: 0, bytes: new Uint8Array() },
  ] })], { applyFilters: false, now: Date.now(), classifier: null });
  await page.reload();
  await selectThread(page, touched[0]!, 'subject:"From conversion fixture"');
  await page.getByTestId("quick-reply").click();
  const from = page.getByTestId("compose-from");
  await from.focus(); await page.keyboard.press("Space");
  await page.getByRole("option", { name: `${other.displayName} · ${other.email}`, exact: true }).focus();
  await page.keyboard.press("Enter");
  const body = page.getByTestId("compose-body");
  await body.fill("work from the selected account");
  await expect.poll(async () => (await server.backend.store.drafts.list())[0]?.body_text).toBe("work from the selected account");
  const before = (await server.backend.store.drafts.list())[0]!;
  const forward = page.getByTestId("action-forward");
  await forward.focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("draft-attachment")).toHaveCount(0);
  await expect(body).toHaveText("work from the selected account");
  await expect(from).toContainText(other.email);
  await expect(page.getByTestId("snack-message").getByText(`To forward these attachments, choose ${source.email} in From.`, { exact: true })).toBeVisible();
  expect(await server.backend.store.drafts.list()).toEqual([before]);
  await page.getByTestId("snack-dock").hover();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addStyleTag({ content: "*{caret-color:transparent!important}" });
    expect((await new AxeBuilder({ page }).include("[data-testid=composer]").include('[aria-label="Notifications"]').analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`forward-${theme}.png`) });
  }
  await body.fill("later text remains savable");
  await expect.poll(async () => (await server.backend.store.drafts.list())[0]?.body_text).toBe("later text remains savable");
  await page.reload();
  await selectThread(page, touched[0]!, 'subject:"From conversion fixture"');
  await expect(body).toHaveText("later text remains savable");
  await expect(from).toContainText(other.email);
  // Follow the explanation using only keyboard controls.
  await from.focus(); await page.keyboard.press("Space");
  await page.getByRole("option", { name: `${source.displayName} · ${source.email}`, exact: true }).focus();
  await page.keyboard.press("Enter");
  await forward.focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("draft-attachment")).toHaveCount(2);
  await expect(body).toHaveText("later text remains savable");
  await expect.poll(async () => (await server.backend.store.drafts.list())[0]?.mode).toBe("forward");
  await page.reload();
  await selectThread(page, touched[0]!, 'subject:"From conversion fixture"');
  const saved = (await server.backend.store.drafts.list())[0]!;
  const refs = JSON.parse(saved.attachments_json);
  expect(refs.map((p: { filename: string }) => p.filename)).toEqual(["binary.bin", "empty.txt"]);
  expect(await server.backend.store.attachments.read(source.id, refs[0].assetId, 0)).toBe("AP+A");
  expect(await server.backend.store.attachments.read(source.id, refs[1].assetId, 0)).toBe(null);
  await expect(body).toHaveText("later text remains savable");
});
