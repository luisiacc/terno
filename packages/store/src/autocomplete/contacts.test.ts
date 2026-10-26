import type { Address } from "@terno/core";
import { describe, expect, it } from "vitest";
import type { ContactMessage } from "../autocomplete-source";
import { SliceClock } from "../instant/slices";
import { cleanName, ContactIndex, contactTokens, normalizeEmail } from "./contacts";

describe("names as other clients mangle them (plan 32)", () => {
  it("mojibake, smart quotes, invisible characters and broken encoded words are undone before a name is learned", () => {
    expect(cleanName("JosÃ© PÃ©rez", "jp@x.com")).toBe("José Pérez");
    expect(cleanName("“Ana Torres”", "a@x.com")).toBe("Ana Torres");
    expect(cleanName("Ana\u{202E} Torres", "a@x.com")).toBe("Ana Torres");
    expect(cleanName("José_David_Sucre_L.?=", "d@x.com")).toBe("José David Sucre L.");
  });
});
import { fold } from "./fold";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 22);
const clock = () => new SliceClock({});
let nextId = 1;

const me: Address = { name: "Luis Cordero", email: "luis@acme.studio" };
function received(from: Address, o: Partial<ContactMessage> = {}): ContactMessage {
  return { id: nextId++, accountId: 1, date: NOW - DAY, sent: false, spam: false, draft: false, from, to: [me], cc: [], bcc: [], hasBody: true, ...o };
}
function sent(to: Address[], o: Partial<ContactMessage> = {}): ContactMessage {
  return { id: nextId++, accountId: 1, date: NOW - DAY, sent: true, spam: false, draft: false, from: me, to, cc: [], bcc: [], hasBody: true, ...o };
}

async function built(messages: ContactMessage[], o: { incremental?: boolean } = {}): Promise<ContactIndex> {
  const c = new ContactIndex({ now: () => NOW });
  if (o.incremental) {
    c.beginBuild({ epoch: "e", seq: 0 });
    await c.finishBuild(clock());
    for (const m of messages) c.add(m);
  } else {
    c.beginBuild({ epoch: "e", seq: 0 });
    for (const m of messages) c.add(m);
    await c.finishBuild(clock());
  }
  c.setOwn([me.email]);
  return c;
}

const emails = (c: ContactIndex, q: string, o?: Parameters<ContactIndex["suggest"]>[1]) => c.suggest(q, o).map((h) => h.email);
const ana = { name: "Ana Martínez", email: "ana.martinez@acme.studio" };
const andres = { name: "Andrés López", email: "andres@lopez.mx" };

describe("folding and tokens", () => {
  it("folds case and diacritics, keeps CJK and Hangul", () => {
    expect(fold("JOSÉ Ñúñez")).toBe("jose nunez");
    expect(fold("Straße Øster Łódź")).toBe("strasse oster lodz");
    expect(fold("王小明")).toBe("王小明");
    expect(fold("김민수")).toBe("김민수");
  });

  it("normalizes addresses and refuses what isn't one", () => {
    expect(normalizeEmail(" <Ana@Example.COM> ")).toBe("ana@example.com");
    expect(normalizeEmail("mailto:bob@x.io")).toBe("bob@x.io");
    expect(normalizeEmail("bob@")).toBeNull();
    expect(normalizeEmail("not an address")).toBeNull();
  });

  it("tokens: name words, local part and pieces, initials, a non-provider domain", () => {
    const t = contactTokens("arjun.patel+news@orbita.dev", ["Arjun Patel"]);
    expect(t.get("arjun")).toBe(3);
    expect(t.get("patel")).toBe(2);
    expect(t.get("ap")).toBe(1);
    expect(t.get("arjun.patel+news")).toBe(3);
    expect(t.get("orbita")).toBe(1);
    expect(contactTokens("bob@gmail.com", []).has("gmail")).toBe(false);
  });

  it("caps hostile names: tokens at 32 characters, at most 12 words", () => {
    const long = Array.from({ length: 80 }, (_, i) => `w${i}${"x".repeat(60)}`).join(" ");
    const t = contactTokens("a@b.co", [long]);
    expect(Math.max(...[...t.keys()].map((k) => k.length))).toBeLessThanOrEqual(32);
    expect(t.size).toBeLessThanOrEqual(2 + 12 + 1);
  });
});

