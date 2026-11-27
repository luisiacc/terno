// The fixed evidence of a rating (plan 158): the same screens in the same states, for one style, light and dark.
// `--screens ai` shoots plan 161's AI screens instead, with AI on Pro's real models (keys from the owner's .env,
// keys.mjs), or on the local stand-in with `--ai stub`.
// `--screens whatmatters` shoots What matters alone (plan 214), on the same real models; `--screens putaway`, Put away
// (plan 282) on its seed.
// `--screens people` shoots People (plan 281), on the local stand-in unless `--ai real`.
//   node scripts/ui-rating/capture.mjs <design> <outDir> [light|dark] [--screens everyday|ai|whatmatters|putaway|people] [--ai real|stub]
import { existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { launch, resize, runRecord, setLayout, shot } from "./harness.mjs";
import { redact } from "./keys.mjs";
import { AI_SMALL, aiFlag, screensFlag, shotFiles } from "./sets.mjs";

/** What matters' rows and its feed's scroller (plan 210) */
const WM_ITEM = "[data-testid=wm-feed] [data-testid=wm-item]";
const WM_SCROLLER = "[data-testid=wm-feed] [data-keep-scroll=list]";

const REPLY = "Hi Isla,\n\nThanks for setting this up. Tuesday at 10 works for the follow-up on the checkout redesign; I'll bring the latest mockups and the numbers from the test.\n\nSee you then.";

async function pass(design, mode, dir) {
  const { app, page, close } = await launch({ design, dark: mode === "dark" });
  const s = (name) => shot(page, `${name}-${mode}`, dir);
  const settle = async () => { await page.mouse.move(0, 0); await page.waitForTimeout(400); };
  const blur = () => page.evaluate(() => document.activeElement?.blur());
  const rows = page.getByTestId("thread-row");
  const subject = () => page.getByTestId("reader-subject").waitFor();
  try {
    await page.waitForTimeout(1500);

    // --- Split view ---
    await settle(); await s("01-split-inbox");
    await rows.filter({ hasText: "Review of the holiday campaign" }).first().click(); await subject(); await settle(); await s("02-split-conversation");

    await rows.first().click(); await subject(); await blur();
    await page.keyboard.press("r"); await page.getByTestId("compose-body").waitFor();
    await page.keyboard.type(REPLY);
    await settle(); await s("03-split-draft-open");
    await page.keyboard.press("Escape"); await page.waitForTimeout(600); await settle(); await s("04-split-draft-collapsed");
    await blur();

    await page.keyboard.press("c"); await page.getByTestId("compose-to").waitFor();
    await settle(); await s("05-new-message-empty");
    await page.keyboard.type("marta.ruiz@example.com"); await page.keyboard.press("Enter");
    await page.getByTestId("compose-subject").fill("Friday's review");
    await page.getByTestId("compose-body").click();
    await page.keyboard.type("Hi Marta,\n\nCould we move Friday's review to the afternoon? I'd like to have the numbers from finance first.\n\nThanks!");
    await settle(); await s("06-new-message-filled");
    await page.keyboard.press("Escape"); await page.waitForTimeout(500); await blur(); await page.waitForTimeout(400);

    await page.keyboard.press("/");
    const input = page.getByTestId("search-input"); await input.waitFor();
    await input.fill("pago"); await page.waitForTimeout(900);
    await settle(); await s("07-search-results");
    await input.fill(""); await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); await page.waitForTimeout(400); await blur();
    await page.keyboard.press("g"); await page.keyboard.press("i"); await page.waitForTimeout(400);

    await page.keyboard.press("Meta+k"); await page.getByTestId("palette-input").waitFor();
    await settle(); await s("08-command-palette");
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);

    await rows.nth(1).click(); await rows.nth(2).click({ modifiers: ["Meta"] }); await rows.nth(3).click({ modifiers: ["Meta"] });
    await page.getByTestId("selection-bar").waitFor({ timeout: 5000 });
    await settle(); await s("09-multi-select");
    await page.keyboard.press("e"); await page.waitForTimeout(500); await s("14-archive-undo");
    await page.keyboard.press("Meta+z"); await page.waitForTimeout(500); await page.keyboard.press("Escape"); await page.waitForTimeout(300);

    await rows.nth(4).click({ button: "right" }); await page.waitForTimeout(400); await s("10-row-menu");
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);

    // the list filtered, by the chip or the button the style has
    const chip = page.getByTestId("quick-filter-unread");
    const onChip = await chip.isVisible().catch(() => false);
    if (onChip) await chip.click(); else { await blur(); await page.keyboard.press("Shift+U"); }
    await page.waitForTimeout(500); await settle(); await s("15-filtered-unread");
    if (onChip) await page.getByTestId("quick-filter-all").click(); else await page.keyboard.press("Shift+A");
    await page.waitForTimeout(400);

    // a smaller window
    await resize(app, 1100, 700); await page.waitForTimeout(500);
    await rows.first().click(); await subject(); await settle(); await s("16-small-split-inbox");
    await blur(); await page.keyboard.press("r"); await page.getByTestId("compose-body").waitFor(); await settle(); await s("17-small-draft-open");
    await page.keyboard.press("Escape"); await page.waitForTimeout(400);
    await resize(app, 1440, 900); await page.waitForTimeout(500);

    // --- List layout ---
    await setLayout(page, "list"); await page.waitForTimeout(500); await blur();
    for (let i = 0; i < 2 && (await page.getByTestId("reader").isVisible().catch(() => false)); i++) { await page.keyboard.press("Meta+["); await page.waitForTimeout(400); }
    await settle(); await s("11-list-inbox");
    await rows.filter({ hasText: "Review of the holiday campaign" }).first().click(); await subject(); await settle(); await s("12-list-conversation");
    await blur(); await page.keyboard.press("r"); await page.getByTestId("compose-body").waitFor();
    await page.keyboard.type("Hey Lucas,\n\nI liked the second direction. Can we keep the red for the banner and try a shorter headline?");
    await settle(); await s("13-list-draft-open");
  } finally { await close(); }
}

