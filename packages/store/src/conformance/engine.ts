import { normalizeText, parseSearch, resolveSearch, tokenize } from "@unica/core";
import type { MockDataset } from "@unica/mock-data";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CachedSearchEngine, IndexBatch, IndexChange, Revision, SearchCursor, SearchMessageDoc, SearchThreadDoc } from "../search";
import { oracleSearch, type SearchCorpus, type UiScope } from "./oracle";
import { defineSearchConformance } from "./search";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const DAY = 86_400_000;

function prng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}

/**
 * A mock dataset projected straight into search docs, without a store:
 * threads by root reference per account, categories by the threads' gold
 * tags. Engines are checked against the oracle over the same corpus, so any
 * consistent projection serves; this one has the fixture's accounts,
 * categories, senders, vocabulary and timestamp ties.
 */
export function corpusFromDataset(data: MockDataset, rate = 0.7): SearchCorpus {
  const accounts = data.accounts.map((a, i) => ({ id: i + 1, email: a.email, display_name: a.displayName }));
  const categories = data.categories.map((c, i) => ({ id: i + 1, name: c.name }));
  const threadOf = new Map<string, number>();
  const messages: SearchMessageDoc[] = [];
  const members = new Map<number, MockDataset["messages"]>();
  data.messages.forEach((m, i) => {
    const key = `${m.accountIndex}|${m.providerThreadId ?? m.references[0] ?? m.inReplyTo ?? m.rfcMessageId}`;
    let t = threadOf.get(key);
    if (t === undefined) threadOf.set(key, (t = threadOf.size + 1));
    members.set(t, [...(members.get(t) ?? []), m]);
    messages.push({
      messageId: i + 1,
      threadId: t,
      accountId: m.accountIndex + 1,
      date: m.date,
      subject: m.subject,
      fromText: `${m.from.name} ${m.from.email}`,
      fromEmail: normalizeText(m.from.email),
      recipients: [...m.to, ...m.cc].map((a) => `${a.name} ${a.email}`).join(", "),
      body: m.bodyText,
      hasAttachments: m.hasAttachments,
      bodyState: "full",
    });
  });
  const keep = (id: number) => ((id * 2654435761) >>> 0) / 4294967296 < rate;
  const threads: SearchThreadDoc[] = [...members].map(([threadId, ms]) => {
    const tags = new Set(ms.flatMap((m) => m.tags));
    return {
      threadId,
      accountId: ms[0]!.accountIndex + 1,
      lastDate: Math.max(...ms.map((m) => m.date)),
      inInbox: ms.some((m) => m.inInbox && !m.isTrash && !m.isSpam),
      hasSent: ms.some((m) => m.isSent),
      inTrash: ms.every((m) => m.isTrash),
      inSpam: ms.every((m) => m.isSpam),
      isStarred: ms.some((m) => m.isStarred),
      unreadCount: ms.filter((m) => !m.isRead).length,
      categoryIds: keep(threadId) ? data.categories.flatMap((c, i) => (c.tags.some((t) => tags.has(t)) ? [i + 1] : [])) : [],
    };
  });
  return { messages, threads, accounts, categories };
}

/**
 * Queries generated from the corpus: 1–4-char prefixes, words, word pairs,
 * phrases cut from real fields (some with the last token as a prefix),
 * negations, field operators with multi-token values and every thread and
 * date operator, alone and combined.
 */
