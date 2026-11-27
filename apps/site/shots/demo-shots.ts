/**
 * `pnpm --filter @terno/site shots:demo` (plans 224, 288): the site's pictures of “What matters”, Follow-ups and People, taken from
 * the AI demo's own window (`./run.sh demoai`, plan 167): its mailbox, prepared on real models, with the feed and the
 * follow-ups those models found. The owner's rule for AI pictures holds: nothing in them is canned or edited by hand.
 *
 * Start the demo with its DevTools port open, on a copy of its profile so the pictures' appearance doesn't stay in yours
 * (copy without Chromium's Singleton* files, or a running demo's lock makes the copy quit at once):
 *
 *   TERNO_USER_DATA=<copy> TERNO_REMOTE_DEBUGGING_PORT=9333 TERNO_VITE_PORT=<free port> pnpm dev:demo-ai
 *
 * then run this (`--port=9333` by default; `--only=ai-people` takes just the pictures named). It sets the pictures' appearance in that window (Lumen, the GitHub palettes,
 * no motion, as shots/lib.ts's `pictureSettings`) and takes each picture light, then dark, at 2×, into .shots-raw-ai/,
 * then encodes them as the other scripts do. The window's own zoom (the app's 120 %) is undone in the capture, so a
 * picture is exactly its CSS size at 2×.
 *
 * - `ai-what-matters`: the window at 1200×860, on What matters (sidebar and feed).
 * - `ai-followups`: the reading pane's head (subject and the unanswered question's card) of the first unanswered question whose head
 *   holds nothing else, at 1180×900: never a sender's line (a one-message conversation shows it between the two) or the
 *   messages under the card, where the demo account's own name and address are; no address at all in the picture.
 * - `ai-people` (plan 288): the window at 1280×800 (the drafted reply's size), Split, on People with no search or
 *   filter: the list from its top and the page of the Open person in view whose items show the most kinds (asked you,
 *   waiting on you, owes you a reply, you promised), then the most items that fit above Conversations. The only address
 *   painted is that person's own, in their page's head.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type CDPSession, type Page } from "@playwright/test";
import { encode, site } from "./lib";

const raw = join(site, ".shots-raw-ai");
const port = Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 9333);
const PICTURES = ["ai-what-matters", "ai-followups", "ai-people"] as const;
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",") ?? [...PICTURES];
const unknown = only.filter((n) => !(PICTURES as readonly string[]).includes(n));
if (unknown.length) throw new Error(`no such picture: ${unknown.join(", ")} (these are ${PICTURES.join(", ")})`);
const wanted = (name: (typeof PICTURES)[number]) => only.includes(name);
type Mode = "light" | "dark";
type Box = { x: number; y: number; width: number; height: number };
/** People's kinds of item, as its page says them (plan 288 picks the person showing the most) */
const KINDS = [/\bAsked you\b/, /\bWaiting on you\b/, /\bOwes you a reply\b/, /\bYou promised\b/];

