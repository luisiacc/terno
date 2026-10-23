import { generateDataset } from "@unica/mock-data";
import { describe, expect, it } from "vitest";
import { corpusFromDataset } from "../conformance";
import type { IndexBatch, IndexChange, Revision, SearchFeed, SearchMessageDoc, SearchThreadDoc } from "../search";
import { InstantSearchEngine } from "./engine";
import { InstantSearch, type InstantSearchOptions } from "./service";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const data = corpusFromDataset(generateDataset({ threads: 200, accounts: 2, seed: 3, now: NOW }));

/** A store's search feed in memory: commits append absolute batches; hooks let tests interleave. */
class MemoryFeed implements SearchFeed {
  readonly messages = new Map<number, SearchMessageDoc>(data.messages.map((m) => [m.messageId, m]));
  readonly threads = new Map<number, SearchThreadDoc>(data.threads.map((t) => [t.threadId, t]));
  private log: IndexBatch[] = [];
  rev: Revision = { epoch: "mem", seq: 0 };
  heads = 0;
  /** runs once, after head() captured its answer and before it returns */
  afterHead: (() => void) | null = null;

  commit(changes: IndexChange[]): void {
    for (const c of changes) {
      if (c.kind === "upsertMessage") this.messages.set(c.doc.messageId, c.doc);
      else if (c.kind === "upsertThread") this.threads.set(c.doc.threadId, c.doc);
    }
    const from = this.rev;
    this.rev = { epoch: from.epoch, seq: from.seq + 1 };
    this.log.push({ from, to: this.rev, changes });
  }

  async head(): Promise<Revision> {
    this.heads++;
    const h = this.rev;
    const hook = this.afterHead;
    this.afterHead = null;
    hook?.();
    return h;
  }

  async changes(after: Revision, through: Revision, max: number): Promise<IndexBatch[]> {
    return this.log.filter((b) => b.to.seq > after.seq && b.to.seq <= through.seq).slice(0, max);
  }

  async beginBuild() {
    const messages = [...this.messages.values()];
    const threads = [...this.threads.values()];
    return {
      from: this.rev,
      async *messages() {
        yield messages;
      },
      async *threads() {
        yield threads;
      },
      release: async () => {},
    };
  }
}

const yieldTo = () => new Promise<void>((r) => setTimeout(r, 0));
const until = async (cond: () => boolean, ms = 2000) => {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
};

function service(feed: MemoryFeed, o: Partial<InstantSearchOptions> = {}) {
  const s = new InstantSearch({ feed, platform: { yield: yieldTo }, snapshotPath: null, identity: "test", settleMs: 0, ...o });
  s.start();
  return s;
}

const newMail = (feed: MemoryFeed): IndexChange[] => {
  const like = data.messages[0]!;
  const id = Math.max(...feed.messages.keys()) + 1;
  return [{ kind: "upsertMessage", doc: { ...like, messageId: id, subject: `nuevo ${id}` } }];
};

describe("InstantSearch", () => {
  it("a commit that lands while catching up reads the head is not lost", async () => {
    const feed = new MemoryFeed();
    const s = service(feed);
    expect(await s.settled()).toBe(true);
    // the loop reads the head, then a commit and its notification arrive before it decides to sleep
    let fired = false;
    feed.afterHead = () => {
      feed.commit(newMail(feed));
      s.notify();
      fired = true;
    };
    s.notify();
    await until(() => fired);
    expect(await s.settled(1500)).toBe(true);
    expect(s.at(feed.rev)).toBeTruthy();
    await s.close();
  });

  it("a build whose postings would exceed the peak cap gives up before allocating them", async () => {
    // what loading the messages holds, and what the finished index holds
    const probe = new InstantSearchEngine();
    probe.beginBuild({ epoch: "mem", seq: 0 });
    await probe.loadMessages(data.messages);
    probe.loadThreads(data.threads);
    const loaded = probe.allocatedBytes();
    await probe.finishBuild();
    const built = probe.allocatedBytes();
    expect(built).toBeGreaterThan(loaded);
    const peak = Math.floor((loaded + built) / 2);
    const allocations: number[] = [];
    const real = InstantSearchEngine.prototype.allocatedBytes;
    const feed = new MemoryFeed();
    const s = service(feed, { memory: { steadyBytes: 1 << 30, peakBytes: peak } });
    try {
      InstantSearchEngine.prototype.allocatedBytes = function (this: InstantSearchEngine) {
        const n = real.call(this);
        allocations.push(n);
        return n;
      };
      expect(await s.settled()).toBe(false);
    } finally {
      InstantSearchEngine.prototype.allocatedBytes = real;
    }
    expect(s.report).toMatchObject({ state: "disabled", disabled: expect.stringMatching(/peak/) });
    expect(s.at(feed.rev)).toBeNull();
    expect(Math.max(...allocations)).toBeLessThanOrEqual(peak);
    await s.close();
  });

  it("without file support it never schedules snapshot deadlines (no polling)", async () => {
    const feed = new MemoryFeed();
    const s = service(feed, { snapshotPath: "/nowhere/unica.db.search", snapshotEvery: { changes: 1e9, ms: 5 } });
    expect(await s.settled()).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    const before = feed.heads;
    await new Promise((r) => setTimeout(r, 300));
    expect(feed.heads - before).toBeLessThan(5);
    await s.close();
  });
});