export function generateQueries(corpus: SearchCorpus, count: number, seed: number): string[] {
  const rand = prng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const sample = Array.from({ length: 400 }, () => pick(corpus.messages));
  const words = sample.flatMap((m) => tokenize(`${m.subject} ${m.body}`)).filter((w) => w.length <= 16);
  const run = (text: string, n: number) => {
    const toks = tokenize(text);
    if (toks.length < n) return null;
    const at = Math.floor(rand() * (toks.length - n + 1));
    return toks.slice(at, at + n);
  };
  const senders = [...new Set(sample.map((m) => m.fromEmail))];
  const names = sample.map((m) => tokenize(m.fromText));
  const views = ["inbox", "sent", "archive", "spam", "trash", "all", "starred"];
  const date = () => (rand() < 0.5 ? `${1 + Math.floor(rand() * 400)}d` : new Date(NOW - Math.floor(rand() * 500) * DAY).toISOString().slice(0, 10));
  const textPart = (): string => {
    const r = rand();
    const w = pick(words);
    if (r < 0.12) return w.slice(0, 1 + Math.floor(rand() * 4));
    if (r < 0.3) return w;
    if (r < 0.45) {
      const m = pick(sample);
      const p = run(rand() < 0.3 ? m.subject : m.body, 2 + Math.floor(rand() * 3));
      return p ? `"${p.join(" ")}"` : w;
    }
    if (r < 0.52) {
      // a multi-token value whose last token is being typed
      const p = run(pick(sample).body, 2);
      return p ? `${p[0]}.${p[1]!.slice(0, Math.max(1, Math.floor(rand() * p[1]!.length)))}` : w;
    }
    if (r < 0.58) return `"${pick(words)} ${pick(words)}"`; // rarely adjacent
    if (r < 0.68) return `-${rand() < 0.8 ? pick(words) : `"${(run(pick(sample).body, 2) ?? [w, w]).join(" ")}"`}`;
    if (r < 0.76) {
      const n = pick(names);
      return `${rand() < 0.5 ? "from" : "de"}:${n.slice(0, 1 + Math.floor(rand() * 2)).join(".") || w}`;
    }
    if (r < 0.82) {
      const m = pick(sample);
      return `to:${tokenize(m.recipients).slice(0, 1 + Math.floor(rand() * 2)).join(".") || w}`;
    }
    if (r < 0.88) {
      const p = run(pick(sample).subject, 1 + Math.floor(rand() * 2));
      return p ? `subject:${p.length > 1 ? `"${p.join(" ")}"` : p[0]}` : w;
    }
    if (r < 0.94) return `${rand() < 0.3 ? "-" : ""}from:${pick(senders)}`;
    return `${pick(words)} ${pick(words)}`;
  };
  const opPart = (): string => {
    const r = rand();
    if (r < 0.15) return `${rand() < 0.2 ? "-" : ""}has:attachment`;
    if (r < 0.3) return pick(["is:unread", "is:read", "is:starred", "-is:starred", "-is:unread"]);
    if (r < 0.45) return `in:${pick(views)}`;
    if (r < 0.55) return `${rand() < 0.3 ? "-" : ""}account:${tokenize(pick(corpus.accounts).email)[1] ?? "acme"}`;
    if (r < 0.7) return `${rand() < 0.3 ? "-" : ""}category:${normalizeText(pick(corpus.categories).name).slice(0, 3 + Math.floor(rand() * 4))}`;
    if (r < 0.85) return `${rand() < 0.5 ? "before" : "after"}:${date()}`;
    return `${rand() < 0.5 ? "-before" : "-after"}:${date()}`;
  };
  const out: string[] = [];
  while (out.length < count) {
    const parts: string[] = [];
    const r = rand();
    const n = r < 0.45 ? 1 : r < 0.8 ? 2 : 3;
    for (let i = 0; i < n; i++) parts.push(rand() < 0.7 ? textPart() : opPart());
    out.push(parts.join(" "));
  }
  return out;
}

export interface EngineHarness {
  /**
   * An engine holding the docs, current at `revision`. `live()` is what the
   * engine holds whenever it is asked (an engine's fallback reads it, as
   * FTS5 reads the store's tables in the same unit of work).
   */
  build(docs: { messages: readonly SearchMessageDoc[]; threads: readonly SearchThreadDoc[] }, revision: Revision, live: () => SearchCorpus): Promise<CachedSearchEngine>;
  /** an unused engine to restore a snapshot into */
  empty(live: () => SearchCorpus): CachedSearchEngine;
  /** engine maintenance (compaction): a replacement with the same answers */
  compact?(engine: CachedSearchEngine): Promise<CachedSearchEngine>;
}

