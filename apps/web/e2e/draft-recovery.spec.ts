import AxeBuilder from "@axe-core/playwright";
import { RpcError } from "@terno/core/rpc";
import { mkdirSync } from "node:fs";
import { expect, openRow, stabilize, test } from "./fixtures";

const shots = "/tmp/terno-missing-draft-shots";
mkdirSync(shots, { recursive: true });

test("terminal draft copy keeps rich history, caret, recipient chips and exact files @design", async ({ app: page, server }, info) => {
  await openRow(page, 0); await page.getByTestId("quick-reply").click();
  const body = page.getByTestId("compose-body");
  await body.fill("bold authored work"); await body.press("Meta+a"); await body.press("Meta+b"); await body.press("ArrowRight");
  await page.getByTestId("attachment-input").setInputFiles({ name: "exact.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 128]) });
  await expect.poll(async () => (await server.backend.store.drafts.list())[0]?.body_text).toBe("bold authored work");
  await expect.poll(async () => JSON.parse((await server.backend.store.drafts.list())[0]?.attachments_json ?? "[]").length).toBe(1);
  const original = (await server.backend.store.drafts.list())[0]!;
  await server.backend.store.drafts.delete(original.id);
  const save = server.backend.store.drafts.save;
  let release!: () => void; let reached!: () => void;
  const gate = new Promise<void>((r) => { release = r; }); const waiting = new Promise<void>((r) => { reached = r; });
  server.backend.store.drafts.save = async (...args) => { if (args[0].id === original.id) { reached(); await gate; } return save(...args); };
  try {
    await body.press("End"); await page.keyboard.type(" newer"); await waiting;
    await page.getByTestId("compose-to").fill('"Pérez, Ana" <ana@example.com>, bob@');
    await body.click(); await body.press("End"); await page.keyboard.type(" latest");
    release();
    const action = page.getByTestId("draft-save-copy");
    await expect(action).toHaveText("Save a copy");
    await expect(page.getByTestId("draft-status")).toContainText("It may have been sent");
    await expect(page.getByTestId("compose-send")).toBeDisabled();
    const exact = await body.innerHTML();
    await body.press("Meta+Enter"); await expect(body).toBeFocused();
    expect((await server.backend.store.ops.recent(10)).filter((o) => o.kind === "send")).toEqual([]);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme }); await stabilize(page);
      expect((await new AxeBuilder({ page }).include("[data-testid=composer]").analyze()).violations).toEqual([]);
      await page.screenshot({ path: `${shots}/missing-${info.project.name}-${theme}.png` });
    }
    await body.focus(); await body.press("ArrowLeft");
    await page.getByTestId("format-italic").click();
    await expect(page.getByTestId("format-italic")).toHaveAttribute("aria-pressed", "true");
    const caret = await page.evaluate(() => ({ offset: window.getSelection()?.anchorOffset, text: window.getSelection()?.anchorNode?.textContent }));
    await action.focus(); await page.keyboard.press("Enter");
    await expect(action).toHaveCount(0); await expect(body).toBeFocused();
    expect(await body.innerHTML()).toBe(exact);
    await expect(page.getByTestId("format-italic")).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => ({ offset: window.getSelection()?.anchorOffset, text: window.getSelection()?.anchorNode?.textContent }))).toEqual(caret);
    await page.clock.setFixedTime(new Date((await page.evaluate(() => Date.now())) + 1000));
    await page.keyboard.type("X"); await expect(body.locator("i")).toHaveText("X"); await body.press("Meta+z"); expect(await body.innerHTML()).toBe(exact);
    await expect.poll(async () => (await server.backend.store.drafts.list()).length).toBe(1);
    const copy = (await server.backend.store.drafts.list())[0]!;
    expect(copy.id).not.toBe(original.id);
    expect(copy.body_html).toContain("<b>");
    expect(copy.to_json).toContain("bob@"); expect(copy.to_json).toContain("Pérez, Ana");
    const ref = JSON.parse(copy.attachments_json)[0];
    expect(await server.backend.store.attachments.read(copy.account_id, ref.assetId, 0)).toBe("AP+A");
    await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
    await page.reload(); await expect(body).toHaveText(copy.body_text);
    await expect(page.getByTestId("draft-attachment")).toContainText("exact.bin");
  } finally { release(); server.backend.store.drafts.save = save; }
});

