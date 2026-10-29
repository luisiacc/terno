import type { FlagSnapshotRequest, FlagSnapshotPage, ImapLocation, ImapLocationStore, ProviderStore } from "@terno/store";
import { getSetting, T, type Ctx, type R } from "./mail";
import { isFolder } from "./folders";

type Command = <V>(fn: () => V) => Promise<V>;

/** One account's provider-side reads and IMAP identity (the SQL adapter's SqlProviderStore, on the in-memory tables). */
/** each twins bucket's ids by envelope, ascending, as of its revision (a page seeks into it) */
const twinOrders = new WeakMap<ReadonlySet<unknown>, { revision: number; byEnvelope: Map<string, number[]> }>();
/** per database, each twins bucket's revision: a row in it written, put in or taken out moves it on */
const twinRevisions = new WeakMap<object, Map<string, number>>();
const twinBucketKey = (accountId: unknown, rfc: unknown, envelope: string) => (rfc ? `id\u0000${accountId}\u0000${rfc}` : `nomid\u0000${accountId}\u0000${envelope}`);
function twinRevision(db: { onRow(fn: (table: string, row: Record<string, unknown> | undefined, prev: Record<string, unknown> | undefined) => void): void }, key: string): number {
  let revisions = twinRevisions.get(db);
  if (!revisions) {
    const map = new Map<string, number>();
    twinRevisions.set(db, (revisions = map));
    db.onRow((table, row, prev) => {
      if (table !== "messages") return;
      for (const r of [row, prev]) {
        if (!r) continue;
        const key = twinBucketKey(r.account_id, r.rfc_message_id || null, `${r.from_email}\u0000${r.date}\u0000${r.size}\u0000${r.subject}`);
        map.set(key, (map.get(key) ?? 0) + 1);
      }
    });
  }
  return revisions.get(key) ?? 0;
}

export class IdbProviderStore implements ProviderStore {
  readonly locations: ImapLocationStore;

  constructor(
    private readonly c: Ctx,
    private readonly accountId: number,
    command: Command,
    private readonly read: Command,
    private readonly flagSnapshots: (request: FlagSnapshotRequest) => Promise<FlagSnapshotPage>,
  ) {
    this.locations = new IdbImapLocations(c, accountId, command, read);
  }

  pendingFlagSnapshots(request: FlagSnapshotRequest) { return this.flagSnapshots(request); }

  messageByProviderId(providerMsgId: string) {
    return this.read(() => {
      const r = T(this.c, "messages").by("provider", this.accountId, providerMsgId)[0];
      return r ? { id: r.id as number, subject: r.subject as string, fromEmail: r.from_email as string } : null;
    });
  }

  syncedMessages() {
    return this.read(() =>
      T(this.c, "messages")
        .by("fk_account_id", this.accountId)
        .filter((m) => m.provider_msg_id !== null && !String(m.provider_msg_id).startsWith("local:"))
        .map((m) => ({ id: m.id as number, providerMsgId: m.provider_msg_id as string, date: m.date as number })),
    );
  }

  pendingAttachmentBodies(limit: number) {
    return this.read(() => T(this.c, "messages").by("attachment_pending", this.accountId, 1)
      .filter((m) => m.provider_msg_id != null && !String(m.provider_msg_id).startsWith("local:"))
      .slice(0, Math.max(0, Math.min(50, limit))).map((m) => ({ id: m.id as number, providerMsgId: m.provider_msg_id as string })));
  }

  pendingBodies(limit: number) {
    return this.read(() => {
      const locations = T(this.c, "message_locations");
      return T(this.c, "messages")
        .by("pending_bodies", this.accountId)
        .sort((x, y) => y.date - x.date || y.id - x.id)
        .flatMap((m) => {
          const l = locations.by("fk_message_id", m.id).sort((x, y) => (x.mailbox < y.mailbox ? -1 : 1))[0];
          return l ? [{ id: m.id as number, mailbox: l.mailbox as string, uid: l.uid as number, uidvalidity: l.uidvalidity as number }] : [];
        })
        .slice(0, limit);
    });
  }

  countPendingBodies() {
    return this.read(() => T(this.c, "messages").count("pending_bodies", this.accountId));
  }

