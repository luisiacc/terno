import { describe, expect, it } from "vitest";
import { removable, STORAGE_AGES, storageBucket, storageCutoff, StorageTally, type StorageThreadRow } from "./storage";

const NOW = Date.UTC(2026, 9, 29);
const DAY = 86_400_000;
const row = (over: Partial<StorageThreadRow>): StorageThreadRow => ({ id: 1, accountId: 1, bucket: "archive", lastDate: NOW - 1000 * DAY, kept: false, messages: 1, bytes: 10, ...over });

describe("storage (plan 69)", () => {
  it("puts a conversation in the first view that holds it: trash, spam, inbox, sent, archive", () => {
    const f = { inInbox: true, inTrash: true, inSpam: true, hasSent: true };
    expect(storageBucket(f)).toBe("trash");
    expect(storageBucket({ ...f, inTrash: false })).toBe("spam");
    expect(storageBucket({ ...f, inTrash: false, inSpam: false })).toBe("inbox");
    expect(storageBucket({ ...f, inTrash: false, inSpam: false, inInbox: false })).toBe("sent");
    expect(storageBucket({ inInbox: false, inTrash: false, inSpam: false, hasSent: false })).toBe("archive");
  });

  it("removes only unkept conversations of a chosen view whose newest message is older than the cutoff; never Sent", () => {
    const cutoff = storageCutoff(NOW, 365);
    expect(removable(row({}), ["archive"], cutoff)).toBe(true);
    expect(removable(row({ kept: true }), ["archive"], cutoff)).toBe(false);
    expect(removable(row({}), ["spam"], cutoff)).toBe(false);
    expect(removable(row({ lastDate: cutoff }), ["archive"], cutoff)).toBe(false);
    expect(removable(row({ bucket: "sent" }), ["sent", "archive"], cutoff)).toBe(false);
  });

  it("tallies every view, and what each age would remove, cumulatively", () => {
    const tally = new StorageTally(NOW);
    tally.add([
      row({ bucket: "spam", lastDate: NOW - 40 * DAY, messages: 2, bytes: 100 }),
      row({ bucket: "spam", lastDate: NOW - 800 * DAY, messages: 1, bytes: 50 }),
      row({ bucket: "spam", lastDate: NOW - 800 * DAY, kept: true, bytes: 7 }),
      row({ bucket: "sent", lastDate: NOW - 800 * DAY, bytes: 9 }),
    ]);
    tally.add([row({ bucket: "inbox", lastDate: NOW - DAY })]);
    const by = Object.fromEntries(tally.result().map((b) => [b.bucket, b]));
    expect(Object.keys(by)).toEqual(["inbox", "archive", "sent", "spam", "trash"]);
    expect(by.spam).toMatchObject({ threads: 3, messages: 4, bytes: 157 });
    expect(STORAGE_AGES).toEqual([30, 90, 180, 365, 730]);
    expect(by.spam!.removable.map((a) => a.threads)).toEqual([2, 1, 1, 1, 1]);
    expect(by.spam!.removable[0]).toEqual({ threads: 2, messages: 3, bytes: 150 });
    expect(by.sent).toMatchObject({ threads: 1, bytes: 9 });
    expect(by.sent!.removable.every((a) => a.threads === 0)).toBe(true);
    expect(by.inbox!.removable.every((a) => a.threads === 0)).toBe(true);
    expect(by.trash).toMatchObject({ threads: 0, bytes: 0 });
  });
});
