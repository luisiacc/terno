import { describe, expect, it } from "vitest";
import { realTasks, spendReport } from "./harness";

/** Whether the model reads who a sentence is for: a tiny request with no mail in it. */
const CASES: { instruction: string; people: { id: string; name: string }[]; expected: string | null }[] = [
  { instruction: "tell tom that this is just fine", people: [{ id: "t", name: "Tom Reed" }], expected: "t" },
  { instruction: "ask dana when the billing deploy can go out", people: [{ id: "d", name: "Dana Whitlock" }], expected: "d" },
  { instruction: "dile a tom que está bien", people: [{ id: "t", name: "Tom Reed" }], expected: "t" },
  { instruction: "Mark the invoice as paid and say thanks", people: [{ id: "m", name: "Mark Ruiz" }], expected: null },
  { instruction: "say we will do it, tom already agreed", people: [{ id: "t", name: "Tom Reed" }], expected: null },
  { instruction: "will this work for you?", people: [{ id: "w", name: "Will Ames" }], expected: null },
];

describe("reading who an instruction is for", () => {
  it.each(CASES)("$instruction", async ({ instruction, people, expected }) => {
    const tasks = realTasks({ provider: "anthropic", model: "claude-haiku-5-5" }, "intent");
    const started = Date.now();
    const result = await tasks.parseIntent({ instruction, candidates: people });
    console.log(instruction, "→", result.recipient, `${Date.now() - started} ms`, spendReport());
    expect(result.recipient).toBe(expected);
  });
});
