import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const bytes = Buffer.from([0, 255, 128, 13, 10, 42, 17, 0, 99]);
const original = "Original authored body";
const committedText = `${original} committed`;
const latest = `${committedText} latest`;
const finalText = `${committedText} X`;
const artifactDir = `/tmp/terno-w12-lost-ack-${process.env.WEB_PORT ?? "55760"}`;

declare global {
  interface Window {
    lostAck: { armed: boolean; delivered: boolean; reject?: () => void; result?: unknown; calls: number };
  }
}

for (const theme of ["light", "dark"] as const) {
  test(`committed save with lost renderer delivery ${theme}`, async ({ page, context }) => {
    const unexpected: string[] = [];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(test.info().project.use.baseURL!).origin) return route.continue();
      unexpected.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort();
    });
    await page.goto(`/?demo=20&mailbox=w12-lost-ack-${theme}`);
    await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage)).toBe("opfs-sqlite");
    await page.evaluate((theme) => window.__ternoWeb!.client.call("settings.update", { theme }), theme);
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage)).toBe("opfs-sqlite");
    await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
    await page.getByTestId("compose-button").click();
    await page.getByTestId("compose-to").fill("recipient@example.test");
    await page.getByTestId("compose-to").press("Enter");
    await page.getByTestId("compose-subject").fill("Lost acknowledgement");
    await page.getByTestId("attachment-input").setInputFiles({ name: "evidence.bin", mimeType: "application/octet-stream", buffer: bytes });
    const body = page.getByTestId("compose-body");
    await body.fill(original);
    await expect.poll(async () => (await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]?.bodyText).toBe(original);
    await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
    const baseline = (await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]!;
    expect(baseline.subject).toBe("Lost acknowledgement");
    expect(baseline.to).toEqual([expect.objectContaining({ email: "recipient@example.test" })]);
    expect(baseline.attachments).toHaveLength(1);
    const baselineSavedRev = await page.evaluate(async () => {
      const path = "/src/lib/drafts.ts";
      const drafts = await import(/* @vite-ignore */ path) as typeof import("../../src/lib/drafts");
      return Object.values(drafts.useDrafts.getState().drafts).find((d) => d.id !== null)!.savedRev;
    });
    await page.evaluate(() => {
      const client = window.__ternoWeb!.client, call = client.call.bind(client);
      window.lostAck = { armed: true, delivered: false, calls: 0 };
      Object.defineProperty(client, "call", { value: (...args: Parameters<typeof call>) => {
        if (args[0] !== "drafts.save" || !window.lostAck.armed) return call(...args);
        window.lostAck.armed = false; window.lostAck.calls++;
        return call(...args).then((result) => new Promise((_, reject) => {
          window.lostAck.result = result; window.lostAck.delivered = true;
          window.lostAck.reject = () => reject(new Error("synthetic renderer delivery loss"));
        }));
      } });
    });
    await body.click(); await body.press("End"); await page.keyboard.type(" committed");
    await expect.poll(() => page.evaluate(() => window.lostAck.delivered)).toBe(true);
    const committed = (await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]!;
    const assertCommitted = (row: typeof committed) => expect(row).toMatchObject({ id: baseline.id, generation: baseline.generation, revision: baseline.revision + 1, bodyText: committedText });
    assertCommitted(committed);
    expect(await page.evaluate(() => window.lostAck.result)).toEqual(committed);
    expect(() => assertCommitted({ ...committed, bodyText: original })).toThrow();
    await expect(body).toBeFocused(); await page.keyboard.type(" latest");
    await expect(body).toHaveText(latest);
    await expect(page.getByTestId("draft-status")).not.toHaveText("Draft saved");
    const pending = await page.evaluate(async () => {
      const path = "/src/lib/drafts.ts";
      const drafts = await import(/* @vite-ignore */ path) as typeof import("../../src/lib/drafts");
      const d = Object.values(drafts.useDrafts.getState().drafts).find((item) => item.id !== null)!;
      return { id: d.id, generation: d.generation, revision: d.revision, localRev: d.localRev, savedRev: d.savedRev, admission: drafts.beginDraftAckRead(d).kind, handoff: await drafts.draftsSaved(10) };
    });
    expect(pending).toMatchObject({ id: baseline.id, generation: baseline.generation, revision: baseline.revision, admission: "refused", handoff: false });
    expect(pending.savedRev).toBe(baselineSavedRev);
    expect(pending.localRev).toBeGreaterThan(pending.savedRev);
    for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowLeft");
    const selection = () => page.evaluate(() => ({ anchor: getSelection()!.anchorOffset, focus: getSelection()!.focusOffset, text: getSelection()!.toString(), active: document.activeElement === document.querySelector('[data-testid="compose-body"]') }));
    const before = await selection();
    expect(before.active).toBe(true); expect(before.anchor).toBeGreaterThan(before.focus); expect(before.text).toBe("latest");
    const nodes = await page.evaluateHandle(() => ({ body: document.querySelector('[data-testid="compose-body"]'), anchor: getSelection()!.anchorNode, focus: getSelection()!.focusNode }));
    await page.evaluate(() => window.lostAck.reject!());
    await expect(body).toBeFocused();
    expect(await selection()).toEqual(before);
    expect(await page.evaluate((old) => old.body === document.querySelector('[data-testid="compose-body"]') && old.anchor === getSelection()!.anchorNode && old.focus === getSelection()!.focusNode, nodes)).toBe(true);
    await expect.poll(async () => (await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {}))).length).toBe(2);
    await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
    expect(await selection()).toEqual(before);
    expect(await page.evaluate((old) => old.body === document.querySelector('[data-testid="compose-body"]') && old.anchor === getSelection()!.anchorNode && old.focus === getSelection()!.focusNode, nodes)).toBe(true);
    await nodes.dispose();
    const rows = await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {}));
    const preserved = rows.find((d) => d.id === baseline.id)!;
    const copy = rows.find((d) => d.id !== baseline.id)!;
    expect(preserved).toEqual(committed);
    expect(copy).toMatchObject({ revision: 1, subject: baseline.subject, to: baseline.to, bodyText: latest, attachments: baseline.attachments });
    expect(copy.generation).not.toBe(baseline.generation);
    const assertBytes = (value: { dataBase64: string | null }) => expect(value).toEqual({ dataBase64: bytes.toString("base64") });
    const readBytes = (row: typeof copy) => page.evaluate((d) => window.__ternoWeb!.client.call("attachments.read", { accountId: d.accountId, assetId: d.attachments![0]!.assetId, index: 0 }), row);
    for (const row of rows) assertBytes(await readBytes(row));
    expect(() => assertBytes({ dataBase64: Buffer.from([0, 255]).toString("base64") })).toThrow();
    expect((await new AxeBuilder({ page }).include('[data-testid="composer"]').analyze()).violations).toEqual([]);
    await page.screenshot({ path: `${artifactDir}/${theme}.png` });
    await page.keyboard.type("X"); await expect(body).toHaveText(finalText);
    await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
    const updated = (await page.evaluate((id) => window.__ternoWeb!.client.call("drafts.list", {}).then((items) => items.find((d) => d.id === id)), copy.id))!;
    expect(updated).toEqual({ ...copy, bodyText: finalText, bodyHtml: copy.bodyHtml!.replace(latest, finalText), revision: copy.revision + 1, updatedAt: updated.updatedAt });
    assertBytes(await readBytes(updated));
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage)).toBe("opfs-sqlite");
    expect(await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {}))).toEqual(expect.arrayContaining([committed, updated]));
    for (const row of rows) expect(await page.evaluate((d) => window.__ternoWeb!.client.call("attachments.read", { accountId: d.accountId, assetId: d.attachments![0]!.assetId, index: 0 }), row)).toEqual({ dataBase64: bytes.toString("base64") });
    await page.locator(`[data-testid="strip-item"][data-key="srv-${copy.id}"]`).click();
    await expect(body).toHaveText(finalText);
    await body.click(); await expect(body).toBeFocused();
    await page.keyboard.press("End"); await page.keyboard.type(" reopened");
    await expect(body).toHaveText(`${finalText} reopened`);
    await expect.poll(async () => (await page.evaluate((id) => window.__ternoWeb!.client.call("drafts.list", {}).then((items) => items.find((d) => d.id === id)), copy.id))?.bodyText).toBe(`${finalText} reopened`);
    const resumed = (await page.evaluate((id) => window.__ternoWeb!.client.call("drafts.list", {}).then((items) => items.find((d) => d.id === id)), copy.id))!;
    expect(resumed).toEqual({ ...updated, bodyText: `${finalText} reopened`, bodyHtml: updated.bodyHtml!.replace(finalText, `${finalText} reopened`), revision: updated.revision + 1, updatedAt: resumed.updatedAt });
    assertBytes(await readBytes(resumed));
    expect((await page.evaluate((id) => window.__ternoWeb!.client.call("drafts.list", {}).then((items) => items.find((d) => d.id === id)), baseline.id))).toEqual(committed);
    expect(unexpected).toEqual([]);
  });
}
