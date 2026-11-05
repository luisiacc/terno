/** Plan 18: a commit of thousands of new people doesn't hold the loop (timed alone; service.test.ts holds the slices by count). */
import { expect, it } from "vitest";
import type { AutocompleteSource, ContactBatch, ContactMessage } from "../autocomplete-source";
import type { Revision } from "../search";
import { Autocomplete } from "./service";

const rev = (seq: number): Revision => ({ epoch: "e", seq });

it("applies a commit of 12,000 new people with no stretch over 60 ms", async () => {
  const people: ContactMessage[] = Array.from({ length: 12_000 }, (_, i) => ({ id: i + 1, accountId: 1, date: Date.UTC(2026, 0, 1), sent: false, spam: false, draft: false, from: { name: `Person ${i} Surname${i}`, email: `p${i}.someone@x${i % 50}.io` }, to: [], cc: [], bcc: [], hasBody: false }));
  let head = 0;
  const source: AutocompleteSource = {
    snapshotBase: null,
    identity: "scripted",
    head: async () => rev(head),
    changes: async (after, through): Promise<ContactBatch[]> => (through.seq > after.seq ? [{ from: after, to: through, messages: people, removed: [], spamSenders: [] }] : []),
    beginBuild: async () => ({ from: rev(head), messages: async function* () {}, release: async () => {} }),
    sentAfter: async () => ({ texts: [], next: null }),
    sentTexts: async () => [],
  };
  let resumed = performance.now();
  let longest = 0;
  const ac = new Autocomplete({
    source,
    phrases: false,
    settleMs: 0,
    platform: {
      yield: async () => {
        longest = Math.max(longest, performance.now() - resumed);
        await new Promise((r) => setTimeout(r, 0));
        resumed = performance.now();
      },
    },
  });
  await ac.warm();
  longest = 0;
  head++;
  ac.notify();
  await ac.idle();
  expect(ac.suggestRecipients("person 11999").items).toHaveLength(1);
  expect(longest).toBeLessThan(60);
  await ac.close();
});
