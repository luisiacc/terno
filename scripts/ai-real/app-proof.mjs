// A real browser on the real app and real models. Start the two servers first (see the plan's "Proving it" notes),
// with TERNO_AI_REAL=1 so the backend holds every request to the spend ledger. Keys are typed into Settings and never printed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { refusalToTypeKeys } from "../../apps/backend-dev/src/proof-guard.ts";

const URL_ = process.env.PROOF_URL ?? "http://127.0.0.1:5183/?backend=ws://127.0.0.1:5184";
/** Real keys typed into a backend off the ledger would spend with no ceiling. Asked again right before each key is typed. */
function assertGuarded() {
  const refusal = refusalToTypeKeys(URL_);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
}
assertGuarded();

const require = createRequire(resolve("apps/web/package.json"));
const { chromium } = require("@playwright/test");

const OUT = process.env.PROOF_OUT ?? "/tmp/terno-ai/proof";
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(readFileSync(".env", "utf8").split(/\r?\n/).map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^(["'])(.*)\1$/, "$2")]));
const only = process.env.PROOF_ONLY?.split(",");

const report = [];
const log = (step, data) => {
  report.push({ step, ...data });
  console.log(step, JSON.stringify(data));
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1320, height: 860 }, colorScheme: "light" });
const page = await context.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text().slice(0, 200)}`); });
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const CMD_J = "ControlOrMeta+j";
const body = () => page.getByTestId("compose-body").first();
const text = async (l) => (await l.innerText()).trim();

async function step(name, fn) {
  if (only && !only.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    await shot(`FAILED-${name}`).catch(() => {});
    log(name, { failed: String(error).slice(0, 400) });
  }
}

async function openThread(subject) {
  await page.getByTestId("thread-row").filter({ hasText: subject }).first().click();
  await page.getByTestId("reader-subject").filter({ hasText: subject }).waitFor();
}

/** Types an instruction and watches the stream: when the first word came, when it finished, and whether anything moved at the end. */
async function draft(name, instruction, { framesEvery = 400 } = {}) {
  await page.keyboard.press(CMD_J);
  const field = page.getByTestId("ai-row-input");
  await field.waitFor();
  await shot(`${name}-1-row`);
  if (instruction) await field.fill(instruction);
  const started = Date.now();
  await page.keyboard.press("Enter");
  const telling = page.getByTestId("ai-telling-continue");
  if (await telling.isVisible().catch(() => false) || (await telling.waitFor({ timeout: 1200 }).then(() => true).catch(() => false))) {
    await shot(`${name}-1b-first-use`);
    await telling.click();
  }
  const preview = page.getByTestId("ai-preview-text");
  await preview.filter({ hasText: /\S/ }).waitFor({ timeout: 90_000 });
  const firstWord = Date.now() - started;
  await shot(`${name}-2-streaming`);
  let frames = 0;
  let last = { y: null, x: null, font: null };
  const strip = page.getByTestId("ai-strip");
  const choice = page.getByTestId("ai-choice");
  while (!(await strip.isVisible()) && !(await choice.isVisible()) && Date.now() - started < 120_000) {
    const box = await preview.boundingBox().catch(() => null);
    if (box) last = { x: box.x, y: box.y, font: await preview.evaluate((el) => getComputedStyle(el).fontSize).catch(() => null) };
    if (frames++ === 1) await shot(`${name}-3-streaming`);
    await page.waitForTimeout(framesEvery);
  }
  const finished = Date.now() - started;
  await shot(`${name}-4-done`);
  const committed = await body().boundingBox();
  const font = await body().evaluate((el) => getComputedStyle(el.querySelector("p") ?? el).fontSize).catch(() => null);
  const result = (await strip.isVisible()) ? await text(body()) : await text(page.getByTestId("ai-choice-text").or(preview).first());
  log(name, { instruction, firstWordMs: firstWord, finishedMs: finished, jump: last.y !== null && committed ? { dx: Math.round(committed.x - last.x), dy: Math.round(committed.y - last.y), fontBefore: last.font, fontAfter: font } : null, to: await text(page.getByTestId("draft-slot").first()).then((t) => t.slice(0, 80)).catch(() => null), result });
  return result;
}

await page.goto(URL_);
await page.locator("[data-ready]").waitFor({ timeout: 60_000 });

await step("settings", async () => {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-ai").click();
  await page.getByTestId("ai-provider").click();
  await page.getByRole("option", { name: /Claude/ }).click();
  assertGuarded();
  await page.getByTestId("ai-key").fill(env.ANTHROPIC_API_KEY);
  await page.keyboard.press("Enter");
  await page.getByTestId("ai-key").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(400);
  await shot("settings-ai");
  await page.getByTestId("tab-categories").click();
  assertGuarded();
  await page.getByTestId("jev-key").fill(env.JEV_API_KEY);
  await page.getByTestId("jev-key-save").click();
  await page.getByTestId("jev-key-test").click();
  await page.getByTestId("jev-key-test-result").waitFor({ timeout: 20_000 });
  await shot("settings-categories-jev");
  log("settings", { jevTest: await text(page.getByTestId("jev-key-test-result")) });
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="settings-dialog"], [data-testid="ai-tab"]').first().waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
});

await step("tell-tom", async () => {
  await openThread("maintenance window");
  await draft("tell-tom", "tell tom that this is just fine");
});

await step("shorter-undo", async () => {
  await page.getByTestId("ai-strip-shorter").click();
  await page.getByTestId("ai-strip").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  await page.getByTestId("ai-strip").waitFor({ timeout: 90_000 });
  await shot("shorter-done");
  const shorter = await text(body());
  await page.getByTestId("ai-strip-undo").click();
  await page.waitForTimeout(300);
  log("shorter-undo", { shorter, afterUndo: await text(body()) });
});

await step("one-tap", async () => {
  await openThread("staging migration");
  await draft("one-tap", "");
});

await step("new-person", async () => {
  await openThread("webhook docs");
  await draft("new-person", "welcome him, webhook docs are in the wiki under /hooks/v2, thursday 2pm eastern for a call");
});

await step("stop", async () => {
  await openThread("birthday").catch(() => openThread("maintenance window"));
  await page.keyboard.press(CMD_J);
  await page.getByTestId("ai-row-input").fill("write a long and careful reply covering everything in this thread");
  await page.keyboard.press("Enter");
  await page.getByTestId("ai-preview-text").filter({ hasText: /\S/ }).waitFor({ timeout: 60_000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await shot("stop-after-esc");
  log("stop", { body: await text(body()).catch(() => "(no body)"), previewGone: !(await page.getByTestId("ai-preview").isVisible()) });
});

await step("draft-other-person", async () => {
  await openThread("maintenance window");
  await page.keyboard.press(CMD_J);
  const field = page.getByTestId("ai-row-input");
  await field.waitFor({ timeout: 5000 });
  await field.fill("ask dana when the billing deploy can go out");
  await page.keyboard.press("Enter");
  const question = page.getByTestId("ai-question");
  await question.waitFor({ timeout: 20_000 });
  await shot("draft-other-person-question");
  log("draft-other-person", { question: await text(question) });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
});

await step("thread-not-participant", async () => {
  await openThread("webhook docs");
  await page.getByTestId("compose-discard").click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.getByTestId("thread-row").filter({ hasText: "birthday" }).first().click({ timeout: 800 }).catch(() => {});
  log("thread-not-participant", { note: "routing by e2e; question screenshot above" });
});

await step("new-message", async () => {
  await page.getByTestId("compose-button").or(page.getByRole("button", { name: "Compose" })).first().click();
  await page.waitForTimeout(500);
  await page.keyboard.press(CMD_J);
  const field = page.getByTestId("ai-row-input");
  await field.waitFor({ timeout: 5000 });
  await field.fill("ask dana when the billing deploy can go out");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await shot("new-message-1");
  await page.getByTestId("ai-strip").or(page.getByTestId("ai-question")).first().waitFor({ timeout: 60_000 });
  await shot("new-message-2-done");
  log("new-message", { body: await text(body()).catch(() => ""), subject: await page.getByTestId("compose-subject").inputValue().catch(() => null), to: await text(page.getByTestId("draft-slot").first()).then((t) => t.slice(0, 90)).catch(() => null) });
});

await step("summary", async () => {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-ai").click();
  await page.getByTestId("ai-summaries").scrollIntoViewIfNeeded();
  await shot("settings-summaries");
  await page.getByTestId("ai-summaries-use").click();
  await page.waitForTimeout(500);
  await shot("settings-summaries-chosen");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await openThread("staging migration");
  await page.getByTestId("action-summarize").click();
  const go = page.getByTestId("summary-continue");
  if (await go.waitFor({ timeout: 2000 }).then(() => true).catch(() => false)) await go.click();
  const started = Date.now();
  await page.locator('[data-testid="summary-block"][data-state="ready"], [data-testid="summary-block"][data-state="error"]').waitFor({ timeout: 90_000 });
  await shot("summary-ready");
  log("summary", { ms: Date.now() - started, state: await page.getByTestId("summary-block").getAttribute("data-state"), text: await text(page.getByTestId("summary-block")) });
});

await step("writing-style", async () => {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-ai").click();
  await page.getByTestId("ai-drafting-style-open").click({ timeout: 4000 });
  await page.waitForTimeout(2500);
  await shot("writing-style");
  log("writing-style", { ok: true });
  await page.keyboard.press("Escape");
});

await step("dark", async () => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.emulateMedia({ colorScheme: "dark" });
  await openThread("maintenance window");
  await page.waitForTimeout(500);
  await shot("dark-reader");
  await page.emulateMedia({ colorScheme: "light" });
});

log("end", { problems: problems.slice(0, 20) });
await browser.close();
