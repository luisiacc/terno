import { describe, expect, it } from "vitest";
import { realTasks, spendReport } from "./harness";

/**
 * Plan 145's eval: labelled newsletters, ads, receipts and notifications in English and Spanish, synthetic, under the
 * harness's hard cap. Needs the owner's go-ahead: run alone with TERNO_AI_DIGEST=1. Precision on `newsletter` is the
 * bar: it decides what Archive all can touch. A human reads the lines for invented facts.
 */
const NEWSLETTERS = [
  ["Stratechery", "Why AI margins look like cloud's", "Today's article looks at gross margins at AI companies and how they compare with early cloud businesses."],
  ["Morning Brew", "Fed holds; oil down 3%", "Good morning. The Fed held rates steady, oil fell 3 percent, and here's what else you need to know today."],
  ["Pointer", "Postgres index bloat", "This week's issue: a guide to index bloat in Postgres, plus five links for engineering leaders."],
  ["El Boletín", "La semana en tecnología", "Esta semana: lo más leído sobre chips, regulación y una entrevista con una fundadora."],
  ["Hacker Newsletter", "#699: Rust in the kernel", "The best of Hacker News this week: Rust in the kernel, a history of SQLite, and more."],
];
const OTHER = [
  ["Acme Store", "48-hour sale: 30% off", "Everything's 30% off until Sunday. Shop now."],
  ["Uber Receipts", "Your Thursday trip", "Thanks for riding. Total $14.20. See your receipt."],
  ["GitHub", "[acme/api] Fix login (#1770)", "ana requested your review on this pull request."],
  ["Amazon", "Tu pedido está en camino", "Tu paquete llega mañana. Sigue tu envío."],
  ["Bank", "New sign-in to your account", "We noticed a new sign-in from a Mac. If this wasn't you, reset your password."],
  ["Rappi", "¡Hoy envío gratis!", "Pide lo que quieras con envío gratis solo por hoy."],
];

describe.skipIf(process.env.TERNO_AI_DIGEST !== "1")("the digest on a small model", () => {
  it("keeps newsletters, drops the rest, and lines say what's there", async () => {
    const tasks = realTasks({ provider: "anthropic", model: "claude-haiku-5-5" }, "digest-eval");
    const all = [...NEWSLETTERS, ...OTHER];
    const out = await tasks.digestNewsletters({ language: "English", items: all.map(([from, subject, text], i) => ({ label: `d${i + 1}`, from: from!, subject: subject!, text: text! })) });
    const kept = new Set(out.filter((i) => i.kind === "newsletter").map((i) => i.label));
    const right = NEWSLETTERS.filter((_, i) => kept.has(`d${i + 1}`)).length;
    const wrong = OTHER.filter((_, i) => kept.has(`d${NEWSLETTERS.length + i + 1}`)).length;
    process.stderr.write(`kept ${right}/${NEWSLETTERS.length}, wrongly kept ${wrong}/${OTHER.length}\n${out.map((i) => `${i.label} ${i.line}`).join("\n")}\n${spendReport()}\n`);
    expect(wrong).toBe(0);
    expect(right / NEWSLETTERS.length).toBeGreaterThanOrEqual(0.8);
  }, 180_000);
});
