import { demoFolderChange } from "./folder-changes";
import type { MailProvider, ProviderContext, ProviderRegistry } from "./types";

/**
 * Provider for demo/mock accounts: ops succeed after a short, realistic delay
 * and nothing leaves the machine. Used by the seeded demo and visual tests.
 */
export function createDemoProvider(ctx: ProviderContext, latencyMs = 40): MailProvider {
  const wait = () => new Promise((r) => setTimeout(r, latencyMs));
  // plan 107: folders change in the list the backend keeps (Gmail-like accounts by label id, the rest by path)
  const gmail = ctx.account.kind === "gmail";
  const locations = ctx.store.locations;
  /** a mailbox's places, a page at a time (the seed's generation: `DEMO_UIDVALIDITY`) */
  const placesOf = async (mailbox: string) => {
    if (!locations.inMailboxPage) return locations.inMailbox(mailbox, DEMO_UIDVALIDITY);
    const all: { message_id: number; uid: number; flags: string }[] = [];
    for (let after = 0; ; ) {
      const page = await locations.inMailboxPage(mailbox, DEMO_UIDVALIDITY, after, 2000);
      all.push(...page);
      if (page.length < 2000) return all;
      after = page.at(-1)!.uid;
      await ctx.yield?.();
    }
  };
  /**
   * A rename's old places, and a deleted folder's, go once the backend has stored the new list (Codex code review
   * round 19 #3): before, while the old path is still listed, taking them would drop the threads the backend is about
   * to carry. Kept in the cursor until done, so a sync or the next change finishes one a crash cut short: a path made
   * again shows none of it.
   */
  const forgetPlaces = async () => {
    const cursor = await ctx.loadCursor<DemoCursor>();
    for (const from of cursor?.forget ?? []) for (const l of await placesOf(from)) await locations.remove(l.message_id, from);
    if (cursor?.forget?.length) await ctx.saveCursor({ ...cursor, forget: [] });
  };
  return {
    async verify() {},
    async sync(sink) {
      await forgetPlaces();
      sink.setSyncState({ status: "idle", lastSyncAt: Date.now(), lastError: null });
    },
    async execute(op) {
      await wait();
      if (op.kind === "send") return { providerMsgId: `demo-sent-${op.id}` };
    },
    async createFolder({ parent, name, folders }) {
      await wait();
      await forgetPlaces();
      const cursor = gmail ? await ctx.loadCursor<DemoCursor>() : null;
      const r = demoFolderChange(folders, gmail, { create: { parent, name } }, cursor?.lastLabel);
      // the id given is kept before it's answered: a label deleted later never hands it out again (round 19 #4)
      if (gmail) await ctx.saveCursor({ ...cursor, lastLabel: Number(/^Label_(\d+)$/.exec(r.key!)?.[1] ?? cursor?.lastLabel ?? 0) });
      return { folders: r.folders, key: r.key! };
    },
    async renameFolder({ key, name, folders }) {
      await wait();
      await forgetPlaces();
      const r = demoFolderChange(folders, gmail, { rename: { key, name } });
      // an IMAP-like folder's mail moves with it, as a server's RENAME moves it: each place is under the new path too
      // (still unlisted: no membership changes until the backend carries the threads and stores the list), the old
      // ones go once it has (`renamesFollowed`). Codex code review round 19 #3: the mail stayed under the old path,
      // so the new one counted and exported nothing, and a thread's refresh took it out
      const moves = gmail ? [] : r.renamed!.filter((m) => m.from !== m.to);
      if (moves.length) {
        const cursor = (await ctx.loadCursor<DemoCursor>()) ?? {};
        await ctx.saveCursor({ ...cursor, forget: [...new Set([...(cursor.forget ?? []), ...moves.map((m) => m.from)])] });
        for (const m of moves) for (const l of await placesOf(m.from)) await locations.upsert(l.message_id, m.to, DEMO_UIDVALIDITY, l.uid, parseFlags(l.flags));
      }
      return { folders: r.folders, renamed: r.renamed! };
    },
    async renamesFollowed() {
      await forgetPlaces();
    },
    async deleteFolder({ key, folders }) {
      await wait();
      await forgetPlaces();
      const r = demoFolderChange(folders, gmail, { delete: { key } });
      // an IMAP-like folder's places go with it (its messages stay, as the demo keeps them): one made again under its
      // path is another folder
      if (!gmail && r.deleted!.length) {
        const cursor = (await ctx.loadCursor<DemoCursor>()) ?? {};
        await ctx.saveCursor({ ...cursor, forget: [...new Set([...(cursor.forget ?? []), ...r.deleted!])] });
      }
      return { folders: r.folders, deleted: r.deleted! };
    },
    async deletionsFollowed() {
      await forgetPlaces();
    },
    async close() {},
  };
}

/** the generation the demo's seeded places have (mock-data's `locations`) */
const DEMO_UIDVALIDITY = 1;

/** plan 107: paths whose places a rename moved or a delete took, to forget once the backend stored the new list */
type DemoCursor = { forget?: string[]; lastLabel?: number };

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
