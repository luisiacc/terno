import { readFile } from "node:fs/promises";
import { AWAITING_IDENTITY } from "@terno/store";
import { sqlDb } from "../../backend-dev/src/server";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { asset, body, raw, readerFixture } from "../../../packages/backend/src/test/w06-reader-fixture";

const ctx = { clientId: "w06", origin: "dev" as const };
const row = (page: Page, id: number) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);
async function selected(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/state/app.ts";
    const { getApp } = await import(/* @vite-ignore */ path) as typeof import("../src/state/app");
    return getApp().selectedId;
  });
}
async function guard(context: BrowserContext, t: Awaited<ReturnType<typeof readerFixture>>, dropChanges = () => false) {
  const unexpected: string[] = [];
  const base = `http://127.0.0.1:${process.env.E2E_PORT ?? 61730}`;
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin === base && (u.pathname === "/" || u.pathname === "/theme.js" || u.pathname === "/@react-refresh" || ["/src/", "/@vite/", "/@fs/", "/node_modules/", "/fonts/"].some((p) => u.pathname.startsWith(p)))) return route.continue();
    unexpected.push(u.href); return route.abort();
  });
  await context.routeWebSocket("**/*", (socket) => {
    const u = new URL(socket.url());
    if ((u.origin === t.dev.url && u.pathname === "/" && u.search === "?token=w06") || (u.origin === base.replace("http:", "ws:") && u.pathname === "/")) {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        if (dropChanges()) {
          const event = JSON.parse(String(message)) as { t?: string; e?: string };
          if (event.t === "evt" && event.e === "changed") return;
        }
        socket.send(message);
      });
    }
    else { unexpected.push(u.href); socket.close(); }
  });
  return unexpected;
}
for (const theme of ["light", "dark"] as const) {
  test(`COPYUID toolbar move preserves bytes and follows next-row policy (${theme})`, async ({ page, context }, info) => {
    const t = await readerFixture();
    const unexpected = await guard(context, t);
    try {
      const language = theme === "dark" ? "es" : "en";
      await t.dev.backend.server.invoke("settings.update", { theme, language, senderIcons: false, layout: "split" }, ctx);
      const bytes = raw("Mapped reader", body, "mapped", undefined, true);
      const otherBytes = raw("Independent control", "Other complete body\n", "control");
      const source = t.wire.control.addMessage("INBOX", { raw: bytes, flags: ["\\Seen"] });
      const other = t.wire.control.addMessage("INBOX", { raw: otherBytes, flags: ["\\Seen"] });
      await t.dev.backend.syncAccount(t.account.id);
      const list = (await t.dev.backend.server.invoke("threads.list", { view: "inbox" }, ctx)).items;
      const target = list.find((m) => m.subject === "Mapped reader")!;
      const control = list.find((m) => m.subject === "Independent control")!;
      const before = await t.dev.backend.server.invoke("threads.get", { threadId: target.id }, ctx);
      const message = before.messages[0]!;
      const assertContent = async () => {
        const current = await t.dev.backend.server.invoke("threads.get", { threadId: target.id }, ctx);
        expect(current.messages.map((m) => m.id)).toEqual([message.id]);
        expect(current.messages[0]!.bodyText).toBe(body);
        expect(await t.dev.backend.store.attachments.read(t.account.id, current.messages[0]!.attachments[0]!.assetId!, 0)).toBe(asset.toString("base64"));
      };
      await assertContent();
      await page.goto(`/?backend=${encodeURIComponent(t.dev.url)}&token=w06`);
      await page.locator("[data-ready]").waitFor();
      await row(page, control.id).click();
      await expect(page.getByTestId("reader-subject")).toHaveText("Independent control");
      await expect(page.getByRole("listbox")).toBeFocused();
      await expect(row(page, control.id)).toHaveAttribute("aria-selected", "true");
      await row(page, target.id).click();
      await expect(page.locator(`[data-message-id="${message.id}"][data-testid=message]`)).toBeVisible();
      await expect(page.locator(`#msg-body-${message.id}`)).toContainText(body.trimEnd());
      const download = async () => {
        const event = page.waitForEvent("download");
        await page.getByTestId("attachment").getByRole("button").click();
        const file = await event;
        const observed = await readFile((await file.path())!);
        if (process.env.W06_ORACLE === "asset") observed[0] = 99;
        expect(observed).toEqual(asset);
      };
      const observed = {
        selection: await selected(page),
        message: Number(await page.locator("[data-testid=message]").getAttribute("data-message-id")),
        body: await page.locator(`#msg-body-${message.id} .whitespace-pre-wrap`).textContent(),
      };
      if (process.env.W06_ORACLE === "selection") observed.selection = control.id;
      if (process.env.W06_ORACLE === "message") observed.message = message.id + 100;
      if (process.env.W06_ORACLE === "body") observed.body = "wrong cached body";
      expect(observed).toEqual({ selection: target.id, message: message.id, body });
      await download();
      const scroller = page.locator("[data-reader-scroller]");
      await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(600);
      await scroller.evaluate((el) => { el.scrollTop = 600; });
      expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await page.getByTestId("action-trash").focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => selected(page)).toBe(control.id);
      await expect(page.getByTestId("reader-subject")).toHaveText("Independent control");
      await t.dev.backend.runWorker();
      expect((await t.dev.backend.server.invoke("ops.list", {}, ctx)).find((o) => o.kind === "trash")?.state).toBe("succeeded");
      const remote = t.wire.control.listMessages("Trash", { raw: true });
      expect(remote).toHaveLength(1); expect(remote[0]!.raw).toEqual(Buffer.from(bytes));
      expect(t.wire.control.listMessages("INBOX", { raw: true }).map((m) => m.uid)).toEqual([other.uid]);
      expect(t.wire.control.getMessage("INBOX", other.uid, { raw: true }).raw).toEqual(Buffer.from(otherBytes));
      let locations = await t.dev.backend.store.providerStore(t.account.id).locations!.of([message.id]);
      expect(locations).toEqual([expect.objectContaining({ mailbox: "Trash", uidvalidity: t.wire.control.getMailbox("Trash").uidvalidity, uid: remote[0]!.uid })]);
      expect(source.uidvalidity).toBe(t.wire.control.getMailbox("INBOX").uidvalidity);
      await t.dev.backend.syncAccount(t.account.id);
      locations = await t.dev.backend.store.providerStore(t.account.id).locations!.of([message.id]);
      expect(locations).toEqual([expect.objectContaining({ mailbox: "Trash", uidvalidity: t.wire.control.getMailbox("Trash").uidvalidity, uid: remote[0]!.uid })]);
      await assertContent();
      if (await page.getByTestId("nav-more").getAttribute("aria-expanded") !== "true") await page.getByTestId("nav-more").click();
      await page.getByTestId("nav-trash").click();
      await row(page, target.id).click();
      await expect(page.getByTestId("reader-subject")).toHaveText("Mapped reader");
      await expect(page.locator(`#msg-body-${message.id}`)).toContainText(body.trimEnd());
      expect((await new AxeBuilder({ page }).include('[data-testid="reader"]').analyze()).violations).toEqual([]);
      await download();
      await page.screenshot({ path: info.outputPath(`${theme}-${language}.png`) });
      await t.reopen();
      await page.goto(`/?backend=${encodeURIComponent(t.dev.url)}&token=w06`);
      await page.locator("[data-ready]").waitFor();
      if (await page.getByTestId("nav-more").getAttribute("aria-expanded") !== "true") await page.getByTestId("nav-more").click();
      await page.getByTestId("nav-trash").click(); await row(page, target.id).click();
      await expect(page.locator(`#msg-body-${message.id}`)).toContainText(body.trimEnd());
      await assertContent();
      expect(await t.dev.backend.store.providerStore(t.account.id).locations!.of([message.id])).toEqual(locations);
      expect(unexpected).toEqual([]);
    } finally { await t.close(); }
  });
}

