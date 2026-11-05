import { buildAskSearch, type AskPlanQuery } from "@terno/core";
import { expect } from "vitest";
import { ASK_MAX_CHARS, ASK_MESSAGES_MAX, type AskTurnWrite } from "../ask";
import { msg, threadOf } from "./fixtures";
import { expectMailbox, type WorkloadMailbox } from "./perf";

/**
 * Plan 141 at 50k+ threads, the same workload on both stores: three queries and their passages, including a term in an
 * old message of a 5,000-message thread and one in a captured body's tail, and a word that's nowhere. What it costs
 * follows what the question found, never the mailbox. History: reading the 100 rows, and the insert with its prune.
 */
export async function measureAsk(o: WorkloadMailbox, limits: { totalMs: number; passagesMs: number; stallMs: number | null; settled?: () => Promise<unknown> }): Promise<void> {
  const { store, accountId } = o;
  await expectMailbox(o, {});
  const now = o.now;
  const seedStart = performance.now();
  const chain = (i: number) => ({ subject: "The long one", providerMsgId: `ask-${i}`, rfcMessageId: `ask-${i}@perf.test`, inReplyTo: i ? `ask-${i - 1}@perf.test` : null, references: i ? [`ask-${i - 1}@perf.test`] : [], date: now - 86_400_000 * 400 + i * 1000 });
  for (let slice = 0; slice < 5; slice++) {
    await store.sync.ingest(Array.from({ length: 1000 }, (_, i) => {
      const at = slice * 1000 + i;
      return msg({ accountId, ...chain(at), bodyText: at === 40 ? "The zzlease clause says it renews on 1 March." : "Sounds good, thanks." });
    }), { applyFilters: false, now, classifier: null });
  }
  const long = await threadOf(store, "ask-0");
  const tail = `${"plenty of filler words here ".repeat(4000)}The zzdoor code is 4921.`;
  await store.sync.ingest([msg({ accountId, subject: "House notes", providerMsgId: "ask-captured", bodyText: tail, date: now - 86_400_000 * 30 })], { applyFilters: false, now, classifier: null });
  const captured = await threadOf(store, "ask-captured");
  o.log(`a 5,000-message thread and a captured body written in ${(performance.now() - seedStart).toFixed(0)} ms`);

  await limits.settled?.();
  const search = (plan: AskPlanQuery) => buildAskSearch(plan, now)!;
  const page = (plan: AskPlanQuery) => store.threads.search({ search: search(plan), limit: 40 });
  const timed = async (n: number, work: () => Promise<unknown>) => {
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const start = performance.now();
      await work();
      times.push(performance.now() - start);
    }
    return [...times].sort((a, b) => a - b)[Math.ceil(n * 0.95) - 1]!;
  };

  const question = async (plans: AskPlanQuery[]) => {
    const pages = await Promise.all(plans.map(page));
    const threadIds = [...new Set(pages.flatMap((p) => p.items.map((t) => t.id)))];
    return store.ask.passages({ threadIds, queries: plans.map(search), maxMessages: ASK_MESSAGES_MAX, maxChars: ASK_MAX_CHARS });
  };

  const inOld = await question([{ terms: ["zzlease"] }]);
  expect(inOld.messages[0]!.text).toContain("renews on 1 March");
  expect(inOld.messages[0]!.threadId).toBe(long);
  const inTail = await question([{ terms: ["zzdoor code"] }]);
  expect(inTail.messages[0]!.threadId).toBe(captured);
  expect(inTail.messages[0]!.text).toContain("4921");

  // what a found thread costs, whatever the search underneath it took
  const longPage = await page({ terms: ["zzlease"] });
  const passagesOnly = await timed(5, () => store.ask.passages({ threadIds: longPage.items.map((t) => t.id), queries: [search({ terms: ["zzlease"] })], maxMessages: ASK_MESSAGES_MAX, maxChars: ASK_MAX_CHARS }));
  const capturedPage = await page({ terms: ["zzdoor code"] });
  const passagesCaptured = await timed(5, () => store.ask.passages({ threadIds: capturedPage.items.map((t) => t.id), queries: [search({ terms: ["zzdoor code"] })], maxMessages: ASK_MESSAGES_MAX, maxChars: ASK_MAX_CHARS }));
  const typical = await timed(5, () => question([{ terms: ["hola"] }, { terms: [], anyOf: [["hola", "factura"]] }, { terms: ["factura"], after: "2026-01-01" }]));
  const oldMessage = await timed(5, () => question([{ terms: ["zzlease"] }]));
  const inBody = await timed(5, () => question([{ terms: ["zzdoor code"] }]));
  const nowhere = await timed(5, () => question([{ terms: ["qqqnosuchword"] }]));

  const write = (i: number): AskTurnWrite => ({ conversationId: null, kind: "question", question: `q${i}`, answer: "a".repeat(2000), status: "answered", sources: [], queries: [{ terms: ["x"] }], checks: { unlinked: false, unsupported: [] }, accountIds: [accountId], model: "m", provider: "p", promptVersion: 1, now: now + i, clearGeneration: store.ask.history.clearGeneration() });
  let n = 0;
  for (; n < 100; n++) await store.ask.history.add(write(n));
  const addPruned = await timed(10, () => store.ask.history.add(write(n++)));
  const readList = await timed(10, () => store.ask.history.list());
  expect(await store.ask.history.list()).toHaveLength(100);
  o.log(`Ask: three queries and passages ${typical.toFixed(1)} ms; a word in the 41st of 5,000 messages ${oldMessage.toFixed(1)} ms; in a captured body's tail ${inBody.toFixed(1)} ms; nowhere ${nowhere.toFixed(1)} ms; history read ${readList.toFixed(2)} ms, add with its prune ${addPruned.toFixed(2)} ms`);
  o.log(`Ask: passages alone: the long thread ${passagesOnly.toFixed(1)} ms, a captured tail ${passagesCaptured.toFixed(1)} ms`);
  expect(passagesOnly).toBeLessThanOrEqual(limits.passagesMs * o.budget);
  expect(passagesCaptured).toBeLessThanOrEqual(limits.passagesMs * o.budget);
  expect(typical).toBeLessThanOrEqual(limits.totalMs * o.budget);
  expect(oldMessage).toBeLessThanOrEqual(limits.totalMs * o.budget);
  expect(inBody).toBeLessThanOrEqual(limits.totalMs * o.budget);
  expect(nowhere).toBeLessThanOrEqual(limits.totalMs * o.budget);
  expect(readList).toBeLessThanOrEqual(5 * o.budget);
  if (limits.stallMs !== null) {
    // what a frame sees: the longest the event loop was held while a whole question was read
    let last = performance.now();
    let worst = 0;
    let ticking = true;
    const tick = () => {
      const at = performance.now();
      worst = Math.max(worst, at - last);
      last = at;
      if (ticking) setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    await question([{ terms: ["zzlease"] }]);
    ticking = false;
    o.log(`Ask: the longest hold during a read of the long thread ${worst.toFixed(1)} ms`);
    expect(worst).toBeLessThanOrEqual(limits.stallMs * o.budget);
  }
}