describe("ranking", () => {
  it("people you've written to rank above people who only wrote to you", async () => {
    const often = { name: "Ana Fuentes", email: "ana@fuentes.mx" };
    const c = await built([...Array.from({ length: 30 }, () => received(often)), sent([ana])]);
    expect(emails(c, "ana")).toEqual([ana.email, often.email]);
  });

  it("frequency and recency: more mail ranks higher, and recent mail outweighs old mail", async () => {
    const old = { name: "Ana Old", email: "ana.old@x.io" };
    const recent = { name: "Ana New", email: "ana.new@x.io" };
    const frequent = { name: "Ana Many", email: "ana.many@x.io" };
    const c = await built([
      ...Array.from({ length: 3 }, () => sent([old], { date: NOW - 900 * DAY })),
      sent([recent], { date: NOW - DAY }),
      ...Array.from({ length: 5 }, () => sent([frequent], { date: NOW - 2 * DAY })),
    ]);
    expect(emails(c, "ana")).toEqual([frequent.email, recent.email, old.email]);
  });

  it("matches without diacritics, and with them when the name has none", async () => {
    const c = await built([sent([andres]), sent([{ name: "Jose Ruiz", email: "jr@ruiz.mx" }])]);
    expect(emails(c, "andres")).toEqual([andres.email]);
    expect(emails(c, "ANDRÉS")).toEqual([andres.email]);
    expect(emails(c, "josé")).toEqual(["jr@ruiz.mx"]);
  });

  it("finds by last name, initials, address local part, address pieces and company domain", async () => {
    const arjun = { name: "Arjun Patel", email: "a.patel@orbita.dev" };
    const c = await built([sent([arjun])]);
    for (const q of ["arj", "pat", "ap", "a.pa", "orbita", "Arjun P", "patel arjun", "a.patel@orb"]) expect(emails(c, q), q).toEqual([arjun.email]);
    expect(emails(c, "a.patel@x")).toEqual([]);
    expect(emails(c, "zz")).toEqual([]);
  });

  it("a first name ranks above a last name of equal weight; a whole word above a prefix", async () => {
    const first = { name: "Mara Soto", email: "m1@x.io" };
    const last = { name: "Luz Marañón", email: "m2@x.io" };
    const c = await built([sent([first]), sent([last])]);
    expect(emails(c, "mar")).toEqual([first.email, last.email]);
    const c2 = await built([sent([{ name: "Ana Perez", email: "a1@x.io" }]), sent([{ name: "Anabel Ruiz", email: "a2@x.io" }]), sent([{ name: "Anabel Ruiz", email: "a2@x.io" }])]);
    // Anabel has twice the weight, but "ana" is Ana's whole first name (×1.5) — and Anabel still wins on 2× weight
    expect(emails(c2, "ana")[0]).toBe("a2@x.io");
    expect(emails(c2, "ana perez")).toEqual(["a1@x.io"]);
  });

  it("CJK names match by their start and by a given name inside them", async () => {
    const wang = { name: "王小明", email: "wang@x.cn" };
    const kim = { name: "김민수", email: "kim@x.kr" };
    const c = await built([sent([wang]), sent([kim])]);
    expect(emails(c, "王")).toEqual([wang.email]);
    expect(emails(c, "小明")).toEqual([wang.email]);
    expect(emails(c, "민수")).toEqual([kim.email]);
  });

  it("one contact per address: the most used name shows, the others stay searchable", async () => {
    const c = await built([
      received({ name: "Robert Smith", email: "bob@smith.io" }),
      sent([{ name: "Bobby", email: "BOB@smith.io" }]),
      sent([{ name: "bobby", email: "bob@smith.io" }]),
      // a "name" that is just the address's local part isn't one
      sent([{ name: "bob", email: "bob@smith.io" }]),
    ]);
    expect(c.size).toBe(2); // bob, and me (own)
    expect(c.suggest("bob")).toEqual([{ name: "Bobby", email: "bob@smith.io" }]);
    expect(emails(c, "robert")).toEqual(["bob@smith.io"]);
  });

  it("the same name at two addresses: both, told apart by the address", async () => {
    const c = await built([sent([{ name: "Ana Ruiz", email: "ana@work.io" }]), sent([{ name: "Ana Ruiz", email: "ana.ruiz@gmail.com" }])]);
    expect(emails(c, "ana ruiz").sort()).toEqual(["ana.ruiz@gmail.com", "ana@work.io"]);
  });

  it("own addresses are never suggested unless typed in full", async () => {
    const alias = { name: "Luis", email: "hola@luiscordero.dev" };
    const c = await built([sent([ana], { from: alias }), received(andres)]);
    expect(emails(c, "luis")).toEqual([]);
    expect(emails(c, "hola")).toEqual([]);
    expect(emails(c, "luis@acme.studio")).toEqual([me.email]);
    expect(emails(c, "hola@luiscordero.dev")).toEqual([alias.email]);
  });

  it("excludes what is already in the draft, any case", async () => {
    const c = await built([sent([ana]), sent([{ name: "Ana B", email: "anab@x.io" }])]);
    expect(emails(c, "an", { exclude: ["ANA.MARTINEZ@acme.studio"] })).toEqual(["anab@x.io"]);
  });

  it("spam and drafts don't count; a sender marked as spam later is hidden unless written to", async () => {
    const spammer = { name: "Ana Prize", email: "ana@prize.biz" };
    const later = { name: "Ana Later", email: "ana@later.biz" };
    const c = await built([received(spammer, { spam: true }), sent([{ name: "Ana Draft", email: "ana@draft.io" }], { draft: true }), received(later), sent([ana])]);
    expect(emails(c, "ana")).toEqual([ana.email, later.email]);
    c.markSpam([later.email, ana.email]);
    expect(emails(c, "ana")).toEqual([ana.email]);
    // real mail from them again
    c.add(received(later));
    expect(emails(c, "ana")).toEqual([ana.email, later.email]);
  });

  it("automated senders rank below people", async () => {
    const c = await built([...Array.from({ length: 5 }, () => received({ name: "Notifications", email: "notifications@nube.io" })), received({ name: "Nuria", email: "nuria@x.io" })]);
    expect(emails(c, "n")[0]).toBe("nuria@x.io");
  });

  it("the draft's account boosts its correspondents, collision-free across account ids", async () => {
    const a = { name: "Sam One", email: "sam1@x.io" };
    const b = { name: "Sam Two", email: "sam2@x.io" };
    const c = await built([sent([a], { accountId: 1 }), sent([b], { accountId: 33 })]);
    expect(emails(c, "sam", { accountId: 33 })[0]).toBe(b.email);
    expect(emails(c, "sam", { accountId: 1 })[0]).toBe(a.email);
    // short queries go through the per-prefix cache: keyed by the account too
    expect(emails(c, "s", { accountId: 33 })[0]).toBe(b.email);
    expect(emails(c, "s", { accountId: 1 })[0]).toBe(a.email);
  });

  it("a message served twice counts once; a forgotten id can count again", async () => {
    const c = await built([]);
    const m = sent([ana]);
    c.add(m);
    c.add(m);
    const other = sent([{ name: "Ana Two", email: "ana2@x.io" }]);
    c.add(other);
    c.add(other);
    c.add(other);
    // one each: equal weight, so the older id first... both present once
    expect(emails(c, "ana").length).toBe(2);
    c.forget(other.id);
    c.add(other);
    expect(emails(c, "ana")[0]).toBe("ana2@x.io");
  });
});