mkdirSync(raw, { recursive: true });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools:"));
  if (!page) throw new Error(`no app window on port ${port}: start the demo with TERNO_REMOTE_DEBUGGING_PORT=${port}`);
  const cdp = await page.context().newCDPSession(page);
  // the window's zoom: CSS pixels to the window's own (the capture's clip is in those), read at a device scale of 2
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 860, deviceScaleFactor: 2, mobile: false });
  const zoom = (await page.evaluate(() => devicePixelRatio)) / 2;
  const size = async (width: number, height: number) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: Math.round(width * zoom), height: Math.round(height * zoom), deviceScaleFactor: 2, mobile: false });
    await page.waitForTimeout(400);
  };
  const appearance = (patch: Record<string, unknown>) =>
    page.evaluate(async (patch) => {
      // the app's own module (the dev build serves it): the same call Settings → Appearance makes
      const module = "/src/lib/appearance.ts";
      const { updateAppearance } = (await import(/* @vite-ignore */ module)) as { updateAppearance: (patch: Record<string, unknown>) => Promise<unknown> };
      await updateAppearance(patch);
    }, patch);
  /** light, then dark: nothing pointed at or focused, then `frame` (CSS pixels) at 2× */
  const both = async (name: string, frame: () => Promise<Box>) => {
    for (const mode of ["light", "dark"] as Mode[]) {
      await appearance({ theme: mode });
      await page.waitForFunction((dark) => document.documentElement.classList.contains("dark") === dark, mode === "dark");
      await still(page);
      const b = await frame();
      writeFileSync(join(raw, `${name}-${mode}.png`), await capture(cdp, b, zoom));
    }
    console.log(`✓ ${name}`);
  };

  await appearance({ design: "lumen", senderIcons: false, motionMs: 0, lightTheme: "github-light", darkTheme: "github-dark" });

  // --- What matters: the window, sidebar and feed ---
  if (wanted("ai-what-matters")) {
  await size(1200, 860);
  await page.getByTestId("nav-today").click();
  await page.getByTestId("wm-item").first().waitFor();
  console.log(`  what matters: ${(await page.getByTestId("wm-feed").innerText()).split("\n").slice(0, 8).join(" · ")}`);
  await both("ai-what-matters", async () => ({ x: 0, y: 0, width: 1200, height: 860 }));
  }

  // --- Follow-ups: the first one open, its card under the subject ---
  if (wanted("ai-followups")) {
  await size(1180, 900);
  await page.getByTestId("nav-followups").click();
  const rows = page.getByTestId("thread-row");
  await rows.first().waitFor();
  // the toolbar above the subject and the messages under the card stay out
  const head = async (): Promise<Box> => {
    const [subject, card] = (await page.evaluate(() => ["reader-subject", "followup-line"].map((id) => document.querySelector(`[data-testid=${id}]`)!.getBoundingClientRect().toJSON() as DOMRect))) as [DOMRect, DOMRect];
    const x = Math.min(subject.x, card.x) - 28;
    const y = subject.y - 12;
    return { x, y, width: Math.max(subject.right, card.right) + 28 - x, height: card.bottom + 18 - y };
  };
  let found = false;
  for (let i = 0, n = await rows.count(); i < n && !found; i++) {
    // a second click on the open conversation would close it
    if ((await rows.nth(i).getAttribute("data-opened")) === null) await rows.nth(i).click();
    await page.waitForTimeout(600);
    // a promise of yours shows What matters' card instead: only an unanswered question's card is pictured
    if (!(await page.getByTestId("followup-line").first().isVisible())) continue;
    found = await safeHead(page, await head());
  }
  if (!found) throw new Error("no follow-up whose head holds only its subject and card: nothing taken");
  console.log(`  follow-up: ${(await page.getByTestId("followup-line").first().innerText()).replace(/\s+/g, " ")}`);
  await both("ai-followups", head);
  }

  // --- People: the window, the list and one person's page ---
  if (wanted("ai-people")) await people(page, size, appearance, both);

  await cdp.send("Emulation.clearDeviceMetricsOverride");
} finally {
  await browser.close().catch(() => {});
}
encode(raw, { only });

/**
 * People in Split with nothing typed or filtered, the list from its top; of the Open people wholly in view, the one
 * whose page shows the most kinds of item, then the most items above Conversations. Both modes are checked again
 * before each capture: the chosen row, the page's items and its first conversation inside the window, and no address
 * painted but the person's own.
 */
async function people(page: Page, size: (w: number, h: number) => Promise<void>, appearance: (patch: Record<string, unknown>) => Promise<void>, both: (name: string, frame: () => Promise<Box>) => Promise<void>) {
  const W = 1280;
  const H = 800;
  await appearance({ layout: "split" });
  await size(W, H);
  await page.getByTestId("nav-people").click();
  await page.getByTestId("people-rows").waitFor();
  if (await page.getByTestId("people-filter-clear").isVisible()) await page.getByTestId("people-filter-clear").click();
  const search = page.getByTestId("people-search");
  if (await search.inputValue()) await search.fill("");
  await page.getByTestId("person-row").first().waitFor();
  await page.getByTestId("people-rows").evaluate((e) => (e.scrollTop = 0));
  await page.waitForTimeout(300);

  const keys = await page.getByTestId("person-row").evaluateAll((rows, H) => rows.filter((r) => r.closest("[data-testid=people-rows]") && r.getBoundingClientRect().bottom <= H - 8 && r.getBoundingClientRect().top >= 0).map((r) => (r as HTMLElement).dataset.key!), H);
  let best: { key: string; kinds: number; fit: number; name: string } | null = null;
  for (const key of keys) {
    const row = page.locator(`[data-testid=person-row][data-key="${key}"]`);
    // only Open's people (a row with an age); Everyone's say an address
    if (await row.evaluate((r) => /@/.test(r.textContent ?? ""))) continue;
    await row.click();
    await page.getByTestId("person-items").waitFor();
    await page.waitForTimeout(500);
    const items = await page.getByTestId("person-item").allInnerTexts();
    const kinds = KINDS.filter((k) => items.some((t) => k.test(t))).length;
    const fit = await page.evaluate((H) => {
      const conv = document.querySelector("[data-testid=person-conversation]")?.getBoundingClientRect();
      const lines = [...document.querySelectorAll("[data-testid=person-item]")];
      return conv && conv.bottom <= H ? lines.filter((l) => l.getBoundingClientRect().bottom <= H).length : 0;
    }, H);
    const name = await page.getByTestId("person-name").innerText();
    const typed = await handTyped(page, H);
    console.log(`    ${name}: ${kinds} kinds, ${fit} of ${items.length} items above Conversations${typed ? `; skipped, it shows mail typed into the demo (“${typed}”)` : ""}`);
    if (typed) continue;
    if (fit && (!best || kinds > best.kinds || (kinds === best.kinds && fit > best.fit))) best = { key, kinds, fit, name };
  }
  if (!best) throw new Error("no Open person in view whose page shows an item and a conversation: nothing taken");
  await page.locator(`[data-testid=person-row][data-key="${best.key}"]`).click();
  await page.getByTestId("person-items").waitFor();
  console.log(`  people: ${best.name}, ${best.kinds} kinds, ${best.fit} items`);
  await both("ai-people", async () => {
    const bad = await peopleProblem(page, best.key, W, H);
    if (bad) throw new Error(`ai-people: ${bad}`);
    return { x: 0, y: 0, width: W, height: H };
  });
}