/** Plan 161's instruction for ⌘J and its question for Ask: fixed, so every round asks the same. */
const AI_INPUTS = {
  draft: "friday works for me, ask her to send the address of the cabin",
  ask: "What did James Harris say about the payment?",
  action: "Archive shipping notices older than a month",
  followup: { to: "Henry Haddad", subject: "The flat on Saturday", body: "Hi Henry,\n\nCould you send me the address of the flat before Friday? I'd like to see it on Saturday.\n\nThanks,\nLuis" },
  filter: "archive receipts from uber.com",
};

/**
 * How long a model state may take, and how often a step whose result is the model's call is tried again. The stub
 * answers in milliseconds; a real model in seconds, and a background job may queue behind another. Ceilings, never
 * sleeps: each wait ends at its ready state.
 */
const WAITS = { stub: { model: 30_000, job: 60_000, tries: 1 }, real: { model: 180_000, job: 300_000, tries: 3 } };

/**
 * Plan 161's AI screens, each in its real ready state: a state the app can't reach fails the capture, never a shot of
 * something else. Each conversation is chosen so one screen's AI can't reach another's: ⌘J and the follow-up use
 * conversations the user wrote last (Reply ready starts only on mail waiting for them), and Reply ready has its own.
 * On real models, a state that depends on what the model says (a follow-up's expectsReply, Ask's answer, the action's
 * matches, the filter) is tried again a bounded number of times, then fails loudly.
 */
