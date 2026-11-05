import { expect } from "vitest";
import { msg } from "./fixtures";
import { expectMailbox, type WorkloadMailbox } from "./perf";

/**
 * Plan 133 at 50k+ threads, the same workload on both stores. A draft's reads: profiles by identity, `sentTo` with
 * thousands of adversarial look-alikes in the way, `threadsWith`, a thread's context; the learner's: a page of headers,
 * what a page's bodies cost. Each follows what it's asked for, never the mailbox.
 */
export async function measureWriting(o: WorkloadMailbox): Promise<void> {
  const { store, accountId } = o;
  await expectMailbox(o, {});
  const seedStart = performance.now();
  const me = { name: "Me", email: "me@perf.test" };
  const tom = { name: "Tom", email: "tom@acme.test" };
  // the phrase for tom@acme.test also matches x.tom@acme.test, 6,000 times
  for (let slice = 0; slice < 6; slice++) {
    await store.sync.ingest(Array.from({ length: 1000 }, (_, i) => msg({ accountId, from: me, to: [{ name: "X", email: "x.tom@acme.test" }], isSent: true, inInbox: false, bodyText: "Sounds good.", subject: `Look-alike ${slice}-${i}`, date: o.now - 1000 * i })), { applyFilters: false, now: o.now, classifier: null });
  }
  // the real ones, sent long ago so nothing about their order helps, and a long conversation to read
  const real = Array.from({ length: 40 }, (_, i) => msg({ accountId, from: me, to: [tom], isSent: true, inInbox: false, bodyText: "Thanks Tom, that works for me.", providerMsgId: `real-${i}`, rfcMessageId: `real-${i}@perf.test`, inReplyTo: i ? `real-${i - 1}@perf.test` : null, references: i ? [`real-${i - 1}@perf.test`] : [], subject: "A long one", date: o.now - 86_400_000 * 90 + i }));
  const { inserted } = await store.sync.ingest(real, { applyFilters: false, now: o.now, classifier: null });
  await store.sync.ingest(Array.from({ length: 2 }, (_, i) => msg({ accountId, from: tom, to: [me], bodyText: "Sure.", providerMsgId: `in-${i}`, rfcMessageId: `in-${i}@perf.test`, inReplyTo: `real-39@perf.test`, references: ["real-39@perf.test"], subject: "A long one", date: o.now - 3600_000 + i, inInbox: true })), { applyFilters: false, now: o.now, classifier: null });
  const profiles = Array.from({ length: 1500 }, (_, i) => ({ scope: "person" as const, scopeKey: `person:${accountId}:p${i}@x.test`, language: "", accountId, habitsJson: JSON.stringify({ messages: i }), phrasesJson: "[]", samples: 5 }));
  o.log(`6,000 look-alikes and a conversation written in ${(performance.now() - seedStart).toFixed(0)} ms`);
  const commitStart = performance.now();
  await store.writing.profiles.commit({ upserts: profiles.slice(0, 250), replaceAccount: accountId, state: { "writing:perf": { window: Array.from({ length: 3000 }, (_, i) => i) } }, now: o.now });
  const commitMs = performance.now() - commitStart;
  await store.writing.profiles.commit({ upserts: profiles.slice(250), state: {}, now: o.now });

  const threadId = (await store.writing.sentTo({ addresses: [tom.email], accountId, limit: 1 })).refs[0]!.threadId;
  const timed = async (n: number, work: (i: number) => Promise<unknown>) => {
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const start = performance.now();
      await work(i);
      times.push(performance.now() - start);
    }
    return [...times].sort((a, b) => a - b)[Math.ceil(n * 0.95) - 1]!;
  };

  const sentTo = await timed(20, async () => {
    const r = await store.writing.sentTo({ addresses: [tom.email], accountId, limit: 24 });
    expect(r.state).toBe("found");
    expect(r.refs.length).toBe(24);
  });
  const threadsWith = await timed(20, () => store.writing.threadsWith({ address: tom.email, accountId, limit: 8 }));
  const context = await timed(20, async () => {
    const c = (await store.writing.threadContext(threadId, { maxBodies: 21, maxChars: 96_000 }))!;
    expect(c.messages.length).toBe(42);
  });
  const profileReads = await timed(40, (i) => store.writing.profiles.read([{ scopeKey: "you", language: "es" }, { scopeKey: "you", language: "" }, { scopeKey: `account:${accountId}`, language: "" }, { scopeKey: `person:${accountId}:p${i}@x.test`, language: "" }]));
  const headers = await timed(20, async () => {
    const page = await store.writing.corpus.headers({ accountId, limit: 200 });
    expect(page.length).toBe(200);
  });
  const texts = await timed(20, async (i) => {
    await store.writing.corpus.texts(inserted.slice(i % 20, (i % 20) + 16));
  });
  o.log(`p95: sentTo through 6,000 look-alikes ${sentTo.toFixed(2)} ms, threadsWith ${threadsWith.toFixed(2)} ms, threadContext (42 messages) ${context.toFixed(2)} ms, 4 profile reads ${profileReads.toFixed(2)} ms, headers(200) ${headers.toFixed(2)} ms, 16 bodies ${texts.toFixed(2)} ms, a pass's commit (250 rows, 3,000 ids) ${commitMs.toFixed(2)} ms`);
  expect(sentTo).toBeLessThanOrEqual(150 * o.budget);
  expect(threadsWith).toBeLessThanOrEqual(150 * o.budget);
  expect(context).toBeLessThanOrEqual(20 * o.budget);
  expect(profileReads).toBeLessThanOrEqual(3 * o.budget);
  expect(headers).toBeLessThanOrEqual(25 * o.budget);
  expect(texts).toBeLessThanOrEqual(15 * o.budget);
  expect(commitMs).toBeLessThanOrEqual(80 * o.budget);
}
