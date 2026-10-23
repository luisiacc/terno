import type { IndexBatch, Revision, SearchFeed, SearchMessageDoc, SearchThreadDoc } from "../search";

/**
 * A reference consumer of the search feed, with the rules every cached engine
 * must follow: build from a retained start revision, then apply absolute
 * batches in order; ignore duplicates, refuse gaps and other epochs.
 */
export class SearchReplica {
  readonly messages = new Map<number, SearchMessageDoc>();
  readonly threads = new Map<number, SearchThreadDoc>();
  revision: Revision;

  private constructor(revision: Revision) {
    this.revision = revision;
  }

  static async build(feed: SearchFeed): Promise<SearchReplica> {
    const build = await feed.beginBuild();
    try {
      const r = new SearchReplica(build.from);
      for await (const page of build.messages()) for (const d of page) r.messages.set(d.messageId, d);
      for await (const page of build.threads()) for (const d of page) r.threads.set(d.threadId, d);
      // rows changed while the scan ran are repaired by replaying (from, head]
      await r.catchUp(feed);
      return r;
    } finally {
      await build.release();
    }
  }

  apply(batch: IndexBatch): "applied" | "duplicate" {
    if (batch.to.epoch !== this.revision.epoch || batch.from.epoch !== this.revision.epoch) throw new Error("epoch mismatch");
    if (batch.to.seq <= this.revision.seq) return "duplicate";
    if (batch.from.seq !== this.revision.seq) throw new Error(`gap: at ${this.revision.seq}, batch from ${batch.from.seq}`);
    for (const c of batch.changes) {
      if (c.kind === "upsertMessage") this.messages.set(c.doc.messageId, c.doc);
      else if (c.kind === "removeMessage") this.messages.delete(c.messageId);
      else if (c.kind === "upsertThread") this.threads.set(c.doc.threadId, c.doc);
      else this.threads.delete(c.threadId);
    }
    this.revision = batch.to;
    return "applied";
  }

  async catchUp(feed: SearchFeed, maxCommits = 50): Promise<number> {
    let applied = 0;
    for (;;) {
      const head = await feed.head();
      if (head.seq === this.revision.seq) return applied;
      for (const b of await feed.changes(this.revision, head, maxCommits)) if (this.apply(b) === "applied") applied++;
    }
  }

  docs(): { messages: SearchMessageDoc[]; threads: SearchThreadDoc[] } {
    return {
      messages: [...this.messages.values()].sort((a, b) => a.messageId - b.messageId),
      threads: [...this.threads.values()].sort((a, b) => a.threadId - b.threadId),
    };
  }
}
