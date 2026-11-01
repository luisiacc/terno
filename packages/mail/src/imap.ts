import { sentCopyWarning, type SentCopyHooks } from "./sent-copy";
import { FOLDERS_PER_ACCOUNT_MAX, MAX_INCOMING_MIME_BYTES } from "@terno/core";
import { createHash } from "node:crypto";
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { bulkHeaders, parseListUnsubscribe } from "@terno/core";
import { L, type Localized } from "@terno/i18n";
import type { IncomingMessage, ProviderFolder, ImapLocation, FlagSnapshotPage } from "@terno/store";
import { headerFields, messageAddresses, parseListId, parseRaw, splitIds } from "./mime";
import { isNetworkError } from "./net-errors";
import { ImapIdentityError } from "@terno/store";
import { sendViaSmtp } from "./smtp";
import { nameTaken, planImapCreate, ROLE_NAME_HINTS, planImapDelete, planImapRename, refusedBy, serverReason } from "./folder-changes";
import { BACKFILL_CHUNK_MS, type FolderChange, type FolderMove, ProviderAuthError, ProviderIdentityError, ProviderError, type FlagUpdate, type ImapAccountConfig, type MailProvider, type ProviderContext, type ProviderOp, type SendPayload, type SyncSink } from "./types";

type Role = "inbox" | "sent" | "archive" | "all" | "junk" | "trash" | "drafts";

interface MailboxState {
  uidvalidity: number;
  uidnext: number;
  /** plan 68: what STATUS compares before a custom folder is synced again (absent: never skipped) */
  messages?: number;
  modseq?: string;
}

interface Cursor {
  mailboxes: Record<string, MailboxState>;
  /**
   * plan 101: older mail a widened window asks for, for that request's span (ms): the mailboxes finished, by
   * `path:uidvalidity`, and per mailbox the UID the next chunk reads below (newest first)
   */
  backfill?: { since: number; until: number; done: string[]; below: Record<string, number>; failed?: Record<string, number>; held?: Record<string, number[]> };
  roles?: Partial<Record<Role, string>>;
  /** plan 68: sync passes so far; without CONDSTORE an unchanged-looking folder is still checked every CHECK_EVERY */
  pass?: number;
  /** plan 68 (Codex R4): messages a failed pass left without a location; the next complete pass reconciles them */
  orphans?: number[];
  /** plan 68 (Codex R5): per mailbox, the messages a UIDVALIDITY reset unlocated, kept until that mailbox syncs, so a retry can still recognise them */
  resetPending?: Record<string, number[]>;
  /** plan 68 (Codex R8, R9): messages any step unlocated (a sweep, a reset, a vanished folder), written down before their locations go; cleared once reconciled */
  unlocated?: number[];
  /** plan 68 (Codex R9): orphans are waiting for a pass that reads every folder (no STATUS skip), the only kind that may delete them */
  fullCheck?: boolean;
  /**
   * plan 79 (Codex review): a folder a new account's preview placed messages in, by its UIDVALIDITY then, until its full
   * read: a reset between them is a reset (those places go), and nothing past it is acknowledged
   */
  previewed?: Record<string, number>;
  /**
   * plan 68 (Codex R15): a journal above was cut at its limit: the next pass that reads every folder looks for every
   * message with no location (a window of ids at a time), so none is left behind with neither a place nor a record
   */
  overflow?: boolean;
  /**
   * plan 107 (Codex R1): mailboxes the user deleted here, with their UIDVALIDITY: the next pass forgets what was only
   * there. One renamed here that no pass had read yet names the path its mail is cached under (Codex code review round 4 #2).
   *
   * Plan 107's invariant for this and `renamed` (Codex code review round 8): a record names a mailbox *generation*
   * (path + UIDVALIDITY), read from the server's STATUS when it's written, never from what's cached, and checked
   * against the LIST and STATUS again where it's applied. It never applies to another generation of its path, and
   * while it's pending the path's listing leaves its generation out (`except`), so no membership, count or export of
   * a path made again shows it.
   *
   * `answered`: the backend followed it (its favorites went): the change heard every DELETE's answer, or a pass
   * announced it (Codex code review round 12 #3). One whose answer was lost is announced by the pass whose LIST shows
   * it done, once.
   */
  deleted?: Record<string, number | { from: string; uidvalidity: number; answered?: true }>;
  /**
   * plan 107: mailboxes the user renamed here, by their new path: the old one and its UIDVALIDITY. Read under the same
   * UIDVALIDITY, a UID under the new path is the message that had it under the old one (the server moved the mailbox).
   * `answered`: the change heard the server's answer and announced the move itself.
   */
  renamed?: Record<string, { from: string; uidvalidity: number; key?: string; stale?: true; answered?: true }>;
}

/** plan 107: a deletion record the backend followed (Codex code review round 12 #3); a bare UIDVALIDITY names its own path */
const answeredDeletion = (path: string, r: NonNullable<Cursor["deleted"]>[string]): NonNullable<Cursor["deleted"]>[string] =>
  typeof r === "number" ? { from: path, uidvalidity: r, answered: true } : { ...r, answered: true };

/**
 * Plan 68 (Codex R52): how many more reset ids this folder may keep: the limit is the cursor's, every folder's together
 * (20 folders reset with the same 200,000 copies were 4 million ids, 27 MB of cursor written each time); past it,
 * `overflow`, and the scan for messages with no place finds the rest
 */
export function resetRoom(pending: Readonly<Record<string, readonly number[]>>, path: string): number {
  let others = 0;
  for (const [p, ids] of Object.entries(pending)) if (p !== path) others += ids.length;
  return Math.max(0, IMAP_JOURNAL_LIMITS.resetPending - others);
}

/** Plan 68: how many ids each journal in the cursor keeps (the cursor stays bounded; past them, `overflow`). */
export const IMAP_JOURNAL_LIMITS = { unlocated: 200_000, resetPending: 200_000, orphans: 100_000 };

/** The newest `max` of `ids`, marking the cursor when any had to go. */
function bounded(cursor: Cursor, ids: readonly number[], max: number, keep: "newest" | "oldest" = "newest"): number[] {
  if (ids.length <= max) return [...ids];
  cursor.overflow = true;
  return keep === "newest" ? ids.slice(-max) : ids.slice(0, max);
}

/**
 * Plan 68 (Codex R18–R30): what each held-back message is, in one linear pass. Per envelope, its twins with no place
 * left on the server, oldest first, go to the held-back messages in order (each moved here); a Message-ID's copy is the
 * same message in one more folder, once a folder (the plain-key one first, else the next twin with no place there,
 * from a cursor per envelope and folder: Codex R27, R29, R30); anything else is a copy of its own (none for old mail).
 */
export function planTellApart<A extends HeldShape>(list: readonly A[], places: ReadonlyMap<number, readonly { mailbox: string; uid: number }[]>, present: ReadonlySet<string>): Plan<A> {
  const steps = planSteps(list, places, present);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

interface HeldShape {
  candidates: readonly number[];
  path: string;
  attachTo: number | null;
  idCopy: boolean;
  old: boolean;
}
interface Plan<A> {
  placed: { id: number; a: A; moved: boolean }[];
  copies: A[];
}

/** planTellApart a step at a time: a pause every thousand messages or candidates (Codex R31: 150,000 were 80 ms at once) */
export function* planSteps<A extends HeldShape>(list: readonly A[], places: ReadonlyMap<number, readonly { mailbox: string; uid: number }[]>, present: ReadonlySet<string>): Generator<void, Plan<A>, void> {
  let work = 0;
  const gone = new Map<readonly number[], { ids: number[]; next: number }>();
  const cursors = new Map<readonly number[], Map<string, number>>();
  /** stored messages given a place in a folder here: each (message, folder) once */
  const attached = new Set<string>();
  const placedHere = (id: number, path: string) => attached.has(`${id}\u0000${path}`) || (places.get(id) ?? []).some((l) => l.mailbox === path);
  const placed: { id: number; a: A; moved: boolean }[] = [];
  const copies: A[] = [];
  for (const a of list) {
    if (++work % 1000 === 0) yield;
    let free = gone.get(a.candidates);
    if (!free) {
      const ids: number[] = [];
      for (const id of a.candidates) {
        if ((places.get(id) ?? []).every((l) => !present.has(`${l.mailbox}\u0000${l.uid}`))) ids.push(id);
        if (++work % 1000 === 0) yield;
      }
      gone.set(a.candidates, (free = { ids, next: 0 }));
    }
    const id = free.ids[free.next];
    if (id !== undefined) {
      free.next++;
      // its place here is given: no copy after it takes it (Codex R28)
      attached.add(`${id}\u0000${a.path}`);
      placed.push({ id, a, moved: true });
      continue;
    }
    let target: number | undefined;
    if (a.idCopy) {
      if (a.attachTo !== null && !placedHere(a.attachTo, a.path)) target = a.attachTo;
      else {
        // the next twin with no place in this folder: a cursor that only moves on (a twin passed over stays placed)
        let byPath = cursors.get(a.candidates);
        if (!byPath) cursors.set(a.candidates, (byPath = new Map()));
        let at = byPath.get(a.path) ?? 0;
        while (at < a.candidates.length && placedHere(a.candidates[at]!, a.path)) {
          at++;
          if (++work % 1000 === 0) yield;
        }
        byPath.set(a.path, at);
        target = a.candidates[at];
      }
    }
    if (target !== undefined) {
      attached.add(`${target}\u0000${a.path}`);
      placed.push({ id: target, a, moved: false });
    } else if (!a.old) copies.push(a);
  }
  return { placed, copies };
}

/** the event loop given a turn once a few milliseconds of work have gone by (a resolved await never gives one) */
function breather(budgetMs = 4): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < budgetMs) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    since = performance.now();
  };
}

/** Plan 68 (Codex R33): the stored ids of messages just written, by key, looked up a few milliseconds a turn (one per key, null where none) */
export async function storedIds(keys: readonly string[], lookup: (key: string) => Promise<{ id: number } | null | undefined>, aligned: true): Promise<(number | null)[]>;
export async function storedIds(keys: readonly string[], lookup: (key: string) => Promise<{ id: number } | null | undefined>): Promise<number[]>;
export async function storedIds(keys: readonly string[], lookup: (key: string) => Promise<{ id: number } | null | undefined>, aligned = false): Promise<(number | null)[]> {
  const breathe = breather();
  const ids: (number | null)[] = [];
  for (const key of keys) {
    const row = await lookup(key);
    if (row) ids.push(row.id);
    else if (aligned) ids.push(null);
    await breathe();
  }
  return ids;
}

/**
 * Plan 68 (Codex R34, R35): messages just written join the twin groups kept for their envelopes: each group's
 * additions gathered, then merged once (new ids sort after the old, so mostly an append), a few milliseconds a turn,
 * never a search and a sort per message.
 */
export async function joinGroups(groups: ReadonlyMap<string, number[]>, keys: readonly string[], ids: readonly (number | null)[]): Promise<void> {
  const breathe = breather();
  const adding = new Map<number[], number[]>();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const group = id === null || id === undefined ? undefined : groups.get(keys[i]!);
    if (group) {
      const add = adding.get(group) ?? [];
      add.push(id!);
      adding.set(group, add);
    }
    if (i % 1000 === 999) await breathe();
  }
  for (const [group, add] of adding) {
    // written in order, so ascending (sorted once otherwise); then appended or merged a thousand at a time, an id
    // already there (or twice in what's added) skipped (Codex R36: a group of 500,000 was 40 ms at once)
    let ascending = true;
    for (let i = 1; i < add.length && ascending; i++) ascending = add[i]! > add[i - 1]!;
    if (!ascending) add.sort((x, y) => x - y);
    if (group.length === 0 || add[0]! > group.at(-1)!) {
      for (let i = 0; i < add.length; i++) {
        if (i === 0 || add[i] !== add[i - 1]) group.push(add[i]!);
        if (i % 1000 === 999) await breathe();
      }
      continue;
    }
    // some older than the group's newest: a merge of the two, then the group rewritten, both in steps
    const merged: number[] = [];
    let i = 0;
    let j = 0;
    while (i < group.length || j < add.length) {
      const next = j >= add.length || (i < group.length && group[i]! <= add[j]!) ? group[i++]! : add[j++]!;
      if (merged.at(-1) !== next) merged.push(next);
      if ((i + j) % 1000 === 0) await breathe();
    }
    group.length = 0;
    for (let k = 0; k < merged.length; k++) {
      group.push(merged[k]!);
      if (k % 1000 === 999) await breathe();
    }
  }
}

/**
 * Plan 68 (Codex R40): a mailbox's stored locations, 2,000 UIDs a page where the store pages (its reads hold the loop),
 * a turn between pages every few milliseconds; whole where it doesn't (in memory)
 */
export async function readMailbox<L extends { uid: number }>(
  locations: { inMailbox(mailbox: string, uidvalidity: number): Promise<L[]>; inMailboxPage?(mailbox: string, uidvalidity: number, afterUid: number, limit: number): Promise<L[]> },
  mailbox: string,
  uidvalidity: number,
): Promise<L[]> {
  if (!locations.inMailboxPage) return locations.inMailbox(mailbox, uidvalidity);
  const breathe = breather();
  const all: L[] = [];
  for (let after = 0; ; ) {
    const page = await locations.inMailboxPage(mailbox, uidvalidity, after, 2000);
    for (const l of page) all.push(l);
    if (page.length < 2000) return all;
    after = page.at(-1)!.uid;
    await breathe();
  }
}

/**
 * Plan 107 (Codex code review round 11 #4): a mailbox generation's message ids, a page at a time with a turn between
 * (never a whole mailbox's places mapped at once)
 */
export async function mailboxIds(
  locations: { inMailbox(mailbox: string, uidvalidity: number): Promise<{ message_id: number }[]>; inMailboxPage?(mailbox: string, uidvalidity: number, afterUid: number, limit: number): Promise<{ message_id: number; uid: number }[]> },
  mailbox: string,
  uidvalidity: number,
): Promise<number[]> {
  const breathe = breather();
  const ids: number[] = [];
  if (!locations.inMailboxPage) {
    const all = await locations.inMailbox(mailbox, uidvalidity);
    for (let i = 0; i < all.length; i++) {
      ids.push(all[i]!.message_id);
      if ((i & 4095) === 4095) await breathe();
    }
    return ids;
  }
  for (let after = 0; ; ) {
    const page = await locations.inMailboxPage(mailbox, uidvalidity, after, 2000);
    for (const l of page) ids.push(l.message_id);
    if (page.length < 2000) return ids;
    after = page.at(-1)!.uid;
    await breathe();
  }
}

/**
 * Plan 107: what a forgotten mailbox's messages become, 500 at a time with a turn whenever a few ms went: `only`
 * placed nowhere else (removed), `kept` held (journaled), and `rest`, the places that just go (the mail in them is
 * placed elsewhere, or a local one). Gathered in the one pass (Codex code review round 11 #4: a Set of the first two
 * and a filter of the whole mailbox after it was ~72 ms for a million ids, at once).
 */
export async function sortForgotten(
  ids: readonly number[],
  path: string,
  hold: (id: number) => boolean,
  read: { unresolved(ids: readonly number[]): Promise<number[]>; of(ids: readonly number[]): Promise<{ message_id: number; mailbox: string }[]>; providerIds(ids: readonly number[]): Promise<Map<number, string | null>> },
  check: () => void = () => {},
): Promise<{ only: number[]; kept: number[]; rest: number[] }> {
  const only: number[] = [];
  const kept: number[] = [];
  const rest: number[] = [];
  const breathe = breather();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const held = new Set(await read.unresolved(chunk));
    const elsewhere = new Set((await read.of(chunk)).filter((l) => l.mailbox !== path).map((l) => l.message_id));
    const identities = await read.providerIds(chunk);
    for (const id of chunk) {
      if (!held.has(id) && !elsewhere.has(id) && !identities.get(id)?.startsWith("local:")) (hold(id) ? kept : only).push(id);
      else rest.push(id);
    }
    check();
    await breathe();
  }
  return { only, kept, rest };
}

