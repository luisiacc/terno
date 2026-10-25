/**
 * The read-after-dwell never disturbs the reader: opening an unread thread
 * marks it read after a short dwell, the thread refetches, and the reader
 * keeps its DOM, focus, caret, scroll and expanded messages through it (no
 * skeleton flash, no remount). Fresh content still arrives in the open thread.
 */
import type { Page } from "@playwright/test";
import type { ThreadDetail } from "@terno/core";
import { sqlDb, type DevServer } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { expect, ingestConversation, selectThread, test } from "./fixtures";

type Probe = Window & { __probe?: { skeleton: boolean; nodes: Record<string, Element | null>; focus: Element | null } };

/**
 * Holds the backend's thread actions until released, so the dwell's mark-read
 * lands after the test has put focus and scroll where it wants them.
 */
function holdActions(server: DevServer) {
  const threads = server.backend.store.threads;
  const act = threads.act.bind(threads);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  threads.act = async (...args) => {
    await gate;
    return act(...args);
  };
  return release;
}

/** Remembers the reader's nodes and the focused element, and watches for the skeleton from now on. */
async function probe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const q = (s: string) => document.querySelector(s);
    const p = { skeleton: false, focus: document.activeElement, nodes: { reader: q("[data-testid=reader]"), subject: q("[data-testid=reader-subject]"), message: q("[data-testid=message]"), draft: q("[data-testid=draft-slot]") } };
    (window as Probe).__probe = p;
    new MutationObserver(() => {
      if (q("[data-testid=reader-skeleton]")) p.skeleton = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
}

/** Same nodes still in the document, same focused element, no skeleton seen. */
async function unchanged(page: Page) {
  return page.evaluate(() => {
    const p = (window as Probe).__probe!;
    const same = Object.fromEntries(Object.entries(p.nodes).map(([k, el]) => [k, el !== null && el.isConnected]));
    return { skeleton: p.skeleton, focus: document.activeElement === p.focus, ...same };
  });
}

const scrollTop = (page: Page) => page.locator("[data-reader-scroller]").evaluate((el) => el.scrollTop);

async function markedRead(page: Page, threadId: number, release: () => void): Promise<void> {
  release();
  // the page holds the refetched thread, every message read (nothing on screen shows it)
  await expect
    .poll(() => page.evaluate((id) => (window as unknown as { __terno: { threadDetail(id: number): ThreadDetail | undefined } }).__terno.threadDetail(id)?.messages.every((m) => m.isRead), threadId))
    .toBe(true);
  // and has rendered it
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

test.describe("reader through the read-after-dwell", { tag: "@design" }, () => {
  test("a focused message toggle, the scroll and the open messages survive the mark-read", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Plan de lanzamiento", count: 6, html: 6, unread: 3, now: E2E_NOW });
    const release = holdActions(server);
    await selectThread(page, id, 'subject:"Plan de lanzamiento"');
    const row = page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);
    // the dwell ran (the row reads as read at once); the backend holds the action
    await expect(row).not.toHaveAttribute("data-unread");
    const toggles = page.getByTestId("reader").getByTestId("message-toggle");
    await expect(toggles).toHaveCount(6);
    const expanded = ["false", "false", "false", "true", "true", "true"];
    for (const [i, v] of expanded.entries()) await expect(toggles.nth(i)).toHaveAttribute("aria-expanded", v);

    const scroller = page.locator("[data-reader-scroller]");
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(400);
    await toggles.nth(3).focus();
    await scroller.evaluate((el) => (el.scrollTop = 320));
    const top = await scrollTop(page);
    expect(top).toBe(320);
    await probe(page);

    await markedRead(page, id, release);

    expect(await unchanged(page)).toEqual({ skeleton: false, focus: true, reader: true, subject: true, message: true, draft: true });
    await expect(toggles.nth(3)).toBeFocused();
    // what was unread when it opened stays open: reading it doesn't fold it away under the reader
    for (const [i, v] of expanded.entries()) await expect(toggles.nth(i)).toHaveAttribute("aria-expanded", v);
    expect(await scrollTop(page)).toBe(top);
  });

  test("the inline reply keeps its focus, text and caret through the mark-read", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Notas de la reunión", count: 3, unread: 1, now: E2E_NOW });
    const release = holdActions(server);
    await selectThread(page, id, 'subject:"Notas de la reunión"');
    await expect(page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`)).not.toHaveAttribute("data-unread");

    await page.getByTestId("quick-reply").click();
    const body = page.getByTestId("reader").getByTestId("compose-body");
    await expect(body).toBeFocused();
    await page.keyboard.type("Hola equipo, nos vemos");
    // the caret goes back before "vemos"
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
    const top = await scrollTop(page);
    await probe(page);

    await markedRead(page, id, release);

    expect(await unchanged(page)).toEqual({ skeleton: false, focus: true, reader: true, subject: true, message: true, draft: true });
    await expect(body).toBeFocused();
    expect(await scrollTop(page)).toBe(top);
    // typing goes on where the caret was
    await page.keyboard.type("X");
    await expect.poll(() => body.evaluate((el) => (el instanceof HTMLTextAreaElement ? el.value : el.textContent))).toContain("Hola equipo, nos Xvemos");
  });

  test("a message arriving in the open thread still appears, without a remount", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Entrega final", count: 2, now: E2E_NOW });
    await selectThread(page, id, 'subject:"Entrega final"');
    const messages = page.getByTestId("reader").getByTestId("message");
    await expect(messages).toHaveCount(2);
    await messages.nth(1).getByTestId("message-toggle").focus();
    await probe(page);
    const renders = () => page.evaluate(() => (window as unknown as { __renders: Record<string, number> }).__renders.Conversation ?? 0);
    const before = await renders();

    // a third message on the same conversation, as a sync would bring it
    await ingestConversation(server, { subject: "Entrega final", count: 3, unread: 1, now: E2E_NOW });
    server.backend.notifyChanged([id]);

    await expect(messages).toHaveCount(3);
    await expect(messages.nth(2).getByTestId("message-toggle")).toHaveAttribute("aria-expanded", "true");
    // the one that was last stays open; one render for the new answer
    await expect(messages.nth(1).getByTestId("message-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(await renders()).toBe(before + 1);
    expect(await unchanged(page)).toEqual({ skeleton: false, focus: true, reader: true, subject: true, message: true, draft: true });
  });

  test("a thread deleted on the server while open says so instead of showing what no longer exists", async ({ app: page, server }) => {
    const id = await ingestConversation(server, { subject: "Borrador viejo", count: 2, now: E2E_NOW });
    await selectThread(page, id, 'subject:"Borrador viejo"');
    await expect(page.getByTestId("reader").getByTestId("message")).toHaveCount(2);
    const ids = sqlDb(server.backend.store).all<{ id: number }>("SELECT id FROM messages WHERE thread_id = ?", id).map((m) => m.id);
    await server.backend.store.sync.remove(ids);
    server.backend.notifyChanged([id]);
    await expect(page.getByTestId("reader-gone")).toHaveText("That conversation no longer exists.");
    await expect(page.getByTestId("reader").getByTestId("message")).toHaveCount(0);
  });
});
