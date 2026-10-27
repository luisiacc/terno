import { describe, expect, it } from "vitest";
import { ARRIVAL_WINDOW_MS, badgeText, importance, noticeText, redact, stillNew, summarize, type ArrivalRow } from "./attention";

const NOW = Date.UTC(2026, 9, 26, 12);

function row(o: Partial<ArrivalRow> = {}): ArrivalRow {
  return {
    id: 1,
    threadId: 10,
    accountId: 1,
    date: NOW - 60_000,
    fromName: "Ana Pérez",
    fromEmail: "ana@example.com",
    subject: "Presupuesto",
    snippet: "Te mando el presupuesto final.",
    isRead: false,
    isSent: false,
    isDraft: false,
    inInbox: true,
    isTrash: false,
    isSpam: false,
    listId: null,
    isBulk: false,
    gmailLabels: null,
    own: false,
    written: false,
    yourConversation: false,
    ...o,
  };
}

describe("badgeText", () => {
  it("clears at 0, shows the number up to 9,999, then 9999+", () => {
    expect(badgeText(0)).toBe("");
    expect(badgeText(-3)).toBe("");
    expect(badgeText(Number.NaN)).toBe("");
    expect(badgeText(1)).toBe("1");
    expect(badgeText(9999)).toBe("9999");
    expect(badgeText(10_000)).toBe("9999+");
    expect(badgeText(250_000)).toBe("9999+");
  });
});

describe("stillNew (the arrival filter at the time it's looked at)", () => {
  it("unread, someone else's, in the Inbox and recent: news", () => {
    expect(stillNew(row(), NOW)).toBe(true);
    expect(stillNew(row({ date: NOW - ARRIVAL_WINDOW_MS + 1000 }), NOW)).toBe(true);
  });
  it.each<[string, Partial<ArrivalRow>]>([
    ["older than a day (backfill, old mail moved in)", { date: NOW - ARRIVAL_WINDOW_MS - 1 }],
    ["read on another device before it synced", { isRead: true }],
    ["sent by you", { isSent: true }],
    ["from one of your addresses", { own: true }],
    ["a draft", { isDraft: true }],
    ["archived (a filter, or another device)", { inInbox: false }],
    ["in the trash", { isTrash: true }],
    ["in spam", { isSpam: true }],
  ])("%s: not news", (_name, o) => {
    expect(stillNew(row(o), NOW)).toBe(false);
  });
});

describe("importance", () => {
  it.each<[string, Partial<ArrivalRow>, ReturnType<typeof importance>]>([
    ["someone you have written to", { written: true }, "written"],
    ["a role address you have written to (a shop's support)", { fromEmail: "support@shop.example", written: true }, "written"],
    ["a reply from a person in a conversation you took part in", { yourConversation: true }, "reply"],
    ["a stranger's first mail (a cold sender)", {}, null],
    ["a role address you never wrote to", { fromEmail: "billing@shop.example" }, null],
    ["a no-reply address, even one you wrote to", { fromEmail: "no-reply@bank.example", written: true }, null],
    ["list mail from someone you wrote to", { written: true, listId: "team.example.com" }, null],
    ["bulk mail from someone you wrote to", { written: true, isBulk: true }, null],
    ["a role address replying in your conversation (not a person)", { fromEmail: "notifications@github.com", yourConversation: true }, null],
    ["Gmail Important from a stranger", { gmailLabels: '["INBOX","IMPORTANT","UNREAD"]' }, "gmail"],
    ["Gmail Important, Auto-Submitted security code (bulk headers don't count against it)", { fromEmail: "no-reply@accounts.example", isBulk: true, gmailLabels: '["INBOX","IMPORTANT"]' }, "gmail"],
    ["Gmail Important newsletter (List-Id)", { listId: "news.example.com", gmailLabels: '["INBOX","IMPORTANT"]' }, null],
    ["Gmail Important in Promotions", { gmailLabels: '["INBOX","IMPORTANT","CATEGORY_PROMOTIONS"]' }, null],
    ["Gmail Important in Social", { gmailLabels: '["INBOX","IMPORTANT","CATEGORY_SOCIAL"]' }, null],
    ["a user label that merely contains the word", { gmailLabels: '["INBOX","Label_IMPORTANT_stuff"]' }, null],
    ["spam, even from someone you wrote to", { written: true, isSpam: true }, null],
  ])("%s", (_name, o, want) => {
    expect(importance(row(o))).toBe(want);
  });
});

describe("summarize and noticeText", () => {
  it("one message: its sender, subject and opening words; a click opens it", () => {
    const n = summarize([row()], "n1")!;
    expect(n).toMatchObject({ id: "n1", count: 1, threadId: 10, senders: ["Ana Pérez"], senderCount: 1, subject: "Presupuesto" });
    expect(noticeText(n)).toEqual({ title: "Ana Pérez", subtitle: "Presupuesto", body: "Te mando el presupuesto final." });
  });

  it("several from one sender: how many and the newest subject; a click opens the newest conversation", () => {
    const n = summarize([row({ id: 1, date: NOW - 3000, threadId: 11, subject: "Old" }), row({ id: 2, date: NOW - 1000, threadId: 12, subject: "Newest", fromEmail: "Ana@Example.com" })], "n2")!;
    expect(n).toMatchObject({ count: 2, threadId: 12, senderCount: 1, snippet: "" });
    expect(noticeText(n)).toEqual({ title: "Ana Pérez", subtitle: "2 new messages", body: "Newest" });
  });

  it("several senders: how many, from whom; a click opens the Inbox", () => {
    const rows = [
      row({ id: 1, date: NOW - 1000, fromName: "Ana", fromEmail: "ana@x.test" }),
      row({ id: 2, date: NOW - 2000, fromName: "", fromEmail: "bob@x.test" }),
      row({ id: 3, date: NOW - 3000, fromName: "Carla", fromEmail: "carla@x.test" }),
      row({ id: 4, date: NOW - 4000, fromName: "Dani", fromEmail: "dani@x.test" }),
      row({ id: 5, date: NOW - 5000, fromName: "Ana", fromEmail: "ana@x.test" }),
    ];
    const n = summarize(rows, "n3")!;
    expect(n).toMatchObject({ count: 5, threadId: null, senders: ["Ana", "bob@x.test", "Carla"], senderCount: 4 });
    expect(noticeText(n)).toEqual({ title: "5 new messages", subtitle: "", body: "From Ana, bob@x.test and 2 others" });
    expect(noticeText(summarize(rows.slice(0, 2), "n4")!).body).toBe("From Ana and bob@x.test");
  });

  it("an empty subject reads as (no subject); a long snippet is clipped on one line", () => {
    const n = summarize([row({ subject: "", snippet: `line one\n\n${"x".repeat(400)}` })], "n5")!;
    expect(noticeText(n).subtitle).toBe("(no subject)");
    expect(n.snippet.length).toBeLessThanOrEqual(140);
    expect(n.snippet).not.toContain("\n");
  });

  it("nothing important: no notice", () => {
    expect(summarize([], "n6")).toBeNull();
  });

  it("redacted: no sender, subject or snippet in the payload, and the text says only how many", () => {
    const one = redact(summarize([row()], "n7")!);
    expect(one).toMatchObject({ senders: [], subject: "", snippet: "", count: 1 });
    expect(JSON.stringify(one)).not.toMatch(/Ana|Presupuesto|presupuesto/);
    expect(noticeText(one)).toEqual({ title: "New mail", subtitle: "", body: "" });
    expect(noticeText(redact(summarize([row({ id: 1 }), row({ id: 2 })], "n8")!)).title).toBe("2 new messages");
  });
});