/**
 * A conversation in view that was typed into the demo by hand rather than generated (someone trying it out: “hi”,
 * two words of body), or null. The fixture's subjects and snippets are always whole sentences; a short one is a test.
 */
async function handTyped(page: Page, H: number): Promise<string | null> {
  return page.getByTestId("person-conversation").evaluateAll((rows, H) => {
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (r.top > H) continue;
      const [subject = "", , ...rest] = (row as HTMLElement).innerText.split("\n").map((l) => l.trim()).filter(Boolean);
      const snippet = rest.join(" ").replace(/^.*? wrote last · /, "");
      if (subject.length < 4 || snippet.length < 24) return `${subject} · ${snippet}`;
    }
    return null;
  }, H);
}

/** What's wrong with the People window as it stands, or null: the row, the items and a conversation in view, one address. */
async function peopleProblem(page: Page, key: string, W: number, H: number): Promise<string | null> {
  return page.evaluate(
    ({ key, W, H }) => {
      // (no named helper: tsx's __name wrapper doesn't exist in the page)
      const needed: [string, string][] = [
        [`[data-testid=person-row][data-key="${CSS.escape(key)}"]`, "the chosen person's row isn't in view"],
        ["[data-testid=person-item]", "no item of theirs in view"],
        ["[data-testid=person-conversation]", "no conversation in view"],
        ["[data-testid=nav-people]", "the sidebar's People isn't in view"],
      ];
      for (const [selector, problem] of needed) {
        const r = document.querySelector(selector)?.getBoundingClientRect();
        if (!r || r.width === 0 || r.top < 0 || r.left < 0 || r.bottom > H || r.right > W) return problem;
      }
      const page = document.querySelector("[data-testid=person-page]")!;
      // the line under the name: their address, then when you last heard from each other
      const own = page.querySelector("[data-testid=person-name]")?.nextElementSibling?.textContent ?? "";
      const theirs = own.match(/[^\s·]+@[^\s·]+/)?.[0];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent ?? "";
        if (!/@/.test(text)) continue;
        const box = n.parentElement?.getBoundingClientRect();
        // painted text only, in the window: a screen reader's 1 px line never shows
        if (!box || box.width <= 1 || box.height <= 1 || box.bottom < 0 || box.top > H || box.right < 0 || box.left > W) continue;
        if (!theirs || !text.includes(theirs) || text.replace(theirs, "").includes("@")) return `an address other than the person's is painted: “${text.trim()}”`;
      }
      return null;
    },
    { key, W, H },
  );
}

/**
 * The follow-up's head is only its subject, the line under it (account, messages) and the card: nothing between the
 * subject's line and the card (a sender's line would be), and no address anywhere in the box.
 */
async function safeHead(page: Page, box: Box): Promise<boolean> {
  return page.evaluate((box) => {
    const subject = document.querySelector("[data-testid=reader-subject]")!.getBoundingClientRect();
    const card = document.querySelector("[data-testid=followup-line]")!.getBoundingClientRect();
    if (card.top - subject.bottom > 48) return false;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      const inside = r.width > 0 && r.right > box.x && r.x < box.x + box.width && r.bottom > box.y && r.y < box.y + box.height;
      // painted text only: a screen reader's line (sr-only, a clipped 1 px box) never shows in a picture
      const own = n.parentElement?.getBoundingClientRect();
      const painted = !!own && own.width > 1 && own.height > 1;
      if (inside && painted && /@/.test(n.textContent ?? "")) return false;
    }
    return true;
  }, box);
}

/** The mouse to a corner, focus dropped, a moment for anything still settling. */
async function still(page: Page) {
  const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.mouse.move(width - 1, height - 1).catch(() => {});
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.waitForTimeout(600);
}

/** `box` in CSS pixels at 2×: the window's clip is in its own pixels, and its device scale already holds the zoom. */
async function capture(cdp: CDPSession, box: Box, zoom: number): Promise<Buffer> {
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: box.x * zoom, y: box.y * zoom, width: box.width * zoom, height: box.height * zoom, scale: 1 / zoom },
  });
  return Buffer.from(data, "base64");
}
