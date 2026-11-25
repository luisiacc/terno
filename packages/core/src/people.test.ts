import { describe, expect, it } from "vitest";
import { BULK_LOCAL } from "./categorize/features";
import { addressKey, automatedLevel, personKey, bulkHeaders, FACTS_WINDOW, ROLE_WORDS, senderIsPerson, sentByService, threadFacts, threadFactsNewestFirst, waitingCutoff, waitingFactsNewestFirst, WAITING_WINDOW_MS, type FactContext, type FactRow } from "./people";

const sender = (from_email: string, o: Partial<FactRow> = {}) => ({ from_email, list_id: null, is_bulk: 0, gmail_labels: null, is_spam: 0, rfc_message_id: null, ...o });

describe("plan 278: mail a sending service sent", () => {
  it("knows each service by its Message-ID's domain, any case, in brackets or not; nothing else", () => {
    for (const id of [
      "010001a2137e934d-0015bcc7-d756-44e5-b50f-0663cb19358e-000000@email.amazonses.com",
      "0100abc@us-west-2.AmazonSES.com",
      "x@amazonses.com",
      "xb0ge6gwtn6gsxib_kilvg@geopod-ismtpd-54",
      "abc@ismtpd0012p1mdw1",
      "abc@geopod-ismtpd-3-0",
      "abc@sendgrid.net",
      "abc@xyz.sendgrid.net",
      "a1b2@mtasv.net",
      "a1b2@pm.mtasv.net",
      "x@mta12.prd.sparkpost",
      "x@sparkpostmail.com",
      "<abc@email.amazonses.com>",
      " abc@email.amazonses.com> ",
    ])
      expect(sentByService(id), id).toBe(true);
    for (const id of [
      null,
      "",
      "no-at-sign",
      "ca+3jzeuppaw3mxhytgbhqnub02e3rdgvn3mcdnwm8oz5=y8chw@mail.gmail.com",
      "sj0pr17mb434904101f1052d56295763f9b442@sj0pr17mb4349.namprd17.prod.outlook.com",
      "x@notamazonses.com",
      "x@amazonses.com.evil.org",
      "x@ismtpd.example.org",
      "x@notismtpd-1",
      "x@ismtpdinternal",
      "x@ismtpd",
      "x@geopod-ismtpd-x",
      "@email.amazonses.com",
      "<@email.amazonses.com>",
      "x@mtasv.network",
      "x@sparkpost",
      "x@bncr.fi.cr",
    ])
      expect(sentByService(id), String(id)).toBe(false);
  });

  it("is never a person, even someone you wrote to (an app's hello@ or sac@)", () => {
    const written = { written: () => true };
    for (const from of ["hello@iuspro.com", "sac@tilopay.com", "ana@friends.com"]) {
      const s = sender(from, { rfc_message_id: "01@email.amazonses.com" });
      expect(automatedLevel(s), from).toBe(2);
      expect(senderIsPerson(s, written), from).toBe(false);
      // the same address from a person's mail server stays what it was
      expect(senderIsPerson(sender(from, { rfc_message_id: "x@mail.gmail.com" }), written), from).toBe(true);
    }
  });

  it("your word outranks every guess, both ways, but never makes Spam a person", () => {
    const always = { written: () => false, rule: () => true };
    const never = { written: () => true, rule: () => false };
    for (const s of [sender("ana@friends.com", { list_id: "l" }), sender("noreply@bank.mx"), sender("hello@iuspro.com", { rfc_message_id: "1@email.amazonses.com" }), sender("support@shop.com")]) expect(senderIsPerson(s, always), s.from_email).toBe(true);
    for (const s of [sender("ana.lopez@gmail.com"), sender("support@shop.com")]) expect(senderIsPerson(s, never), s.from_email).toBe(false);
    expect(senderIsPerson(sender("ana@friends.com", { is_spam: 1 }), always)).toBe(false);
    // asked by the address's key: a +tag and case don't escape it
    expect(senderIsPerson(sender("Ana+x@Friends.com"), { written: () => false, rule: (k) => (k === "ana@friends.com" ? false : undefined) })).toBe(false);
  });
});

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

  it("plan 215: a newest message marked as needing no reply is answered; a newer one from them waits again; with answered too, none", () => {
    const asked = msg({ date: 5 });
    const cleared = (id: number) => id === asked.id;
    expect(threadFacts([asked], ctx({ cleared }))).toEqual({ person: 1, waitingSince: null });
    // the walk names the message it judged waiting, or none once it's cleared
    const walk = (rows: FactRow[], c: FactContext) => {
      const sorted = [...rows].sort((a, b) => b.date - a.date || b.id - a.id);
      let i = 0;
      return waitingFactsNewestFirst(() => sorted[i++], c);
    };
    expect(walk([asked], ctx())).toEqual({ person: 1, waitingSince: 5, waitingMessageId: asked.id });
    expect(walk([asked], ctx({ cleared }))).toEqual({ person: 1, waitingSince: null, waitingMessageId: null });
    const again = msg({ date: 7 });
    expect(threadFacts([asked, again], ctx({ cleared }))).toEqual({ person: 1, waitingSince: 7 });
    expect(walk([asked, again], ctx({ cleared }))).toEqual({ person: 1, waitingSince: 7, waitingMessageId: again.id });
    // asked only of a message that would wait: an answered one never reaches it
    let asks = 0;
    const answered = msg({ date: 9, rfc_message_id: "z@x" });
    expect(threadFacts([answered], ctx({ answered: (id) => id === "z@x", cleared: () => (asks++, true) }))).toEqual({ person: 1, waitingSince: null });
    expect(asks).toBe(0);
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

describe("plan 240: a sender always shown in What matters", () => {
  const shown = (k: string) => k === "news@list.shop.com";
  it("their newest unanswered message waits whatever it looks like, and who is a person doesn't change", () => {
    // a list's mail (never a person), Promotions', a no-reply's: each waits once shown
    for (const over of [{ list_id: "l.shop.com" }, { is_bulk: 1 }, { gmail_labels: JSON.stringify(["CATEGORY_PROMOTIONS"]) }]) {
      const m = msg({ date: 5, from: "News+deals@List.Shop.com", ...over });
      expect(threadFacts([m], ctx())).toEqual({ person: 0, waitingSince: null });
      expect(threadFacts([m], ctx({ shown }))).toEqual({ person: 0, waitingSince: 5 });
    }
  });

  it("never Spam's, nor one answered, cleared, or that only copied you", () => {
    const from = "news@list.shop.com";
    expect(threadFacts([msg({ date: 5, from, is_spam: 1 })], ctx({ shown }))).toEqual({ person: 0, waitingSince: null });
    expect(threadFacts([msg({ date: 5, from, list_id: "l" }), msg({ date: 6, from: ME, is_sent: 1, to: [from] })], ctx({ shown }))).toEqual({ person: 0, waitingSince: null });
    const asked = msg({ date: 5, from, list_id: "l", rfc_message_id: "q@x" });
    expect(threadFacts([asked], ctx({ shown, answered: (id) => id === "q@x" }))).toEqual({ person: 0, waitingSince: null });
    expect(threadFacts([asked], ctx({ shown, cleared: (id) => id === asked.id }))).toEqual({ person: 0, waitingSince: null });
    expect(threadFacts([msg({ date: 5, from, to: ["boss@acme.com"], cc: [ME] })], ctx({ shown }))).toEqual({ person: 0, waitingSince: null });
  });

  it("the newest-first walk agrees", () => {
    const rows = [msg({ date: 4, from: "ana@friends.com" }), msg({ date: 5, from: "news@list.shop.com", list_id: "l" })];
    const ordered = [...rows].sort((a, b) => b.date - a.date || b.id - a.id);
    let i = 0;
    expect(threadFactsNewestFirst(() => ordered[i++], ctx({ shown }))).toEqual(threadFacts(rows, ctx({ shown })));
    expect(threadFacts(rows, ctx({ shown }))).toEqual({ person: 0, waitingSince: 5 });
  });
});

describe("plan 278: a thread's facts with sending services and your word", () => {
  it("an app's receipt from an address you wrote to is neither from a person nor waiting; Always makes it both", () => {
    const m = msg({ date: 5, from: "sac@tilopay.com", rfc_message_id: "abc@geopod-ismtpd-54" });
    const wrote = ctx({ written: (k) => k === "sac@tilopay.com" });
    expect(threadFacts([m], wrote)).toEqual({ person: 0, waitingSince: null });
    expect(threadFacts([m], ctx({ rule: (k) => (k === "sac@tilopay.com" ? true : undefined) }))).toEqual({ person: 1, waitingSince: 5 });
  });

  it("Never takes a person out of People and waiting, but an always shown sender still waits (plan 240)", () => {
    const m = msg({ date: 5, from: "ana@friends.com" });
    const never = (k: string) => (k === "ana@friends.com" ? false : undefined);
    expect(threadFacts([m], ctx({ rule: never }))).toEqual({ person: 0, waitingSince: null });
    expect(threadFacts([m], ctx({ rule: never, shown: (k) => k === "ana@friends.com" }))).toEqual({ person: 0, waitingSince: 5 });
  });

  it("Always keeps the usual reply checks: answered, or only on Cc, doesn't wait", () => {
    const always = () => true;
    const asked = msg({ date: 5, from: "news@list.shop.com", list_id: "l", rfc_message_id: "q@x" });
    expect(threadFacts([asked], ctx({ rule: always, answered: (id) => id === "q@x" }))).toEqual({ person: 1, waitingSince: null });
    expect(threadFacts([msg({ date: 5, from: "news@list.shop.com", to: ["boss@acme.com"], cc: [ME] })], ctx({ rule: always }))).toEqual({ person: 1, waitingSince: null });
  });

  it("a store that left out the Message-ID is asked for it once, for the inbound message, and it's reused when that's the newest", () => {
    const m = msg({ date: 5, from: "carlos@acme.com" });
    const { to_json, cc_json, rfc_message_id, ...bare } = m;
    const asked: number[] = [];
    expect(threadFacts([bare], ctx({ details: (id) => (asked.push(id), { to_json: to_json!, cc_json: cc_json!, rfc_message_id: "1@email.amazonses.com" }) }))).toEqual({ person: 0, waitingSince: null });
    expect(asked).toEqual([m.id]);
    asked.length = 0;
    expect(threadFacts([bare], ctx({ details: (id) => (asked.push(id), { to_json: to_json!, cc_json: cc_json!, rfc_message_id: rfc_message_id ?? null }) }))).toEqual({ person: 1, waitingSince: 5 });
    expect(asked).toEqual([m.id]);
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
          ...(r() < 0.2 ? { rfc_message_id: `s${k}@email.amazonses.com` } : {}),
        }),
      );
      const c = ctx({ written: (key) => key === "support@shop.com", answered: (id) => id.length % 3 === 0, failedSend: (id) => id % 2 === 0, shown: (key) => key === "noreply@x.com", rule: (key) => (key === "carlos@acme.com" ? false : key === "noreply@x.com" ? true : undefined) });
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

describe("personKey (plan 281)", () => {
  it("addressKey's, with Gmail's dots ignored and googlemail as gmail", () => {
    expect(personKey(" Ana.B+work@GoogleMail.com")).toBe("anab@gmail.com");
    expect(personKey("ana.b@gmail.com")).toBe("anab@gmail.com");
    expect(personKey("ana.b+x@acme.test")).toBe("ana.b@acme.test");
  });
});
