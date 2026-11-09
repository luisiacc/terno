/**
 * Plan 133 in the page, on the offline fake model streaming at a real model's pace: nothing here reaches a real
 * provider. The mail is invented and ingested into this test's own backend.
 */
import { mkdirSync } from "node:fs";
import { RpcError } from "@terno/core/rpc";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { fakeDraft } from "../../../packages/ai/src/fake";
import type { IncomingMessage } from "@terno/store";
import { E2E_NOW } from "./constants";
import { sqlDb } from "../../backend-dev/src/server";
import { addRecipients, expect, recipientEmails, rows, scenario, stabilize, test, type DevServerFixture } from "./fixtures";
import { unclipped } from "./helpers/unclipped";
import { inEveryLook, wheelsTo } from "./helpers/looks";

const SHOTS = process.env.AI_DRAFT_SHOTS ?? "/tmp/terno-scratch/ai-draft";
const dev = { clientId: "setup", origin: "dev" as const };

const ME = { name: "Luis Cordero", email: "" };
const TOM = { name: "Tom Reed", email: "tom@acme.example" };
const ANA = { name: "Ana Pérez", email: "ana@studio.example" };
const PRIYA = { name: "Priya Shah", email: "priya@acme.example" };
const YUKI = { name: "Yuki Gutiérrez", email: "yuki@elsewhere.example" };
const ROSA = { name: "Rosa Vidal", email: "rosa@faraway.example" };

const DRAFT = "Hi Tom,\n\nThat works for me, and the [date] is still open on my side.\n\nI read through the contract again this morning. Nothing in it changes what we agreed, so I'm happy to go ahead as it is.\n\nThanks";

type Seed = { contract: number; lunch: number; accountId: number };

let unique = 0;
function message(accountId: number, key: string, o: { subject: string; from: typeof TOM; to: (typeof TOM)[]; cc?: (typeof TOM)[]; at: number; body: string; mine?: boolean; reply?: string }): IncomingMessage {
  return {
    accountId, providerMsgId: key, providerThreadId: `thread-${o.subject}`, rfcMessageId: `<${key}@ai-draft.test>`, inReplyTo: o.reply ? `<${o.reply}@ai-draft.test>` : null, references: o.reply ? [`<${o.reply}@ai-draft.test>`] : [],
    from: o.from, to: o.to, cc: o.cc ?? [], bcc: [], subject: o.subject, date: o.at, snippet: o.body.slice(0, 80), bodyText: o.body, bodyHtml: null, bodyState: "full", listId: null,
    isRead: true, isStarred: false, inInbox: true, isSent: !!o.mine, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 800,
  };
}

