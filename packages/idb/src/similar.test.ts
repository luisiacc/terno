import "fake-indexeddb/auto";
import type { Platform } from "@terno/store";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { expect, it } from "vitest";
import { T, type Ctx } from "./mail";
import { IdbMailStore } from "./store";

const platform: Pick<Platform, "uuid" | "yield"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)) };

/** Plan 63: a sweep's pages walk the index once between them: each message is read once, however many pages. */
it("a sweep's later pages read on from where the last stopped (each message once), and a lost cursor starts over", async () => {
  const store = await IdbMailStore.open({ name: `similar-${Date.now()}`, factory: indexedDB, platform, instantSearch: false });
  try {
    const [acct] = await withAccounts(store, 1);
    await ingest(store, Array.from({ length: 10 }, () => msg({ accountId: acct!, from: { name: "Bot", email: "bot@b.com" } })));
    // every index entry a page walks, through either way of reading the index
    const messages = T((store as unknown as { c: Ctx }).c, "messages");
    let walked = 0;
    const counting = <V,>(it: Iterator<V>): IterableIterator<V> => ({
      next: () => {
        const r = it.next();
        if (!r.done) walked++;
        return r;
      },
      [Symbol.iterator]() {
        return this;
      },
    });
    const keysBy = messages.keysBy.bind(messages);
    const bucket = messages.bucket.bind(messages);
    messages.keysBy = (...a: Parameters<typeof keysBy>) => counting(keysBy(...a));
    messages.bucket = (...a: Parameters<typeof bucket>) => {
      const b = bucket(...a);
      return b && ({ size: b.size, has: (k: unknown) => b.has(k as never), [Symbol.iterator]: () => counting(b.values()), values: () => counting(b.values()) } as unknown as ReturnType<typeof bucket>);
    };
    const scope = { kind: "sender", email: "bot@b.com" } as const;
    const ids = new Set<number>();
    let pages = 0;
    for (let cursor: number | null = null; ; pages++) {
      const p = await store.similar.resolvePage(scope, "archive", [], cursor, 3);
      p.ids.forEach((id) => ids.add(id));
      if (p.next === null) break;
      cursor = p.next;
    }
    expect(ids.size).toBe(10);
    expect(pages).toBe(3);
    expect(walked).toBe(10);
    // a cursor this store doesn't know (a restart, too many sweeps at once): the walk starts over, nothing is lost
    const again = await store.similar.resolvePage(scope, "archive", [], 987_654, 100);
    expect(again.ids).toHaveLength(10);
  } finally {
    await store.close();
  }
});
