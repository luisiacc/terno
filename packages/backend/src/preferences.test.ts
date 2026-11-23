/**
 * Plan 248 through the real backend (RPC, settings, limiter, SQLite), with a scripted model and clock: the user's words
 * around the dated reader. Its first test is the owner's bar: an empty box (never saved, or cleared) and words that reach
 * nothing leave every request of the dated reader byte for byte what it was.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, promptText, type AiOptions, type Completion, type CompletionRequest, type ProviderConfig } from "@terno/ai";
import type { TodayList } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { msg, threadOf } from "@terno/store/conformance";
import type { IncomingMessage } from "@terno/store";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { checkWanted, excerptAround } from "./preferences";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 11, 10, 12);
const me = { name: "Me", email: "me@terno.test" };
const power = { name: "Power Co", email: "billing@power.test" };
const parcel = { name: "Parcelo", email: "track@parcelo.test" };
const rei = { name: "REI", email: "deals@rei.test" };
const school = { name: "Lincoln Elementary", email: "office@lincoln.test" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type Item = { kind: string; text: string; quote: string; due: string | null; time: string | null };
const dated = (items: Item[] = []): Completion => ({ text: JSON.stringify({ items, settled: [], moved: [], replaced: [] }), stop: "end" });
const json = (value: unknown): Completion => ({ text: JSON.stringify(value), stop: "end" });
type Rule = { said: string; effect: string; kinds?: string[]; senders?: string[]; about?: string | null; unless?: string | null; cues?: string[]; understood?: string };
const compiled = (rules: Rule[], notes: { said: string; kind: string; text: string }[] = []) =>
  json({ rules: rules.map((r) => ({ kinds: [], senders: [], names: [], about: null, unless: null, cues: [], understood: r.said, ...r })), notes });

const BILL = { subject: "Your bill", bodyText: "Your electricity bill of $54.20 is due on November 20." };
const billItem: Item = { kind: "pay", text: "Pay the electricity bill", quote: "due on November 20", due: "2026-11-20", time: null };
const DELIVERY = { subject: "Your parcel", bodyText: "Your parcel arrives on November 12." };
const deliveryItem: Item = { kind: "delivery", text: "Parcel arrives", quote: "Your parcel arrives on November 12.", due: "2026-11-12", time: null };
const SALE = { subject: "REI members sale", bodyText: "Our members sale ends November 15. Up to 40% off tents.", listId: "<deals.rei.test>", gmailLabels: ["INBOX", "CATEGORY_PROMOTIONS"] };

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-words-"));
  const model = {
    requests: [] as CompletionRequest[],
    gate: null as Promise<void> | null,
    dated: (_r: CompletionRequest): Completion => dated(),
    compile: (_r: CompletionRequest): Completion => compiled([]),
    match: (_r: CompletionRequest): Completion => json({ matches: [] }),
    wanted: (_r: CompletionRequest): Completion => json({ items: [] }),
  };
  const clock = { now: NOW };
  const factory = (config: ProviderConfig, options: AiOptions) =>
    createAi(config, {
      ...options,
      transport: {
        complete: async (req) => {
          model.requests.push(req);
          if (model.gate) await Promise.race([model.gate, new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true }))]);
          switch (req.schema?.name) {
            case "dated_mail":
              return model.dated(req);
            case "what_matters_preferences":
              return model.compile(req);
            case "preference_matches":
              return model.match(req);
            case "wanted_mail":
              return model.wanted(req);
            default:
              return json({});
          }
        },
      },
    });
  const backend = new Backend({ dbPath: join(dir, "d.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => clock.now });
  await backend.store.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: me.email, displayName: "Me", color: "brown", now: 0 });
  await client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
  await client.call("settings.update", { dated: { enabled: false } });
  await client.call("settings.update", { dated: { enabled: true } });
  clock.now += 120_000;
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  let seq = 0;
  const receive = async (over: Partial<IncomingMessage> = {}) => {
    const id = `r-${seq++}`;
    const m = msg({ accountId: account.id, from: power, to: [me], isSent: false, inInbox: true, isRead: false, date: clock.now - 60_000 + seq, ...BILL, providerMsgId: id, ...over });
    await backend.ingestSliced([m], true, undefined, undefined, undefined, undefined, undefined, true);
    return threadOf(backend.store, id);
  };
  const settled = async () => {
    // a projection asks the matcher about what it found unjudged (the list's and the count's alike)
    await client.call("today.list", { held: [] });
    backend.dated.wake();
    await expect.poll(() => backend.store.dated.marks.count()).toBe(0);
    backend.words.worker.wake();
    await expect.poll(() => backend.store.whatMatters.wanted.marks.count()).toBe(0);
    await expect.poll(() => backend.words.worker.status().applying).toBeNull();
  };
  const list = (): Promise<TodayList> => client.call("today.list", { held: [] });
  const threads = async () => (await list()).sections.flatMap((x) => x.items.map((i) => i.thread.id));
  const words = async (text: string) => {
    const { preferences } = await client.call("whatMatters.words", {});
    return client.call("whatMatters.words.save", { text, revision: preferences.revision });
  };
  const of = (name: string) => model.requests.filter((r) => r.schema?.name === name);
  return { backend, client, model, clock, receive, settled, list, threads, words, of, account };
}

/** A dated reading as sent: its system words, its prompt and its schema's name, nothing else. */
const sent = (r: CompletionRequest) => ({ system: promptText(r.system), prompt: promptText(r.messages[0]!.content), schema: r.schema?.name, maxTokens: r.maxTokens, effort: r.effort });

