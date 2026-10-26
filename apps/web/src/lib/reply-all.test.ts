/**
 * Plan 29 §3.4: who a reply and a reply-all go to, whatever other clients
 * wrote in the headers. Table-driven; each row a message (or a thread) and
 * the To and Cc Terno fills in.
 */
import type { Account, Address, MessageDetail, ThreadDetail } from "@terno/core";
import { describe, expect, it } from "vitest";
import { answered, autoRecipients, identitiesIn, quoteFor, replyFields, replyName } from "./compose-fields";

const A = (name: string, email: string): Address => ({ name, email });
const me = A("Luis", "luis@acme.studio");
const ana = A("Ana", "ana@x.com");
const bob = A("Bob", "bob@y.com");
const cara = A("Cara", "cara@z.com");

let id = 1;
const m = (o: Partial<MessageDetail>): MessageDetail => ({ id: id++, threadId: 1, accountId: 1, from: ana, replyTo: [], to: [me], cc: [], subject: "s", date: id, snippet: "", bodyText: `body ${id}`, bodyHtml: null, bodyState: "full", isRead: true, isStarred: false, isSent: false, hasAttachments: false, rfcMessageId: null, references: [], listId: null, attachments: [], ...o });
const thread = (...messages: MessageDetail[]): ThreadDetail => ({ thread: { id: 1, subject: "s" }, messages }) as unknown as ThreadDetail;
const emails = (list: Address[]) => list.map((a) => a.email);

describe("reply and reply-all recipients", () => {
  it.each<[string, MessageDetail[], { to: string[]; cc: string[] }]>([
    ["ordinary: the sender; the others in Cc, never me", [m({ from: ana, to: [me, bob], cc: [cara] })], { to: ["ana@x.com"], cc: ["bob@y.com", "cara@z.com"] }],
    ["the user's mangled Cc: both people, cleanly", [m({ cc: [A("_David_Sucre_L.?= <david@sucre.net> , Luis Alberto Medina", "lmedina@sucre.net")] })], { to: ["ana@x.com"], cc: ["david@sucre.net", "lmedina@sucre.net"] }],
    ["me in any case, with a +tag, in Cc", [m({ to: [A("", "LUIS@ACME.STUDIO")], cc: [A("", "luis+news@acme.studio"), bob] })], { to: ["ana@x.com"], cc: ["bob@y.com"] }],
    ["duplicates across and within To and Cc", [m({ to: [me, bob, A("BOB", "Bob@Y.com")], cc: [bob, A("", "ana@x.com")] })], { to: ["ana@x.com"], cc: ["bob@y.com"] }],
    ["Reply-To: the list, not the author", [m({ from: ana, replyTo: [A("Team", "team@lists.x.com")], to: [A("Team", "team@lists.x.com")], cc: [bob] })], { to: ["team@lists.x.com"], cc: ["bob@y.com"] }],
    ["several Reply-To addresses", [m({ replyTo: [bob, cara] })], { to: ["bob@y.com", "cara@z.com"], cc: [] }],
    ["a Reply-To that is only me: To left empty (plan 27), the others in Cc", [m({ replyTo: [me], cc: [bob] })], { to: [], cc: ["bob@y.com"] }],
    ["my own message: its To again, its Cc in Cc, not me", [m({ from: me, isSent: true, to: [bob], cc: [cara, me] })], { to: ["bob@y.com"], cc: ["cara@z.com"] }],
    ["the newest is mine: the one before it is answered", [m({ from: ana, to: [me], cc: [bob] }), m({ from: me, isSent: true, to: [ana] })], { to: ["ana@x.com"], cc: ["bob@y.com"] }],
    ["an alias of mine (a sent From in the thread) that isn't marked sent on this one", [m({ from: A("Luis", "luis@personal.dev"), isSent: true, to: [ana] }), m({ from: ana, to: [A("", "luis@personal.dev"), cara] }), m({ from: A("Luis", "luis@personal.dev"), to: [ana, cara] })], { to: ["ana@x.com"], cc: ["cara@z.com"] }],
    ["answering a note to myself: to me", [m({ from: me, isSent: true, to: [me] })], { to: ["luis@acme.studio"], cc: [] }],
    ["an address that can't be repaired stays (shown invalid)", [m({ cc: [A("", "foo bar")] })], { to: ["ana@x.com"], cc: ["foo bar"] }],
    ["a no-reply sender is kept (the chip says so)", [m({ from: A("Shop", "no-reply@shop.com") })], { to: ["no-reply@shop.com"], cc: [] }],
  ])("%s", (_, messages, expected) => {
    const detail = thread(...messages);
    const all = autoRecipients("replyAll", detail, [me.email]);
    expect({ to: emails(all.to), cc: emails(all.cc) }).toEqual(expected);
    // a reply is the same To and no Cc
    const one = autoRecipients("reply", detail, [me.email]);
    expect({ to: emails(one.to), cc: one.cc }).toEqual({ to: expected.to, cc: [] });
  });

  it("every account's address is mine, Gmail's dotted spellings too", () => {
    const detail = thread(m({ to: [A("", "l.u.i.s@gmail.com"), bob], cc: [A("", "work@acme.studio")] }));
    expect(emails(autoRecipients("replyAll", detail, ["luis@googlemail.com", "work@acme.studio"]).cc)).toEqual(["bob@y.com"]);
  });

  it("forward: nobody", () => {
    expect(autoRecipients("forward", thread(m({})), [me.email])).toEqual({ to: [], cc: [] });
  });

  it("hundreds of recipients: all of them, once, fast", () => {
    const many = Array.from({ length: 1000 }, (_, i) => A(`P ${i}`, `p${i}@x.com`));
    const detail = thread(m({ to: [me, ...many], cc: [...many].reverse() }));
    const started = performance.now();
    const r = autoRecipients("replyAll", detail, [me.email]);
    expect(performance.now() - started).toBeLessThan(100);
    expect(r.cc).toHaveLength(1000);
  });

  it("the recipients, the quote, the threading and the reply bar answer the same message (Codex review 4)", () => {
    const alias = A("Luis", "luis@personal.dev");
    const detail = thread(m({ from: alias, isSent: true, to: [ana] }), m({ from: bob, to: [alias] }), m({ from: alias, to: [bob], bodyText: "mine, from the alias" }));
    const mine = identitiesIn(detail, [me.email]);
    expect(answered(detail, mine).from).toEqual(bob);
    expect(quoteFor("reply", detail, mine)).toContain("Bob");
    const fields = replyFields("reply", detail, { id: 1, email: me.email } as Account);
    expect(fields.toText).toBe("Bob <bob@y.com>");
    expect(fields.inReplyToMessageId).toBe(detail.messages[1]!.id);
    expect(replyName(detail, [me.email])).toBe("Bob");
  });

  it("Bcc never goes anywhere", () => {
    const detail = thread(m({ from: me, isSent: true, to: [bob] }));
    (detail.messages[0] as unknown as { bcc: Address[] }).bcc = [cara];
    const r = autoRecipients("replyAll", detail, [me.email]);
    expect([...emails(r.to), ...emails(r.cc)]).not.toContain("cara@z.com");
  });
});
