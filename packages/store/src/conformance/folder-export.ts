import { ATTACHMENT_CHUNK } from "@terno/core";
import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import type { FolderExportCursor, FolderExportTarget } from "../types";
import { ingest, msg, withAccounts } from "./fixtures";
import type { StoreHarness } from "./store";

const loc = (mailbox: string, uid: number) => ({ mailbox, uidvalidity: 1, uid, flags: [] as string[] });

/**
 * Plan 107: what an .mbox export reads. A folder holds the messages that carry its key (never trash, spam or a
 * draft); a standard row the account's messages in that place; ids come a stretch of threads at a time, and a
 * message gone between stretches is simply not there. Both stores alike.
 */
export function defineFolderExportConformance(name: string, harness: StoreHarness): void {
  const open: MailStore[] = [];
  const fresh = async () => {
    const s = await harness.open();
    open.push(s);
    return s;
  };
  afterEach(async () => {
    for (const s of open.splice(0)) if (s.isOpen) await s.close();
  });
  /** every id of a place, walking `limit` threads a stretch */
  const walk = async (store: MailStore, target: FolderExportTarget, limit = 1, between?: (stretch: number) => Promise<void>) => {
    const out: { id: number; date: number }[] = [];
    let stretches = 0;
    for (let after: FolderExportCursor | null = null; ;) {
      const r = await store.folderExport.ids(target, after, limit);
      // the limit bounds what a stretch looks at, so it never returns more messages than that
      expect(r.messages.length).toBeLessThanOrEqual(limit);
      out.push(...r.messages);
      stretches++;
      if (r.next === null) return { ids: out.map((m) => m.id).sort((a, b) => a - b), dates: out, stretches };
      after = r.next;
      await between?.(stretches);
    }
  };
  const idsOf = async (store: MailStore, providerIds: string[]) => {
    const all = (await store.debug.snapshot()).messages;
    return providerIds.map((p) => all.find((m) => m.providerMsgId === p)!.id).sort((a, b) => a - b);
  };

  describe(`folder export (plan 107): ${name}`, () => {
    it("a Gmail folder is its label's messages, never trash, spam, drafts or another account's", async () => {
      const store = await fresh();
      const [g, other] = await withAccounts(store);
      await ingest(store, [
        msg({ accountId: g!, providerMsgId: "g1", providerThreadId: "t1", gmailLabels: ["INBOX", "Label_7"] }),
        msg({ accountId: g!, providerMsgId: "g2", providerThreadId: "t1", gmailLabels: ["SENT"], isSent: true, inInbox: false }),
        msg({ accountId: g!, providerMsgId: "g3", providerThreadId: "t2", gmailLabels: ["Label_7"], inInbox: false }),
        msg({ accountId: g!, providerMsgId: "g4", providerThreadId: "t3", gmailLabels: ["Label_7", "TRASH"], isTrash: true, inInbox: false }),
        msg({ accountId: g!, providerMsgId: "g5", providerThreadId: "t2", gmailLabels: ["Label_7", "SPAM"], isSpam: true, inInbox: false }),
        msg({ accountId: g!, providerMsgId: "g6", providerThreadId: "t2", gmailLabels: ["Label_7", "DRAFT"], isDraft: true, inInbox: false }),
        msg({ accountId: g!, providerMsgId: "g7", providerThreadId: "t4", gmailLabels: ["Label_70"] }),
        msg({ accountId: other!, providerMsgId: "o1", gmailLabels: ["Label_7"], locations: [loc("Label_7", 1)] }),
      ]);
      expect((await walk(store, { accountId: g!, folder: "Label_7" })).ids).toEqual(await idsOf(store, ["g1", "g3"]));
      expect((await walk(store, { accountId: g!, folder: "Label_7" }, 50)).ids).toEqual(await idsOf(store, ["g1", "g3"]));
    });

    it("an IMAP folder is its mailbox's messages", async () => {
      const store = await fresh();
      const [, imap] = await withAccounts(store);
      await store.folders.replace(imap!, [{ key: "Work", path: ["Work"], selectable: true }, { key: "Work/Old", path: ["Work", "Old"], selectable: true }]);
      await ingest(store, [
        msg({ accountId: imap!, providerMsgId: "i1", locations: [loc("Work", 1)] }),
        msg({ accountId: imap!, providerMsgId: "i2", locations: [loc("INBOX", 1), loc("Work", 2)] }),
        msg({ accountId: imap!, providerMsgId: "i3", locations: [loc("Work/Old", 1)] }),
        msg({ accountId: imap!, providerMsgId: "i4", locations: [loc("INBOX", 2)] }),
      ]);
      expect((await walk(store, { accountId: imap!, folder: "Work" })).ids).toEqual(await idsOf(store, ["i1", "i2"]));
      expect((await walk(store, { accountId: imap!, folder: "Nope" })).ids).toEqual([]);
    });

    it("an IMAP folder renamed here before a pass has its mail still under the old path: the alias names it (Codex code review round 5 #2)", async () => {
      const store = await fresh();
      const [, imap] = await withAccounts(store);
      await store.folders.replace(imap!, [{ key: "Work", path: ["Work"], selectable: true }]);
      await ingest(store, [
        msg({ accountId: imap!, providerMsgId: "i1", locations: [loc("Work", 1)] }),
        msg({ accountId: imap!, providerMsgId: "i2", locations: [loc("INBOX", 1), loc("Work", 2)] }),
        msg({ accountId: imap!, providerMsgId: "i3", locations: [loc("INBOX", 2)] }),
      ]);
      // the rename: listed under its new key, its threads carried, its locations where they were
      await store.folders.replace(imap!, [{ key: "Job", path: ["Job"], selectable: true }]);
      for (let after: number | null = 0; after !== null; ) after = (await store.folders.carry(imap!, "Work", "Job", after, 1)).next;
      expect((await walk(store, { accountId: imap!, folder: "Job" })).ids).toEqual([]);
      for (const limit of [1, 50]) expect((await walk(store, { accountId: imap!, folder: "Job", aliases: [{ mailbox: "Work", uidvalidity: 1 }] }, limit)).ids).toEqual(await idsOf(store, ["i1", "i2"]));
    });

    it("a path made again after a rename here: the alias takes its old UIDVALIDITY's mail, the new folder the rest (Codex code review round 6 #2)", async () => {
      const store = await fresh();
      const [, imap] = await withAccounts(store);
      await store.folders.replace(imap!, [{ key: "Work", path: ["Work"], selectable: true }]);
      await ingest(store, [
        msg({ accountId: imap!, providerMsgId: "old", locations: [loc("Work", 1)] }),
        msg({ accountId: imap!, providerMsgId: "new", locations: [{ ...loc("Work", 1), uidvalidity: 2 }] }),
      ]);
      await store.folders.replace(imap!, [{ key: "Job", path: ["Job"], selectable: true }, { key: "Work", path: ["Work"], selectable: true }]);
      for (let after: number | null = 0; after !== null; ) after = (await store.folders.carry(imap!, "Work", "Job", after, 1)).next;
      for (const limit of [1, 50]) {
        expect((await walk(store, { accountId: imap!, folder: "Job", aliases: [{ mailbox: "Work", uidvalidity: 1 }] }, limit)).ids).toEqual(await idsOf(store, ["old"]));
        expect((await walk(store, { accountId: imap!, folder: "Work", except: [1] }, limit)).ids).toEqual(await idsOf(store, ["new"]));
      }
    });

    it("a standard row is the account's messages in that place", async () => {
      const store = await fresh();
      const [a, b] = await withAccounts(store);
      await ingest(store, [
        msg({ accountId: a!, providerMsgId: "in", providerThreadId: "x" }),
        msg({ accountId: a!, providerMsgId: "sent", providerThreadId: "x", isSent: true, inInbox: false }),
        msg({ accountId: a!, providerMsgId: "arch", providerThreadId: "y", inInbox: false }),
        msg({ accountId: a!, providerMsgId: "spam", providerThreadId: "z", isSpam: true, inInbox: false }),
        msg({ accountId: a!, providerMsgId: "trash", providerThreadId: "w", isTrash: true, inInbox: false }),
        msg({ accountId: a!, providerMsgId: "draft", providerThreadId: "y", isDraft: true, inInbox: false }),
        msg({ accountId: b!, providerMsgId: "b-in" }),
      ]);
      const view = (v: "inbox" | "sent" | "archive" | "spam" | "trash") => walk(store, { accountId: a!, view: v }).then((r) => r.ids);
      expect(await view("inbox")).toEqual(await idsOf(store, ["in"]));
      expect(await view("sent")).toEqual(await idsOf(store, ["sent"]));
      expect(await view("archive")).toEqual(await idsOf(store, ["sent", "arch"]));
      expect(await view("spam")).toEqual(await idsOf(store, ["spam"]));
      expect(await view("trash")).toEqual(await idsOf(store, ["trash"]));
    });

    it("walks a stretch of threads at a time; equal dates are all there, and a deletion between stretches is skipped", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store, 1);
      const date = Date.UTC(2026, 0, 1);
      await ingest(store, Array.from({ length: 6 }, (_, i) => msg({ accountId: a!, providerMsgId: `e${i}`, providerThreadId: `t${i}`, date })));
      const all = await idsOf(store, Array.from({ length: 6 }, (_, i) => `e${i}`));
      const whole = await walk(store, { accountId: a!, view: "inbox" }, 2);
      expect(whole.ids).toEqual(all);
      expect(whole.dates.every((m) => m.date === date)).toBe(true);
      const [gone] = await idsOf(store, ["e5"]);
      const cut = await walk(store, { accountId: a!, view: "inbox" }, 2, async (stretch) => {
        if (stretch === 1) await store.sync.remove([gone!]);
      });
      expect(cut.ids).toEqual(all.filter((id) => id !== gone));
      expect(cut.stretches).toBe(3);
      // a batch read leaves out what's gone and keeps the order asked
      expect((await store.folderExport.messages([all[2]!, gone!, all[0]!])).map((m) => m.id)).toEqual([all[2], all[0]]);
    });

    it("a long conversation is read a stretch of its messages at a time, each once, a deletion between stretches skipped (Codex code review round 2 #6)", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store, 1);
      const day = Date.UTC(2026, 0, 1);
      // one thread of 9 (equal dates among them, one archived so the inbox skips it) between two short ones
      await ingest(store, [
        msg({ accountId: a!, providerMsgId: "before", providerThreadId: "x", date: day }),
        ...Array.from({ length: 9 }, (_, i) => msg({ accountId: a!, providerMsgId: `c${i}`, providerThreadId: "long", subject: "Hilo", date: day + Math.floor(i / 3) * 1000, inInbox: i !== 4 })),
        msg({ accountId: a!, providerMsgId: "after", providerThreadId: "z", date: day }),
      ]);
      const inbox = await idsOf(store, ["before", "after", ...Array.from({ length: 9 }, (_, i) => `c${i}`).filter((p) => p !== "c4")]);
      for (const limit of [1, 2, 4]) {
        const r = await walk(store, { accountId: a!, view: "inbox" }, limit);
        expect(r.ids).toEqual(inbox);
        expect(r.dates).toHaveLength(inbox.length);
        // the 9 never came in one stretch
        expect(r.stretches).toBeGreaterThanOrEqual(Math.ceil(9 / limit));
      }
      const archive = await walk(store, { accountId: a!, view: "archive" }, 2);
      expect(archive.ids).toEqual(await idsOf(store, ["c4"]));
      const [gone] = await idsOf(store, ["c7"]);
      const cut = await walk(store, { accountId: a!, view: "inbox" }, 3, async (stretch) => {
        if (stretch === 1) await store.sync.remove([gone!]);
      });
      expect(cut.ids).toEqual(inbox.filter((id) => id !== gone));
    });

    it("reads a batch: stored headers, bodies, and which attachments' bytes are here", async () => {
      const store = await fresh();
      const [a] = await withAccounts(store, 1);
      const bytes = new Uint8Array(ATTACHMENT_CHUNK + 3).map((_, i) => i % 256);
      await ingest(store, [
        msg({
          accountId: a!,
          providerMsgId: "full",
          rfcMessageId: "full@x",
          inReplyTo: "parent@x",
          references: ["root@x", "parent@x"],
          replyTo: [{ name: "Lista", email: "list@x.com" }],
          cc: [{ name: "", email: "cc@x.com" }],
          listId: "team.x.com",
          subject: "Reunión",
          bodyText: "hola",
          bodyHtml: "<p>hola</p>",
          hasAttachments: true,
          attachments: [
            { filename: "data.bin", mime: "application/octet-stream", size: bytes.length, bytes },
            { filename: "later.pdf", mime: "application/pdf", size: 900, providerRef: "r1" },
          ],
        }),
        msg({ accountId: a!, providerMsgId: "partial", bodyText: "beginning", bodyState: "partial" }),
      ]);
      const [full, partial] = await idsOf(store, ["full", "partial"]);
      const [m, p] = await store.folderExport.messages([full!, partial!]);
      expect(m).toMatchObject({
        id: full,
        accountId: a,
        rfcMessageId: "full@x",
        inReplyTo: "parent@x",
        // as the store keeps them
        references: expect.arrayContaining(["root@x", "parent@x"]),
        from: { name: "Ana Pérez", email: "ana@example.com" },
        to: [{ name: "Me", email: "me@example.com" }],
        cc: [{ name: "", email: "cc@x.com" }],
        replyTo: [{ name: "Lista", email: "list@x.com" }],
        subject: "Reunión",
        listId: "team.x.com",
        bodyText: "hola",
        bodyHtml: "<p>hola</p>",
        bodyState: "full",
      });
      expect(m!.attachments).toEqual([
        { filename: "data.bin", mime: "application/octet-stream", size: bytes.length, contentId: null, assetId: expect.any(String) },
        { filename: "later.pdf", mime: "application/pdf", size: 900, contentId: null, assetId: null },
      ]);
      // the bytes, a stored chunk at a time
      const chunks = await Promise.all([0, 1].map((i) => store.attachments.read(a!, m!.attachments[0]!.assetId!, i)));
      expect(chunks.map((c) => Uint8Array.from(atob(c!), (x) => x.charCodeAt(0)).length)).toEqual([ATTACHMENT_CHUNK, 3]);
      expect(p).toMatchObject({ bodyText: "beginning", bodyState: "partial", attachments: [] });
    });
  });
}