/** deterministic people */
function people(n: number, seed: number): Address[] {
  let s = seed;
  const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const first = ["Ana", "Andrés", "Arjun", "Beatriz", "Bob", "Carla", "Chen", "Diego", "Élodie", "Fatima", "Gabriel", "Hana", "Iván", "José", "Julia", "Kenji", "Laura", "Luz", "María", "Mateo", "Nuria", "Óscar", "Priya", "Raúl", "Sofía", "Tomás", "Úrsula", "Valeria", "Xin", "Yuki", "Zoe", "王小明", "김민수"];
  const last = ["García", "López", "Patel", "Smith", "Müller", "Nguyen", "Rossi", "Kim", "Silva", "Fernández", "O'Brien", "Núñez", "Wang", "Sato"];
  const domains = ["gmail.com", "acme.studio", "orbita.dev", "lopez.mx", "univ.edu", "outlook.com"];
  return Array.from({ length: n }, (_, i) => {
    const f = first[Math.floor(rand() * first.length)]!;
    const l = last[Math.floor(rand() * last.length)]!;
    const local = `${fold(f)}.${fold(l)}${i}`.replace(/[^a-z0-9.]/g, "");
    return { name: rand() < 0.1 ? "" : `${f} ${l}`, email: `${local || "u" + i}@${domains[Math.floor(rand() * domains.length)]}` };
  });
}