/**
 * Plan 68 (Codex R44): the journal with these ids added, gathered a few thousand at a time (a big expunge's 500,000
 * onto 200,000 was 28 ms at once); null when nothing new
 */
export async function journalUnion(journaled: readonly number[], ids: Iterable<number>): Promise<number[] | null> {
  const next = new Set<number>();
  await addAll(next, journaled);
  const before = next.size;
  await addAll(next, ids);
  return next.size === before && before === journaled.length ? null : [...next];
}

/**
 * Plan 68 (Codex R46): a sweep's stored locations split against the server's UIDs, a few thousand at a time: by UID,
 * the ones gone, and the UIDs still there
 */
export async function partitionKnown<K extends { uid: number }>(known: readonly K[], serverUids: ReadonlySet<number>): Promise<{ byUid: Map<number, K>; gone: K[]; stillThere: number[] }> {
  const breathe = breather();
  const byUid = new Map<number, K>();
  const gone: K[] = [];
  const stillThere: number[] = [];
  for (let i = 0; i < known.length; i++) {
    const k = known[i]!;
    byUid.set(k.uid, k);
    if (serverUids.has(k.uid)) stillThere.push(k.uid);
    else gone.push(k);
    if (i % 5000 === 4999) await breathe();
  }
  return { byUid, gone, stillThere };
}

/**
 * Messages that may have lost places: their flags from the places left, and the ones with none (orphans: a local
 * optimistic send with no server copy yet is kept) removed unless `keepOrphans`. A chunk of 500 at a time, its flag
 * updates sent with it and the loop given a turn between chunks (plan 68, Codex R49: 50,000 at once, 64 ms, every
 * update in one batch).
 */
export async function reconcileMessages(
  messageIds: Iterable<number>,
  deps: {
    of(ids: number[]): Promise<readonly { message_id: number; mailbox: string; flags: string }[]>;
    observe?(ids: number[]): Promise<readonly ImapLocation[]>;
    check?(): void;
    providerIds(ids: number[]): Promise<ReadonlyMap<number, string | null>>;
    state(locs: { mailbox: string; flags: string }[]): FlagUpdate["flags"];
    updateFlags(updates: FlagUpdate[]): Promise<void>;
    removeMessages(ids: number[]): Promise<void>;
  },
  keepOrphans = false,
): Promise<number[]> {
  const ids = [...messageIds];
  if (ids.length === 0) return [];
  const orphans: number[] = [];
  const breathe = breather();
  for (let i = 0; i < ids.length; i += 500) {
    const updates: FlagUpdate[] = [];
    const chunk = ids.slice(i, i + 500);
    const providerIds = await deps.providerIds(chunk);
    deps.check?.();
    const rows = deps.observe ? await deps.observe(chunk) : await deps.of(chunk);
    deps.check?.();
    const byMessage = new Map<number, { mailbox: string; flags: string }[]>();
    for (const r of rows) {
      const list = byMessage.get(r.message_id);
      if (list) list.push(r);
      else byMessage.set(r.message_id, [r]);
    }
    for (const id of chunk) {
      const locs = byMessage.get(id);
      if (!locs) {
        if (providerIds.has(id) && !providerIds.get(id)?.startsWith("local:")) orphans.push(id);
        continue;
      }
      const identity = providerIds.get(id);
      if (!identity) continue;
      updates.push({ messageId: id, expectedProviderMsgId: identity, ...(deps.observe && { expectedImapLocations: locs as ImapLocation[] }), flags: deps.state(locs) });
    }
    deps.check?.();
    if (updates.length) await deps.updateFlags(updates);
    await breathe();
  }
  // the orphans removed 100 at a time with a turn between (Codex R53: a folder of 50,000 deleted in one transaction,
  // its threads recomputed, 1.8 s)
  if (!keepOrphans) {
    for (let i = 0; i < orphans.length; i += 100) {
      await deps.removeMessages(orphans.slice(i, i + 100));
      await breathe();
    }
  }
  return orphans;
}

/** Plan 68 (Codex R42): these ids into a set, a few thousand at a time with the loop given turns */
export async function addAll(target: Set<number>, ids: Iterable<number>): Promise<void> {
  const breathe = breather();
  let n = 0;
  for (const id of ids) {
    target.add(id);
    if (++n % 5000 === 0) await breathe();
  }
}

/** Plan 68 (Codex R20, R39): every stored twin of an envelope, 500 a page, the loop given a turn every few milliseconds */
export async function readTwins(page: (after: number) => Promise<readonly number[]>): Promise<number[]> {
  const breathe = breather();
  const group: number[] = [];
  for (let after = 0; ; ) {
    const ids = await page(after);
    for (const id of ids) group.push(id);
    if (ids.length < 500) return group;
    after = ids.at(-1)!;
    await breathe();
  }
}

/** an envelope's key among the twins kept in a pass (its Message-ID, or none) */


/**
 * Plan 68 (Codex R32): the held-back messages' candidates and every place of theirs, by mailbox, read 500 at a time and
 * gathered a few milliseconds a turn (150,000 of them were 50 ms at once before the planner began).
 */
export async function gatherPlaces<L extends { message_id: number; mailbox: string; uid: number; uidvalidity: number }>(
  list: readonly { candidates: readonly number[] }[],
  of: (ids: number[]) => Promise<readonly L[]>,
): Promise<{ places: Map<number, L[]>; byMailbox: Map<string, { uidvalidity: number; uids: Set<number> }> }> {
  const breathe = breather();
  const places = new Map<number, L[]>();
  const ids: number[] = [];
  const lists = new Set<readonly number[]>();
  for (const a of list) {
    if (lists.has(a.candidates)) continue;
    lists.add(a.candidates);
    for (const id of a.candidates) {
      if (places.has(id)) continue;
      places.set(id, []);
      ids.push(id);
      if (ids.length % 1000 === 0) await breathe();
    }
  }
  const byMailbox = new Map<string, { uidvalidity: number; uids: Set<number> }>();
  for (let i = 0; i < ids.length; i += 500) {
    for (const l of await of(ids.slice(i, i + 500))) {
      places.get(l.message_id)!.push(l);
      const box = byMailbox.get(l.mailbox) ?? { uidvalidity: l.uidvalidity, uids: new Set<number>() };
      box.uids.add(l.uid);
      byMailbox.set(l.mailbox, box);
    }
    await breathe();
  }
  return { places, byMailbox };
}

/** Plan 68 (Codex R23, R24): a folder's UIDNEXT, kept below its first held-back message (a loop: any number of them) */
export function heldUidnext(uidnext: number, held: readonly { uid: number }[]): number {
  let at = uidnext;
  for (const a of held) if (a.uid < at) at = a.uid;
  return at;
}

/** Plan 68 (Codex R15): message ids looked at a window at a time for ones with no location */
const UNLOCATED_SPAN = 5000;
/** plan 79: how many of a new account's newest Inbox messages come in first */
const PREVIEW = 250;

/** Plan 68: a LIST longer than this is cut before any work (a catalog keeps FOLDERS_PER_ACCOUNT_MAX at most). */
const LISTED_MAX = 2 * FOLDERS_PER_ACCOUNT_MAX;

/** Plan 68: a mailbox as STATUS compares it (its message count, its mod-sequence where the server has one). */
interface Snapshot {
  messages: number;
  modseq?: string;
}
const snapshotOf = (mb: { exists: number; highestModseq?: bigint }): Snapshot => ({ messages: mb.exists, ...(mb.highestModseq !== undefined && { modseq: String(mb.highestModseq) }) });

/** Plan 68: without HIGHESTMODSEQ, flag changes don't show in STATUS: a quiet folder is checked on every fourth pass. */
const CHECK_EVERY = 4;

type ListedMailbox = Awaited<ReturnType<ImapFlow["list"]>>[number];

function classifyMailbox(mailbox: ListedMailbox) {
  let groupOnly = false, unusable = false, specialUse = false;
  for (const flag of mailbox.flags) {
    const value = flag.toLowerCase();
    if (value === "\\noselect") groupOnly = true;
    else if (value === "\\nonexistent") unusable = true;
    else if (SPECIAL_USE_LOWER.has(value) || value === "\\flagged" || value === "\\important") specialUse = true;
  }
  return { mailbox, groupOnly, unusable, specialUse };
}
const selectableMailbox = (m: ListedMailbox) => {
  const attributes = classifyMailbox(m);
  return !attributes.groupOnly && !attributes.unusable;
};

/**
 * Plan 68: the account's own folders in a LIST: what holds no role, isn't a server special (Gmail's Starred,
 * Important…) and exists. A \Noselect parent is listed only to group folders under it. A leading INBOX in the
 * path (servers that keep every folder under it) isn't shown. Bounded: names, path length and count.
 */
export function customFolders(list: readonly ListedMailbox[], roles: Partial<Record<Role, string>>): ProviderFolder[] {
  // paths compare exactly (a server may hold "Sent" and "sent"); only INBOX is case-insensitive (RFC 3501, Codex R2)
  const rolePaths = new Set(Object.values(roles) as string[]);
  // (a long name is never upper-cased only to be compared with INBOX: Codex R17)
  const isInbox = (name: string) => name.length === 5 && name.toUpperCase() === "INBOX";
  const isRole = (m: ListedMailbox, specialUse: boolean) => rolePaths.has(m.path) || isInbox(m.path) || Boolean(m.specialUse && m.specialUseSource !== "name") || specialUse;
  // bounded before any work (Codex R1): a server listing more than this is cut, never walked whole
  const bounded = list.length > LISTED_MAX ? list.slice(0, LISTED_MAX) : list;
  const candidates: ReturnType<typeof classifyMailbox>[] = [];
  const groups = new Set<string>();
  for (const m of bounded) {
    if (m.path.length > 1000) continue;
    const candidate = classifyMailbox(m);
    if (candidate.unusable || (isRole(m, candidate.specialUse) && (!candidate.groupOnly || isInbox(m.path)))) continue;
    candidates.push(candidate);
    if (candidate.groupOnly) groups.add(m.path);
  }
  const names = (m: ListedMailbox) => {
    const parts = m.delimiter ? m.path.split(m.delimiter) : [m.path];
    if (parts.length > 1 && isInbox(parts[0]!)) parts.shift();
    // whole segments (a path is at most 1,000 characters): a shortened one could merge two hierarchies (Codex R9)
    return parts;
  };
  // a group with nothing under it says nothing: the ancestors of every real folder, gathered once (linear, Codex R1)
  // Only groups need it (none: no walk at all), and only prefixes as long as a group's are looked up; deepest first,
  // stopping at one already there, its own ancestors having come with it; a sibling of the last folder seen is
  // recognised by its prefix, never its parent built and hashed again (Codex R46: 10,000 paths sharing twenty
  // levels rebuilt every shared prefix, 153 ms)
  const ancestors = new Set<string>();
  const groupLengths = new Set([...groups].map((p) => p.length));
  let lastParent = "";
  for (const { mailbox: m, groupOnly } of groups.size ? candidates : []) {
    if (groupOnly || !m.delimiter) continue;
    const parent = m.path.lastIndexOf(m.delimiter);
    if (parent > 0 && parent === lastParent.length && m.path[parent] === m.delimiter && m.path.startsWith(lastParent)) continue;
    for (let i = parent; i > 0; i = m.path.lastIndexOf(m.delimiter, i - 1)) {
      if (!groupLengths.has(i)) continue;
      const ancestor = m.path.slice(0, i);
      if (ancestors.has(ancestor)) break;
      if (groups.has(ancestor)) ancestors.add(ancestor);
    }
    lastParent = parent > 0 ? m.path.slice(0, parent) : "";
  }
  return candidates
    .filter((candidate) => !candidate.groupOnly || ancestors.has(candidate.mailbox.path))
    .map(({ mailbox: m, groupOnly }) => ({ key: m.path, path: names(m), selectable: !groupOnly }))
    // in the server's order: the sidebar draws them by name, a step at a time (Codex R17: a sort here of 10,000 long
    // names was 50 ms on the backend's loop, every pass)
    .slice(0, FOLDERS_PER_ACCOUNT_MAX);
}

export interface ImapProviderOptions {
  /** plaintext/self-signed servers (tests, local bridges like Proton Bridge) */
  allowInsecure?: boolean;
  /** max bodies downloaded per sync pass */
  bodiesPerSync?: number;
  /** tests only: shorter timeouts (plan 20), so a dead socket is found in seconds */
  timeouts?: Partial<ImapTimeouts>;
}

export interface ImapTimeouts {
  /** connect + TLS + greeting budget */
  connectMs: number;
  /** a command session quiet this long is dead (a stuck command fails; an idle session closes) */
  socketMs: number;
  /** how long IDLE has to answer the heartbeat's NOOP */
  heartbeatMs: number;
  /** IDLE heard nothing this long: the next sync pings it */
  quietMs: number;
  /** IDLE reconnect backoff: first wait and cap */
  reconnectMs: number;
  reconnectMaxMs: number;
  /** SMTP's socket timeout (a stall after DATA is ambiguous either way) */
  smtpSocketMs: number;
}

export const IMAP_TIMEOUTS: ImapTimeouts = {
  connectMs: 20_000,
  socketMs: 60_000,
  heartbeatMs: 15_000,
  quietMs: 60_000,
  reconnectMs: 1000,
  reconnectMaxMs: 60_000,
  smtpSocketMs: 60_000,
};

const SPECIAL_USE: Record<string, Role> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Archive": "archive",
  "\\All": "all",
  "\\Junk": "junk",
  "\\Trash": "trash",
  "\\Drafts": "drafts",
};

const SPECIAL_USE_LOWER = new Map(Object.entries(SPECIAL_USE).map(([flag, role]) => [flag.toLowerCase(), role]));
const roleForFlag = (flag: string): Role | undefined => SPECIAL_USE_LOWER.get(flag.toLowerCase());
const isSpecialUseFlag = (flag: string) => roleForFlag(flag) !== undefined || flag.toLowerCase() === "\\flagged" || flag.toLowerCase() === "\\important";

const NAME_HINTS: Record<Exclude<Role, "inbox" | "all">, RegExp> = ROLE_NAME_HINTS;

// RFC 5530 codes for a refusal that passes: the server is busy, the mailbox in use, a limit hit, its own bug
const TEMPORARY_CODES = new Set(["UNAVAILABLE", "INUSE", "LIMIT", "SERVERBUG", "THROTTLED"]);
// what servers say without a code (Gmail: "[ALERT] Too many simultaneous connections", "Account exceeded
// command or bandwidth limits"; Microsoft: "Request is throttled"). Never a credentials message.
const TEMPORARY_TEXT = /too many (?:simultaneous |concurrent )?connections|bandwidth limit|exceeded command|request is throttled|try (?:again )?later|temporar(?:il)?y (?:unavailable|failure)|server (?:is )?busy/i;

// RFC 5530 codes that are about the credentials or the account: never "later", whatever the text says
const CREDENTIAL_CODES = new Set(["AUTHENTICATIONFAILED", "AUTHORIZATIONFAILED", "EXPIRED", "PRIVACYREQUIRED", "CONTACTADMIN", "NOPERM"]);