async function aiPass(design, mode, dir, ai) {
  const { app, page, close, stub, network, models, usage } = await launch({ design, dark: mode === "dark", ai: ai === "stub" ? "stub" : true });
  const wait = WAITS[ai];
  const rows = page.getByTestId("thread-row");
  const subject = () => page.getByTestId("reader-subject").waitFor();
  const blur = () => page.evaluate(() => document.activeElement?.blur());
  const visible = (testId, opts = {}) => page.getByTestId(testId).filter(opts).first().waitFor({ timeout: opts.timeout ?? wait.model });
  /** whichever of these selectors shows first, by its index */
  const first = async (selectors, timeout = wait.model) => {
    await page.locator(selectors.join(", ")).first().waitFor({ timeout });
    for (let i = 0; i < selectors.length; i++) if (await page.locator(selectors[i]).first().isVisible().catch(() => false)) return i;
    return first(selectors, timeout);
  };
  /** a step the model decides, tried `wait.tries` times: `attempt(n)` returns true once the state is there */
  const retry = async (what, attempt) => {
    let last = "";
    for (let n = 1; n <= wait.tries; n++) {
      // a wait that ran out is a no from the model; the last one's reason goes in the failure
      if (await attempt(n).catch((e) => ((last = e.message.split("\n")[0]), false))) return;
      if (n < wait.tries) console.log(`${design} ${mode}: ${what} not reached${last ? ` (${last})` : ""}, trying again (${n}/${wait.tries})`);
      last = "";
    }
    throw new Error(`${what}: not reached after ${wait.tries} ${wait.tries === 1 ? "try" : "tries"}${last ? ` (${last})` : ""}`);
  };
  /** after its shot: the model a surface says wrote it (its provenance popover), for the round's record */
  const seen = {};
  const provenance = async (testId) => {
    const trigger = page.getByTestId(testId).first();
    if (!(await trigger.isVisible().catch(() => false))) return;
    await trigger.click();
    const detail = page.getByTestId(`${testId}-detail`);
    seen[testId.replace(/-provenance$/, "")] = (await detail.innerText({ timeout: 5000 }).catch(() => "")).trim();
    await page.keyboard.press("Escape");
    await page.getByTestId(`${testId}-popover`).waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  };
  /** nothing moving and the model idle: what's on screen is the state, not a step on the way */
  const still = async () => {
    await page.mouse.move(0, 0);
    // transitions end (motion is capped at 100 ms); a snack's countdown or a spinner runs on, and isn't waited for
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || !(Number(a.effect?.getComputedTiming().endTime) <= 1000)));
    // the stub says when it's idle; a real provider can't, so its screens rest on their ready states alone
    for (let i = 0; stub && stub.active > 0; i++) {
      if (i > 600) throw new Error("the model stub is still answering");
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const s = async (name, { snack = false } = {}) => {
    // closed first, then still: a closing snack fades out before the shot
    if (!snack) await noSnacks();
    await still();
    // the state is still there after the wait: an undo that ran out isn't a shot of the undo
    if (snack && !(await page.getByTestId("snack").first().isVisible())) throw new Error(`${name}: its snack was gone before the shot`);
    await shot(page, `${name}-${mode}`, dir);
    if (!AI_SMALL.includes(name)) return;
    await resize(app, 1100, 700);
    await page.waitForFunction(() => innerWidth === 1100);
    await still();
    await shot(page, `${name}-small-${mode}`, dir);
    await resize(app, 1440, 900);
    await page.waitForFunction(() => innerWidth === 1440);
  };
  /** a snack a step leaves (Draft discarded, Put back, Message sent) isn't part of the next screen: closed once it's there */
  const closeSnack = async (text) => {
    const snack = page.getByTestId("snack").filter({ hasText: text }).first();
    await snack.waitFor({ timeout: 15_000 });
    await snack.getByTestId("snack-close").click();
    await snack.waitFor({ state: "detached" });
  };
  const noSnacks = async () => {
    // only what's on screen: a snack on its way out keeps its button for a moment, hidden
    for (const close of await page.getByTestId("snack-close").all()) if (await close.isVisible()) await close.click({ timeout: 2000 }).catch(() => {});
    await page.getByTestId("snack").first().waitFor({ state: "detached", timeout: 5000 });
  };
  const noReplyReady = async (where) => {
    if (await page.getByTestId("reply-ready").count()) throw new Error(`${where}: Reply ready reached a conversation it shouldn't`);
  };
  try {
    // --- What matters (plan 210's feed; plan 214), and the digest the backend prepared on its own ---
    await page.getByTestId("nav-today").click();
    await page.locator(WM_ITEM).first().waitFor({ timeout: wait.job });
    // the automated mail's row (the feed's last open item; the feed draws only what's near the view): sought a step at a
    // time, from the top again until it comes
    const digest = page.locator(`${WM_ITEM}[data-digest]`);
    const toDigest = async () => {
      for (const end = Date.now() + wait.job; !(await digest.count()); ) {
        if (Date.now() > end) throw new Error("What matters' automated mail row never came");
        const atEnd = await page.locator(WM_SCROLLER).evaluate((el) => {
          const end = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
          el.scrollTop = end ? 0 : el.scrollTop + el.clientHeight * 0.6;
          return end;
        });
        await page.waitForTimeout(atEnd ? 2000 : 120);
      }
      await digest.first().scrollIntoViewIfNeeded();
    };
    await toDigest();
    await page.locator(WM_SCROLLER).evaluate((el) => (el.scrollTop = 0));
    await s("a07-today");
    await toDigest();
    await digest.first().click();
    await visible("digest-page");
    // ready, not "Preparing today's digest…": the digest is prepared once a day, on its own, and a model that found no
    // newsletter can't be asked again from here
    await visible("digest-item", { timeout: wait.job });
    await s("a08-today-digest");
    await provenance("digest-provenance");

    // --- a summary, asked for (old mail isn't summarized on its own) ---
    await page.getByTestId("nav-inbox").click();
    await rows.filter({ hasText: "Review of the holiday campaign" }).first().click(); await subject();
    await page.getByTestId("action-summarize").click();
    // no per-use consent (plan 131, the owner's decision): it runs on the click, on a cloud model too
    await page.locator("[data-testid=summary-block][data-state=ready]").waitFor({ timeout: wait.model });
    await visible("summary-item");
    await s("a01-summary");
    await provenance("summary-provenance");

    // --- ⌘J (plan 163): the reply opened for AI, the instruction typed in its body (its Sparkles lit), then the draft
    // written in its place ---
    await rows.filter({ hasText: "Plans for the long weekend" }).first().click(); await subject();
    await blur();
    await page.keyboard.press("Meta+j");
    await page.locator("[data-testid=compose-body]:focus").waitFor();
    await page.keyboard.type(AI_INPUTS.draft);
    await page.locator("[data-testid=compose-ai][data-ready]").waitFor();
    await noReplyReady("⌘J");
    await s("a02-draft-prompt");
    await page.keyboard.press("Meta+j");
    await visible("ai-strip");
    // the strip shows once the writing is done; the draft is in the body (the stub's names the address, a real model's words vary)
    await page.waitForFunction(() => (document.querySelector("[data-testid=compose-body]")?.textContent ?? "").trim().length > 40, null, { timeout: wait.model });
    await noReplyReady("⌘J");
    await s("a03-draft-written");
    // the draft goes, so no later screen shows it in the list
    await page.getByTestId("compose-discard").click();
    await page.getByTestId("composer").waitFor({ state: "detached" });
    await closeSnack(/discarded|descartado/i);

    // --- Ask your mail: an answer and its sources ---
    await blur();
    await page.keyboard.press("Meta+Shift+k");
    await page.getByRole("dialog").waitFor();
    await retry("Ask's answer with sources", async (n) => {
      if (n > 1) { await page.getByTestId("ask-new").click(); }
      await page.keyboard.type(AI_INPUTS.ask);
      await page.keyboard.press("Enter");
      await page.locator("[data-testid=ask-turn]:not([data-status=running])").last().waitFor({ timeout: wait.model });
      // an answer with its sources: "answered", or "partial" when the model says it saw only part of the mail (a real
      // model's call on the demo's years of mail); not_found, failed and stopped are asked again
      return ["answered", "partial"].includes(await page.locator("[data-testid=ask-turn]").last().getAttribute("data-status")) && (await page.getByTestId("ask-source").count()) > 0;
    });
    await s("a04-ask-answer");
    await provenance("ask-provenance");

    // --- actions in plain English: the preview, then the undo offered after Apply ---
    await retry("the action's preview with matches", async (n) => {
      if (n > 1) {
        // a preview with nothing to apply is left by its Cancel; the question is asked again from Ask
        if (await page.getByTestId("action-cancel").isVisible().catch(() => false)) { await page.getByTestId("action-cancel").click(); await page.getByTestId("action-preview").waitFor({ state: "detached" }); }
        if (!(await page.getByRole("dialog").isVisible().catch(() => false))) { await blur(); await page.keyboard.press("Meta+Shift+k"); await page.getByRole("dialog").waitFor(); }
      }
      // after an answer, New question; an Ask with nothing in it is new already
      if (await page.getByTestId("ask-new").isVisible().catch(() => false)) await page.getByTestId("ask-new").click();
      await page.keyboard.type(AI_INPUTS.action);
      await page.keyboard.press("Enter");
      // nothing matched is a notice in Ask, not a preview: a no from the model's plan
      if ((await first(["[data-testid=action-preview]", "[data-testid=ask-command-notice]"])) === 1) return false;
      // whole: the search done, the check done, and Apply ready for what's left
      const ready = () => !document.querySelector("[data-testid=action-finding], [data-testid=action-checking]") && document.querySelector("[data-testid=action-apply]")?.disabled === false;
      return page.waitForFunction(ready, null, { timeout: wait.model }).then(() => true, () => false);
    });
    await s("a05-actions-preview");
    await page.getByTestId("action-apply").click();
    await visible("snack", { hasText: /Archived|Archivad/ });
    await s("a06-actions-undo", { snack: true });
    await blur();
    await page.keyboard.press("Meta+z");
    await page.getByTestId("snack").filter({ hasText: /Archived|Archivad/ }).waitFor({ state: "detached" });
    await closeSnack(/back|devuelt|de vuelta/i);

    // --- Reply ready, on mail waiting for the user ---
    await page.getByTestId("nav-inbox").click();
    await rows.filter({ hasText: "Blockers for instant search" }).first().click(); await subject();
    // the model decides whether it needs a reply (needs_reply), once per conversation as it stands: not a step to retry
    await page.locator("[data-testid=reply-ready][data-phase=ready]").waitFor({ timeout: wait.model });
    await visible("reply-ready-use");
    await s("a10-reply-ready");
    await provenance("reply-ready-provenance");

    // --- a follow-up: a question sent from the window, read by the model, waiting with Nudge ---
    // whether it waits for an answer is the model's call (expectsReply): on real models, the question is sent again
    await retry("the follow-up line with Nudge", async () => {
      await page.getByTestId("nav-inbox").click();
      await blur();
      await page.keyboard.press("c");
      await visible("compose-to");
      // a person the demo knows, picked from the suggestions as a person does: the line names them
      await page.keyboard.type(AI_INPUTS.followup.to);
      await page.getByTestId("recipient-suggestion").filter({ hasText: AI_INPUTS.followup.to }).first().click();
      await page.getByTestId("recipient-chip").filter({ hasText: AI_INPUTS.followup.to }).waitFor();
      await page.getByTestId("compose-subject").fill(AI_INPUTS.followup.subject);
      await page.getByTestId("compose-body").click();
      await page.keyboard.type(AI_INPUTS.followup.body);
      await page.keyboard.press("Meta+Enter");
      await page.getByTestId("composer").waitFor({ state: "detached" });
      // Sent sits under More in the sidebar: its shortcut, as a keyboard user goes there
      await blur();
      await page.keyboard.press("g"); await page.keyboard.press("t");
      await rows.filter({ hasText: AI_INPUTS.followup.subject }).first().waitFor({ timeout: 30_000 });
      await rows.filter({ hasText: AI_INPUTS.followup.subject }).first().click(); await subject();
      return visible("followup-nudge", { timeout: wait.job }).then(() => true, () => false);
    });
    await visible("followup-line");
    // the first follow-up's tip (plan 113) is taught once; the screen is the line it points at
    if (await page.getByTestId("tip-done").isVisible().catch(() => false)) await page.getByTestId("tip-done").click();
    await s("a09-followup");

    // --- Create a filter with AI: the rule it wrote, before saving ---
    await page.getByTestId("open-filters").click();
    await page.getByTestId("ai-prompt").fill(AI_INPUTS.filter);
    await retry("the filter the AI wrote", async () => {
      await page.getByTestId("ai-generate").click();
      return visible("ai-explanation").then(() => true, () => false);
    });
    // the rule's matches counted, not "Calculating…" (plan 161, pass 2: the timing it waited on is no longer shown; data-ready is set exactly when it was)
    await page.locator("[data-testid=filter-preview][data-ready]").first().waitFor({ timeout: wait.model });
    await s("a11-filter-ai");
    await page.keyboard.press("Escape");
    await page.getByTestId("ai-prompt").waitFor({ state: "detached" });

    // --- Writing style, learned on this Mac from sent mail ---
    await page.keyboard.press("Meta+,");
    await page.getByTestId("tab-ai").click();
    await page.getByTestId("ai-drafting-style-open").click();
    await visible("writing-style");
    await visible("style-status", { hasText: /Learned from|Aprendido/ });
    await s("a12-writing-style");
    await page.keyboard.press("Escape");

    // revision 10: nothing left but the model's own requests, and the stub was asked only what it knows
    const net = network();
    if (net.problems.length) throw new Error(`requests outside the ${stub ? "stub" : "providers in use"}: ${net.problems.join("; ")}`);
    if (stub?.unknown.length) throw new Error(`the stub was asked tasks it doesn't know: ${stub.unknown.join("; ")}`);
    if (stub) console.log(`${design} ${mode}: ${net.ai} AI requests, all to the stub (${[...new Set(stub.tasks)].join(", ")})`);
    else {
      const spent = usage();
      console.log(`${design} ${mode}: ${net.ai} AI requests, to ${net.hosts.join(", ")} only; ${spent.total.requests} counted, ${spent.total.inputTokens} tokens in, ${spent.total.outputTokens} out, US$${spent.total.usd.toFixed(4)}`);
      // one line rate.mjs reads into round.json: who ran and what it cost, never a key
      console.log(`AI_RUN ${JSON.stringify(runRecord({ design, mode, models, net, seen, usage: spent }))}`);
    }
  } catch (error) {
    // what the window showed when a state wasn't reached, beside the shots, for whoever reads the failure
    await page.screenshot({ path: join(dir, `FAILED-${mode}.png`) }).catch(() => {});
    throw error;
  } finally { await close(); }
}

