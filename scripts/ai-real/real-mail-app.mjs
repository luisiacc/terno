// The real app in a real browser, on a copy of a real mailbox with its tokens removed (real-mail.real.ts says how the
// copy is made). The backend behind it has no mail provider, and every model request is held to the spend ledger.
// What to open comes from outside the repo (TERNO_REAL_MAIL_DIR/app-cases.json), and nothing is ever sent.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { refusalToTypeKeys } from "../../apps/backend-dev/src/proof-guard.ts";

const DIR = process.env.TERNO_REAL_MAIL_DIR ?? "/tmp/terno-ai/real-mail";
const OUT = join(DIR, "app");
const URL_ = process.env.PROOF_URL ?? "http://127.0.0.1:5183/?backend=ws://127.0.0.1:5184";
const assertGuarded = () => {
  const refusal = refusalToTypeKeys(URL_);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
};
assertGuarded();

const require = createRequire(resolve("apps/web/package.json"));
const { chromium } = require("@playwright/test");
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(readFileSync(".env", "utf8").split(/\r?\n/).map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^(["'])(.*)\1$/, "$2")]));
const { replies, fromList } = JSON.parse(readFileSync(join(DIR, "app-cases.json"), "utf8"));

const report = [];
const log = (step, data) => {
  report.push({ step, ...data });
  console.log(step, JSON.stringify(data).slice(0, 400));
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1320, height: 860 }, colorScheme: "light", locale: "es-CR" });
const page = await context.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`console: ${m.text().slice(0, 300)}`);
});
const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) });
const CMD_J = "ControlOrMeta+j";
const body = () => page.getByTestId("compose-body").first();
const text = async (l) => (await l.innerText()).trim();

async function step(name, fn) {
  try {
    await fn();
  } catch (error) {
    await shot(`FAILED-${name}`).catch(() => {});
    log(name, { failed: String(error).slice(0, 500) });
  }
}

async function openBySearch(query) {
  await page.keyboard.press("/");
  await page.getByTestId("search-input").fill(query);
  const row = page.getByTestId("thread-row").first();
  await page.waitForTimeout(500);
  await row.click();
  await page.getByTestId("reader-subject").waitFor();
}

const started = Date.now();
await page.goto(URL_);
await page.locator("[data-ready]").waitFor({ timeout: 60_000 });
await page.getByTestId("thread-row").first().waitFor({ timeout: 30_000 });
log("open", { firstRowMs: Date.now() - started });
await shot("01-inbox");

await step("list-j", async () => {
  await page.getByTestId("thread-row").first().click();
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__long.push(Math.round(e.duration));
    }).observe({ type: "longtask" });
  });
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) await page.keyboard.press("j");
  const ms = Date.now() - t0;
  await page.waitForTimeout(600);
  const long = await page.evaluate(() => window.__long);
  log("list-j", { messagesOpened: 60, ms, longTasks: long.length, worstMs: long.length ? Math.max(...long) : 0 });
  await shot("02-after-j");
  await page.keyboard.press("Escape");
});

await step("settings", async () => {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-ai").click();
  await page.getByTestId("ai-provider").click();
  await page.getByTestId("ai-choice-keys").click();
  assertGuarded();
  // plan 168: both keys under one item; Terno picks the model for each feature
  await page.getByTestId("ai-key-anthropic").fill(env.ANTHROPIC_API_KEY);
  await page.keyboard.press("Enter");
  await page.getByTestId("ai-key-anthropic").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(400);
  assertGuarded();
  await page.getByTestId("ai-key-openai").fill(env.OPENAI_API_KEY);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  await shot("03-settings-ai");
  log("settings", { ok: true });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
});

for (const c of replies) {
  await step(`draft-${c.name}`, async () => {
    await openBySearch(c.query);
    await shot(`10-${c.name}-thread`);
    await page.keyboard.press(CMD_J);
    const field = page.getByTestId("ai-row-input");
    await field.waitFor({ timeout: 8000 });
    await field.fill(c.instruction);
    const asked = Date.now();
    await page.keyboard.press("Enter");
    const preview = page.getByTestId("ai-preview-text");
    await preview.filter({ hasText: /\S/ }).waitFor({ timeout: 60_000 });
    const firstWordMs = Date.now() - asked;
    await shot(`11-${c.name}-streaming`);
    const strip = page.getByTestId("ai-strip");
    let last = null;
    while (!(await strip.isVisible()) && Date.now() - asked < 60_000) {
      const box = await preview.boundingBox().catch(() => null);
      if (box) last = box;
      await page.waitForTimeout(150);
    }
    const finishedMs = Date.now() - asked;
    const box = await body().boundingBox();
    await shot(`12-${c.name}-done`);
    const draft = await text(body());
    await page.getByTestId("ai-strip-undo").click();
    await page.waitForTimeout(250);
    const afterUndo = await text(body()).catch(() => "");
    log(`draft-${c.name}`, { firstWordMs, finishedMs, jump: last && box ? Math.round(box.y - last.y) : null, draft, undoEmpty: afterUndo === "" });
    await page.keyboard.press("Escape");
    await page.getByTestId("compose-discard").click({ timeout: 1500 }).catch(() => {});
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /Clear search|Limpiar/ }).click({ timeout: 1500 }).catch(() => {});
  });
}

for (const c of fromList) {
  await step(`list-${c.name}`, async () => {
    await page.getByRole("button", { name: /^(Compose|Escribir)/ }).first().click();
    await page.waitForTimeout(400);
    await page.keyboard.press(CMD_J);
    const field = page.getByTestId("ai-row-input");
    await field.waitFor({ timeout: 8000 });
    await field.fill(c.instruction);
    const asked = Date.now();
    await page.keyboard.press("Enter");
    const question = page.getByTestId("ai-question");
    const strip = page.getByTestId("ai-strip");
    await question.or(strip).first().waitFor({ timeout: 40_000 });
    let asks = null;
    if (await question.isVisible()) {
      asks = await text(question);
      await shot(`20-${c.name}-question`);
      await page.keyboard.press("Enter");
      await strip.waitFor({ timeout: 40_000 });
    }
    await shot(`21-${c.name}-done`);
    log(`list-${c.name}`, { ms: Date.now() - asked, asks, draft: await text(body()) });
    await page.keyboard.press("Escape");
    await page.getByTestId("compose-discard").click({ timeout: 1500 }).catch(() => {});
    await page.keyboard.press("Escape");
  });
}

await step("summary", async () => {
  await openBySearch(replies[0].query);
  await page.getByRole("button", { name: /Summarize|Resumir/ }).first().click();
  const asked = Date.now();
  await page.getByTestId("summary-text").waitFor({ timeout: 60_000 });
  await shot("31-summary");
  log("summary", { ms: Date.now() - asked, summary: await text(page.getByTestId("summary-text")) });
});

await step("dark", async () => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await shot("40-dark");
});

log("problems", { problems });
await browser.close();