/** A thread with Tom, Ana and Priya (Ana last), one with Yuki alone, and a person last written to long ago. */
async function seed(server: DevServerFixture): Promise<Seed> {
  const { accounts } = (await server.backend.server.invoke("app.bootstrap", {}, dev)) as { accounts: { id: number; email: string }[] };
  const accountId = accounts[0]!.id;
  const me = { ...ME, email: accounts[0]!.email };
  const n = ++unique;
  const contract = `Contract review ${n}`;
  const lunch = `Studio lunch ${n}`;
  await server.backend.store.sync.ingest(
    [
      message(accountId, `c1-${n}`, { subject: contract, from: TOM, to: [me], cc: [ANA, PRIYA], at: E2E_NOW - 5 * 3_600_000, body: "Can we sign on the 12th? Let me know if the clauses look right to you." }),
      message(accountId, `c2-${n}`, { subject: contract, from: ANA, to: [me], cc: [TOM, PRIYA], at: E2E_NOW - 3_600_000, body: "I can't make the 12th. Could we do the 19th instead?", reply: `c1-${n}` }),
      message(accountId, `l1-${n}`, { subject: lunch, from: YUKI, to: [me], at: E2E_NOW - 600_000, body: "Are we still on for lunch at the studio this week?" }),
      message(accountId, `r1-${n}`, { subject: `Old note ${n}`, from: me, to: [ROSA], at: E2E_NOW - 60 * 86_400_000, body: "Thanks for the introduction, it was good to meet.", mine: true }),
    ],
    { applyFilters: false, now: E2E_NOW, classifier: null },
  );
  const threadOf = (key: string) => sqlDb(server.backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", key)!.thread_id;
  return { contract: threadOf(`c1-${n}`), lunch: threadOf(`l1-${n}`), accountId };
}

async function ready(page: Page, server: DevServerFixture) {
  const ids = await seed(server);
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake" } }, dev);
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await rows(page).first().waitFor();
  return ids;
}

/** The next scenario of a merged test: its drafts discarded, as if it had just loaded. */
async function fresh(page: Page, server: DevServerFixture) {
  const discard = page.getByTestId("compose-discard");
  while (await discard.count()) await discard.first().click();
  await expect.poll(async () => (await server.backend.store.drafts.list()).length).toBe(0);
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await rows(page).first().waitFor();
}

/** No first token to wait for and no pace: for what's decided before or after the stream, not during it. */
function instant() {
  fakeDraft.firstTokenMs = 0;
  fakeDraft.paceMs = 0;
}

async function openThread(page: Page, subject: RegExp | string) {
  await page.getByTestId("thread-row").filter({ hasText: subject }).first().click();
  await page.getByTestId("reader-subject").filter({ hasText: subject }).waitFor();
}

const row = (page: Page) => page.getByTestId("ai-row");
const body = (page: Page) => page.getByTestId("compose-body").first();
const preview = (page: Page) => page.getByTestId("ai-preview");
const strip = (page: Page) => page.getByTestId("ai-strip");
const CMD_J = "ControlOrMeta+j";

async function shot(page: Page, name: string, design: string | null) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${design ?? "lumen"}-${name}.png` });
}

/**
 * Plan 163: the keys in a draft's body, ready for words: ⌘J from a conversation or the list opens one for AI; in an open
 * composer, its body (⌘J there would act on what's written).
 */
async function openField(page: Page) {
  if (await page.getByTestId("composer").count()) await body(page).focus();
  else await page.keyboard.press(CMD_J);
  await expect(body(page)).toBeFocused();
}

/** Lines typed into the body as a person types them (Return between them), over what was there. */
async function put(page: Page, text: string) {
  await body(page).fill("");
  await body(page).focus();
  await page.keyboard.type(text);
}

/** Plan 163: words in the body, then ⌘J acts on them. */
async function ask(page: Page, words: string) {
  await body(page).fill(words);
  await page.keyboard.press(CMD_J);
}

/** The stream has begun: watched per frame, since at a real pace it's over before a slower poll would look. */
async function streaming(page: Page, text = "Hi To") {
  await page.waitForFunction((t) => document.querySelector("[data-testid=ai-preview-text]")?.textContent?.includes(t), text, { polling: "raf" });
}

/**
 * Per frame until the text is in: where each line of the preview stands, where each line of the body stands first, and
 * how tall the form is either side, so a commit that moves a line or the form by a pixel shows.
 */
async function recordCommit(page: Page) {
  await page.evaluate(() => {
    const lines = (root: Element | null) => [...(root?.querySelectorAll("p") ?? [])].filter((p) => p.textContent).map((p) => {
      const range = document.createRange();
      range.selectNodeContents(p);
      const rect = range.getBoundingClientRect();
      return { text: p.textContent, left: rect.left, top: rect.top, height: rect.height };
    });
    const out = { preview: [] as ReturnType<typeof lines>, body: [] as ReturnType<typeof lines>, both: false, previewForm: 0, bodyForm: 0 };
    (window as unknown as { __commit: typeof out }).__commit = out;
    const form = () => document.querySelector("[data-testid=compose-collapse]")?.getBoundingClientRect().top ?? 0;
    let previewed = false;
    const frame = () => {
      const preview = lines(document.querySelector("[data-testid=ai-preview-text]"));
      // plan 163: the body may hold the instruction under the stream, transparent: only text that shows counts
      const editor = document.querySelector("[data-testid=compose-body]");
      const mount = editor?.closest("[data-editor-mount]");
      const shown = !mount || getComputedStyle(mount).opacity !== "0";
      const body = shown ? lines(editor) : [];
      if (preview.length && body.length) out.both = true;
      if (preview.length) { out.preview = preview; out.previewForm = form(); previewed = true; }
      else if (previewed && body.length) { out.body = body; out.bodyForm = form(); return; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  return () => page.evaluate(() => (window as unknown as { __commit: { preview: { text: string; left: number; top: number; height: number }[]; body: { text: string; left: number; top: number; height: number }[]; both: boolean; previewForm: number; bodyForm: number } }).__commit);
}

test.beforeEach(() => {
  fakeDraft.firstTokenMs = 250;
  fakeDraft.paceMs = 30;
  fakeDraft.text = (instruction) => (instruction.includes("echo:") ? instruction.replace("echo:", "").trim() : DRAFT);
});
test.afterEach(() => {
  fakeDraft.firstTokenMs = 0;
  fakeDraft.paceMs = 0;
  fakeDraft.text = null;
});

test.describe("drafting with AI (plan 133)", () => {
  test("plan 162: Writing style reaches its end by the wheel, its editor names what it edits beside Save, and its remove buttons are 32 px targets, in every design, light and dark, 1440 and 1100", { tag: "@design" }, async ({ app: page, server }) => {
    await ready(page, server);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-ai").click();
    await page.getByTestId("ai-drafting-style-open").click();
    await expect(page.getByTestId("style-profile").first()).toContainText(/Usually about \d+ words/, { timeout: 20_000 });
    await inEveryLook(page, async (where) => {
      const page_ = page.getByTestId("writing-style");
      // plan 162 (after ai162-r05): where the page continues, nothing fades over its words (a fade read as disabled); it
      // ends at the dialog's edge as every section does
      const scroller = page.getByTestId("settings-scroller");
      await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
      expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 2), where).toBe(true);
      await expect(scroller, where).toHaveCSS("mask-image", "none");
      expect(await wheelsTo(page, page_, page.getByTestId("style-people")), where).toBe(true);
      await page.getByTestId("style-profile-edit").first().scrollIntoViewIfNeeded();
      await page.getByTestId("style-profile-edit").first().click();
      await expect(page.getByTestId("style-edit-scope"), where).toHaveText(/^Editing /);
      await expect(page.getByTestId("style-edit-save"), where).toBeInViewport();
      const remove = page.getByTestId("style-edit-greetings-remove").first();
      if (await remove.count()) {
        // the hit area: its centre and 15 px out on every side are the button
        const hits = await remove.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
          return [[0, 0], [-15, 0], [15, 0], [0, -15], [0, 15]].every(([dx, dy]) => el.contains(document.elementFromPoint(x + dx!, y + dy!)));
        });
        expect(hits, where).toBe(true);
      }
      await page.getByTestId("style-edit-cancel").click();
    });
  });

  test("the commit moves nothing, on both paths", async ({ app: page, server, design }) => {
    await scenario("⌘J from a conversation: the body, the instruction typed there, the stream in its place, one commit that moves nothing, the strip", async () => {
      await ready(page, server);
      await openThread(page, /Contract review/);
      await openField(page);
      await expect(page.getByTestId("composer")).toBeVisible();
      // plan 163: no row until there's work; the empty body says what to do here
      await expect(row(page)).toHaveCount(0);
      expect(await body(page).evaluate((el) => getComputedStyle(el, "::before").content)).toContain("or what it should say, then press");

      const commit = await recordCommit(page);
      fakeDraft.paceMs = 60;
      await ask(page, "say that this is just fine");
      // focus stays in the text, which stays editable; the row says what's happening, lined up with To
      await expect(body(page)).toBeFocused();
      await expect(page.getByTestId("ai-row-status-text")).toHaveText("Writing…");
      await expect(page.getByTestId("ai-live")).toHaveText("Writing draft");
      const labels = page.locator("[data-testid=composer] label");
      expect((await row(page).locator("label").boundingBox())!.x).toBe((await labels.first().boundingBox())!.x);
      await expect(row(page)).toHaveCSS("min-height", "38px");
      await streaming(page);

      // the instruction is still the document until the commit, hidden under the stream; nothing new saved
      await expect(body(page)).toHaveText("say that this is just fine");
      await expect(preview(page)).toHaveAttribute("data-mode", "replacing");
      await expect(preview(page)).toHaveAttribute("aria-hidden", "true");

      // the moment of commit: every line where the preview had it, the same size; never both on screen; the form's foot holds
      await expect(strip(page)).toBeVisible();
      const seen = await commit();
      expect(seen.both).toBe(false);
      expect(seen.preview.length).toBeGreaterThan(2);
      for (const [i, line] of seen.preview.entries()) {
        const after = seen.body[i]!;
        expect(after.left, line.text).toBe(line.left);
        expect(after.top, line.text).toBe(line.top);
        expect(after.height, line.text).toBe(line.height);
      }
      expect(seen.bodyForm).toBe(seen.previewForm);
      await expect(preview(page)).toHaveCount(0);

      // caret on the first placeholder, selected, ready to type over; the strip tells what was used
      await expect(page.getByTestId("ai-live")).toHaveText(/Draft ready, \d+ words/);
      expect(await page.evaluate(() => getSelection()?.toString())).toBe("[date]");
      await expect(strip(page)).toContainText("Written with AI");
      await expect(strip(page)).toContainText("Regenerate");

      // one undo step, autosaved like typing; plan 162 (after ai162-r02): its name says what it takes back
      await expect(page.getByTestId("ai-strip-undo")).toHaveAccessibleName("Undo: remove the AI’s draft");
      await page.getByTestId("ai-strip-undo").click();
      await expect(strip(page)).toHaveCount(0);
      // plan 163: the instruction is back in the body, as typed, the keys in it, no row: change a word and ⌘J again
      await expect(body(page)).toHaveText("say that this is just fine");
      await expect(body(page)).toBeFocused();
      await expect(row(page)).toHaveCount(0);
      const saved = async () => ((await server.backend.server.invoke("drafts.list", {}, dev)) as { bodyText: string }[]).map((d) => d.bodyText);
      await expect.poll(saved).toEqual(["say that this is just fine"]);
      expect(design === null || typeof design === "string").toBe(true);
    });
    await scenario("the check line goes under the text: on the one-tap path, nothing moves at commit either", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await openField(page);
      const commit = await recordCommit(page);
      fakeDraft.paceMs = 60;
      await page.keyboard.press(CMD_J);
      await streaming(page);
      await expect(strip(page)).toBeVisible();
      const seen = await commit();
      for (const [i, line] of seen.preview.entries()) expect(seen.body[i]!.top, line.text).toBe(line.top);
      await expect(page.getByTestId("ai-strip-check")).toContainText("From the conversation alone, with no instruction from you");
      const checkTop = (await page.getByTestId("ai-strip-check").boundingBox())!.y;
      expect(checkTop).toBeGreaterThan((await body(page).boundingBox())!.y);
    });
  });

  test("a long stream follows its last line down; someone who scrolled up to read stays where they are", async ({ app: page, server }) => {
    await ready(page, server);
    await page.setViewportSize({ width: 1440, height: 620 });
    fakeDraft.paceMs = 25;
    fakeDraft.text = () => Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long draft.`).join("\n\n");
    await openThread(page, /Contract review/);
    await openField(page);
    await page.keyboard.press(CMD_J);
    await streaming(page, "Line 20");
    const lastLine = page.locator("[data-testid=ai-preview-text] p").last();
    const box = (await lastLine.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(621);
    await page.getByTestId("reader-subject").evaluate((el) => {
      let node = el.parentElement;
      while (node && node.scrollTop === 0) node = node.parentElement;
      if (node) node.scrollTop = 0;
    });
    const scrolled = await page.getByTestId("reader-subject").boundingBox();
    await page.waitForTimeout(150);
    expect(await page.getByTestId("reader-subject").boundingBox()).toEqual(scrolled);
  });

  test("Still writing… after 8 s, or Loading the model… on a local one with no text yet", async ({ app: page, server }) => {
    await ready(page, server);
    fakeDraft.firstTokenMs = 60_000;
    await openThread(page, /Contract review/);
    await openField(page);
    await page.keyboard.press(CMD_J);
    await expect(page.getByTestId("ai-row-status-text")).toHaveText("Writing…");
    // the clock also runs in real time: well short of 8 s here, so a loaded machine's seconds don't reach it
    await page.clock.fastForward(4_000);
    await expect(page.getByTestId("ai-row-status-text")).toHaveText("Writing…");
    await page.clock.fastForward(4_000);
    // at once, for the same reason: a longer wait would pass a slower timer
    await expect(page.getByTestId("ai-row-status-text")).toHaveText("Loading the model…", { timeout: 600 });
    await page.getByTestId("ai-row-stop").click();
    // plan 163: stopped before any words, the body is as it was, and the row goes
    await expect(body(page)).toHaveText("");
    await expect(page.getByTestId("ai-row-status")).toHaveCount(0);
  });

  test("the row with an instant model: its ways in and out, your notes, a question, a send, a failure", async ({ app: page, server }) => {
    await scenario("the palette reaches it: from a conversation, and in a draft", async () => {
      await ready(page, server);
      instant();
      await openThread(page, /Contract review/);
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByTestId("palette-ai-draft").click();
      await expect(body(page)).toBeFocused();
      // plan 163: opened for AI and nothing more: Esc is the composer's, and the empty reply goes
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("composer")).toHaveCount(0);
      await page.keyboard.press("r");
      await expect(body(page)).toBeFocused();
      await page.keyboard.type("say that this is just fine");
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByTestId("palette-draft-ai").click();
      await expect(strip(page)).toBeVisible();
    });
    await scenario("plan 161: in the pinned card's width the strip keeps its status, and its commands wrap under it", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await openField(page);
      await body(page).fill("say that this is just fine");
      await page.keyboard.press(CMD_J);
      await strip(page).waitFor();
      await page.getByTestId("compose-pin").click();
      const card = page.getByTestId("pinned-draft");
      await expect(card.getByTestId("ai-strip")).toBeVisible();
      await expect(card.getByTestId("ai-strip-written")).toBeVisible();
      await expect(card.getByTestId("ai-strip-written")).toHaveText("Written with AI");
      // plan 163: one line, the commands and the status (what was asked is in the popover)
      expect((await card.getByTestId("ai-row").boundingBox())!.height).toBeLessThanOrEqual(40);
    });
    await scenario("plan 163: ⌘J with nothing typed is the one-tap draft; with an instruction, its draft; Undo gives back what was there; Esc on an empty one is the composer's", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await page.getByTestId("quick-ai").click();
      await expect(body(page)).toBeFocused();
      // the Sparkles in its foot is quiet over an empty reply, and named for what ⌘J does there
      await expect(page.getByTestId("compose-ai")).toHaveAccessibleName("Draft a reply with AI");
      await expect(page.getByTestId("compose-ai")).not.toHaveAttribute("data-ready");
      await page.keyboard.press(CMD_J);
      await expect(strip(page)).toBeVisible();
      await expect(page.getByTestId("ai-strip-check")).toContainText("From the conversation alone, with no instruction from you");
      await page.getByTestId("ai-strip-undo").click();
      await expect(body(page)).toHaveText("");
      await expect(row(page)).toHaveCount(0);

      // an instruction lights the Sparkles, which says what it will do; clicking it writes, as ⌘J does
      await body(page).fill("echo: fine by me, tell him that");
      await expect(page.getByTestId("compose-ai")).toHaveAttribute("data-ready", "true");
      await expect(page.getByTestId("compose-ai")).toHaveAccessibleName("Write it from your note with AI");
      await page.getByTestId("compose-ai").click();
      await expect(body(page)).toContainText("fine by me, tell him that");
      await expect(strip(page)).toBeVisible();
      await page.getByTestId("ai-strip-undo").click();
      await expect(body(page)).toHaveText("echo: fine by me, tell him that");
      await expect(body(page)).toBeFocused();
      // plan 162 (after ai162-r05): Undo gives back the note for AI exactly: its label, and Write it as the primary
      await expect(page.getByTestId("ai-note-label")).toBeVisible();
      await expect(page.getByTestId("compose-note-actions")).toBeVisible();
      await expect(page.getByTestId("compose-ai")).toHaveAttribute("data-note", "true");

      // an ordinary email being typed leaves it quiet
      await body(page).fill("Hi Tom,\n\nThat works for me. See you then.");
      await page.waitForTimeout(300);
      await expect(page.getByTestId("compose-ai")).not.toHaveAttribute("data-ready");

      // opened for AI and nothing more: the composer's own Esc closes an empty reply
      await page.getByTestId("compose-discard").click();
      await page.getByTestId("quick-ai").waitFor();
      await page.getByTestId("quick-ai").click();
      await expect(body(page)).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("composer")).toHaveCount(0);
      await expect(page.getByTestId("quick-reply")).toBeFocused();
    });
    await scenario("⌘J from a draft and from the list", async () => {
      await fresh(page, server);
      // the list, with nothing open: a new message, the row focused, asks who when it can't tell
      await page.getByTestId("thread-list").locator("[data-keep-scroll=list]").focus();
      await page.keyboard.press("c");
      await expect(page.getByTestId("compose-to")).toBeFocused();
      // plan 163: ⌘J in a new message with nothing in it and nobody in To asks who it's for
      await page.keyboard.press(CMD_J);
      await expect(page.getByTestId("ai-who")).toHaveText("Who is it for? Add them in To.");
      await expect(page.getByTestId("compose-to")).toBeFocused();
      await addRecipients(page, "compose-to", "rosa@faraway.example");
      await page.getByTestId("ai-who-write").click();
      await expect(strip(page)).toBeVisible();
      // an empty subject gets one; Undo takes both back
      await expect(page.getByTestId("compose-subject")).toHaveValue("Fake subject");
      await page.getByTestId("ai-strip-undo").click();
      await expect(page.getByTestId("compose-subject")).toHaveValue("");
      await expect(body(page)).toHaveText("");
    });
    await scenario("your notes: with text in the body it expands them, and ends in Replace, Insert below or Discard", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await page.keyboard.press("r");
      await expect(body(page)).toBeFocused();
      // plan 163: their own email (a greeting says so), nothing marked: expanded beside it, never over it
      const mine = "Hi Tom,\n\nfine with the 19th";
      await body(page).fill(mine);
      await page.keyboard.press(CMD_J);
      const choice = page.getByTestId("ai-choice");
      await expect(choice).toHaveAttribute("data-reason", "notes");
      await expect(preview(page)).toHaveAttribute("data-mode", "below");
      await expect(preview(page)).not.toHaveAttribute("aria-hidden", "true");
      await expect(body(page)).toContainText("fine with the 19th");

      await page.getByTestId("ai-choice-below").click();
      await expect(body(page)).toContainText("fine with the 19th");
      await expect(body(page)).toContainText("That works for me");
      await page.keyboard.press("ControlOrMeta+z");
      await expect(body(page)).not.toContainText("That works for me");

      await page.keyboard.press(CMD_J);
      await page.getByTestId("ai-choice-replace").click();
      await expect(body(page)).not.toContainText("fine with the 19th");
      await expect(body(page)).toContainText("That works for me");
      await page.getByTestId("ai-strip-undo").click();
      await expect(body(page)).toContainText("fine with the 19th");
      await expect(row(page)).toHaveCount(0);

      await page.keyboard.press(CMD_J);
      await page.getByTestId("ai-choice-discard").click();
      await expect(body(page)).toContainText("fine with the 19th");
      await expect(body(page)).not.toContainText("That works for me");
      await expect(row(page)).toHaveCount(0);
    });
    await scenario("coming back to a question doesn't take focus: only asking for it does (Codex review 10)", async () => {
      await fresh(page, server);
      await openThread(page, /Studio lunch/);
      await openField(page);
      await body(page).fill("tell tom that this is just fine");
      await page.keyboard.press(CMD_J);
      await expect(page.getByTestId("ai-choice-forward")).toBeFocused();
      await openThread(page, /Contract review/);
      await page.getByTestId("thread-row").filter({ hasText: /Contract review/ }).first().focus();
      await openThread(page, /Studio lunch/);
      await expect(page.getByTestId("ai-question")).toBeVisible();
      await expect(page.getByTestId("ai-choice-forward")).not.toBeFocused();
    });
    await scenario("the choice at the send: discard the suggestion, and what's in the document goes", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await page.keyboard.press("r");
      // plan 163: their own email, expanded beside it
      await page.keyboard.type("Hi Ana,\nshort and mine");
      await expect(body(page)).toBeFocused();
      await page.keyboard.press(CMD_J);
      await page.getByTestId("ai-choice").waitFor();
      await page.keyboard.press("ControlOrMeta+Enter");
      await expect(page.getByTestId("ai-guard")).toContainText("A suggestion hasn’t gone in.");
      await page.getByTestId("ai-guard-send").click();
      await expect(page.getByTestId("composer")).toHaveCount(0);
      const db = sqlDb(server.backend.store);
      await expect.poll(() => db.get<{ snippet: string }>("SELECT snippet FROM messages WHERE is_sent = 1 ORDER BY id DESC LIMIT 1")!.snippet).toContain("short and mine");
    });
    await scenario("failures say what happened: a refusal discards, a dropped connection keeps what came with Insert and Try again", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await openField(page);
      await body(page).fill("tell him nope [fake:refusal]");
      await page.keyboard.press(CMD_J);
      await expect(page.getByTestId("ai-error-text")).toContainText("The model declined to write this.");
      await expect(page.getByTestId("ai-error-insert")).toHaveCount(0);
      await page.getByTestId("ai-error-close").click();

      await openField(page);
      await body(page).fill("tell him it drops [fake:fail:3]");
      await page.keyboard.press(CMD_J);
      await expect(page.getByTestId("ai-error-text")).toBeVisible();
      await expect(page.getByTestId("ai-error-insert")).toBeVisible();
      await expect(page.getByTestId("ai-error-retry")).toBeVisible();
      // what came can be read before deciding on it, by anyone (Codex review 11)
      await expect(preview(page)).not.toHaveAttribute("aria-hidden", "true");
      await expect(page.getByRole("region", { name: "Suggestion" })).toBeVisible();
      await page.getByTestId("ai-error-insert").click();
      await expect(strip(page)).toBeVisible();
      await expect(page.getByTestId("ai-strip-check")).toContainText("This was cut off.");
    });
  });

  test.describe("“tell tom” in each row of §5.2", () => {
    test("“tell tom”, each row", async ({ app: page, server }) => {
      await scenario("a thread, a participant who isn't the last sender: to them alone, answering their message, with everyone one click away", async () => {
        await ready(page, server);
      instant();
        await openThread(page, /Contract review/);
        await openField(page);
        await expect(await recipientEmails(page, "compose-to")).toEqual(["ana@studio.example"]);
        await body(page).fill("tell tom that this is just fine");
        await page.keyboard.press(CMD_J);
        await expect.poll(() => recipientEmails(page, "compose-to")).toEqual(["tom@acme.example"]);
        await expect(page.getByTestId("ai-include-everyone")).toHaveText("Include everyone (3)");
        // To is on screen before any text
        await expect(page.getByTestId("compose-cc")).toHaveCount(0);
        await expect(strip(page)).toBeVisible();
      });
      await scenario("a thread, someone who isn't on it: it asks, and nothing is quoted or attached until chosen", async () => {
        await fresh(page, server);
        await openThread(page, /Studio lunch/);
        await openField(page);
        await body(page).fill("tell tom that this is just fine");
        await page.keyboard.press(CMD_J);
        const question = page.getByTestId("ai-question");
        await expect(question).toHaveAttribute("data-question", "forward-or-new");
        await expect(question).toContainText("Tom isn’t on this conversation.");
        await expect(page.getByTestId("ai-choice-forward")).toBeFocused();
        await expect(preview(page)).toHaveCount(0);
        await page.getByTestId("ai-choice-new").click();
        await expect(page.getByTestId("compose-title")).toBeVisible();
        await expect.poll(() => recipientEmails(page, "compose-to")).toEqual(["tom@acme.example"]);
        await expect(strip(page)).toBeVisible();
        // the empty reply it was going to be is gone
        await expect(page.getByTestId("composer")).toHaveCount(1);
        await expect(page.getByTestId("composer")).toHaveAttribute("data-mode", "new");
      });
      await scenario("a thread, someone who isn't on it: Forward adds the original, because they said so", async () => {
        await fresh(page, server);
        await openThread(page, /Studio lunch/);
        await openField(page);
        await body(page).fill("tell tom that this is just fine");
        await page.keyboard.press(CMD_J);
        await page.getByTestId("ai-choice-forward").click();
        await expect(page.getByTestId("composer")).toHaveAttribute("data-mode", "forward");
        await expect.poll(() => recipientEmails(page, "compose-to")).toEqual(["tom@acme.example"]);
        await expect(strip(page)).toBeVisible();
      });
      await scenario("the list, a recent thread with them: New message is the default, Reply on it one click away", async () => {
        await fresh(page, server);
        await page.getByTestId("thread-list").locator("[data-keep-scroll=list]").focus();
        await page.keyboard.press("c");
        await openField(page);
        await body(page).fill("tell tom that this is just fine");
        await page.keyboard.press(CMD_J);
        const question = page.getByTestId("ai-question");
        await expect(question).toHaveAttribute("data-question", "new-or-reply");
        await expect(question).toContainText("Contract review");
        await expect(page.getByTestId("ai-choice-new")).toBeFocused();
        await page.keyboard.press("Enter");
        await expect.poll(() => recipientEmails(page, "compose-to")).toEqual(["tom@acme.example"]);
        await expect(strip(page)).toBeVisible();

        await page.getByTestId("compose-discard").click();
        await page.keyboard.press("c");
        await openField(page);
        await body(page).fill("tell tom that this is just fine");
        await page.keyboard.press(CMD_J);
        await page.getByTestId("ai-choice-reply").click();
        await expect(page.getByTestId("reader-subject")).toContainText("Contract review");
        await expect.poll(() => recipientEmails(page, "compose-to")).toEqual(["tom@acme.example"]);
        await expect(strip(page)).toBeVisible();
      });
      await scenario("Codex review 3: an answer landing in a reply with words of its own never writes over them; nothing typed is lost", async () => {
        await fresh(page, server);
        await openThread(page, /Contract review/);
        await page.keyboard.press("r");
        await expect(body(page)).toBeFocused();
        await page.keyboard.type("Hi Ana, my own words");
        await page.getByTestId("compose-collapse").click();
        await page.getByTestId("thread-list").locator("[data-keep-scroll=list]").focus();
        await page.keyboard.press("c");
        await openField(page);
        await ask(page, "tell tom that this is just fine");
        await page.getByTestId("ai-choice-reply").click();
        await expect(page.getByTestId("reader-subject")).toContainText("Contract review");
        // the reply keeps its words and its recipient; the instruction is still a draft of its own until it lands somewhere
        const saved = async () => ((await server.backend.server.invoke("drafts.list", {}, dev)) as { bodyText: string }[]).map((d) => d.bodyText).sort();
        await expect.poll(saved).toContain("Hi Ana, my own words");
        await page.waitForTimeout(1000);
        const kept = await saved();
        expect(kept.some((t) => t.includes("Hi Ana, my own words") && !t.includes("This is just fine"))).toBe(true);
        expect(kept.some((t) => t.includes("tell tom that this is just fine") || t.includes("That works for me"))).toBe(true);
        // neither is on screen to discard: they go from the store, so the next scenario starts clean
        for (const d of (await server.backend.server.invoke("drafts.list", {}, dev)) as { id: number; generation: string }[]) await server.backend.server.invoke("drafts.delete", { id: d.id, generation: d.generation }, dev);
      });
      await scenario("the list, no recent thread: a new message to them", async () => {
        await fresh(page, server);
        await page.getByTestId("thread-list").locator("[data-keep-scroll=list]").focus();
        await page.keyboard.press("c");
        await openField(page);
        await body(page).fill("tell rosa that this is just fine");
        await page.keyboard.press(CMD_J);
        await expect.poll(() => recipientEmails(page, "compose-to")).toEqual(["rosa@faraway.example"]);
        await expect(strip(page)).toBeVisible();
      });
      await scenario("a thread, nobody named: a reply as usual", async () => {
        await fresh(page, server);
        await openThread(page, /Contract review/);
        await openField(page);
        await body(page).fill("say the clauses look right");
        await page.keyboard.press(CMD_J);
        await expect(strip(page)).toBeVisible();
        expect(await recipientEmails(page, "compose-to")).toEqual(["ana@studio.example"]);
      });
      await scenario("the list, nobody named: the row asks who it's for", async () => {
        await fresh(page, server);
        await page.getByTestId("thread-list").locator("[data-keep-scroll=list]").focus();
        await page.keyboard.press("c");
        await openField(page);
        await body(page).fill("say the clauses look right");
        await page.keyboard.press(CMD_J);
        await expect(page.getByTestId("ai-who")).toBeVisible();
        await expect(page.getByTestId("compose-to")).toBeFocused();
        // plan 163: the instruction stays where it was typed; Send now would mail it, so it stops
        await expect(body(page)).toHaveText("say the clauses look right");
        await page.keyboard.press("ControlOrMeta+Enter");
        await expect(page.getByTestId("ai-guard")).toContainText("AI is still working on what you wrote.");
      });
      await scenario("a draft with recipients: one of them stands, someone else asks and is never re-addressed silently", async () => {
        await fresh(page, server);
        await page.getByTestId("thread-list").locator("[data-keep-scroll=list]").focus();
        await page.keyboard.press("c");
        await addRecipients(page, "compose-to", "Ana Pérez <ana@studio.example>");
        await openField(page);
        await body(page).fill("tell ana that this is just fine");
        await page.keyboard.press(CMD_J);
        await expect(strip(page)).toBeVisible();
        expect(await recipientEmails(page, "compose-to")).toEqual(["ana@studio.example"]);
        await page.getByTestId("ai-strip-undo").click();
        await expect(body(page)).toHaveText("tell ana that this is just fine");

        await body(page).fill("tell tom that this is just fine");
        await page.keyboard.press(CMD_J);
        await expect(page.getByTestId("ai-question")).toHaveAttribute("data-question", "add-or-just-write");
        expect(await recipientEmails(page, "compose-to")).toEqual(["ana@studio.example"]);
        await page.getByTestId("ai-choice-add").click();
        await expect.poll(() => recipientEmails(page, "compose-to")).toEqual(["ana@studio.example", "tom@acme.example"]);
        await expect(strip(page)).toBeVisible();
      });
    });

  });

  test("plan 162 (after ai162-r04): a note for AI is visibly one at every width, Send asks before mailing it, and words typed after a draft revise it", async ({ app: page, server }) => {
    instant();
    await ready(page, server);
    fakeDraft.text = (instruction) => (/shorter/.test(instruction) ? "Hi Tom,\n\nShort and sweet.\n\nLuis" : /fine by me/.test(instruction) ? "Hi Tom,\n\nThat's fine by me.\n\nLuis" : null);
    try {
      for (const width of [1100, 1440]) {
        await page.setViewportSize({ width, height: width === 1100 ? 700 : 900 });
        await fresh(page, server);
        await openThread(page, /Contract review/);
        await page.getByTestId("quick-ai").click();
        await body(page).fill("fine by me, tell him that");
        // the body says it's a note for AI (a wash, "For AI"), described to assistive tech; a plain draft has none of it
        await expect(page.getByTestId("ai-note-label")).toHaveText(/For AI/);
        await expect(page.locator("[data-ai-note]")).toHaveCount(1);
        await expect(body(page)).toHaveAccessibleDescription(/Your note for AI/);
        // Write it is the primary, in Send's place, with its word at every width; Send an icon that steps back
        const write = page.getByTestId("compose-ai");
        await expect(write).toHaveAttribute("data-note", "true");
        await expect(write).toHaveText(/Write it/);
        await expect(write).toBeInViewport();
        // plan 162 (after ai162-r05): Send is off, its reason in its description and tooltip; a click sends nothing and asks nothing
        await expect(page.getByTestId("compose-send")).toHaveAccessibleName("Send");
        await expect(page.getByTestId("compose-send")).toHaveAttribute("aria-disabled", "true");
        await expect(page.getByTestId("compose-send")).toHaveAccessibleDescription(/Send is off while this is a note for AI/);
        await expect(page.getByTestId("compose-send-group")).toHaveCount(0);
        await page.getByTestId("compose-send").click({ force: true });
        await page.waitForTimeout(200);
        await expect(page.getByTestId("compose-empty-ask")).toHaveCount(0);
        await expect(page.getByTestId("composer")).toBeVisible();
        await expect(body(page)).toHaveText("fine by me, tell him that");
        const sendBox = (await page.getByTestId("compose-send").boundingBox())!;
        const writeBox = (await write.boundingBox())!;
        expect(writeBox.x).toBeLessThan(sendBox.x);
        // ⌘↵ asks, Esc puts the question away and nothing went
        await body(page).press("ControlOrMeta+Enter");
        await expect(page.getByTestId("compose-empty-ask")).toContainText("This reads as a note for AI.");
        // the body still says what it is while it asks
        await expect(page.getByTestId("ai-note-label")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("compose-empty-ask")).toHaveCount(0);
        await expect(body(page)).toHaveText("fine by me, tell him that");
        // Send later keeps its picker (Codex review: ⌘⇧↩ did nothing); what it picks asks the same question
        await body(page).press("ControlOrMeta+Shift+Enter");
        await expect(page.getByTestId("send-later-popover")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("send-later-popover")).toHaveCount(0);
      }
      // Write it from the question writes; the note's marks go, Send is the primary again
      await body(page).press("ControlOrMeta+Enter");
      await page.getByTestId("compose-note-write").click();
      await expect(strip(page)).toBeVisible();
      await expect(body(page)).toContainText("That's fine by me.");
      await expect(page.getByTestId("ai-note-label")).toHaveCount(0);
      await expect(page.getByTestId("compose-send-group")).toBeVisible();
      // words typed after the draft are how to change it: the draft is rewritten from them, they don't stay, no copy beside it
      await body(page).click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
      await page.keyboard.type("make it shorter");
      await page.keyboard.press(CMD_J);
      await expect(body(page)).toContainText("Short and sweet.");
      await expect(body(page)).not.toContainText("make it shorter");
      await expect(preview(page)).toHaveCount(0);
      await expect(page.getByTestId("ai-confirm")).toHaveCount(0);
      // Undo gives back exactly what was there: the draft and the words
      await page.getByTestId("ai-strip-undo").click();
      await expect(body(page)).toContainText("That's fine by me.");
      await expect(body(page)).toContainText("make it shorter");
      // a plain draft never looks like a note
      await page.getByTestId("ai-strip-undo").click();
      await body(page).fill("Hi Tom,\n\nThat works for me. See you then.");
      await page.waitForTimeout(300);
      await expect(page.locator("[data-ai-note]")).toHaveCount(0);
      await expect(page.getByTestId("compose-send-group")).toBeVisible();
    } finally {
      fakeDraft.text = null;
    }
  });

  test("during the stream: Esc, typing, collapsing, switching", async ({ app: page, server }) => {
    await scenario("plan 163: Esc mid-stream stops and keeps what came, Stopped part-way, over its instruction; Undo gives the instruction back in the body", async () => {
      await ready(page, server);
      await openThread(page, /Contract review/);
      await openField(page);
      await body(page).fill("say that this is just fine");
      await page.keyboard.press(CMD_J);
      // while it writes, the instruction stays where it was typed, dimmed, until the stream takes its place
      await expect(body(page)).toHaveText("say that this is just fine");
      await streaming(page);
      await page.keyboard.press("Escape");
      // ai-r02: Esc took the instruction and the words that had come, without a word
      await expect(strip(page)).toHaveAttribute("data-stopped", "true");
      await expect(page.getByTestId("ai-strip-written")).toHaveText("Stopped part-way");
      await expect(body(page)).toContainText("Hi To");
      await expect(body(page)).not.toContainText("say that this is just fine");
      await expect(page.getByTestId("ai-live")).toHaveText("Stopped. What it wrote so far is in the draft.");
      await expect(preview(page)).toHaveCount(0);
      await expect(page.getByTestId("composer")).toBeVisible();
      // its popover says it stopped, not a voice it may not have used
      await page.getByTestId("ai-strip-voice").click();
      await expect(page.getByTestId("ai-voice-label")).toHaveText(/stopped it before it finished/);
      await page.keyboard.press("Escape");
      // Undo: the words go, and the instruction is the body's again, the keys there, no row
      await page.getByTestId("ai-strip-undo").click();
      await expect(body(page)).toHaveText("say that this is just fine");
      await expect(body(page)).toBeFocused();
      await expect(row(page)).toHaveCount(0);
    });
    await scenario("plan 163: Esc before any words leaves the instruction in the body", async () => {
      await fresh(page, server);
      fakeDraft.firstTokenMs = 60_000;
      await openThread(page, /Contract review/);
      await openField(page);
      await body(page).fill("say that this is just fine");
      await page.keyboard.press(CMD_J);
      await expect(page.getByTestId("ai-row-status-text")).toHaveText("Writing…");
      await page.keyboard.press("Escape");
      await expect(body(page)).toHaveText("say that this is just fine");
      await expect(row(page)).toHaveCount(0);
      fakeDraft.firstTokenMs = 250;
    });
    await scenario("typing during the stream: it goes on, and ends as a suggestion; a change of recipients says who it was for", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await openField(page);
      await body(page).fill("say that this is just fine");
      await page.keyboard.press(CMD_J);
      await streaming(page);
      // plan 163: typed into the instruction while it writes: it shows again, and the draft ends beside it, Replace offered
      await page.keyboard.type(" my own words");
      await expect(preview(page)).toHaveAttribute("data-mode", "below");
      await expect(page.getByTestId("ai-choice")).toHaveAttribute("data-reason", "typed");
      await expect(page.getByTestId("ai-choice-text")).toHaveText("Suggestion ready");
      await expect(body(page)).toHaveText("say that this is just fine my own words");
      await page.getByTestId("ai-choice-below").click();
      await expect(body(page)).toContainText("my own words");
      await expect(body(page)).toContainText("That works for me");

      await page.keyboard.press("ControlOrMeta+z");
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("Backspace");
      await openField(page);
      await body(page).fill("say that this is just fine");
      await page.keyboard.press(CMD_J);
      await streaming(page);
      await addRecipients(page, "compose-to", "rosa@faraway.example");
      await expect(page.getByTestId("ai-written-for")).toHaveText("Written for Ana");
    });
    await scenario("collapse and return: it goes on, the collapsed line says so, and the text is there with its strip on return", async () => {
      await fresh(page, server);
      fakeDraft.paceMs = 80;
      await openThread(page, /Contract review/);
      await openField(page);
      await body(page).fill("say that this is just fine");
      await page.keyboard.press(CMD_J);
      await streaming(page);
      await page.getByTestId("compose-collapse").click();
      await expect(page.getByTestId("draft-collapsed")).toContainText("Writing…");
      await expect(page.getByTestId("draft-collapsed")).toContainText("Suggestion ready");
      await page.getByTestId("draft-collapsed").click();
      await expect(strip(page)).toBeVisible();
      await expect(body(page)).toContainText("That works for me");
      await page.getByTestId("ai-strip-undo").click();
      await expect(body(page)).toHaveText("say that this is just fine");
    });
    await scenario("switching threads: it goes on, and the text is there with its strip on return", async () => {
      await fresh(page, server);
      fakeDraft.paceMs = 80;
      fakeDraft.text = () => "Hi Tom,\n\nThat works for me.";
      await openThread(page, /Contract review/);
      await openField(page);
      await body(page).fill("say that this is just fine");
      await page.keyboard.press(CMD_J);
      await streaming(page);
      await openThread(page, /Studio lunch/);
      await expect(page.getByTestId("composer")).toHaveCount(0);
      // long enough for this short stream to end while away (nothing outside the composer says it has)
      await page.waitForTimeout(600);
      await openThread(page, /Contract review/);
      await expect(strip(page)).toBeVisible();
      await expect(body(page)).toContainText("That works for me");
      expect(await recipientEmails(page, "compose-to")).toEqual(["ana@studio.example"]);
    });
  });

  test("during the stream: pinned, a send, axe", async ({ app: page, server }) => {
    await scenario("pinned: the stream goes on in the card, its editor rebuilt, and commits there", async () => {
      await ready(page, server);
      fakeDraft.paceMs = 80;
      await openThread(page, /Contract review/);
      await openField(page);
      await body(page).fill("say that this is just fine");
      await page.keyboard.press(CMD_J);
      await streaming(page);
      await page.getByTestId("compose-pin").click();
      const card = page.getByTestId("pinned-draft");
      await expect(card.getByTestId("ai-preview-text")).toContainText("Hi Tom");
      await expect(card.getByTestId("ai-strip")).toBeVisible();
      await expect(card.getByTestId("compose-body")).toContainText("That works for me");
      await card.getByTestId("ai-strip-undo").click();
      await expect(card.getByTestId("compose-body")).toHaveText("say that this is just fine");
    });
    await scenario("send blocked: ⌘↵, Send and Send Later all stop at the row, which offers the choice", async () => {
      await fresh(page, server);
      fakeDraft.paceMs = 120;
      await openThread(page, /Contract review/);
      await openField(page);
      await body(page).fill("say that this is just fine");
      await page.keyboard.press(CMD_J);
      await streaming(page);
      await page.keyboard.press("ControlOrMeta+Enter");
      const guard = page.getByTestId("ai-guard");
      await expect(guard).toContainText("A draft is still being written.");
      await expect(page.getByTestId("composer")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(guard).toHaveCount(0);
      await expect(page.getByTestId("ai-row-status")).toBeVisible();

      await page.getByTestId("compose-send").click();
      await expect(guard).toBeVisible();
      await page.getByTestId("ai-guard-keep").click();
      await page.getByTestId("ai-choice").or(strip(page)).first().waitFor();

      // finished and committed: nothing undecided; the gap it left ([date]) is asked about once, inline (plan 161), and it sends
      await expect(strip(page)).toBeVisible();
      await page.keyboard.press("ControlOrMeta+Enter");
      await expect(page.getByTestId("ai-gaps")).toContainText("[date]");
      await page.getByTestId("ai-gaps-send").click();
      await expect(page.getByTestId("composer")).toHaveCount(0);
    });
    await scenario("axe with the stream on its way, light and dark (the row and the strip: the sweep)", async () => {
      await fresh(page, server);
      fakeDraft.paceMs = 120;
      await openThread(page, /Contract review/);
      await openField(page);
      await body(page).fill("say that this is just fine");
      await page.keyboard.press(CMD_J);
      await streaming(page);
      expect((await new AxeBuilder({ page }).include("[data-testid=composer]").analyze()).violations).toEqual([]);
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveClass(/dark/);
      expect((await new AxeBuilder({ page }).include("[data-testid=composer]").withRules(["color-contrast"]).analyze()).violations).toEqual([]);
      await page.emulateMedia({ colorScheme: "light" });
      await expect(strip(page)).toBeVisible();
    });
  });

  test("what comes while a reply is still opening: words are the body's however the open ends, and Reply all stays Reply all (plan 158)", async ({ app: page, server }) => {
    /** The open stays on its way, at the backend's check of its source: what a person typing fast meets on a loaded machine. */
    const whileOpening = async (keys: () => Promise<void>) => {
      const drafts = server.backend.store.drafts;
      const real = drafts.sourceContext;
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      drafts.sourceContext = async (id: number) => { await held; return real.call(drafts, id); };
      try {
        await keys();
      } finally {
        drafts.sourceContext = real;
        release();
      }
    };
    const saved = async () => ((await server.backend.server.invoke("drafts.list", {}, dev)) as { bodyText: string }[]).map((d) => d.bodyText);
    await scenario("⌘J: the words are in the text, the row is empty, and the draft goes by them", async () => {
      await ready(page, server);
      instant();
      await openThread(page, /Contract review/);
      await whileOpening(async () => {
        await page.keyboard.press("r");
        await page.keyboard.type("Hi Ana,\nshort and mine");
        await page.keyboard.press(CMD_J);
      });
      // plan 163: the words are the body's, the keys there; nothing ran on words still arriving
      await expect(body(page)).toBeFocused();
      await expect(body(page)).toHaveText(/Hi Ana,\s*short and mine/);
      await page.keyboard.press(CMD_J);
      await expect(page.getByTestId("ai-choice")).toHaveAttribute("data-reason", "notes");
      await page.getByTestId("ai-choice-discard").click();
      await expect(body(page)).toHaveText(/Hi Ana,\s*short and mine/);
      await expect.poll(saved).toEqual(["Hi Ana,\nshort and mine"]);
    });
    await scenario("a click away: the reply still opens, with the words, and doesn't take focus back", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await whileOpening(async () => {
        await page.keyboard.press("r");
        await page.keyboard.type("before the click");
        await page.getByTestId("reader-subject").click();
      });
      await expect(body(page)).toHaveText("before the click");
      await expect(body(page)).not.toBeFocused();
    });
    await scenario("Esc: the open ends and the words are a draft put away, saved, as a moment later they would have been", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await whileOpening(async () => {
        await page.keyboard.press("r");
        await page.keyboard.type("before the esc");
        await page.keyboard.press("Escape");
      });
      await expect(page.getByTestId("composer")).toHaveCount(0);
      await expect(page.getByTestId("draft-collapsed")).toContainText("before the esc");
      await expect.poll(saved).toEqual(["before the esc"]);
      await page.keyboard.press("r");
      await expect(body(page)).toHaveText("before the esc");
    });
    await scenario("Reply all, still opening when ⌘J comes", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await whileOpening(async () => {
        await page.keyboard.press("a");
        await page.keyboard.press(CMD_J);
      });
      await expect(body(page)).toBeFocused();
      await expect(page.getByTestId("composer")).toHaveAttribute("data-mode", "replyAll");
    });
    await scenario("an open of another conversation still going: when it settles, the first one's words are saved there, not left in memory", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await whileOpening(async () => {
        await page.keyboard.press("r");
        await page.keyboard.type("for the contract");
        await page.keyboard.press("Escape");
        await openThread(page, /Studio lunch/);
        await page.keyboard.press("r");
      });
      await expect(body(page)).toBeFocused();
      await expect(body(page)).toHaveText("");
      await page.keyboard.type("for the lunch");
      await expect.poll(async () => (await saved()).sort()).toEqual(["for the contract", "for the lunch"]);
      await page.getByTestId("compose-discard").click();
      await expect.poll(saved).toEqual(["for the contract"]);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await openThread(page, /Contract review/);
      await expect(page.getByTestId("draft-collapsed")).toContainText("for the contract");
      await page.getByTestId("draft-collapsed").click();
      await page.getByTestId("compose-discard").click();
    });
    await scenario("c right after: a new message isn't what they were written for: it opens empty, and they're the reply's", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await whileOpening(async () => {
        await page.keyboard.press("r");
        await page.keyboard.type("for the reply");
        await page.keyboard.press("Escape");
        await page.keyboard.press("c");
        await expect(page.getByTestId("compose-to")).toBeFocused();
      });
      await expect.poll(saved).toEqual(["for the reply"]);
      await expect(body(page)).toHaveText("");
    });
    await scenario("Esc, and the conversation can't be read by the time they'd be kept: a new message on its account holds them, saved (series review)", async () => {
      // the last scenario's reply is put away, where fresh's Discard doesn't reach
      await page.getByTestId("compose-discard").click();
      await openThread(page, /Contract review/);
      await page.getByTestId("draft-collapsed").click();
      await fresh(page, server);
      const threadId = Number(await page.locator("[data-testid=thread-row]", { hasText: /Contract review/ }).first().getAttribute("data-thread-id"));
      await openThread(page, /Contract review/);
      const handlers = (server.backend.server as unknown as { handlers: Record<string, (input: { threadId: number }, ...rest: unknown[]) => unknown> }).handlers;
      const get = handlers["threads.get"]!;
      try {
        await whileOpening(async () => {
          await page.keyboard.press("r");
          await page.keyboard.type("nowhere else");
          await page.keyboard.press("Escape");
          // it's gone from under them: the reader's own refetch finds nothing
          handlers["threads.get"] = (input, ...rest) => {
            if (input.threadId === threadId) throw new RpcError("NOT_FOUND", "gone");
            return get(input, ...rest);
          };
          await server.backend.server.invoke("threads.act", { threadIds: [threadId], action: "markUnread" }, dev);
          await expect.poll(() => page.evaluate((id) => Boolean((window as unknown as { __terno: { threadDetail(id: number): unknown } }).__terno.threadDetail(id)), threadId)).toBe(false);
        });
        const kept = async () => ((await server.backend.server.invoke("drafts.list", {}, dev)) as { bodyText: string; mode: string; subject: string }[]).map((d) => [d.bodyText, d.mode, d.subject]);
        await expect.poll(kept).toEqual([["nowhere else", "new", expect.stringMatching(/^Re: Contract review/)]]);
      } finally {
        handlers["threads.get"] = get;
      }
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await expect(page.getByTestId("strip-item")).toContainText("Re: Contract review");
    });
  });

  test("no provider: nothing shows; one that goes from under the row says what to do; off in Settings, it's gone everywhere", async ({ app: page, server }) => {
    await seed(server);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await rows(page).first().waitFor();
    // this window doesn't hear of the change below: what another window's Settings looks like from here
    await openThread(page, /Contract review/);
    await page.keyboard.press(CMD_J);
    await expect(body(page)).toBeFocused();
    await server.backend.server.invoke("settings.update", { ai: { provider: "none" } }, dev);
    await body(page).fill("say yes");
    await page.keyboard.press(CMD_J);
    await expect(page.getByTestId("ai-no-provider")).toContainText("Drafting needs an AI provider. Use your own key or a local model.");
    // plan 163: what was typed is a draft of its own now: it goes, so the reply bar is back after the reload
    await page.getByTestId("compose-discard").click();

    // Plan 147: a free install: no button, no row, no shortcut, no line in the palette or the help
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await rows(page).first().waitFor();
    await openThread(page, /Contract review/);
    await expect(page.getByTestId("quick-ai")).toHaveCount(0);
    await page.keyboard.press(CMD_J);
    await page.waitForTimeout(100);
    await expect(row(page)).toHaveCount(0);
    await expect(page.getByTestId("ai-no-provider")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-input").fill("draft with ai");
    await expect(page.getByTestId("palette-ai-draft")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await server.backend.server.invoke("settings.update", { ai: { provider: "fake" } }, dev);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await rows(page).first().waitFor();
    await openThread(page, /Contract review/);
    await page.getByTestId("quick-ai").waitFor();
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-ai").click();
    await expect(page.getByTestId("ai-tab")).toBeVisible();
    await page.getByTestId("ai-drafting-enabled").click();
    await expect(page.getByTestId("ai-drafting-enabled")).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("quick-ai")).toHaveCount(0);
    await page.keyboard.press(CMD_J);
    await page.waitForTimeout(100);
    await expect(row(page)).toHaveCount(0);
  });

  test("plan 163: their email with gaps: only the gaps are filled, in place, as each comes; every other word stays", async ({ app: page, server }) => {
    await scenario("filled in place, one step, reviewed, undone exactly, filled again", async () => {
      await ready(page, server);
      fakeDraft.paceMs = 40;
      await openThread(page, /Contract review/);
      await page.keyboard.press("r");
      await put(page, "Hi Tom,\nWe can sign on [date we agreed] at {{place}}, as Ana said.\nLuis");
      const before = await body(page).innerHTML();
      // the Sparkles lights, named for the gaps
      await expect(page.getByTestId("compose-ai")).toHaveAttribute("data-ready", "true");
      await expect(page.getByTestId("compose-ai")).toHaveAccessibleName("Fill 2 gaps with AI");
      await page.keyboard.press(CMD_J);
      await expect(page.getByTestId("ai-row-status-text")).toHaveText("Filling 2 gaps…");
      // each fill shows where its gap is, as it comes, before anything is in the document
      await expect(page.getByTestId("compose-fill-stream").first()).toBeVisible();
      await expect(strip(page)).toBeVisible();
      await expect(strip(page)).toHaveAttribute("data-fill", "true");
      await expect(body(page)).toHaveText("Hi Tom,We can sign on filled date we agreed at filled place, as Ana said.Luis");
      await expect(page.getByTestId("compose-fill")).toHaveText(["filled date we agreed", "filled place"]);
      // a fill's rewrites: Fill again, never Shorter or Warmer (they'd rewrite the user's words)
      await expect(page.getByTestId("ai-strip-shorter")).toHaveCount(0);
      await expect(page.getByTestId("ai-strip-regenerate")).toHaveText("Fill again");
      await expect(page.getByTestId("ai-live")).toHaveText("Filled 2 gaps");
      await page.getByTestId("ai-strip-voice").click();
      await expect(page.getByTestId("ai-fill-pair")).toHaveText(["[date we agreed] → filled date we agreed", "{{place}} → filled place"]);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("ai-strip-undo")).toHaveAccessibleName("Undo: put the gaps back");
      await page.getByTestId("ai-strip-undo").click();
      expect(await body(page).innerHTML()).toBe(before);
      await expect(strip(page)).toHaveCount(0);
      await page.keyboard.press(CMD_J);
      await expect(page.getByTestId("compose-fill")).toHaveCount(2);
      await page.getByTestId("ai-strip-regenerate").click();
      await expect(page.getByTestId("ai-row-status-text")).toHaveText("Filling 2 gaps…");
      await expect(strip(page)).toBeVisible();
      await expect(body(page)).toHaveText("Hi Tom,We can sign on filled date we agreed at filled place, as Ana said.Luis");
      await page.getByTestId("ai-strip-undo").click();
      await page.getByTestId("ai-strip-undo").click();
      expect(await body(page).innerHTML()).toBe(before);
    });
    await scenario("a gap the conversation doesn't answer stays as typed, is said, and Send asks about it", async () => {
      await fresh(page, server);
      instant();
      await openThread(page, /Contract review/);
      await page.keyboard.press("r");
      await put(page, "Hi Tom,\nSee you [day] at [fake:empty].");
      await page.keyboard.press(CMD_J);
      await expect(strip(page)).toBeVisible();
      await expect(body(page)).toHaveText("Hi Tom,See you filled day at [fake:empty].");
      await expect(page.getByTestId("ai-strip-check")).toContainText("1 gap is as you wrote it: the conversation doesn’t say.");
      await expect(page.getByTestId("compose-gap")).toHaveText("[fake:empty]");
      await page.keyboard.press("ControlOrMeta+Enter");
      await expect(page.getByTestId("ai-gaps")).toBeVisible();
    });
    await scenario("Esc while it fills: what had finished goes in, the rest stays as typed", async () => {
      await fresh(page, server);
      fakeDraft.paceMs = 150;
      await openThread(page, /Contract review/);
      await page.keyboard.press("r");
      await put(page, "Hi Tom,\nSee you [day] at [a rather long place to fill in].");
      await page.keyboard.press(CMD_J);
      await expect(page.getByTestId("compose-fill-stream").nth(1)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(strip(page)).toHaveAttribute("data-stopped", "true");
      await expect(body(page)).toHaveText("Hi Tom,See you filled day at [a rather long place to fill in].");
    });
  });

  test("Settings: Drafting, an account's instructions, and Writing style's edit and reset; axe-clean in both modes", async ({ app: page, server }) => {
    const { accountId } = await ready(page, server);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-ai").click();
    await expect(page.getByTestId("ai-drafting")).toContainText("Learn from my sent mail");
    await page.getByTestId("ai-drafting-instructions").fill("Never use exclamation marks.");
    await page.getByTestId("ai-drafting-instructions").blur();
    await expect.poll(async () => ((await server.backend.server.invoke("writing.prefs.get", {}, dev)) as { global: { instructions: string } }).global.instructions).toBe("Never use exclamation marks.");
    expect((await new AxeBuilder({ page }).include("[data-testid=ai-drafting]").analyze()).violations).toEqual([]);

    // Writing style: in plain words, editable, and Reset takes it back
    await page.getByTestId("ai-drafting-style-open").click();
    await expect(page.getByTestId("writing-style")).toBeVisible();
    await expect(page.getByTestId("style-status")).toBeVisible();
    const profile = page.getByTestId("style-profile").first();
    // (learned from the demo mail by the real pass, which this page started)
    await expect(profile).toContainText(/Usually about \d+ words/, { timeout: 20_000 });
    await expect(page.getByTestId("style-status")).toContainText(/Learned from \d+ sent messages/, { timeout: 20_000 });
    expect((await new AxeBuilder({ page }).include("[data-testid=writing-style]").analyze()).violations).toEqual([]);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect((await new AxeBuilder({ page }).include("[data-testid=writing-style]").withRules(["color-contrast"]).analyze()).violations).toEqual([]);
    await page.emulateMedia({ colorScheme: "light" });
    const above = async (a: string, b: string) => (await page.getByTestId(a).boundingBox())!.y < (await page.getByTestId(b).boundingBox())!.y;
    // plan 161: its title is the page's; what it learned and how styles combine come first; one profile at a time
    await expect(page.getByTestId("settings-title")).toHaveText("Writing style");
    // pass 2: plain words that agree: the closest style wins, and a profile's count is part of the page's
    // pass 3: as your writing, never the recipient's voice
    // plan 162: a sequence, not an algorithm
    await expect(page.getByTestId("style-precedence")).toHaveText("A draft uses the closest style it has: the person, then their company, then the account, then yours.");
    // plan 162 (after ai162-r01): one job per group, in order: your style, Companies and People, How it learns, and
    // Start over on its own, last
    expect(await above("style-own", "style-domains")).toBe(true);
    expect(await above("style-domains", "style-actions")).toBe(true);
    expect(await above("style-actions", "style-start-over")).toBe(true);
    await expect(page.getByTestId("style-start-over").getByTestId("style-clear")).toBeVisible();
    // the count says what it counts, and the style shows what it does to a draft
    await expect(page.getByTestId("style-own")).toContainText(/From (the \d+ you wrote in \w+|\d+ of the \d+ messages|\d+ messages?)/);
    // plan 162 (after ai162-r02): the habits are said once (a sample box repeated them, 120 px)
    await expect(page.getByTestId("style-sample")).toHaveCount(0);
    await expect(page.getByTestId("style-own")).toContainText("Your style");
    expect(await above("style-status", "style-own")).toBe(true);
    await expect(page.getByTestId("style-profile")).toHaveCount(1);
    if (await page.getByTestId("style-scope").count()) {
      // plan 162 (after ai162-r02): Esc on Style for's open menu closes the menu and stays on the page (it left)
      await page.getByTestId("style-scope").click();
      await expect(page.getByRole("listbox")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(page.getByTestId("writing-style")).toBeVisible();
      // under the picker, the card doesn't name the profile again
      const first = await page.getByTestId("style-scope").innerText();
      await expect(page.getByTestId("style-profile-title")).not.toContainText(first.split(" · ")[0]!);
      await page.getByTestId("style-scope").click();
      await page.getByRole("option").nth(1).click();
      await expect(page.getByTestId("style-scope")).not.toHaveText(first);
      await page.getByTestId("style-scope").click();
      await page.getByRole("option").first().click();
    }
    // the editor: its first field focused, a sign-off kept whole, Save in view in a small window, focus back on Edit
    await page.setViewportSize({ width: 1100, height: 700 });
    await profile.getByTestId("style-profile-edit").click();
    await expect(page.getByTestId("style-editor").locator("textarea").first()).toBeFocused();
    // pass 2: the focused field is on screen, not above the view
    await expect(page.getByTestId("style-editor").locator("textarea").first()).toBeInViewport();
    await page.getByTestId("style-edit-signoffs-add").click();
    await page.getByTestId("style-edit-signoffs-field").last().fill("Cheers,\nLuis");
    await page.getByTestId("style-edit-phrases").fill("all the best\nlet me know");
    await expect(page.getByTestId("style-edit-save")).toBeInViewport();
    // the picker waits while a profile is edited (Codex review): switching would lose the edit
    if (await page.getByTestId("style-scope").count()) await expect(page.getByTestId("style-scope")).toBeDisabled();
    await page.getByTestId("style-edit-save").click();
    await expect(profile.getByTestId("style-profile-edited")).toBeVisible();
    await expect(profile.getByTestId("style-profile-edit")).toBeFocused();
    await profile.getByTestId("style-profile-examples-toggle").click();
    await expect(profile.getByTestId("style-profile-examples")).toContainText("“all the best”");
    // pass 2: a learned phrase can be removed where it's listed. Codex review: two quick removals both stick, and the page's
    // lists follow, so leaving and coming back doesn't bring one back
    const phrase = (text: string) => profile.getByTestId("style-profile-phrase").filter({ hasText: `“${text}”` });
    await phrase("let me know").getByTestId("style-profile-example-remove").click();
    await phrase("all the best").getByTestId("style-profile-example-remove").click();
    await expect(phrase("let me know")).toHaveCount(0);
    await expect(phrase("all the best")).toHaveCount(0);
    // another profile in the picker, then back: what was removed stays removed
    if (await page.getByTestId("style-scope").count()) {
      await page.getByTestId("style-scope").click();
      await page.getByRole("option").nth(1).click();
      await page.getByTestId("style-scope").click();
      await page.getByRole("option").first().click();
    }
    // the edit had left only those two: none left, so nothing to open
    await expect(profile.getByTestId("style-profile-lines")).toBeVisible();
    await expect(profile.getByTestId("style-profile-examples-toggle")).toHaveCount(0);
    // Codex review: a changed editor survives an Esc from elsewhere on the page, and the back button asks too
    await profile.getByTestId("style-profile-edit").click();
    await page.getByTestId("style-edit-phrases").fill("talk soon");
    await page.getByTestId("style-rebuild").focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("style-discard-dialog")).toBeVisible();
    await page.getByTestId("style-discard-dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("style-edit-phrases")).toHaveValue("talk soon");
    await expect(page.getByTestId("writing-style")).toBeVisible();
    await page.getByTestId("writing-style-back").click();
    await expect(page.getByTestId("style-discard-dialog")).toBeVisible();
    await page.getByTestId("style-discard-dialog").getByRole("button", { name: "Discard" }).click();
    await expect(page.getByTestId("writing-style")).toHaveCount(0);
    await page.getByTestId("ai-drafting-style-open").click();
    await expect(profile.getByTestId("style-profile-lines")).toBeVisible();
    await expect(phrase("let me know")).toHaveCount(0);
    await expect(phrase("all the best")).toHaveCount(0);
    await profile.getByTestId("style-profile-edit").click();
    await expect(page.getByTestId("style-edit-signoffs-field").last()).toHaveValue("Cheers,\nLuis");
    // pass 3: Esc steps back out of the editor, not out of Settings: unchanged, at once, focus back on Edit
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("style-editor")).toHaveCount(0);
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await expect(profile.getByTestId("style-profile-edit")).toBeFocused();
    // with a change it asks; Cancel keeps the typing, Discard drops it
    await profile.getByTestId("style-profile-edit").click();
    await page.getByTestId("style-edit-phrases").fill("talk soon");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("style-discard-dialog")).toBeVisible();
    await page.getByTestId("style-discard-dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("style-discard-dialog")).toHaveCount(0);
    await expect(page.getByTestId("style-edit-phrases")).toHaveValue("talk soon");
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.getByTestId("style-edit-phrases").focus();
    await page.keyboard.press("Escape");
    await page.getByTestId("style-discard-dialog").getByRole("button", { name: "Discard" }).click();
    await expect(page.getByTestId("style-editor")).toHaveCount(0);
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await expect(profile.getByTestId("style-profile-examples-toggle")).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Reset says so, and Undo puts back exactly what was there, the edit too
    await profile.getByTestId("style-profile-reset").click();
    await expect(page.getByTestId("style-reset-done")).toContainText("Reset “You");
    await expect(page.getByTestId("style-profile-edited")).toHaveCount(0);
    // in the page, not a snack behind Settings (Codex review)
    await page.getByTestId("style-reset-undo").click();
    await expect(page.getByTestId("style-profile-edited")).toBeVisible();
    await expect(page.getByTestId("style-reset-done")).toHaveCount(0);
    await page.getByTestId("style-profile-reset").click();
    await expect(page.getByTestId("style-profile-edited")).toHaveCount(0);

    // pass 2: Companies is a list of one-line profiles, one open at a time
    await page.getByTestId("style-domains-toggle").click();
    const companies = page.getByTestId("style-domains").getByTestId("style-profile-toggle");
    await expect(companies.first()).toBeVisible({ timeout: 20_000 });
    if ((await companies.count()) >= 2) {
      await companies.nth(0).click();
      await expect(page.getByTestId("style-domains").getByTestId("style-profile-lines")).toHaveCount(1);
      await companies.nth(1).click();
      await expect(page.getByTestId("style-domains").getByTestId("style-profile-lines")).toHaveCount(1);
      await expect(companies.nth(0)).toHaveAttribute("aria-expanded", "false");
      // Codex review: while one is edited, another can't open over it and lose the edit
      await page.getByTestId("style-domains").getByTestId("style-profile-edit").click();
      await expect(companies.nth(0)).toBeDisabled();
      await page.getByTestId("style-edit-cancel").click();
      await expect(companies.nth(0)).toBeEnabled();
    }
    // Codex review, round 2: Your style's editor and a company's can be open at once; closing the first leaves the second
    // guarded, so a changed company edit still asks before Esc from elsewhere drops it
    if ((await companies.first().getAttribute("aria-expanded")) !== "true") await companies.first().click();
    const domains = page.getByTestId("style-domains");
    await domains.getByTestId("style-profile-edit").click();
    await domains.getByTestId("style-edit-phrases").fill("talk soon");
    await profile.getByTestId("style-profile-edit").click();
    await expect(profile.getByTestId("style-editor")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(profile.getByTestId("style-editor")).toHaveCount(0);
    await page.getByTestId("style-rebuild").focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("style-discard-dialog")).toBeVisible();
    await page.getByTestId("style-discard-dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(domains.getByTestId("style-edit-phrases")).toHaveValue("talk soon");
    await domains.getByTestId("style-edit-cancel").click();
    await expect(domains.getByTestId("style-editor")).toHaveCount(0);
    // Codex review: one open across Companies and People
    await page.getByTestId("style-people-toggle").click();
    const people = page.getByTestId("style-people").getByTestId("style-profile-toggle");
    if (await people.first().isVisible({ timeout: 10_000 }).catch(() => false)) {
      await people.first().click();
      await expect(page.getByTestId("style-domains").getByTestId("style-profile-lines")).toHaveCount(0);
      await expect(page.getByTestId("style-people").getByTestId("style-profile-lines")).toHaveCount(1);
    }
    await page.getByTestId("style-people-toggle").click();
    await page.getByTestId("style-domains-toggle").click();

    // the study is running, not done, when it starts (Codex review 12); it asks nothing on any provider (plan 131)
    await page.getByTestId("style-study-start").click();
    await expect(page.getByTestId("style-study-running")).toContainText(/\d+ of \d+/);
    await page.getByTestId("style-study-stop").click();
    await expect(page.getByTestId("style-study-start")).toBeVisible();
    // plan 162 (after ai162-r01): done, it says where its result is and goes there: Phrases and notes, open, with the keys
    await page.getByTestId("style-study-start").click();
    await expect(page.getByTestId("style-study-done")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("style-study-show").click();
    await expect(page.getByTestId("style-profile-examples-toggle")).toBeFocused();
    await expect(page.getByTestId("style-profile-examples")).toBeVisible();
    // Codex review: the profile opened is the one holding the study's notes
    await expect(page.getByTestId("style-profile-examples").getByTestId("style-profile-note").first()).toBeAttached();

    // pass 3: Esc on the page goes back to Drafting, focus on the way in; Settings stays
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("writing-style")).toHaveCount(0);
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await expect(page.getByTestId("ai-drafting-style-open")).toBeFocused();
    await page.getByTestId("ai-drafting-style-open").click();
    await page.getByTestId("writing-style-back").click();
    await expect(page.getByTestId("ai-tab")).toBeVisible();
    await expect(page.getByTestId("ai-drafting-instructions")).toHaveValue("Never use exclamation marks.");

    // an account's own, after its signature
    await page.getByTestId("tab-accounts").click();
    await page.getByTestId("account-toggle").first().click();
    const own = page.getByTestId("account-writing-instructions");
    await expect(own).toBeVisible();
    const signature = (await page.getByTestId("account-signature").boundingBox())!;
    expect((await own.boundingBox())!.y).toBeGreaterThan(signature.y);
    await own.fill("Exclamation marks are fine here.");
    // straight to the switch: the blur's save and the switch's must not overwrite each other (Codex review 4)
    await page.getByTestId("account-writing-general").click();
    await expect.poll(async () => ((await server.backend.server.invoke("writing.prefs.get", {}, dev)) as { accounts: Record<string, { useGeneral?: boolean; instructions?: string }> }).accounts[String(accountId)]).toEqual({ instructions: "Exclamation marks are fine here.", useGeneral: false });
  });

  test("plan 161: the strip after an edit, its exact Undo, the Write button, and a small window", async ({ app: page, server }) => {
    const lastLineClear = () => page.evaluate(() => {
      const last = [...document.querySelectorAll("[data-testid=compose-body] p")].filter((p) => p.textContent).at(-1)!.getBoundingClientRect();
      const foot = document.querySelector("[data-draft-foot]")!.getBoundingClientRect();
      return { last: Math.round(last.bottom), foot: Math.round(foot.top), scrolled: document.querySelector("[data-reader-scroller]")!.scrollTop };
    });
    await scenario("plan 163: the empty body says what to do; the Sparkles does what ⌘J does", async () => {
      await ready(page, server);
      instant();
      await openThread(page, /Contract review/);
      await openField(page);
      expect(await body(page).evaluate((el) => getComputedStyle(el, "::before").content)).toMatch(/Write the reply, or what it should say, then press/);
      await body(page).fill("echo: Thanks, that works.");
      await page.getByTestId("compose-ai").click();
      await expect(strip(page)).toBeVisible();
      await expect(body(page)).toHaveText("Thanks, that works.");
    });
    await scenario("a status and four buttons: the commands have a resting shape at 28 px; the status has none (pass 2: it opens what the AI used)", async () => {
      await expect(page.getByTestId("ai-strip-written")).toHaveText("Written with AI");
      expect(await page.getByTestId("ai-strip-voice").evaluate((el) => getComputedStyle(el).borderTopColor)).toBe("rgba(0, 0, 0, 0)");
      // plan 162: the four are one group at 28 px, its 1 px edge at rest (not only on hover), each command filling it
      const group = page.getByTestId("ai-strip-commands");
      expect((await group.boundingBox())!.height).toBeGreaterThanOrEqual(28);
      expect(await group.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("1px");
      for (const id of ["ai-strip-regenerate", "ai-strip-shorter", "ai-strip-warmer", "ai-strip-undo"]) {
        const button = (await page.getByTestId(id).boundingBox())!;
        expect(button.height, id).toBeGreaterThanOrEqual((await group.boundingBox())!.height - 2);
      }
    });
    await scenario("an edit keeps the strip, as Edited after AI, with no jump", async () => {
      const before = (await body(page).boundingBox())!.y;
      await body(page).click();
      await page.keyboard.press("ControlOrMeta+ArrowDown");
      await page.keyboard.type(" Mine.");
      await expect(page.getByTestId("ai-strip-written")).toHaveText("Edited after AI");
      await expect(page.getByTestId("ai-strip-undo")).toBeVisible();
      expect((await body(page).boundingBox())!.y).toBe(before);
    });
    await scenario("Undo then restores the draft exactly as it was before ⌘J; the snack's Undo brings the edit back", async () => {
      await page.getByTestId("ai-strip-undo").click();
      // plan 163: before ⌘J, the body held what was asked
      await expect(body(page)).toHaveText("echo: Thanks, that works.");
      await expect(strip(page)).toHaveCount(0);
      await expect(page.getByTestId("snack")).toContainText("Back to before the AI draft");
      await page.getByTestId("snack-action").click();
      await expect(body(page)).toHaveText("Thanks, that works. Mine.");
      await expect(page.getByTestId("ai-strip-written")).toHaveText("Edited after AI");
    });
    await scenario("1100x700: the strip keeps its status, and the written draft and Send are in view", async () => {
      await fresh(page, server);
      await page.setViewportSize({ width: 1100, height: 700 });
      fakeDraft.text = () => "Friday works for me.\n\nCould you send the address of the flat, and say whether parking is near?\n\nThanks,\n\nLuis";
      await openThread(page, /Contract review/);
      await openField(page);
      await ask(page, "friday works, ask him to send the address of the flat and say whether parking is near");
      await expect(strip(page)).toBeVisible();
      await expect(page.getByTestId("ai-strip-written")).toBeVisible();
      expect(await page.getByTestId("ai-strip-written").evaluate((s) => s.scrollWidth <= s.clientWidth)).toBe(true);
      // the draft's last line clears the composer's sticky foot: written, it's all there to read without a scroll
      await expect.poll(async () => { const r = await lastLineClear(); return r.last <= r.foot ? true : JSON.stringify(r); }).toBe(true);
      await expect(page.getByTestId("compose-send")).toBeInViewport();
    });
    await scenario("written at a large size, then the window shrinks: the draft is kept in view", async () => {
      await fresh(page, server);
      await page.setViewportSize({ width: 1440, height: 900 });
      await openThread(page, /Contract review/);
      fakeDraft.text = () => "One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.\n\nThanks,\n\nLuis";
      await openField(page);
      await ask(page, "tell him one to five");
      await expect(strip(page)).toBeVisible();
      await page.setViewportSize({ width: 1100, height: 700 });
      await expect.poll(async () => { const r = await lastLineClear(); return r.last <= r.foot ? true : JSON.stringify(r); }).toBe(true);
    });
    await scenario("Codex review 5: scrolled up to read, with the composer below the window, a resize leaves the reader where it is", async () => {
      const scroller = page.locator("[data-reader-scroller]");
      await page.setViewportSize({ width: 1100, height: 220 });
      await page.waitForTimeout(250);
      await scroller.evaluate((el) => { el.scrollTop = 0; });
      // its top is below the window: not on screen, so not followed
      expect(await page.getByTestId("composer").evaluate((el) => el.getBoundingClientRect().top >= el.closest("[data-reader-scroller]")!.getBoundingClientRect().bottom)).toBe(true);
      await page.setViewportSize({ width: 1100, height: 210 });
      await page.waitForTimeout(250);
      expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
    });
  });

  test("plan 162: the instruction on one line with Edit right after it, the four commands one group at every width, folded when narrow; nothing in its menus clipped", { tag: "@design" }, async ({ app: page, server }) => {
    await ready(page, server);
    instant();
    await openThread(page, /Contract review/);
    await openField(page);
    const words = "echo: Friday works for me, ask him to send the address of the flat";
    await body(page).fill(words);
    await page.keyboard.press(CMD_J);
    await expect(strip(page)).toBeVisible();
    const box = async (id: string) => (await page.getByTestId(id).boundingBox())!;
    const middle = async (id: string) => { const b = await box(id); return b.y + b.height / 2; };
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const size of [{ width: 1440, height: 900 }, { width: 1100, height: 700 }]) {
        await page.setViewportSize(size);
        const where = `${scheme} ${size.width}`;
        // plan 163: no instruction line: what was asked is in the provenance's popover, the strip one line at every width
        await expect(page.getByTestId("ai-strip-instruction"), where).toHaveCount(0);
        // the four commands are one group (one chrome, none heavier), on the provenance's line
        await expect(page.getByTestId("ai-strip-commands"), where).toHaveAttribute("data-slot", "button-group");
        await expect(page.getByTestId("ai-strip-undo"), where).toHaveText("Undo");
        await expect(page.getByTestId("ai-strip-undo"), where).toHaveAccessibleName("Undo: remove the AI’s draft");
        await expect.poll(async () => Math.abs((await middle("ai-strip-undo")) - (await middle("ai-strip-voice"))), where).toBeLessThanOrEqual(1);
        expect((await box("ai-row")).height, where).toBeLessThanOrEqual(40);
        const wide = size.width === 1440;
        // plan 162 (after ai162-r01): Regenerate stays direct at every width; narrow, Shorter and Warmer fold into Rewrite ▾
        await expect(page.getByTestId("ai-strip-regenerate"), where).toBeVisible();
        await expect(page.getByTestId("ai-strip-shorter"), where).toBeVisible({ visible: wide });
        await expect(page.getByTestId("ai-strip-rewrite"), where).toBeVisible({ visible: !wide });
        if (!wide) {
          await page.getByTestId("ai-strip-rewrite").click();
          await expect(page.getByTestId("ai-strip-rewrite-menu").getByRole("menuitem")).toHaveText(["Shorter", "Warmer"]);
          expect(await unclipped(page.getByTestId("ai-strip-rewrite-menu")), where).toEqual([]);
          await page.keyboard.press("Escape");
        }
        await page.getByTestId("ai-strip-voice").click();
        expect(await unclipped(page.getByTestId("ai-voice-popover")), where).toEqual([]);
        await page.keyboard.press("Escape");
      }
    }
    // plan 162 (after ai162-r02): a rewrite picked from the narrow menu gives the keys to the draft, and Undo says what it
    // takes back; its Undo gives them to the draft too (they were left on the menu's trigger, then on <body>)
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.getByTestId("ai-strip-rewrite").click();
    await page.getByTestId("ai-strip-rewrite-shorter").click();
    await expect(page.getByTestId("ai-strip-undo")).toHaveAccessibleName("Undo Shorter");
    await expect(body(page)).toBeFocused();
    await page.getByTestId("ai-strip-undo").click();
    await expect(page.getByTestId("ai-strip-undo")).toHaveAccessibleName("Undo: remove the AI’s draft");
    await expect(body(page)).toBeFocused();
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1440, height: 900 });
    // the group's items share one look: the same ink and no edge of their own (the group draws it)
    const style = (id: string) => page.getByTestId(id).evaluate((el) => { const s = getComputedStyle(el); return { color: s.color, weight: s.fontWeight, height: el.getBoundingClientRect().height }; });
    expect(await style("ai-strip-regenerate")).toEqual(await style("ai-strip-undo"));
    // plan 163: what was asked, in the popover, with an icon-only pencil (the owner, 2026-11-08: the worded button was
    // "way too big"), which turns it into a field named for what it holds
    await page.getByTestId("ai-strip-voice").click();
    await expect(page.getByTestId("ai-asked-text")).toHaveText(`From your words: “${words}”`);
    const pencil = page.getByTestId("ai-asked-edit");
    await expect(pencil).toHaveAccessibleName("Edit what you asked");
    await expect(pencil).toHaveText("");
    expect((await pencil.boundingBox())!.width).toBeLessThanOrEqual(28);
    await pencil.click();
    await expect(page.getByTestId("ai-asked-input")).toHaveValue(words);
    await expect(page.getByTestId("ai-asked-input")).toHaveAccessibleName("What you asked");
    await expect(page.getByTestId("ai-asked-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ai-asked-text")).toBeVisible();
  });

  test("plan 161, pass 2: nothing the user wrote is lost, the instruction stays", async ({ app: page, server }) => {
    await scenario("plan 163: words typed in the body are never lost: written up, they're one Undo away", async () => {
      await ready(page, server);
      instant();
      await openThread(page, /Contract review/);
      await openField(page);
      await ask(page, "echo: Friday works for me, tell him that");
      await expect(strip(page)).toBeVisible();
      await page.getByTestId("ai-strip-voice").click();
      await expect(page.getByTestId("ai-asked-text")).toHaveText("From your words: “echo: Friday works for me, tell him that”");
      await expect(page.getByTestId("ai-voice-label")).toHaveText(/^In your /);
      await page.keyboard.press("Escape");
    });
    await scenario("what was asked, edited in the popover, writes the draft again from the new words", async () => {
      await page.getByTestId("ai-strip-voice").click();
      await page.getByTestId("ai-asked-edit").click();
      await page.getByTestId("ai-asked-input").fill("echo: Saturday works better, tell him that");
      await page.keyboard.press("Enter");
      await expect(body(page)).toHaveText("Saturday works better, tell him that");
      await page.getByTestId("ai-strip-voice").click();
      await expect(page.getByTestId("ai-asked-text")).toHaveText(/Saturday works better/);
      await page.keyboard.press("Escape");
    });
    await scenario("Undo of the rewrite goes back one version", async () => {
      await page.getByTestId("ai-strip-undo").click();
      await expect(body(page)).toHaveText("Friday works for me, tell him that");
      await expect(strip(page)).toBeVisible();
    });
    await scenario("Regenerate over an edit asks first: Keep editing leaves it; Replace replaces, and Undo brings the edit back", async () => {
      await body(page).click();
      await page.keyboard.press("ControlOrMeta+ArrowDown");
      await page.keyboard.type(" Mine.");
      await expect(page.getByTestId("ai-strip-written")).toHaveText("Edited after AI");
      await page.getByTestId("ai-strip-regenerate").click();
      await expect(page.getByTestId("ai-confirm-text")).toHaveText("Replace your edits?");
      await expect(page.getByTestId("ai-confirm-replace")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("ai-confirm")).toHaveCount(0);
      await expect(body(page)).toHaveText("Friday works for me, tell him that Mine.");
      await expect(page.getByTestId("composer")).toBeVisible();
      await page.getByTestId("ai-strip-shorter").click();
      await page.getByTestId("ai-confirm-keep").click();
      await expect(body(page)).toHaveText("Friday works for me, tell him that Mine.");
      await page.getByTestId("ai-strip-regenerate").click();
      await page.getByTestId("ai-confirm-replace").click();
      await expect(page.getByTestId("ai-strip-written")).toHaveText("Written with AI");
      await expect(body(page)).toHaveText("Friday works for me, tell him that");
      await page.getByTestId("ai-strip-undo").click();
      await expect(body(page)).toHaveText("Friday works for me, tell him that Mine.");
    });
    await scenario("a rewrite keeps the old text on screen, dimmed, until the new one is in", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await openField(page);
      await body(page).fill("echo: Friday works for me.");
      await page.keyboard.press(CMD_J);
      await expect(strip(page)).toBeVisible();
      fakeDraft.firstTokenMs = 1500;
      fakeDraft.paceMs = 60;
      await page.getByTestId("ai-strip-shorter").click();
      await expect(page.getByTestId("ai-row-status-text")).toHaveText("Rewriting…");
      await expect(body(page)).toHaveText("Friday works for me.");
      await expect(body(page)).toBeVisible();
      const opacity = await page.locator("[data-ai-overlay=rewriting] > [data-editor-mount]").evaluate((el) => getComputedStyle(el).opacity);
      expect(Number(opacity)).toBeGreaterThan(0.4);
      expect(Number(opacity)).toBeLessThan(1);
      // never the stream drawn over it
      await expect(preview(page)).toHaveCount(0);
      instant();
      await expect(strip(page)).toBeVisible({ timeout: 15_000 });
      await expect(page.locator("[data-ai-overlay]")).toHaveCount(0);
    });
  });

  test("en and es: the row, status and strip follow the language", async ({ app: page, server }) => {
    await ready(page, server);
    await server.backend.server.invoke("settings.update", { language: "es" }, dev);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await rows(page).first().waitFor();
    await openThread(page, /Contract review/);
    await openField(page);
    expect(await body(page).evaluate((el) => getComputedStyle(el, "::before").content)).toMatch(/Escribe la respuesta, o lo que debe decir, y pulsa/);
    await page.keyboard.press(CMD_J);
    await expect(row(page).locator("label")).toHaveText("IA");
    await expect(page.getByTestId("ai-row-status-text")).toHaveText("Escribiendo…");
    await expect(strip(page)).toContainText("Escrito con IA");
    await expect(strip(page)).toContainText("Regenerar");
  });

  // ── looked at: frames during the stream and across the commit (AI_DRAFT_FRAMES=1), in each project's design
  test("frames", async ({ app: page, server, design }) => {
    test.skip(!process.env.AI_DRAFT_FRAMES, "only when looking");
    test.setTimeout(120_000);
    await ready(page, server);
    // slower than a real model: each screenshot takes a moment, and the frames should show the stream on its way
    fakeDraft.firstTokenMs = 900;
    fakeDraft.paceMs = 160;
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await stabilize(page);
      await openThread(page, /Contract review/);
      await openField(page);
      await body(page).fill("say that this is just fine");
      await shot(page, `${theme}-1-row`, design);
      await page.keyboard.press(CMD_J);
      await expect(page.getByTestId("ai-row-status")).toBeVisible();
      await shot(page, `${theme}-2-writing`, design);
      await streaming(page);
      await shot(page, `${theme}-3-stream-early`, design);
      await expect(page.getByTestId("ai-preview-text")).toContainText("I read through");
      await shot(page, `${theme}-4-stream-mid`, design);
      await expect(strip(page)).toBeVisible();
      await shot(page, `${theme}-5-committed`, design);
      await page.getByTestId("ai-strip-voice").click();
      await page.getByTestId("ai-voice-popover").waitFor();
      await shot(page, `${theme}-6-popover`, design);
      await page.keyboard.press("Escape");
      await page.getByTestId("compose-discard").click();
    }
    await page.emulateMedia({ colorScheme: "light" });
  });

  test("frames across a commit, as fast as they can be taken, of the card alone", async ({ app: page, server, design }) => {
    test.skip(!process.env.AI_DRAFT_FRAMES, "only when looking");
    test.setTimeout(120_000);
    await ready(page, server);
    fakeDraft.firstTokenMs = 200;
    fakeDraft.paceMs = 70;
    await openThread(page, /Contract review/);
    await openField(page);
    await body(page).fill("say that this is just fine");
    await page.keyboard.press(CMD_J);
    mkdirSync(SHOTS, { recursive: true });
    const card = page.getByTestId("draft-slot");
    let n = 0;
    while (n < 40) {
      const up = await strip(page).count();
      await card.screenshot({ path: `${SHOTS}/${design ?? "lumen"}-burst-${String(n++).padStart(2, "0")}${up ? "-strip" : ""}.png`, animations: "allow", caret: "initial" });
      if (up) break;
    }
  });

  test("frames of every other state", async ({ app: page, server, design }) => {
    test.skip(!process.env.AI_DRAFT_FRAMES, "only when looking");
    test.setTimeout(180_000);
    await ready(page, server);
    fakeDraft.firstTokenMs = 100;
    fakeDraft.paceMs = 100;
    const tag = async (name: string) => {
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await stabilize(page);
        await shot(page, `state-${name}-${theme}`, design);
      }
      await page.emulateMedia({ colorScheme: "light" });
    };
    const reset = async () => {
      if (await page.getByTestId("compose-discard").count()) await page.getByTestId("compose-discard").first().click();
      await page.keyboard.press("Escape");
    };
    // a question, on the row
    await openThread(page, /Studio lunch/);
    await openField(page);
    await body(page).fill("tell tom that this is just fine");
    await page.keyboard.press(CMD_J);
    await page.getByTestId("ai-question").waitFor();
    await tag("question");
    await page.keyboard.press("Escape");
    // notes, ending in the choice
    await openThread(page, /Contract review/);
    await page.keyboard.press("r");
    await expect(body(page)).toBeFocused();
    await page.keyboard.type("Hi Tom,\nfine with the 19th, signing after");
    await tag("notes-field");
    fakeDraft.paceMs = 20;
    await page.keyboard.press(CMD_J);
    await page.getByTestId("ai-choice").waitFor();
    await tag("notes-choice");
    // a send stopped at it
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.getByTestId("ai-guard").waitFor();
    await tag("guard");
    await page.getByTestId("ai-guard-keep").click();
    await page.getByTestId("ai-choice-discard").click();
    // typed during the stream
    fakeDraft.paceMs = 100;
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await openField(page);
    await body(page).fill("say that this is just fine");
    await page.keyboard.press(CMD_J);
    await streaming(page);
    await page.keyboard.type("my own words first");
    await tag("typing-mid-stream");
    await page.getByTestId("ai-choice").waitFor();
    await addRecipients(page, "compose-to", "rosa@faraway.example");
    await tag("typed-choice");
    await page.getByTestId("ai-choice-discard").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    // a failure, with what came kept
    await openField(page);
    await body(page).fill("tell him it drops [fake:fail:8]");
    fakeDraft.paceMs = 20;
    await page.keyboard.press(CMD_J);
    await page.getByTestId("ai-error").waitFor();
    await tag("error-partial");
    await page.getByTestId("ai-error-close").click();
    // the check line
    fakeDraft.text = () => "See you on 19 March at [time].";
    await openField(page);
    await body(page).fill("say see you");
    await page.keyboard.press(CMD_J);
    await strip(page).waitFor();
    await tag("strip-check");
    // refining: the old text gives way as the new comes
    fakeDraft.text = () => DRAFT;
    fakeDraft.paceMs = 100;
    await page.getByTestId("ai-strip-regenerate").click();
    await streaming(page);
    await tag("refining");
    await page.keyboard.press("Escape");
    // pinned
    await page.getByTestId("ai-strip-undo").click();
    await openField(page);
    await page.keyboard.press(CMD_J);
    await streaming(page);
    await page.getByTestId("compose-pin").click();
    await page.getByTestId("pinned-draft").getByTestId("ai-preview-text").waitFor();
    await tag("pinned-stream");
    await page.getByTestId("pinned-draft").getByTestId("ai-strip").waitFor();
    await tag("pinned-strip");
    await page.getByTestId("compose-unpin").click();
    await reset();
    // Settings
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-ai").click();
    await page.getByTestId("ai-drafting").scrollIntoViewIfNeeded();
    await tag("settings-drafting");
    await page.getByTestId("ai-drafting-style-open").click();
    await expect(page.getByTestId("style-profile").first()).toBeVisible();
    await tag("settings-style");
    await page.getByTestId("style-profile-edit").first().click();
    await tag("settings-style-edit");
  });
});
