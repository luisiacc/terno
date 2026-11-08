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
const field = (page: Page) => page.getByTestId("ai-row-input");
const body = (page: Page) => page.getByTestId("compose-body").first();
const preview = (page: Page) => page.getByTestId("ai-preview");
const strip = (page: Page) => page.getByTestId("ai-strip");
const CMD_J = "ControlOrMeta+j";

async function shot(page: Page, name: string, design: string | null) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${design ?? "lumen"}-${name}.png` });
}

/** ⌘J, and the field has focus: a person's next key lands in it. */
async function openField(page: Page) {
  await page.keyboard.press(CMD_J);
  await expect(field(page)).toBeFocused();
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
    const frame = () => {
      const preview = lines(document.querySelector("[data-testid=ai-preview-text]"));
      const body = lines(document.querySelector("[data-testid=compose-body]"));
      if (preview.length && body.length) out.both = true;
      if (preview.length) { out.preview = preview; out.previewForm = form(); }
      if (body.length) { out.body = body; out.bodyForm = form(); return; }
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
  test("the commit moves nothing, on both paths", async ({ app: page, server, design }) => {
    await scenario("⌘J from a conversation: the row, the stream in the body's place, one commit that moves nothing, the strip", async () => {
      await ready(page, server);
      await openThread(page, /Contract review/);
      await openField(page);
      await expect(field(page)).toBeFocused();
      await expect(page.getByTestId("composer")).toBeVisible();

      // lined up with its neighbours: the label on To's, the text on To's content line
      const labels = page.locator("[data-testid=composer] label");
      const toLabel = await labels.first().boundingBox();
      const aiLabel = await row(page).locator("label").boundingBox();
      expect(aiLabel!.x).toBe(toLabel!.x);
      const toField = await page.locator("[data-recipient-field=compose-to]").boundingBox();
      // on To's value line: its field reaches 6 px further left, for the chips' pills (plan 158)
      expect((await field(page).boundingBox())!.x).toBe(toField!.x + 6);
      await expect(row(page)).toHaveCSS("min-height", "38px");

      const commit = await recordCommit(page);
      fakeDraft.paceMs = 60;
      await field(page).fill("say that this is just fine");
      await page.keyboard.press("Enter");
      // focus goes back to the text, which stays editable; the row says what's happening
      await expect(body(page)).toBeFocused();
      await expect(page.getByTestId("ai-row-status-text")).toHaveText("Writing…");
      await expect(page.getByTestId("ai-live")).toHaveText("Writing draft");
      await streaming(page);

      // not in the document, nor saved
      expect(await body(page).textContent()).toBe("");
      await expect(preview(page)).toHaveAttribute("data-mode", "overlay");
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

      // one undo step, autosaved like typing
      await page.getByTestId("ai-strip-undo").click();
      await expect(strip(page)).toHaveCount(0);
      await expect(body(page)).toHaveText("");
      await expect(body(page)).toBeFocused();
      // nothing was there before: no blank draft stays in the list, and writing still saves
      const saved = async () => ((await server.backend.server.invoke("drafts.list", {}, dev)) as { bodyText: string }[]).map((d) => d.bodyText);
      await expect.poll(saved).toEqual([]);
      await body(page).pressSequentially("my own words");
      await expect.poll(saved).toEqual(["my own words"]);
      expect(design === null || typeof design === "string").toBe(true);
    });
    await scenario("the check line goes under the text: on the one-tap path, nothing moves at commit either", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await openField(page);
      const commit = await recordCommit(page);
      fakeDraft.paceMs = 60;
      await page.keyboard.press("Enter");
      await streaming(page);
      await expect(strip(page)).toBeVisible();
      const seen = await commit();
      for (const [i, line] of seen.preview.entries()) expect(seen.body[i]!.top, line.text).toBe(line.top);
      await expect(page.getByTestId("ai-strip-check")).toContainText("Written from the conversation alone");
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
    await page.keyboard.press("Enter");
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
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("ai-row-status-text")).toHaveText("Writing…");
    // the clock also runs in real time: well short of 8 s here, so a loaded machine's seconds don't reach it
    await page.clock.fastForward(4_000);
    await expect(page.getByTestId("ai-row-status-text")).toHaveText("Writing…");
    await page.clock.fastForward(4_000);
    // at once, for the same reason: a longer wait would pass a slower timer
    await expect(page.getByTestId("ai-row-status-text")).toHaveText("Loading the model…", { timeout: 600 });
    await page.getByTestId("ai-row-stop").click();
    await expect(row(page)).toHaveCount(0);
  });

  test("the row with an instant model: its ways in and out, your notes, a question, a send, a failure", async ({ app: page, server }) => {
    await scenario("the palette reaches it: from a conversation, and in a draft", async () => {
      await ready(page, server);
      instant();
      await openThread(page, /Contract review/);
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByTestId("palette-ai-draft").click();
      await expect(field(page)).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("composer")).toHaveCount(0);
      await page.keyboard.press("r");
      await expect(body(page)).toBeFocused();
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByTestId("palette-draft-ai").click();
      await expect(field(page)).toBeFocused();
    });
    await scenario("plan 161: in the pinned card's width the strip keeps its status, and its commands wrap under it", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await openField(page);
      await field(page).fill("say that this is just fine");
      await page.keyboard.press("Enter");
      await strip(page).waitFor();
      await page.getByTestId("compose-pin").click();
      const card = page.getByTestId("pinned-draft");
      await expect(card.getByTestId("ai-strip")).toBeVisible();
      await expect(card.getByTestId("ai-strip-written")).toBeVisible();
      await expect(card.getByTestId("ai-strip-written")).toHaveText("Written with AI");
      // two lines at most: the status, then the commands
      expect((await card.getByTestId("ai-row").boundingBox())!.height).toBeLessThanOrEqual(80);
    });
    await scenario("Enter with nothing typed is the one-tap draft; ↑ recalls the last instruction; Esc closes and the empty reply goes", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await page.getByTestId("quick-ai").click();
      await expect(field(page)).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(strip(page)).toBeVisible();
      await expect(page.getByTestId("ai-strip-check")).toContainText("Written from the conversation alone");

      await page.getByTestId("ai-strip-undo").click();
      await openField(page);
      await field(page).fill("echo: fine by me");
      await page.keyboard.press("Enter");
      await expect(body(page)).toContainText("fine by me");
      await page.getByTestId("ai-strip-undo").click();
      await openField(page);
      await expect(field(page)).toHaveValue("");
      await page.keyboard.press("ArrowUp");
      await expect(field(page)).toHaveValue("echo: fine by me");
      await page.keyboard.press("Escape");
      await expect(row(page)).toHaveCount(0);
      await expect(body(page)).toBeFocused();

      // a row that made its draft takes it away with it
      await page.getByTestId("compose-discard").click();
      await page.getByTestId("quick-ai").waitFor();
      await page.getByTestId("quick-ai").click();
      await expect(field(page)).toBeFocused();
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
      await openField(page);
      await expect(field(page)).toBeFocused();
      await page.keyboard.press("Enter");
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
      await page.keyboard.type("fine with the 19th");
      await openField(page);
      await expect(field(page)).toHaveAttribute("placeholder", /notes/);
      await page.keyboard.press("Enter");
      const choice = page.getByTestId("ai-choice");
      await expect(choice).toHaveAttribute("data-reason", "notes");
      await expect(preview(page)).toHaveAttribute("data-mode", "below");
      await expect(preview(page)).not.toHaveAttribute("aria-hidden", "true");
      await expect(body(page)).toHaveText("fine with the 19th");

      await page.getByTestId("ai-choice-below").click();
      await expect(body(page)).toContainText("fine with the 19th");
      await expect(body(page)).toContainText("That works for me");
      await page.keyboard.press("ControlOrMeta+z");
      await expect(body(page)).toHaveText("fine with the 19th");

      await openField(page);
      await page.keyboard.press("Enter");
      await page.getByTestId("ai-choice-replace").click();
      await expect(body(page)).not.toContainText("fine with the 19th");
      await expect(body(page)).toContainText("That works for me");
      await page.getByTestId("ai-strip-undo").click();
      await expect(body(page)).toHaveText("fine with the 19th");

      await openField(page);
      await page.keyboard.press("Enter");
      await page.getByTestId("ai-choice-discard").click();
      await expect(body(page)).toHaveText("fine with the 19th");
      await expect(row(page)).toHaveCount(0);
    });
    await scenario("coming back to a question doesn't take focus: only asking for it does (Codex review 10)", async () => {
      await fresh(page, server);
      await openThread(page, /Studio lunch/);
      await openField(page);
      await field(page).fill("tell tom that this is just fine");
      await page.keyboard.press("Enter");
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
      await page.keyboard.type("short and mine");
      await openField(page);
      await page.keyboard.press("Enter");
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
      await field(page).fill("[fake:refusal] nope");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("ai-error-text")).toContainText("The model declined to write this.");
      await expect(page.getByTestId("ai-error-insert")).toHaveCount(0);
      await page.getByTestId("ai-error-close").click();

      await openField(page);
      await field(page).fill("[fake:fail:3] it drops");
      await page.keyboard.press("Enter");
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
        await field(page).fill("tell tom that this is just fine");
        await page.keyboard.press("Enter");
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
        await field(page).fill("tell tom that this is just fine");
        await page.keyboard.press("Enter");
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
        await field(page).fill("tell tom that this is just fine");
        await page.keyboard.press("Enter");
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
        await field(page).fill("tell tom that this is just fine");
        await page.keyboard.press("Enter");
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
        await field(page).fill("tell tom that this is just fine");
        await page.keyboard.press("Enter");
        await page.getByTestId("ai-choice-reply").click();
        await expect(page.getByTestId("reader-subject")).toContainText("Contract review");
        await expect.poll(() => recipientEmails(page, "compose-to")).toEqual(["tom@acme.example"]);
        await expect(strip(page)).toBeVisible();
      });
      await scenario("the list, no recent thread: a new message to them", async () => {
        await fresh(page, server);
        await page.getByTestId("thread-list").locator("[data-keep-scroll=list]").focus();
        await page.keyboard.press("c");
        await openField(page);
        await field(page).fill("tell rosa that this is just fine");
        await page.keyboard.press("Enter");
        await expect.poll(() => recipientEmails(page, "compose-to")).toEqual(["rosa@faraway.example"]);
        await expect(strip(page)).toBeVisible();
      });
      await scenario("a thread, nobody named: a reply as usual", async () => {
        await fresh(page, server);
        await openThread(page, /Contract review/);
        await openField(page);
        await field(page).fill("say the clauses look right");
        await page.keyboard.press("Enter");
        await expect(strip(page)).toBeVisible();
        expect(await recipientEmails(page, "compose-to")).toEqual(["ana@studio.example"]);
      });
      await scenario("the list, nobody named: the row asks who it's for", async () => {
        await fresh(page, server);
        await page.getByTestId("thread-list").locator("[data-keep-scroll=list]").focus();
        await page.keyboard.press("c");
        await openField(page);
        await field(page).fill("say the clauses look right");
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("ai-who")).toBeVisible();
        await expect(page.getByTestId("compose-to")).toBeFocused();
        await expect(field(page)).toHaveValue("say the clauses look right");
      });
      await scenario("a draft with recipients: one of them stands, someone else asks and is never re-addressed silently", async () => {
        await fresh(page, server);
        await page.getByTestId("thread-list").locator("[data-keep-scroll=list]").focus();
        await page.keyboard.press("c");
        await addRecipients(page, "compose-to", "Ana Pérez <ana@studio.example>");
        await openField(page);
        await field(page).fill("tell ana that this is just fine");
        await page.keyboard.press("Enter");
        await expect(strip(page)).toBeVisible();
        expect(await recipientEmails(page, "compose-to")).toEqual(["ana@studio.example"]);
        await page.getByTestId("ai-strip-undo").click();

        await openField(page);
        await field(page).fill("tell tom that this is just fine");
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("ai-question")).toHaveAttribute("data-question", "add-or-just-write");
        expect(await recipientEmails(page, "compose-to")).toEqual(["ana@studio.example"]);
        await page.getByTestId("ai-choice-add").click();
        await expect.poll(() => recipientEmails(page, "compose-to")).toEqual(["ana@studio.example", "tom@acme.example"]);
        await expect(strip(page)).toBeVisible();
      });
    });

  });

  test("during the stream: Esc, typing, collapsing, switching", async ({ app: page, server }) => {
    await scenario("Esc mid-stream stops and discards, handled before the form's collapse; a second Esc puts the empty draft away", async () => {
      await ready(page, server);
      await openThread(page, /Contract review/);
      await openField(page);
      await field(page).fill("say that this is just fine");
      await page.keyboard.press("Enter");
      await streaming(page);
      await page.keyboard.press("Escape");
      await expect(row(page)).toHaveCount(0);
      await expect(preview(page)).toHaveCount(0);
      await expect(page.getByTestId("composer")).toBeVisible();
      await expect(body(page)).toHaveText("");
      await expect(body(page)).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("draft-slot")).toHaveAttribute("data-state", "bar");
    });
    await scenario("typing during the stream: it goes on, and ends as a suggestion; a change of recipients says who it was for", async () => {
      await fresh(page, server);
      await openThread(page, /Contract review/);
      await openField(page);
      await field(page).fill("say that this is just fine");
      await page.keyboard.press("Enter");
      await streaming(page);
      await page.keyboard.type("my own words");
      await expect(preview(page)).toHaveAttribute("data-mode", "below");
      await expect(page.getByTestId("ai-choice")).toHaveAttribute("data-reason", "typed");
      await expect(page.getByTestId("ai-choice-text")).toHaveText("Suggestion ready");
      await expect(body(page)).toHaveText("my own words");
      await page.getByTestId("ai-choice-insert").click();
      await expect(body(page)).toContainText("my own words");
      await expect(body(page)).toContainText("That works for me");

      await page.keyboard.press("ControlOrMeta+z");
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("Backspace");
      await openField(page);
      await field(page).fill("say that this is just fine");
      await page.keyboard.press("Enter");
      await streaming(page);
      await addRecipients(page, "compose-to", "rosa@faraway.example");
      await expect(page.getByTestId("ai-written-for")).toHaveText("Written for Ana");
    });
    await scenario("collapse and return: it goes on, the collapsed line says so, and the text is there with its strip on return", async () => {
      await fresh(page, server);
      fakeDraft.paceMs = 80;
      await openThread(page, /Contract review/);
      await openField(page);
      await field(page).fill("say that this is just fine");
      await page.keyboard.press("Enter");
      await streaming(page);
      await page.getByTestId("compose-collapse").click();
      await expect(page.getByTestId("draft-collapsed")).toContainText("Writing…");
      await expect(page.getByTestId("draft-collapsed")).toContainText("Suggestion ready");
      await page.getByTestId("draft-collapsed").click();
      await expect(strip(page)).toBeVisible();
      await expect(body(page)).toContainText("That works for me");
      await page.getByTestId("ai-strip-undo").click();
      await expect(body(page)).toHaveText("");
    });
    await scenario("switching threads: it goes on, and the text is there with its strip on return", async () => {
      await fresh(page, server);
      fakeDraft.paceMs = 80;
      fakeDraft.text = () => "Hi Tom,\n\nThat works for me.";
      await openThread(page, /Contract review/);
      await openField(page);
      await field(page).fill("say that this is just fine");
      await page.keyboard.press("Enter");
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
      await field(page).fill("say that this is just fine");
      await page.keyboard.press("Enter");
      await streaming(page);
      await page.getByTestId("compose-pin").click();
      const card = page.getByTestId("pinned-draft");
      await expect(card.getByTestId("ai-preview-text")).toContainText("Hi Tom");
      await expect(card.getByTestId("ai-strip")).toBeVisible();
      await expect(card.getByTestId("compose-body")).toContainText("That works for me");
      await card.getByTestId("ai-strip-undo").click();
      await expect(card.getByTestId("compose-body")).toHaveText("");
    });
    await scenario("send blocked: ⌘↵, Send and Send Later all stop at the row, which offers the choice", async () => {
      await fresh(page, server);
      fakeDraft.paceMs = 120;
      await openThread(page, /Contract review/);
      await openField(page);
      await field(page).fill("say that this is just fine");
      await page.keyboard.press("Enter");
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
      await field(page).fill("say that this is just fine");
      await page.keyboard.press("Enter");
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
        await page.keyboard.type("short and mine");
        await page.keyboard.press(CMD_J);
      });
      await expect(field(page)).toBeFocused();
      await expect(body(page)).toHaveText("short and mine");
      await expect(field(page)).toHaveValue("");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("ai-choice")).toHaveAttribute("data-reason", "notes");
      await page.getByTestId("ai-choice-discard").click();
      await expect(body(page)).toHaveText("short and mine");
      await expect.poll(saved).toEqual(["short and mine"]);
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
      await expect(field(page)).toBeFocused();
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
    await server.backend.server.invoke("settings.update", { ai: { provider: "none" } }, dev);
    await page.getByTestId("ai-row-input").fill("say yes");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("ai-no-provider")).toContainText("Drafting needs an AI provider. Use your own key or a local model.");

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

  test("the first draft on a cloud provider says what it sends, once", async ({ app: page, server }) => {
    await seed(server);
    await server.backend.server.invoke("settings.update", { ai: { provider: "compatible", preset: "custom", baseURL: "https://stub.invalid/v1", model: "stub" } }, dev);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await rows(page).first().waitFor();
    await openThread(page, /Contract review/);
    await openField(page);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("ai-telling")).toContainText("Each draft sends");
    await expect(page.getByTestId("ai-telling-continue")).toBeFocused();
    await page.keyboard.press("Enter");
    // it goes to the stub, which isn't there: the failure says so, and the line doesn't come back
    await expect(page.getByTestId("ai-error-text")).toBeVisible();
    await page.getByTestId("ai-error-close").click();
    await openField(page);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("ai-telling")).toHaveCount(0);
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
    await expect(page.getByTestId("style-status")).toContainText(/Learned from \d+ messages/, { timeout: 20_000 });
    expect((await new AxeBuilder({ page }).include("[data-testid=writing-style]").analyze()).violations).toEqual([]);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect((await new AxeBuilder({ page }).include("[data-testid=writing-style]").withRules(["color-contrast"]).analyze()).violations).toEqual([]);
    await page.emulateMedia({ colorScheme: "light" });
    // plan 161: its title is the page's; what it learned and how styles combine come first; one profile at a time
    await expect(page.getByTestId("settings-title")).toHaveText("Writing style");
    await expect(page.getByTestId("style-precedence")).toContainText("AI drafts start from You");
    const above = async (a: string, b: string) => (await page.getByTestId(a).boundingBox())!.y < (await page.getByTestId(b).boundingBox())!.y;
    expect(await above("style-status", "style-own")).toBe(true);
    await expect(page.getByTestId("style-profile")).toHaveCount(1);
    if (await page.getByTestId("style-scope").count()) {
      const first = await page.getByTestId("style-profile-title").innerText();
      await page.getByTestId("style-scope").click();
      await page.getByRole("option").nth(1).click();
      await expect(page.getByTestId("style-profile-title")).not.toHaveText(first);
      await page.getByTestId("style-scope").click();
      await page.getByRole("option").first().click();
    }
    // the editor: its first field focused, a sign-off kept whole, Save in view in a small window, focus back on Edit
    await page.setViewportSize({ width: 1100, height: 700 });
    await profile.getByTestId("style-profile-edit").click();
    await expect(page.getByTestId("style-editor").locator("textarea").first()).toBeFocused();
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
    await profile.getByTestId("style-profile-edit").click();
    await expect(page.getByTestId("style-edit-signoffs-field").last()).toHaveValue("Cheers,\nLuis");
    await page.getByTestId("style-edit-cancel").click();
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

    // the study on a local model asks nothing, and is running, not done, when it starts (Codex review 12)
    await page.getByTestId("style-study-start").click();
    await expect(page.getByTestId("style-study-consent")).toHaveCount(0);
    await expect(page.getByTestId("style-study-running")).toContainText(/\d+ of \d+/);
    await page.getByTestId("style-study-stop").click();
    await expect(page.getByTestId("style-study-start")).toBeVisible();

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
    await scenario("the prompt says what Return does, and Write does the same", async () => {
      await ready(page, server);
      instant();
      await openThread(page, /Contract review/);
      await openField(page);
      await expect(field(page)).toHaveAttribute("placeholder", "Describe the reply, or press Return to draft from the conversation.");
      await expect(page.getByTestId("ai-row-write")).toHaveText(/Write/);
      await field(page).fill("echo: Thanks, that works.");
      await page.getByTestId("ai-row-write").click();
      await expect(strip(page)).toBeVisible();
      await expect(body(page)).toHaveText("Thanks, that works.");
    });
    await scenario("a status and four buttons: the commands have a resting shape at 28 px; the status isn't a control", async () => {
      await expect(page.getByTestId("ai-strip-written")).toHaveText("Written with AI");
      expect(await page.getByTestId("ai-strip-written").evaluate((el) => el.closest("button"))).toBeNull();
      for (const id of ["ai-strip-regenerate", "ai-strip-shorter", "ai-strip-warmer", "ai-strip-undo"]) {
        const button = page.getByTestId(id);
        expect((await button.boundingBox())!.height, id).toBeGreaterThanOrEqual(28);
        // a 1 px edge at rest, not only on hover
        expect(await button.evaluate((el) => getComputedStyle(el).borderTopWidth), id).toBe("1px");
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
      await expect(body(page)).toHaveText("");
      await expect(strip(page)).toHaveCount(0);
      await expect(page.getByTestId("snack")).toContainText("Back to before the AI draft");
      await page.getByTestId("snack-action").click();
      await expect(body(page)).toHaveText("Thanks, that works. Mine.");
      await expect(page.getByTestId("ai-strip-written")).toHaveText("Edited after AI");
    });
    await scenario("1100x700: a long instruction shows whole, the strip keeps its status, and the written draft and Send are in view", async () => {
      await fresh(page, server);
      await page.setViewportSize({ width: 1100, height: 700 });
      await openThread(page, /Contract review/);
      await openField(page);
      const words = "echo: Friday works for me. Could you send the address of the flat, and say whether parking is near?";
      await field(page).fill(words);
      // the field grows rather than cutting the words: everything it holds is on screen
      expect(await field(page).evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      await page.keyboard.press("Enter");
      await expect(strip(page)).toBeVisible();
      await expect(page.getByTestId("ai-strip-written")).toBeVisible();
      expect(await page.getByTestId("ai-strip-voice").evaluate((el) => { const s = el.querySelector("span")!; return s.scrollWidth <= s.clientWidth; })).toBe(true);
      const view = page.viewportSize()!;
      await expect.poll(async () => { const b = (await body(page).boundingBox())!; return b.y + b.height <= view.height; }).toBe(true);
      await expect(page.getByTestId("compose-send")).toBeInViewport();
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
    await expect(field(page)).toHaveAttribute("placeholder", "Describe la respuesta, o pulsa Intro para redactarla a partir de la conversación.");
    await expect(row(page).locator("label")).toHaveText("IA");
    await page.keyboard.press("Enter");
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
      await expect(field(page)).toBeFocused();
      await field(page).fill("say that this is just fine");
      await shot(page, `${theme}-1-row`, design);
      await page.keyboard.press("Enter");
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
    await field(page).fill("say that this is just fine");
    await page.keyboard.press("Enter");
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
    await field(page).fill("tell tom that this is just fine");
    await page.keyboard.press("Enter");
    await page.getByTestId("ai-question").waitFor();
    await tag("question");
    await page.keyboard.press("Escape");
    // notes, ending in the choice
    await openThread(page, /Contract review/);
    await page.keyboard.press("r");
    await expect(body(page)).toBeFocused();
    await page.keyboard.type("fine with the 19th, signing after");
    await openField(page);
    await tag("notes-field");
    fakeDraft.paceMs = 20;
    await page.keyboard.press("Enter");
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
    await field(page).fill("say that this is just fine");
    await page.keyboard.press("Enter");
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
    await field(page).fill("[fake:fail:8] it drops");
    fakeDraft.paceMs = 20;
    await page.keyboard.press("Enter");
    await page.getByTestId("ai-error").waitFor();
    await tag("error-partial");
    await page.getByTestId("ai-error-close").click();
    // the check line
    fakeDraft.text = () => "See you on 19 March at [time].";
    await openField(page);
    await field(page).fill("say see you");
    await page.keyboard.press("Enter");
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
    await page.keyboard.press("Enter");
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