test("an uncertain copy is disclosed and only another explicit copy can proceed @design", async ({ app: page, server }, info) => {
  await openRow(page, 0); await page.getByTestId("quick-reply").click();
  const body = page.getByTestId("compose-body"); await body.fill("keep uncertain work");
  await expect.poll(async () => (await server.backend.store.drafts.list())[0]?.body_text).toBe("keep uncertain work");
  const original = (await server.backend.store.drafts.list())[0]!; await server.backend.store.drafts.delete(original.id);
  await body.press("End"); await page.keyboard.type(" latest");
  await expect(page.getByTestId("draft-save-copy")).toBeVisible();
  const save = server.backend.store.drafts.save; let creates = 0;
  server.backend.store.drafts.save = async (...args) => { const result = await save(...args); if (args[0].id === undefined && ++creates === 1) throw new RpcError("TIMEOUT", "synthetic timeout"); return result; };
  try {
    await page.getByTestId("draft-save-copy").click();
    await expect(page.getByTestId("draft-status")).toContainText("may already exist");
    await expect(page.getByTestId("draft-save-copy")).toHaveText("Save another copy");
    await expect(page.getByTestId("compose-send")).toBeDisabled();
    await body.focus(); await body.press("End"); await page.keyboard.type(" still here");
    await body.press("Meta+Enter"); expect(creates).toBe(1);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme }); await stabilize(page);
      expect((await new AxeBuilder({ page }).include("[data-testid=composer]").analyze()).violations).toEqual([]);
      await page.screenshot({ path: `${shots}/unknown-${info.project.name}-${theme}.png` });
    }
    expect(creates).toBe(1);
    await page.getByTestId("draft-save-copy").focus(); await page.keyboard.press("Enter");
    await expect(page.getByTestId("draft-save-copy")).toHaveCount(0);
    expect(creates).toBe(2); expect(await server.backend.store.drafts.list()).toHaveLength(2);
    expect((await server.backend.store.ops.recent(10)).filter((o) => o.kind === "send")).toEqual([]);
    await expect(body).toContainText("still here");
  } finally { server.backend.store.drafts.save = save; }
});

test("typing during a copy ACK keeps focus and busy activation shares one creation @design", async ({ app: page, server }) => {
  await openRow(page, 0); await page.getByTestId("quick-reply").click();
  const body = page.getByTestId("compose-body"); await body.fill("copy baseline");
  await expect.poll(async () => (await server.backend.store.drafts.list())[0]?.body_text).toBe("copy baseline");
  const original = (await server.backend.store.drafts.list())[0]!; await server.backend.store.drafts.delete(original.id);
  await body.press("End"); await page.keyboard.type(" retained"); await expect(page.getByTestId("draft-save-copy")).toBeVisible();
  const save = server.backend.store.drafts.save; let creates = 0; let release!: () => void; let reached!: () => void;
  const gate = new Promise<void>((r) => { release = r; }); const waiting = new Promise<void>((r) => { reached = r; });
  server.backend.store.drafts.save = async (...args) => { const result = await save(...args); if (args[0].id === undefined) { creates++; reached(); await gate; } return result; };
  try {
    const action = page.getByTestId("draft-save-copy"); await action.focus(); await page.keyboard.press("Enter"); await waiting;
    await expect(action).toHaveAttribute("aria-busy", "true"); await page.keyboard.press("Enter"); expect(creates).toBe(1);
    await body.focus(); await body.press("End"); await page.keyboard.type(" typed during copy");
    release(); await expect(action).toHaveCount(0); await expect(body).toBeFocused();
    await expect(body).toHaveText("copy baseline retained typed during copy");
    await expect.poll(async () => (await server.backend.store.drafts.list())[0]?.body_text).toBe("copy baseline retained typed during copy");
    expect(creates).toBe(1);
  } finally { release(); server.backend.store.drafts.save = save; }
});