/** A corpus the engine and the oracle both follow through mutations. */
class Model {
  messages = new Map<number, SearchMessageDoc>();
  threads = new Map<number, SearchThreadDoc>();
  constructor(
    readonly base: SearchCorpus,
    public revision: Revision,
  ) {
    for (const m of base.messages) this.messages.set(m.messageId, m);
    for (const t of base.threads) this.threads.set(t.threadId, t);
  }
  corpus(): SearchCorpus {
    return { ...this.base, messages: [...this.messages.values()], threads: [...this.threads.values()] };
  }
  apply(c: IndexChange): void {
    if (c.kind === "upsertMessage") this.messages.set(c.doc.messageId, c.doc);
    else if (c.kind === "removeMessage") this.messages.delete(c.messageId);
    else if (c.kind === "upsertThread") this.threads.set(c.doc.threadId, c.doc);
    else this.threads.delete(c.threadId);
  }
  /** the next revision's batch (its changes are already applied to the model) */
  commit(changes: IndexChange[]): IndexBatch {
    const from = this.revision;
    this.revision = { epoch: from.epoch, seq: from.seq + 1 };
    return { from, to: this.revision, changes };
  }
}

/** One batch of random store-like mutations, applied to the model as they are made: new mail (new and existing threads), bodies, deletes, bumps, trash, categories, merges. */
function mutate(model: Model, rand: () => number, step: number): IndexBatch {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const changes: IndexChange[] = [];
  const push = (c: IndexChange) => {
    changes.push(c);
    model.apply(c);
  };
  const r = rand();
  const n = 1 + Math.floor(rand() * 6);
  for (let j = 0; j < n; j++) {
    const threads = [...model.threads.values()];
    const msgs = [...model.messages.values()];
    if (r < 0.3) {
      // new mail, sometimes into an existing thread (bumps it)
      const like = pick(msgs);
      const existing = rand() < 0.5 ? pick(threads) : null;
      const threadId = existing?.threadId ?? Math.max(...model.threads.keys()) + 1;
      const date = NOW + step * 60_000 + j;
      const t: SearchThreadDoc = existing
        ? { ...existing, lastDate: Math.max(existing.lastDate, date), unreadCount: existing.unreadCount + 1, inInbox: true }
        : { threadId, accountId: like.accountId, lastDate: date, inInbox: true, hasSent: false, inTrash: false, inSpam: false, isStarred: false, unreadCount: 1, categoryIds: [] };
      push({
        kind: "upsertMessage",
        doc: { ...like, messageId: Math.max(...model.messages.keys()) + 1, threadId, accountId: t.accountId, date, body: `${pick(msgs).body.slice(0, 200)} presupuesto ${step}`, subject: rand() < 0.5 ? `Re: ${like.subject}` : like.subject },
      });
      push({ kind: "upsertThread", doc: t });
    } else if (r < 0.45) {
      push({ kind: "upsertMessage", doc: { ...pick(msgs), body: rand() < 0.2 ? "" : pick(msgs).body.slice(0, 300), bodyState: "full" } });
    } else if (r < 0.55) {
      push({ kind: "removeMessage", messageId: pick(msgs).messageId });
    } else if (r < 0.75) {
      const t = pick(threads);
      const flip = rand();
      push({
        kind: "upsertThread",
        doc: {
          ...t,
          lastDate: flip < 0.3 ? t.lastDate + Math.floor(rand() * 10 * DAY) : t.lastDate,
          inTrash: flip >= 0.3 && flip < 0.5 ? !t.inTrash : t.inTrash,
          inInbox: flip >= 0.5 && flip < 0.7 ? !t.inInbox : t.inInbox,
          isStarred: flip >= 0.7 && flip < 0.85 ? !t.isStarred : t.isStarred,
          unreadCount: flip >= 0.85 ? (t.unreadCount ? 0 : 2) : t.unreadCount,
        },
      });
    } else if (r < 0.9) {
      const t = pick(threads);
      const c = pick(model.base.categories).id;
      const ids = t.categoryIds.includes(c) ? t.categoryIds.filter((x) => x !== c) : [...t.categoryIds, c].sort((a, b) => a - b);
      push({ kind: "upsertThread", doc: { ...t, categoryIds: ids } });
    } else {
      // merge: every message of `drop` moves to `keep`, `drop` goes away
      const [keep, drop] = [pick(threads), pick(threads)];
      if (keep.threadId === drop.threadId) continue;
      for (const m of msgs) if (m.threadId === drop.threadId) push({ kind: "upsertMessage", doc: { ...m, threadId: keep.threadId, accountId: keep.accountId } });
      push({ kind: "removeThread", threadId: drop.threadId });
      push({ kind: "upsertThread", doc: { ...keep, lastDate: Math.max(keep.lastDate, drop.lastDate), categoryIds: [...new Set([...keep.categoryIds, ...drop.categoryIds])].sort((a, b) => a - b) } });
    }
  }
  return model.commit(changes);
}

