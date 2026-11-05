import { demoFolderChange } from "./folder-changes";
import { isFolderOp, MOVE_TO_FOLDER, type LeaveFolderPayload, type MoveToFolderPayload, type ProviderFolder } from "@terno/store";
import type { IncomingMessage } from "@terno/store";
import type { MailProvider, ProviderContext, ProviderQuery, ProviderRegistry, SyncSink } from "./types";

/** Plan 141: mail older than the demo's window, for "Search older mail" to find. */
const OLDER_MAIL = [
  { id: "demo-older-lease", date: Date.UTC(2023, 2, 1, 10), from: { name: "Greenway Rentals", email: "office@greenway.example.test" }, subject: "Your lease renewal", text: "Your lease renews on 1 March 2027, with 60 days' notice to leave." },
  { id: "demo-older-warranty", date: Date.UTC(2022, 5, 14, 9), from: { name: "Northwind Appliances", email: "care@northwind.example.test" }, subject: "Warranty for your dishwasher", text: "Your dishwasher warranty runs for five years from the day it was delivered." },
];

function olderMatches(m: (typeof OLDER_MAIL)[number], q: ProviderQuery): boolean {
  const text = `${m.subject} ${m.text} ${m.from.name}`.toLowerCase();
  const has = (word: string) => text.includes(word.toLowerCase());
  return q.terms.every(has) && (q.anyOf ?? []).every((group) => group.some(has)) && (q.terms.length > 0 || (q.anyOf?.length ?? 0) > 0);
}

