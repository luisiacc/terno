import { parseAddressList, type Account, type Address, type MessageDetail, type ThreadDetail } from "@terno/core";
import { describe, expect, it } from "vitest";
import { replyFields } from "./compose-fields";

const me = { name: "Me", email: "me@example.test" };
const alias = { name: "Support", email: "support@example.test" };
const client = { name: "Client, One", email: "client@example.test" };
const teammate = { name: "Teammate", email: "team@example.test" };
const old = { name: "Old contact", email: "old@example.test" };
const account = { id: 1, email: me.email } as Account;
const message = (id: number, fields: Partial<MessageDetail>): MessageDetail => ({
  id, accountId: 1, threadId: 7, from: me, replyTo: [], to: [client], cc: [],
  subject: "Re: Same subject", date: id, snippet: "", bodyText: `source-${id}`,
  bodyHtml: null, bodyState: "full", isRead: true, isStarred: false, isSent: true,
  hasAttachments: false, rfcMessageId: `source-${id}@example.test`, references: [], listId: null, attachments: [], ...fields,
});
const thread = (...messages: MessageDetail[]) => ({ thread: { id: 7, accountId: 1, subject: "Re: Same subject" }, messages }) as ThreadDetail;

const own = thread(
  message(10, { from: alias, to: [old] }),
  message(11, { from: alias, isSent: false, to: [me, client, { ...client, email: "CLIENT@EXAMPLE.TEST" }], cc: [alias, client, teammate], replyTo: [old] }),
);
const received = thread(
  message(20, { from: alias }),
  message(21, { from: old, isSent: false, to: [me] }),
  message(22, { from: client, isSent: false, to: [alias, me, teammate] }),
  message(23, { from: alias, isSent: false, to: [old] }),
);

describe.each(["reply", "replyAll"] as const)("%s own-message identity", (mode) => {
  it("continues the latest own copy's To, ignoring its Reply-To and earlier recipients", () => {
    const draft = replyFields(mode, own, account);
    const cc = mode === "replyAll" ? [teammate] : [];
    expect(parseAddressList(draft.toText)).toEqual([client]);
    expect(parseAddressList(draft.ccText)).toEqual(cc);
    expect(draft.auto).toEqual({ to: [client.email], cc: cc.map((a) => a.email), bcc: [] });
    expect(draft.accountId).toBe(account.id);
    expect(draft.inReplyToMessageId).toBe(11);
    expect(draft.forwardOfMessageId).toBeNull();
    expect(draft.quotedText).toContain("> source-11");
    expect(draft.quotedText).not.toContain("source-10");
  });

  it("answers the last received non-self message before an unmarked known-alias copy", () => {
    const draft = replyFields(mode, received, account);
    expect(parseAddressList(draft.toText)).toEqual([client]);
    expect(parseAddressList(draft.ccText)).toEqual(mode === "replyAll" ? [teammate] : []);
    expect(draft.inReplyToMessageId).toBe(22);
    expect(draft.quotedText).toContain("> source-22");
    for (const other of [20, 21, 23]) expect(draft.quotedText).not.toContain(`source-${other}`);
  });

  it("does not infer an alias from subject or a received From without a sent witness", () => {
    const draft = replyFields(mode, thread(message(30, { from: alias, isSent: false, to: [me, client] })), account);
    expect(parseAddressList(draft.toText)).toEqual([alias]);
    expect(parseAddressList(draft.ccText)).toEqual(mode === "replyAll" ? [client] : []);
    expect(draft.inReplyToMessageId).toBe(30);
  });

  it.each<[string, Address[], Address]>([
    ["note-to-self", [me], me],
    ["several own destinations", [alias, me], alias],
    ["empty To", [], me],
  ])("keeps the existing fallback for %s", (_, to, expected) => {
    const detail = thread(message(40, { from: alias }), message(41, { to, cc: [me, alias] }));
    const draft = replyFields(mode, detail, account);
    expect(parseAddressList(draft.toText)).toEqual([expected]);
    expect(draft.ccText).toBe("");
    expect(draft.inReplyToMessageId).toBe(41);
    expect(draft.quotedText).toContain("> source-41");
  });
});

it.each([own, received])("forward starts with no automatic destinations and uses the same selected source", (detail) => {
  const draft = replyFields("forward", detail, account);
  const source = detail === own ? 11 : 22;
  expect([draft.toText, draft.ccText, draft.bccText]).toEqual(["", "", ""]);
  expect(draft.auto).toEqual({ to: [], cc: [], bcc: [] });
  expect(draft.inReplyToMessageId).toBeNull();
  expect(draft.forwardOfMessageId).toBe(source);
  expect(draft.quotedText).toContain(`source-${source}`);
});
