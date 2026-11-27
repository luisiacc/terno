import type { Address } from "@terno/core";
import { describe, expect, it } from "vitest";
import type { ContactMessage } from "../autocomplete-source";
import { SliceClock } from "../instant/slices";
import { cleanName, ContactIndex, contactTokens, normalizeEmail } from "./contacts";

describe("names as other clients mangle them (plan 34)", () => {
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
  c.setOwn([me]);
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
      sent([{ name: "Robert Smith", email: "bob@smith.io" }]),
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

describe("names people give themselves (plan 228)", () => {
  const dianela = { name: "Dianela Mompie", email: "dianela@mompie.cu" };

  it("your own address keeps your account's name, whatever others put in their To", async () => {
    // their To names you after themselves (a contact card of theirs, a forward), more than once
    const c = await built([1, 2, 3].map(() => received(dianela, { to: [{ name: "Dianela Mompie", email: "LUIS@acme.studio" }] })));
    expect(c.suggest("luis@acme.studio")).toEqual([me]);
    // the account says what you're called: a new sender name applies at once
    c.setOwn([{ email: me.email, name: "Luis C." }]);
    expect(c.suggest("luis@acme.studio")).toEqual([{ name: "Luis C.", email: me.email }]);
    // an account with no name: the bare address, never theirs
    c.setOwn([{ email: me.email, name: "" }]);
    expect(c.suggest("luis@acme.studio")).toEqual([{ name: "", email: me.email }]);
  });

  it("an alias is called what you sent from it as, never what others call it", async () => {
    const alias = { name: "Luis", email: "hola@luiscordero.dev" };
    const c = await built([
      ...[1, 2, 3].map(() => received(dianela, { to: [{ name: "Dianela Mompie", email: alias.email }] })),
      sent([ana], { from: alias }),
    ]);
    expect(c.suggest(alias.email)).toEqual([alias]);
    // known only from others' To before you send from it: no name yet, not theirs
    const d = await built([received(dianela, { to: [{ name: "Dianela Mompie", email: "otro@luiscordero.dev" }] }), sent([ana], { from: { name: "", email: "otro@luiscordero.dev" } })]);
    expect(d.suggest("otro@luiscordero.dev")).toEqual([{ name: "", email: "otro@luiscordero.dev" }]);
  });

  it("the name in someone's own From beats heavier names others gave them, which stay searchable", async () => {
    const bob = { name: "Robert Smith", email: "bob@smith.io" };
    const c = await built([
      // others call him Bob (Finance), often and recently; you've copied it in your replies
      ...[1, 2, 3, 4].map((i) => received(ana, { to: [me, { name: "Bob (Finance)", email: bob.email }], date: NOW - i * 3600_000 })),
      sent([{ name: "Bob (Finance)", email: bob.email }]),
      // he wrote to you once, long ago, as himself
      received(bob, { date: NOW - 300 * DAY }),
    ]);
    expect(c.suggest("bob")).toEqual([bob]);
    expect(emails(c, "finance")).toEqual([bob.email]);
    // someone who never wrote: the names others gave are all there is
    const d = await built([sent([{ name: "Carla Ruiz", email: "carla@ruiz.mx" }])]);
    expect(d.suggest("carla")).toEqual([{ name: "Carla Ruiz", email: "carla@ruiz.mx" }]);
  });

  it("their own name finds room when others' names fill the alternates, and the most used of their own shows", async () => {
    const email = "eva@lund.se";
    const c = await built([
      sent([{ name: "Eva L", email }]), sent([{ name: "Eva Accounts", email }]), sent([{ name: "Eva from Lund", email }]),
      received({ name: "Eva Lund", email }, { date: NOW - 2 * DAY }),
      received({ name: "Eva Lundqvist", email }, { date: NOW - DAY }),
      received({ name: "Eva Lundqvist", email }),
    ]);
    expect(c.suggest("eva")).toEqual([{ name: "Eva Lundqvist", email }]);
    expect(emails(c, "lund")).toEqual([email]);
  });

  it("once they use a name themselves, it's their spelling, and only their own uses of it count (Codex review)", async () => {
    const jose = "jose@garcia.es";
    const c = await built([
      ...[1, 2, 3].map(() => sent([{ name: "JOSE GARCIA", email: jose }])),
      received({ name: "José García", email: jose }),
    ]);
    expect(c.suggest("jose")).toEqual([{ name: "José García", email: jose }]);
    // others call him Robert a hundred times; he signs Robert once and Roberto twice: Roberto
    const bob = "rob@x.io";
    const d = await built([
      ...Array.from({ length: 100 }, () => sent([{ name: "Robert", email: bob }])),
      received({ name: "Robert", email: bob }),
      received({ name: "Roberto", email: bob }), received({ name: "Roberto", email: bob }),
    ]);
    expect(d.suggest("rob")).toEqual([{ name: "Roberto", email: bob }]);
  });

  it("a name others gave that becomes their own keeps the alternates bounded (Codex review)", async () => {
    const email = "kai@x.io";
    const msgs = [received({ name: "Kai Berg", email })];
    for (let i = 0; i < 50; i++) msgs.push(sent([{ name: `Alias ${i}`, email }]), received({ name: `Alias ${i}`, email }));
    const c = await built(msgs);
    const alts = (c as unknown as { alts: Map<number, unknown[]> }).alts;
    expect(Math.max(...[...alts.values()].map((a) => a.length))).toBeLessThanOrEqual(4);
    expect(emails(c, "alias 49")).toEqual([]);
  });

  it("an account's sender name that is its address's local part is still its name (Codex review)", async () => {
    const john = { name: "John", email: "john@example.com" };
    const c = await built([received(dianela, { to: [{ name: "John Smith", email: john.email }] })]);
    c.setOwn([john]);
    expect(c.suggest(john.email)).toEqual([john]);
    // the address itself is no name
    c.setOwn([{ email: john.email, name: john.email }]);
    expect(c.suggest(john.email)).toEqual([{ name: "", email: john.email }]);
  });

  it("their spelling, once theirs, is found by its own words (Codex review)", async () => {
    const email = "sq@mail.ie";
    const c = await built([sent([{ name: "Sean O\uFF07Brien", email }]), received({ name: "Sean O'Brien", email })]);
    expect(c.suggest("obrien")).toEqual([{ name: "Sean O'Brien", email }]);
    const d = await built([received({ name: "Seán Ó Briain", email }), sent([{ name: "Sean O\uFF07Brien", email }]), received({ name: "Sean O'Brien", email }), received({ name: "Sean O'Brien", email })]);
    expect(d.suggest("obrien")).toEqual([{ name: "Sean O'Brien", email }]);
  });

  it("a snapshot keeps who named whom", async () => {
    const bob = { name: "Robert Smith", email: "bob@smith.io" };
    const c = await built([received(bob, { date: NOW - 300 * DAY }), sent([{ name: "Bobby", email: bob.email }])]);
    c.revision = { epoch: "e", seq: 1 };
    const r = new ContactIndex({ now: () => NOW });
    expect(await r.restore(await c.snapshot("test", clock()), "test", clock())).toBe(true);
    r.setOwn([me]);
    // after the restore, names others give still don't replace his own
    for (let i = 0; i < 3; i++) r.add(sent([{ name: "Bobby", email: bob.email }]));
    expect(r.suggest("bob")).toEqual([bob]);
  });
});

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
    r.setOwn([me]);
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

describe("People's lists (plan 281)", () => {
  const priya = { name: "Priya Shah", email: "priya@greenway.studio" };
  const shop = { name: "Shop", email: "no-reply@shop.example" };

  it("written: only those you wrote to, never your own, best first, capped", async () => {
    const c = await built([
      sent([ana]),
      sent([ana]),
      sent([andres], { date: NOW - 30 * DAY }),
      received(priya),
      received(shop),
      // an alias of yours you once sent to: never a person here
      sent([{ name: "Luis", email: "luis@acme.studio" }]),
    ]);
    expect(c.written(10).map((p) => p.email)).toEqual([ana.email, andres.email]);
    expect(c.written(1).map((p) => p.email)).toEqual([ana.email]);
    expect(c.written(10)[0]).toMatchObject({ name: "Ana Martínez", written: true, last: NOW - DAY });
  });

  it("written follows new mail (sorted once per version of the scores)", async () => {
    const c = await built([sent([ana]), sent([ana]), sent([andres])]);
    expect(c.written(10).map((p) => p.email)).toEqual([ana.email, andres.email]);
    for (let i = 0; i < 5; i++) c.add(sent([andres]));
    expect(c.written(10).map((p) => p.email)).toEqual([andres.email, ana.email]);
  });

  it("people: names, addresses and domains by prefix, written to or not, never your own, past suggest's 20", async () => {
    const many = Array.from({ length: 30 }, (_, i) => received({ name: `Greta ${i}`, email: `greta${i}@x${i}.com` }));
    const c = await built([sent([ana]), received(priya), received({ name: "Luis Cordero", email: "luis@acme.studio" }), ...many]);
    expect(c.people("pri").map((p) => p.email)).toEqual([priya.email]);
    expect(c.people("greenway").map((p) => p.email)).toEqual([priya.email]);
    expect(c.people("luis").map((p) => p.email)).not.toContain("luis@acme.studio");
    expect(c.people("gre").length).toBe(31);
    expect(c.people("gre", 25).length).toBe(25);
    expect(c.people("pri")[0]).toMatchObject({ written: false });
  });

  it("people: a piece of an address finds whoever's address holds it (a domain with its dot, a common provider)", async () => {
    const c = await built([sent([ana]), received(priya), received({ name: "Sofía Romero", email: "sofia.romero27@gmail.com" })]);
    expect(c.people("acme.studio").map((p) => p.email)).toEqual([ana.email]);
    expect(c.people("greenway.studio").map((p) => p.email)).toEqual([priya.email]);
    expect(c.people("gmail").map((p) => p.email)).toEqual(["sofia.romero27@gmail.com"]);
    expect(c.people("@gmail.com").map((p) => p.email)).toEqual(["sofia.romero27@gmail.com"]);
  });

  it("person: what's known of one address, any case", async () => {
    const c = await built([sent([ana])]);
    expect(c.person("ANA.martinez@acme.studio")).toMatchObject({ name: "Ana Martínez", written: true });
    expect(c.person("nobody@x.com")).toBeNull();
  });
});

describe("People's filter (plan 287)", () => {
  const bea = { name: "Bea Ortiz", email: "bea@ortiz.studio" };
  const carl = { name: "Carl Nunes", email: "carl@nunes.dev" };
  const dora = { name: "Dora Vélez", email: "dora@velez.dev" };
  const emails = (list: readonly { email: string }[]) => list.map((p) => p.email);

  it("Everyone in an account is who you wrote to from it; one only copied there isn't (the search still finds them)", async () => {
    const c = await built([
      sent([ana], { accountId: 1 }),
      // bea: written to from account 2 only, copied on mail in account 1
      sent([bea], { accountId: 2 }),
      received(andres, { accountId: 1, cc: [bea] }),
      sent([carl], { accountId: 2 }),
    ]);
    expect(emails(c.written(10, { accounts: [1] }))).toEqual([ana.email]);
    expect(emails(c.written(10, { accounts: [2] })).sort()).toEqual([bea.email, carl.email].sort());
    expect(emails(c.written(10, { accounts: [1, 2] })).sort()).toEqual([ana.email, bea.email, carl.email].sort());
    // seen in account 1 (copied): the search finds her there
    expect(emails(c.people("bea", 50, { accounts: [1] }))).toEqual([bea.email]);
    expect(emails(c.people("carl", 50, { accounts: [1] }))).toEqual([]);
    // an account the index never saw: nobody (never everyone)
    expect(c.written(10, { accounts: [99] })).toEqual([]);
    expect(c.people("a", 50, { accounts: [99] })).toEqual([]);
  });

  it("the date is the last message in the chosen accounts, exact when someone is in several", async () => {
    const c = await built([
      // ana: account 1 a year ago, account 2 yesterday
      sent([ana], { accountId: 1, date: NOW - 300 * DAY }),
      sent([ana], { accountId: 2, date: NOW - DAY }),
      // andres: account 1 only, last week
      sent([andres], { accountId: 1, date: NOW - 5 * DAY }),
    ]);
    const month = NOW - 30 * DAY;
    expect(emails(c.written(10, { since: month })).sort()).toEqual([ana.email, andres.email].sort());
    expect(emails(c.written(10, { accounts: [1], since: month }))).toEqual([andres.email]);
    expect(emails(c.written(10, { accounts: [2], since: month }))).toEqual([ana.email]);
    expect(c.written(10, { accounts: [1] }).find((p) => p.email === ana.email)?.last).toBe(NOW - 300 * DAY);
    expect(c.lastWith(ana.email, [1])).toBe(NOW - 300 * DAY);
    expect(c.lastWith(ana.email, [2])).toBe(NOW - DAY);
    expect(c.lastWith(ana.email)).toBe(NOW - DAY);
    expect(c.lastWith(ana.email, [99])).toBe(0);
    expect(c.lastWith("nobody@x.io", [1])).toBeNull();
    // a third account later: its own date, the first two's kept
    c.add(received(ana, { accountId: 3, date: NOW - 2 * DAY }));
    expect([c.lastWith(ana.email, [1]), c.lastWith(ana.email, [3]), c.lastWith(ana.email, [1, 3])]).toEqual([NOW - 300 * DAY, NOW - 2 * DAY, NOW - 2 * DAY]);
  });

  it("the filter applies before the cut, and each filter is its own list (kept until the scores move)", async () => {
    const c = await built([
      ...Array.from({ length: 5 }, () => sent([ana], { accountId: 1 })),
      ...Array.from({ length: 3 }, () => sent([andres], { accountId: 1 })),
      sent([dora], { accountId: 2 }),
    ]);
    expect(emails(c.written(1))).toEqual([ana.email]);
    expect(emails(c.written(1, { accounts: [2] }))).toEqual([dora.email]);
    const first = c.written(5, { accounts: [1] });
    expect(c.written(5, { accounts: [1] })).toBe(first);
    c.add(sent([dora], { accountId: 1 }));
    expect(emails(c.written(5, { accounts: [1] }))).toEqual([ana.email, andres.email, dora.email]);
  });

  it("a narrow filter still fills the search past the short query's cached top", async () => {
    const many = Array.from({ length: 300 }, (_, i) => sent([{ name: `Ana ${i}`, email: `ana${i}@x${i}.com` }], { accountId: 1 }));
    const c = await built([...many, ...Array.from({ length: 30 }, (_, i) => received({ name: `Ana Two ${i}`, email: `two${i}@y.com` }, { accountId: 2 }))]);
    expect(c.people("a", 50, { accounts: [2] })).toHaveLength(30);
    expect(c.people("a", 50, { accounts: [2] }).every((p) => p.email.endsWith("@y.com"))).toBe(true);
  });

  it("an evicted contact's per-account dates go at once, not at the next compaction (Codex code review)", async () => {
    const k = new ContactIndex({ now: () => NOW, caps: { maxContacts: 2, maxBytes: 64 * 1024 * 1024 } });
    k.beginBuild({ epoch: "e", seq: 0 });
    // zed: copied in two accounts, never written to (the least ranked); ana and bea written to
    for (const m of [received(andres, { accountId: 1, cc: [{ name: "Zed", email: "zed@z.io" }] }), received(andres, { accountId: 2, cc: [{ name: "Zed", email: "zed@z.io" }] }), sent([ana], { accountId: 1 }), sent([ana], { accountId: 1 }), sent([bea], { accountId: 1 }), sent([bea], { accountId: 1 })]) k.add(m);
    await k.finishBuild(clock());
    const before = k.perAccountDates().contacts;
    expect(before).toBeGreaterThan(0);
    while (k.overCaps()) await k.enforceCaps(clock());
    expect(k.person("zed@z.io")).toBeNull();
    expect(k.perAccountDates().contacts).toBeLessThan(before);
  });

  it("the shared pool: a contact gaining accounts moves its dates, garbage is packed away, every date stays right", async () => {
    // many contacts each seen in turn in up to 5 accounts: their pairs move (and the pool packs) many times
    const k = await built([]);
    const who = Array.from({ length: 400 }, (_, i) => ({ name: `P ${i}`, email: `p${i}@x.io` }));
    for (let a = 1; a <= 5; a++) for (const [i, p] of who.entries()) k.add(sent([p], { accountId: a, date: NOW - (a * 1000 + i) * 60_000 }));
    for (const [i, p] of who.entries()) for (let a = 1; a <= 5; a++) expect(k.lastWith(p.email, [a])).toBe(NOW - (a * 1000 + i) * 60_000);
    expect(k.perAccountDates().contacts).toBe(400);
    // 400 contacts × 5 pairs × 16 bytes live: the pool holds no more than about twice that
    expect(k.perAccountDates().bytes).toBeLessThanOrEqual(2 * 400 * 5 * 16 + 4096 * 8);
  });

  it("a snapshot whose per-account dates don't agree with its accounts is refused (Codex code review)", async () => {
    type Inside = { pool: Float64Array; lastAt: Uint32Array; lastN: Uint8Array; sentIn: Uint32Array };
    const make = async () => {
      const c = await built([sent([ana], { accountId: 1, date: NOW - 300 * DAY }), sent([ana], { accountId: 2, date: NOW - DAY })]);
      c.revision = { epoch: "e", seq: 1 };
      const inside = c as unknown as Inside;
      const id = inside.lastN.findIndex((n) => n > 0);
      return { c, inside, id, at: inside.lastAt[id]! - 1 };
    };
    const refused = async (c: ContactIndex) => expect(await new ContactIndex({ now: () => NOW }).restore(await c.snapshot("test", clock()), "test", clock())).toBe(false);
    // an account's pair twice
    const twice = await make();
    twice.inside.pool[twice.at + 2] = twice.inside.pool[twice.at]!;
    await refused(twice.c);
    // one of its accounts' pairs missing (another account's in its place)
    const short = await make();
    short.inside.pool[short.at + 2] = 5;
    await refused(short.c);
    // written to from an account never seen there
    const stranger = await make();
    stranger.inside.sentIn[stranger.id] = 0b100;
    await refused(stranger.c);
    // and the honest one restores
    const ok = await make();
    expect(await new ContactIndex({ now: () => NOW }).restore(await ok.c.snapshot("test", clock()), "test", clock())).toBe(true);
  });

  it("a snapshot and a compaction keep each account's dates and whom you wrote from where; memory counts them", async () => {
    const c = await built([sent([ana], { accountId: 1, date: NOW - 300 * DAY }), sent([ana], { accountId: 2, date: NOW - DAY }), sent([bea], { accountId: 2 }), received(carl, { accountId: 1, cc: [bea] })]);
    c.revision = { epoch: "e", seq: 1 };
    const r = new ContactIndex({ now: () => NOW });
    expect(await r.restore(await c.snapshot("test", clock()), "test", clock())).toBe(true);
    r.setOwn([me]);
    for (const x of [c, r]) {
      expect(x.lastWith(ana.email, [1])).toBe(NOW - 300 * DAY);
      expect(x.lastWith(ana.email, [2])).toBe(NOW - DAY);
      expect(emails(x.written(10, { accounts: [1] }))).toEqual([ana.email]);
    }
    const plain = await built([sent([andres], { accountId: 1 })]);
    expect(c.allocatedBytes()).toBeGreaterThan(plain.allocatedBytes());
    // compaction: the least ranked go, ids move; ana's dates move with her
    const k = new ContactIndex({ now: () => NOW, caps: { maxContacts: 3, maxBytes: 64 * 1024 * 1024 } });
    k.beginBuild({ epoch: "e", seq: 0 });
    for (const m of [received({ name: "Zed", email: "zed@z.io" }, { accountId: 1 }), received({ name: "Yan", email: "yan@y.io" }, { accountId: 1 }), sent([ana], { accountId: 1, date: NOW - 300 * DAY }), sent([ana], { accountId: 2, date: NOW - DAY }), sent([bea], { accountId: 2 })]) k.add(m);
    await k.finishBuild(clock());
    k.setOwn([me]);
    while (k.overCaps()) await k.enforceCaps(clock());
    await k.compact(clock());
    expect(k.person("zed@z.io")).toBeNull();
    expect([k.lastWith(ana.email, [1]), k.lastWith(ana.email, [2])]).toEqual([NOW - 300 * DAY, NOW - DAY]);
    expect(emails(k.written(10, { accounts: [2] })).sort()).toEqual([ana.email, bea.email].sort());
  });
});