/**
 * Plan 214: What matters on its own, as the app's readers fill it on Pro's real models (AI is on by default, plan 211):
 * shot once both readers have read what they queued and the header's numbers hold. A state that isn't there fails the
 * capture, never a shot of something else.
 */
async function wmPass(design, mode, dir, ai) {
  const { app, page, profile, close, network, models, usage } = await launch({ design, dark: mode === "dark", ai: ai === "stub" ? "stub" : true });
  const scroller = page.locator(WM_SCROLLER);
  const row = (id) => page.locator(`${WM_ITEM}[data-row-id="${id}"]`);
  const still = async () => {
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || !(Number(a.effect?.getComputedTiming().endTime) <= 1000)));
  };
  const closeReader = async () => {
    for (let i = 0; i < 4 && (await page.locator(`${WM_ITEM}[data-open]`).count()); i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
  };
  /** the feed scrolled until `locator` is drawn, a step at a time (the virtualizer measures as it goes), from the top */
  const reach = async (locator) => {
    await scroller.evaluate((el) => (el.scrollTop = 0));
    // at the end, Earlier's next page comes in as the feed nears it: waited for, and asked again by leaving the end and
    // coming back (30 s at most)
    for (const end = Date.now() + 30_000; !(await locator.count()); ) {
      if (Date.now() > end) throw new Error(`not in the feed: ${locator}`);
      const atEnd = await scroller.evaluate((el) => {
        const at = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
        el.scrollTop = at ? el.scrollTop - el.clientHeight * 2 : el.scrollTop + el.clientHeight * 0.6;
        return at;
      });
      await page.waitForTimeout(atEnd ? 800 : 120);
    }
  };
  /** `locator` at the feed's top (a little below the header), and checked in view */
  const toTop = async (locator) => {
    // the row can leave the virtualizer's window between finding it and checking it (its neighbours measured on the way,
    // Earlier's next page coming in as the feed nears its end): the feed's height held for a second, then found again
    const inView = (el, s) => {
      const r = el.getBoundingClientRect(), v = document.querySelector(s).getBoundingClientRect();
      return r.top >= v.top - 1 && r.bottom <= v.bottom + 1;
    };
    for (let tries = 0; ; tries++) {
      await reach(locator);
      for (let last = -1, height = 0; height !== last; await page.waitForTimeout(1000)) [last, height] = [height, await scroller.evaluate((el) => el.scrollHeight)];
      await reach(locator);
      const placed = await locator.first().evaluate((el) => el.scrollIntoView({ block: "start" }), null, { timeout: 2000 }).then(() => true, () => false);
      if (placed) {
        await scroller.evaluate((el) => (el.scrollTop -= 16));
        await page.waitForTimeout(300);
        if (await locator.first().evaluate(inView, WM_SCROLLER, { timeout: 2000 }).catch(() => false)) return;
      }
      if (tries === 4) throw new Error(`couldn't bring into view: ${locator}`);
    }
  };
  /** the drawn rows that have Done and Later, in order, by their ids */
  const actionable = () => page.locator(`${WM_ITEM}:has([data-testid=wm-controls])`).evaluateAll((els) => els.map((e) => e.getAttribute("data-row-id")));
  try {
    await page.getByTestId("nav-today").click();
    // settled: both readers have checked every account and read what they queued (plan 211: a fresh profile reads its
    // last 14 days' mail and 30 days' sent mail, hundreds of a model's reads), and the header's numbers then hold for 20 s
    const queued = () => {
      const db = new DatabaseSync(join(profile, "terno.db"), { readOnly: true });
      try {
        const accounts = db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
        const checked = (key) => Object.keys(JSON.parse(db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key)?.value_json ?? "{}")).length;
        if (checked("dated:checked") < accounts || checked("followups:checked") < accounts) return Infinity;
        return db.prepare("SELECT COUNT(*) AS n FROM ai_dated_mail").get().n + db.prepare("SELECT COUNT(*) AS n FROM ai_sent_mail").get().n;
      } finally { db.close(); }
    };
    const reading = () => page.evaluate(() => `${document.querySelector("[data-testid=today-line]")?.textContent}|${document.querySelector("[data-testid=nav-today]")?.textContent}`);
    let last = "";
    let since = Date.now();
    let settled = false;
    for (const end = Date.now() + 1_500_000; !settled && Date.now() < end; await page.waitForTimeout(5000)) {
      const now = `${queued()}|${await reading()}`;
      if (now !== last) [last, since] = [now, Date.now()];
      else settled = now.startsWith("0|") && Date.now() - since > 20_000;
    }
    if (!settled) throw new Error(`What matters didn't settle in 25 minutes (${last})`);

    // at rest, from the top
    await scroller.evaluate((el) => (el.scrollTop = 0));
    await still();
    await shot(page, `w01-feed-${mode}`, dir);
    // the first two rows with Done and Later: the first hovered, then open beside the reader with the second hovered
    const [first, second] = await actionable();
    if (!first || !second) throw new Error("fewer than two rows with Done and Later on the feed's first screen");
    await row(first).hover();
    await row(first).getByTestId("wm-controls").getByTestId("wm-done").waitFor();
    await page.waitForTimeout(250);
    await shot(page, `w02-feed-hover-${mode}`, dir);
    await row(first).getByTestId("wm-item-open").click();
    await page.getByTestId("reader-subject").waitFor();
    await row(first).and(page.locator("[data-open]")).waitFor();
    await still();
    await row(second).scrollIntoViewIfNeeded();
    await row(second).hover();
    await row(second).getByTestId("wm-done").waitFor();
    await page.waitForTimeout(250);
    await shot(page, `w03-feed-reader-${mode}`, dir);
    await closeReader();
    // further down: the automated mail's row at the top, Coming up opened under it (when anything is coming up)
    await toTop(page.locator(`${WM_ITEM}[data-digest]`));
    const coming = page.getByTestId("wm-coming-up");
    if (await coming.count()) {
      if ((await coming.getAttribute("aria-expanded")) !== "true") await coming.click();
      await page.locator("[data-testid=wm-feed] [data-testid=wm-heading][data-kind=coming]").first().waitFor();
    }
    await still();
    await shot(page, `w04-feed-further-${mode}`, dir);
    // Earlier, from its heading
    await toTop(page.locator("[data-testid=wm-feed] [data-testid=wm-heading][data-kind=history]"));
    await still();
    await shot(page, `w06-feed-earlier-${mode}`, dir);
    // a 1100x700 window, the first row open beside the reader
    await scroller.evaluate((el) => (el.scrollTop = 0));
    await resize(app, 1100, 700);
    await page.waitForFunction(() => innerWidth === 1100);
    await row(first).getByTestId("wm-item-open").click();
    await page.getByTestId("reader-subject").waitFor();
    await still();
    await shot(page, `w05-feed-small-${mode}`, dir);
    await closeReader();
    await resize(app, 1440, 900);
    const net = network();
    if (net.problems.length) throw new Error(`requests outside the providers in use: ${net.problems.join("; ")}`);
    if (models?.ai === "real") console.log(`AI_RUN ${JSON.stringify(runRecord({ design, mode, models, net, seen: {}, usage: usage() }))}`);
  } catch (error) {
    await page.screenshot({ path: join(dir, `FAILED-${mode}.png`) }).catch(() => {});
    throw error;
  } finally { await close(); }
}