/** A refusal the server means to pass (throttling, limits, busy): try again later, never "sign in again" or "failed". */
export function temporaryRefusal(error: unknown): boolean {
  const e = error as { code?: unknown; serverResponseCode?: unknown; response?: unknown; responseText?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.code === "ETHROTTLE") return true;
  const code = typeof e.serverResponseCode === "string" ? e.serverResponseCode.toUpperCase() : "";
  // an explicit credentials code wins over a "try again later" in its text (retrying a wrong password locks accounts)
  if (CREDENTIAL_CODES.has(code)) return false;
  if (TEMPORARY_CODES.has(code)) return true;
  const text = [e.message, e.response, e.responseText].filter((part): part is string => typeof part === "string").join(" ");
  return TEMPORARY_TEXT.test(text);
}

export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof ImapIdentityError) return new ProviderIdentityError(L("errors.imap.identityUnavailable"));
  const e = error as { authenticationFailed?: boolean; serverResponseCode?: string; code?: string; responseStatus?: string; message?: string };
  const message = e?.message ?? String(error);
  // the server refused the login: a sign-in to redo (plan 25), unless it says the refusal is temporary
  // (RFC 5530, or "too many connections": the user's other mail apps hold the server's slots)
  if (e.authenticationFailed) return temporaryRefusal(error) ? ProviderError.deferred(L("errors.imap.loginFailed", { detail: message })) : new ProviderAuthError(L("errors.imap.loginFailed", { detail: message }));
  // throttled or busy: the same command later works
  if (temporaryRefusal(error)) return ProviderError.deferred(`IMAP: ${message}`);
  if (e.responseStatus === "NO" || e.responseStatus === "BAD") return new ProviderError(`IMAP: ${message}`, false);
  // the server couldn't be reached or the connection died (plan 20): waits for the network
  if (isNetworkError(error)) return ProviderError.network(`IMAP: ${message}`);
  return new ProviderError(`IMAP: ${message}`, true);
}

/** imapflow resolves false when a STORE, MOVE, COPY or DELETE fails; its logger keeps why (makeClient) */
const commandErrors = new WeakMap<ImapFlow, { err?: unknown }>();
/** forget an earlier command's error before the one whose result is read */
function clearRefusal(c: ImapFlow): void { const box = commandErrors.get(c); if (box) box.err = undefined; }
/**
 * Why a command imapflow resolved false failed: the server refused it for now (retry), refused it
 * (it didn't happen), or nothing says (no tagged reply: an ACK may be lost, the change is unknown).
 */
function refusal(c: ImapFlow): "temporary" | "refused" | "unknown" {
  return refusalOf(c).why;
}
/** The refusal and the command it answered (imapflow's executedCommand: "<tag> UID COPY …" → "COPY"). */
function refusalOf(c: ImapFlow): { why: "temporary" | "refused" | "unknown"; command?: string } {
  const box = commandErrors.get(c);
  const err = box?.err as { responseStatus?: unknown; executedCommand?: unknown } | undefined;
  if (box) box.err = undefined;
  if (!err) return { why: "unknown" };
  const command = typeof err.executedCommand === "string" ? /^\S+\s+(?:UID\s+)?([A-Za-z]+)/.exec(err.executedCommand)?.[1]?.toUpperCase() : undefined;
  if (temporaryRefusal(err)) return { why: "temporary", command };
  return { why: err.responseStatus === "NO" || err.responseStatus === "BAD" ? "refused" : "unknown", command };
}

/** The server answered a change with a tagged refusal: it didn't happen, so it is never "unknown" (withConnection). */
class RefusedChangeError extends ProviderError {}

/**
 * Throws for a change imapflow resolved false: a temporary refusal is retried, a refusal fails, and
 * with no reply at all `unknown` decides (a MOVE may have happened if only its ACK was lost).
 */
function refusedChange(c: ImapFlow, detail: string | Localized, unknown: "ambiguous" | "refused" = "ambiguous", why = refusal(c)): never {
  if (why === "temporary") throw Object.defineProperty(new RefusedChangeError(detail, true), "deferred", { value: true });
  if (why === "refused") throw new RefusedChangeError(detail, false);
  // no tagged reply: withConnection decides (a dead session after the change makes it unknown)
  throw new ProviderError(detail, unknown === "ambiguous");
}

const messageKey = (id: string | undefined | null) => (id ? id.replace(/[<>]/g, "").trim().toLowerCase() : null);

function hasAttachmentPart(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.disposition === "attachment") return true;
  return (node.childNodes ?? []).some(hasAttachmentPart);
}

/** plan 101: a folder that refuses its backfill read is tried by this many passes before it's left out */
const BACKFILL_FOLDER_TRIES = 3;

/** The address fields fetched raw beside the envelope (plan 34: parsed by us, the envelope's when one is missing). */
const ADDRESS_HEADERS = ["from", "to", "cc", "bcc", "reply-to"];

function headerValue(headers: Buffer | undefined, name: string): string | null {
  if (!headers) return null;
  const text = headers.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  const m = new RegExp(`^${name}:\\s*(.*)$`, "im").exec(text);
  return m ? m[1]!.trim() : null;
}