/**
 * The CachedSearchEngine contract beyond the oracle cases: generated queries
 * on every page, batches applied in order (duplicates ignored, gaps and other
 * epochs refused), random mutation sequences, snapshot round-trips and
 * damaged snapshots. Engines run it over a projected mock dataset.
 */
export function defineEngineConformance(name: string, harness: EngineHarness, data: SearchCorpus, options: { queries?: number } = {}): void {
  const epoch = "conformance";
  const at0: Revision = { epoch, seq: 1 };

  const searchWith = (engine: CachedSearchEngine, corpus: SearchCorpus, revision: () => Revision) => async (query: string, scope: UiScope, cursor: SearchCursor | undefined, limit: number) => {
    const search = resolveSearch(parseSearch(query, NOW), query, scope, corpus);
    return engine.query({ search, cursor, limit }, revision());
  };
  async function allPages(engine: CachedSearchEngine, corpus: SearchCorpus, revision: Revision, query: string, scope: UiScope = {}, pageSize = 37): Promise<number[]> {
    const search = searchWith(engine, corpus, () => revision);
    const ids: number[] = [];
    let cursor: SearchCursor | undefined;
    for (let guard = 0; guard < 10_000; guard++) {
      const page = await search(query, scope, cursor, pageSize);
      ids.push(...page.threadIds);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return ids;
  }
  const docsOf = (c: SearchCorpus) => ({ messages: c.messages, threads: c.threads });

  let current: SearchCorpus = data;
  const live = () => current;

  describe(`engine conformance: ${name}`, () => {
    let engine: CachedSearchEngine;
    beforeAll(async () => {
      engine = await harness.build(docsOf(data), at0, live);
    }, 120_000);
    beforeEach(() => {
      current = data;
    });

    defineSearchConformance(name, async () => ({ now: NOW, corpus: async () => data, search: searchWith(engine, data, () => at0) }));

    const queries = generateQueries(data, options.queries ?? 500, 2026);
    const chunks = 5;
    for (let c = 0; c < chunks; c++) {
      const part = queries.slice((c * queries.length) / chunks, ((c + 1) * queries.length) / chunks);
      it(`generated queries ${c * part.length + 1}–${(c + 1) * part.length}: every page equals the oracle`, async () => {
        for (const q of part) expect(await allPages(engine, data, at0, q, {}, 37), q).toEqual(oracleSearch(data, q, NOW));
      }, 120_000);
    }

    it("generated queries inside a UI account or category scope", async () => {
      const account = data.accounts[1]!.id;
      const category = data.categories[0]!.id;
      for (const q of queries.slice(0, 60)) {
        expect(await allPages(engine, data, at0, q, { accountId: account }, 50), q).toEqual(oracleSearch(data, q, NOW, { accountId: account }));
        expect(await allPages(engine, data, at0, q, { categoryId: category }, 50), q).toEqual(oracleSearch(data, q, NOW, { categoryId: category }));
      }
    }, 120_000);

    it("reports its revision; refuses to answer at another one", async () => {
      expect(engine.status()).toMatchObject({ revision: at0, state: "ready" });
      expect(engine.status().allocatedBytes).toBeGreaterThan(0);
      await expect(searchWith(engine, data, () => ({ epoch, seq: 2 }))("factura", {}, undefined, 10)).rejects.toThrow();
      await expect(searchWith(engine, data, () => ({ epoch: "other", seq: 1 }))("factura", {}, undefined, 10)).rejects.toThrow();
    });

    it("applies batches in order: duplicates ignored, gaps and other epochs refused", async () => {
      const e = await harness.build(docsOf(data), at0, live);
      const model = new Model(data, at0);
      const rand = prng(5);
      const first = mutate(model, rand, 0);
      const second = mutate(model, rand, 1);
      await expect(e.apply(second)).rejects.toMatchObject({ name: "RevisionError", reason: "gap" });
      await expect(e.apply({ ...first, from: { epoch: "other", seq: 1 }, to: { epoch: "other", seq: 2 } })).rejects.toMatchObject({ name: "RevisionError", reason: "epoch" });
      await e.apply(first);
      await e.apply(first);
      expect(e.status().revision).toEqual({ epoch, seq: 2 });
      await e.apply(second);
      expect(e.status().revision).toEqual({ epoch, seq: 3 });
      const corpus = (current = model.corpus());
      for (const q of ["presupuesto", "factura", "-factura", "is:unread", "in:trash"]) expect(await allPages(e, corpus, { epoch, seq: 3 }, q), q).toEqual(oracleSearch(corpus, q, NOW));
    }, 60_000);

    for (const seed of [1, 2, 3]) {
      it(`mutation sequence #${seed}: after every batch, answers equal the oracle (with a compaction and a snapshot round-trip on the way)`, async () => {
        let e = await harness.build(docsOf(data), at0, live);
        const model = new Model(data, at0);
        const rand = prng(seed * 7919);
        const probe = generateQueries(data, 400, seed);
        const fixed = ["presupuesto", "factura", "-factura", "is:unread", "in:trash", "is:starred", "category:fact", "re", "from:lucia presupuesto", '"darse de baja"'];
        for (let step = 0; step < 40; step++) {
          await e.apply(mutate(model, rand, step));
          current = model.corpus();
          if (step === 15 && harness.compact) e = await harness.compact(e);
          if (step === 25) {
            const restored = harness.empty(live);
            expect(await restored.restore(await e.snapshot())).toBe(true);
            expect(restored.status().revision).toEqual(model.revision);
            e = restored;
          }
          const corpus = current;
          const qs = [...fixed, ...probe.slice(step * 10, step * 10 + 10)];
          for (const q of qs) expect(await allPages(e, corpus, model.revision, q, {}, step % 3 === 0 ? 37 : 1000), `step ${step}: ${q}`).toEqual(oracleSearch(corpus, q, NOW));
        }
      }, 120_000);
    }

    it("snapshot round-trip: the restored engine answers every generated query identically and keeps applying", async () => {
      const restored = harness.empty(live);
      const bytes = await engine.snapshot();
      expect(await restored.restore(bytes)).toBe(true);
      expect(restored.status()).toMatchObject({ revision: at0, state: "ready" });
      for (const q of queries.slice(0, 200)) expect(await allPages(restored, data, at0, q, {}, 100), q).toEqual(await allPages(engine, data, at0, q, {}, 100));
      const model = new Model(data, at0);
      await restored.apply(mutate(model, prng(99), 0));
      const corpus = (current = model.corpus());
      for (const q of fixedProbe) expect(await allPages(restored, corpus, model.revision, q), q).toEqual(oracleSearch(corpus, q, NOW));
    }, 120_000);

    it("a truncated, bit-flipped or foreign snapshot is refused, and the engine stays usable for a good one", async () => {
      const bytes = await engine.snapshot();
      const damaged: Uint8Array[] = [bytes.slice(0, bytes.length >> 1), bytes.slice(0, 20), new Uint8Array(0), new TextEncoderLike().encode("not a snapshot at all")];
      for (const at of [5, 9, 14, 40, bytes.length >> 2, bytes.length >> 1, bytes.length - 3]) {
        const flipped = bytes.slice();
        flipped[at]! ^= 0x10;
        damaged.push(flipped);
      }
      for (const d of damaged) {
        const e = harness.empty(live);
        expect(await e.restore(d)).toBe(false);
        expect(e.status().state).not.toBe("ready");
        expect(await e.restore(bytes)).toBe(true);
      }
    }, 120_000);
  });
}

const fixedProbe = ["presupuesto", "factura", "-factura", "is:unread", "in:trash", "re"];

/** Latin-1 bytes of an ASCII string (no TextEncoder in the store's environment types). */
class TextEncoderLike {
  encode(s: string): Uint8Array {
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  }
}
