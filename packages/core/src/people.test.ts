import { describe, expect, it } from "vitest";
import { BULK_LOCAL } from "./categorize/features";
import { addressKey, automatedLevel, bulkHeaders, FACTS_WINDOW, ROLE_WORDS, senderIsPerson, threadFacts, threadFactsNewestFirst, waitingCutoff, WAITING_WINDOW_MS, type FactContext, type FactRow } from "./people";

const sender = (from_email: string, o: Partial<FactRow> = {}) => ({ from_email, list_id: null, is_bulk: 0, gmail_labels: null, is_spam: 0, ...o });

describe("who is a person (plan 17 §2.2)", () => {
  it("compares addresses lowercased, trimmed, without a +tag", () => {
    expect(addressKey("  Ana+News@Example.COM ")).toBe("ana@example.com");
    expect(addressKey("ana@example.com")).toBe("ana@example.com");
    expect(addressKey("+x@example.com")).toBe("+x@example.com");
    expect(addressKey("not-an-address")).toBe("not-an-address");
  });

  it("bulk headers: List-Unsubscribe, Precedence bulk/list/junk, Auto-Submitted other than no", () => {
    expect(bulkHeaders({})).toBe(false);
    expect(bulkHeaders({ listUnsubscribe: "<mailto:u@x.com>" })).toBe(true);
    expect(bulkHeaders({ listUnsubscribe: "  " })).toBe(false);
    for (const p of ["bulk", "List", " junk "]) expect(bulkHeaders({ precedence: p })).toBe(true);
    expect(bulkHeaders({ precedence: "first-class" })).toBe(false);
    expect(bulkHeaders({ autoSubmitted: "auto-replied" })).toBe(true);
    expect(bulkHeaders({ autoSubmitted: "auto-generated" })).toBe(true);
    expect(bulkHeaders({ autoSubmitted: "no" })).toBe(false);
  });

  it("strong signals are never a person, even when you wrote to them", () => {
    const written = { written: () => true };
    for (const s of [
      sender("ana@friends.com", { list_id: "team.lists.example.com" }),
      sender("ana@friends.com", { is_bulk: 1 }),
      sender("ana@friends.com", { is_spam: 1 }),
      sender("ana@friends.com", { gmail_labels: '["INBOX","CATEGORY_PROMOTIONS"]' }),
      sender("ana@friends.com", { gmail_labels: '["CATEGORY_SOCIAL"]' }),
      sender("ana@friends.com", { gmail_labels: '["CATEGORY_FORUMS"]' }),
      sender("noreply@github.com"),
      sender("no-reply@accounts.example.com"),
      sender("do_not_reply@bank.mx"),
      sender("donotreply@x.com"),
      sender("calendar-noreply@google.com"),
      sender("MAILER-DAEMON@mx.example.com"),
      sender("postmaster@example.com"),
      sender("bounces+123@mail.example.com"),
      sender("no.responder@banco.mx"),
      sender(""),
      sender("nobody"),
    ]) {
      expect(automatedLevel(s), s.from_email).toBe(2);
      expect(senderIsPerson(s, written), s.from_email).toBe(false);
    }
  });

  it("weak signals lose to a person you have written to", () => {
    for (const s of [
      sender("notifications@github.com"),
      sender("support@small-shop.com"),
      sender("uber.receipts@uber.com"),
      sender("pedidos@amazon.com.mx"),
      sender("hola@estudio.mx"),
      sender("calendar-notification@google.com"),
      sender("ana@news.example.com"),
      sender("someone@linkedin.com"),
      sender("ana@friends.com", { gmail_labels: '["CATEGORY_UPDATES"]' }),
    ]) {
      expect(automatedLevel(s), s.from_email).toBe(1);
      expect(senderIsPerson(s, { written: () => false }), s.from_email).toBe(false);
      expect(senderIsPerson(s, { written: (k) => k === addressKey(s.from_email) }), s.from_email).toBe(true);
    }
  });

  it("everyone else is a person", () => {
    for (const s of [sender("ana.lopez@gmail.com"), sender("carlos@acme.com"), sender("ana+work@gmail.com"), sender("j@mail.com"), sender("noemi@ejemplo.com"), sender("ana@friends.com", { gmail_labels: '["INBOX","CATEGORY_PERSONAL"]' })]) {
      expect(automatedLevel(s), s.from_email).toBe(0);
      expect(senderIsPerson(s, { written: () => false })).toBe(true);
    }
  });

  it("role words are a superset of the categorizer's bulk local parts", () => {
    const words = BULK_LOCAL.source.replace(/^\^\(|\)\\b$/g, "").split("|");
    for (const w of ["notification", "notifications", "notificaciones", "alerta", "alertas", "automated", "mailer", "newsletter", "boletin", "news", "info", "updates", "marketing", "promo", "promociones"]) {
      expect(ROLE_WORDS.has(w), w).toBe(true);
    }
    // the no-reply family is strong here
    expect(words.some((w) => w.includes("reply"))).toBe(true);
    expect(automatedLevel(sender("no-reply@x.com"))).toBe(2);
  });
});

