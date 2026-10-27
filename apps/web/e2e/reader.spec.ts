/**
 * The reader as a conversation: flat messages, native disclosure buttons
 * (Enter and Space, aria-expanded/aria-controls), bodies mounted only while
 * open, and runs of collapsed messages folded into "N more messages".
 */
import { E2E_NOW } from "./constants";
import { expect, focusList, ingestConversation, openRow, search, selectThread, test } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

test.describe("reader conversation", { tag: "@design" }, () => {
  test("messages are disclosure buttons that work with Enter and Space; collapsed bodies aren't mounted", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Propuesta campaña de Navidad", count: 3, now: E2E_NOW });
    await selectThread(page, id, 'subject:"Propuesta campaña de Navidad"');
    const reader = page.getByTestId("reader");
    const messages = reader.getByTestId("message");
    await expect(messages).toHaveCount(3);
    // read conversation: only the last message is open
    const first = messages.nth(0).getByTestId("message-toggle");
    await expect(first).toHaveAttribute("aria-expanded", "false");
    const region = await first.getAttribute("aria-controls");
    expect(region).toBe(`msg-body-${(await messages.nth(0).locator("[id^=msg-body-]").getAttribute("id"))!.replace("msg-body-", "")}`);
    // nothing of the collapsed body is in the DOM
    await expect(page.locator(`#${region}`)).toBeEmpty();
    await expect(messages.nth(2).getByTestId("message-toggle")).toHaveAttribute("aria-expanded", "true");

    await first.focus();
    await page.keyboard.press("Enter");
    const header = messages.nth(0).getByTestId("message-toggle");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`#${region}`)).toContainText("Mensaje 1");
    // focus stays on the same control through both transitions: no refocusing
    await expect(header).toBeFocused();
    await page.keyboard.press(" ");
    await expect(header).toBeFocused();
    await expect(messages.nth(0).getByTestId("message-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(`#${region}`)).toBeEmpty();
  });

  test("4 or more collapsed messages in a row fold into «N more messages»", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Sprint de diseño", count: 7, now: E2E_NOW });
    await selectThread(page, id, 'subject:"Sprint de diseño"');
    const more = page.getByTestId("more-messages");
    await expect(more).toHaveText("6 more messages");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("message")).toHaveCount(1);
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message")).toHaveCount(7);
    await expect(more).toHaveCount(0);
    // focus goes to the first message it revealed, not to the document
    await expect(page.getByTestId("message").first().getByTestId("message-toggle")).toBeFocused();
    await focusList(page);
  });

  test("HTML bodies mount on expand and leave nothing behind when collapsed", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Presupuesto anual", count: 3, html: 3, now: E2E_NOW });
    await selectThread(page, id, 'subject:"Presupuesto anual"');
    const frames = page.locator("[data-testid=reader] iframe");
    await expect(frames).toHaveCount(1);
    await page.getByTestId("message").nth(0).getByTestId("message-toggle").click();
    await expect(frames).toHaveCount(2);
    await page.getByTestId("message").nth(0).getByTestId("message-toggle").click();
    await expect(frames).toHaveCount(1);
  });

  test("attachments are view-only tiles: name, type and size, no download control", async ({ app: page }) => {
    await search(page, "has:attachment");
    await openRow(page, 0);
    const tile = page.getByTestId("attachment").first();
    await expect(tile).toBeVisible();
    await expect(tile).toContainText(/\d/);
    await expect(page.getByTestId("attachment").getByRole("button")).toHaveCount(0);
  });

  test("the reply bar after the last message starts a reply to who wrote last", async ({ app: page }) => {
    await openRow(page, 0);
    const subject = (await page.getByTestId("reader-subject").textContent())!;
    await expect(page.getByTestId("quick-reply")).toContainText(/Reply to \S+…$/);
    await page.getByTestId("quick-reply").click();
    await expect(page.getByTestId("reader").getByTestId("composer")).toBeVisible();
    await page.getByTestId("compose-show-subject").click();
    await expect(page.getByTestId("compose-subject")).toHaveValue(`Re: ${subject}`);
  });
});

test.describe("plan 35: “Load content” for every remote image the frame would block", () => {
  type Probe = { __terno: { hasRemoteContent(h: string, protocolRelative?: boolean): boolean } };
  test("detection reads the markup as the browser does, and stays linear on hostile input", async ({ app: page }) => {
    const cases: [string, boolean, boolean?][] = [
      ['<img src="https://t.test/p.gif">', true],
      ['<div style="background:url(https://x.test/a.png)">x</div>', true],
      ['<table background="http://t.test/bg.png"><tr><td>x</td></tr></table>', true],
      ['<img src="cid:logo">', false],
      ['<svg><image href="https://t.test/i.png"/></svg>', true],
      ['<svg><image width="1" xlink:href="https://t.test/i.png"/></svg>', true],
      // Codex code review: an entity-encoded scheme, and a quoted ">" before the source
      ['<svg><image href="&#104;ttps://t.test/i.png"/></svg>', true],
      ['<img alt="a > b" src="https://t.test/p.gif">', true],
      ['<a href="https://acme.test/">Acme</a>', false],
      ['<p>see https://acme.test/ or //acme.test</p>', false],
      ['<img src="//t.test/p.gif">', false],
      ['<img src="//t.test/p.gif">', true, true],
      ['<div style="background:url(//t.test/a.png)">x</div>', true, true],
      ['<a href="//acme.test/">Acme</a>', false, true],
    ];
    const results = await page.evaluate((list) => list.map(([html, , rel]) => (window as unknown as Probe).__terno.hasRemoteContent(html, rel)), cases);
    expect(results).toEqual(cases.map(([, expected]) => expected));
    // the old regex rescanned on every "<image": 56 KB of them took ~140 ms; a parse is linear
    const ms = await page.evaluate(() => {
      const hostile = "<image ".repeat(40_000);
      const t0 = performance.now();
      (window as unknown as Probe).__terno.hasRemoteContent(hostile);
      return performance.now() - t0;
    });
    expect(ms).toBeLessThan(100);
  });

  test("an SVG image with an encoded scheme gets the row and its button; the button loads it", async ({ app: page, server }) => {
    const thread = Number(await page.locator("[data-testid=thread-row]").first().getAttribute("data-thread-id"));
    sqlDb(server.backend.store).run("UPDATE message_bodies SET body_html = ? WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)", '<p>Logo</p><svg width="10" height="10"><image href="&#104;ttps://svg.test/logo.png" width="10" height="10"/></svg>', thread);
    const hits: string[] = [];
    await page.route(/svg\.test/, (route) => (hits.push(route.request().url()), route.abort()));
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openRow(page, 0);
    const row = page.getByTestId("remote-blocked").first();
    await expect(row).toBeVisible();
    expect(hits).toEqual([]);
    await row.getByRole("button", { name: "Load content" }).click();
    await expect.poll(() => hits).toContain("https://svg.test/logo.png");
  });
});
