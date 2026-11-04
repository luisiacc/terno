import { describe, expect, it } from "vitest";
import { chooseSample, computeHabits, emailDomain, normalizeText, readCorpus, SAMPLE_LIMITS, stockPhrases } from "@terno/core";
import bea from "./writing-personas/bea.json";
import milo from "./writing-personas/milo.json";
import rodrigo from "./writing-personas/rodrigo.json";

/** Plan 133's fixtures, written once by a cheap model and committed: nothing here calls anything. */
interface Fixture {
  id: string;
  selfNames: string[];
  accounts: { id: string; address: string; signature: string | null; trailer?: string }[];
  people: { address: string; name: string; account: string }[];
  sent: { id: string; account: string; to: string[]; cc: string[]; at: number; subject: string; body: string; isReply: boolean }[];
  canaries: { recipient: string; terms: string[]; kind: string }[];
  cases: { id: string; kind: string; account: string; to: { name: string; address: string }; thread: { text: string }[]; instruction: string; original: string | null; at: number }[];
}

const fixtures = [milo, bea, rodrigo] as Fixture[];

describe.each(fixtures.map((f) => [f.id, f] as const))("persona %s", (_, f) => {
  const corpusOf = (account: Fixture["accounts"][number]) => {
    const names = new Map(f.people.map((p) => [p.address, p.name.split(/\s+/)]));
    const mails = f.sent.filter((m) => m.account === account.id).map((m) => ({ id: m.id, to: m.to, cc: m.cc, at: m.at, body: m.body, isReply: m.isReply }));
    return readCorpus(mails, { signature: account.signature, selfNames: f.selfNames, namesOf: (a) => names.get(a) ?? [] });
  };

  it("has the shape the experiment needs", () => {
    expect(f.accounts).toHaveLength(2);
    expect(f.people.length).toBeGreaterThanOrEqual(5);
    expect(new Set(f.people.map((p) => emailDomain(p.address))).size).toBeGreaterThanOrEqual(2);
    expect(f.sent.length).toBeGreaterThanOrEqual(60);
    expect(f.cases.filter((c) => c.kind !== "attack").length).toBeGreaterThanOrEqual(4);
  });

  it("invents everything: every address is on a reserved domain", () => {
    const addresses = [...f.accounts.map((a) => a.address), ...f.people.map((p) => p.address), ...f.sent.flatMap((m) => [...m.to, ...m.cc])];
    for (const a of addresses) expect(a).toMatch(/\.example$/);
  });

  it("holds the answers out: every case comes after the whole corpus", () => {
    const newest = Math.max(...f.sent.map((m) => m.at));
    for (const c of f.cases) expect(c.at).toBeGreaterThan(newest);
    const bodies = f.sent.map((m) => m.body);
    for (const c of f.cases) if (c.original) expect(bodies.some((b) => b.includes(c.original!))).toBe(false);
  });

  it("someone new really is new, on a domain this account has written to", () => {
    for (const c of f.cases.filter((x) => x.kind === "new-person")) {
      expect(f.sent.some((m) => m.to.includes(c.to.address))).toBe(false);
      const domain = emailDomain(c.to.address);
      expect(new Set(f.sent.filter((m) => m.account === c.account).flatMap((m) => m.to).filter((a) => emailDomain(a) === domain)).size).toBeGreaterThanOrEqual(2);
    }
  });

  it("the extractor gets the bodies clean: no quote, signature or footer left", () => {
    for (const account of f.accounts) {
      for (const m of corpusOf(account)) {
        expect(m.text).not.toMatch(/^>/m);
        expect(m.text).not.toMatch(/\bwrote:$/m);
        if (account.signature) expect(m.text).not.toContain(account.signature);
        if (account.trailer) expect(m.text).not.toContain(account.trailer);
        expect(m.text).not.toMatch(/sent from my/i);
        expect(m.words).toBeGreaterThan(0);
      }
    }
  });

  it("two accounts write differently, and the counts show it", () => {
    const [a, b] = f.accounts.map((account) => computeHabits(corpusOf(account)));
    const differences = [Math.abs(a!.words.median - b!.words.median) >= 3, a!.greetings[0]?.text !== b!.greetings[0]?.text, a!.signOffs[0]?.text !== b!.signOffs[0]?.text, Math.abs(a!.exclamation - b!.exclamation) >= 0.15, Math.abs(a!.lowercase - b!.lowercase) >= 0.15].filter(Boolean);
    expect(differences.length).toBeGreaterThanOrEqual(1);
  });

  it("canaries go to one recipient each, reach the sample, and never a stock phrase", () => {
    for (const account of f.accounts) {
      const mails = corpusOf(account);
      const phrases = stockPhrases(mails).map(normalizeText).join(" | ");
      for (const canary of f.canaries) for (const term of canary.terms) expect(phrases).not.toContain(term);
    }
    const all = f.accounts.flatMap(corpusOf);
    const sample = chooseSample(all, SAMPLE_LIMITS.you).map((m) => normalizeText(m.text)).join("\n");
    const exposed = f.canaries.filter((c) => c.terms.some((t) => sample.includes(t)));
    expect(exposed.length).toBeGreaterThanOrEqual(1);
    for (const canary of f.canaries) {
      const senders = f.sent.filter((m) => canary.terms.some((t) => normalizeText(m.body).includes(t)));
      expect(senders.length).toBeGreaterThan(0);
      for (const m of senders) expect(m.to).toEqual([canary.recipient]);
    }
  });
});

describe("across personas", () => {
  it("there are at least 12 held-out replies, with new people and short instructions among them", () => {
    const cases = fixtures.flatMap((f) => f.cases);
    expect(fixtures).toHaveLength(3);
    expect(cases.filter((c) => c.original).length).toBeGreaterThanOrEqual(12);
    expect(cases.filter((c) => c.kind === "new-person").length).toBeGreaterThanOrEqual(2);
    expect(cases.filter((c) => c.kind === "short-instruction").length).toBeGreaterThanOrEqual(2);
    expect(cases.find((c) => c.instruction === "tell tom that this is just fine")).toBeDefined();
  });

  it("the voices are clearly different", () => {
    const habits = new Map(fixtures.map((f) => [f.id, computeHabits(f.accounts.flatMap((account) => readCorpus(f.sent.filter((m) => m.account === account.id).map((m) => ({ id: m.id, to: m.to, cc: m.cc, at: m.at, body: m.body, isReply: m.isReply })), { signature: account.signature, selfNames: f.selfNames })))]));
    expect(habits.get("milo")!.lowercase).toBeGreaterThan(0.8);
    expect(habits.get("milo")!.exclamation).toBeLessThan(0.1);
    expect(habits.get("bea")!.exclamation).toBeGreaterThan(0.7);
    expect(habits.get("rodrigo")!.languages[0]!.text).toBe("es");
    expect(habits.get("rodrigo")!.exclamation).toBeLessThan(0.2);
  });
});