test("late IMAP parent joins the existing child thread without replacing its reader", async ({ page, context }, info) => {
  const t = await readerFixture();
  let suppress = false;
  const unexpected = await guard(context, t, () => suppress);
  try {
    await t.dev.backend.server.invoke("settings.update", { senderIcons: false, layout: "split" }, ctx);
    const childBytes = raw("Late chain", "Exact child body", "child", "parent");
    const child = t.wire.control.addMessage("INBOX", { raw: childBytes, flags: ["\\Seen"] });
    await t.dev.backend.syncAccount(t.account.id);
    const thread = (await t.dev.backend.server.invoke("threads.list", { view: "inbox" }, ctx)).items[0]!;
    const message = (await t.dev.backend.server.invoke("threads.get", { threadId: thread.id }, ctx)).messages[0]!;
    await page.goto(`/?backend=${encodeURIComponent(t.dev.url)}&token=w06`); await page.locator("[data-ready]").waitFor();
    await row(page, thread.id).click();
    await expect(page.locator(`#msg-body-${message.id}`)).toHaveText("Exact child body\n");
    suppress = process.env.W06_ORACLE === "late-refresh";
    const parentBytes = raw("Late chain", "Exact parent body", "parent");
    const parent = t.wire.control.addMessage("INBOX", { raw: parentBytes, flags: ["\\Seen"] });
    await t.dev.backend.syncAccount(t.account.id);
    const after = await t.dev.backend.server.invoke("threads.get", { threadId: thread.id }, ctx);
    expect(after.messages).toHaveLength(2);
    expect(after.messages.find((m) => m.id === message.id)).toMatchObject({ bodyText: "Exact child body\n" });
    expect(after.messages.find((m) => m.id !== message.id)).toMatchObject({ bodyText: "Exact parent body\n" });
    const parentMessage = after.messages.find((m) => m.id !== message.id)!;
    await expect(page.locator(`[data-testid=message][data-message-id="${parentMessage.id}"]`)).toBeVisible();
    await expect(page.locator(`#msg-body-${parentMessage.id}`)).toHaveText("Exact parent body\n");
    await expect.poll(() => selected(page)).toBe(thread.id);
    await expect(page.locator(`#msg-body-${message.id}`)).toHaveText("Exact child body\n");
    expect(await t.dev.backend.store.providerStore(t.account.id).locations!.at("INBOX", child.uidvalidity, child.uid)).toBe(message.id);
    expect(t.wire.control.getMessage("INBOX", child.uid, { raw: true }).raw).toEqual(Buffer.from(childBytes));
    expect(t.wire.control.getMessage("INBOX", parent.uid, { raw: true }).raw).toEqual(Buffer.from(parentBytes));
    await page.screenshot({ path: info.outputPath("late-parent.png") });
    expect(unexpected).toEqual([]);
  } finally { await t.close(); }
});

