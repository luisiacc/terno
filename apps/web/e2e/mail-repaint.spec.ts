/** A theme or "HTML mail" change repaints an open message in place: its frame never reloads (a reload blanks it, a flash). */
import { E2E_NOW } from "./constants";
import { expect, ingestConversation, selectThread, test } from "./fixtures";

type Terno = { __terno: { updateAppearance(p: object): Promise<unknown> } };

test("switching the theme and the HTML mail setting doesn't reload the open mail", async ({ app: page, server }) => {
  const id = await ingestConversation(server, { subject: "Repaint in place", count: 1, html: 1, now: E2E_NOW });
  await selectThread(page, id, 'subject:"Repaint in place"');
  const frame = page.locator("iframe[data-mail]").first();
  await expect(frame).toBeVisible();
  // count the frame's loads from here on, and remember its document
  await frame.evaluate((f: HTMLIFrameElement) => {
    const w = window as unknown as { __loads: number; __doc: Document | null };
    w.__loads = 0;
    w.__doc = f.contentDocument;
    f.addEventListener("load", () => w.__loads++);
  });
  const bg = () => frame.evaluate((f: HTMLIFrameElement) => getComputedStyle(f.contentDocument!.body).backgroundColor);
  const before = await bg();
  await page.evaluate(() => (window as unknown as Terno).__terno.updateAppearance({ theme: "dark" }));
  await expect.poll(bg).not.toBe(before);
  const dark = await bg();
  await page.evaluate(() => (window as unknown as Terno).__terno.updateAppearance({ htmlMailAppearance: "paper" }));
  await expect(frame).toHaveAttribute("data-mail", "paper");
  await expect.poll(bg).not.toBe(dark);
  // the same document all along: repainted, never reloaded
  expect(await frame.evaluate((f: HTMLIFrameElement) => (window as unknown as { __loads: number; __doc: Document | null }).__loads === 0 && (window as unknown as { __doc: Document | null }).__doc === f.contentDocument)).toBe(true);
});
