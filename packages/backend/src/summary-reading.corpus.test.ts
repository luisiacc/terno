import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { automatedLevel, readingWords, wordsIn } from "@terno/core";
import { describe, expect, it } from "vitest";

/** The summary worker's floor (summaries.ts). */
const MIN_WORDS = 60;

interface CorpusConversation {
  id: string;
  messages: { from: string; own: boolean; text: string }[];
}

describe("the fictional corpus (plan 269)", () => {
  const dir = join(import.meta.dirname, "../../../scripts/ai-real/corpus/synthetic");
  const conversations: CorpusConversation[] = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CorpusConversation));

  /** what the corpus has that plan 269 means to skip: a machine's short note with nothing to read past its template */
  const SKIPPED: Record<string, string> = { "steps-004#0": "a setup nudge: verify your address, then four bullets of tips" };
  const address = (from: string) => /<([^>]+)>/.exec(from)?.[1] ?? from;
  // nobody in the corpus has written to them: a role address is a machine here, as for a stranger
  const machine = (from: string) => automatedLevel({ from_email: address(from), list_id: null, is_bulk: 0, gmail_labels: null, is_spam: 0 }) > 0;

  it("loses no summary but the notes it means to skip: each machine's message that reaches the floor alone still does", () => {
    expect(conversations.length).toBeGreaterThan(100);
    const lost: string[] = [];
    let read = 0;
    for (const c of conversations) {
      // each one as if it arrived alone, the worker's hardest case: no other new message adds its words
      c.messages.forEach((m, i) => {
        if (m.own || !machine(m.from) || wordsIn(m.text) < MIN_WORDS) return;
        read++;
        const id = `${c.id}#${i}`;
        if (readingWords(m.text) < MIN_WORDS) lost.push(id);
        else expect(SKIPPED[id], `${id} ${address(m.from)}`).toBeUndefined();
      });
    }
    // few: the corpus is mostly people; the paired templates in core's reading tests are the real check
    expect(read).toBeGreaterThanOrEqual(4);
    expect(lost).toEqual(Object.keys(SKIPPED));
  });
});
