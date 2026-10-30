import type { Page } from "@playwright/test";
import type { Node as PMNode } from "prosemirror-model";
import { fromPlainText, toEmailHtml } from "@terno/richtext";
import { sqlDb, type DevServer } from "../../backend-dev/src/server";
import { expect, focusOn, readerShown, rows, test } from "./fixtures";

test.use({ fixedClock: false, trace: "off" });

/** A reply draft with this body on the newest conversation, opened (r) and focused. */
async function openDraft(page: Page, server: DevServer, bodyText: string) {
  const db = sqlDb(server.backend.store);
  const m = db.get<{ id: number; thread_id: number; account_id: number }>("SELECT m.id, m.thread_id, m.account_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.in_inbox = 1 ORDER BY t.last_date DESC, m.date DESC LIMIT 1")!;
  await server.backend.store.drafts.save({ accountId: m.account_id, threadId: m.thread_id, mode: "reply", to: [{ name: "Ana", email: "ana@example.com" }], cc: [], subject: "Re: x", inReplyToMessageId: m.id, bodyText }, Date.now());
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await rows(page).first().dispatchEvent("mousedown");
  await readerShown(page, 8_000);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("r");
  const editor = page.getByTestId("compose-body");
  await focusOn(page, "compose-body", 60_000);
  // the backend's models are warm (a draft opened warms them; the first build is over)
  await server.backend.autocomplete.warm();
  await server.backend.autocomplete.idle();
  return editor;
}

/** The caret at the end of the top-level line `index` (-1: the last), or at `offset` into it, set in the editor's state (a DOM selection would race the editor reading it in a huge draft). */
async function caretAt(page: Page, index: number, offset?: number) {
  expect(await page.evaluate(([index, offset]) => (window as unknown as { __terno: { setComposerCaret(i: number, o?: number): boolean } }).__terno.setComposerCaret(index!, offset ?? undefined), [index, offset ?? null] as const)).toBe(true);
  await page.waitForTimeout(60);
}

/** Chinese lines: three bytes a character in UTF-8, so a 10 MB draft stays within the 5M-character draft limit (plan 16). */
const CHINESE = "你好，我把会议的笔记发给你，包括我们今天讨论的所有要点和下一步的安排。";
function chineseLines(megabytes: number) {
  const n = Math.ceil((megabytes * 1_000_000) / (new TextEncoder().encode(CHINESE).length + 8));
  return Array.from({ length: n }, (_, i) => `${i} ${CHINESE}`).join("\n");
}


test("a fitted suggestion at the true 10 MB model midpoint preserves the full draft and native history", async ({ app: page, server }) => {
  test.setTimeout(180_000);
  const lines = chineseLines(10).split("\n");
  const index = Math.floor(lines.length / 2);
  const body = await openDraft(page, server, lines.join("\n"));
  await caretAt(page, index);
  await page.keyboard.press("Enter");
  lines.splice(index + 1, 0, "Could you take a");
  const handlers = (server.backend.server as unknown as { handlers: Record<string, (...args: unknown[]) => Promise<unknown>> }).handlers;
  const suggest = handlers["compose.suggestText"]!;
  let release!: () => void;
  const fence = new Promise<void>(resolve => { release = resolve; });
  handlers["compose.suggestText"] = async (...args) => { await fence; return suggest(...args); };
  const ghost = page.getByTestId("compose-ghost");
  const position = () => body.evaluate(root => {
    const selection = document.getSelection()!;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const scroll: number[][] = [];
    for (let el: Element | null = root; el; el = el.parentElement) scroll.push([el.scrollLeft, el.scrollTop]);
    return { anchor: selection.anchorOffset, focus: selection.focusOffset, text: selection.anchorNode?.textContent, caret: [rect.left, rect.top, rect.bottom], scroll };
  });
  let shown: string | null;
  try {
    await page.keyboard.type(lines[index + 1]!, { delay: 30 });
    expect(await ghost.getAttribute("data-ghost")).toBeNull();
    const before = await position();
    release();
    await expect.poll(() => ghost.getAttribute("data-ghost")).toMatch(/^ look/);
    expect(await position(), "placement preserves the native caret and every scroll ancestor").toEqual(before);
    shown = await ghost.getAttribute("data-ghost");
  } finally { release(); handlers["compose.suggestText"] = suggest; }
  expect(shown).toBeTruthy();
  await page.keyboard.press("Tab");
  lines[index + 1] += shown!;
  const check = async () => {
    const actual = await body.evaluate(root => {
      const doc = (root as unknown as { pmViewDesc: { node: PMNode } }).pmViewDesc.node;
      return { json: doc.toJSON(), text: [...root.querySelectorAll("p")].map(p => p.textContent).join("\n") };
    });
    const expected = lines.join("\n");
    expect(actual.json).toEqual(fromPlainText(expected).toJSON());
    expect(actual.text).toBe(expected);
    await expect(body).toBeFocused();
    await expect(page.getByTestId("draft-status")).toHaveText(/saved/i, { timeout: 60_000 });
    const saved = await server.backend.server.invoke("drafts.list", {}, { clientId: "autocomplete-runtime", origin: "dev" });
    expect(saved[0]!.bodyText).toBe(expected);
    expect(saved[0]!.bodyHtml).toBe(toEmailHtml(fromPlainText(expected)));
  };
  await check();
  await page.keyboard.press("ControlOrMeta+z");
  lines[index + 1] = "Could you take a";
  await check();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  lines[index + 1] += shown!;
  await check();
});

