import { describe, expect, it } from "vitest";
import { realTasks, spendReport } from "./harness";

/**
 * Plan 144's eval: `needsReply` on labelled synthetic mail, in English and Spanish, under the harness's hard cap. Needs
 * the owner's go-ahead: run alone with TERNO_AI_REPLIES=1. A false no costs a missed draft and a false yes a few cents,
 * so it should lean to yes. The owner's read on a copy of a real profile is the release gate, separately.
 */
const WANTS = [
  "Can you make the 19th instead?",
  "¿Te viene bien el jueves a las 10?",
  "Could you send me the signed copy when you get a chance?",
  "Let me know what you think of the second option.",
  "Necesito que me confirmes la dirección de envío.",
  "We'd like to move forward. What are the next steps on your side?",
  "Are you free for a quick call this week?",
  "¿Me mandas el presupuesto actualizado?",
  "I'm not sure which version you meant, the March one or the April one?",
  "Hope you're well. I wanted to ask whether you'd be open to speaking at our meetup.",
];
const NOT = [
  "Thanks!",
  "Gracias, recibido.",
  "Thank you so much, that's perfect.",
  "FYI, the office is closed on Monday.",
  "Para tu información, ya está pagado.",
  "Got it, will do.",
  "Sounds good, talk soon.",
  "Perfecto, muchas gracias.",
  "Just letting you know the package arrived.",
  "No need to reply, this is only for your records.",
];

describe.skipIf(process.env.TERNO_AI_REPLIES !== "1")("does it want a reply, on a small model", () => {
  const tasks = () => realTasks({ provider: "anthropic", model: "claude-haiku-5-5" }, "replies-eval");
  const read = (newest: string) => tasks().needsReply({ from: "Ana <ana@acme.test>", subject: "The 19th", newest });

  it("leans to yes, and drops thanks and FYIs", async () => {
    let yes = 0;
    let falseYes = 0;
    for (const text of WANTS) if (await read(text)) yes++;
    for (const text of NOT) if (await read(text)) falseYes++;
    process.stderr.write(`wanted ${yes}/${WANTS.length}, false yes ${falseYes}/${NOT.length}\n${spendReport()}\n`);
    expect(yes / WANTS.length).toBeGreaterThanOrEqual(0.95);
    expect(falseYes / NOT.length).toBeLessThanOrEqual(0.3);
  }, 300_000);
});
