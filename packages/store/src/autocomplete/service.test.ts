/**
 * The service over a scripted source (plan 18): a commit carrying thousands
 * of new people is applied in slices, with merges and caps inside (Codex
 * review: it was applied in one go, the delta growing far past its
 * threshold).
 */
import { describe, expect, it } from "vitest";
import type { AutocompleteSource, ContactBatch, ContactMessage } from "../autocomplete-source";
import type { Revision } from "../search";
import { Autocomplete } from "./service";

const rev = (seq: number): Revision => ({ epoch: "e", seq });

function source(batch: () => ContactMessage[]): AutocompleteSource & { commit(): void } {
  let head = 0;
  return {
    snapshotBase: null,
    identity: "scripted",
    head: async () => rev(head),
    changes: async (after, through): Promise<ContactBatch[]> => (through.seq > after.seq ? [{ from: after, to: through, messages: batch(), removed: [], spamSenders: [] }] : []),
    beginBuild: async () => ({ from: rev(head), messages: async function* () {}, release: async () => {} }),
    sentAfter: async () => ({ texts: [], next: null }),
    sentTexts: async () => [],
    commit: () => void head++,
  };
}

describe("the service", () => {
  it("applies a commit of 12,000 new people in slices, the delta near its threshold", async () => {
    const people: ContactMessage[] = Array.from({ length: 12_000 }, (_, i) => ({ id: i + 1, accountId: 1, date: Date.UTC(2026, 0, 1), sent: false, spam: false, draft: false, from: { name: `Person ${i} Surname${i}`, email: `p${i}.someone@x${i % 50}.io` }, to: [], cc: [], bcc: [], hasBody: false }));
    const src = source(() => people);
    let resumed = performance.now();
    let longest = 0;
    let maxDelta = 0;
    const ac = new Autocomplete({
      source: src,
      phrases: false,
      settleMs: 0,
      platform: {
        yield: async () => {
          longest = Math.max(longest, performance.now() - resumed);
          maxDelta = Math.max(maxDelta, (ac as unknown as { contacts: { deltaSize: number } | null }).contacts?.deltaSize ?? 0);
          await new Promise((r) => setTimeout(r, 0));
          resumed = performance.now();
        },
      },
    });
    await ac.warm();
    longest = 0;
    src.commit();
    ac.notify();
    await ac.idle();
    expect(ac.suggestRecipients("person 11999").items).toHaveLength(1);
    // without slicing: one stretch for all 12,000 and a delta of ~60,000 tokens
    expect(maxDelta).toBeLessThan(4096 + 64 * 8);
    expect(longest).toBeLessThan(60);
    await ac.close();
  });
});
