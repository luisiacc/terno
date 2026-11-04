/**
 * Plan 133 review: counting phrases can't hold the event loop. A step of the generator is the most a slicing caller can
 * be late by, and on a corpus where tens of thousands of sequences qualify, sorting them all was 140 ms in one step.
 */
import { expect, it } from "vitest";
import { phraseSteps, stockPhrases } from "./habits";
import type { WrittenMail } from "./extract";

const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");

/** Words drawn so that sequences recur across many messages and recipients: as many qualify as a real corpus could. */
function corpus(messages: number): WrittenMail[] {
  const pool = Array.from({ length: 180 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))}`);
  let seed = 233;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const passage = (from: number) => Array.from({ length: 12 }, (_, i) => pool[(from + i * (1 + (from % 3))) % pool.length]!).join(" ");
  return Array.from({ length: messages }, (_, id) => {
    const sentences = Array.from({ length: 34 }, () => `${passage(next() % pool.length)}.`);
    return { id, text: sentences.join(" "), to: [`r${id % 40}@x.test`], cc: [], at: id, isReply: false, bulk: false, greeting: null, signOff: null, words: 400, language: "en" } as unknown as WrittenMail;
  });
}

it("no step of counting phrases takes more than the slicer's budget, on 300 messages where most sequences qualify", () => {
  const mails = corpus(300);
  const steps = phraseSteps(mails);
  let longest = 0;
  let count = 0;
  for (;;) {
    const at = performance.now();
    const step = steps.next();
    longest = Math.max(longest, performance.now() - at);
    count++;
    if (step.done) {
      expect(step.value.length).toBeGreaterThan(0);
      break;
    }
  }
  process.stderr.write(`[phrases] ${count} steps, longest ${longest.toFixed(2)} ms\n`);
  expect(longest).toBeLessThanOrEqual(8 * MULT);
});

it("over the bound it still finds what's used most, the same each time", () => {
  const mails = corpus(120);
  const first = stockPhrases(mails);
  expect(first.length).toBeGreaterThan(0);
  expect(stockPhrases([...mails])).toEqual(first);
});
