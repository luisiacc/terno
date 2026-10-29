// @vitest-environment jsdom
import type { ThreadAction, ThreadSummary } from "@terno/core";
import { beforeAll, describe, expect, it, vi } from "vitest";

/** Plan 64: a row a search keeps after an action shows where the stores will put it (db/actions.ts). */
let patched: (t: ThreadSummary, a: ThreadAction) => ThreadSummary;
beforeAll(async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  ({ patched } = await import("./actions"));
});

const row = (o: Partial<ThreadSummary>): ThreadSummary =>
  ({ id: 1, accountId: 1, subject: "", snippet: "", lastDate: 0, fromName: "", fromEmail: "", messageCount: 1, unread: false, starred: false, hasAttachments: false, categoryIds: [], inInbox: true, inSpam: false, inTrash: false, hasSpam: false, ...o }) as ThreadSummary;
const place = (t: ThreadSummary) => ({ inInbox: t.inInbox, inSpam: t.inSpam, inTrash: t.inTrash, hasSpam: t.hasSpam, icon: !t.inSpam && !t.hasSpam && !t.spamHeld });

describe("the optimistic places", () => {
  it("spam on a thread in Trash leaves it in Trash (spam mail now: no icon); trash on spam is Trash, still spam mail", () => {
    expect(place(patched(row({ inInbox: false, inTrash: true }), "spam"))).toEqual({ inInbox: false, inSpam: false, inTrash: true, hasSpam: true, icon: false });
    expect(place(patched(row({ inInbox: false, inSpam: true, hasSpam: true }), "trash"))).toEqual({ inInbox: false, inSpam: false, inTrash: true, hasSpam: true, icon: false });
  });
  it("Not spam on trashed spam keeps it in Trash; Move to Inbox takes it out of both; neither turns an icon on before the backend says so", () => {
    const trashedSpam = row({ inInbox: false, inTrash: true, hasSpam: true });
    expect(place(patched(trashedSpam, "notSpam"))).toEqual({ inInbox: false, inSpam: false, inTrash: true, hasSpam: false, icon: false });
    expect(place(patched(trashedSpam, "moveToInbox"))).toEqual({ inInbox: true, inSpam: false, inTrash: false, hasSpam: false, icon: false });
    expect(place(patched(row({ inInbox: false, inSpam: true, hasSpam: true }), "notSpam"))).toEqual({ inInbox: true, inSpam: false, inTrash: false, hasSpam: false, icon: false });
  });
  it("archive and spam from the Inbox", () => {
    expect(place(patched(row({}), "archive"))).toEqual({ inInbox: false, inSpam: false, inTrash: false, hasSpam: false, icon: true });
    expect(place(patched(row({}), "spam"))).toEqual({ inInbox: false, inSpam: true, inTrash: false, hasSpam: true, icon: false });
  });
});