/**
 * Plan 282: Put away, on its seed (put-away-seed.ts) at the rating's instant: the Inbox's line, Review into the view, a
 * rule's reason box (the colleague your own rule caught), Terno's own filing's, and that in a 1100x700 window.
 */
async function paPass(design, mode, dir) {
  const { app, page, close } = await launch({ design, dark: mode === "dark", clock: true });
  const rows = page.getByTestId("thread-row");
  const settle = async () => { await page.mouse.move(0, 0); await page.waitForTimeout(400); };
  const open = async (subject) => {
    await rows.filter({ hasText: subject }).first().click();
    await page.getByTestId("put-away-box").waitFor();
    await settle();
  };
  try {
    await page.waitForTimeout(1500);
    await page.getByTestId("put-away-notice").waitFor();
    await settle(); await shot(page, `p01-inbox-line-${mode}`, dir);
    await page.getByTestId("put-away-review").click();
    await page.getByTestId("list-title").filter({ hasText: "Put away" }).waitFor();
    await rows.nth(7).waitFor();
    await settle(); await shot(page, `p02-put-away-${mode}`, dir);
    await open("Reunión de seguimiento"); await shot(page, `p03-box-rule-${mode}`, dir);
    await open("Tu recibo de luz de noviembre"); await shot(page, `p04-box-terno-${mode}`, dir);
    await resize(app, 1100, 700); await page.waitForTimeout(600); await settle(); await shot(page, `p05-small-${mode}`, dir);
    await resize(app, 1440, 900);
  } catch (error) {
    await page.screenshot({ path: join(dir, `FAILED-${mode}.png`) }).catch(() => {});
    throw error;
  } finally { await close(); }
}

