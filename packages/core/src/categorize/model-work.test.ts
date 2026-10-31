import { describe, expect, it, vi } from "vitest";
import { encodeFeatures, FEATURES_V } from "./features";
import { CategorizerModel, type TrainExample } from "./model";

const NOW = 1_700_000_000_000;
const features = (sender: string) => encodeFeatures({ v: FEATURES_V, sender, list: null, domain: null, rawDomain: "", name: "", tokens: ["b:shared"], intents: [] });
const query = features("unknown@example.test");
function fixture() {
  const m = new CategorizerModel({ decayRef: NOW });
  for (let categoryId = 1; categoryId <= 20; categoryId++) {
    for (let i = 0; i < 3; i++) m.train({ categoryId, label: 1, weight: 1, at: NOW, content: true, features: features(`s${categoryId}@example.test`) });
  }
  return m;
}

// Independent single-token oracle: every category has support, and the query has no identity or intent evidence.
function verify(m: CategorizerModel) {
  const expected = m.categoryIds.map((categoryId) => {
    const inv = 1 / m.labelRate(categoryId);
    const P = 3 * inv;
    const N = m.alpha * Math.max(0, m.backgroundSize - 3 * (inv - 1));
    const prior = Math.log((P + 1) / (N + 1));
    const C = Math.max(-3, Math.min(3, m.featureStats(query[7]!, categoryId).llr));
    return { categoryId, p: 1 / (1 + Math.exp(-(prior + C))), prior, I: 0, identityShare: 0, identityFit: 0, C, Nint: 0, identity: null, identitySupport: 0, domainSenders: 0, positives: 3, positiveSenders: 1 };
  });
  expect(m.score(query)).toEqual(expected);
  const ids = m.categoryIds.slice().reverse().slice(0, 7);
  expect(m.score(query, ids)).toEqual(ids.map((id) => expected.find((s) => s.categoryId === id)));
  const bytes = m.serialize();
  const back = CategorizerModel.deserialize(bytes.slice())!;
  expect(back.serialize()).toEqual(bytes);
  expect(back.score(query)).toEqual(expected);
}

describe("categorizer sparse-token work", () => {
  it.each([0, 1, 2])("calculates the background logarithm only when consumed, at support %i", (background) => {
    const m = fixture();
    for (let i = 0; i < background; i++) m.addBackground(i, features("background@example.test"));
    m.score(query);
    const log = vi.spyOn(Math, "log");
    try {
      m.score(query);
      expect(log).toHaveBeenCalledTimes(background < 2 ? 0 : 1);
      if (background === 2) expect(log).toHaveBeenCalledWith(m.alpha * background + 0.1);
    } finally {
      log.mockRestore();
    }
  });

  it("keeps every score field and snapshot through background thresholds, subsets, Undo and deletion", () => {
    const m = fixture();
    verify(m);
    m.addBackground(100, features("background@example.test")); verify(m);
    m.addBackground(101, features("background@example.test")); verify(m);
    m.addBackground(102, features("background@example.test")); verify(m);
    m.removeBackground(100); verify(m);
    m.removeBackground(101); verify(m);
    m.removeBackground(102); verify(m);
    const extra: TrainExample = { categoryId: 4, label: -1, weight: 3, at: NOW, content: true, features: query };
    const before = m.score(query);
    m.train(extra);
    expect(m.score(query)).not.toEqual(before);
    m.untrain(extra);
    verify(m);
    m.dropCategory(2);
    verify(m);
  });
});

function mixedFixture() {
  const encode = (tokens: string[], sender = "filed@example.test") => encodeFeatures({ v: FEATURES_V, sender, list: null, domain: null, rawDomain: "", name: "", tokens, intents: [] });
  const m = new CategorizerModel({ decayRef: NOW });
  for (let cat = 1; cat <= 4; cat++) {
    for (let i = 0; i < cat + 1; i++) m.train({ categoryId: cat, label: 1, weight: 1, at: NOW, content: true, features: encode(cat % 2 ? ["a", "b", "c", "d"] : ["b", "d"]) });
  }
  // a,b,c,d have background support 0,2,1,3. "only" has no sparse groups; "absent" has no entry.
  for (let i = 0; i < 3; i++) m.addBackground(i, encode([...(i < 2 ? ["b"] : []), ...(i < 1 ? ["c"] : []), "d", "only"], "background@example.test"));
  m.train({ categoryId: 5, label: 1, weight: 1, at: NOW, content: true, features: encode(["a"]) });
  return { m, query: encode(["a", "b", "absent", "c", "d", "only"], "unknown@example.test") };
}

it.each([false, true])("matches unchanged-source full mixed-token records, including non-finite snapshot counts: %s", (nonfinite) => {
  const { m, query } = mixedFixture();
  const bytes = m.serialize();
  if (nonfinite) {
    const dv = new DataView(bytes.buffer);
    const pad = (n: number) => (n + 7) & ~7;
    const n = dv.getUint32(8, true);
    const hashesAt = pad(16 + dv.getUint32(4, true) * 2);
    const bgAt = pad(pad(hashesAt + n * 4) + n * 2);
    const hashes = new Uint32Array(bytes.buffer, hashesAt, n);
    dv.setFloat64(bgAt + hashes.indexOf(query[7]!) * 8, NaN, true);
  }
  const loaded = CategorizerModel.deserialize(bytes)!;
  const cold = loaded.score(query);
  expect(cold).toMatchSnapshot();
  expect(loaded.score(query)).toEqual(cold);
  expect(loaded.score(query, [4, 999, 1, 5, 2])).toEqual([cold[3], cold[0], cold[4], cold[1]]);
});