  providerIds(messageIds: readonly number[]) {
    return this.read(() => {
      const out = new Map<number, string | null>();
      const messages = T(this.c, "messages");
      for (const id of messageIds) {
        const m = messages.get(id);
        if (m) out.set(id, m.provider_msg_id as string | null);
      }
      return out;
    });
  }

  setting<V>(key: string): Promise<V | null> {
    return this.read(() => getSetting<V | null>(this.c, key, null));
  }
}

class IdbImapLocations implements ImapLocationStore {
  constructor(
    private readonly c: Ctx,
    private readonly accountId: number,
    private readonly command: Command,
    private readonly read: Command,
  ) {}

  private get t() {
    return T(this.c, "message_locations");
  }

  /** plan 65: a location in a listed folder decides membership, in the same unit and incrementally (the SQL adapter's, Codex R10) */
  private located(messageIds: readonly number[], mailbox: string, added: boolean) {
    if (!messageIds.length || !isFolder(this.c, this.accountId, mailbox)) return;
    const messages = T(this.c, "messages");
    const threads = T(this.c, "threads");
    const memberships = T(this.c, "thread_folders");
    for (const id of messageIds) {
      const m = messages.get(id);
      if (!m) continue;
      if (added) {
        const t = threads.get(m.thread_id);
        if (t && !m.is_trash && !m.is_spam && !memberships.has(t.id, mailbox)) memberships.insert({ thread_id: t.id, account_id: t.account_id, folder: mailbox, last_date: t.last_date, unread: t.unread_count > 0 ? 1 : 0 });
      } else {
        const row = memberships.get(m.thread_id, mailbox);
        if (row && !messages.by("fk_thread_id", m.thread_id).some((o) => !o.is_trash && !o.is_spam && this.t.has(o.id, mailbox))) memberships.deleteRow(row);
      }
    }
  }

  upsert(messageId: number, mailbox: string, uidvalidity: number, uid: number, flags: string[]) {
    return this.command(() => {
      // a known location (new flags, a new UID) moves no membership
      const known = this.t.has(messageId, mailbox);
      this.t.put({ message_id: messageId, account_id: this.accountId, mailbox, uidvalidity, uid, flags: JSON.stringify(flags) });
      if (!known) this.located([messageId], mailbox, true);
    });
  }

  remove(messageId: number, mailbox: string) {
    return this.command(() => {
      this.t.delete(messageId, mailbox);
      this.located([messageId], mailbox, false);
    });
  }