/**
 * Plan 281: People, on the local stand-in. The list (Open, then Everyone) settles as the app reads the mail: shot once its
 * line holds for 10 s. A person with two or more things open is chosen, so a page shows what it is for.
 */
async function peoplePass(design, mode, dir, ai) {
  const { app, page, close } = await launch({ design, dark: mode === "dark", ai: ai === "real" ? true : "stub" });
  const still = async () => {
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || !(Number(a.effect?.getComputedTiming().endTime) <= 1000)));
    await page.waitForTimeout(300);
  };
  const rows = page.getByTestId("person-row");
  const items = page.getByTestId("person-page").getByTestId("person-item");
  // plan 207's question, whenever it comes: the Inbox stays the first screen (it isn't what's rated)
  await page.addLocatorHandler(page.getByTestId("first-screen-question"), () => page.getByTestId("first-screen-keep-inbox").click());
  try {
    await page.getByTestId("nav-people").click();
    await page.getByTestId("people").waitFor();
    // settled: Open's count holds for 10 s (the readers on the stand-in take seconds), 3 minutes at most
    let last = "";
    let since = Date.now();
    for (const end = Date.now() + 180_000; Date.now() < end; await page.waitForTimeout(1000)) {
      const now = `${await page.getByTestId("people-line").textContent()}|${await rows.count()}`;
      if (now !== last) [last, since] = [now, Date.now()];
      else if (Date.now() - since > 10_000 && (await rows.count()) > 0) break;
    }
    // the first person with two or more things open (a "+N" on their row), else the first
    const several = rows.filter({ has: page.locator("[data-slot=badge]") }).first();
    await ((await several.count()) ? several : rows.first()).click();
    await page.getByTestId("person-name").waitFor();
    await items.first().waitFor();
    await still();
    await shot(page, `p01-people-${mode}`, dir);
    await items.first().hover();
    await items.first().getByTestId("person-item-done").waitFor();
    await page.waitForTimeout(250);
    await shot(page, `p02-person-hover-${mode}`, dir);
    // the search: a name's start
    await page.mouse.move(0, 0);
    await page.keyboard.press("/");
    await page.getByTestId("people-search").fill("an");
    await page.getByTestId("people-match").first().waitFor();
    await still();
    await shot(page, `p03-people-search-${mode}`, dir);
    await page.getByTestId("people-search").press("Escape");
    await page.getByTestId("people-search").press("Escape");
    // Everyone, from its heading
    const heading = page.locator("[data-testid=people-heading][data-kind=everyone]");
    for (let i = 0; i < 60 && !(await heading.count()); i++) {
      await page.getByTestId("people-rows").evaluate((el) => (el.scrollTop += el.clientHeight * 0.7));
      await page.waitForTimeout(120);
    }
    await heading.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.getByTestId("people-rows").evaluate((el) => (el.scrollTop -= 8));
    await still();
    await shot(page, `p04-people-everyone-${mode}`, dir);
    await page.getByTestId("people-rows").evaluate((el) => (el.scrollTop = 0));
    // a conversation with several people: a chip's card
    await page.getByTestId("nav-inbox").click();
    const threadRows = page.getByTestId("thread-row");
    await threadRows.first().waitFor();
    let found = false;
    // down the Inbox by keyboard (the list draws only what's near), to the first conversation with people chips
    await threadRows.first().click();
    for (let i = 0; i < 200 && !found; i++) {
      await page.getByTestId("reader-subject").waitFor();
      await page.waitForTimeout(150);
      found = (await page.getByTestId("thread-person").count()) > 0;
      if (!found) {
        await page.evaluate(() => document.activeElement?.blur());
        await page.keyboard.press("j");
      }
    }
    if (!found) throw new Error("no conversation with people chips in the Inbox's first 200");
    const chip = page.getByTestId("thread-person").first();
    await chip.hover();
    await page.waitForTimeout(600);
    await chip.click();
    await page.getByTestId("person-menu").waitFor();
    await page.waitForTimeout(300);
    await shot(page, `p05-person-card-${mode}`, dir);
    await page.keyboard.press("Escape");
    // a 1100x700 window, a person open
    await page.getByTestId("nav-people").click();
    await rows.first().waitFor();
    await resize(app, 1100, 700);
    await page.waitForFunction(() => innerWidth === 1100);
    await ((await several.count()) ? several : rows.first()).click();
    await page.getByTestId("person-name").waitFor();
    await still();
    await shot(page, `p07-people-small-${mode}`, dir);
    await resize(app, 1440, 900);
    await page.waitForFunction(() => innerWidth === 1440);
    // List layout: the person's page over the list
    await setLayout(page, "list");
    await page.waitForTimeout(500);
    await page.getByTestId("nav-people").click();
    await page.waitForTimeout(400);
    // (the person chosen in Split is still chosen: their page is already over the list)
    if (!(await page.getByTestId("person-back").isVisible())) await ((await several.count()) ? several : rows.first()).click();
    await page.getByTestId("person-back").waitFor();
    await still();
    await shot(page, `p06-people-list-layout-${mode}`, dir);
  } catch (error) {
    await page.screenshot({ path: join(dir, `FAILED-${mode}.png`) }).catch(() => {});
    throw error;
  } finally { await close(); }
}

const args = process.argv.slice(2);
const set = screensFlag(args);
const ai = aiFlag(args);
const [design, dir, only] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--screens" && args[i - 1] !== "--ai");
if (!design || !dir) throw new Error("usage: capture.mjs <design> <outDir> [light|dark] [--screens everyday|ai|whatmatters|putaway] [--ai real|stub]");
try {
  mkdirSync(dir, { recursive: true });
  for (const mode of only ? [only] : ["light", "dark"]) await (set === "ai" ? aiPass(design, mode, dir, ai) : set === "whatmatters" ? wmPass(design, mode, dir, ai) : set === "putaway" ? paPass(design, mode, dir) : set === "people" ? peoplePass(design, mode, dir, ai) : pass(design, mode, dir));
  // every file of the set, or the capture failed
  const missing = shotFiles(set).filter((f) => (!only || f.endsWith(`-${only}.png`)) && !existsSync(join(dir, f)));
  if (missing.length) throw new Error(`capture ${set} is missing ${missing.join(", ")}`);
} catch (error) {
  // through the guarded stream (keys.mjs), and redacted besides: Node's own report of an uncaught error bypasses both
  console.error(redact(error?.stack ?? error));
  process.exit(1);
}