export function createImapProvider(ctx: ProviderContext, options: ImapProviderOptions = {}): MailProvider {
  const config = ctx.config as unknown as ImapAccountConfig;
  const store = ctx.store;
  const locations = store.locations;
  const accountId = ctx.account.id;
  let client: ImapFlow | null = null;
  let roles: Partial<Record<Role, string>> | null = null;
  const timeouts: ImapTimeouts = { ...IMAP_TIMEOUTS, ...options.timeouts };
  /** IDLE loops of this account (normally one): reset() restarts them, a sync pings them */
  const watchers = new Set<{ restart(): void; ping(): void; signedIn(): void }>();

  const makeClient = async (forIdle = false) => {
    const password = await ctx.getSecret("password");
    if (!password) throw new ProviderAuthError(L("errors.imap.noPassword"));
    const refused: { err?: unknown } = {};
    const made = new ImapFlow({
      host: config.imap.host,
      port: config.imap.port,
      secure: config.imap.secure,
      // never fall back to plaintext on a non-TLS port: a stripped STARTTLS would leak the password
      doSTARTTLS: options.allowInsecure ? false : config.imap.secure ? undefined : true,
      auth: { user: config.imap.user, pass: password },
      // nothing is logged; the one warning kept is a command's error imapflow resolves false on (see refusal())
      // (no debug/info methods, so imapflow never reaches them, as with logger: false)
      logger: { warn: (entry: unknown) => { if (entry && typeof entry === "object" && "err" in entry) refused.err = entry.err; }, error() {}, fatal() {} } as unknown as NonNullable<ConstructorParameters<typeof ImapFlow>[0]>["logger"],
      maxLiteralSize: MAX_INCOMING_MIME_BYTES + 1,
      maxResponseSize: MAX_INCOMING_MIME_BYTES + 65536,
      disableAutoIdle: !forIdle,
      tls: options.allowInsecure ? { rejectUnauthorized: false } : undefined,
      connectionTimeout: timeouts.connectMs,
      // Plan 20: a command session quiet for a minute is closed (imapflow's timeout without IDLE), so a
      // socket a network change killed is never reused after a quiet minute, and a command stuck on one
      // fails in a minute instead of five. IDLE keeps imapflow's 5 minutes; the heartbeat checks it sooner.
      ...(forIdle ? {} : { socketTimeout: timeouts.socketMs }),
    });
    commandErrors.set(made, refused);
    return made;
  };

  /** bumped by reset(): a session that was connecting across a network change is never kept */
  let generation = 0;
  /** the one connect in flight: a sync and an op asking together share it */
  let connecting: { gen: number; promise: Promise<ImapFlow>; session: ImapFlow | null } | null = null;

  function connection(): Promise<ImapFlow> {
    if (client?.usable) return Promise.resolve(client);
    if (connecting && connecting.gen === generation) return connecting.promise;
    const attempt: NonNullable<typeof connecting> = { gen: generation, session: null, promise: null as unknown as Promise<ImapFlow> };
    attempt.promise = (async () => {
      const c = await makeClient();
      attempt.session = c;
      c.on("error", () => {});
      // the server may BYE us (e.g. UIDVALIDITY reset, idle timeout): never reuse a dead session
      c.on("close", () => {
        if (client === c) client = null;
      });
      // a reset while the secret was read: never start on the old network
      if (attempt.gen !== generation) throw ProviderError.network(L("errors.network.changed"));
      try {
        await c.connect();
      } catch (error) {
        throw toProviderError(error);
      }
      if (attempt.gen !== generation) {
        // it may have connected over the route that just went away
        c.close();
        throw ProviderError.network(L("errors.network.changed"));
      }
      client = c;
      // the password works: an IDLE loop a refused login stopped comes back
      for (const w of watchers) w.signedIn();
      return c;
    })().finally(() => {
      if (connecting === attempt) connecting = null;
    });
    connecting = attempt;
    return attempt.promise;
  }

  /** Retry only while no non-idempotent message mutation could have reached the server. */
  async function withConnection<T>(fn: (c: ImapFlow, beforeMutation: () => void) => Promise<T>): Promise<T> {
    const run = async (session: ImapFlow): Promise<T> => {
      let mutated = false;
      try {
        return await fn(session, () => {
          if (!session.usable) throw ProviderError.network(L("errors.network.changed"));
          mutated = true;
        });
      } catch (error) {
        const e = toProviderError(error);
        // a tagged refusal is an answer: the change didn't happen (retried later if the server only was busy)
        if (e instanceof RefusedChangeError) throw e;
        // ImapFlow can return false after losing an ACK. Keep the boundary across sources and
        // local writes too: even a later SELECT failure must not repeat an earlier COPY.
        if (mutated && (e.retryable || e instanceof ProviderIdentityError || !session.usable)) {
          if (client === session) client = null;
          session.close();
          throw new ProviderError(L("errors.imap.changeUnknown"), false, true);
        }
        throw e;
      }
    };
    let c: ImapFlow | null = null;
    try {
      c = await connection();
      return await run(c);
    } catch (error) {
      const e = toProviderError(error);
      // the server said "not now" on a working session: the op's own backoff waits, not an instant reconnect
      if (!e.retryable || e.deferred) throw e;
      // only the session that failed goes (another caller may already hold a fresh one); never LOGOUT on
      // it: on a dead socket that waits for the timeout
      if (c) {
        if (client === c) client = null;
        c.close();
      }
      try {
        return await run(await connection());
      } catch (again) {
        throw toProviderError(again);
      }
    }
  }

  async function discoverRoles(c: ImapFlow, listed?: readonly ListedMailbox[], previous = roles): Promise<Partial<Record<Role, string>>> {
    if (roles && !listed) return roles;
    const found: Partial<Record<Role, string>> = { inbox: "INBOX" };
    const list = listed ?? (await c.list());
    if (!listed) {
      const persisted = roles ? null : await ctx.loadCursor<Cursor>();
      // A sync may have published a newer LIST during either await; never reinterpret it through this old LIST.
      if (roles) return roles;
      previous = persisted?.roles ?? null;
    }
    const selectable = list.filter(selectableMailbox);
    for (const mb of selectable) for (const flag of mb.flags) {
      const role = roleForFlag(flag);
      if (role && previous?.[role] === mb.path && role !== "inbox") found[role] = mb.path;
    }
    for (const mb of selectable) for (const flag of mb.flags) {
      const role = roleForFlag(flag);
      if (role && !found[role]) found[role] = mb.path;
    }
    for (const [role, re] of Object.entries(NAME_HINTS) as [Role, RegExp][]) {
      if (found[role]) continue;
      const mb = selectable.find((m) => re.test(m.path) && ![...m.flags].some(isSpecialUseFlag));
      if (mb) found[role] = mb.path;
    }
    roles = found;
    return found;
  }

  const roleOf = (path: string): Role | undefined => (Object.entries(roles ?? {}) as [Role, string][]).find(([, p]) => p === path)?.[0];

  /** Message state is derived from where the message lives on the server (all its locations). */
  function stateFromLocations(locs: { mailbox: string; flags: string }[]): FlagUpdate["flags"] {
    const parsed = locs.map((l) => ({ role: roleOf(l.mailbox), flags: JSON.parse(l.flags) as string[] }));
    return {
      inInbox: parsed.some((l) => l.role === "inbox"),
      isTrash: parsed.length > 0 && parsed.every((l) => l.role === "trash"),
      isSpam: parsed.length > 0 && parsed.every((l) => l.role === "junk" || l.role === "trash") && parsed.some((l) => l.role === "junk"),
      isSent: parsed.some((l) => l.role === "sent"),
      isDraft: parsed.some((l) => l.role === "drafts" || l.flags.includes("\\Draft")),
      isRead: parsed.some((l) => l.flags.includes("\\Seen")),
      isStarred: parsed.some((l) => l.flags.includes("\\Flagged")),
    };
  }

  const upsertLocation = (messageId: number, mailbox: string, uidvalidity: number, uid: number, flags: string[]) => locations.upsert(messageId, mailbox, uidvalidity, uid, flags);

  /** `keepOrphans` (plan 68, Codex R3): a pass where a folder failed part-way may have taken locations it didn't give back yet: nothing is removed for it */
  const locatorKey = (id: number, mailbox: string, uidvalidity: number, uid: number) => JSON.stringify([id, mailbox, uidvalidity, uid]);

  async function observeLocations(c: ImapFlow, ids: number[], check: () => void, evidence?: ReadonlyMap<string, string>): Promise<ImapLocation[]> {
    const unresolved = new Set(await locations.unresolved(ids));
    const rows = (await locations.of(ids)).filter((l) => !unresolved.has(l.message_id));
    check();
    const byMailbox = new Map<string, ImapLocation[]>();
    for (const row of rows) {
      const captured = evidence?.get(locatorKey(row.message_id, row.mailbox, row.uidvalidity, row.uid));
      if (captured !== undefined) { row.flags = captured; continue; }
      const batch = byMailbox.get(row.mailbox) ?? [];
      batch.push(row);
      byMailbox.set(row.mailbox, batch);
    }
    for (const [mailbox, batch] of byMailbox) {
      const lock = await c.getMailboxLock(mailbox);
      try {
        check();
        await assertValidity(c, mailbox, batch);
        for (let i = 0; i < batch.length; i += 500) {
          const expected = new Map(batch.slice(i, i + 500).map((row) => [row.uid, row]));
          for await (const message of c.fetch([...expected.keys()], { uid: true, flags: true }, { uid: true })) {
            check();
            const row = expected.get(message.uid);
            if (!row || !(message.flags instanceof Set)) throw new ProviderError(L("errors.imap.listRefused"), false);
            row.flags = JSON.stringify([...message.flags]);
            expected.delete(message.uid);
          }
          if (expected.size) throw new ProviderError(L("errors.imap.listRefused"), false);
        }
      } finally { lock.release(); }
    }
    check();
    return rows;
  }

  async function reconcile(messageIds: Iterable<number>, sink: SyncSink, keepOrphans: boolean, c: ImapFlow, authoritative: boolean, check: () => void, identities?: ReadonlyMap<number, string>, evidence?: ReadonlyMap<string, string>): Promise<number[]> {
    return reconcileMessages(messageIds, {
      of: async (ids) => { const held = new Set(await locations.unresolved(ids)); return (await locations.of(ids)).filter((l) => !held.has(l.message_id)); }, providerIds: (ids) => identities ? Promise.resolve(identities) : store.providerIds(ids), check,
      ...(authoritative && { observe: (ids: number[]) => observeLocations(c, ids, check, evidence) }),
      state: stateFromLocations, updateFlags: (u) => sink.updateFlags(u, authoritative ? undefined : { authoritative: false }),
      removeMessages: (ids) => sink.removeMessages(ids),
    }, keepOrphans);
  }

  /** Plan 68 (Codex R8, R9): messages about to lose locations, written down durably first; reconciliation clears them. */
  async function journal(cursor: Cursor, ids: Iterable<number>) {
    const next = await journalUnion(cursor.unlocated ?? [], ids);
    if (next === null) return;
    cursor.unlocated = bounded(cursor, next, IMAP_JOURNAL_LIMITS.unlocated);
    await ctx.saveCursor(cursor);
  }

  /**
   * Plan 107 (Codex R1): a mailbox the user deleted or renamed here is forgotten. What's elsewhere too stays, with the
   * places it has left; what was only there goes (`gone: "remove"`: the server deleted it), or is held and looked for
   * again as a vanished folder's mail is (`"hold"`: a renamed one's UID that didn't turn up under the new path). One
   * under an identity hold is left to it. Each step can run again: a pass stopped midway repeats it. Only this
   * UIDVALIDITY's places go, and the path's state only if it's this generation's, whether or not the LIST has a mailbox
   * at the path again (`live`; Codex code review round 6 #1: Work → Job, Work created again, Job deleted took the new
   * Work's mail; round 8: a record never applies to another generation of its path, so another one cached for a path
   * that's gone is left to the vanished-folder pass). With no UIDVALIDITY (a record from before), a gone path's all go.
   */
  async function forgetMailbox(cursor: Cursor, path: string, uidvalidity: number | undefined, gone: "remove" | "hold", sink: SyncSink, c: ImapFlow, check: () => void, seen?: ReadonlySet<number>, live = false) {
    const ids = uidvalidity ? await mailboxIds(locations, path, uidvalidity) : [];
    // one a folder read this pass met again (`seen`: moved there by another app) isn't proven gone: it's held
    const read = { unresolved: (x: readonly number[]) => locations.unresolved(x), of: (x: readonly number[]) => locations.of(x), providerIds: (x: readonly number[]) => store.providerIds(x) };
    const { only, kept, rest: placed } = await sortForgotten(ids, path, (id) => gone === "hold" || Boolean(seen?.has(id)), read, check);
    const breathe = breather();
    for (let i = 0; i < only.length; i += 100) {
      await sink.removeMessages(only.slice(i, i + 100));
      await breathe();
    }
    if (kept.length) {
      // written down before they go (Codex R9), as a vanished folder's are
      await journal(cursor, kept);
      await locations.removeMany(kept, path);
    }
    // the places left go with no hold (the mail in them is placed elsewhere, or went with the mailbox); their flags follow
    const scoped = live || uidvalidity !== undefined;
    let rest: number[];
    if (scoped) {
      rest = placed;
      await locations.removeMany(rest, path, { deleted: true });
    } else rest = await locations.resetMailbox(path, { deleted: true });
    await reconcile(rest, sink, gone === "hold", c, false, check);
    // its state goes if it's this generation's (a folder created again under the path is another)
    const mine = scoped ? uidvalidity !== undefined && cursor.mailboxes[path]?.uidvalidity === uidvalidity : true;
    if (mine) {
      delete cursor.mailboxes[path];
      if (cursor.resetPending) delete cursor.resetPending[path];
      if (cursor.backfill) {
        delete cursor.backfill.below[path];
        if (cursor.backfill.failed) delete cursor.backfill.failed[path];
        if (cursor.backfill.held) delete cursor.backfill.held[path];
      }
    }
    if (cursor.previewed && (!scoped || cursor.previewed[path] === uidvalidity)) delete cursor.previewed[path];
    if (cursor.backfill) cursor.backfill.done = cursor.backfill.done.filter((k) => k.slice(0, k.lastIndexOf(":")) !== path || (scoped && k !== `${path}:${uidvalidity}`));
  }

  /** Plan 107: a fresh LIST for a folder change: the account's own folders and roles now, and imapflow's namespace prefix. */
  async function folderCatalog(c: ImapFlow) {
    const list = await c.list();
    const cursor = await ctx.loadCursor<Cursor>();
    const r = await discoverRoles(c, list, cursor?.roles ?? roles);
    const generations = await recordedGenerations(c, list, cursor);
    const folders = withExcept(customFolders(list, r), cursor, generations);
    return { list, roles: r, folders, own: new Set(folders.map((f) => f.key)), prefix: c.namespace?.prefix ?? "", generations };
  }

  /** Plan 107: a mailbox's UIDVALIDITY now, for a record about to be written: STATUS failing stops the change. */
  async function serverGeneration(c: ImapFlow, path: string): Promise<number> {
    const status = await c.status(path, { uidValidity: true });
    const v = Number(status && status.uidValidity);
    if (!Number.isSafeInteger(v) || v <= 0) throw new ProviderError(L("errors.network.changed"), true);
    return v;
  }

  /** Plan 107: a selectable mailbox's UIDVALIDITY now (STATUS); null: STATUS couldn't say. */
  async function generationOf(c: ImapFlow, path: string): Promise<number | null> {
    return c.status(path, { uidValidity: true }).then((s) => (s && Number(s.uidValidity)) || null, () => null);
  }

  /**
   * Plan 107 (Codex code review round 8): the generation now of each listed, selectable path a pending rename or
   * delete names (its old path, the path it was listed under), one STATUS each: what decides whether a record's
   * generation is still there or another mailbox has the path. Only those paths: a handful, never the whole LIST.
   */
  async function recordedGenerations(c: ImapFlow, list: readonly ListedMailbox[], cursor: Cursor | null | undefined): Promise<Map<string, number | null>> {
    const named = new Set<string>();
    for (const r of Object.values(cursor?.renamed ?? {})) { named.add(r.from); if (r.key) named.add(r.key); }
    for (const [path, r] of Object.entries(cursor?.deleted ?? {})) { named.add(path); if (typeof r !== "number") named.add(r.from); }
    const out = new Map<string, number | null>();
    if (!named.size) return out;
    for (const m of list) if (named.has(m.path) && selectableMailbox(m)) out.set(m.path, await generationOf(c, m.path));
    return out;
  }

  /**
   * Plan 107 (Codex code review round 8 #1): the listing's folders, each with the generations cached under its path
   * that are another folder's: a pending rename's or delete's, the path listed again under another UIDVALIDITY (one
   * STATUS couldn't read is left out too: a generation's mail is never shown under another).
   */
  function withExcept(folders: ProviderFolder[], cursor: Cursor | null | undefined, generations: ReadonlyMap<string, number | null>): ProviderFolder[] {
    const except = new Map<string, number[]>();
    const away = (path: string, uidvalidity: number) => {
      if (!uidvalidity || !generations.has(path) || generations.get(path) === uidvalidity) return;
      except.set(path, [...(except.get(path) ?? []), uidvalidity]);
    };
    for (const r of Object.values(cursor?.renamed ?? {})) away(r.from, r.uidvalidity);
    for (const [path, r] of Object.entries(cursor?.deleted ?? {})) away(typeof r === "number" ? path : r.from, typeof r === "number" ? r : r.uidvalidity);
    if (!except.size) return folders;
    return folders.map((f) => (except.has(f.key) ? { ...f, except: except.get(f.key)! } : f));
  }

  /** Plan 107: a CREATE, RENAME or DELETE the server refused, in its own words (null: not a refusal, e.g. the connection). */
  function folderRefusal(error: unknown): { taken: boolean; reason: string } | null {
    const e = error as { responseStatus?: unknown; responseText?: unknown; serverResponseCode?: unknown; message?: unknown } | null;
    if (!e || (e.responseStatus !== "NO" && e.responseStatus !== "BAD")) return null;
    const taken = typeof e.serverResponseCode === "string" && e.serverResponseCode.toUpperCase() === "ALREADYEXISTS";
    return { taken, reason: serverReason(e.responseText) || serverReason(e.message) || String(e.responseStatus) };
  }
  const refused = (error: unknown, name: string) => {
    const r = folderRefusal(error);
    return r ? (r.taken ? nameTaken(name) : refusedBy(config.imap.host, r.reason)) : toProviderError(error);
  };
  const leaf = (m: { path: string; delimiter?: string | null }) => (m.delimiter ? m.path.split(m.delimiter).at(-1)! : m.path);

  /**
   * A UIDVALIDITY reset: every UID stored for the mailbox is meaningless now. Its messages are written down first,
   * durably (including `resetPending` and the journal), and only then unlocated. The store retains an
   * identity hold independently of those bounded journals, including after a disconnect.
   */
  async function resetLocations(cursor: Cursor, path: string, olduidvalidity: number, touched: Set<number>): Promise<Set<number>> {
    // plan 107: the old UIDVALIDITY is a mailbox renamed away and deleted here, the path a new one: its places are the
    // deletion's to forget once every folder is read, never held as a reset's (Codex code review round 6 #1); one
    // deleted here and made again likewise (Codex code review round 7 #2)
    if (Object.entries(cursor.deleted ?? {}).some(([p, r]) => typeof r === "number" ? p === path && r === olduidvalidity : r.from === path && r.uidvalidity === olduidvalidity)) return new Set();
    // one renamed away and made again: its places are the rename's proof, for the new path to claim (Codex code review
    // round 7 #1); the path's state goes now, so a folder read before it this pass knows it's another mailbox
    if (Object.values(cursor.renamed ?? {}).some((r) => r.from === path && r.uidvalidity === olduidvalidity)) {
      delete cursor.mailboxes[path];
      await ctx.saveCursor(cursor);
      return new Set();
    }
    // every id gathered a few thousand at a time, the loop given turns (Codex R42: 500,000 merged at once, 80 ms)
    const ids = new Set<number>();
    await addAll(ids, cursor.resetPending?.[path] ?? []);
    await addAll(ids, (await readMailbox(locations, path, olduidvalidity)).map((l) => l.message_id));
    const list = [...ids];
    cursor.resetPending ??= Object.create(null) as Record<string, number[]>;
    cursor.resetPending[path] = bounded(cursor, list, resetRoom(cursor.resetPending, path), "oldest");
    const journaled = new Set<number>();
    await addAll(journaled, cursor.unlocated ?? []);
    await addAll(journaled, list);
    cursor.unlocated = bounded(cursor, [...journaled], IMAP_JOURNAL_LIMITS.unlocated);
    await ctx.saveCursor(cursor);
    await addAll(ids, await locations.resetMailbox(path));
    await addAll(touched, ids);
    return ids;
  }

  /** Unknown locators never establish logical identity from an envelope or arrival order. */
  async function syncMailbox(c: ImapFlow, path: string, cursor: Cursor, sink: SyncSink, touched: Set<number>, opts: { reidentify?: boolean; checkpoint?: Snapshot | null; introduced: Set<number>; preview?: number; uids?: number[]; heldUids?: number[]; formerly?: { from: string; uidvalidity: number }; seen?: Set<number> }): Promise<number | undefined> {
    const lock = await c.getMailboxLock(path);
    try {
      const mb = c.mailbox;
      if (!mb) return;
      const uidvalidity = Number(mb.uidValidity);
      let state = cursor.mailboxes[path];
      const hadState = state !== undefined;
      // plan 79: a preview is a first read's newest messages only, before that read (nothing to preview after it)
      if (opts.preview !== undefined && hadState) return;
      // the validity this folder's stored places were read under: its state's, else a preview's (plan 79)
      const before = state?.uidvalidity ?? cursor.previewed?.[path];
      const reset = before !== undefined && before !== uidvalidity;
      // plan 101: older UIDs of a folder read before, as it was: a reset is the regular pass's (it reads the wider window)
      if (opts.uids && (!hadState || reset)) return;
      if (reset) {
        await resetLocations(cursor, path, before, touched);
        state = undefined;
      }
      const live = state !== undefined;
      const reidentify = reset || opts.reidentify === true;
      const searched = opts.uids ?? await c.search(state ? { uid: `${state.uidnext}:*` } : reidentify ? { all: true } : { since: new Date(sink.windowStart) }, { uid: true });
      if (!searched) throw new ProviderError(L("errors.imap.listRefused"), false);
      // a preview: the most recently arrived (highest UIDs) of the window
      const found = opts.uids ? opts.uids : state ? searched.filter((uid) => uid >= state!.uidnext) : opts.preview !== undefined ? searched.sort((a, b) => a - b).slice(-opts.preview) : searched;
      const fresh: IncomingMessage[] = [];
      const claimed = new Map<string, number>();
      let held = Infinity;
      for (let i = 0; i < found.length; i += 250) {
        const batch = found.slice(i, i + 250);
        const expected = new Set(batch);
        for await (const msg of c.fetch(batch, { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true, headers: ["references", "list-id", "list-unsubscribe", "list-unsubscribe-post", "precedence", "auto-submitted", ...ADDRESS_HEADERS] }, { uid: true })) {
          const m = msg as FetchMessageObject;
          if (!expected.delete(m.uid) || !(m.flags instanceof Set)) throw new ProviderError(L("errors.imap.listRefused"), false);
          const flags = [...m.flags];
          const env = m.envelope;
          let atLocation = await locations.at(path, uidvalidity, m.uid);
          // plan 107: a mailbox renamed here kept its UIDVALIDITY: the message at this UID under its old path is this one
          if (atLocation === null && opts.formerly?.uidvalidity === uidvalidity) atLocation = await locations.at(opts.formerly.from, uidvalidity, m.uid);
          if (atLocation !== null) {
            if (!(await locations.unresolved([atLocation])).length) {
              await upsertLocation(atLocation, path, uidvalidity, m.uid, flags);
              touched.add(atLocation);
            }
            continue;
          }
          if (!env) throw new ProviderError(L("errors.imap.listRefused"), false);
          const envelope = { subject: env.subject ?? "", fromEmail: (env.from?.[0]?.address ?? "").toLowerCase(), date: new Date(env.date ?? m.internalDate ?? 0).getTime(), size: m.size ?? 0, rfcMessageId: messageKey(env.messageId) };
          const fingerprint = `nomid:${createHash("sha1").update(`${envelope.date}|${envelope.fromEmail}|${envelope.subject}|${envelope.size}`).digest("hex")}`;
          let key = messageKey(env.messageId) ?? fingerprint;
          let existing = await store.messageByProviderId(key);
          if (existing && (existing.subject !== envelope.subject || existing.fromEmail !== envelope.fromEmail)) {
            key = `${key}#${fingerprint}`;
            existing = await store.messageByProviderId(key);
          }
          const candidates = new Set(await locations.twins(envelope, 0, 1));
          if (existing) candidates.add(existing.id);
          let uncertain = false;
          for (const id of candidates) {
            const here = await locations.get(id, path);
            // New imports have their own logical targets, including twins first seen in different folders.
            // Never assign an older logical target to a new place from its envelope.
            if ((await locations.unresolved([id])).length || (!opts.introduced.has(id) && (!here || here.uidvalidity !== uidvalidity))) { uncertain = true; break; }
          }
          // plan 107 (Codex code review round 4 #1): a deleted folder's message met here may be this one: not proven gone
          if (uncertain) for (const id of candidates) opts.seen?.add(id);
          if (uncertain) {
            held = Math.min(held, m.uid);
            opts.heldUids?.push(m.uid);
            continue;
          }
          if (existing || (claimed.has(key) && claimed.get(key) !== m.uid)) key = `${key}#${path}:${uidvalidity}:${m.uid}`;
          // A stable per-locator key that lost its locator also needs proof, never an ingest overwrite.
          if (await store.messageByProviderId(key)) { held = Math.min(held, m.uid); opts.heldUids?.push(m.uid); continue; }
          claimed.set(key, m.uid);
          const old = reidentify && new Date(env.date ?? m.internalDate ?? Date.now()).getTime() < sink.windowStart;
          if (old) continue;
          const role = roleOf(path);
          // the raw address fields, read by our parser (plan 34); the server's envelope where one is missing
          const addrs = messageAddresses(headerFields(m.headers), { from: env?.from, to: env?.to, cc: env?.cc, bcc: env?.bcc, replyTo: env?.replyTo });
          const incoming: IncomingMessage = {
            accountId,
            providerMsgId: key,
            providerThreadId: null,
            rfcMessageId: messageKey(env?.messageId),
            inReplyTo: env?.inReplyTo ? (splitIds(env.inReplyTo)[0] ?? null) : null,
            references: splitIds(headerValue(m.headers, "references")),
            from: addrs.from,
            to: addrs.to,
            cc: addrs.cc,
            bcc: addrs.bcc,
            replyTo: addrs.replyTo,
            subject: env?.subject ?? "",
            date: (env?.date ?? m.internalDate ?? new Date()).valueOf() as number,
            snippet: "",
            bodyText: null,
            bodyHtml: null,
            bodyState: "none",
            listId: parseListId(headerValue(m.headers, "list-id")),
            bulk: bulkHeaders({ listUnsubscribe: headerValue(m.headers, "list-unsubscribe"), precedence: headerValue(m.headers, "precedence"), autoSubmitted: headerValue(m.headers, "auto-submitted") }),
            unsubscribe: parseListUnsubscribe(headerValue(m.headers, "list-unsubscribe"), headerValue(m.headers, "list-unsubscribe-post")),
            isRead: flags.includes("\\Seen"),
            isStarred: flags.includes("\\Flagged"),
            inInbox: role === "inbox",
            isSent: role === "sent" || addrs.from.email === ctx.account.email.toLowerCase(),
            isDraft: role === "drafts" || flags.includes("\\Draft"),
            isTrash: role === "trash",
            isSpam: role === "junk",
            hasAttachments: hasAttachmentPart(m.bodyStructure),
            size: m.size ?? 0,
            locations: [{ mailbox: path, uidvalidity, uid: m.uid, flags }],
          };
          fresh.push(incoming);
        }
        if (expected.size) throw new ProviderError(L("errors.imap.listRefused"), false);
      }
      // old mail (plan 101) is never live: it notifies nothing, as a first sync's doesn't
      if (fresh.length) await sink.ingest(fresh, { live: live && !opts.uids });
      const inserted = await storedIds(fresh.map((m) => m.providerMsgId!), (key) => store.messageByProviderId(key));
      await addAll(touched, inserted);
      await addAll(opts.introduced, inserted);
      // a preview acknowledges nothing: the read after it takes the whole folder, finding these where they are
      // (its UIDVALIDITY, for the caller to keep)
      if (opts.preview !== undefined) return uidvalidity;
      // a backfill chunk acknowledges nothing either: the folder's own state (uidnext, its snapshot) is the regular pass's
      if (opts.uids) return uidvalidity;

      // a first read or a reset read everything now; a mailbox we had is acknowledged as its sweep saw it
      const seen: Snapshot | null = reset || !hadState ? snapshotOf(mb) : (opts.checkpoint ?? null);
      // a message set aside isn't acknowledged until it's told apart: a pass that stops first reads it again
      const uidnext = Math.min(Number(mb.uidNext), held);
      cursor.mailboxes[path] = { uidvalidity, uidnext, ...(seen && { messages: seen.messages, ...(seen.modseq !== undefined && { modseq: seen.modseq }) }) };
      if (cursor.resetPending) delete cursor.resetPending[path];
      if (cursor.previewed) {
        delete cursor.previewed[path];
        if (!Object.keys(cursor.previewed).length) delete cursor.previewed;
      }
      // one at a time: a folder may hold back more than an argument list takes (Codex R24: 150,000 copies)
    } finally {
      lock.release();
    }
  }


  /**
   * Plan 101: older mail a widened window asks for, after the pass's own work. Every folder read before is searched
   * for the span (`SINCE`/`BEFORE`, below its `uidnext`), its UIDs taken newest first 250 at a time through the
   * same identification as a first read, never live; progress saved a chunk at a time, at most BACKFILL_CHUNK_MS a
   * pass. A message held back for identity stays with the regular passes; it never blocks completion.
   */
  async function backfillMailboxes(c: ImapFlow, cursor: Cursor, sink: SyncSink, check: () => void) {
    const request = sink.backfill;
    if (!request) return;
    // saved progress for this request only, field by field; paths are keys, so a null prototype (a folder may be "__proto__")
    const saved = cursor.backfill;
    const counts = (v: unknown) => v && typeof v === "object" && Object.values(v).every((n) => Number.isSafeInteger(n) && (n as number) > 0);
    const valid = saved && saved.since === request.since && saved.until === request.until && Array.isArray(saved.done) && saved.done.every((k) => typeof k === "string")
      && counts(saved.below) && (saved.failed === undefined || counts(saved.failed))
      && (saved.held === undefined || (typeof saved.held === "object" && Object.values(saved.held).every((l) => Array.isArray(l) && l.every((uid) => Number.isSafeInteger(uid) && uid > 0))));
    const map = <T,>(from: Record<string, T> | undefined) => Object.assign(Object.create(null) as Record<string, T>, valid ? from : {});
    const state: NonNullable<Cursor["backfill"]> = cursor.backfill = {
      since: request.since, until: request.until, done: valid ? [...saved.done] : [],
      below: map(saved?.below), failed: map(saved?.failed), held: map(saved?.held),
    };
    const started = Date.now();
    const over = () => Date.now() - started > BACKFILL_CHUNK_MS;
    // one set for the whole run (Codex review): a twin read from INBOX earlier in it isn't held back in Projects
    const introduced = new Set<number>();
    const touched = new Set<number>();
    const pause = async () => { await settle(); await ctx.saveCursor(cursor); sink.backfillMore?.(); };
    // what the run read is reconciled like any pass's (Codex review: a location's flags changed meanwhile aren't lost)
    const settle = async () => { if (touched.size) { await reconcile(touched, sink, true, c, false, check); touched.clear(); } };
    let waiting = false;
    const keys = Object.keys(cursor.mailboxes).flatMap((path) => { const known = cursor.mailboxes[path]; return known ? [{ path, known, key: `${path}:${known.uidvalidity}` }] : []; });
    // plan 103: folders done of the run's folders
    // a count kept as folders finish (Codex review: never a scan per report)
    const finished = new Set(state.done);
    let doneCount = keys.filter((k) => finished.has(k.key)).length;
    const report = () => sink.progress?.({ done: doneCount, total: keys.length, unit: "folders" });
    report();
    for (const { path, known, key } of keys) {
      if (finished.has(key)) continue;
      if (sink.signal.aborted) return;
      if (over()) return pause();
      try {
        let uids: number[];
        const lock = await c.getMailboxLock(path);
        try {
          // gone or reset since: the regular pass reads it again with the wider window
          if (!c.mailbox || Number(c.mailbox.uidValidity) !== known.uidvalidity) uids = [];
          else {
            const found = await c.search({ since: new Date(request.since), before: new Date(request.until) }, { uid: true });
            if (!found) throw new ProviderError(L("errors.imap.listRefused"), false);
            const below = Math.min(known.uidnext, state.below[key] ?? Infinity);
            uids = found.filter((uid) => uid < below).sort((a, b) => b - a);
          }
        } finally { lock.release(); }
        for (let i = 0; i < uids.length; i += 250) {
          if (sink.signal.aborted) return;
          if (over()) return pause();
          const chunk = uids.slice(i, i + 250);
          const held: number[] = [];
          await syncMailbox(c, path, cursor, sink, touched, { introduced, uids: chunk, heldUids: held });
          // held back for identity: tried once more at the end of the run, with everything it read introduced
          if (held.length) state.held![key] = [...(state.held![key] ?? []), ...held].slice(0, 5000);
          state.below[key] = chunk[chunk.length - 1]!;
          await ctx.saveCursor(cursor);
        }
      } catch (error) {
        // a folder that won't be read now: the regular passes try it again (a few times), never one marked done
        const e = toProviderError(error);
        if (sink.signal.aborted || e.retryable || e instanceof ProviderAuthError) throw e;
        state.failed![key] = (state.failed![key] ?? 0) + 1;
        if (state.failed![key]! < BACKFILL_FOLDER_TRIES) { waiting = true; continue; }
      }
      state.done.push(key);
      if (!finished.has(key)) { finished.add(key); doneCount++; }
      delete state.below[key];
      await ctx.saveCursor(cursor);
      report();
    }
    await settle();
    // a folder still to retry: the next regular pass (not a chunk a second later: the server refused it)
    if (waiting) { await ctx.saveCursor(cursor); return; }
    // what identity held back, once more now that the run's messages are all introduced; what stays held is the
    // regular passes' (its message is already here from another folder)
    for (const { path, key } of keys) {
      const held = state.held?.[key];
      if (!held?.length || !cursor.mailboxes[path]) continue;
      try { await syncMailbox(c, path, cursor, sink, touched, { introduced, uids: held }); }
      catch (error) {
        const e = toProviderError(error);
        if (sink.signal.aborted || e.retryable || e instanceof ProviderAuthError) throw e;
      }
    }
    await settle();
    delete cursor.backfill;
    await ctx.saveCursor(cursor);
    await sink.backfillDone?.(request);
  }

  /**
   * Plan 68 (Codex R5): what the server expunged, and flags it changed, for mail we already have: run for every
   * mailbox before any new mail is identified, so a message moved between folders (the destination synced first)
   * finds its old location gone and keeps its identity, its thread and categories, never a second copy.
   */
  async function sweepMailbox(c: ImapFlow, path: string, cursor: Cursor, touched: Set<number>, remember: (id: number, mailbox: string, uidvalidity: number, uid: number, flags: Set<string> | undefined) => void): Promise<Snapshot | null> {
    const state = cursor.mailboxes[path];
    if (!state) return null;
    const lock = await c.getMailboxLock(path);
    try {
      const mb = c.mailbox;
      if (!mb) return null;
      // a reset: its messages unlocated and written down now, before any mailbox identifies new mail (Codex R11)
      if (Number(mb.uidValidity) !== state.uidvalidity) {
        await resetLocations(cursor, path, state.uidvalidity, touched);
        return null;
      }
      const uidvalidity = state.uidvalidity;
      // what the mailbox was as the sweep began: anything after it is for the next pass to see (Codex R6)
      const seen = snapshotOf(mb);
      const known = await readMailbox(locations, path, uidvalidity);
      // SELECT already proves an empty mailbox; with no cached UIDs there is nothing to reconcile.
      if (mb.exists === 0 && known.length === 0) return seen;
      const found = await c.search({ all: true }, { uid: true });
      // A refused search says nothing about which cached messages still exist.
      if (!found) throw new ProviderError(L("errors.imap.listRefused"), false);
      // gathered and split a few thousand at a time (Codex R46: 500,000 mapped and filtered at once, 46 to 71 ms)
      const serverUids = new Set<number>();
      await addAll(serverUids, found);
      const { byUid, gone, stillThere } = await partitionKnown(known, serverUids);
      if (gone.length) {
        // written down first, durably: a moved message is recognised under its new folder, an expunged one
        // reconciled, even if the connection drops before this pass ends (Codex R8)
        await journal(cursor, gone.map((k) => k.message_id));
      }
      // in slices, each thread's membership looked at once (Codex R11: one at a time was quadratic in a long conversation)
      await locations.removeMany(gone.map((k) => k.message_id), path);
      await addAll(touched, gone.map((k) => k.message_id));
      for (let i = 0; i < stillThere.length; i += 1000) {
        const batch = stillThere.slice(i, i + 1000);
        const expected = new Set(batch);
        for await (const msg of c.fetch(batch, { uid: true, flags: true }, { uid: true })) {
          const k = byUid.get(msg.uid);
          if (!k || !expected.delete(msg.uid) || !(msg.flags instanceof Set)) throw new ProviderError(L("errors.imap.listRefused"), false);
          remember(k.message_id, path, uidvalidity, msg.uid, msg.flags);
          const flags = JSON.stringify([...(msg.flags ?? new Set<string>())]);
          if (flags !== k.flags) {
            await locations.setFlags(k.message_id, path, flags);
            touched.add(k.message_id);
          }
        }
        if (expected.size) throw new ProviderError(L("errors.imap.listRefused"), false);
      }
      return seen;
    } finally {
      lock.release();
    }
  }

  /** Plan 68: a custom folder STATUS says hasn't changed since the cursor (UIDVALIDITY included) needs no pass. */
  async function unchanged(c: ImapFlow, path: string, cursor: Cursor): Promise<boolean> {
    const state = cursor.mailboxes[path];
    if (!state || state.messages === undefined) return false;
    const s = await c.status(path, { uidValidity: true, uidNext: true, messages: true, highestModseq: true });
    if (!s) return false;
    if (Number(s.uidValidity) !== state.uidvalidity || Number(s.uidNext) !== state.uidnext || s.messages !== state.messages) return false;
    if (s.highestModseq !== undefined) return state.modseq === String(s.highestModseq);
    return (cursor.pass ?? 0) % CHECK_EVERY !== 0;
  }

  /** Downloads bodies newest-first (search, snippets and body filters depend on them). */
  async function syncBodies(c: ImapFlow, sink: SyncSink) {
    const requested = sink.captureRetry;
    const repair = requested?.locator.kind === "imap" ? await store.repairs?.get(ctx.account.id, requested.locator) : undefined;
    const source = repair?.state === "pending" && repair.revision === requested?.revision && repair.locator.kind === "imap" ? repair.locator : undefined;
    const pending = source ? [{ id: source.messageId, mailbox: source.mailbox, uid: source.uid, uidvalidity: source.uidvalidity }] : await store.pendingBodies(options.bodiesPerSync ?? 500);
    const byMailbox = new Map<string, { id: number; uid: number; uidvalidity: number }[]>();
    for (const p of pending) byMailbox.set(p.mailbox, [...(byMailbox.get(p.mailbox) ?? []), p]);
    for (const [mailbox, all] of byMailbox) {
      if (sink.signal.aborted) return;
      const lock = await c.getMailboxLock(mailbox);
      try {
        // UIDs are only meaningful with their UIDVALIDITY: skip stale ones (the next sync remaps them)
        const items = all.filter((i) => i.uidvalidity === Number(c.mailbox && c.mailbox.uidValidity));
        const byUid = new Map(items.map((i) => [i.uid, i.id]));
        for (let i = 0; i < items.length; i += 25) {
          const uids = items.slice(i, i + 25).map((x) => x.uid);
          for await (const msg of c.fetch(uids, { uid: true, source: { start: 0, maxLength: MAX_INCOMING_MIME_BYTES + 1 } }, { uid: true })) {
            const id = byUid.get(msg.uid);
            if (!id || !msg.source) continue;
            const captured = all.find((item) => item.id === id)!;
            const locator = { kind: "imap" as const, messageId: id, mailbox, uid: msg.uid, uidvalidity: captured.uidvalidity };
            const repair = await store.repairs?.get(ctx.account.id, locator);
            if (repair?.state === "blocked") continue;
            let parsed;
            try { parsed = await parseRaw(msg.source); }
            catch (error) {
              // This direct-parser refusal is qualified independently of the worker profile.
              if ((error as { code?: string })?.code !== "EMAXNESTINGDEPTH" || !sink.blockCapture) throw error;
              sink.signal.throwIfAborted();
              await sink.blockCapture(locator, "mime-depth", repair?.revision ?? 0);
              continue;
            }
            await locations.dispatch([id], (await locations.of([id])).filter((l) => l.mailbox !== mailbox).concat([{ message_id: id, mailbox, uid: msg.uid, uidvalidity: captured.uidvalidity, flags: "[]" }]), () => sink.setBody(id, parsed.text, parsed.html, parsed.captureUnavailable ? undefined : parsed.attachments, { ...(parsed.captureUnavailable && { captureUnavailable: parsed.captureUnavailable }), ...(repair && { repair: { key: repair.key, revision: repair.revision } }) }));
          }
        }
      } finally {
        lock.release();
      }
    }
    await sink.setSyncState({ bodiesPending: await store.countPendingBodies() });
  }

  type Loc = ImapLocation;

  /** Throws (retryable) if the mailbox's UIDVALIDITY no longer matches our stored UIDs. */
  async function assertValidity(c: ImapFlow, _mailbox: string, items: Loc[]) {
    const current = Number(c.mailbox && c.mailbox.uidValidity);
    if (items.some((i) => i.uidvalidity !== current)) {
      await locations.fence(items.map((item) => item.message_id));
      throw new ProviderIdentityError(L("errors.imap.identityUnavailable"));
    }
  }

  function targetedCapability(c: ImapFlow, capability: "MOVE" | "UIDPLUS"): boolean {
    // IMAP4rev2 folds both extensions into the active base protocol.
    return c.capabilities.has(capability) || c.enabled.has("IMAP4REV2") || (c.capabilities.has("IMAP4rev2") && !c.capabilities.has("IMAP4rev1"));
  }

  async function moveLocations(c: ImapFlow, locs: Loc[], destination: string | (() => Promise<string>), beforeMutation: () => void, admission: { ids: readonly number[]; expected: ImapLocation[] }, mode: "move" | "copy" = "move") {
    if (!locs.some((l) => typeof destination !== "string" || l.mailbox !== destination)) return;
    if (mode === "move" && !targetedCapability(c, "MOVE") && !targetedCapability(c, "UIDPLUS")) throw new ProviderError(L("errors.imap.unsafeMove"), false);
    const target = typeof destination === "string" ? destination : await destination();
    const byMailbox = new Map<string, typeof locs>();
    for (const l of locs) {
      if (l.mailbox === target) continue;
      const list = byMailbox.get(l.mailbox);
      if (list) list.push(l);
      else byMailbox.set(l.mailbox, [l]);
    }
    for (const [mailbox, items] of byMailbox) {
      const lock = await c.getMailboxLock(mailbox);
      try {
        await assertValidity(c, mailbox, items);
        if (mode === "move" && c.mailbox && c.mailbox.readOnly) throw new ProviderError(L("errors.imap.readOnly"), false);
        const uids = items.map((i) => i.uid);
        let holdOwner: string | undefined;
        clearRefusal(c);
        const res = await locations.dispatch(admission.ids, admission.expected, async (owner) => {
          holdOwner = owner;
          beforeMutation();
          return mode === "move" ? c.messageMove(uids, target, { uid: true }) : c.messageCopy(uids, target, { uid: true });
        }, items.map((l) => l.message_id));
        if (!res) {
          const { why, command } = refusalOf(c);
          // What a refusal proves changed nothing: a COPY (atomic, RFC 3501: also the fallback's first step),
          // or a MOVE of one message (RFC 6851 lets a refused MOVE move part of a larger set). Those holds
          // go and the op runs again; anything else (a failed EXPUNGE after the fallback's COPY) stays held.
          const unchanged = command === "COPY" || (command === "MOVE" && items.length === 1);
          if (why !== "unknown" && unchanged && holdOwner) await locations.refused(items.map((l) => l.message_id), holdOwner);
          refusedChange(c, `Could not ${mode} messages to ${target}`, "ambiguous", why);
        }
        const epoch = Number(res.uidValidity);
        const mapping = items.map((item) => ({ messageId: item.message_id, uid: res.uidMap?.get(item.uid) ?? 0 }));
        const targetStatus = await c.status(target, { uidValidity: true });
        const targetEpoch = Number(targetStatus && targetStatus.uidValidity);
        const valid = epoch === targetEpoch && Number.isSafeInteger(epoch) && epoch > 0 && epoch <= 0xffff_ffff && mapping.every((m) => Number.isSafeInteger(m.uid) && m.uid > 0 && m.uid <= 0xffff_ffff) && new Set(mapping.map((m) => m.uid)).size === items.length && res.uidMap?.size === items.length;
        if (valid) {
          await locations.mappedMove(items, target, epoch, mapping, mode === "copy", admission.expected, holdOwner!);
          const moved = new Set(items.map((l) => l.message_id));
          admission.expected = admission.expected.filter((l) => !(moved.has(l.message_id) && (l.mailbox === target || (mode === "move" && l.mailbox === mailbox))));
          for (const item of items) admission.expected.push({ ...item, mailbox: target, uidvalidity: epoch, uid: mapping.find((m) => m.messageId === item.message_id)!.uid });
        }
        else if (mode === "move") await locations.removeMany(items.map((i) => i.message_id), mailbox);

      } finally {
        lock.release();
      }
    }
  }

  async function ensureMailbox(c: ImapFlow, role: Role, fallbackName: string): Promise<string> {
    const r = await discoverRoles(c);
    if (r[role]) return r[role]!;
    const created = await c.mailboxCreate(fallbackName);
    if (!created || !created.created) throw new ProviderError(L("errors.imap.changeRefused"), false);
    r[role] = fallbackName;
    return fallbackName;
  }

  async function appendCopy(raw: Uint8Array, hooks?: SentCopyHooks, mailbox?: string): Promise<import("@terno/core").SentCopyState> {
    let issued = false;
    try {
      const c = await connection();
      const sent = mailbox ?? await ensureMailbox(c, "sent", "Sent");
      await hooks?.record("unknown", { mailbox: sent });
      issued = true;
      const result = await c.append(sent, Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), ["\\Seen"]);
      if (!result) throw new Error("APPEND outcome missing");
      await hooks?.record("saved", { mailbox: sent, ...(result.uidValidity && { uidValidity: String(result.uidValidity) }), ...(result.uid && { uid: result.uid }) });
      return "saved";
    } catch (error) {
      const status = (error as { responseStatus?: string })?.responseStatus;
      const copy = !issued || status === "NO" || status === "BAD" ? "rejected" : "unknown";
      // The SMTP latch already owns this outcome, even when local receipt storage fails.
      try { await hooks?.record(copy); } catch { /* The prior durable state remains conservative. */ }
      return copy;
    }
  }

  async function send(payload: SendPayload, op: ProviderOp): Promise<{ providerMsgId: string; warning?: Localized }> {
    const password = await ctx.getSecret("password");
    if (!password) throw new ProviderAuthError(L("errors.imap.noPassword"));
    const { raw, rejected, outcomes, recipientOutcomeUnknown } = await sendViaSmtp({ ...config.smtp, password, allowInsecure: options.allowInsecure, socketTimeoutMs: timeouts.smtpSocketMs }, payload, { prepare: op.sentCopy?.prepare, accepted: op.submissionAccepted, beforeSubmission: op.beforeSubmission, recovery: op.recovery });
    if (outcomes) op.recipientOutcomes?.(outcomes);
    const warning = recipientOutcomeUnknown ? L("errors.smtp.recipientOutcomeUnknown") : rejected.length ? L("errors.smtp.notDeliveredTo", { recipients: rejected.join(", ") }) : undefined;
    op.submissionWarning?.(warning);
    if ((op.sentCopyRequested ?? config.appendToSent) && !op.recovery) {
      try {
        await op.sentCopy?.accepted(warning);
      } catch {
        return { providerMsgId: messageKey(payload.messageId)!, warning: sentCopyWarning("unknown", warning) };
      }
      const copy = await appendCopy(raw, op.sentCopy);
      return { providerMsgId: messageKey(payload.messageId)!, warning: sentCopyWarning(copy, warning) };
    }
    return { providerMsgId: messageKey(payload.messageId)!, warning };
  }

  async function repairSentCopy(input: { raw: Uint8Array; messageId: string; mailbox: string | null }, hooks: SentCopyHooks): Promise<void> {
    try {
    const c = await connection();
    const mailbox = input.mailbox ?? await ensureMailbox(c, "sent", "Sent");
    const lock = await c.getMailboxLock(mailbox);
    try {
      const matches = await c.search({ header: { "message-id": `<${input.messageId}>` } }, { uid: true });
      if (!matches || matches.length > 1) throw new ProviderError(L("errors.sentCopy.unavailable"), false);
      if (matches.length === 1) {
        const uid = matches[0]!;
        const message = await c.fetchOne(uid, { size: true }, { uid: true });
        if (!message || message.size !== input.raw.byteLength) throw new ProviderError(L("errors.sentCopy.unavailable"), false);
        const source = await c.fetchOne(uid, { source: { start: 0, maxLength: input.raw.byteLength + 1 } }, { uid: true });
        if (!source || !source.source?.equals(Buffer.from(input.raw.buffer, input.raw.byteOffset, input.raw.byteLength))) throw new ProviderError(L("errors.sentCopy.unavailable"), false);
        await hooks.record("saved", { mailbox, uidValidity: String(c.mailbox && c.mailbox.uidValidity), uid });
        return;
      }
    } finally {
      lock.release();
    }
    await appendCopy(input.raw, hooks, mailbox);
    } catch (error) {
      try { await hooks.record("unknown"); } catch { /* A failed read or write never authorizes APPEND. */ }
      throw error;
    }
  }

  return {
    flagSnapshots: true,
    flagSnapshotSource: "locations",
    async verify() {
      const c = await makeClient();
      c.on("error", () => {});
      try {
        await c.connect();
        await discoverRoles(c);
        await c.logout();
      } catch (error) {
        throw toProviderError(error);
      }
    },

    async sync(sink) {
      await withConnection(async (c) => {
        const passGeneration = generation;
        const check = () => {
          sink.signal.throwIfAborted();
          if (generation !== passGeneration) throw ProviderError.network(L("errors.network.changed"));
        };
        const snapshots = ctx.flagObservation ? await store.pendingFlagSnapshots({ limit: 50 }) : undefined;
        const wanted = new Set(snapshots?.items.map((item) => item.id));
        // Reuse only real FLAGS evidence for the first bounded page; later pages use targeted reads.
        const evidence = new Map<string, string>();
        const remember = (id: number, mailbox: string, uidvalidity: number, uid: number, flags: Set<string> | undefined) => {
          if (wanted.has(id) && flags instanceof Set && evidence.size < 1000) evidence.set(locatorKey(id, mailbox, uidvalidity, uid), JSON.stringify([...flags]));
        };
        check();
        // one LIST a pass: the roles (kept) and the account's own folders (fresh: plan 68)
        const list = await c.list();
        // plan 68 (Codex R3): mailboxes by path in a map with no prototype, so a folder named "__proto__" is a path like any other
        const loaded = await ctx.loadCursor<Cursor>();
        const r = await discoverRoles(c, list, loaded?.roles ?? roles);
        const cursor: Cursor = {
          ...loaded,
          mailboxes: Object.assign(Object.create(null) as Cursor["mailboxes"], loaded?.mailboxes),
          ...(loaded?.resetPending && { resetPending: Object.assign(Object.create(null) as Record<string, number[]>, loaded.resetPending) }),
          // (plan 79, Codex R2: a folder named "constructor" is a path, not an inherited validity)
          ...(loaded?.previewed && { previewed: Object.assign(Object.create(null) as Record<string, number>, loaded.previewed) }),
        };
        cursor.pass = (cursor.pass ?? 0) + 1;
        const touched = new Set<number>();
        const introduced = new Set<number>();
        {
          const changed = new Set<string>(cursor.roles ? [] : Object.keys(cursor.mailboxes));
          for (const role of Object.keys(SPECIAL_USE).map((key) => SPECIAL_USE[key]!)) {
            if (cursor.roles?.[role] === r[role]) continue;
            if (cursor.roles?.[role]) changed.add(cursor.roles[role]!);
            if (r[role]) changed.add(r[role]!);
          }
          for (const path of changed) {
            const state = cursor.mailboxes[path];
            if (state) await addAll(touched, (await readMailbox(locations, path, state.uidvalidity)).map((l) => l.message_id));
          }
        }
        // plan 107: each pending record's path's generation now, and the listing with theirs left out (Codex code review round 8)
        const generations = await recordedGenerations(c, list, cursor);
        const listing = withExcept(customFolders(list, r), cursor, generations);
        // plan 107: renames made here that this LIST shows done (the new path there, the old one gone or another
        // mailbox now: Codex code review round 8 #3): the store still showing the old one means their answer was lost
        // (Codex code review round 5 #1). The path it was listed under had the record's generation when it was written.
        const own = new Set(listing.map((f) => f.key));
        // one whose answer was lost and whose old path is listed but STATUS can't say which mailbox it is now waits, with
        // its record (Codex code review round 10 #1: dropped, the view and favorites stayed on another mailbox for good):
        // the new path (and what's under it) isn't stored, neither path is read, and the pass is incomplete, so a pass
        // whose STATUS answers announces it as the store still shows it
        const waiting = new Set<string>();
        const undecided = new Set<string>();
        for (const [to, m] of Object.entries(cursor.renamed ?? {})) {
          const from = m.key ?? m.from;
          if (!m.answered && from !== to && own.has(to) && own.has(from) && generations.has(from) && generations.get(from) == null) { undecided.add(to); waiting.add(from); }
        }
        const withheld = listing.filter((f) => undecided.has(f.key));
        const hidden = (f: ProviderFolder) => withheld.some((w) => w.path.length <= f.path.length && w.path.every((p, i) => f.path[i] === p));
        const folders = withheld.length ? listing.filter((f) => !hidden(f)) : listing;
        for (const f of listing) if (hidden(f)) waiting.add(f.key);
        const moved = Object.entries(cursor.renamed ?? {}).flatMap(([to, m]): FolderMove[] => {
          const from = m.key ?? m.from;
          const now = generations.get(from);
          if (waiting.has(to)) return [];
          return from !== to && own.has(to) && (!own.has(from) || (now != null && now !== m.uidvalidity)) ? [{ from, to, ...(m.stale && { stale: true as const }) }] : [];
        });
        // plan 107: deletions made here that this LIST shows done (the path gone, or another mailbox there now) and that
        // nothing announced (their answer was lost): their favorites go with the list, once (Codex code review round 12 #3)
        const shownGone = Object.entries(cursor.deleted ?? {}).flatMap(([path, r]) => {
          if (typeof r !== "number" && r.answered) return [];
          const was = typeof r === "number" ? r : r.uidvalidity;
          const there = list.find((m) => m.path === path && !classifyMailbox(m).unusable);
          if (!there) return [path];
          const now = generations.get(path);
          return was && selectableMailbox(there) && now != null && now !== was ? [path] : [];
        });
        // listed before they sync: a location in a listed folder is membership as it's written
        await sink.setFolders?.(folders, moved, shownGone);
        if (shownGone.length && sink.setFolders) {
          for (const path of shownGone) cursor.deleted![path] = answeredDeletion(path, cursor.deleted![path]!);
          await ctx.saveCursor(cursor);
        }
        // plan 107 (Codex R1): mailboxes deleted here. A record is written before its DELETE is sent (Codex code review
        // round 2 #2): one the LIST still has under the same UIDVALIDITY wasn't carried out (its answer was lost), so
        // only the record goes; under another, it was made again since: the record stays, for the deleted one's mail
        // (Codex code review round 7 #2). One STATUS can't answer waits for a pass that can.
        const stillListed = cursor.deleted ? new Set(list.filter((m) => !classifyMailbox(m).unusable).map((m) => m.path)) : null;
        const unsettled = new Set<string>();
        for (const [path, r] of Object.entries(cursor.deleted ?? {})) {
          if (!stillListed!.has(path)) continue;
          const was = typeof r === "number" ? r : r.uidvalidity;
          // a \Noselect one holds no mail: no generation to tell
          if (was && list.some((m) => m.path === path && selectableMailbox(m))) {
            const now = generations.get(path) ?? null;
            if (now === null) unsettled.add(path);
            if (now !== was) continue;
          }
          delete cursor.deleted![path];
          if (!Object.keys(cursor.deleted!).length) delete cursor.deleted;
          await ctx.saveCursor(cursor);
        }
        // the rest are forgotten once every folder here has been read (Codex code review round 4 #1): mail another app
        // moved out first is met there, so only what no folder has is proven gone. Each by where its mail is cached:
        // its own path, or the one it had before a rename no pass read (round 4 #2)
        const deletions = Object.entries(cursor.deleted ?? {}).filter(([path]) => !unsettled.has(path)).map(([path, r]) => ({ path, from: typeof r === "number" ? path : r.from, uidvalidity: typeof r === "number" ? r : r.uidvalidity }));
        const seen = new Set<number>();
        // Gmail-style servers keep archived mail only in "All Mail"
        const boxes = new Set([r.inbox, r.sent, r.archive ?? r.all, r.junk, r.trash].filter((p): p is string => Boolean(p)));
        // a folder that couldn't sync this pass may be a vanished one's new name: their locations wait (Codex R2)
        let incomplete = false;
        // a folder the server won't open (permissions, gone since the LIST) waits for the next pass; the rest syncs
        const tolerate = (error: unknown) => {
          const e = toProviderError(error);
          if (e.retryable || e instanceof ProviderAuthError) throw e;
          incomplete = true;
        };
        // the custom folders to read this pass: new ones, and known ones STATUS says changed
        // (a pass owing a full check reads every folder: STATUS may have skipped where a moved message went, Codex R9)
        const custom: string[] = [];
        const forceSnapshots = Boolean(snapshots?.items.length);
        let skipped = 0;
        // a rename that waits for its old path's generation: neither path is read (round 10 #1)
        if (waiting.size) incomplete = true;
        for (const f of folders) {
          if (!f.selectable || boxes.has(f.key) || waiting.has(f.key)) continue;
          try {
            if (forceSnapshots || cursor.fullCheck || cursor.mailboxes[f.key] === undefined || !(await unchanged(c, f.key, cursor))) custom.push(f.key);
            else skipped++;
          } catch (error) {
            tolerate(error);
          }
        }
        // Snapshot obligations include selectable special-use paths omitted from the folder UI.
        if (forceSnapshots && list.length <= LISTED_MAX) for (const mailbox of list) {
          if (selectableMailbox(mailbox) && !boxes.has(mailbox.path) && !waiting.has(mailbox.path) && !custom.includes(mailbox.path)) custom.push(mailbox.path);
        }
        // first what the server expunged everywhere, then new mail anywhere: a message moved between folders keeps its identity (Codex R5)
        const swept = new Map<string, Snapshot | null>();
        for (const path of boxes) {
          if (sink.signal.aborted) return;
          swept.set(path, await sweepMailbox(c, path, cursor, touched, remember));
        }
        for (const path of custom) {
          if (sink.signal.aborted) return;
          try {
            swept.set(path, await sweepMailbox(c, path, cursor, touched, remember));
          } catch (error) {
            swept.set(path, null);
            tolerate(error);
          }
        }
        // folders gone since the last pass (deleted, or renamed: the new path is among the custom ones); their
        // messages may be found again under it, or anywhere they were moved before the folder went (Codex R10: every
        // destination, role mailboxes too, gets the index), so their locations stay until every folder has synced (Codex R1)
        // a place mail can be: listed, existing and selectable (Codex R24: one that became a \Noselect parent holds
        // nothing, its old locations go like a deleted folder's; it's still drawn as a group)
        const listed = new Set(list.filter(selectableMailbox).map((m) => m.path));
        const vanished = Object.keys(cursor.mailboxes).filter((path) => !boxes.has(path) && !listed.has(path));
        const vanishedIds = new Set<number>();
        for (const path of vanished) await addAll(vanishedIds, (await readMailbox(locations, path, cursor.mailboxes[path]!.uidvalidity)).map((l) => l.message_id));
        // Revisit identities unlocated this pass or before an interrupted reconciliation.
        await addAll(touched, cursor.unlocated ?? []);
        // Gather missing identities in slices; a new role folder must search old mail too.
        const pending = new Set<number>();
        await addAll(pending, vanishedIds);
        await addAll(pending, cursor.unlocated ?? []);
        await addAll(pending, cursor.orphans ?? []);
        for (const ids of Object.values(cursor.resetPending ?? {})) await addAll(pending, ids);
        // Rediscover identities outside a truncated journal. Their durable holds are never truncated.
        const lost: number[] = [];
        for (let after = 0, more = cursor.overflow === true; more; after += UNLOCATED_SPAN) {
          if (sink.signal.aborted) return;
          const w = await locations.unlocated(after, UNLOCATED_SPAN);
          lost.push(...w.ids);
          more = w.more;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await addAll(pending, lost);
        // a candidate is one with no place left: one the journal names that's placed in a folder still here (a pass
        // that stopped had placed it) isn't, whatever folder is read first (Codex R38); a vanished folder's are
        const vanishedPaths = new Set(vanished);
        // plan 107: the old path of a mailbox renamed here, while it's gone from the LIST or another mailbox now (proof
        // its UIDs moved with it; Codex code review round 7 #1: made again, its reset drops the state)
        const replaced = (r: { from: string; uidvalidity: number }) => vanishedPaths.has(r.from) || cursor.mailboxes[r.from]?.uidvalidity !== r.uidvalidity;
        const renamedFrom = (path: string) => {
          const r = cursor.renamed?.[path];
          return r && replaced(r) ? r : undefined;
        };
        const ask = [...pending];
        const breathe = breather();
        for (let i = 0; i < ask.length; i += 500) {
          for (const l of await locations.of(ask.slice(i, i + 500))) if (!vanishedPaths.has(l.mailbox)) pending.delete(l.message_id);
          await breathe();
        }
        // plan 79: a new account shows its newest Inbox mail, with bodies, before the rest is read (the full read
        // finds these by their location, before any identity rule)
        if (!loaded && r.inbox) {
          const previewed = await syncMailbox(c, r.inbox, cursor, sink, touched, { introduced, preview: PREVIEW });
          if (sink.signal.aborted) return;
          // written down (Codex review): a pass that stops from here on doesn't preview again, and a reset is seen as one
          if (previewed !== undefined) {
            cursor.previewed = Object.assign(Object.create(null) as Record<string, number>, { [r.inbox]: previewed });
            await ctx.saveCursor(cursor);
          }
          // the preview's bodies are a head start, never a gate: one the server won't give comes with the rest
          try {
            await syncBodies(c, sink);
          } catch (error) {
            // read like `tolerate` does: a refused login comes raw from the client, and stops the pass
            const e = toProviderError(error);
            if (sink.signal.aborted || e.retryable || e instanceof ProviderAuthError) throw e;
          }
          if (sink.signal.aborted) return;
        }
        // plan 103: a first read says how far it is, a folder at a time (a regular pass says nothing)
        const firstRead = [...boxes, ...custom].every((path) => cursor.mailboxes[path] === undefined);
        let foldersDone = 0;
        const folderRead = () => { if (firstRead) sink.progress?.({ done: ++foldersDone, total: boxes.size + custom.length, unit: "folders" }); };
        if (firstRead) sink.progress?.({ done: 0, total: boxes.size + custom.length, unit: "folders" });
        for (const path of boxes) {
          if (sink.signal.aborted) return;
          await syncMailbox(c, path, cursor, sink, touched, { introduced, seen, checkpoint: swept.get(path) ?? null, reidentify: cursor.mailboxes[path] === undefined && (pending.size > 0 || vanishedIds.size > 0) });
          folderRead();
        }
        for (const path of custom) {
          if (sink.signal.aborted) return;
          try {
            await syncMailbox(c, path, cursor, sink, touched, { introduced, seen, ...(cursor.mailboxes[path] === undefined ? { reidentify: true, formerly: renamedFrom(path) } : { checkpoint: swept.get(path) ?? null }) });
          } catch (error) {
            tolerate(error);
          }
          folderRead();
        }
        // plan 107: a mailbox renamed here whose new path read under the same UIDVALIDITY has its mail placed there now;
        // the old path is forgotten with no hold (a UID that didn't turn up is held, as a vanished folder's). Another
        // UIDVALIDITY, or a new path that's gone, leaves it to the vanished-folder path; one not read yet waits. An old
        // path made again has only the record's UIDVALIDITY's places forgotten, whatever the new path read as (its reset
        // left them to the record: Codex code review round 7 #1).
        for (const [to, r] of incomplete ? [] : Object.entries(cursor.renamed ?? {})) {
          const state = cursor.mailboxes[to];
          // a generation deleted here since is the deletion's to forget (Codex code review round 6 #1)
          const live = listed.has(r.from);
          if (replaced(r) && !deletions.some((d) => d.from === r.from && d.uidvalidity === r.uidvalidity) && (live || state?.uidvalidity === r.uidvalidity)) {
            await forgetMailbox(cursor, r.from, r.uidvalidity, "hold", sink, c, check, undefined, live);
          }
          delete cursor.renamed![to];
        }
        if (cursor.renamed && !Object.keys(cursor.renamed).length) delete cursor.renamed;
        // plan 107: deleted here, and every folder read (a restart in between finds them here again): what was only
        // there goes, what a folder met this pass is held as a vanished folder's is
        for (const d of incomplete ? [] : deletions) {
          check();
          // the record's UIDVALIDITY, never the path's now: a mailbox created there since is another (Codex code review round 6 #1)
          const live = listed.has(d.from);
          await forgetMailbox(cursor, d.from, d.uidvalidity || (live ? undefined : cursor.mailboxes[d.from]?.uidvalidity), "remove", sink, c, check, seen, live);
          delete cursor.deleted![d.path];
          if (!Object.keys(cursor.deleted!).length) delete cursor.deleted;
          await ctx.saveCursor(cursor);
        }
        // Forget vanished paths, retaining their cached identities behind durable holds.
        // (one a record forgot has no state left; another generation cached for its path is a vanished folder's: round 8)
        for (const path of incomplete ? [] : vanished.filter((p) => cursor.mailboxes[p] !== undefined)) {
          // written down before they go (Codex R9): a crash right after still reconciles them
          await journal(cursor, (await readMailbox(locations, path, cursor.mailboxes[path]!.uidvalidity)).map((l) => l.message_id));
          await addAll(touched, await locations.resetMailbox(path));
          delete cursor.mailboxes[path];
        }
        // A complete sequential pass permits flag reconciliation, not proof of disappearance.
        const full = !incomplete && skipped === 0;
        await addAll(touched, cursor.unlocated ?? []);
        if (full) await addAll(touched, cursor.orphans ?? []);
        // what the cut journal's scan found (those found again have a place now: their flags, nothing more)
        const overflowed = full && cursor.overflow === true;
        if (overflowed) await addAll(touched, lost);
        const covered = new Set([...boxes, ...custom]);
        const authoritative = full && list.length <= LISTED_MAX && list.every((mailbox) => !selectableMailbox(mailbox) || covered.has(mailbox.path));
        const kept = await reconcile(touched, sink, true, c, false, check);
        // Capture the finite work boundary after incomplete derivations have recorded fresh obligations.
        if (authoritative && ctx.flagObservation) {
          let page: FlagSnapshotPage = await store.pendingFlagSnapshots({ limit: 50 });
          const through = page.throughMessageId;
          for (;;) {
            check();
            await reconcile(page.items.map((item) => item.id), sink, true, c, true, check, new Map(page.items.map((item) => [item.id, item.providerMsgId])), evidence);
            if (!page.hasMore || !page.items.length) break;
            page = await store.pendingFlagSnapshots({ limit: 50, throughMessageId: through, afterMessageId: page.items[page.items.length - 1]!.id });
          }
        }
        check();
        if (full) {
          delete cursor.orphans;
          delete cursor.fullCheck;
          if (overflowed) delete cursor.overflow;
        } else if (kept.length) {
          cursor.orphans = bounded(cursor, (await journalUnion(cursor.orphans ?? [], kept)) ?? cursor.orphans ?? [], IMAP_JOURNAL_LIMITS.orphans);
          cursor.fullCheck = true;
        }
        // a cut journal waits for a pass that reads every folder
        if (!full && cursor.overflow) cursor.fullCheck = true;
        // reconciled, or kept above as orphans: the journal is done with
        delete cursor.unlocated;
        cursor.roles = { ...r };
        await ctx.saveCursor(cursor);
        await sink.setSyncState({ syncedSince: sink.windowStart });
        await syncBodies(c, sink);
        // plan 101: older mail, after everything new and its bodies
        await backfillMailboxes(c, cursor, sink, check);
        if (authoritative) await locations.resumeResolved();
      });
    },

    repairSentCopy,

    // plan 107: each change is checked against a fresh LIST, and answered with the LIST after it
    async createFolder({ parent, name }): Promise<FolderChange & { key: string }> {
      try {
        const c = await connection();
        const before = await folderCatalog(c);
        const path = planImapCreate(before.list, before.own, parent, name, before.prefix);
        const created = await c.mailboxCreate(path).catch((error: unknown) => { throw refused(error, name); });
        // ALREADYEXISTS: one the LIST didn't show (unsubscribed, made meanwhile)
        if (!created?.created) throw nameTaken(name);
        const after = await folderCatalog(c);
        return { folders: after.folders, key: path };
      } catch (error) {
        throw toProviderError(error);
      }
    },

    async renameFolder({ key, name }): Promise<FolderChange & { renamed: FolderMove[] }> {
      try {
        const c = await connection();
        const before = await folderCatalog(c);
        const plan = planImapRename(before.list, before.own, before.roles, key, name, before.prefix);
        if (plan.path === key) return { folders: before.folders, renamed: [] };
        // written down first: the next pass knows the moved mail by its UIDs (a RENAME the server refuses takes it back;
        // a crash before it leaves a new path that never appears, which the pass drops)
        const cursor = await ctx.loadCursor<Cursor>();
        const intent = (cursor?.renamed ? Object.assign(Object.create(null) as NonNullable<Cursor["renamed"]>, cursor.renamed) : Object.create(null)) as NonNullable<Cursor["renamed"]>;
        // moves whose path's cached state is another generation: what the store shows under it isn't what moved
        const stale = new Set<string>();
        for (const m of plan.moves) {
          // a group (\Noselect) holds no mail: nothing to prove
          const listed = before.list.find((x) => x.path === m.from);
          if (!listed || !selectableMailbox(listed)) continue;
          // the generation moving is the server's now, never the one cached for the path (Codex code review round 8
          // #2: Work → Job, Work made again and renamed to Other, and Other claimed Job's mail)
          const now = await serverGeneration(c, m.from);
          const state = cursor?.mailboxes[m.from];
          const was = cursor?.renamed?.[m.from];
          // its mail is cached under the path (a pass read this generation), or under the one a rename here that no
          // pass has read moved it from (Codex code review round 3 #2: Work → Job → New, New's UIDs are Work's); else
          // nothing is cached for it, and the record only says where it went
          const cached = state?.uidvalidity === now || was?.uidvalidity === now;
          const from = state?.uidvalidity === now ? m.from : was?.uidvalidity === now ? was.from : m.from;
          if (!cached && (state || was)) stale.add(m.from);
          // `key`: the path it was listed under, so a pass that finds the RENAME done tells where it went (Codex code
          // review round 5 #1: an answer lost, and the folder you were in fell back to the Inbox)
          if (from !== m.to) intent[m.to] = { from, uidvalidity: now, key: m.from, ...(stale.has(m.from) && { stale: true as const }) };
        }
        if (cursor && Object.keys(intent).length) await ctx.saveCursor({ ...cursor, renamed: intent });
        try {
          await c.mailboxRename(key, plan.path);
        } catch (error) {
          // refused: nothing moved, so the record goes now (Codex code review round 3 #1: an answer lost may hide a
          // RENAME the server carried out; the record stays for the next pass, whose LIST settles it)
          if (folderRefusal(error) && cursor) {
            const now = await ctx.loadCursor<Cursor>();
            if (now?.renamed) {
              for (const m of plan.moves) {
                const was = cursor.renamed?.[m.to];
                if (was) now.renamed[m.to] = was;
                else delete now.renamed[m.to];
              }
              await ctx.saveCursor(Object.keys(now.renamed).length ? now : { ...now, renamed: undefined });
            }
          }
          throw refused(error, name);
        }
        // answered: this change announces it, so a pass whose STATUS fails never holds it back (round 10 #1)
        if (cursor) {
          const now = await ctx.loadCursor<Cursor>();
          const written = plan.moves.filter((m) => intent[m.to] && now?.renamed?.[m.to]);
          if (now?.renamed && written.length) {
            for (const m of written) now.renamed[m.to] = { ...now.renamed[m.to]!, answered: true };
            await ctx.saveCursor(now);
          }
        }
        const after = await folderCatalog(c);
        return { folders: after.folders, renamed: plan.moves.filter((m) => after.own.has(m.to)).map((m) => (stale.has(m.from) ? { ...m, stale: true as const } : m)) };
      } catch (error) {
        throw toProviderError(error);
      }
    },

    async deleteFolder({ key }): Promise<FolderChange & { deleted: string[] }> {
      try {
        const c = await connection();
        const before = await folderCatalog(c);
        const paths = planImapDelete(before.list, before.own, before.roles, key);
        const deleted: string[] = [];
        let partial: ProviderError | undefined;
        // the generation each DELETE takes is the server's now, never the one cached for the path (Codex code review
        // round 8: Work → Job, Work made again and deleted recorded Job's), read before the first; a group
        // (\Noselect) has none
        const generations = new Map<string, number>();
        for (const path of paths) {
          const listed = before.list.find((x) => x.path === path);
          generations.set(path, listed && selectableMailbox(listed) ? await serverGeneration(c, path) : 0);
        }
        for (const path of paths) {
          // written down before it's sent (Codex R1; Codex code review round 2 #2: after, a DELETE the server carried out
          // but whose answer was lost, or a stop before the save, left the mail kept as a vanished folder's): the next
          // pass forgets what was only there, even after a restart, and drops a record its LIST shows wasn't carried out
          const cursor = await ctx.loadCursor<Cursor>();
          const now = generations.get(path)!;
          // a path renamed here that no pass has read keeps its mail under the old one: the record names it (Codex code
          // review round 4 #2: Work → Job, then Job deleted, left Work's mail behind holds)
          const state = cursor?.mailboxes[path];
          const was = cursor?.renamed?.[path];
          const record = !now || state?.uidvalidity === now ? now : was?.uidvalidity === now ? { from: was.from, uidvalidity: now } : now;
          if (cursor) await ctx.saveCursor({ ...cursor, deleted: Object.assign(Object.create(null) as NonNullable<Cursor["deleted"]>, cursor.deleted, { [path]: record }) });
          try {
            await c.mailboxDelete(path);
          } catch (error) {
            const r = folderRefusal(error);
            // refused: it's still there, so its record goes now (an answer lost keeps it for the next pass to settle)
            if (r && cursor) {
              const now = await ctx.loadCursor<Cursor>();
              if (now?.deleted && Object.hasOwn(now.deleted, path)) {
                delete now.deleted[path];
                await ctx.saveCursor(Object.keys(now.deleted).length ? now : { ...now, deleted: undefined });
              }
            }
            // nothing deleted yet: the refusal is the answer; midway, what went stays gone and the rest is said
            if (!r || !deleted.length) throw r ? refusedBy(config.imap.host, r.reason) : error;
            partial = new ProviderError(L("errors.folder.partialDelete", { done: deleted.length, total: paths.length, name: leaf(before.list.find((m) => m.path === path) ?? { path }), reason: r.reason }), false);
            break;
          }
          deleted.push(path);
        }
        // every DELETE that went was answered: the backend follows them (their favorites go), so no pass announces them
        // again (Codex code review round 12 #3)
        const now = deleted.length ? await ctx.loadCursor<Cursor>() : null;
        if (now?.deleted && deleted.some((p) => Object.hasOwn(now.deleted!, p))) {
          for (const p of deleted) if (Object.hasOwn(now.deleted, p)) now.deleted[p] = answeredDeletion(p, now.deleted[p]!);
          await ctx.saveCursor(now);
        }
        const after = await folderCatalog(c);
        return { folders: after.folders, deleted, ...(partial && { partial }) };
      } catch (error) {
        throw toProviderError(error);
      }
    },

    async execute(op: ProviderOp) {
      if (op.kind === "send") return send(op.payload as SendPayload, op);
      if (!["markRead", "markUnread", "star", "unstar", "archive", "trash", "spam", "notSpam", "moveToInbox"].includes(op.kind)) throw new ProviderError(`Unsupported operation ${op.kind}`, false);
      const ids = op.target.messageIds ?? [];
      if (ids.length === 0) return;
      await withConnection(async (c, beforeMutation) => {
        const r = await discoverRoles(c);
        const locs: Loc[] = await locations.of(ids);
        await locations.dispatch(ids, locs, async () => {});
        const admission = { ids, expected: [...locs] };
        const inRole = (role: Role) => locs.filter((l) => l.mailbox === r[role]);
        const flagOp = async (flag: string, add: boolean) => {
          const byMailbox = new Map<string, Loc[]>();
          for (const l of locs) byMailbox.set(l.mailbox, [...(byMailbox.get(l.mailbox) ?? []), l]);
          for (const [mailbox, items] of byMailbox) {
            const lock = await c.getMailboxLock(mailbox);
            try {
              await assertValidity(c, mailbox, items);
              const uids = items.map((i) => i.uid);
              clearRefusal(c);
              const ok = await locations.dispatch(ids, locs, () => add ? c.messageFlagsAdd(uids, [flag], { uid: true }) : c.messageFlagsRemove(uids, [flag], { uid: true }));
              // imapflow resolves false when the server rejects the STORE (a throttled one is retried)
              if (ok === false) throw refusal(c) === "temporary" ? ProviderError.deferred(`Server is busy: ${flag} in ${mailbox} is updated later`) : new ProviderError(`Server refused to update ${flag} in ${mailbox}`, false);
              for (const i of items) {
                const row = await locations.get(i.message_id, mailbox);
                if (!row) continue;
                const set = new Set(JSON.parse(row.flags) as string[]);
                if (add) set.add(flag);
                else set.delete(flag);
                await locations.setFlags(i.message_id, mailbox, JSON.stringify([...set]));
              }
            } finally {
              lock.release();
            }
          }
        };
        switch (op.kind) {
          case "markRead":
            return void (await flagOp("\\Seen", true));
          case "markUnread":
            return void (await flagOp("\\Seen", false));
          case "star":
            return void (await flagOp("\\Flagged", true));
          case "unstar":
            return void (await flagOp("\\Flagged", false));
          case "archive": {
            const inbox = inRole("inbox");
            if (!inbox.length) return;
            if (r.archive || !r.all) return void (await moveLocations(c, inbox, r.archive ?? (() => ensureMailbox(c, "archive", "Archive")), beforeMutation, admission));
            if (!targetedCapability(c, "UIDPLUS")) throw new ProviderError(L("errors.imap.unsafeMove"), false);
            // Gmail-style: archiving = removing the INBOX copy; All Mail keeps it
            const lock = await c.getMailboxLock(r.inbox!);
            try {
              await assertValidity(c, r.inbox!, inbox);
              if (c.mailbox && c.mailbox.readOnly) throw new ProviderError(L("errors.imap.readOnly"), false);
              beforeMutation();
              clearRefusal(c);
              const deleted = await locations.dispatch(ids, locs, () => c.messageDelete(inbox.map((l) => l.uid), { uid: true }));
              if (!deleted) refusedChange(c, L("errors.imap.changeRefused"), "refused");
              await locations.removeMany(inbox.map((l) => l.message_id), r.inbox!);
            } finally {
              lock.release();
            }
            return;
          }
          case "trash":
            return void (await moveLocations(c, locs.filter((l) => l.mailbox !== r.trash), r.trash ?? (() => ensureMailbox(c, "trash", "Trash")), beforeMutation, admission));
          case "spam":
            return void (await moveLocations(c, locs.filter((l) => l.mailbox !== r.junk && l.mailbox !== r.sent), r.junk ?? (() => ensureMailbox(c, "junk", "Junk")), beforeMutation, admission));
          case "notSpam":
            return void (await moveLocations(c, inRole("junk"), r.inbox!, beforeMutation, admission));
          case "moveToInbox": {
            const away = locs.filter((l) => l.mailbox !== r.inbox && l.mailbox !== r.sent);
            const all = away.filter((l) => l.mailbox === r.all);
            await moveLocations(c, away.filter((l) => l.mailbox !== r.all), r.inbox!, beforeMutation, admission);
            if (all.length) await moveLocations(c, all, r.inbox!, beforeMutation, admission, "copy");
            return;
          }
          default:
            throw new ProviderError(`Unsupported operation ${op.kind}`, false);
        }
      });
    },

    watch(onChange) {
      // Plan 20: one reconnect loop. At most one session and one pending timer; a failed connect and a
      // closed session schedule through the same place (they used to both, doubling the loops per failure).
      let stopped = false;
      let idle: ImapFlow | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let connecting = false;
      /** reset() came while connecting: that session may be on the old route, connect again */
      let again = false;
      let delay = timeouts.reconnectMs;
      /** when IDLE last heard the server (an event, a connect, an answered heartbeat) */
      let heardAt = 0;
      let pinging = false;
      /** stopped by a refused login (not retried on a timer: servers lock accounts out for that) */
      let refusedLogin = false;
      /** push stopped working at (null: it works) */
      let lostAt: number | null = null;

      const changed = () => {
        heardAt = Date.now();
        onChange();
      };
      const markLost = () => {
        if (lostAt !== null) return;
        lostAt = Date.now();
        ctx.event?.("push.lost");
      };
      const schedule = () => {
        if (stopped || timer || connecting) return;
        // ±20 %: accounts (and clients) that lost the same server don't come back in lockstep
        const wait = delay * (0.8 + Math.random() * 0.4);
        delay = Math.min(delay * 2, timeouts.reconnectMaxMs);
        timer = setTimeout(() => {
          timer = null;
          void connect();
        }, wait);
      };
      /** the session still connecting (login, SELECT): a reset or a stop closes it at once (Codex review) */
      let pending: ImapFlow | null = null;
      const connect = async (): Promise<void> => {
        if (stopped || connecting) return;
        connecting = true;
        again = false;
        const gen = generation;
        /** a reset or a stop came while connecting: that session may be on the old route */
        const stale = () => stopped || again || gen !== generation;
        let c: ImapFlow | null = null;
        try {
          c = await makeClient(true);
          pending = c;
          const session = c;
          c.on("error", () => {});
          c.on("exists", changed);
          c.on("expunge", changed);
          c.on("flags", changed);
          c.on("close", () => {
            if (idle !== session) return;
            idle = null;
            if (stopped) return;
            markLost();
            schedule();
          });
          // the password lookup took a while: never start on the network that just went away
          if (stale()) throw new Error("stale");
          await c.connect();
          await c.mailboxOpen("INBOX");
          if (stale()) throw new Error("stale");
          pending = null;
          idle = c;
          heardAt = Date.now();
          delay = timeouts.reconnectMs;
          refusedLogin = false;
          connecting = false;
          // enter IDLE now so the server pushes EXISTS/EXPUNGE; imapflow re-enters it after each event
          void c.idle().catch(() => {});
          if (lostAt !== null) {
            ctx.event?.("push.restored", { durationMs: Date.now() - lostAt });
            lostAt = null;
            // whatever arrived while push was down
            onChange();
          }
        } catch (error) {
          if (pending === c) pending = null;
          c?.close();
          connecting = false;
          if (stopped) return;
          // a reset abandoned this attempt: the next one goes now, not after a backoff
          if (again || gen !== generation) return void connect();
          markLost();
          // plan 25: a refused sign-in isn't knocked on every minute (servers lock accounts out for that); a
          // network change tries once more, and signing in again starts a new provider
          if (toProviderError(error) instanceof ProviderAuthError) { refusedLogin = true; return; }
          schedule();
        }
      };
      const watcher = {
        /** another session just logged in with the same password: a refused login was a fluke, connect again */
        signedIn() {
          if (!refusedLogin || stopped || connecting || timer || idle) return;
          refusedLogin = false;
          delay = timeouts.reconnectMs;
          void connect();
        },
        /** the network changed: the session is presumed dead, reconnect now */
        restart() {
          if (stopped) return;
          delay = timeouts.reconnectMs;
          if (timer) clearTimeout(timer);
          timer = null;
          const c = idle;
          idle = null;
          if (c) {
            markLost();
            c.close();
          }
          if (connecting) {
            // the attempt in flight fails now (its socket closed) and connects again at once
            again = true;
            pending?.close();
          } else void connect();
        },
        /** the heartbeat (the core's tick): a session quiet for a while must answer a NOOP in time, or it is dead */
        ping() {
          const c = idle;
          if (!c || stopped || pinging || Date.now() - heardAt < timeouts.quietMs) return;
          pinging = true;
          let deadline: ReturnType<typeof setTimeout> | undefined;
          const late = new Promise<boolean>((r) => (deadline = setTimeout(() => r(false), timeouts.heartbeatMs)));
          void Promise.race([c.noop().then(() => true, () => false), late]).then((alive) => {
            clearTimeout(deadline);
            pinging = false;
            if (idle !== c) return;
            if (alive) {
              heardAt = Date.now();
              // back to IDLE at once (imapflow's auto-IDLE would wait 15 s)
              void c.idle().catch(() => {});
              return;
            }
            // dead: reconnect now (if the whole network is down, the reconnect loop backs off from here)
            idle = null;
            markLost();
            c.close();
            delay = timeouts.reconnectMs;
            void connect();
          });
        },
      };
      watchers.add(watcher);
      void connect();
      return () => {
        stopped = true;
        watchers.delete(watcher);
        if (timer) clearTimeout(timer);
        timer = null;
        const c = idle;
        idle = null;
        if (c) void quit(c);
        // one still connecting goes too (it would otherwise linger until its timeout)
        pending?.close();
        pending = null;
      };
    },

    heartbeat() {
      // the core's tick (no timer of our own): does IDLE still hear the server?
      for (const w of watchers) w.ping();
    },

    reset() {
      // the network changed: a session still connecting is abandoned, the cached one closes now (never
      // LOGOUT on a dead socket), and IDLE reconnects at once
      generation++;
      const pending = connecting;
      connecting = null;
      pending?.session?.close();
      const c = client;
      client = null;
      c?.close();
      for (const w of watchers) w.restart();
    },

    async close() {
      const c = client;
      client = null;
      if (c) await quit(c);
    },
  };
}

/** LOGOUT politely, but a session on a dead socket would wait for its timeout: give it 2 s, then close. */
async function quit(c: ImapFlow): Promise<void> {
  const force = setTimeout(() => c.close(), 2000);
  try {
    await c.logout();
  } catch {
    /* closed */
  } finally {
    clearTimeout(force);
  }
}