const ME = "me@mine.com";
const ALIAS = "me@alias.com";
let nextId = 1;
function msg(o: Partial<FactRow> & { from?: string; to?: string[]; cc?: string[] }): FactRow {
  const { from, to, cc, ...rest } = o;
  return {
    id: nextId++,
    date: 1000,
    from_email: from ?? "ana@friends.com",
    to_json: JSON.stringify((to ?? [ME]).map((email) => ({ name: "", email }))),
    cc_json: JSON.stringify((cc ?? []).map((email) => ({ name: "", email }))),
    is_sent: 0,
    is_draft: 0,
    is_trash: 0,
    is_spam: 0,
    list_id: null,
    is_bulk: 0,
    gmail_labels: null,
    rfc_message_id: `m${nextId}@x`,
    provider_msg_id: `p${nextId}`,
    ...rest,
  };
}
const ctx = (o: Partial<FactContext> = {}): FactContext => ({ own: (k) => k === ME || k === ALIAS, written: () => false, answered: () => false, failedSend: () => false, ...o });

describe("a thread's facts (plan 17 §2.3)", () => {
  it("a person's message to you, unanswered: from a person and waiting since its date", () => {
    expect(threadFacts([msg({ date: 5 })], ctx())).toEqual({ person: 1, waitingSince: 5 });
  });

  it("your reply after it: still from a person, not waiting", () => {
    expect(threadFacts([msg({ date: 5 }), msg({ date: 6, from: ME, is_sent: 1, to: ["ana@friends.com"] })], ctx())).toEqual({ person: 1, waitingSince: null });
  });

  it("your reply from another account, copied here as inbound mail from your address: yours", () => {
    expect(threadFacts([msg({ date: 5 }), msg({ date: 6, from: "Me+x@Alias.com", to: ["ana@friends.com"] })], ctx())).toEqual({ person: 1, waitingSince: null });
  });

  it("a reply from another account that didn't copy this one: answered", () => {
    const m = msg({ date: 5, rfc_message_id: "q@x" });
    expect(threadFacts([m], ctx({ answered: (id) => id === "q@x" }))).toEqual({ person: 1, waitingSince: null });
  });

  it("a newsletter is neither", () => {
    expect(threadFacts([msg({ from: "boletin@xataka.com", list_id: "boletin.xataka.com" })], ctx())).toEqual({ person: 0, waitingSince: null });
  });

  it("only your own mail: no inbound message, neither", () => {
    expect(threadFacts([msg({ from: ME, is_sent: 1, to: ["ana@friends.com"] })], ctx())).toEqual({ person: 0, waitingSince: null });
  });

  it("the newest inbound decides who it's from: a person's reply after a notification", () => {
    const rows = [msg({ date: 1, from: "notifications@github.com" }), msg({ date: 2, from: "carlos@acme.com" })];
    expect(threadFacts(rows, ctx())).toEqual({ person: 1, waitingSince: 2 });
    const reversed = [msg({ date: 2, from: "notifications@github.com" }), msg({ date: 1, from: "carlos@acme.com" })];
    expect(threadFacts(reversed, ctx())).toEqual({ person: 0, waitingSince: null });
  });

  it("ties on date break by id, as the list orders them", () => {
    const a = msg({ date: 7, from: "carlos@acme.com" });
    const b = msg({ date: 7, from: "noreply@acme.com" });
    expect(threadFacts([b, a], ctx())).toEqual({ person: 0, waitingSince: null });
  });

  it("drafts never count, neither as the newest message nor as a reply", () => {
    expect(threadFacts([msg({ date: 5 }), msg({ date: 6, from: ME, is_draft: 1, is_sent: 0 })], ctx())).toEqual({ person: 1, waitingSince: 5 });
    expect(threadFacts([msg({ date: 5, is_draft: 1 })], ctx())).toEqual({ person: 0, waitingSince: null });
  });

  it("trashed and spam messages are ignored while anything is visible", () => {
    const rows = [msg({ date: 5 }), msg({ date: 9, from: "spammer@x.top", is_spam: 1 }), msg({ date: 8, from: ME, is_sent: 1, is_trash: 1 })];
    expect(threadFacts(rows, ctx())).toEqual({ person: 1, waitingSince: 5 });
  });

  it("a thread entirely in the Trash keeps who it's from but never waits", () => {
    expect(threadFacts([msg({ date: 5, is_trash: 1 })], ctx())).toEqual({ person: 1, waitingSince: null });
  });

  it("a thread entirely in Spam is neither", () => {
    expect(threadFacts([msg({ date: 5, is_spam: 1 })], ctx())).toEqual({ person: 0, waitingSince: null });
  });

  it("only on Cc: not waiting; on To, or none of your addresses at all (a forward, Bcc): waiting", () => {
    expect(threadFacts([msg({ to: ["boss@acme.com"], cc: [ME] })], ctx()).waitingSince).toBeNull();
    expect(threadFacts([msg({ to: ["boss@acme.com", "me+work@mine.com"], cc: [ME] })], ctx()).waitingSince).toBe(1000);
    expect(threadFacts([msg({ to: ["work@forwarded.com"] })], ctx()).waitingSince).toBe(1000);
    expect(threadFacts([msg({ to_json: "not json" })], ctx()).waitingSince).toBe(1000);
  });

  it("a weak sender you wrote to is a person, and waits", () => {
    const rows = [msg({ from: "support@small-shop.com" })];
    expect(threadFacts(rows, ctx())).toEqual({ person: 0, waitingSince: null });
    expect(threadFacts(rows, ctx({ written: (k) => k === "support@small-shop.com" }))).toEqual({ person: 1, waitingSince: 1000 });
  });

  it("the window: 30 days back from now", () => {
    expect(WAITING_WINDOW_MS).toBe(30 * 86_400_000);
    expect(waitingCutoff(31 * 86_400_000)).toBe(86_400_000);
  });

  it("a queued send answers at once; one that failed counts for nothing (Codex R8)", () => {
    const reply = msg({ date: 6, from: ME, is_sent: 1, to: ["ana@friends.com"], provider_msg_id: "local:abc@mine.com" });
    const rows = [msg({ date: 5 }), reply];
    expect(threadFacts(rows, ctx())).toEqual({ person: 1, waitingSince: null });
    expect(threadFacts(rows, ctx({ failedSend: (id) => id === reply.id }))).toEqual({ person: 1, waitingSince: 5 });
    // a server copy is never asked about
    expect(threadFacts([msg({ date: 5 }), { ...reply, provider_msg_id: "gm-1" }], ctx({ failedSend: () => true }))).toEqual({ person: 1, waitingSince: null });
  });
});