  async removeMany(messageIds: readonly number[], mailbox: string) {
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500);
      await this.command(() => {
        const messages = T(this.c, "messages");
        const threads = new Set<number>();
        for (const id of chunk) {
          this.t.delete(id, mailbox);
          const m = messages.get(id);
          if (m) threads.add(m.thread_id as number);
        }
        if (!isFolder(this.c, this.accountId, mailbox)) return;
        const memberships = T(this.c, "thread_folders");
        // a thread's row goes only when none of its messages is still there: once per thread (Codex R11)
        for (const thread of threads) {
          const row = memberships.get(thread, mailbox);
          if (row && !messages.by("fk_thread_id", thread).some((o) => !o.is_trash && !o.is_spam && this.t.has(o.id, mailbox))) memberships.deleteRow(row);
        }
      });
    }
  }

  setFlags(messageId: number, mailbox: string, flags: string) {
    return this.command(() => {
      const r = this.t.get(messageId, mailbox);
      if (r) this.t.update(r, { flags });
    });
  }

  of(messageIds: readonly number[]): Promise<ImapLocation[]> {
    return this.read(() => messageIds.flatMap((id) => this.t.by("fk_message_id", id).map((r) => ({ message_id: r.message_id, mailbox: r.mailbox, uid: r.uid, uidvalidity: r.uidvalidity, flags: r.flags }) as ImapLocation)));
  }

  at(mailbox: string, uidvalidity: number, uid: number) {
    return this.read(() => (this.t.by("uid", this.accountId, mailbox, uidvalidity, uid)[0]?.message_id as number | undefined) ?? null);
  }

  get(messageId: number, mailbox: string) {
    return this.read(() => {
      const r = this.t.get(messageId, mailbox);
      return r ? { uid: r.uid as number, uidvalidity: r.uidvalidity as number, flags: r.flags as string } : null;
    });
  }

  count(messageId: number) {
    return this.read(() => this.t.count("fk_message_id", messageId));
  }

  inMailbox(mailbox: string, uidvalidity: number) {
    return this.read(() =>
      this.t
        .by("mailbox", this.accountId, mailbox)
        .filter((r) => r.uidvalidity === uidvalidity)
        .map((r) => ({ message_id: r.message_id as number, uid: r.uid as number, flags: r.flags as string })),
    );
  }

  resetMailbox(mailbox: string) {
    return this.command(() => {
      const rows: R[] = this.t.by("mailbox", this.accountId, mailbox);
      for (const r of rows) this.t.deleteRow(r);
      // membership in an IMAP folder is its locations there: with every one gone its rows go, no thread refolded (Codex R2)
      for (const r of T(this.c, "thread_folders").by("folder", this.accountId, mailbox)) T(this.c, "thread_folders").deleteRow(r);
      return rows.map((r) => r.message_id as number);
    });
  }

  twins(e: { subject: string; fromEmail: string; date: number; size: number; rfcMessageId?: string | null }, afterId: number, limit: number) {
    // a bucket of exactly the envelope's ID-less messages (Codex R20), or a Message-ID's, split by envelope (Codex
    // R27): sorted once and kept while its revision holds (any change to a row in it: Codex R28, never its size), each
    // page a seek (Codex R21)
    return this.read(() => {
      const messages = T(this.c, "messages");
      const envelope = `${e.fromEmail}\u0000${e.date}\u0000${e.size}\u0000${e.subject}`;
      const rfc = e.rfcMessageId ?? null;
      const bucket = rfc ? messages.bucket("rfc", this.accountId, rfc) : messages.bucket("twins", this.accountId, e.fromEmail, e.date, e.size, e.subject);
      if (!bucket) return [];
      const revision = twinRevision(this.c.db, twinBucketKey(this.accountId, rfc, envelope));
      let cached = twinOrders.get(bucket);
      if (!cached || cached.revision !== revision) {
        const byEnvelope = new Map<string, number[]>();
        for (const k of bucket) {
          const m = messages.rows.get(k)!;
          const at = `${m.from_email}\u0000${m.date}\u0000${m.size}\u0000${m.subject}`;
          const ids = byEnvelope.get(at) ?? [];
          ids.push(m.id as number);
          byEnvelope.set(at, ids);
        }
        for (const ids of byEnvelope.values()) ids.sort((x, y) => x - y);
        twinOrders.set(bucket, (cached = { revision, byEnvelope }));
      }
      const ids = cached.byEnvelope.get(envelope) ?? [];
      let lo = 0;
      let hi = ids.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ids[mid]! <= afterId) lo = mid + 1;
        else hi = mid;
      }
      return ids.slice(lo, lo + limit);
    });
  }

  unlocated(afterId: number, span: number) {
    return this.read(() => {
      const messages = T(this.c, "messages");
      const locations = T(this.c, "message_locations");
      const ids: number[] = [];
      // a window of ids, never the account's every message (they're keys: a get each)
      for (let id = afterId + 1; id <= afterId + span; id++) {
        const m = messages.get(id);
        if (m && m.account_id === this.accountId && locations.count("fk_message_id", id) === 0) ids.push(id);
      }
      return { ids, more: messages.highestKey() > afterId + span };
    });
  }

  envelopes(messageIds: readonly number[]) {
    return this.read(() => {
      const messages = T(this.c, "messages");
      return messageIds.flatMap((id) => {
        const m = messages.get(id);
        return m && m.account_id === this.accountId ? [{ id, subject: m.subject as string, fromEmail: m.from_email as string, date: m.date as number, size: m.size as number, rfcMessageId: (m.rfc_message_id as string | null) ?? null }] : [];
      });
    });
  }

  resetCandidate(c: { candidates: readonly number[]; subject: string; fromEmail: string; date: number; size: number; mailbox: string; rfcMessageId?: string | null }) {
    return this.read(() => {
      const messages = T(this.c, "messages");
      const hit = [...c.candidates]
        .sort((x, y) => x - y)
        .map((id) => messages.get(id))
        .find((m) => m && m.account_id === this.accountId && m.rfc_message_id === (c.rfcMessageId ?? null) && m.subject === c.subject && m.from_email === c.fromEmail && m.date === c.date && m.size === c.size && !this.t.has(m.id, c.mailbox));
      return hit ? { id: hit.id as number } : null;
    });
  }
}