function olderIncoming(account: { id: number; email: string; displayName?: string }, m: (typeof OLDER_MAIL)[number]): IncomingMessage {
  return {
    accountId: account.id,
    providerMsgId: m.id,
    providerThreadId: m.id,
    rfcMessageId: `${m.id}@demo.example.test`,
    inReplyTo: null,
    references: [],
    from: m.from,
    to: [{ name: account.displayName ?? "", email: account.email }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: m.subject,
    date: m.date,
    snippet: m.text.slice(0, 120),
    bodyText: m.text,
    bodyHtml: null,
    bodyState: "full",
    listId: null,
    bulk: false,
    unsubscribe: null,
    isRead: true,
    isStarred: false,
    inInbox: false,
    isSent: false,
    isDraft: false,
    isTrash: false,
    isSpam: false,
    hasAttachments: false,
    size: m.text.length,
    locations: [],
  } as unknown as IncomingMessage;
}

/**
 * Provider for demo/mock accounts: ops succeed after a short, realistic delay
 * and nothing leaves the machine. Used by the seeded demo and visual tests.
 */
export function createDemoProvider(ctx: ProviderContext, latencyMs = 40): MailProvider {
  const wait = () => new Promise((r) => setTimeout(r, latencyMs));
  // plan 107: folders change in the list the backend keeps (Gmail-like accounts by label id, the rest by path)
  const gmail = ctx.account.kind === "gmail";
  const locations = ctx.store.locations;
  const load = async () => (await ctx.loadCursor<DemoCursor>()) ?? {};
  /** a real turn of the event loop, so a big folder's places never hold the backend past the slicer's budget */
  const turn = () => ctx.yield?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 0));
  /** a mailbox's places (the seed's generation: `DEMO_UIDVALIDITY`) above `after`, a page at a time by UID */
  async function* pages(mailbox: string, after = 0) {
    if (!locations.inMailboxPage) {
      // a store in memory reads it whole quickly
      const all = (await locations.inMailbox(mailbox, DEMO_UIDVALIDITY)).filter((l) => l.uid > after).sort((a, b) => a.uid - b.uid);
      for (let i = 0; i < all.length; i += PAGE) yield all.slice(i, i + PAGE);
      return;
    }
    for (;;) {
      const page = await locations.inMailboxPage(mailbox, DEMO_UIDVALIDITY, after, PAGE);
      if (page.length) yield page;
      if (page.length < PAGE) return;
      after = page.at(-1)!.uid;
    }
  }
  /**
   * A change's places copied under the new paths, a page a write with a turn between (Codex code review round 20 #5:
   * the whole folder went in one stretch), its progress kept with each page, so a copy cut short goes on where it
   * stopped. The new paths aren't listed yet: nothing changes membership.
   */
  const copy = async (change: DemoChange) => {
    for (const m of change.moves) {
      if (m.copied) continue;
      for await (const page of pages(m.from, m.after)) {
        await locations.upsertMany(m.to, DEMO_UIDVALIDITY, page.map((l) => ({ messageId: l.message_id, uid: l.uid, flags: parseFlags(l.flags) })));
        m.after = page.at(-1)!.uid;
        await ctx.saveCursor({ ...(await load()), change });
        await turn();
      }
      m.copied = true;
      await ctx.saveCursor({ ...(await load()), change });
    }
  };
  /** the change is done (or given up): these paths' places go */
  const conclude = async (forget: readonly string[]) => {
    const cursor = await load();
    await ctx.saveCursor({ lastLabel: cursor.lastLabel, forget: [...new Set([...(cursor.forget ?? []), ...forget])] });
  };
  /**
   * Places nothing listed has any more: a renamed folder's old ones (every one copied), a deleted folder's, a given-up
   * rename's copies. Removed a page at a time with a turn between, and with no identity held (Codex code review round
   * 20 #2: held, the next rename's copy skipped them and Work → Job → Other kept nothing); a path is let go once it has none.
   */
  const retire = async () => {
    for (let path = (await load()).forget?.[0]; path !== undefined; path = (await load()).forget?.[0]) {
      for await (const page of pages(path)) {
        await locations.removeMany(page.map((l) => l.message_id), path, { deleted: true });
        await turn();
      }
      const cursor = await load();
      await ctx.saveCursor({ ...cursor, forget: (cursor.forget ?? []).filter((p) => p !== path) });
    }
  };
  /**
   * A change in flight is ended before anything else (Codex code review round 20 #3: the old paths were let go before
   * the backend stored the list that moved them, so a rename cut short lost the old folder's mail). `folders`: the list
   * the backend has, which says how far it got: shown, only the acknowledgement was lost; not shown, it never stored it
   * and the change is given up (the old paths untouched, the copies go). A sync instead takes it to its end, as a
   * server's rename would be: the copy finished, then the list handed with its moves, which the backend follows.
   */
  const settle = async (folders?: readonly ProviderFolder[], sink?: SyncSink) => {
    const change = (await load()).change;
    if (change && folders) {
      const listed = new Set(folders.map((f) => f.key));
      const shown = change.moves.every((m) => listed.has(m.to) && !listed.has(m.from)) && change.deleted.every((p) => !listed.has(p));
      await conclude(shown ? followed(change) : change.moves.map((m) => m.to).filter((p) => !listed.has(p)));
    } else if (change && sink?.setFolders) {
      await copy(change);
      await sink.setFolders(change.folders, change.moves.map(({ from, to }) => ({ from, to })), change.deleted);
      await conclude(followed(change));
    }
    await retire();
  };
  /** the backend stored the change's list and followed it */
  const acknowledged = async () => {
    const change = (await load()).change;
    if (change) await conclude(followed(change));
    await retire();
  };
  return {
    // plan 141: what a server would find further back: a few fixed messages from before anything here, nothing stored
    async search({ queries, before }) {
      await wait();
      const held = OLDER_MAIL.filter((m) => m.date < before && queries.some((q) => olderMatches(m, q)));
      const stored = await Promise.all(held.map((m) => ctx.store.messageByProviderId(m.id)));
      return { hits: held.filter((_, i) => !stored[i]).map((m) => ({ id: m.id, date: m.date })), partial: false };
    },
    async fetchHits(hits, sink) {
      await wait();
      const wanted = new Set(hits.map((h) => h.id));
      await sink.ingest(OLDER_MAIL.filter((m) => wanted.has(m.id)).map((m) => olderIncoming(ctx.account, m)), { live: false });
    },
    async verify() {},
    async sync(sink) {
      await settle(undefined, sink);
      sink.setSyncState({ status: "idle", lastSyncAt: Date.now(), lastError: null });
    },
    async execute(op) {
      await wait();
      if (op.kind === "send") return { providerMsgId: `demo-sent-${op.id}` };
      // plan 127: the places a server's answer would write (a Gmail-like account's labels change when the op settles)
      if (gmail || !isFolderOp(op.kind)) return;
      const ids = op.target.messageIds ?? [];
      const put = (mailbox: string) => locations.upsertMany(mailbox, DEMO_UIDVALIDITY, ids.map((messageId) => ({ messageId, uid: DEMO_MOVED_UID + messageId, flags: [] })));
      if (op.kind === MOVE_TO_FOLDER) {
        const { folder, from } = op.payload as MoveToFolderPayload;
        await put(folder);
        if (from !== null) await locations.removeMany(ids, from, { deleted: true });
      } else {
        const { folder, back, stays } = op.payload as LeaveFolderPayload;
        if (back !== null) await put(back);
        if (!stays) await locations.removeMany(ids, folder, { deleted: true });
      }
    },
    async createFolder({ parent, name, folders }) {
      await wait();
      await settle(folders);
      const cursor = gmail ? await ctx.loadCursor<DemoCursor>() : null;
      const r = demoFolderChange(folders, gmail, { create: { parent, name } }, cursor?.lastLabel);
      // the id given is kept before it's answered: a label deleted later never hands it out again (round 19 #4)
      if (gmail) await ctx.saveCursor({ ...cursor, lastLabel: Number(/^Label_(\d+)$/.exec(r.key!)?.[1] ?? cursor?.lastLabel ?? 0) });
      return { folders: r.folders, key: r.key! };
    },
    async renameFolder({ key, name, folders }) {
      await wait();
      await settle(folders);
      const r = demoFolderChange(folders, gmail, { rename: { key, name } });
      // an IMAP-like folder's mail moves with it, as a server's RENAME moves it (Codex code review round 19 #3): each
      // place is copied under the new path before the answer (still unlisted: no membership changes until the backend
      // carries the threads and stores the list), and the old ones go once it has (`renamesFollowed`). The change is
      // kept in the cursor first, so one cut short is ended by the next sync or change (round 20 #3)
      const moves = gmail ? [] : r.renamed!.filter((m) => m.from !== m.to);
      if (moves.length) {
        const change: DemoChange = { folders: r.folders, moves: moves.map((m) => ({ from: m.from, to: m.to, after: 0 })), deleted: [] };
        await ctx.saveCursor({ ...(await load()), change });
        await copy(change);
      }
      return { folders: r.folders, renamed: r.renamed! };
    },
    async renamesFollowed() {
      await acknowledged();
    },
    async deleteFolder({ key, folders }) {
      await wait();
      await settle(folders);
      const r = demoFolderChange(folders, gmail, { delete: { key } });
      // an IMAP-like folder's places go with it once the backend stored the list without it (its messages stay, as
      // the demo keeps them): one made again under its path is another folder
      if (!gmail && r.deleted!.length) await ctx.saveCursor({ ...(await load()), change: { folders: r.folders, moves: [], deleted: r.deleted! } satisfies DemoChange });
      return { folders: r.folders, deleted: r.deleted! };
    },
    async deletionsFollowed() {
      await acknowledged();
    },
    async close() {},
  };
}