// Fit trials must stay inside the layer's layout boundary.
test("fitting text only lays out the ghost after its first measurement", async ({ app: page, server }) => {
  await openDraft(page, server, "");
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-testid="compose-ghost"]' });
  const { node } = await cdp.send("DOM.describeNode", { nodeId });
  await page.evaluate(() => {
    const layer = document.querySelector('[data-testid="compose-ghost"]');
    let next = 0;
    const measured = <T,>(read: () => T) => {
      const id = next++;
      performance.mark(`fit-start-${id}`);
      try { return read(); } finally { performance.mark(`fit-end-${id}`); }
    };
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return this === layer ? measured(() => rect.call(this)) : rect.call(this);
    };
    const height = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!;
    Object.defineProperty(Element.prototype, "scrollHeight", { ...height, get() {
      return this === layer ? measured(() => height.get!.call(this) as number) : height.get!.call(this);
    } });
  });
  await cdp.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing", transferMode: "ReturnAsStream" });
  await page.keyboard.type("Could you take a", { delay: 30 });
  const layer = page.getByTestId("compose-ghost");
  await expect.poll(() => layer.getAttribute("data-ghost")).toMatch(/^ look/);
  const lineTops = await layer.evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return [...range.getClientRects()].filter(rect => rect.width > 0).map(rect => rect.top);
  });
  expect(new Set(lineTops).size, "the fitted visible text really occupies one line").toBe(1);
  const complete = new Promise<{ stream?: string }>(resolve => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  const { stream } = await complete;
  if (!stream) throw new Error("Chrome did not return the layout trace stream");
  let json = "";
  for (;;) {
    const part = await cdp.send("IO.read", { handle: stream });
    json += part.data;
    if (part.eof) break;
  }
  await cdp.send("IO.close", { handle: stream });
  await cdp.detach();
  const events = (JSON.parse(json) as { traceEvents: { name: string; ts: number; dur?: number; args?: { endData?: { layoutRoots: { nodeId: number }[] } } }[] }).traceEvents;
  const starts = events.filter(e => e.name.startsWith("fit-start-"));
  expect(starts.length).toBeGreaterThanOrEqual(2);
  const roots = starts.slice(1).flatMap(start => {
    const end = events.find(e => e.name === start.name.replace("start", "end"))!;
    return events.filter(e => e.name === "Layout" && e.ts >= start.ts && e.ts + (e.dur ?? 0) <= end.ts).flatMap(e => e.args?.endData?.layoutRoots.map(r => r.nodeId) ?? []);
  });
  expect(roots.length).toBeGreaterThan(0);
  expect(roots.every(id => id === node.backendNodeId), "fit trials must not reflow the containing editor or page").toBe(true);
});

test("native Chromium composition clears a fitted ghost and preserves the committed body through history", async ({ app: page, server }) => {
  const body = await openDraft(page, server, "");
  await page.keyboard.type("Could you take a", { delay: 30 });
  const ghost = page.getByTestId("compose-ghost");
  await expect.poll(() => ghost.getAttribute("data-ghost")).toMatch(/^ look/);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.imeSetComposition", { text: "漢字", selectionStart: 2, selectionEnd: 2 });
    await expect.poll(() => ghost.getAttribute("data-ghost")).toBeNull();
    await cdp.send("Input.insertText", { text: "漢字" });
  } finally { await cdp.detach(); }
  const expected = "Could you take a漢字";
  await expect(body).toHaveText(expected);
  await expect(body).toBeFocused();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(body).not.toHaveText(expected);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(body).toHaveText(expected);
  await page.keyboard.press("Tab");
  await expect(body).toHaveText(expected);
  await expect(page.getByTestId("draft-status")).toHaveText(/saved/i);
  const actual = await body.evaluate(root => (root as unknown as { pmViewDesc: { node: PMNode } }).pmViewDesc.node.toJSON());
  expect(actual).toEqual(fromPlainText(expected).toJSON());
  const saved = await server.backend.server.invoke("drafts.list", {}, { clientId: "autocomplete-runtime", origin: "dev" });
  expect(saved[0]!.bodyText).toBe(expected);
  expect(saved[0]!.bodyHtml).toBe(toEmailHtml(fromPlainText(expected)));
});
