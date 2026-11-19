/**
 * Plan 221: the conversations on screen are warmed once the list rests, so a click opens from the cache; nothing but a
 * read of the local store (no body download, no change, no AI, no remote picture).
 */
import { expect, navTo, readerSubject, scenario, test } from "./fixtures";
import type { Page } from "@playwright/test";

const remote = (url: URL) => /^https?:$/.test(url.protocol) && url.hostname !== "127.0.0.1" && url.hostname !== "localhost";

/** What the page asks the backend (its WebSocket): each call's method and input. */
function rpcSent(page: Page): { m: string; p: { threadId?: number } }[] {
  const sent: { m: string; p: { threadId?: number } }[] = [];
  page.on("websocket", (ws) => ws.on("framesent", (f) => {
    try {
      const msg = JSON.parse(String(f.payload)) as { m?: string; p?: { threadId?: number } };
      if (msg.m) sent.push({ m: msg.m, p: msg.p ?? {} });
    } catch { /* not a call */ }
  }));
  return sent;
}

/** The rows wholly or partly inside the list's viewport, top first. */
const onScreen = (page: Page) => page.evaluate(() => {
  const scroller = document.querySelector<HTMLElement>("[data-testid=thread-list] [role=listbox]")!.getBoundingClientRect();
  return [...document.querySelectorAll<HTMLElement>("[data-testid=thread-row]")]
    .filter((row) => { const r = row.getBoundingClientRect(); return r.bottom > scroller.top + 1 && r.top < scroller.bottom - 1; })
    .map((row) => Number(row.dataset.threadId));
});

test("plan 221: the rows on screen are warmed once the list rests, and a click on one opens from the cache", async ({ app: page, server }) => {
  // remote pictures load the moment a mail opens: warming must still fetch none
  await server.backend.server.invoke("settings.update", { remoteImages: "always" }, { clientId: "setup", origin: "dev" });
  const pictures: string[] = [];
  await page.route(remote, (route) => (pictures.push(route.request().url()), route.abort()));
  const sent = rpcSent(page);
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await page.locator("[data-testid=thread-row]").first().waitFor();
  const gets = () => new Set(sent.filter((c) => c.m === "threads.get").map((c) => c.p.threadId!));
  const selected = async () => Number(await page.locator("[data-testid=thread-row][aria-selected=true]").first().getAttribute("data-thread-id").catch(() => null)) || null;

  await scenario("the Inbox's rows on screen, exactly: a read of each, and nothing else", async () => {
    const rows = await onScreen(page);
    expect(rows.length).toBeGreaterThan(5);
    await expect.poll(() => rows.every((id) => gets().has(id))).toBe(true);
    // none past the screen (the list's overscan isn't warmed); the open one is the reader's
    const open = await selected();
    expect([...gets()].filter((id) => !rows.includes(id) && id !== open)).toEqual([]);
    // let anything else it might have started arrive
    await page.waitForTimeout(400);
    // (the open conversation's reader asks for its own, its summary for one)
    expect(open === null || rows.includes(open)).toBe(true);
    expect(sent.filter((c) => /^(reader\.hydrate|threads\.act|threads\.markRead|ai\.)/.test(c.m) && c.p.threadId !== open)).toEqual([]);
    expect(pictures).toEqual([]);
  });

  await scenario("a click on a warmed row opens it with no fetch; its pictures load then", async () => {
    const rows = await onScreen(page);
    const open = await selected();
    const target = rows.find((id) => id !== open)!;
    const before = sent.length;
    await page.locator(`[data-testid=thread-row][data-thread-id="${target}"]`).dispatchEvent("mousedown");
    await readerSubject(page);
    await page.waitForTimeout(300);
    expect(sent.slice(before).filter((c) => c.m === "threads.get" && c.p.threadId === target)).toEqual([]);
  });

  await scenario("a fling warms nothing while it moves, then only the screen it rests on", async () => {
    await navTo(page, "all");
    await page.locator("[data-testid=thread-row]").first().waitFor();
    await expect.poll(() => onScreen(page).then((rows) => rows.every((id) => gets().has(id)))).toBe(true);
    const before = sent.length;
    // a fling: 20 steps a frame apart, about 300 rows down
    await page.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>("[data-testid=thread-list] [role=listbox]")!;
      for (let i = 0; i < 20; i++) {
        scroller.scrollTop += 1000;
        await new Promise((r) => requestAnimationFrame(r));
      }
    });
    const rest = await onScreen(page);
    await expect.poll(() => rest.every((id) => sent.slice(before).some((c) => c.m === "threads.get" && c.p.threadId === id))).toBe(true);
    await page.waitForTimeout(400);
    const open = await selected();
    const warmed = sent.slice(before).filter((c) => c.m === "threads.get").map((c) => c.p.threadId!);
    expect(warmed.filter((id) => !rest.includes(id) && id !== open)).toEqual([]);
  });
});
