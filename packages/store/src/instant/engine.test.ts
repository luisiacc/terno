import { parseSearch, resolveSearch } from "@unica/core";
import { generateDataset } from "@unica/mock-data";
import { describe, expect, it } from "vitest";
import { corpusFromDataset, defineEngineConformance, termMatches, type SearchCorpus } from "../conformance";
import type { SearchMessageDoc, SearchThreadDoc } from "../search";
import { tokenize } from "@unica/core";
import { InstantSearchEngine, tokenizeSliced, type InstantEngineOptions } from "./engine";
import { SliceClock } from "./slices";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const data = corpusFromDataset(generateDataset({ threads: 2500, accounts: 4, seed: 11, now: NOW }));

async function build(docs: { messages: readonly SearchMessageDoc[]; threads: readonly SearchThreadDoc[] }, options: InstantEngineOptions = {}, epoch = "e", seq = 1) {
  const e = new InstantSearchEngine(options);
  e.beginBuild({ epoch, seq });
  await e.loadMessages(docs.messages);
  e.loadThreads(docs.threads);
  await e.finishBuild();
  return e;
}

/** a brute-force phrase doclist over what the engine holds (FTS5's role in the store) */
const phrasesOf = (live: () => SearchCorpus): InstantEngineOptions["phrases"] => (term) => live().messages.filter((m) => termMatches(m, term)).map((m) => m.messageId);

defineEngineConformance(
  "InstantSearchEngine",
  {
    build: (docs, revision) => build(docs, {}, revision.epoch, revision.seq),
    empty: () => new InstantSearchEngine(),
    compact: (e) => (e as InstantSearchEngine).compacted(),
  },
  data,
);

// a tiny phrase budget sends every phrase that isn't settled at once to the doclist
defineEngineConformance(
  "InstantSearchEngine with a phrase doclist",
  {
    build: (docs, revision, live) => build(docs, { phrases: phrasesOf(live), phraseBudget: 4, walkThreshold: 500 }, revision.epoch, revision.seq),
    empty: (live) => new InstantSearchEngine({ phrases: phrasesOf(live), phraseBudget: 4, walkThreshold: 500 }),
    compact: (e) => (e as InstantSearchEngine).compacted(),
  },
  data,
  { queries: 200 },
);

describe("tokenizeSliced", () => {
  // what could make a cut change tokens: marks (precomposed and combining), compositions with ASCII (=, <, > + U+0338),
  // scripts kept with their marks, Hangul jamo and syllables, compatibility forms, astral chars, runs without separators
  const pieces = ["hola", "Reunión", "reunio\u0301n", "ÁRBOL", "=\u0338", "<\u0338x", ">\u0338", "ά", "Ελλάδα", "й", "Йод", "\u1100\u1161", "한국어", "ﬁn", "😀", "x\u0301", " ", "  ", "\n", ".", ",", "-", "_", "'", "/", "=", "<", ">", "@", "a1b2", "123", "e.mail", "ÿ", "ß", "İ", "ı"];
  let seed = 3;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const text = (n: number) => Array.from({ length: n }, () => pieces[Math.floor(rand() * pieces.length)]).join(rand() < 0.5 ? "" : " ");

  it("gives exactly tokenize()'s tokens, whatever the chunk size", async () => {
    const clock = new SliceClock({});
    for (let k = 0; k < 40; k++) {
      const t = text(2000 + Math.floor(rand() * 4000));
      for (const chunk of [7, 37, 256, 4096]) expect(await tokenizeSliced(t, clock, chunk), `${k}/${chunk}`).toEqual(tokenize(t));
    }
    const noSeparator = "palabra".repeat(20_000);
    expect(await tokenizeSliced(noSeparator, clock, 100)).toEqual(tokenize(noSeparator));
  });
});

