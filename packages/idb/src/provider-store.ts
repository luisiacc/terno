import { ImapIdentityError, AWAITING_IDENTITY, sameImapLocations } from "@terno/store";
import type { FlagSnapshotRequest, FlagSnapshotPage, ImapLocation, ImapLocationStore, ProviderStore } from "@terno/store";
import { getSetting, T, type Ctx, type R } from "./mail";
import { isFolder } from "./folders";

const identityVersions = new WeakMap<object, { value: number }>();
function identityVersion(c: Ctx) {
  let version = identityVersions.get(c.db);
  if (!version) {
    version = { value: 0 };
    identityVersions.set(c.db, version);
    const observed = version;
    c.db.onRow((table, row, prev) => {
      if (table === "imap_identity_holds" && (!row || !prev || row.owner !== prev.owner)) observed.value++;
      if (table === "message_locations" && (!row || !prev || ["message_id", "account_id", "mailbox", "uid", "uidvalidity"].some((key) => row[key] !== prev[key]))) observed.value++;
    });
  }
  return version;
}

type Command = <V>(fn: () => V) => Promise<V>;

/** One account's provider-side reads and IMAP identity (the SQL adapter's SqlProviderStore, on the in-memory tables). */
/**
 * per database, the threads an expunge is deciding: true once a write could have put one of their messages back in a
 * folder (a location written for one of them; one changing spam, trash or thread) since the decision began (Codex R48)
 */
const expungeWatches = new WeakMap<object, Map<number, { mailbox: string; marked: boolean }>>();
function expungeWatch(c: { db: { onRow(fn: (table: string, row: Record<string, unknown> | undefined, prev: Record<string, unknown> | undefined) => void): void } }): Map<number, { mailbox: string; marked: boolean }> {
  let watch = expungeWatches.get(c.db);
  if (!watch) {
    const map = new Map<number, { mailbox: string; marked: boolean }>();
    expungeWatches.set(c.db, (watch = map));
    const mark = (thread: unknown, mailbox?: unknown) => {
      const w = map.get(thread as number);
      if (w && (mailbox === undefined || w.mailbox === mailbox)) w.marked = true;
    };
    c.db.onRow((table, row, prev) => {
      if (map.size === 0) return;
      if (table === "messages") {
        // a message put in the thread, or out of trash or spam, or moved between threads
        if (row && (!prev || row.is_spam !== prev.is_spam || row.is_trash !== prev.is_trash || row.thread_id !== prev.thread_id)) mark(row.thread_id);
        if (row && prev && row.thread_id !== prev.thread_id) mark(prev.thread_id);
      } else if (table === "message_locations" && row) {
        // a location written in that mailbox for one of its messages
        mark(T(c as never, "messages").get(row.message_id as number)?.thread_id, row.mailbox);
      }
    });
  }
  return watch;
}

/** each twins bucket's ids by envelope, ascending, as of its revision (a page seeks into it) */
const twinOrders = new WeakMap<ReadonlySet<unknown>, { revision: string; asked: Map<string, number[]>; bySubject: Map<string, number[]> | null; byRest: Map<string, Map<string, number[]>> }>();
/** the first position in ascending ids above `after` */
function seek(ids: readonly number[], after: number): number {
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid]! <= after) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
/**
 * per database, the revision of each twins bucket looked up: a row in it written, put in or taken out moves it on.
 * Only buckets looked up are followed, and at most TWIN_WATCHED of them (Codex R32: every changed message's key was
 * kept for good); past that they're all let go at once, a new generation, so no kept order is ever taken as current.
 */
const twinRevisions = new WeakMap<object, { watched: Map<string, number>; generation: number }>();
const TWIN_WATCHED = 10_000;
/** tests: how many buckets a database follows */
export function twinBucketsWatched(db: object): number {
  return twinRevisions.get(db)?.watched.size ?? 0;
}
const twinBucketKey = (accountId: unknown, rfc: unknown, envelope: string) => (rfc ? `id\u0000${accountId}\u0000${rfc}` : `nomid\u0000${accountId}\u0000${envelope}`);
function twinRevision(db: { onRow(fn: (table: string, row: Record<string, unknown> | undefined, prev: Record<string, unknown> | undefined) => void): void }, key: string): string {
  let revisions = twinRevisions.get(db);
  if (!revisions) {
    const state = { watched: new Map<string, number>(), generation: 0 };
    twinRevisions.set(db, (revisions = state));
    db.onRow((table, row, prev) => {
      if (table !== "messages" || state.watched.size === 0) return;
      for (const r of [row, prev]) {
        if (!r) continue;
        const key = twinBucketKey(r.account_id, r.rfc_message_id || null, `${r.from_email}\u0000${r.date}\u0000${r.size}\u0000${r.subject}`);
        const at = state.watched.get(key);
        if (at !== undefined) state.watched.set(key, at + 1);
      }
    });
  }
  if (!revisions.watched.has(key)) {
    if (revisions.watched.size >= TWIN_WATCHED) {
      revisions.watched.clear();
      revisions.generation++;
    }
    revisions.watched.set(key, 0);
  }
  return `${revisions.generation}:${revisions.watched.get(key)}`;
}