describe("the empty box (plan 248 §9: the owner's bar)", () => {
  /** the same mail through a fresh backend, the words as `prepare` leaves them; what the dated reader sent */
  async function readings(prepare: (t: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
    const t = await setup();
    t.model.dated = (r) => (promptText(r.messages[0]!.content).includes("electricity") ? dated([billItem]) : promptText(r.messages[0]!.content).includes("parcel") ? dated([deliveryItem]) : dated());
    await prepare(t);
    t.model.requests.length = 0;
    await t.receive();
    await t.receive({ from: parcel, ...DELIVERY, listId: "<p.list>" });
    await t.receive({ from: rei, ...SALE });
    await t.receive({ from: { name: "Ana", email: "ana@people.test" }, subject: "Lunch?", bodyText: "Could you send me the deck by Friday?" });
    await t.receive({ from: { name: "News", email: "news@daily.test" }, subject: "Today's news", bodyText: "Nothing much happened.", listId: "<news>" });
    await t.settled();
    // what shows, whole: each section's rows by id, in order, with their words; the counts; each conversation's line
    const list = await t.list();
    const rows = { counts: list.counts, sections: list.sections.map((x) => ({ kind: x.kind, day: x.day, part: x.part, items: x.items.map((i) => ({ id: i.id, thread: i.thread.id, why: i.why })) })) };
    const lines = await Promise.all(list.sections.flatMap((x) => x.items).map((i) => t.client.call("dated.ofThread", { threadId: i.thread.id })));
    return { dated: t.of("dated_mail").map(sent), other: t.model.requests.filter((r) => r.schema?.name !== "dated_mail").map((r) => r.schema?.name), rows, lines };
  }

  it("never saved, cleared, and words that reach nothing: the dated reader's requests are the same, byte for byte", async () => {
    const never = await readings(async () => {});
    const cleared = await readings(async (t) => {
      t.model.compile = () => compiled([{ said: "Hide deliveries", effect: "hide", kinds: ["delivery"] }]);
      await t.words("Hide deliveries");
      const { preferences } = await t.client.call("whatMatters.words", {});
      await t.client.call("whatMatters.words.clear", { revision: preferences.revision });
    });
    const whitespace = await readings(async (t) => void (await t.words("   \n ")));
    // words with every effect, none of which reaches this mail (another sender, a kind it hasn't, cues it doesn't say)
    const elsewhere = await readings(async (t) => {
      t.model.compile = () =>
        compiled([
          { said: "Hide everything from @nowhere.test", effect: "hide", senders: ["@nowhere.test"] },
          { said: "Flights first", effect: "first", kinds: ["event"] },
          { said: "Show sales at Kayak Co", effect: "show", about: "a sale at Kayak Co", cues: ["Kayak Co"] },
        ]);
      await t.words("Hide everything from @nowhere.test. Flights first. Show sales at Kayak Co.");
    });
    expect(never.dated.length).toBeGreaterThan(0);
    for (const other of [cleared, whitespace, elsewhere]) expect(other.dated).toEqual(never.dated);
    // and nothing else asked of the model: no matcher, no second reader (the compile is the words' own)
    expect(never.other).toEqual([]);
    expect(cleared.other).toEqual([]);
    expect(whitespace.other).toEqual([]);
    expect(elsewhere.other.filter((n) => n !== "what_matters_preferences")).toEqual([]);
    // what shows is the same too: every row, its order and words, the counts, each conversation's line
    expect(never.rows.sections.length).toBeGreaterThan(0);
    for (const other of [cleared, whitespace, elsewhere]) {
      expect(other.rows).toEqual(never.rows);
      expect(other.lines).toEqual(never.lines);
    }
  });
});

describe("hide and first (plan 248 §4)", () => {
  it("an exact hide takes a kind out of the list and the count at once, with no request; Clear brings it back and its Undo hides it again", async () => {
    const t = await setup();
    t.model.dated = (r) => (promptText(r.messages[0]!.content).includes("parcel") ? dated([deliveryItem]) : dated([billItem]));
    const bill = await t.receive();
    const box = await t.receive({ from: parcel, ...DELIVERY });
    await t.settled();
    expect(await t.threads()).toEqual(expect.arrayContaining([bill, box]));
    t.model.compile = () => compiled([{ said: "No more package deliveries", effect: "hide", kinds: ["delivery"] }]);
    t.model.requests.length = 0;
    await t.words("No more package deliveries");
    await t.settled();
    expect(await t.threads()).toEqual([bill]);
    // only the compile went out: a hide of a kind needs no judgment
    expect(t.model.requests.map((r) => r.schema?.name)).toEqual(["what_matters_preferences"]);
    const { preferences } = await t.client.call("whatMatters.words", {});
    expect(preferences.rules).toMatchObject([{ effect: "hide", kinds: ["delivery"], understood: "No more package deliveries" }]);
    const cleared = await t.client.call("whatMatters.words.clear", { revision: preferences.revision });
    expect(await t.threads()).toEqual(expect.arrayContaining([bill, box]));
    if ("stale" in cleared) throw new Error("stale");
    await t.client.call("whatMatters.words.undoClear", { undoId: cleared.undoId!, revision: cleared.preferences.revision });
    expect(await t.threads()).toEqual([bill]);
  });

  it("a judged hide asks the matcher with the row's words, keeps an exception, and drops a match whose evidence isn't the row's", async () => {
    const t = await setup();
    t.model.dated = () => dated([deliveryItem]);
    const plain = await t.receive({ from: parcel, ...DELIVERY });
    const signed = await t.receive({ from: parcel, subject: "Signature needed", bodyText: "Your parcel arrives on November 12. An adult signature is required." });
    await t.settled();
    t.model.compile = () => compiled([{ said: "No deliveries unless I have to sign", effect: "hide", kinds: ["delivery"], unless: "the delivery needs a signature" }]);
    t.model.match = (r) => {
      const prompt = promptText(r.messages[0]!.content);
      const rows = [...prompt.matchAll(/<row id="(t\d+)">\n[\s\S]*?excerpt: ([^\n]*)\n<\/row>/gu)].map((m) => ({ id: m[1]!, excerpt: m[2]! }));
      // the plain one matches with its own words; the signed one is the exception
      return json({ matches: rows.filter((x) => !x.excerpt.includes("signature")).map((x) => ({ target: x.id, rule: "r1", evidence: "Your parcel arrives" })) });
    };
    await t.words("No deliveries unless I have to sign");
    await t.settled();
    expect(await t.threads()).toEqual([signed]);
    // the first reading, then the hide confirmed before the row goes
    expect(t.of("preference_matches")).toHaveLength(2);
    expect(promptText(t.of("preference_matches")[1]!.system)).toContain("A first reading matched these rows to these hide rules");
    // the rows went with the mail's words around them, never another conversation's
    const prompt = promptText(t.of("preference_matches")[0]!.messages[0]!.content);
    expect(prompt).toContain("An adult signature is required");
    expect(plain).not.toBe(signed);
  });

  it("evidence the row doesn't hold is no match: the row stays", async () => {
    const t = await setup();
    t.model.dated = () => dated([deliveryItem]);
    const box = await t.receive({ from: parcel, ...DELIVERY });
    await t.settled();
    t.model.compile = () => compiled([{ said: "Hide school newsletters", effect: "hide", about: "a school newsletter" }]);
    t.model.match = () => json({ matches: [{ target: "t1", rule: "r1", evidence: "Lincoln Elementary weekly bulletin" }] });
    await t.words("Hide school newsletters");
    await t.settled();
    expect(await t.threads()).toEqual([box]);
  });

  it("a new row a judged hide may reach waits for its verdict: never shown and then taken away", async () => {
    const t = await setup();
    t.model.compile = () => compiled([{ said: "Hide school newsletters", effect: "hide", about: "a newsletter from a school" }]);
    await t.words("Hide school newsletters");
    t.clock.now += 1000;
    let release = () => {};
    t.model.match = () => json({ matches: [{ target: "t1", rule: "r1", evidence: "Field day" }] });
    t.model.dated = () => dated([{ kind: "event", text: "Field day", quote: "Field day is on November 13.", due: "2026-11-13", time: null }]);
    const fieldDay = await t.receive({ from: school, subject: "Field day", bodyText: "Field day is on November 13." });
    t.backend.dated.wake();
    await expect.poll(() => t.backend.store.dated.marks.count()).toBe(0);
    // the matcher held at the provider: the item is stored, and not shown meanwhile
    t.model.gate = new Promise<void>((r) => (release = r));
    await t.list();
    await expect.poll(() => t.of("preference_matches").length).toBe(1);
    expect((await t.backend.store.dated.active()).map((r) => r.threadId)).toContain(fieldDay);
    expect(await t.threads()).not.toContain(fieldDay);
    release();
    t.model.gate = null;
    await t.settled();
    expect(await t.threads()).not.toContain(fieldDay);
  });

  it("first puts its rows at the top of their own section, keeping the rest's order", async () => {
    const t = await setup();
    t.model.dated = (r) =>
      promptText(r.messages[0]!.content).includes("electricity")
        ? dated([{ ...billItem, due: "2026-11-11", quote: "due on November 11" }])
        : dated([{ kind: "respond", text: "Send the form", quote: "Send the form by November 11.", due: "2026-11-11", time: null }]);
    const form = await t.receive({ from: school, subject: "Form", bodyText: "Send the form by November 11." });
    const bill = await t.receive({ ...BILL, bodyText: "Your electricity bill of $54.20 is due on November 11." });
    await t.settled();
    const before = (await t.list()).sections.find((x) => x.items.some((i) => i.thread.id === bill))!;
    t.model.compile = () => compiled([{ said: "Bills first", effect: "first", kinds: ["pay"] }]);
    await t.words("Bills first");
    await t.settled();
    const after = (await t.list()).sections.find((x) => x.items.some((i) => i.thread.id === bill))!;
    expect(after.items[0]!.thread.id).toBe(bill);
    expect(after.items.map((i) => i.thread.id).sort()).toEqual(before.items.map((i) => i.thread.id).sort());
    expect(form).not.toBe(bill);
  });
});

describe("show: the second reader (plan 248 §5)", () => {
  it("brings in a Promotions sale the user asked for, which the dated reader never reads, as an item of its own with Done and Undo", async () => {
    const t = await setup();
    t.model.compile = () => compiled([{ said: "Tell me about sales at REI", effect: "show", about: "a sale or offer from REI, with when it ends", cues: ["REI"] }]);
    await t.words("Tell me about sales at REI");
    t.model.wanted = () => json({ items: [{ rule: "r1", kind: "expire", text: "REI members sale ends (up to 40% off tents)", quote: "Our members sale ends November 15.", due: "2026-11-15", time: null }] });
    const sale = await t.receive({ from: rei, ...SALE });
    await t.settled();
    // v16 never saw it (Promotions), the second reader did, once
    expect(t.of("dated_mail")).toHaveLength(0);
    expect(t.of("wanted_mail")).toHaveLength(1);
    const prompt = promptText(t.of("wanted_mail")[0]!.messages[0]!.content);
    expect(prompt).toContain("<rules>\nr1: about: a sale or offer from REI");
    const row = (await t.list()).sections.flatMap((x) => x.items).find((i) => i.thread.id === sale)!;
    expect(row.id).toMatch(/^dated:-\d+$/);
    expect(row.why.item).toMatchObject({ kind: "expire", wanted: true });
    // Done and its Undo, on the wanted store
    const id = Number(row.id.slice("dated:".length));
    const { undoId } = await t.client.call("dated.act", { id, revision: row.why.item!.revision, action: "done" });
    expect(await t.threads()).not.toContain(sale);
    await t.client.call("dated.undo", { undoId: undoId! });
    expect(await t.threads()).toContain(sale);
    // the words changed so no rule wants it: hidden, not gone; back with the words
    t.model.compile = () => compiled([{ said: "Bills first", effect: "first", kinds: ["pay"] }]);
    await t.words("Bills first");
    expect(await t.threads()).not.toContain(sale);
    t.model.compile = () => compiled([{ said: "Tell me about sales at REI", effect: "show", about: "a sale or offer from REI, with when it ends", cues: ["REI"] }]);
    await t.words("Tell me about sales at REI");
    expect(await t.threads()).toContain(sale);
  });

  it("never a scam's sale, a quote not the mail's, nor mail in Spam (it reaches no AI)", async () => {
    const t = await setup();
    t.model.compile = () => compiled([{ said: "Show sales at REI", effect: "show", about: "a sale from REI", cues: ["REI"] }]);
    await t.words("Show sales at REI");
    t.model.wanted = (r) =>
      promptText(r.messages[0]!.content).includes("gift card")
        ? json({ items: [{ rule: "r1", kind: "pay", text: "Buy REI gift cards", quote: "Buy three REI gift cards and send me the codes", due: "2026-11-15", time: null }] })
        : json({ items: [{ rule: "r1", kind: "expire", text: "REI sale", quote: "words nobody wrote", due: "2026-11-15", time: null }] });
    const scam = await t.receive({ from: rei, subject: "REI urgent", bodyText: "Buy three REI gift cards and send me the codes today. gift card" });
    const invented = await t.receive({ from: rei, ...SALE });
    await t.settled();
    expect(await t.threads()).not.toContain(scam);
    expect(await t.threads()).not.toContain(invented);
    const asked = t.of("wanted_mail").length;
    await t.receive({ from: rei, ...SALE, isSpam: true, inInbox: false });
    await t.settled();
    expect(t.of("wanted_mail")).toHaveLength(asked);
  });

  it("the look back offers the last 14 days' candidates (Promotions included) and reads them only with a yes", async () => {
    const t = await setup();
    t.model.dated = () => dated();
    await t.receive({ from: rei, ...SALE });
    await t.receive({ from: power, ...BILL });
    await t.settled();
    t.model.compile = () => compiled([{ said: "Show sales at REI", effect: "show", about: "a sale from REI", cues: ["REI"] }]);
    await t.words("Show sales at REI");
    expect(t.of("wanted_mail")).toHaveLength(0);
    const { offer } = await t.client.call("whatMatters.words.lookOffer", {});
    expect(offer?.count).toBe(1);
    expect(t.of("wanted_mail")).toHaveLength(0);
    expect((await t.client.call("whatMatters.words.look", {})).queued).toBe(1);
    await t.settled();
    expect(t.of("wanted_mail")).toHaveLength(1);
  });
});

describe("the second reader's local checks", () => {
  const rule = { id: "r1", key: "s1", said: "x", effect: "show" as const, about: "a sale", understood: "x" };
  const rules = new Map([["r1", rule]]);
  const base = { text: "Our members sale ends November 15. Up to 40% off.", subject: "REI sale", arrivedAt: NOW, rules, already: [] };
  it("keeps the mail's own words and a day ahead; drops an invented quote, a past day, an unknown rule and what's already there", () => {
    const item = { rule: "r1", kind: "expire" as const, text: "REI sale ends", quote: "Our members sale ends November 15.", due: "2026-11-15", time: null };
    expect(checkWanted({ items: [item] }, base)).toMatchObject([{ kind: "expire", dueDay: "2026-11-15", rules: ["s1"] }]);
    expect(checkWanted({ items: [{ ...item, quote: "nobody wrote this" }] }, base)).toEqual([]);
    expect(checkWanted({ items: [{ ...item, due: "2026-11-01" }] }, base)).toEqual([]);
    expect(checkWanted({ items: [{ ...item, rule: "r9" }] }, base)).toEqual([]);
    expect(checkWanted({ items: [item] }, { ...base, already: [{ kind: "expire", text: "REI sale ends" }] })).toEqual([]);
    // no day: news the user asked for, an alert for its week
    expect(checkWanted({ items: [{ ...item, kind: "event", due: null }] }, base)).toMatchObject([{ kind: "alert", dated: false }]);
  });
  it("an excerpt is the mail around the quote", () => {
    expect(excerptAround("a b c. The parcel arrives Friday. d e f", "The parcel arrives Friday.", 30)).toContain("The parcel arrives Friday.");
    expect(excerptAround("short", "", 30)).toBe("short");
  });
});

describe("the Codex code review of plan 248", () => {
  it("the second reader comes back by itself once v16 has read the same message (never only on an outside wake)", async () => {
    const t = await setup();
    t.model.compile = () => compiled([{ said: "Show sales at REI", effect: "show", about: "a sale from REI", cues: ["REI"] }]);
    await t.words("Show sales at REI");
    t.model.wanted = () => json({ items: [{ rule: "r1", kind: "expire", text: "REI sale ends", quote: "Our members sale ends November 15.", due: "2026-11-15", time: null }] });
    // a person's mail with the cue, so v16 reads it too (the second reader waits for it)
    const sale = await t.receive({ from: { name: "Jo", email: "jo@people.test" }, subject: "REI sale", bodyText: "Our members sale ends November 15. Want to go?" });
    t.backend.dated.wake();
    await expect.poll(() => t.backend.store.whatMatters.wanted.marks.count()).toBe(0);
    await expect.poll(async () => (await t.threads()).includes(sale)).toBe(true);
  });

  it("a semantic only fails open: a row the matcher can't judge stays", async () => {
    const t = await setup();
    t.model.dated = () => dated([billItem]);
    const bill = await t.receive();
    await t.settled();
    t.model.compile = () => compiled([{ said: "Only school stuff", effect: "only", about: "mail about the reader's school" }]);
    t.model.match = () => ({ text: "", stop: "refusal" });
    await t.words("Only school stuff");
    await t.settled();
    expect(await t.threads()).toContain(bill);
  });

  it("one item two shows want keeps both reasons: dropping either rule keeps it", async () => {
    const t = await setup();
    const both = [
      { said: "Show sales at REI", effect: "show", about: "a sale from REI", cues: ["REI"] },
      { said: "Show tent deals", effect: "show", about: "a deal on tents", cues: ["tents"] },
    ];
    t.model.compile = () => compiled(both);
    await t.words("Show sales at REI. Show tent deals.");
    t.model.wanted = () => json({ items: [{ rule: "r1", kind: "expire", text: "REI sale ends", quote: "Our members sale ends November 15.", due: "2026-11-15", time: null }, { rule: "r2", kind: "expire", text: "Tent deal ends", quote: "Our members sale ends November 15.", due: "2026-11-15", time: null }] });
    const sale = await t.receive({ from: rei, ...SALE });
    await t.settled();
    expect((await t.backend.store.whatMatters.wanted.active())[0]!.rules).toHaveLength(2);
    t.model.compile = () => compiled([both[1]!]);
    await t.words("Show tent deals.");
    expect(await t.threads()).toContain(sale);
  });

  it("a quoted offer in a mail that also asks for gift-card codes brings nothing", async () => {
    const t = await setup();
    t.model.compile = () => compiled([{ said: "Show sales at REI", effect: "show", about: "a sale from REI", cues: ["REI"] }]);
    await t.words("Show sales at REI");
    t.model.wanted = () => json({ items: [{ rule: "r1", kind: "expire", text: "REI sale ends", quote: "Our members sale ends November 15.", due: "2026-11-15", time: null }] });
    const scam = await t.receive({ from: rei, subject: "REI sale", bodyText: "Our members sale ends November 15. Buy two gift cards and send me the codes so I can apply your discount." });
    await t.settled();
    expect(await t.threads()).not.toContain(scam);
  });

  it("a row the words brought opens with its conversation's line (its negative id is a valid include)", async () => {
    const t = await setup();
    t.model.compile = () => compiled([{ said: "Show sales at REI", effect: "show", about: "a sale from REI", cues: ["REI"] }]);
    await t.words("Show sales at REI");
    t.model.wanted = () => json({ items: [{ rule: "r1", kind: "expire", text: "REI sale ends", quote: "Our members sale ends November 15.", due: "2026-11-15", time: null }] });
    const sale = await t.receive({ from: rei, ...SALE });
    await t.settled();
    const [w] = await t.backend.store.whatMatters.wanted.active();
    const { rows } = await t.client.call("dated.ofThread", { threadId: sale, include: -w!.id });
    expect(rows.map((r) => r.id)).toEqual([-w!.id]);
  });

  it("the look back's yes is for the words it was said to: its marks under other words are dropped, never read", async () => {
    const t = await setup();
    t.model.dated = () => dated();
    const sale = await t.receive({ from: rei, ...SALE });
    await t.settled();
    t.model.compile = () => compiled([{ said: "Show sales at REI", effect: "show", about: "a sale from REI", cues: ["REI"] }]);
    await t.words("Show sales at REI");
    const { preferences } = await t.client.call("whatMatters.words", {});
    // a yes given for the words before these (a Save came between the yes and the reading)
    await t.backend.store.settings.set("whatMatters:lookRevision", preferences.revision - 1);
    const m = (await t.backend.store.whatMatters.wanted.lookCandidates(0, 10)).find((c) => c.threadId === sale)!;
    expect(await t.backend.store.whatMatters.wanted.marks.add({ messageId: m.id, threadId: sale, arrivedAt: m.date, source: "look" }, t.clock.now)).toBe(true);
    await t.settled();
    expect(t.of("wanted_mail")).toHaveLength(0);
    expect(await t.backend.store.whatMatters.wanted.marks.count("look")).toBe(0);
  });
});

describe("the second question (the held-out eval)", () => {
  it("a hide the confirmation doesn't stand by isn't applied: the row stays", async () => {
    const t = await setup();
    t.model.dated = () => dated([{ kind: "renew", text: "Cancel Tasklet Pro before Nov 15 or pay $9.99/month", quote: "Your Tasklet Pro trial ends on November 15.", due: "2026-11-15", time: null }]);
    const trial = await t.receive({ from: { name: "Tasklet", email: "billing@tasklet.test" }, subject: "Your trial ends Sunday", bodyText: "Your Tasklet Pro trial ends on November 15. After that we'll charge $9.99/month unless you cancel." });
    await t.settled();
    t.model.compile = () => compiled([{ said: "Hide promos", effect: "hide", about: "promotional or marketing email" }]);
    // the first reading calls the trial marketing; the strict second question doesn't
    t.model.match = (r) => (promptText(r.system).includes("A first reading matched") ? json({ matches: [] }) : json({ matches: [{ target: "t1", rule: "r1", evidence: "Your trial ends Sunday" }] }));
    await t.words("Hide promos");
    await t.settled();
    expect(await t.threads()).toContain(trial);
  });

  it("a row no only kept is asked again, leniently, and kept when it could be one", async () => {
    const t = await setup();
    t.model.dated = () => dated([{ kind: "event", text: "Field day", quote: "Field day is on November 13.", due: "2026-11-13", time: null }]);
    const fieldDay = await t.receive({ from: school, subject: "Field day", bodyText: "Field day is on November 13." });
    await t.settled();
    t.model.compile = () => compiled([{ said: "Only school stuff", effect: "only", about: "mail about the reader's child's school" }]);
    t.model.match = (r) => (promptText(r.system).includes("none of these keep rules applies") ? json({ matches: [{ target: "t1", rule: "r1", evidence: "Field day" }] }) : json({ matches: [] }));
    await t.words("Only school stuff");
    await t.settled();
    expect(await t.threads()).toContain(fieldDay);
  });
});

