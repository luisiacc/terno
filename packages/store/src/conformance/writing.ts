import { canonicalAuthored } from "@terno/core";
import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { GENERATION_TEXT_MAX_STORE, GENERATIONS_MAX_BYTES, GENERATIONS_MAX_ROWS, PROFILE_MAX_BYTES, PROFILES_MAX_BYTES, PROFILES_MAX_ROWS, SENT_TO_CANDIDATES, type ProfileUpsert } from "../writing";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 4, 12);
const ME = { name: "Me", email: "me0@example.com" };
const TOM = { name: "Tom Reed", email: "tom@acme.com" };

/**
 * Plan 133: sent mail read by date and by exact recipient, a bounded read of a thread, the profiles and the provenance
 * of what the model wrote. The same behavior in both stores, including the ways FTS and memory indexes would differ.
 */
export function defineWritingConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("drafting (plan 133)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId, other] = await withAccounts(store, 2);
      /** a sent message */
      const send = async (over: Partial<IncomingMessage> = {}) => {
        const m = msg({ accountId: accountId!, from: ME, to: [TOM], isSent: true, isRead: true, inInbox: false, bodyText: "Sounds good to me.", date: NOW, ...over });
        const { inserted } = await ingest(store, [m], NOW);
        return inserted[0]!;
      };
      return { store, accountId: accountId!, other: other!, send };
    }

    const refsOf = async (store: MailStore, addresses: string[], o: { accountId?: number; limit?: number } = {}) => {
      const r = await store.writing.sentTo({ addresses, limit: o.limit ?? 10, ...(o.accountId !== undefined ? { accountId: o.accountId } : {}) });
      return { ids: r.refs.map((x) => x.id), state: r.state };
    };

    describe("sentTo", () => {
      it("is the exact address: never a look-alike the FTS phrase also matches", async () => {
        const { store, send } = await setup();
        const look = await send({ to: [{ name: "X", email: "x.tom@acme.com" }] });
        const also = await send({ to: [{ name: "T", email: "tom@acme.com.evil.test" }] });
        const real = await send();
        expect(await refsOf(store, ["tom@acme.com"])).toEqual({ ids: [real], state: "found" });
        expect((await refsOf(store, ["x.tom@acme.com"])).ids).toEqual([look]);
        expect((await refsOf(store, ["tom@acme.com.evil.test"])).ids).toEqual([also]);
      });

      it("holds any case and aliases, in To or Cc, and an account filter", async () => {
        const { store, accountId, other, send } = await setup();
        const upper = await send({ to: [{ name: "T", email: "TOM@ACME.COM" }] });
        const cc = await send({ to: [{ name: "A", email: "ana@acme.com" }], cc: [TOM] });
        const alias = await send({ to: [{ name: "T", email: "tomas@acme.com" }] });
        const elsewhere = await send({ accountId: other, from: { name: "Me", email: "me1@example.com" } });
        expect(new Set((await refsOf(store, ["Tom@Acme.com"], { accountId })).ids)).toEqual(new Set([upper, cc]));
        expect(new Set((await refsOf(store, ["tom@acme.com", "tomas@acme.com"], { accountId })).ids)).toEqual(new Set([upper, cc, alias]));
        expect((await refsOf(store, ["tom@acme.com"], { accountId: other })).ids).toEqual([elsewhere]);
        expect(new Set((await refsOf(store, ["tom@acme.com"])).ids)).toEqual(new Set([upper, cc, elsewhere]));
      });

      it("leaves out drafts, spam and trash, and inbound mail to that address", async () => {
        const { store, send, accountId } = await setup();
        await send({ isDraft: true });
        await send({ isSpam: true });
        await send({ isTrash: true });
        await ingest(store, [msg({ accountId, from: { name: "Ana", email: "ana@x.test" }, to: [TOM], bodyText: "inbound" })], NOW);
        expect(await refsOf(store, ["tom@acme.com"])).toEqual({ ids: [], state: "none" });
      });

      it("tells history without usable text from no history, and ranks by date whatever the insert order", async () => {
        const { store, send } = await setup();
        await send({ bodyText: null, bodyState: "none" });
        expect(await refsOf(store, ["tom@acme.com"])).toEqual({ ids: [], state: "unavailable" });
        const newest = await send({ date: NOW });
        // a backfilled message: inserted last, oldest
        const old = await send({ date: NOW - 86_400_000 });
        const middle = await send({ date: NOW - 3600_000 });
        expect((await refsOf(store, ["tom@acme.com"])).ids).toEqual([newest, middle, old]);
        expect((await refsOf(store, ["tom@acme.com"], { limit: 1 })).ids).toEqual([newest]);
      });

      it("finds the real one behind a large number of look-alikes", async () => {
        const { store, send, accountId } = await setup();
        const real = await send({ date: NOW - 86_400_000 * 30 });
        const look = [{ name: "X", email: "x.tom@acme.com" }];
        const batch = Array.from({ length: 800 }, (_, i) => msg({ accountId, from: ME, to: look, isSent: true, inInbox: false, bodyText: "x", date: NOW - i }));
        await ingest(store, batch, NOW);
        expect((await refsOf(store, ["tom@acme.com"])).ids).toEqual([real]);
      });

      it("says unavailable, not none, when past the look-alikes it can't tell but has written to them", async () => {
        const { store, send, accountId } = await setup();
        await send();
        const look = [{ name: "X", email: "x.tom@acme.com" }];
        for (let n = 0; n < Math.ceil((SENT_TO_CANDIDATES + 500) / 1000); n++) {
          await ingest(store, Array.from({ length: 1000 }, (_, i) => msg({ accountId, from: ME, to: look, isSent: true, inInbox: false, bodyText: "x", date: NOW + n * 1000 + i })), NOW);
        }
        const r = await store.writing.sentTo({ addresses: ["tom@acme.com"], limit: 5 });
        expect(r.refs.length === 1 || r.state === "unavailable").toBe(true);
      }, 60_000);

      it("follows a thread merge: the refs and threadsWith name the thread that survived", async () => {
        const { store, accountId, send } = await setup();
        const first = msg({ accountId, from: TOM, to: [ME], rfcMessageId: "a@merge.test", providerMsgId: "ma", bodyText: "a", date: NOW - 3000, inInbox: true });
        const third = msg({ accountId, from: ME, to: [TOM], rfcMessageId: "c@merge.test", providerMsgId: "mc", references: ["b@merge.test"], inReplyTo: "b@merge.test", bodyText: "c", date: NOW - 1000, isSent: true, inInbox: false });
        await ingest(store, [first, third], NOW);
        await send({ date: NOW - 100_000 });
        const before = [await threadOf(store, "ma"), await threadOf(store, "mc")];
        expect(before[0]).not.toBe(before[1]);
        // the message between them arrives: they're one conversation now
        await ingest(store, [msg({ accountId, from: TOM, to: [ME], rfcMessageId: "b@merge.test", providerMsgId: "mb", references: ["a@merge.test"], inReplyTo: "a@merge.test", bodyText: "b", date: NOW - 2000, inInbox: true })], NOW);
        const survivor = await threadOf(store, "mc");
        expect(await threadOf(store, "ma")).toBe(survivor);
        const r = await store.writing.sentTo({ addresses: ["tom@acme.com"], accountId, limit: 1 });
        expect(r.refs[0]!.threadId).toBe(survivor);
        const threads = await store.writing.threadsWith({ address: "tom@acme.com", accountId, limit: 5 });
        expect(threads[0]).toBe(survivor);
        expect(threads).not.toContain(before.find((t) => t !== survivor));
        const ctx = await store.writing.threadContext(survivor, { maxBodies: 5, maxChars: 1000 });
        expect(ctx!.messages.map((m) => m.text)).toEqual(["a", "b", "c"]);
      });
    });

    describe("threadsWith", () => {
      it("is both directions, newest first, without spam, trash, the excluded thread or other accounts", async () => {
        const { store, accountId, other, send } = await setup();
        const a = await send({ date: NOW - 5000, providerMsgId: "s1" });
        void a;
        await ingest(store, [msg({ accountId, from: TOM, to: [ME], providerMsgId: "r1", date: NOW - 1000, bodyText: "x" })], NOW);
        await ingest(store, [msg({ accountId, from: TOM, to: [ME], providerMsgId: "sp", date: NOW, isSpam: true, bodyText: "x" })], NOW);
        await ingest(store, [msg({ accountId: other, from: TOM, to: [ME], providerMsgId: "o1", date: NOW, bodyText: "x" })], NOW);
        const sent = await threadOf(store, "s1");
        const recv = await threadOf(store, "r1");
        expect(await store.writing.threadsWith({ address: "TOM@acme.com", accountId, limit: 5 })).toEqual([recv, sent]);
        expect(await store.writing.threadsWith({ address: "tom@acme.com", accountId, exclude: recv, limit: 5 })).toEqual([sent]);
        expect(await store.writing.threadsWith({ address: "tom@acme.com", accountId, limit: 1 })).toEqual([recv]);
      });
    });

    describe("the corpus", () => {
      it("is newest first by date under backfill, a page at a time, with what choosing needs", async () => {
        const { store, accountId, other, send } = await setup();
        const newest = await send({ date: NOW, inReplyTo: "x@test", to: [TOM], cc: [{ name: "A", email: "Ana@x.test" }] });
        const backfilled = await send({ date: NOW - 86_400_000 });
        const between = await send({ date: NOW - 3600_000 });
        await send({ accountId: other, from: { name: "Me", email: "me1@example.com" } });
        const first = await store.writing.corpus.headers({ accountId, limit: 2 });
        expect(first.map((h) => h.id)).toEqual([newest, between]);
        expect(first[0]).toMatchObject({ to: ["tom@acme.com"], cc: ["ana@x.test"], isReply: true, bulk: false, date: NOW, accountId, names: { "tom@acme.com": "Tom Reed", "ana@x.test": "A" } });
        const last = first[1]!;
        expect((await store.writing.corpus.headers({ accountId, before: { date: last.date, id: last.id }, limit: 2 })).map((h) => h.id)).toEqual([backfilled]);
      });

      it("takes equal dates by id, across a page boundary", async () => {
        const { store, accountId, send } = await setup();
        const ids = [await send({ date: NOW }), await send({ date: NOW }), await send({ date: NOW })];
        const [a, b] = await store.writing.corpus.headers({ accountId, limit: 2 });
        expect([a!.id, b!.id]).toEqual([ids[2], ids[1]]);
        expect((await store.writing.corpus.headers({ accountId, before: { date: b!.date, id: b!.id }, limit: 2 })).map((h) => h.id)).toEqual([ids[0]]);
      });

      it("leaves out drafts, spam, trash, what has no body and what's too large; marks mass mail as bulk", async () => {
        const { store, accountId, send } = await setup();
        await send({ isDraft: true });
        await send({ isSpam: true });
        await send({ isTrash: true });
        await send({ bodyText: null, bodyState: "none" });
        await send({ size: 600 * 1024 });
        const list = await send({ listId: "list.example" });
        const many = await send({ to: Array.from({ length: 25 }, (_, i) => ({ name: "", email: `p${i}@x.test` })) });
        const fine = await send();
        const headers = await store.writing.corpus.headers({ accountId, limit: 10 });
        expect(new Set(headers.map((h) => h.id))).toEqual(new Set([list, many, fine]));
        expect(headers.find((h) => h.id === list)!.bulk).toBe(true);
        expect(headers.find((h) => h.id === many)!.bulk).toBe(true);
        expect(headers.find((h) => h.id === fine)!.bulk).toBe(false);
        expect((await store.writing.corpus.usable([list, fine, 999_999])).sort((x, y) => x - y)).toEqual([list, fine].sort((x, y) => x - y));
      });

      it("a body arriving late brings a message in", async () => {
        const { store, accountId, send } = await setup();
        const m = msg({ accountId, from: ME, to: [TOM], isSent: true, inInbox: false, bodyText: null, bodyState: "none", date: NOW, providerMsgId: "late" });
        await ingest(store, [m], NOW);
        expect(await store.writing.corpus.headers({ accountId, limit: 5 })).toEqual([]);
        await ingest(store, [{ ...m, bodyText: "Here it is.", bodyState: "full" }], NOW);
        const [header] = await store.writing.corpus.headers({ accountId, limit: 5 });
        expect(await store.writing.corpus.texts([header!.id])).toEqual([{ id: header!.id, text: "Here it is." }]);
        await send();
      });

      it("texts come for chosen ids, bounded", async () => {
        const { store, send } = await setup();
        const long = "word ".repeat(30_000);
        const id = await send({ bodyText: long });
        const [text] = await store.writing.corpus.texts([id]);
        expect(text!.text.length).toBeLessThanOrEqual(65_536);
        expect(await store.writing.corpus.texts([])).toEqual([]);
      });
    });

    describe("threadContext", () => {
      async function thread() {
        const { store, accountId, send } = await setup();
        await ingest(store, [msg({ accountId, from: TOM, to: [ME], cc: [{ name: "Ana", email: "ana@x.test" }], providerMsgId: "t1", rfcMessageId: "t1@test", bodyText: "First from Tom", date: NOW - 4000, inInbox: true })], NOW);
        await send({ providerMsgId: "t2", rfcMessageId: "t2@test", inReplyTo: "t1@test", references: ["t1@test"], bodyText: "My answer", date: NOW - 3000 });
        await ingest(store, [msg({ accountId, from: TOM, to: [ME], providerMsgId: "t3", rfcMessageId: "t3@test", inReplyTo: "t2@test", references: ["t1@test", "t2@test"], bodyText: "Second from Tom, a longer one", date: NOW - 2000, inInbox: true })], NOW);
        return { store, accountId, threadId: await threadOf(store, "t3") };
      }

      it("reads headers first, then only the bodies its budget chooses, answering message first", async () => {
        const { store, threadId } = await thread();
        const ctx = (await store.writing.threadContext(threadId, { maxBodies: 2, maxChars: 1000 }))!;
        expect(ctx.messages.map((m) => m.fromEmail)).toEqual(["tom@acme.com", "me0@example.com", "tom@acme.com"]);
        expect(ctx.newestInbound).toBe(ctx.messages[2]!.id);
        expect(ctx.messages[2]!.text).toBe("Second from Tom, a longer one");
        expect(ctx.messages[1]!.text).toBe("My answer");
        expect(ctx.messages[0]!.text).toBeNull();
        expect(ctx.messages[0]!.cc).toEqual([{ name: "Ana", email: "ana@x.test" }]);
        expect(ctx.messages[1]!.own).toBe(true);
      });

      it("keeps to its characters, in total", async () => {
        const { store, threadId } = await thread();
        const ctx = (await store.writing.threadContext(threadId, { maxBodies: 3, maxChars: 20 }))!;
        const total = ctx.messages.reduce((n, m) => n + (m.text?.length ?? 0), 0);
        expect(total).toBeLessThanOrEqual(20);
        expect(ctx.messages[2]!.text).toBe("Second fro");
      });

      it("says when the message it would answer has no text here", async () => {
        const { store, accountId } = await setup();
        await ingest(store, [msg({ accountId, from: TOM, to: [ME], providerMsgId: "n1", bodyText: null, bodyState: "none", snippet: "the snippet", date: NOW, inInbox: true })], NOW);
        const ctx = (await store.writing.threadContext(await threadOf(store, "n1"), { maxBodies: 2, maxChars: 100 }))!;
        expect(ctx.messages[0]).toMatchObject({ bodyState: "none", text: null, snippet: "the snippet" });
        expect(await store.writing.threadContext(999_999, { maxBodies: 2, maxChars: 100 })).toBeNull();
      });

      it("changes its stamp when a body does; leaves out trashed messages of a live thread", async () => {
        const { store, accountId, threadId } = await thread();
        const before = (await store.writing.threadContext(threadId, { maxBodies: 1, maxChars: 100 }))!;
        await ingest(store, [msg({ accountId, from: TOM, to: [ME], providerMsgId: "t4", rfcMessageId: "t4@test", inReplyTo: "t3@test", references: ["t1@test", "t2@test", "t3@test"], bodyText: "Third", date: NOW - 1000, isTrash: true })], NOW);
        const after = (await store.writing.threadContext(threadId, { maxBodies: 1, maxChars: 100 }))!;
        expect(after.messages.length).toBe(before.messages.length);
        await ingest(store, [msg({ accountId, from: TOM, to: [ME], providerMsgId: "t5", rfcMessageId: "t5@test", inReplyTo: "t3@test", references: ["t1@test", "t2@test", "t3@test"], bodyText: "Fourth", date: NOW - 500, inInbox: true })], NOW);
        const third = (await store.writing.threadContext(threadId, { maxBodies: 1, maxChars: 100 }))!;
        expect(third.stamp).not.toBe(before.stamp);
        expect(third.messages[third.messages.length - 1]!.text).toBe("Fourth");
      });
    });

    describe("profiles", () => {
      const upsert = (over: Partial<ProfileUpsert> = {}): ProfileUpsert => ({ scope: "person", scopeKey: "person:1:tom@acme.com", language: "", accountId: 1, habitsJson: "{}", phrasesJson: "[]", samples: 5, ...over });
      const STATE = "writing:test";

      it("has one identity per scope key and language, written with its checkpoint in one commit, and survives a reopen", async () => {
        const { store, accountId } = await setup();
        const a = upsert({ accountId, scopeKey: `person:${accountId}:tom@acme.com` });
        await store.writing.profiles.commit({ upserts: [a, { ...a, language: "es", samples: 8, habitsJson: '{"es":1}' }, { scope: "you", scopeKey: "you", language: "", accountId: null, habitsJson: "{}", phrasesJson: "[]", samples: 50 }], state: { [STATE]: { at: 1 } }, now: NOW });
        await store.writing.profiles.commit({ upserts: [{ ...a, samples: 9, habitsJson: '{"v":2}' }], incorporated: [{ scopeKey: a.scopeKey, language: "", count: 4 }], state: { [STATE]: { at: 2 } }, now: NOW + 1 });
        const again = await reopen(store);
        const rows = await again.writing.profiles.read([{ scopeKey: a.scopeKey, language: "" }, { scopeKey: a.scopeKey, language: "es" }, { scopeKey: "you", language: "" }, { scopeKey: "none", language: "" }]);
        expect(rows.map((r) => [r.scopeKey, r.language, r.samples, r.habitsJson])).toEqual([[a.scopeKey, "", 9, '{"v":2}'], [a.scopeKey, "es", 8, '{"es":1}'], ["you", "", 50, "{}"]]);
        expect(rows[0]).toMatchObject({ newSince: 4, edited: false, accountId, updatedAt: NOW + 1, judgmentJson: null });
        expect(rows[2]!.accountId).toBeNull();
        expect(await again.settings.get(STATE, null)).toEqual({ at: 2 });
      });

      it("what's new counts what was incorporated, even when the samples don't grow because the window is full", async () => {
        const { store, accountId } = await setup();
        const a = upsert({ accountId, scopeKey: `person:${accountId}:tom@acme.com`, samples: 3000 });
        await store.writing.profiles.commit({ upserts: [a], state: {}, now: NOW });
        for (const at of [1, 2]) await store.writing.profiles.commit({ upserts: [a], incorporated: [{ scopeKey: a.scopeKey, language: "", count: 25 }], state: {}, now: NOW + at });
        expect((await store.writing.profiles.read([{ scopeKey: a.scopeKey, language: "" }]))[0]).toMatchObject({ samples: 3000, newSince: 50 });
        // shrinking samples take nothing back, and a row gone isn't an error
        await store.writing.profiles.commit({ upserts: [{ ...a, samples: 10 }], incorporated: [{ scopeKey: "person:none", language: "", count: 5 }], state: {}, now: NOW + 3 });
        expect((await store.writing.profiles.read([{ scopeKey: a.scopeKey, language: "" }]))[0]).toMatchObject({ samples: 10, newSince: 50 });
      });

      it("a pass in several commits: the last one's replacement leaves what the earlier ones wrote", async () => {
        const { store, accountId } = await setup();
        const key = (n: string) => `person:${accountId}:${n}@x.test`;
        await store.writing.profiles.commit({ upserts: ["a", "b", "c"].map((n) => upsert({ accountId, scopeKey: key(n) })), state: {}, now: NOW });
        await store.writing.profiles.commit({ upserts: [upsert({ accountId, scopeKey: key("a"), samples: 7 })], state: {}, now: NOW + 1 });
        await store.writing.profiles.commit({ upserts: [], keep: [{ scopeKey: key("a"), language: "" }, { scopeKey: key("b"), language: "" }], replaceAccount: accountId, state: {}, now: NOW + 2 });
        expect((await store.writing.profiles.list({ accountId, limit: 10 })).map((r) => [r.scopeKey, r.samples])).toEqual([[key("a"), 7], [key("b"), 5]]);
      });

      it("a commit that fails leaves nothing behind, the checkpoint included", async () => {
        const { store, accountId } = await setup();
        await store.writing.profiles.commit({ upserts: [], state: { [STATE]: { at: 1 } }, now: NOW });
        await expect(store.writing.profiles.commit({ upserts: [upsert({ accountId: 999_999, scopeKey: "person:999999:x@y.test" })], state: { [STATE]: { at: 2 } }, now: NOW })).rejects.toThrow();
        expect(await store.settings.get(STATE, null)).toEqual({ at: 1 });
        expect(await store.writing.profiles.list({ limit: 10 })).toEqual([]);
        void accountId;
      });

      it("replaces an account's rows the upserts don't name, keeps what's edited; lists in key order and pages", async () => {
        const { store, accountId, other } = await setup();
        const key = (n: string) => `person:${accountId}:${n}@x.test`;
        await store.writing.profiles.commit({ upserts: ["a", "b", "c"].map((n) => upsert({ accountId, scopeKey: key(n) })), state: {}, now: NOW });
        await store.writing.profiles.commit({ upserts: [upsert({ accountId: other, scopeKey: `person:${other}:z@x.test` })], state: {}, now: NOW });
        expect(await store.writing.profiles.edit({ scopeKey: key("b"), language: "", phrasesJson: '["mine"]', now: NOW + 1 })).toBe(true);
        await store.writing.profiles.commit({ upserts: [upsert({ accountId, scopeKey: key("c"), samples: 7, phrasesJson: '["new"]' })], replaceAccount: accountId, state: {}, now: NOW + 2 });
        const rows = await store.writing.profiles.list({ accountId, limit: 10 });
        expect(rows.map((r) => r.scopeKey)).toEqual([key("b"), key("c")]);
        expect(rows.map((r) => r.phrasesJson)).toEqual(['["mine"]', '["new"]']);
        expect((await store.writing.profiles.list({ limit: 10 })).map((r) => r.scopeKey)).toEqual([key("b"), key("c"), `person:${other}:z@x.test`]);
        expect((await store.writing.profiles.list({ after: { scopeKey: key("b"), language: "" }, limit: 1 })).map((r) => r.scopeKey)).toEqual([key("c")]);
        expect((await store.writing.profiles.list({ scope: "you", limit: 10 }))).toEqual([]);
      });

      it("an edit pins: a pass keeps its content and counts what's new; a judgment leaves it alone; reset removes it", async () => {
        const { store, accountId } = await setup();
        const a = upsert({ accountId, scopeKey: `person:${accountId}:tom@acme.com` });
        await store.writing.profiles.commit({ upserts: [a], state: {}, now: NOW });
        await store.writing.profiles.edit({ scopeKey: a.scopeKey, language: "", habitsJson: '{"mine":1}', judgmentJson: '{"notes":["mine"]}', now: NOW + 1 });
        await store.writing.profiles.commit({ upserts: [{ ...a, samples: 8, habitsJson: '{"counted":1}', phrasesJson: '["counted"]' }], incorporated: [{ scopeKey: a.scopeKey, language: "", count: 3 }], state: {}, now: NOW + 2 });
        const [row] = await store.writing.profiles.read([{ scopeKey: a.scopeKey, language: "" }]);
        expect(row).toMatchObject({ habitsJson: '{"mine":1}', phrasesJson: "[]", judgmentJson: '{"notes":["mine"]}', edited: true, samples: 8, newSince: 3, updatedAt: NOW + 1 });
        expect(await store.writing.profiles.judge({ scopeKey: a.scopeKey, language: "", judgmentJson: '{"notes":["model"]}', sampleHash: "h", model: "m", provider: "p", promptVersion: 1, now: NOW + 3 })).toBe(false);
        await store.writing.profiles.reset(a.scopeKey, "");
        expect(await store.writing.profiles.read([{ scopeKey: a.scopeKey, language: "" }])).toEqual([]);
        expect(await store.writing.profiles.edit({ scopeKey: a.scopeKey, language: "", phrasesJson: "[]", now: NOW })).toBe(false);
      });

      it("a judgment is kept through a pass, resets what's new since, and clearing removes it but not the counts", async () => {
        const { store, accountId, other } = await setup();
        const a = upsert({ accountId, scopeKey: `person:${accountId}:tom@acme.com` });
        const b = upsert({ accountId: other, scopeKey: `person:${other}:tom@acme.com` });
        await store.writing.profiles.commit({ upserts: [a, b], state: {}, now: NOW });
        await store.writing.profiles.commit({ upserts: [{ ...a, samples: 9 }], state: {}, now: NOW });
        for (const key of [a.scopeKey, b.scopeKey]) expect(await store.writing.profiles.judge({ scopeKey: key, language: "", judgmentJson: '{"notes":[]}', sampleHash: "h", model: "m", provider: "p", promptVersion: 1, now: NOW + 1 })).toBe(true);
        await store.writing.profiles.commit({ upserts: [{ ...a, samples: 10, habitsJson: '{"v":2}' }], incorporated: [{ scopeKey: a.scopeKey, language: "", count: 1 }], state: {}, now: NOW + 2 });
        const [row] = await store.writing.profiles.read([{ scopeKey: a.scopeKey, language: "" }]);
        expect(row).toMatchObject({ judgmentJson: '{"notes":[]}', sampleHash: "h", model: "m", provider: "p", promptVersion: 1, newSince: 1, habitsJson: '{"v":2}' });
        await store.writing.profiles.clearJudgments(accountId);
        expect((await store.writing.profiles.read([{ scopeKey: a.scopeKey, language: "" }]))[0]).toMatchObject({ judgmentJson: null, sampleHash: null, model: null, habitsJson: '{"v":2}' });
        expect((await store.writing.profiles.read([{ scopeKey: b.scopeKey, language: "" }]))[0]!.judgmentJson).not.toBeNull();
        await store.writing.profiles.clearJudgments();
        expect((await store.writing.profiles.read([{ scopeKey: b.scopeKey, language: "" }]))[0]!.judgmentJson).toBeNull();
      });

      it("stays within its rows: the oldest unedited people and domains go first, general levels never", async () => {
        const { store, accountId } = await setup();
        const you = { scope: "you" as const, scopeKey: "you", language: "", accountId: null, habitsJson: "{}", phrasesJson: "[]", samples: 50 };
        const edited = upsert({ accountId, scopeKey: `person:${accountId}:pinned@x.test` });
        await store.writing.profiles.commit({ upserts: [you, edited], state: {}, now: NOW - 100_000 });
        await store.writing.profiles.edit({ scopeKey: edited.scopeKey, language: "", phrasesJson: '["mine"]', now: NOW - 100_000 });
        const rows = Array.from({ length: PROFILES_MAX_ROWS }, (_, i) => upsert({ accountId, scopeKey: `person:${accountId}:p${i}@x.test` }));
        // the first few are older
        await store.writing.profiles.commit({ upserts: rows.slice(0, 5), state: {}, now: NOW - 1000 });
        await store.writing.profiles.commit({ upserts: rows.slice(5), state: {}, now: NOW });
        const left = await store.writing.profiles.list({ limit: PROFILES_MAX_ROWS + 10 });
        expect(left.length).toBe(PROFILES_MAX_ROWS);
        const keys = new Set(left.map((r) => r.scopeKey));
        expect(keys.has("you")).toBe(true);
        expect(keys.has(edited.scopeKey)).toBe(true);
        expect(keys.has(rows[0]!.scopeKey)).toBe(false);
        expect(keys.has(rows[1]!.scopeKey)).toBe(false);
        expect(keys.has(rows[2]!.scopeKey)).toBe(true);
      }, 60_000);

      it("stays within its bytes, and a row too big for a profile isn't stored", async () => {
        const { store, accountId } = await setup();
        const big = "x".repeat(PROFILE_MAX_BYTES - 10);
        const rows = Array.from({ length: Math.ceil(PROFILES_MAX_BYTES / big.length) + 2 }, (_, i) => upsert({ accountId, scopeKey: `person:${accountId}:p${i}@x.test`, habitsJson: big }));
        for (const [i, row] of rows.entries()) await store.writing.profiles.commit({ upserts: [row], state: {}, now: NOW + i });
        const left = await store.writing.profiles.list({ limit: 1000 });
        expect(left.length).toBeLessThan(rows.length);
        expect(left.reduce((n, r) => n + r.habitsJson.length + r.phrasesJson.length, 0)).toBeLessThanOrEqual(PROFILES_MAX_BYTES);
        expect(left.some((r) => r.scopeKey === rows[0]!.scopeKey)).toBe(false);
        await store.writing.profiles.commit({ upserts: [upsert({ accountId, scopeKey: "person:x", habitsJson: "x".repeat(PROFILE_MAX_BYTES + 1) })], state: {}, now: NOW });
        expect(await store.writing.profiles.read([{ scopeKey: "person:x", language: "" }])).toEqual([]);
      }, 60_000);

      it("goes with its account: the profiles and generations, leaving the other's and 'you'", async () => {
        const { store, accountId, other, send } = await setup();
        const a = upsert({ accountId, scopeKey: `person:${accountId}:tom@acme.com` });
        const b = upsert({ accountId: other, scopeKey: `person:${other}:tom@acme.com` });
        await store.writing.profiles.commit({ upserts: [a, b, { scope: "you", scopeKey: "you", language: "", accountId: null, habitsJson: "{}", phrasesJson: "[]", samples: 50 }], state: {}, now: NOW });
        const draft = await store.drafts.save({ accountId: other, subject: "s", bodyText: "b", to: [], cc: [], bcc: [], mode: "new" } as never, NOW);
        await store.writing.generations.commit({ accountId: other, draftId: draft!.id, draftGeneration: draft!.generation ?? "", address: "t@x.test", generated: "Hi", now: NOW });
        await store.accounts.remove(other);
        const left = (await store.writing.profiles.list({ limit: 10 })).map((r) => r.scopeKey);
        expect(left).toEqual([a.scopeKey, "you"]);
        expect(await store.writing.generations.forDraft(draft!.id)).toBeNull();
        void send;
      });

      it("clear takes all of it, and the settings named", async () => {
        const { store, accountId } = await setup();
        const a = upsert({ accountId, scopeKey: `person:${accountId}:tom@acme.com` });
        await store.writing.profiles.commit({ upserts: [a], state: { [STATE]: 1, "writing:other": 2 }, now: NOW });
        const draft = await store.drafts.save({ accountId, subject: "s", bodyText: "b", to: [], cc: [], bcc: [], mode: "new" } as never, NOW);
        await store.writing.generations.commit({ accountId, draftId: draft!.id, draftGeneration: draft!.generation ?? "", address: "t@x.test", generated: "Hi", now: NOW });
        await store.writing.profiles.clear([STATE]);
        expect(await store.writing.profiles.list({ limit: 10 })).toEqual([]);
        expect(await store.writing.generations.forDraft(draft!.id)).toBeNull();
        expect(await store.settings.get(STATE, null)).toBeNull();
        expect(await store.settings.get("writing:other", null)).toBe(2);
      });
    });

    describe("provenance", () => {
      async function drafted(text = "Hi Tom,\n\nThat's fine.") {
        const t = await setup();
        const draft = (await t.store.drafts.save({ accountId: t.accountId, subject: "s", bodyText: `${text}\n\n-- \nMe`, to: [TOM], cc: [], bcc: [], mode: "new" } as never, NOW))!;
        const generated = canonicalAuthored(text);
        expect(await t.store.writing.generations.commit({ accountId: t.accountId, draftId: draft.id, draftGeneration: draft.generation ?? "", address: TOM.email, generated, now: NOW })).toBe(true);
        const send = (authored: string | null, over: Record<string, unknown> = {}) =>
          t.store.compose.queueSend({ accountId: t.accountId, to: [TOM], cc: [], bcc: [], subject: "s", bodyText: `${authored ?? text}\n\n-- \nMe\n\nOn Tuesday Tom wrote:\n> quoted`, draftId: draft.id, draftGeneration: draft.generation ?? "", draftRevision: draft.revision, recordReply: true, now: NOW + 5, writing: { authored: authored === null ? null : canonicalAuthored(authored) }, ...over });
        return { ...t, draft, generated, sendDraft: send };
      }

      it("is against a draft: refused when the draft or its generation is gone; a later commit replaces it", async () => {
        const { store, accountId, draft } = await drafted();
        expect(await store.writing.generations.commit({ accountId, draftId: 999_999, draftGeneration: "x", address: "a@x.test", generated: "Hi", now: NOW })).toBe(false);
        expect(await store.writing.generations.commit({ accountId, draftId: draft.id, draftGeneration: "stale", address: "a@x.test", generated: "Hi", now: NOW })).toBe(false);
        expect(await store.writing.generations.commit({ accountId, draftId: draft.id, draftGeneration: draft.generation ?? "", address: "a@x.test", generated: "x".repeat(GENERATION_TEXT_MAX_STORE + 1), now: NOW })).toBe(false);
        expect(await store.writing.generations.commit({ accountId, draftId: draft.id, draftGeneration: draft.generation ?? "", address: "A@x.test", generated: "Second", now: NOW + 1 })).toBe(true);
        expect(await store.writing.generations.forDraft(draft.id)).toMatchObject({ generated: "Second", address: "a@x.test", messageId: null, final: null, at: NOW + 1 });
      });

      it("sent unchanged: moves to the message and op with the send, and the message leaves the corpus and sentTo", async () => {
        const { store, accountId, draft, generated, sendDraft } = await drafted();
        const { messageId, opId } = await sendDraft("Hi Tom,\r\n\r\nThat's fine.  ");
        expect(await store.writing.generations.forDraft(draft.id)).toBeNull();
        expect(await store.writing.generations.forMessage(messageId)).toMatchObject({ messageId, opId, generated, final: null, draftId: null, at: NOW + 5 });
        expect(await store.writing.corpus.headers({ accountId, limit: 5 })).toEqual([]);
        expect(await store.writing.corpus.usable([messageId])).toEqual([]);
        expect(await store.writing.sentTo({ addresses: [TOM.email], limit: 5 })).toEqual({ refs: [], state: "unavailable" });
        expect(await store.writing.generations.pairs({ accountId, limit: 5 })).toEqual([]);
      });

      it("sent changed: a bounded pair, and the message stays in the corpus", async () => {
        const { store, accountId, generated, sendDraft } = await drafted();
        const { messageId } = await sendDraft("Tom,\n\nFine by me.");
        expect(await store.writing.generations.forMessage(messageId)).toMatchObject({ generated, final: "Tom,\n\nFine by me." });
        expect((await store.writing.corpus.headers({ accountId, limit: 5 })).map((h) => h.id)).toEqual([messageId]);
        expect(await store.writing.generations.pairs({ accountId, limit: 5 })).toEqual([{ generated, final: "Tom,\n\nFine by me.", address: TOM.email, at: NOW + 5 }]);
        expect(await store.writing.generations.pairs({ accountId, address: "other@x.test", limit: 5 })).toEqual([]);
      });

      it("an agent's send says nothing about what was typed: it stays out of the corpus", async () => {
        const { store, accountId, sendDraft } = await drafted();
        const { messageId } = await sendDraft(null, { writing: undefined });
        expect((await store.writing.generations.forMessage(messageId))!.final).toBeNull();
        expect(await store.writing.corpus.headers({ accountId, limit: 5 })).toEqual([]);
      });

      it("a send that fails its checks leaves the draft's generation as it was", async () => {
        const { store, draft, generated, sendDraft } = await drafted();
        await expect(sendDraft("x", { draftRevision: draft.revision + 5 })).rejects.toThrow();
        expect(await store.writing.generations.forDraft(draft.id)).toMatchObject({ generated, messageId: null });
      });

      it("survives identity reconciliation: the provider's copy of the mail keeps it on the same row", async () => {
        const { store, accountId, sendDraft } = await drafted();
        const { messageId } = await sendDraft("Tom,\n\nFine by me.");
        const local = (await store.debug.snapshot()).messages.find((m) => m.id === messageId)!;
        const [header] = await store.writing.corpus.headers({ accountId, limit: 1 });
        const rfc = (await store.threads.get(header!.threadId))!.messages.find((m) => m.id === messageId) as { rfcMessageId?: string } | undefined;
        const rfcMessageId = rfc?.rfcMessageId ?? local.rfcMessageId!;
        await ingest(store, [msg({ accountId, providerMsgId: "server-id", rfcMessageId, from: ME, to: [TOM], isSent: true, inInbox: false, bodyText: "Tom,\n\nFine by me.\n\n-- \nMe", date: NOW + 5 })], NOW + 10);
        expect(await store.writing.generations.forMessage(messageId)).toMatchObject({ final: "Tom,\n\nFine by me." });
      });

      it("goes when the draft is discarded, and when its message goes", async () => {
        const { store, accountId, draft, sendDraft } = await drafted();
        const again = (await store.drafts.save({ accountId, subject: "x", bodyText: "b", to: [TOM], cc: [], bcc: [], mode: "new" } as never, NOW))!;
        await store.writing.generations.commit({ accountId, draftId: again.id, draftGeneration: again.generation ?? "", address: TOM.email, generated: "Other", now: NOW });
        await store.drafts.delete(again.id, again.generation ?? "");
        expect(await store.writing.generations.forDraft(again.id)).toBeNull();
        const { messageId } = await sendDraft("Tom,\n\nFine by me.");
        await store.sync.remove([messageId]);
        expect(await store.writing.generations.forMessage(messageId)).toBeNull();
        void draft;
      });

      it("keeps to its rows and bytes, oldest first; an unchanged send past them stays out of the corpus", async () => {
        const { store, accountId, send } = await setup();
        const sent = async (i: number, text: string, unchanged: boolean) => {
          const draft = (await store.drafts.save({ accountId, subject: `s${i}`, bodyText: text, to: [TOM], cc: [], bcc: [], mode: "new" } as never, NOW + i))!;
          await store.writing.generations.commit({ accountId, draftId: draft.id, draftGeneration: draft.generation ?? "", address: TOM.email, generated: text, now: NOW + i });
          return (await store.compose.queueSend({ accountId, to: [TOM], cc: [], bcc: [], subject: `s${i}`, bodyText: text, draftId: draft.id, draftGeneration: draft.generation ?? "", draftRevision: draft.revision, recordReply: true, now: NOW + i, writing: { authored: unchanged ? text : `${text}!` } })).messageId;
        };
        const firstUnchanged = await sent(0, "Oldest unchanged", true);
        const firstChanged = await sent(1, "Oldest changed", false);
        for (let i = 2; i < GENERATIONS_MAX_ROWS + 3; i++) await sent(i, `Generated ${i}`, false);
        expect(await store.writing.generations.forMessage(firstChanged)).toBeNull();
        expect(await store.writing.generations.forMessage(firstUnchanged)).toMatchObject({ generated: "", final: null });
        expect((await store.writing.generations.pairs({ accountId, limit: 1000 })).length).toBeLessThanOrEqual(GENERATIONS_MAX_ROWS);
        expect((await store.writing.corpus.usable([firstUnchanged]))).toEqual([]);
        void send;
      }, 60_000);

      it("keeps to its bytes", async () => {
        const { store, accountId } = await setup();
        const big = "word ".repeat(12_000);
        const ids: number[] = [];
        for (let i = 0; i < Math.ceil(GENERATIONS_MAX_BYTES / (big.length * 2)) + 3; i++) {
          const draft = (await store.drafts.save({ accountId, subject: `s${i}`, bodyText: "b", to: [TOM], cc: [], bcc: [], mode: "new" } as never, NOW + i))!;
          await store.writing.generations.commit({ accountId, draftId: draft.id, draftGeneration: draft.generation ?? "", address: TOM.email, generated: `${i}${big}`, now: NOW + i });
          ids.push((await store.compose.queueSend({ accountId, to: [TOM], cc: [], bcc: [], subject: `s${i}`, bodyText: "b", draftId: draft.id, draftGeneration: draft.generation ?? "", draftRevision: draft.revision, recordReply: true, now: NOW + i, writing: { authored: `${big}${i}` } })).messageId);
        }
        const pairs = await store.writing.generations.pairs({ accountId, limit: 1000 });
        expect(pairs.reduce((n, p) => n + p.generated.length + p.final.length, 0)).toBeLessThanOrEqual(GENERATIONS_MAX_BYTES);
        expect(await store.writing.generations.forMessage(ids[0]!)).toBeNull();
      }, 60_000);
    });
  });
}
