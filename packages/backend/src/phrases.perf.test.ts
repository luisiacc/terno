/**
 * Plan 133 review: counting phrases can't hold the event loop. A step of the generator is the most a slicing caller can
 * be late by, and on a corpus where tens of thousands of sequences qualify, sorting them all took 140 ms in one step.
 */
import { phraseSteps, stockPhrases, type WrittenMail } from "@terno/core";
import { expect, it } from "vitest";

const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");

/**
 * Thousands of different passages, each landing in a few messages to different people: nearly every sequence in them
 * qualifies, so tens of thousands reach the selection, which is what a whole-map sort couldn't take.
 */
function corpus(messages: number): WrittenMail[] {
  const letter = (n: number) => String.fromCharCode(97 + (n % 26));
  const pool = Array.from({ length: 5000 }, (_, i) => `w${letter(i)}${letter(i >> 2)}${letter(i >> 4)}${letter(i >> 6)}${letter(i >> 8)}`);
  let seed = 233;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 8;
  const PASSAGES = 2400;
  const passage = (index: number) => Array.from({ length: 12 }, (_, i) => pool[(index * 13 + i * (index % 97) + i) % pool.length]!).join(" ");
  return Array.from({ length: messages }, (_, id) => {
    const sentences = Array.from({ length: 34 }, () => `${passage(next() % PASSAGES)}.`);
    return { id, text: sentences.join(" "), to: [`r${id % 40}@x.test`], cc: [], at: id, isReply: false, bulk: false, greeting: null, signOff: null, words: 400, language: "en" } as unknown as WrittenMail;
  });
}

it("no step of counting phrases takes more than the slicer's budget, on 300 messages where most sequences qualify", () => {
  const steps = phraseSteps(corpus(300));
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

it("past the bound it still finds what's used most, the same each time", () => {
  const mails = corpus(120);
  const first = stockPhrases(mails);
  expect(first.length).toBeGreaterThan(0);
  expect(stockPhrases([...mails])).toEqual(first);
});
