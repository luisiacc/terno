import type { Address } from "@terno/core";
import { describe, expect, it } from "vitest";
import type { ContactMessage } from "../autocomplete-source";
import { SliceClock } from "../instant/slices";
import { ContactIndex } from "./contacts";

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
