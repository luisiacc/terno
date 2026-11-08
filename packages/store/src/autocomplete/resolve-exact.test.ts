import type { Address } from "@terno/core";
import { describe, expect, it } from "vitest";
import type { ContactMessage } from "../autocomplete-source";
import { SliceClock } from "../instant/slices";
import { ContactIndex } from "./contacts";
import { namesSender } from "./senders";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 4);
let nextId = 1;
const me: Address = { name: "Me", email: "me@acme.test" };
const received = (from: Address, o: Partial<ContactMessage> = {}): ContactMessage => ({ id: nextId++, accountId: 1, date: NOW - DAY, sent: false, spam: false, draft: false, from, to: [me], cc: [], bcc: [], hasBody: true, ...o });
const sent = (to: Address[], o: Partial<ContactMessage> = {}): ContactMessage => ({ id: nextId++, accountId: 1, date: NOW - DAY, sent: true, spam: false, draft: false, from: me, to, cc: [], bcc: [], hasBody: true, ...o });

async function built(messages: ContactMessage[], later: ContactMessage[] = []): Promise<ContactIndex> {
  const c = new ContactIndex({ now: () => NOW });
  c.beginBuild({ epoch: "e", seq: 0 });
  for (const m of messages) c.add(m);
  await c.finishBuild(new SliceClock({}));
  for (const m of later) c.add(m);
  c.setOwn([me.email]);
  return c;
}

const tom = { name: "Tom Reed", email: "t.reed@acme.test" };
const tomas = { name: "Tomás Núñez", email: "tomas@acme.test" };
const dolores = { name: "Dolores O'Neil", email: "dolo@x.test" };

describe("resolveExact (plan 133 §5.1)", () => {
  it("is a whole name or address token, never a prefix, in the main index and what arrived since", async () => {
    const c = await built([received(tom), received(tomas)], [received(dolores)]);
    expect(c.resolveExact("tom").map((h) => h.email)).toEqual([tom.email]);
    expect(c.resolveExact("Reed").map((h) => h.email)).toEqual([tom.email]);
    expect(c.resolveExact("tomorrow")).toEqual([]);
    expect(c.resolveExact("to")).toEqual([]);
    expect(c.resolveExact("TOMÁS").map((h) => h.email)).toEqual([tomas.email]);
    expect(c.resolveExact("tomas").map((h) => h.email)).toEqual([tomas.email]);
    expect(c.resolveExact("dolo").map((h) => h.email)).toEqual([dolores.email]);
    expect(c.resolveExact("dolores").map((h) => h.email)).toEqual([dolores.email]);
    expect(c.resolveExact("")).toEqual([]);
  });

  it("ranks who you write to first, and more so on this account; bounded", async () => {
    const other = { name: "Tom Wu", email: "tom.wu@x.test" };
    const c = await built([sent([tom]), sent([other], { accountId: 2 })]);
    expect(c.resolveExact("tom", { limit: 1 }).length).toBe(1);
    expect(new Set(c.resolveExact("tom").map((h) => h.email))).toEqual(new Set([tom.email, other.email]));
    expect(c.resolveExact("tom", { accountId: 1 })[0]!.email).toBe(tom.email);
    expect(c.resolveExact("tom", { accountId: 2 })[0]!.email).toBe(other.email);
    const written = await built([received(other), sent([tom])]);
    expect(written.resolveExact("tom")[0]!.email).toBe(tom.email);
  });

  it("is never the user, and not someone only ever seen in spam", async () => {
    const spammer = { name: "Spam Prince", email: "prince@x.test" };
    const c = await built([received(me), received(spammer, { spam: true })]);
    c.markSpam([spammer.email]);
    expect(c.resolveExact("me")).toEqual([]);
    expect(c.resolveExact("prince")).toEqual([]);
  });
});

describe("a sender a sentence names (plan 161)", () => {
  const uber = { name: "Uber Receipts", email: "uber.receipts@uber.com" };
  const brew = { name: "Morning Brew", email: "crew@morningbrew.test" };
  const browser = { name: "The Browser", email: "hello@thebrowser.test" };
  const netflix = { name: "Netflix", email: "info@account.netflix.com" };
  const best = (c: ContactIndex, phrase: string) => c.bestSender(phrase.split(" ")[0]!, (h) => namesSender(phrase, h), { scan: 2000, enough: phrase.split(" ").length });

  it("only someone mail you received was from: not someone you only wrote to, nor a co-recipient, nor spam (Codex review)", async () => {
    const ana = { name: "Ana Ruiz", email: "ana@ruiz.test" };
    const bea = { name: "Bea Lima", email: "bea@lima.test" };
    const spammer = { name: "Prize Office", email: "prize@x.test" };
    const c = await built([received(uber, { cc: [bea] }), sent([ana]), received(spammer, { spam: true })]);
    c.markSpam([spammer.email]);
    expect(c.resolveExact("ana").map((h) => h.email)).toEqual([ana.email]);
    expect(best(c, "Ana")).toBe(0);
    expect(c.resolveExact("bea").map((h) => h.email)).toEqual([bea.email]);
    expect(best(c, "Bea")).toBe(0);
    expect(best(c, "Prize")).toBe(0);
    expect(best(c, "Uber")).toBe(1);
  });

  it("finds a sender by their domain's own label, a nameless one too (Codex review)", async () => {
    const c = await built([received({ name: "", email: netflix.email })]);
    expect(best(c, "Netflix")).toBe(1);
    expect(best(c, "account")).toBe(0);
  });

  it("qualifies every sender with the token before it stops, so a crowd of others doesn't hide the one that's named (Codex review)", async () => {
    const crowd = Array.from({ length: 40 }, (_, i) => received({ name: `Morning Brew ${i}`, email: `brew${i}@crowd.test` }, { date: NOW - DAY + i }));
    const c = await built([...crowd, received({ name: "Brew Logistics", email: "ops@logistics.test" }, { date: NOW - 30 * DAY })]);
    expect(c.resolveExact("brew", { limit: 20 }).some((h) => h.name === "Brew Logistics")).toBe(false);
    expect(best(c, "Brew")).toBe(1);
    // and the walk is bounded
    expect(c.bestSender("brew", (h) => namesSender("Brew", h), { scan: 5, enough: 1 })).toBe(0);
  });

  it("their name and the phrase agree until one ends, or the phrase starts with their domain's own label; never a word inside a name", () => {
    expect(namesSender("Uber", uber)).toBe(1);
    expect(namesSender("Uber Receipts", uber)).toBe(2);
    expect(namesSender("Morning Brew team", brew)).toBe(2);
    expect(namesSender("receipts", uber)).toBe(0);
    expect(namesSender("Netflix", netflix)).toBe(1);
    expect(namesSender("netflix", { name: "", email: netflix.email })).toBe(1);
    expect(namesSender("account", { name: "", email: netflix.email })).toBe(0);
    expect(namesSender("mercadolibre", { name: "", email: "info@mercadolibre.com.mx" })).toBe(1);
    expect(namesSender("com", { name: "", email: netflix.email })).toBe(0);
    expect(namesSender("Brew", brew)).toBe(0);
    expect(namesSender("Morning", brew)).toBe(1);
    expect(namesSender("Browser", browser)).toBe(1);
    expect(namesSender("BRÓWSER", browser)).toBe(1);
    expect(namesSender("", uber)).toBe(0);
    // Codex review: a shared first name isn't the person
    expect(namesSender("John Smith", { name: "John Doe", email: "john@doe.test" })).toBe(0);
    expect(namesSender("María José", { name: "María Fernanda López", email: "mf@lopez.test" })).toBe(0);
  });
});
