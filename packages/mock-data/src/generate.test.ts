import { describe, expect, it } from "vitest";
import { FAMILIES, FAMILY_TAGS } from "./adversarial";
import { generateDataset, type MockMessage } from "./generate";

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 22, 15, 30);
const threads = (ms: MockMessage[]) => {
  const by = new Map<string, MockMessage[]>();
  for (const m of ms) {
    const key = m.rfcMessageId.split(".")[0]!;
    by.set(key, [...(by.get(key) ?? []), m]);
  }
  return [...by.values()];
};

describe("mock dataset", () => {
  it("is byte-identical to the generator before gold tags and adversarial families existed", () => {
    // fingerprints of the previous generator's output (seeded fixtures, perf DBs and screenshots depend on it)
    for (const [options, expected] of [
      [{ threads: 800, seed: 42, accounts: 4, bodyScale: 2 }, "af58f003"],
      [{ threads: 500, seed: 5, accounts: 8, bodyScale: 3 }, "55936846"],
    ] as const) {
      const data = generateDataset(options);
      const legacy = { ...data, messages: data.messages.map(({ tags: _t, family: _f, ...m }) => m) };
      expect(fnv(JSON.stringify(legacy))).toBe(expected);
    }
  });

  it("gold tags are the thread's tag set", () => {
    for (const t of threads(generateDataset({ threads: 300, seed: 1 }).messages)) {
      const tags = [...new Set(t.map((m) => m.tag))];
      for (const m of t) expect(m.tags).toEqual(tags);
    }
  });

  it("adds every adversarial family after the regular threads, deterministically", () => {
    const plain = generateDataset({ threads: 1000, seed: 7 });
    const adv = generateDataset({ threads: 1000, seed: 7, adversarial: true });
    expect(adv.messages.slice(0, plain.messages.length).map(({ tags: _t, ...m }) => m)).toEqual(plain.messages.map(({ tags: _t, ...m }) => m));
    const extra = adv.messages.slice(plain.messages.length);
    for (const family of FAMILIES) {
      const ms = extra.filter((m) => m.family === family);
      expect(ms.length, family).toBeGreaterThanOrEqual(3);
      for (const m of ms) expect(m.tags).toEqual(FAMILY_TAGS[family]);
    }
    expect(generateDataset({ threads: 1000, seed: 7, adversarial: true })).toEqual(adv);
  });

  it("models the adversarial cases the eval relies on", () => {
    const extra = generateDataset({ threads: 2000, seed: 3, adversarial: true }).messages.filter((m) => m.family);
    const of = (f: string) => extra.filter((m) => m.family === f);
    // Amazon invoices come from the same sender as Amazon shipping notices
    expect(new Set(of("amazon-invoice").map((m) => m.from.email))).toEqual(new Set(["pedidos@amazon.com.mx"]));
    // phishing borrows bank names from other domains, in spam and in the inbox
    const phish = of("phish-bank");
    expect(phish.every((m) => /bbva|banco andino/i.test(m.from.name) && !/@(bbva\.mx|bancoandino\.co)$/.test(m.from.email))).toBe(true);
    expect(phish.some((m) => m.isSpam) && phish.some((m) => m.inInbox)).toBe(true);
    // a client invoice is both Clientes and Facturas
    expect(of("client-invoice")[0]!.tags).toEqual(["client", "receipt"]);
    // new receipts only appear recently
    expect(of("new-receipt").every((m) => m.date >= NOW - 18 * DAY)).toBe(true);
  });

  it("cold-adversarial keeps every family after the cutoff", () => {
    const coldAfter = NOW - 20 * DAY;
    const extra = generateDataset({ threads: 1000, seed: 3, adversarial: { coldAfter } }).messages.filter((m) => m.family);
    expect(extra.length).toBeGreaterThan(0);
    expect(extra.every((m) => m.date >= coldAfter)).toBe(true);
  });
});