describe("the index agrees with a brute-force oracle", () => {
  it("through a build, deltas, a merge and evictions with compaction", async () => {
    const ppl = people(1500, 7);
    let s = 3;
    const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    const msgs = Array.from({ length: 6000 }, () => {
      const p = ppl[Math.floor(Math.pow(rand(), 2) * ppl.length)]!;
      return rand() < 0.4 ? sent([p], { date: NOW - Math.floor(rand() * 700) * DAY, accountId: 1 + Math.floor(rand() * 3) }) : received(p, { date: NOW - Math.floor(rand() * 700) * DAY });
    });
    const c = await built(msgs.slice(0, 3000));
    for (const m of msgs.slice(3000)) c.add(m);
    const queries = ["ana 1", "a 2", "jose 3", "1", "12", "ana.g 4", "a", "an", "ana", "and", "ar", "pat", "gar", "jose", "maria", "mat", "nu", "o'b", "ob", "w", "王", "小明", "민", "zz", "acme", "orbita", "ana g", "lo", "l", "ap", "s", "so", "sof", "tomas", "yu", "x"];
    const check = () => {
      for (const q of queries) for (const accountId of [undefined, 1, 2]) expect(c.suggest(q, { accountId }), `${q} @${accountId}`).toEqual(c.suggestByScan(q, { accountId }));
    };
    check();
    await c.merge(clock());
    check();
    // evictions: a cap of 1,000 contacts, then compaction
    (c as unknown as { caps: { maxContacts: number; maxBytes: number } }).caps.maxContacts = 1000;
    const evicted = await c.enforceCaps(clock());
    expect(evicted).toBeGreaterThan(0);
    expect(c.size).toBeLessThanOrEqual(1000);
    check();
    await c.compact(clock());
    expect(c.dead).toBe(0);
    check();
    for (const m of msgs.slice(0, 500)) c.add({ ...m, id: m.id + 100_000 });
    check();
  });
});

describe("memory caps and snapshots", () => {
  it("repeated eviction cycles keep the index under its cap", async () => {
    const c = new ContactIndex({ now: () => NOW, caps: { maxContacts: 2000, maxBytes: 64 * 1024 * 1024 } });
    c.beginBuild({ epoch: "e", seq: 0 });
    await c.finishBuild(clock());
    let id = 1;
    for (let round = 0; round < 6; round++) {
      for (const p of people(1500, 100 + round)) c.add({ ...sent([{ ...p, email: `r${round}.${p.email}` }]), id: id++ });
      if (c.needsMerge()) await c.merge(clock());
      if (c.overCaps()) {
        await c.enforceCaps(clock());
        await c.compact(clock());
      }
      expect(c.size).toBeLessThanOrEqual(2000);
      expect(c.dead).toBe(0);
    }
    // memory follows the live contacts, not everyone ever seen (9,000)
    expect(c.allocatedBytes()).toBeLessThan(2 * 1024 * 1024);
  });

  it("a snapshot restores the same answers; damaged or foreign snapshots are refused", async () => {
    const ppl = people(800, 9);
    const c = await built(ppl.map((p, i) => (i % 3 ? received(p) : sent([p]))));
    c.add(sent([{ name: "Late Addition", email: "late@x.io" }]));
    c.revision = { epoch: "e", seq: 5 };
    const bytes = await c.snapshot("test", clock());
    const r = new ContactIndex({ now: () => NOW });
    expect(await r.restore(bytes, "test", clock())).toBe(true);
    r.setOwn([me.email]);
    expect(r.revision).toEqual({ epoch: "e", seq: 5 });
    for (const q of ["a", "ana", "pat", "late", "王", "lo", "luis@acme.studio"]) expect(r.suggest(q), q).toEqual(c.suggest(q));
    // the applied messages came along: serving one again doesn't count it twice
    const before = r.suggest("late");
    expect(before).toHaveLength(1);
    expect(await new ContactIndex().restore(bytes, "other", clock())).toBe(false);
    const flipped = bytes.slice();
    flipped[flipped.length - 9]! ^= 0xff;
    expect(await new ContactIndex().restore(flipped, "test", clock())).toBe(false);
    expect(await new ContactIndex().restore(bytes.slice(0, bytes.length >> 1), "test", clock())).toBe(false);
  });
});
