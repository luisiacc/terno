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
  const SKIPPED: Record<string, string> = { "steps-004": "a setup nudge: verify your address, then four bullets of tips" };

  it("loses no summary but the notes it means to skip: every conversation over the floor today still is", () => {
    expect(conversations.length).toBeGreaterThan(100);
    const lost: string[] = [];
    for (const c of conversations) {
      const inbound = c.messages.filter((m) => !m.own);
      const today = inbound.reduce((n, m) => n + wordsIn(m.text), 0);
      if (today < MIN_WORDS) continue;
      const email = /<([^>]+)>/.exec(inbound[0]?.from ?? "")?.[1] ?? "";
      // nobody in the corpus has written to them: a role address is a machine here, as for a stranger
      const person = (from: string) => automatedLevel({ from_email: /<([^>]+)>/.exec(from)?.[1] ?? from, list_id: null, is_bulk: 0, gmail_labels: null, is_spam: 0 }) === 0;
      const reading = inbound.reduce((n, m) => n + (person(m.from) ? wordsIn(m.text) : readingWords(m.text)), 0);
      if (reading < MIN_WORDS) lost.push(c.id);
      else expect(SKIPPED[c.id], `${c.id} ${email}`).toBeUndefined();
    }
    expect(lost).toEqual(Object.keys(SKIPPED));
  });
});
