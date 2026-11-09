/**
 * Plan 163 on Pro's real models (`TERNO_RATING_REAL=1` only: it spends money, never in CI or test:all): ⌘J on what's
 * written in the body, through the app as a person uses it, on the rating's demo mailbox. It checks what a stub can't
 * (the fast model's reading of text the rules leave unsure, and fills that leave the user's words alone) and times, in the
 * page, the first visible change and the finished draft for each path. The times are printed for plan 163.
 */
import { expect, test, type Page } from "@playwright/test";
import { launch } from "../../../scripts/ui-rating/harness.mjs";

test.describe.configure({ mode: "serial" });

/** In the page, from now: when the first change shows (stream text, a fill in its gap), and when it's done. */
async function watch(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __t: Record<string, number> };
    const t = (w.__t = {} as Record<string, number>);
    const t0 = performance.now();
    const mark = (k: string) => { if (t[k] === undefined) t[k] = Math.round(performance.now() - t0); };
    const tick = () => {
      if (w.__t !== t) return;
      if (document.querySelector("[data-testid=ai-row-status][data-state=reading]")) mark("reading");
      if ((document.querySelector("[data-testid=ai-preview-text]")?.textContent ?? "").trim() || document.querySelector("[data-testid=compose-fill-stream]")) mark("first");
      if (document.querySelector("[data-testid=ai-strip], [data-testid=ai-choice], [data-testid=ai-error]")) { mark("first"); mark("done"); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const times = (page: Page) => page.evaluate(() => (window as unknown as { __t: Record<string, number> }).__t);

async function press(page: Page) {
  await watch(page);
  // nothing is asked first (plan 131: no per-use consent): the clock runs from the press
  await page.keyboard.press("Meta+j");
  await page.locator("[data-testid=ai-strip], [data-testid=ai-choice], [data-testid=ai-error]").first().waitFor({ timeout: 3 * 60_000 });
  await expect.poll(async () => (await times(page)).done, { timeout: 10_000 }).toBeGreaterThan(0);
  return times(page);
}

async function reply(page: Page, subject: string, text: string) {
  const discard = page.getByTestId("compose-discard");
  while (await discard.count()) { await discard.first().click(); await page.waitForTimeout(400); }
  await page.getByTestId("thread-row").filter({ hasText: subject }).first().click();
  await page.getByTestId("reader-subject").waitFor();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("r");
  await page.locator("[data-testid=compose-body]:focus").waitFor();
  await page.keyboard.type(text);
  await page.waitForTimeout(300);
}

const body = (page: Page) => page.getByTestId("compose-body").first().innerText();

test("plan 163 on real models: write, fill, and the fast read, timed", async () => {
  test.skip(process.env.TERNO_RATING_REAL !== "1", "real models spend money: TERNO_RATING_REAL=1 runs it");
  test.setTimeout(15 * 60_000);
  const { page, close, network, usage } = await launch({ ai: true });
  const out: Record<string, unknown> = {};
  try {
    // an instruction (the rules know): the draft replaces it
    for (const round of [1, 2]) {
      await reply(page, "departamento en la Roma", "friday works for me, ask him to send the address of the flat");
      const t = await press(page);
      await expect(page.getByTestId("ai-strip")).toBeVisible();
      const text = await body(page);
      expect(text).not.toContain("ask him to send");
      expect(text.toLowerCase()).toContain("address");
      out[`write ${round}`] = { ...t, text };
    }
    // their email with gaps: only the gaps change
    const typed = "Hi Arjun,\nThe changes to the pricing page are fine, [something warm about his work]. When is the new deadline, [the date he mentioned]?\nLuis";
    for (const round of [1, 2]) {
      await reply(page, "departamento en la Roma", typed);
      const t = await press(page);
      const text = await body(page);
      for (const kept of ["Hi Arjun,", "The changes to the pricing page are fine, ", "When is the new deadline, ", "Luis"]) expect(text).toContain(kept);
      expect(text).not.toContain("[something warm about his work]");
      const fills = await page.getByTestId("compose-fill").allInnerTexts();
      out[`fill ${round}`] = { ...t, text, fills, left: await page.getByTestId("compose-gap").allInnerTexts() };
    }
    // the rules can't tell: it writes at once, and the fast model's read (Haiku on Pro) says meanwhile whether the draft
    // replaces the text ("write") or lands beside it with Replace ("expand"; the owner's answers, 2026-11-08)
    const unsure: [string, "write" | "expand"][] = [
      ["sounds good, see you friday", "write"],
      ["Friday works for me. Can you send me the address of the flat?", "expand"],
      ["please decline politely, I'm away that week", "write"],
      ["Great news about the pricing page. I'll look at it tomorrow and send you my comments by Thursday.", "expand"],
    ];
    for (const [text, expected] of unsure) {
      await reply(page, "departamento en la Roma", text);
      const t = await press(page);
      const got = (await page.getByTestId("ai-choice").count()) ? "expand" : (await page.getByTestId("ai-strip").count()) ? "write" : "error";
      out[`unsure: ${text}`] = { ...t, expected, got };
    }
    const spent = usage();
    out.usage = spent.total;
    out.hosts = network().hosts;
    expect(network().problems).toEqual([]);
  } finally {
    console.log(`PLAN163 ${JSON.stringify(out, null, 1)}`);
    await close();
  }
});
