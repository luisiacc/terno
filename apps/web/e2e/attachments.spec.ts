import { parseRaw } from "@terno/mail";
import type { IncomingMessage } from "@terno/store";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { expect, openRow, selectThread, stabilize, test } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

test.use({ backendOptions: { smtpCapture: true } });

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
    await page.screenshot({ path: `/tmp/terno-attachments-evidence/composer-${testInfo.project.name}-${theme}.png` });
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
    await page.screenshot({ path: `/tmp/terno-attachments-evidence/reader-${testInfo.project.name}-${theme}.png` });
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
    await page.screenshot({ path: `/tmp/terno-scoped-fixes-evidence/conversion-${testInfo.project.name}-${theme}.png` });
  }
  await page.getByTestId("compose-send").click();
  await expect.poll(() => server.smtp.length).toBe(1);
  expect((await parseRaw(server.smtp[0]!.raw)).attachments[0]!.bytes).toEqual(new Uint8Array(bytes));
});