test("external reverse arrival keeps the open cached identity and parked intent", async ({ page, context }, info) => {
  const t = await readerFixture();
  const unexpected = await guard(context, t);
  try {
    await t.dev.backend.server.invoke("settings.update", { theme: "dark", language: "es", senderIcons: false, layout: "split" }, ctx);
    const bytes = raw("Equal envelope", body, "duplicate", undefined, true);
    const siblingBytes = bytes.replace(asset.toString("base64"), Buffer.from([1, 254, 18, 127, 11, 12, 43]).toString("base64"));
    const first = t.wire.control.addMessage("Z", { raw: bytes, flags: ["\\Seen"] });
    const second = t.wire.control.addMessage("Z", { raw: siblingBytes, flags: ["\\Seen"] });
    await t.dev.backend.syncAccount(t.account.id);
    const id = await t.dev.backend.store.providerStore(t.account.id).locations!.at("Z", first.uidvalidity, first.uid);
    const siblingId = await t.dev.backend.store.providerStore(t.account.id).locations!.at("Z", second.uidvalidity, second.uid);
    expect(id).not.toBe(siblingId);
    const list = (await t.dev.backend.server.invoke("threads.list", { view: "all", accountId: t.account.id, folder: "Z" }, ctx)).items;
    const threadId = sqlDb(t.dev.backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", id)!.thread_id;
    const thread = list.find((r) => r.id === threadId)!;
    const detail = await t.dev.backend.server.invoke("threads.get", { threadId: thread.id }, ctx);
    expect(detail.messages.some((m) => m.id === id)).toBe(true);
    await page.goto(`/?backend=${encodeURIComponent(t.dev.url)}&token=w06`); await page.locator("[data-ready]").waitFor();
    await page.getByTestId(`nav-account-${t.account.id}`).click(); await page.getByTestId(`nav-own-${t.account.id}-Z`).click();
    await row(page, thread.id).click();
    const message = page.locator(`[data-testid=message][data-message-id="${id}"]`);
    const toggle = message.getByTestId("message-toggle");
    if (await toggle.count() && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await expect(page.locator(`#msg-body-${id}`)).toContainText(body);
    await page.getByTestId("action-star").focus();
    const scroller = page.locator("[data-reader-scroller]");
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(600);
    await scroller.evaluate((el) => { el.scrollTop = 600; });
    const position = await scroller.evaluate((el) => el.scrollTop);
    const anchor = () => page.locator(`#msg-body-${id} .whitespace-pre-wrap`).evaluate((el) => {
      const node = el.firstChild!;
      const start = node.textContent!.indexOf("Reader anchor 25");
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 16);
      const rect = range.getBoundingClientRect();
      return { text: range.toString(), top: rect.top, left: rect.left, visible: rect.top > 52 && rect.bottom < innerHeight };
    });
    const beforeAnchor = await anchor();
    expect(beforeAnchor.visible).toBe(true);
    await t.dev.backend.server.invoke("threads.act", { threadIds: [thread.id], action: "star" }, ctx);
    const op = (await t.dev.backend.server.invoke("ops.list", {}, ctx)).find((o) => o.kind === "star")!;
    let moved = false;
    const hook = t.wire.script.add({ on: "response", command: "STATUS", delay: 0, when(c) {
      if (!moved && /\* STATUS "?A"? /i.test(c.data)) {
        moved = true; t.wire.control.moveMessages("Z", [second.uid], "A"); t.wire.control.moveMessages("Z", [first.uid], "A");
      }
      return false;
    } });
    try { await t.dev.backend.syncAccount(t.account.id); } finally { hook.remove(); }
    expect(moved).toBe(true);
    await t.dev.backend.runWorker();
    await expect.poll(() => selected(page)).toBe(thread.id);
    await expect(page.locator(`#msg-body-${id}`)).toContainText(body);
    await expect(page.getByTestId("action-star")).toBeFocused();
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(position);
    expect(await anchor()).toEqual(beforeAnchor);
    expect(await t.dev.backend.store.providerStore(t.account.id).locations!.of([id!])).toEqual([]);
    const held = await t.dev.backend.store.ops.get(op.id);
    expect(held).toMatchObject({ state: "queued", attempts: 0, next_attempt_at: AWAITING_IDENTITY });
    expect(JSON.parse(held!.target_json)).toEqual({ messageIds: [id] });
    const remote = t.wire.control.listMessages("A", { raw: true });
    expect(remote.map((m) => m.raw)).toEqual([Buffer.from(siblingBytes), Buffer.from(bytes)]);
    expect(remote.every((m) => !m.flags.includes("\\Flagged"))).toBe(true);
    expect(t.wire.control.listMessages("Z")).toEqual([]);
    if (process.env.W06_ORACLE === "external-asset") {
      const siblingThread = sqlDb(t.dev.backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", siblingId)!.thread_id;
      const sibling = (await t.dev.backend.server.invoke("threads.get", { threadId: siblingThread }, ctx)).messages.find((m) => m.id === siblingId)!;
      await page.evaluate(async ({ threadId, messageId, attachment }) => {
        const path = "/src/state/threads.ts";
        const { useThreads } = await import(/* @vite-ignore */ path) as typeof import("../src/state/threads");
        const state = useThreads.getState();
        const details = new Map(state.details);
        const detail = details.get(threadId)!;
        details.set(threadId, { ...detail, messages: detail.messages.map((m) => m.id === messageId ? { ...m, attachments: [attachment] } : m) });
        useThreads.setState({ details, version: state.version + 1 });
      }, { threadId: thread.id, messageId: id!, attachment: sibling.attachments[0]! });
    }
    const downloaded = page.waitForEvent("download");
    await message.getByTestId("attachment").getByRole("button").click();
    expect(await readFile((await (await downloaded).path())!)).toEqual(asset);
    await page.screenshot({ path: info.outputPath("external-dark-es.png") });
    const cached = (await t.dev.backend.server.invoke("threads.get", { threadId: thread.id }, ctx)).messages.find((m) => m.id === id)!;
    expect(cached.bodyText).toBe(body);
    expect(await t.dev.backend.store.attachments.read(t.account.id, cached.attachments[0]!.assetId!, 0)).toBe(asset.toString("base64"));
    await t.reopen();
    const start = t.commands.length;
    await t.dev.backend.runWorker();
    await t.dev.backend.syncAccount(t.account.id);
    await t.dev.backend.runWorker();
    expect(t.commands.slice(start).filter((c) => ["UID STORE", "UID MOVE", "UID COPY"].includes(c))).toEqual([]);
    expect(await t.dev.backend.store.ops.get(op.id)).toMatchObject({ state: "queued", attempts: 0, next_attempt_at: AWAITING_IDENTITY, target_json: held!.target_json });
    expect((await t.dev.backend.server.invoke("threads.get", { threadId: thread.id }, ctx)).messages.find((m) => m.id === id)).toMatchObject({ bodyText: body });
    expect(await t.dev.backend.store.attachments.read(t.account.id, cached.attachments[0]!.assetId!, 0)).toBe(asset.toString("base64"));
    expect(t.wire.control.listMessages("A", { raw: true }).map((m) => ({ raw: m.raw, flags: m.flags }))).toEqual(remote.map((m) => ({ raw: m.raw, flags: m.flags })));
    expect(unexpected).toEqual([]);
  } finally { await t.close(); }
});