describe("InstantSearchEngine", () => {
  const at = { epoch: "e", seq: 1 };
  const search = (e: InstantSearchEngine, query: string, limit = 100) => e.search({ search: resolveSearch(parseSearch(query, NOW), query, {}, data), limit }, at);

  it("walks threads for many candidates, deduplicates candidates for few, and asks the doclist for rarely-adjacent phrases", async () => {
    let asked = 0;
    const e = await build(data, {
      phrases: (term) => {
        asked++;
        return data.messages.filter((m) => termMatches(m, term)).map((m) => m.messageId);
      },
    });
    expect(search(e, "p").strategy).toBe("instant:walk");
    expect(search(e, "zzqxjv").strategy).toBe("instant:docs");
    expect(search(e, "account:nonexistent").strategy).toBe("instant:empty");
    expect(search(e, '"darse de baja"').strategy).not.toContain("+phrases");
    expect(asked).toBe(0);
    // frequent words that are rarely adjacent: verifying every candidate would cost more than the doclist
    const strategies = ['"hola equipo"', '"baja darse"', '"de equipo"', '"la factura de"'].map((q) => search(e, q).strategy);
    expect(strategies.some((s) => s.endsWith("+phrases"))).toBe(true);
    expect(asked).toBeGreaterThan(0);
  });

  it("a batch that fails part-way discards the index instead of leaving it half-applied", async () => {
    const e = await build(data);
    const bad = { ...data.messages[0]!, messageId: 999_999 };
    Object.defineProperty(bad, "body", {
      get() {
        throw new Error("boom");
      },
    });
    await expect(
      e.apply({ from: at, to: { epoch: "e", seq: 2 }, changes: [{ kind: "upsertMessage", doc: { ...data.messages[1]!, subject: "cambiado" } }, { kind: "upsertMessage", doc: bad }] }),
    ).rejects.toThrow("boom");
    expect(e.status()).toMatchObject({ state: "disabled", revision: null });
    expect(() => search(e, "factura")).toThrow(/not at revision/);
  });

  it("a snapshot of another identity or tokenizer is refused", async () => {
    const e = await build(data, { identity: "schema 7" });
    const bytes = await e.snapshot();
    expect(await new InstantSearchEngine({ identity: "schema 8" }).restore(bytes)).toBe(false);
    expect(await new InstantSearchEngine({ identity: "schema 7" }).restore(bytes)).toBe(true);
  });

  it("a restored index accounts for the snapshot buffer its views pin, also after arrays grow out of it", async () => {
    // every distinct buffer the engine's typed arrays hold, at its full size
    const retained = (e: InstantSearchEngine) => {
      const buffers = new Set<ArrayBufferLike>();
      const visit = (v: unknown) => {
        if (ArrayBuffer.isView(v)) buffers.add(v.buffer);
        else if (v instanceof Map) for (const x of v.values()) visit(x);
      };
      for (const v of Object.values(e)) visit(v);
      return [...buffers].reduce((n, b) => n + b.byteLength, 0);
    };
    const big = corpusFromDataset(generateDataset({ threads: 1500, accounts: 2, seed: 7, now: NOW, bodyScale: 4 }));
    const e = await build(big);
    const bytes = await e.snapshot();
    const restored = new InstantSearchEngine();
    expect(await restored.restore(bytes, true)).toBe(true);
    expect(restored.allocatedBytes()).toBeGreaterThanOrEqual(retained(restored));
    // new mail: the doc arrays and the forward index grow into fresh buffers; the snapshot's stays pinned by the rest
    const fresh = big.messages.slice(0, 50).map((m, i) => ({ kind: "upsertMessage" as const, doc: { ...m, messageId: 1_000_000 + i } }));
    await restored.apply({ from: at, to: { epoch: "e", seq: 2 }, changes: fresh });
    expect(retained(restored)).toBeGreaterThanOrEqual(bytes.byteLength + restored.stats().forwardBytes);
    expect(restored.allocatedBytes()).toBeGreaterThanOrEqual(retained(restored));
  });

  it("compaction folds tombstones and the delta into a new base with the same answers", async () => {
    const e = await build(data);
    const changes = data.messages.slice(0, 3000).map((m) => ({ kind: "upsertMessage" as const, doc: { ...m, body: `${m.body} actualizado` } }));
    await e.apply({ from: at, to: { epoch: "e", seq: 2 }, changes });
    expect(e.stats()).toMatchObject({ tombstones: 3000, deltaDocs: 3000 });
    expect(e.needsCompaction()).toBe(true);
    const c = await e.compacted();
    expect(c.stats()).toMatchObject({ tombstones: 0, deltaDocs: 0, messages: data.messages.length });
    expect(c.allocatedBytes()).toBeLessThan(e.allocatedBytes());
    const rev = { epoch: "e", seq: 2 };
    for (const q of ["actualizado", "factura", "-factura", '"darse de baja"', "p", "from:lucia"]) {
      const s = resolveSearch(parseSearch(q, NOW), q, {}, data);
      expect(c.search({ search: s, limit: 1000 }, rev).threadIds, q).toEqual(e.search({ search: s, limit: 1000 }, rev).threadIds);
    }
  });

  it("yields to the event loop while building, in bounded slices", async () => {
    const gaps: number[] = [];
    let last = performance.now();
    const e = new InstantSearchEngine({
      sliceMs: 4,
      yield: async () => {
        await new Promise((r) => setTimeout(r, 0));
        const now = performance.now();
        gaps.push(now - last);
        last = now;
      },
    });
    e.beginBuild(at);
    await e.loadMessages(data.messages);
    e.loadThreads(data.threads);
    await e.finishBuild();
    expect(gaps.length).toBeGreaterThan(5);
  });
});