export class IdbProviderStore implements ProviderStore {
  readonly locations: ImapLocationStore;

  constructor(
    private readonly c: Ctx,
    private readonly accountId: number,
    command: Command,
    private readonly read: Command,
    private readonly cachedPage: (after?: string) => ReturnType<ProviderStore["syncedMessagePage"]>,
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

  syncedMessagePage(after?: string) { return this.cachedPage(after); }

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
          if (T(this.c, "imap_identity_holds").has(m.id)) return [];
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

  async fence(ids: readonly number[]) {
    for (let i = 0; i < ids.length; i += 1000) await this.command(() => {
      for (const id of ids.slice(i, i + 1000)) if (T(this.c, "messages").get(id)?.account_id === this.accountId) T(this.c, "imap_identity_holds").put({ message_id: id, account_id: this.accountId, owner: null });
    });
  }

  unresolved(ids: readonly number[]) {
    return this.read(() => ids.filter((id) => T(this.c, "imap_identity_holds").get(id)?.account_id === this.accountId));
  }

  async dispatch<T>(ids: readonly number[], expected: readonly ImapLocation[], start: (holdOwner?: string) => Promise<T>, fenceIds?: readonly number[]): Promise<T> {
    const wanted = new Map<number, Map<string, ImapLocation>>();
    for (const row of expected) {
      const group = wanted.get(row.message_id) ?? new Map();
      if (group.has(row.mailbox)) throw new ImapIdentityError();
      group.set(row.mailbox, row); wanted.set(row.message_id, group);
    }
    const targetSet = new Set(ids), targets = [...targetSet], fencing = new Set(fenceIds);
    if ([...wanted.keys(), ...fencing].some((id) => !targetSet.has(id))) throw new ImapIdentityError();
    const owner = fencing.size ? crypto.randomUUID() : undefined;
    const revision = identityVersion(this.c);
    let version = await this.read(() => revision.value);
    let started = false;
    try {
      for (let i = 0; i < targets.length; i += 128) {
        const validate = () => {
          if (revision.value !== version) throw new ImapIdentityError();
          for (const id of targets.slice(i, i + 128)) {
            const rows = this.t.by("fk_message_id", id).filter((l) => l.account_id === this.accountId);
            const want = wanted.get(id);
            if (T(this.c, "imap_identity_holds").has(id) || !rows.length || rows.length !== want?.size || rows.some((l) => { const e = want.get(l.mailbox); return !e || e.uid !== l.uid || e.uidvalidity !== l.uidvalidity; })) throw new ImapIdentityError();
          }
          if (owner) for (const id of targets.slice(i, i + 128)) if (fencing.has(id)) T(this.c, "imap_identity_holds").put({ message_id: id, account_id: this.accountId, owner });
          if (owner) version += targets.slice(i, i + 128).filter((id) => fencing.has(id)).length;
        };
        if (owner) await this.command(validate);
        else await this.read(validate);
      }
      return await this.read(() => {
        if (revision.value !== version) throw new ImapIdentityError();
        started = true;
        return start(owner);
      });
    } catch (error) {
      if (!started && owner) for (let i = 0; i < targets.length; i += 128) await this.command(() => {
        const holds = T(this.c, "imap_identity_holds");
        for (const id of targets.slice(i, i + 128)) if (holds.get(id)?.owner === owner) holds.delete(id);
      });
      throw error;
    }
  }

  async mappedMove(source: readonly ImapLocation[], mailbox: string, uidvalidity: number, mapping: readonly { messageId: number; uid: number }[], copy: boolean, expected: readonly ImapLocation[], holdOwner: string) {
    if (!holdOwner) throw new ImapIdentityError();
    const expectedById = new Map<number, ImapLocation[]>();
    for (const row of expected) {
      const group = expectedById.get(row.message_id) ?? [];
      group.push(row); expectedById.set(row.message_id, group);
    }
    const mappedById = new Map(mapping.map((m) => [m.messageId, m.uid]));
    if (!Number.isSafeInteger(uidvalidity) || uidvalidity <= 0 || uidvalidity > 0xffff_ffff || mapping.length !== source.length || mappedById.size !== source.length || new Set(mapping.map((m) => m.uid)).size !== mapping.length || mapping.some((m) => !Number.isSafeInteger(m.uid) || m.uid <= 0 || m.uid > 0xffff_ffff) || source.some((l) => !mappedById.has(l.message_id))) throw new ImapIdentityError();
    for (let i = 0; i < source.length; i += 128) {
      await this.command(() => {
        for (const item of source.slice(i, i + 128)) {
          if (T(this.c, "imap_identity_holds").get(item.message_id)?.owner !== holdOwner) throw new ImapIdentityError();
          const current = this.t.by("fk_message_id", item.message_id).filter((l) => l.account_id === this.accountId) as unknown as ImapLocation[];
          if (!sameImapLocations(expectedById.get(item.message_id) ?? [], current)) throw new ImapIdentityError();
          const mapped = mappedById.get(item.message_id);
          if (!mapped) continue;
          const old = this.t.get(item.message_id, item.mailbox);
          if (!old || old.account_id !== this.accountId || old.uid !== item.uid || old.uidvalidity !== item.uidvalidity) throw new ImapIdentityError();
          if (this.t.by("uid", this.accountId, mailbox, uidvalidity, mapped).some((l) => l.message_id !== item.message_id)) throw new ImapIdentityError();
          this.t.put({ message_id: item.message_id, account_id: this.accountId, mailbox, uidvalidity, uid: mapped, flags: "[]" });
          this.located([item.message_id], mailbox, true);
          if (!copy) { this.t.delete(item.message_id, item.mailbox); this.located([item.message_id], item.mailbox, false); }
          T(this.c, "imap_identity_holds").delete(item.message_id);
        }
      });
    }
    await this.resumeResolved();
  }

  async resumeResolved() {
    await this.command(() => {
      for (const op of T(this.c, "ops").by("fk_account_id", this.accountId)) {
        if (op.state !== "queued" || op.next_attempt_at !== AWAITING_IDENTITY) continue;
        const ids = (JSON.parse(op.target_json) as { messageIds?: number[] }).messageIds ?? [];
        if (ids.length && ids.every((id) => !T(this.c, "imap_identity_holds").has(id) && this.t.count("fk_message_id", id))) T(this.c, "ops").update(op, { next_attempt_at: 0 });
      }
    });
  }

  private get t() {
    return T(this.c, "message_locations");
  }

  /** plan 68: a location in a listed folder decides membership, in the same unit and incrementally (the SQL adapter's, Codex R10) */
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
      if (T(this.c, "imap_identity_holds").has(messageId)) return;
      // a known location (new flags, a new UID) moves no membership
      const known = this.t.has(messageId, mailbox);
      this.t.put({ message_id: messageId, account_id: this.accountId, mailbox, uidvalidity, uid, flags: JSON.stringify(flags) });
      if (!known) this.located([messageId], mailbox, true);
    });
  }

  remove(messageId: number, mailbox: string) {
    return this.command(() => {
      if (this.t.has(messageId, mailbox)) T(this.c, "imap_identity_holds").put({ message_id: messageId, account_id: this.accountId, owner: null });
      this.t.delete(messageId, mailbox);
      this.located([messageId], mailbox, false);
    });
  }

  async removeMany(messageIds: readonly number[], mailbox: string) {
    const threads = new Set<number>();
    for (let i = 0; i < messageIds.length; i += 500) {
      const chunk = messageIds.slice(i, i + 500);
      await this.command(() => {
        const messages = T(this.c, "messages");
        for (const id of chunk) {
          if (this.t.has(id, mailbox)) T(this.c, "imap_identity_holds").put({ message_id: id, account_id: this.accountId, owner: null });
          this.t.delete(id, mailbox);
          const m = messages.get(id);
          if (m) threads.add(m.thread_id as number);
        }
      });
    }
    // then each thread's row, once all its locations are gone: it goes only when none of its messages is still there.
    // Each thread's messages are walked 2,000 a read with a turn between reads (Codex R48: copied whole and rescanned
    // in the deleting command, 75 ms at once); a thread being decided is watched (any write that could put one of its
    // messages back here marks it), so the delete needs no second walk: unmarked, its row goes in a batch of 500.
    const watch = expungeWatch(this.c);
    let since = performance.now();
    const turn = async () => {
      if (performance.now() - since < 4) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
      since = performance.now();
    };
    const going: number[] = [];
    const flush = async () => {
      const batch = going.splice(0);
      if (!batch.length) return;
      await this.command(() => {
        if (!isFolder(this.c, this.accountId, mailbox)) return;
        const memberships = T(this.c, "thread_folders");
        for (const thread of batch) {
          // marked while it was decided: it keeps its row (shown a while longer, never a whole thread walked here)
          if (watch.get(thread)?.marked !== false) continue;
          const row = memberships.get(thread, mailbox);
          if (row) memberships.deleteRow(row);
        }
      });
      for (const thread of batch) watch.delete(thread);
    };
    for (const thread of threads) {
      await turn();
      watch.set(thread, { mailbox, marked: false });
      const keys = T(this.c, "messages").keysBy("fk_thread_id", thread);
      let here = false;
      for (let ended = false; !ended && !here; ) {
        here = await this.read(() => {
          const messages = T(this.c, "messages");
          for (let n = 0; n < 2000; n++) {
            const next = keys.next();
            if (next.done) {
              ended = true;
              return false;
            }
            const o = messages.rows.get(next.value);
            if (o && !o.is_trash && !o.is_spam && this.t.has(o.id, mailbox)) return true;
          }
          return false;
        });
        if (!ended && !here) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          since = performance.now();
        }
      }
      if (here) watch.delete(thread);
      else going.push(thread);
      if (going.length >= 500) await flush();
    }
    await flush();
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
      for (const r of rows) { T(this.c, "imap_identity_holds").put({ message_id: r.message_id, account_id: this.accountId, owner: null }); this.t.deleteRow(r); }
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
      // the first few envelopes asked for in a revision found by comparing fields along the bucket (one lookup stays a
      // single cheap walk: Codex R49); past them the bucket is split once by subject, then a subject's ids by the rest
      // of the envelope the first time it's asked for (never a walk per envelope: Codex R50)
      let split = twinOrders.get(bucket);
      if (!split || split.revision !== revision) twinOrders.set(bucket, (split = { revision, asked: new Map(), bySubject: null, byRest: new Map() }));
      const known = split.asked.get(envelope);
      if (known) return known.slice(seek(known, afterId), seek(known, afterId) + limit);
      if (!split.bySubject && split.asked.size < 3) {
        const found: number[] = [];
        for (const k of bucket) {
          const m = messages.rows.get(k)!;
          if (m.date === e.date && m.size === e.size && m.from_email === e.fromEmail && m.subject === e.subject) found.push(m.id as number);
        }
        found.sort((x, y) => x - y);
        split.asked.set(envelope, found);
        return found.slice(seek(found, afterId), seek(found, afterId) + limit);
      }
      if (!split.bySubject) {
        const bySubject = new Map<string, number[]>();
        for (const k of bucket) {
          const m = messages.rows.get(k)!;
          const ids = bySubject.get(m.subject as string);
          if (ids) ids.push(m.id as number);
          else bySubject.set(m.subject as string, [m.id as number]);
        }
        split.bySubject = bySubject;
      }
      let rest = split.byRest.get(e.subject);
      if (!rest) {
        rest = new Map();
        for (const id of split.bySubject!.get(e.subject) ?? []) {
          const m = messages.get(id)!;
          const at = `${m.date}\u0000${m.size}\u0000${m.from_email}`;
          const ids = rest.get(at);
          if (ids) ids.push(id);
          else rest.set(at, [id]);
        }
        for (const ids of rest.values()) ids.sort((x, y) => x - y);
        split.byRest.set(e.subject, rest);
      }
      const found = rest.get(`${e.date}\u0000${e.size}\u0000${e.fromEmail}`) ?? [];
      const cached = { byEnvelope: new Map([[envelope, found]]) };
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

/** Native index seek: never materialize the account bucket or load message payloads. */
export function idbCachedPage(idb: IDBDatabase, c: Ctx, accountId: number, after = ""): ReturnType<ProviderStore["syncedMessagePage"]> {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction("messages", "readonly");
    const range = IDBKeyRange.bound([accountId, after], [accountId + 1], true, true);
    const request = tx.objectStore("messages").index("cached_provider").openKeyCursor(range);
    const items: { id: number; providerMsgId: string }[] = [];
    let scanned = 0, next: string | undefined;
    tx.onabort = () => reject(tx.error ?? new Error("Cached refresh cursor aborted"));
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => resolve({ items, next });
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const key = (cursor.key as [number, string])[1];
      next = key; scanned++;
      const row = T(c, "messages").get(cursor.primaryKey as number);
      if (row?.account_id === accountId && row.provider_msg_id === key && !key.startsWith("local:")) items.push({ id: row.id, providerMsgId: key });
      if (scanned < 50) cursor.continue();
    };
  });
}