test("missing account and files stay explicit; removing refs permits the sole connected From account @design", async ({ app: page, server }) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.keyboard.press("c");
  const body = page.getByTestId("compose-body"); await body.fill("account recovery text");
  await page.getByTestId("attachment-input").setInputFiles({ name: "unavailable.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 128]) });
  await expect.poll(async () => JSON.parse((await server.backend.store.drafts.list())[0]?.attachments_json ?? "[]").length).toBe(1);
  const draft = (await server.backend.store.drafts.list())[0]!;
  const accounts = await server.backend.store.accounts.list(); const remaining = accounts.find((a) => a.id !== draft.account_id)!;
  for (const account of accounts) if (account.id !== remaining.id) await server.backend.server.invoke("accounts.remove", { id: account.id }, { clientId: "synthetic-recovery", origin: "dev" });
  await body.press("End"); await page.keyboard.type(" retained");
  await expect(page.getByTestId("draft-save-copy")).toBeVisible(); await page.getByTestId("draft-save-copy").click();
  await expect(page.getByTestId("draft-status")).toContainText("Choose a connected From account");
  const from = page.getByTestId("compose-from"); await expect(from).toBeVisible(); await expect(from).toBeDisabled();
  await page.getByRole("button", { name: "Remove unavailable.bin", exact: true }).click(); await expect(from).toBeEnabled();
  await from.focus(); await page.keyboard.press("Space"); await page.getByRole("option", { name: `${remaining.displayName} · ${remaining.email}`, exact: true }).click();
  await page.getByTestId("draft-save-copy").click(); await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  expect((await server.backend.store.drafts.list())[0]).toMatchObject({ account_id: remaining.id, body_text: "account recovery text retained", attachments_json: "[]" });
});

test("restart hold preserves the rich document, caret, history and marks until cancellation @design", async ({ app: page, server }, info) => {
  await openRow(page, 0); await page.getByTestId("quick-reply").click();
  const body = page.getByTestId("compose-body"); await body.fill("exact rich work");
  await body.press("Meta+a"); await body.press("Meta+b"); await body.press("ArrowRight"); await body.press("ArrowLeft");
  await page.getByTestId("format-italic").click(); await expect(page.getByTestId("format-italic")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await server.backend.store.drafts.list())[0]?.body_text).toBe("exact rich work");
  const html = await body.innerHTML();
  const caret = await page.evaluate(() => ({ offset: window.getSelection()?.anchorOffset, text: window.getSelection()?.anchorNode?.textContent }));
  await page.evaluate("window.releaseDraftHold = window.__terno.acquireDraftHold()");
  await expect(page.getByTestId("draft-status")).toHaveText("Preparing to restart. Draft editing is paused.");
  await page.keyboard.type("blocked"); await page.keyboard.press("Meta+z"); await page.keyboard.press("c");
  expect(await body.innerHTML()).toBe(html);
  expect(await page.evaluate(() => ({ offset: window.getSelection()?.anchorOffset, text: window.getSelection()?.anchorNode?.textContent }))).toEqual(caret);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme }); await stabilize(page);
    expect((await new AxeBuilder({ page }).include("[data-testid=composer]").analyze()).violations).toEqual([]);
    await page.screenshot({ path: `${shots}/restart-${info.project.name}-${theme}.png` });
  }
  await page.evaluate("window.releaseDraftHold()");
  await expect(body).toBeFocused();
  await expect(page.getByTestId("format-italic")).toHaveAttribute("aria-pressed", "true");
  await page.clock.setFixedTime(new Date((await page.evaluate(() => Date.now())) + 1000));
  await page.keyboard.type("X"); await expect(body.locator("i")).toHaveText("X");
  await body.press("Meta+z"); expect(await body.innerHTML()).toBe(html);
});
