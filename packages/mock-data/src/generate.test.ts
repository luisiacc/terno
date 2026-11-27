import { describe, expect, it } from "vitest";
import { FAMILIES, FAMILY_TAGS } from "./adversarial";
import * as B from "./banks";
import { DEMO_DATASET, DEMO_SPANISH_ACCOUNT, demoSpanishWords, generateDataset, type MockMessage } from "./generate";

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
    // fingerprints of the previous generator's output (seeded fixtures, perf DBs and screenshots depend on it);
    // Message-IDs moved from @mock.unica to @mock.terno with the rename, nothing else (before: af58f003, 55936846)
    for (const [options, expected] of [
      [{ threads: 800, seed: 42, accounts: 4, bodyScale: 2 }, "631e09a5"],
      [{ threads: 500, seed: 5, accounts: 8, bodyScale: 3 }, "3c522abe"],
    ] as const) {
      const data = generateDataset(options);
      // plan 17's bulk flag is derived from what the generator already chose (no draw from the PRNG)
      // plan 68's folders are placed after, from a hash (no draw from the PRNG either); plan 96's unsubscribe is from the list id
      // plan 194: brown took indigo's slot, the one change to what it draws (the fingerprints still hold with it put back)
      const indigo = <T extends { color: string }>(x: T) => (x.color === "brown" ? { ...x, color: "indigo" } : x);
      const legacy = { ...data, categories: data.categories.map(indigo), accounts: data.accounts.map(({ folders: _x, ...a }) => indigo(a)), messages: data.messages.map(({ tags: _t, family: _f, bulk: _b, gmailLabels: _g, locations: _l, unsubscribe: _u, ...m }) => m) };
      expect(fnv(JSON.stringify(legacy))).toBe(expected);
    }
  });

  it("the fixture is byte-identical to the generator before the demo edition (plan 289), every field", () => {
    // whole outputs, not the legacy projection above: folders, labels, unsubscribe, bulk, tags and families too
    for (const [options, expected] of [
      [{ threads: 800, seed: 42, accounts: 4, bodyScale: 2 }, "9d8bec1c"],
      [{ threads: 500, seed: 5, accounts: 8, bodyScale: 3 }, "630638ba"],
      [{ threads: 1000, seed: 7, accounts: 4, adversarial: true }, "6532cac"],
      [{ threads: 3000, accounts: 4, seed: 42, bodyScale: 2, now: NOW }, "bc09cdc0"],
    ] as const) {
      expect(fnv(JSON.stringify(generateDataset(options))), JSON.stringify(options)).toBe(expected);
      expect(fnv(JSON.stringify(generateDataset({ ...options, edition: "fixture" })))).toBe(expected);
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

describe("the demo edition (plan 289)", () => {
  const data = generateDataset({ ...DEMO_DATASET, accounts: 8 });
  const SPANISH_LETTERS = /[áéíóúñÁÉÍÓÚÑ¿¡]/;
  // whole words only Spanish writes (an English sentence never has one)
  const SPANISH_WORDS = /\b(hola|gracias|saludos|abrazo|el|los|las|una|para|por|con|tu|del|de|que|est[aá]|semana|factura|recibo|pedido)\b/i;
  const texts = (m: MockMessage) => [m.subject, m.bodyText, m.bodyHtml ?? "", m.from.name, ...m.to.map((a) => a.name), ...m.cc.map((a) => a.name), ...m.attachments.map((a) => a.filename)];

  it("is deterministic, the same size as the fixture, with English categories and one Spanish account", () => {
    expect(generateDataset({ ...DEMO_DATASET, accounts: 8 })).toEqual(data);
    expect(data.categories.map((c) => c.name)).toEqual(["Receipts", "Clients", "Travel", "Reading", "Dev"]);
    expect(data.accounts.filter((a) => a.lang === "es").map((a) => a.displayName)).toEqual(["Freelance"]);
    expect(DEMO_SPANISH_ACCOUNT).toBe(2);
    // the fixture's addresses, so the site's check that a window shows the mock mailbox holds
    expect(data.accounts.map((a) => a.email)).toEqual(generateDataset({ threads: 0, accounts: 8 }).accounts.map((a) => a.email));
    const fixture = generateDataset({ threads: 3000, accounts: 4, seed: 42, bodyScale: 2 });
    const demo = generateDataset(DEMO_DATASET);
    expect(Math.abs(demo.messages.length - fixture.messages.length)).toBeLessThan(fixture.messages.length * 0.1);
    expect(Math.max(...demo.messages.map((m) => m.date))).toBeLessThanOrEqual(NOW);
  });

  it("the English accounts say nothing in Spanish: every kind of mail, its HTML, names, files and folders", () => {
    const english = data.messages.filter((m) => m.accountIndex !== DEMO_SPANISH_ACCOUNT);
    // every kind of mail is there to check
    expect(new Set(english.map((m) => m.tag))).toEqual(new Set(["newsletter", "receipt", "shipping", "bank", "dev", "travel", "calendar", "work", "client", "personal", "spam"]));
    for (const m of english) for (const text of texts(m)) {
      expect(text, m.subject).not.toMatch(SPANISH_LETTERS);
      expect(text.replace(/<[^>]+>|https?:\/\/\S+/g, " "), m.subject).not.toMatch(SPANISH_WORDS);
    }
    for (const a of data.accounts.filter((a) => a.lang === "en")) {
      expect(a.displayName).not.toMatch(SPANISH_LETTERS);
      for (const f of a.folders ?? []) expect(f.path.join("/")).not.toMatch(SPANISH_LETTERS);
    }
  });

  it("the Spanish account's conversations are all in Spanish, and nobody writes on both sides", () => {
    const spanish = data.messages.filter((m) => m.accountIndex === DEMO_SPANISH_ACCOUNT);
    const talk = spanish.filter((m) => ["personal", "work", "client"].includes(m.tag));
    expect(talk.length).toBeGreaterThan(100);
    for (const m of talk) expect(B.OPENERS_ES.some((o) => m.bodyText.startsWith(o.split("{name}")[0]!)), m.subject).toBe(true);
    for (const m of spanish.filter((m) => m.tag === "newsletter")) expect(B.ES_NEWSLETTERS.map((n) => n.email)).toContain(m.from.email);
    const people = (ms: MockMessage[]) => new Set(ms.flatMap((m) => [m.from, ...m.to, ...m.cc]).map((a) => a.email));
    const mine = new Set(data.accounts.map((a) => a.email));
    const es = people(talk);
    const en = people(data.messages.filter((m) => m.accountIndex !== DEMO_SPANISH_ACCOUNT && ["personal", "work", "client"].includes(m.tag)));
    expect([...es].filter((e) => en.has(e) && !mine.has(e))).toEqual([]);
  });

  it("names what only the Spanish account says, for the site's pictures to refuse", () => {
    const words = demoSpanishWords(generateDataset(DEMO_DATASET));
    expect(words).toContain("Clientes antiguos");
    expect(words).toContain("Lucía");
    expect(words.some((w) => w.startsWith("Propuesta: ") || w.startsWith("Planeación"))).toBe(true);
    expect(words).not.toContain("Freelance");
    // nothing the English accounts say too, and no word without a letter (Codex code review)
    for (const shared of ["2026", "Google Calendar", "Uber Receipts", "Airbnb"]) expect(words).not.toContain(shared);
    const english = new Set(generateDataset(DEMO_DATASET).messages.filter((m) => m.accountIndex !== DEMO_SPANISH_ACCOUNT).flatMap((m) => [m.subject, m.from.name]));
    expect(words.filter((w) => english.has(w))).toEqual([]);
  });

  it("has no adversarial families: they're the fixture's", () => {
    expect(() => generateDataset({ ...DEMO_DATASET, adversarial: true })).toThrow(/adversarial/);
  });
});