/** the generation the demo's seeded places have (mock-data's `locations`) */
const DEMO_UIDVALIDITY = 1;
/** plan 127: a moved message's UID in its new place: above anything the seed uses */
const DEMO_MOVED_UID = 1_000_000;

/** places copied or removed a page at a time, a write each and a turn between (a few milliseconds of SQLite) */
const PAGE = 200;

/**
 * plan 107: an IMAP-like rename or delete given to the backend and not yet followed (Codex code review round 20 #3):
 * the list it makes, each move's copy (the last UID copied, and whether all were), the paths deleted
 */
type DemoChange = { folders: ProviderFolder[]; moves: { from: string; to: string; after: number; copied?: true }[]; deleted: string[] };

/** `forget`: paths whose places go (a followed change's old ones, a given-up rename's new ones) */
type DemoCursor = { change?: DemoChange; forget?: string[]; lastLabel?: number };

/** what a followed change lets go: the old paths of its moves, the paths it deleted */
const followed = (change: DemoChange): string[] => [...change.moves.map((m) => m.from), ...change.deleted];

const parseFlags = (flags: string): string[] => {
  try {
    const v: unknown = JSON.parse(flags);
    return Array.isArray(v) ? v.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
};

export const demoRegistry: ProviderRegistry = {
  kind: "demo",
  create: (ctx) => createDemoProvider(ctx),
  async verifyImap() {},
  async connectGmail() {
    throw new Error("Gmail is not available in demo mode");
  },
};