describe("threadFactsNewestFirst (Codex R10)", () => {
  /** mulberry32 */
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const newestFirst = (rows: FactRow[]) => [...rows].sort((a, b) => b.date - a.date || b.id - a.id);

  it("equals threadFacts on 5,000 random threads", () => {
    const r = prng(17);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
    const senders = [ME, ALIAS, "me+x@mine.com", "ana@friends.com", "support@shop.com", "noreply@x.com", "carlos@acme.com"];
    for (let k = 0; k < 5000; k++) {
      const rows = Array.from({ length: 1 + Math.floor(r() * 7) }, () =>
        msg({
          date: Math.floor(r() * 5),
          from: pick(senders),
          to: [pick([ME, "boss@acme.com", ALIAS])],
          cc: r() < 0.3 ? [ME] : [],
          is_sent: r() < 0.2 ? 1 : 0,
          is_draft: r() < 0.1 ? 1 : 0,
          is_trash: r() < 0.2 ? 1 : 0,
          is_spam: r() < 0.1 ? 1 : 0,
          list_id: r() < 0.1 ? "l.x.com" : null,
          provider_msg_id: r() < 0.2 ? "local:1" : "p",
        }),
      );
      const c = ctx({ written: (key) => key === "support@shop.com", answered: (id) => id.length % 3 === 0, failedSend: (id) => id % 2 === 0 });
      const ordered = newestFirst(rows);
      let i = 0;
      expect(threadFactsNewestFirst(() => ordered[i++], c), JSON.stringify(rows)).toEqual(threadFacts(rows, c));
      // and with a window shorter than the thread (Codex review 1, #1): both read the same newest messages
      let j = 0;
      expect(threadFactsNewestFirst(() => ordered[j++], c, 3), `window 3: ${JSON.stringify(rows)}`).toEqual(threadFacts(rows, c, 3));
    }
  });

  it("reads only as far as it must: the newest message of a long conversation, when it is a person's", () => {
    const rows = newestFirst(Array.from({ length: 1000 }, (_, i) => msg({ date: i, from: i % 2 ? ME : "carlos@acme.com", is_sent: i % 2 })));
    let read = 0;
    expect(threadFactsNewestFirst(() => (read++, rows[read - 1]), ctx())).toEqual({ person: 1, waitingSince: null });
    // the newest is yours (999 is odd), the next one is Carlos's
    expect(read).toBe(2);
  });

  it("never reads past the window: a 50,000-message conversation of yours, or one entirely in the Trash, costs 200 messages (Codex review 1, #1)", () => {
    const yours = newestFirst([msg({ date: 0, from: "carlos@acme.com" }), ...Array.from({ length: 50_000 }, (_, i) => msg({ date: i + 1, from: ME, is_sent: 1, to: ["carlos@acme.com"] }))]);
    let read = 0;
    expect(threadFactsNewestFirst(() => (read++, yours[read - 1]), ctx())).toEqual({ person: 0, waitingSince: null });
    expect(read).toBe(FACTS_WINDOW);
    expect(threadFacts(yours, ctx())).toEqual({ person: 0, waitingSince: null });
    // Carlos's message is inside a wider window: from a person again
    expect(threadFacts(yours, ctx(), 50_001)).toEqual({ person: 1, waitingSince: null });
    const trashed = newestFirst(Array.from({ length: 50_000 }, (_, i) => msg({ date: i, from: i === 49_999 - 150 ? "carlos@acme.com" : ME, is_sent: i === 49_999 - 150 ? 0 : 1, is_trash: 1 })));
    read = 0;
    expect(threadFactsNewestFirst(() => (read++, trashed[read - 1]), ctx())).toEqual({ person: 1, waitingSince: null });
    expect(read).toBeLessThanOrEqual(FACTS_WINDOW);
    expect(threadFacts(trashed, ctx())).toEqual({ person: 1, waitingSince: null });
  });
});
