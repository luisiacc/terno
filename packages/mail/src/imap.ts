import { FOLDERS_PER_ACCOUNT_MAX, MAX_INCOMING_MIME_BYTES } from "@terno/core";
import { createHash } from "node:crypto";
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { bulkHeaders } from "@terno/core";
import { L, type Localized } from "@terno/i18n";
import type { IncomingMessage, ProviderFolder } from "@terno/store";
import { headerFields, messageAddresses, parseListId, parseRaw, splitIds } from "./mime";
import { isNetworkError } from "./net-errors";
import { AdoptIndex } from "./adopt";
import { sendViaSmtp } from "./smtp";
import { ProviderAuthError, ProviderError, type FlagUpdate, type ImapAccountConfig, type MailProvider, type ProviderContext, type ProviderOp, type SendPayload, type SyncSink } from "./types";

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
   * plan 68 (Codex R15): a journal above was cut at its limit: the next pass that reads every folder looks for every
   * message with no location (a window of ids at a time), so none is left behind with neither a place nor a record
   */
  overflow?: boolean;
}

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

/** Plan 68 (Codex R18): an ID-less message held back until every folder is read (a copy, or its twin moved here) */
interface Ambiguous {
  /** the stored ID-less messages with its envelope, oldest first */
  candidates: number[];
  incoming: IncomingMessage;
  /** older than the window in a folder read whole: a copy of it isn't fetched */
  old: boolean;
  path: string;
  uidvalidity: number;
  uid: number;
  flags: string[];
  live: boolean;
  /** its folder's UIDNEXT when read: acknowledged once it's told apart */
  uidnext: number;
  /** a Message-ID's: as a copy, this stored message gains the place (the same message in one more folder) */
  attachTo: number | null;
  /** a Message-ID's: as a copy, the first of its twins (`attachTo` first) with no place in the folder gains it */
  idCopy: boolean;
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
    const rows = await deps.of(chunk);
    const byMessage = new Map<number, { mailbox: string; flags: string }[]>();
    for (const r of rows) {
      const list = byMessage.get(r.message_id);
      if (list) list.push(r);
      else byMessage.set(r.message_id, [r]);
    }
    const providerIds = await deps.providerIds(chunk);
    for (const id of chunk) {
      const locs = byMessage.get(id);
      if (!locs) {
        if (providerIds.has(id) && !providerIds.get(id)?.startsWith("local:")) orphans.push(id);
        continue;
      }
      updates.push({ messageId: id, flags: deps.state(locs) });
    }
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
function twinKey(e: { subject: string; fromEmail: string; date: number; size: number; rfcMessageId?: string | null }): string {
  return `${e.rfcMessageId ?? ""}\u0000${e.fromEmail}\u0000${e.date}\u0000${e.size}\u0000${e.subject}`;
}

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
  const isRole = (m: ListedMailbox) => rolePaths.has(m.path) || isInbox(m.path) || Boolean(m.specialUse);
  const unusable = (m: ListedMailbox) => m.flags.has("\\NonExistent");
  const groupOnly = (m: ListedMailbox) => m.flags.has("\\Noselect");
  // bounded before any work (Codex R1): a server listing more than this is cut, never walked whole
  const bounded = list.length > LISTED_MAX ? list.slice(0, LISTED_MAX) : list;
  const candidates = bounded.filter((m) => !isRole(m) && !unusable(m) && m.path.length <= 1000);
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
  const groups = new Set(candidates.filter(groupOnly).map((m) => m.path));
  const groupLengths = new Set([...groups].map((p) => p.length));
  let lastParent = "";
  for (const m of groups.size ? candidates : []) {
    if (groupOnly(m) || !m.delimiter) continue;
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
    .filter((m) => !groupOnly(m) || ancestors.has(m.path))
    .map((m) => ({ key: m.path, path: names(m), selectable: !groupOnly(m) }))
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

/** Name heuristics for servers without SPECIAL-USE (es/en/de variants). */
const NAME_HINTS: Record<Exclude<Role, "inbox" | "all">, RegExp> = {
  sent: /^(inbox[./])?(sent|sent items|sent messages|sent mail|enviados|elementos enviados|gesendet)$/i,
  archive: /^(inbox[./])?(archive|archives|archivo|archivados|archiv)$/i,
  junk: /^(inbox[./])?(junk|spam|junk e-?mail|correo no deseado|bulk mail)$/i,
  trash: /^(inbox[./])?(trash|deleted items|deleted messages|papelera|elementos eliminados|bin|papierkorb)$/i,
  drafts: /^(inbox[./])?(drafts|borradores|entwürfe)$/i,
};

export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const e = error as { authenticationFailed?: boolean; serverResponseCode?: string; code?: string; responseStatus?: string; message?: string };
  const message = e?.message ?? String(error);
  // the server refused the login: a sign-in to redo (plan 25), unless it says the refusal is temporary (RFC 5530)
  if (e.authenticationFailed) return e.serverResponseCode === "UNAVAILABLE" ? new ProviderError(L("errors.imap.loginFailed", { detail: message }), true) : new ProviderAuthError(L("errors.imap.loginFailed", { detail: message }));
  if (e.responseStatus === "NO" || e.responseStatus === "BAD") return new ProviderError(`IMAP: ${message}`, false);
  // the server couldn't be reached or the connection died (plan 20): waits for the network
  if (isNetworkError(error)) return ProviderError.network(`IMAP: ${message}`);
  return new ProviderError(`IMAP: ${message}`, true);
}

const messageKey = (id: string | undefined | null) => (id ? id.replace(/[<>]/g, "").trim().toLowerCase() : null);

function hasAttachmentPart(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.disposition === "attachment") return true;
  return (node.childNodes ?? []).some(hasAttachmentPart);
}

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
  const watchers = new Set<{ restart(): void; ping(): void }>();

  const makeClient = async (forIdle = false) => {
    const password = await ctx.getSecret("password");
    if (!password) throw new ProviderAuthError(L("errors.imap.noPassword"));
    return new ImapFlow({
      host: config.imap.host,
      port: config.imap.port,
      secure: config.imap.secure,
      // never fall back to plaintext on a non-TLS port: a stripped STARTTLS would leak the password
      doSTARTTLS: options.allowInsecure ? false : config.imap.secure ? undefined : true,
      auth: { user: config.imap.user, pass: password },
      logger: false,
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
      return c;
    })().finally(() => {
      if (connecting === attempt) connecting = null;
    });
    connecting = attempt;
    return attempt.promise;
  }

  /** Runs fn on a live connection; a transient failure gets one retry on a fresh session. */
  async function withConnection<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    let c: ImapFlow | null = null;
    try {
      c = await connection();
      return await fn(c);
    } catch (error) {
      const e = toProviderError(error);
      if (!e.retryable) throw e;
      // only the session that failed goes (another caller may already hold a fresh one); never LOGOUT on
      // it: on a dead socket that waits for the timeout
      if (c) {
        if (client === c) client = null;
        c.close();
      }
      try {
        return await fn(await connection());
      } catch (again) {
        throw toProviderError(again);
      }
    }
  }

  async function discoverRoles(c: ImapFlow, listed?: readonly ListedMailbox[]): Promise<Partial<Record<Role, string>>> {
    if (roles) return roles;
    const found: Partial<Record<Role, string>> = { inbox: "INBOX" };
    const list = listed ?? (await c.list());
    for (const mb of list) {
      const role = mb.specialUse ? SPECIAL_USE[mb.specialUse] : undefined;
      if (role && !found[role]) found[role] = mb.path;
    }
    for (const [role, re] of Object.entries(NAME_HINTS) as [Role, RegExp][]) {
      if (found[role]) continue;
      const mb = list.find((m) => re.test(m.path) || re.test(m.name));
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
  async function reconcile(messageIds: Set<number>, sink: SyncSink, keepOrphans = false): Promise<number[]> {
    return reconcileMessages(messageIds, { of: (ids) => locations.of(ids), providerIds: (ids) => store.providerIds(ids), state: stateFromLocations, updateFlags: (u) => sink.updateFlags(u), removeMessages: (ids) => sink.removeMessages(ids) }, keepOrphans);
  }

  /** Plan 68 (Codex R8, R9): messages about to lose locations, written down durably first; reconciliation clears them. */
  async function journal(cursor: Cursor, ids: Iterable<number>) {
    const next = await journalUnion(cursor.unlocated ?? [], ids);
    if (next === null) return;
    cursor.unlocated = bounded(cursor, next, IMAP_JOURNAL_LIMITS.unlocated);
    await ctx.saveCursor(cursor);
  }

  /**
   * A UIDVALIDITY reset: every UID stored for the mailbox is meaningless now. Its messages are written down first,
   * durably (with any an earlier pass couldn't finish recognising: `resetPending`, and the journal), and only then
   * unlocated, so a disconnect from here on still finds them (Codex R5, R6, R9). The sweep does it before any
   * identification, so every destination can recognise them (Codex R11).
   */
  async function resetLocations(cursor: Cursor, path: string, olduidvalidity: number, touched: Set<number>): Promise<Set<number>> {
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

  /**
   * `reidentify` (plan 68, Codex R1): a folder seen for the first time is read whole once, so mail already stored
   * (older than the window too) gains its location; mail it doesn't know is fetched only inside the window.
   * `recover`: every message that lost a location this pass or before (a vanished folder, a sweep, a reset, kept
   * orphans), by envelope, one index for every mailbox (Codex R11): a copy found anywhere is the same message, even
   * without a Message-ID, never a second one, and each is claimed once.
   * `checkpoint` (Codex R6): for a mailbox we already had, what its sweep saw (message count, mod-sequence): the
   * cursor never acknowledges changes that came after the sweep read the flags; null (a sweep that failed, or none)
   * checkpoints nothing, so the next pass looks again.
   */
  async function syncMailbox(c: ImapFlow, path: string, cursor: Cursor, sink: SyncSink, touched: Set<number>, opts: { reidentify?: boolean; recover?: AdoptIndex; checkpoint?: Snapshot | null; ambiguous?: Ambiguous[]; twins?: Map<string, number[]> } = {}) {
    const lock = await c.getMailboxLock(path);
    try {
      const mb = c.mailbox;
      if (!mb) return;
      const uidvalidity = Number(mb.uidValidity);
      let state = cursor.mailboxes[path];
      const hadState = state !== undefined;
      const reset = Boolean(state && state.uidvalidity !== uidvalidity);
      const resetOrphans = new Set<number>();
      const recover = opts.recover ?? new AdoptIndex();
      const twinsOf = opts.twins ?? new Map<string, number[]>();
      /**
       * Every stored ID-less message with this envelope, under any key, oldest first: read once a pass (paged, never
       * cut: Codex R20), one list shared by every message held back with it, so telling them apart stays linear.
       */
      const twinGroup = async (e: { subject: string; fromEmail: string; date: number; size: number; rfcMessageId?: string | null }, include: number | null): Promise<number[]> => {
        const at = twinKey(e);
        let group = twinsOf.get(at);
        if (!group) {
          group = await readTwins((after) => locations.twins(e, after, 500));
          twinsOf.set(at, group);
        }
        // the row found under the plain key, if its stored envelope differs (no date at all): one of them too
        if (include !== null && !group.includes(include)) {
          group.push(include);
          group.sort((x, y) => x - y);
        }
        return group;
      };
      if (state && state.uidvalidity !== uidvalidity) {
        // (the sweep normally did this already; here it's whatever is still pending, or a reset since the sweep)
        for (const id of await resetLocations(cursor, path, state.uidvalidity, touched)) resetOrphans.add(id);
        // candidates like any other, so a twin of theirs found here keeps its identity (Codex R12)
        await recover.add(resetOrphans, (ids) => locations.envelopes(ids));
        state = undefined;
      }
      const takeAny = (e: Omit<import("./adopt").Envelope, "id">) => recover.take(e, notHere);

      // plan 41: new UIDs past a uidnext we kept, same UIDVALIDITY, are live mail (not a first sync, not a reset)
      const live = state !== undefined;
      const reidentify = reset || opts.reidentify === true;
      // a candidate is usable here while this folder doesn't already hold it
      const notHere = async (id: number) => (await locations.get(id, path)) === null;
      // 1) messages we haven't seen
      // After a UIDVALIDITY reset every message must be re-identified, including ones older
      // than the sync window that we already have (otherwise they'd be dropped as orphans).
      const found = state
        ? ((await c.search({ uid: `${state.uidnext}:*` }, { uid: true })) || []).filter((u) => u >= state!.uidnext)
        : reidentify
          ? (await c.search({ all: true }, { uid: true })) || []
          : (await c.search({ since: new Date(sink.windowStart) }, { uid: true })) || [];
      const fresh: IncomingMessage[] = [];
      /** each fresh message's twin key: once written, it joins its envelope's group if one is kept (Codex R34) */
      const freshTwins: string[] = [];
      // held back here, handed over only once this folder's read completes: one that fails part-way keeps its old
      // cursor and is read again, never acknowledged past what it didn't read (Codex R23)
      const held: Ambiguous[] = [];
      /** provider keys already claimed in this pass (by UID): duplicates within one batch stay distinct */
      const claimed = new Map<string, number>();
      for (let i = 0; i < found.length; i += 250) {
        const batch = found.slice(i, i + 250);
        for await (const msg of c.fetch(batch, { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true, headers: ["references", "list-id", "list-unsubscribe", "precedence", "auto-submitted", ...ADDRESS_HEADERS] }, { uid: true })) {
          const m = msg as FetchMessageObject;
          const flags = [...(m.flags ?? new Set<string>())];
          /** an ID-less message whose stored twins are still placed: a copy, or one of them moved since its sweep */
          let ambiguousOf: number[] | null = null;
          /** a Message-ID held back: as a copy, the same message (this one) in one more folder (Codex R26) */
          let attachTo: number | null = null;
          /** a Message-ID held back with no plain-key row: as a copy, one of its twins in one more folder (Codex R29) */
          let idCopy = false;
          const env = m.envelope;
          // 1) this exact location is already known (e.g. recorded from a MOVE's COPYUID)
          const atLocation = await locations.at(path, uidvalidity, m.uid);
          if (atLocation !== null) {
            await upsertLocation(atLocation, path, uidvalidity, m.uid, flags);
            touched.add(atLocation);
            // placed: no longer a candidate, even if a pass that stopped left it in the journal (Codex R37)
            recover.drop(atLocation);
            resetOrphans.delete(atLocation);
            continue;
          }
          // Without a Message-ID, identify by content (date, sender, subject, size): stable across
          // moves and UIDVALIDITY resets, unlike a mailbox/UID-based key.
          const fingerprint = () =>
            `nomid:${createHash("sha1").update(`${new Date(env?.date ?? m.internalDate ?? 0).getTime()}|${env?.from?.[0]?.address ?? ""}|${env?.subject ?? ""}|${m.size ?? 0}`).digest("hex")}`;
          let key = messageKey(env?.messageId) ?? fingerprint();
          let existing = await store.messageByProviderId(key);
          if (existing && messageKey(env?.messageId)) {
            // Same Message-ID but clearly different content (sender/subject): a collision, not a copy.
            const sameContent = existing.subject === (env?.subject ?? "") && existing.fromEmail === (env?.from?.[0]?.address ?? "").toLowerCase();
            if (!sameContent) {
              key = `${key}#${fingerprint()}`;
              existing = await store.messageByProviderId(key);
            }
          }
          if (existing && !messageKey(env?.messageId)) {
            // A fingerprint is only evidence enough to re-attach a message that currently has no
            // live location (it moved, or its mailbox was reset). Otherwise two distinct messages
            // with identical envelopes must stay separate.
            const live = await locations.count(existing.id);
            // a message of a folder that vanished this pass is this one, moved (a rename): re-attached, not copied
            if (live > 0 && !recover.ids.has(existing.id)) {
              // its twin, moved or renamed or reset, under a key of its old place: recognised by envelope (Codex R8)
              const twin = await takeAny({ subject: env?.subject ?? "", fromEmail: (env?.from?.[0]?.address ?? "").toLowerCase(), date: new Date(env?.date ?? m.internalDate ?? 0).getTime(), size: m.size ?? 0, rfcMessageId: null });
              if (twin !== null) {
                resetOrphans.delete(twin);
                await upsertLocation(twin, path, uidvalidity, m.uid, flags);
                touched.add(twin);
                continue;
              }
              // a copy, or a stored twin (under any key: Codex R19) moved here after its folder's sweep: told apart once
              // every folder is read (Codex R18)
              const e = { subject: env?.subject ?? "", fromEmail: (env?.from?.[0]?.address ?? "").toLowerCase(), date: new Date(env?.date ?? m.internalDate ?? 0).getTime(), size: m.size ?? 0 };
              ambiguousOf = await twinGroup(e, existing.id);
              key = `${key}#${path}:${uidvalidity}:${m.uid}`;
              existing = await store.messageByProviderId(key);
            }
          }
          // a renamed folder's ID-less copy: by its envelope, from the index (Codex R4: never a scan per message)
          const envelope = { subject: env?.subject ?? "", fromEmail: (env?.from?.[0]?.address ?? "").toLowerCase(), date: new Date(env?.date ?? m.internalDate ?? 0).getTime(), size: m.size ?? 0 };
          // mail that lost its place (moved, renamed, reset, under an older key scheme) with no row under the plain key:
          // by its envelope (and Message-ID: Codex R28, a Message-ID twin whose plain-key one was deleted); a row
          // already re-attached in this mailbox can't be claimed twice
          if (!existing && recover.size) {
            const found = await takeAny({ ...envelope, rfcMessageId: messageKey(env?.messageId) });
            if (found !== null) {
              resetOrphans.delete(found);
              await upsertLocation(found, path, uidvalidity, m.uid, flags);
              touched.add(found);
              continue;
            }
          }
          // no row under the plain key (it was deleted), yet twins under other keys: a copy, or one of them moved here
          // late; told apart like the rest, before the window decides anything (Codex R20)
          if (!existing && ambiguousOf === null) {
            const group = await twinGroup({ ...envelope, rfcMessageId: messageKey(env?.messageId) }, null);
            if (group.length) {
              ambiguousOf = group;
              // a Message-ID's copy is the same message in one more folder: one of its twins gains the place (Codex R29)
              if (messageKey(env?.messageId)) idCopy = true;
              // a copy held back gets a key of its own place: two of them, in two folders, are never one (Codex R21)
              key = `${key}#${path}:${uidvalidity}:${m.uid}`;
            }
          }
          // a Message-ID twin that lost its place this pass (moved here) is this one, not the twin still placed under the
          // plain key, which would otherwise take its place and leave it to be deleted (Codex R25)
          if (existing && messageKey(env?.messageId) && recover.size && !recover.ids.has(existing.id) && (await locations.count(existing.id)) > 0) {
            const twin = await takeAny({ ...envelope, rfcMessageId: messageKey(env?.messageId) });
            if (twin !== null) {
              resetOrphans.delete(twin);
              await upsertLocation(twin, path, uidvalidity, m.uid, flags);
              touched.add(twin);
              continue;
            }
          }
          // a Message-ID with twins (the same envelope stored more than once), the plain-key one still placed elsewhere:
          // a copy of it here, or one of the others moved here after its folder's sweep; told apart once every folder
          // is read, like ID-less twins (Codex R26)
          // (the plain-key one here already too: Codex R27); as a copy, the plain-key one gains this place if it has
          // none here yet, else it's a message of its own, under a key of its place
          let idHeld = false;
          if (existing && messageKey(env?.messageId) && ambiguousOf === null && (await locations.count(existing.id)) > 0) {
            const group = await twinGroup({ ...envelope, rfcMessageId: messageKey(env?.messageId) }, existing.id);
            if (group.length > 1) {
              ambiguousOf = group;
              idHeld = true;
              idCopy = true;
              attachTo = existing.id;
              key = `${key}#${path}:${uidvalidity}:${m.uid}`;
            }
          }
          if (existing && !idHeld) {
            // 2) same Message-ID: the same message in another folder (moved/copied, our sent mail)…
            const sameMailbox = await locations.get(existing.id, path);
            if (!sameMailbox || sameMailbox.uidvalidity !== uidvalidity || sameMailbox.uid === m.uid) {
              await upsertLocation(existing.id, path, uidvalidity, m.uid, flags);
              touched.add(existing.id);
              resetOrphans.delete(existing.id);
              recover.drop(existing.id);
              continue;
            }
            // …unless a different UID in the same mailbox already holds it: a distinct message
            // that reuses the Message-ID. Keep both instead of collapsing them. A renamed folder's twin is
            // already stored under the old path's key: found by its envelope, re-attached (plan 68, Codex R2)
            if (recover.size) {
              const twin = await takeAny({ ...envelope, rfcMessageId: messageKey(env?.messageId) });
              if (twin !== null) {
                resetOrphans.delete(twin);
                await upsertLocation(twin, path, uidvalidity, m.uid, flags);
                touched.add(twin);
                continue;
              }
            }
            key = `${key}#${path}:${uidvalidity}:${m.uid}`;
          }
          if (claimed.has(key) && claimed.get(key) !== m.uid) key = `${key}#${path}:${uidvalidity}:${m.uid}`;
          claimed.set(key, m.uid);
          // only re-identify old mail; one held back is told apart first (Codex R19: a twin moved here keeps its identity)
          const old = reidentify && new Date(env?.date ?? m.internalDate ?? Date.now()).getTime() < sink.windowStart;
          if (old && ambiguousOf === null) continue;
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
          if (ambiguousOf !== null && opts.ambiguous) held.push({ candidates: ambiguousOf, incoming, old, path, uidvalidity, uid: m.uid, flags, live, uidnext: Number(mb.uidNext), attachTo, idCopy });
          else if (!old) {
            fresh.push(incoming);
            freshTwins.push(twinKey({ ...envelope, rfcMessageId: messageKey(env?.messageId) }));
          }
        }
      }
      if (fresh.length) await sink.ingest(fresh, { live });

      // written: in the groups kept for its envelope, so a folder read later (or a message held back) sees it as a
      // twin, never only the ones there were before (Codex R34: a copy moved on would take the original's place)
      const written = await storedIds(fresh.map((m) => m.providerMsgId!), (key) => store.messageByProviderId(key), true);
      await addAll(touched, written.filter((id): id is number => id !== null));
      await joinGroups(twinsOf, freshTwins, written);
      // a first read or a reset read everything now; a mailbox we had is acknowledged as its sweep saw it
      const seen: Snapshot | null = reset || !hadState ? snapshotOf(mb) : (opts.checkpoint ?? null);
      // a message set aside isn't acknowledged until it's told apart: a pass that stops first reads it again
      const uidnext = heldUidnext(Number(mb.uidNext), held);
      cursor.mailboxes[path] = { uidvalidity, uidnext, ...(seen && { messages: seen.messages, ...(seen.modseq !== undefined && { modseq: seen.modseq }) }) };
      if (cursor.resetPending) delete cursor.resetPending[path];
      // one at a time: a folder may hold back more than an argument list takes (Codex R24: 150,000 copies)
      if (opts.ambiguous) for (const a of held) opts.ambiguous.push(a);
    } finally {
      lock.release();
    }
  }

  /**
   * Plan 68 (Codex R18): ID-less messages set aside because their stored twin was still placed elsewhere, told apart
   * now that every folder is read: where the twin's places are all gone from the server (one lock and one search per
   * mailbox), it moved here after its folder's sweep, so it keeps its identity, thread and categories; otherwise it's
   * a copy. A mailbox no longer listed holds nothing (a rename's old name); one that can't be read fails the pass, and
   * what was held back is read again next time (nothing merged, or copied, on a guess).
   */
  async function tellApart(c: ImapFlow, list: readonly Ambiguous[], listed: ReadonlySet<string>, sink: SyncSink, touched: Set<number>) {
    if (!list.length) return;
    // every candidate's places (another UID in the same folder counts: Codex R19), gathered a slice at a time
    const { places, byMailbox } = await gatherPlaces(list, (ids) => locations.of(ids));
    const present = new Set<string>();
    for (const [mailbox, box] of byMailbox) {
      if (sink.signal.aborted) return;
      if (!listed.has(mailbox)) continue;
      const all = [...box.uids];
      const lock = await c.getMailboxLock(mailbox);
      try {
        if (Number(c.mailbox && c.mailbox.uidValidity) !== box.uidvalidity) continue;
        for (let i = 0; i < all.length; i += 500) for (const uid of (await c.search({ uid: all.slice(i, i + 500).join(",") }, { uid: true })) || []) present.add(`${mailbox}\u0000${uid}`);
      } finally {
        lock.release();
      }
    }
    // what each held-back message is (planned in one linear pass, a few milliseconds a turn, then written a slice at
    // a time: Codex R30, R31)
    const steps = planSteps(list, places, present);
    let plan: Plan<Ambiguous>;
    for (;;) {
      const until = performance.now() + 4;
      let r = steps.next();
      while (!r.done && performance.now() < until) r = steps.next();
      if (r.done) {
        plan = r.value;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // old places of the ones that moved, per mailbox: removed together once the new ones are written (Codex R24: one
    // at a time re-read a long conversation each time)
    const leaving = new Map<string, number[]>();
    const breathe = breather();
    for (const { id, a, moved } of plan.placed) {
      // its new place first, then the old ones go: a stop in between leaves it placed, never placeless (Codex R22)
      await upsertLocation(id, a.path, a.uidvalidity, a.uid, a.flags);
      if (moved) {
        for (const l of places.get(id)!) {
          if (l.mailbox === a.path) continue;
          const ids = leaving.get(l.mailbox) ?? [];
          ids.push(id);
          leaving.set(l.mailbox, ids);
        }
      }
      touched.add(id);
      await breathe();
    }
    const copies = plan.copies;
    for (const [mailbox, ids] of leaving) await locations.removeMany(ids, mailbox);
    if (copies.length) await sink.ingest(copies.map((a) => a.incoming), { live: list.some((a) => a.live) });
    await addAll(touched, (await storedIds(copies.map((a) => a.incoming.providerMsgId!), (key) => store.messageByProviderId(key), true)).filter((id): id is number => id !== null));
  }



  /**
   * Plan 68 (Codex R5): what the server expunged, and flags it changed, for mail we already have: run for every
   * mailbox before any new mail is identified, so a message moved between folders (the destination synced first)
   * finds its old location gone and keeps its identity, its thread and categories, never a second copy.
   */
  async function sweepMailbox(c: ImapFlow, path: string, cursor: Cursor, touched: Set<number>): Promise<Snapshot | null> {
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
      // gathered and split a few thousand at a time (Codex R46: 500,000 mapped and filtered at once, 46 to 71 ms)
      const serverUids = new Set<number>();
      await addAll(serverUids, (await c.search({ all: true }, { uid: true })) || []);
      const known = await readMailbox(locations, path, uidvalidity);
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
        for await (const msg of c.fetch(stillThere.slice(i, i + 1000), { uid: true, flags: true }, { uid: true })) {
          const k = byUid.get(msg.uid);
          if (!k) continue;
          const flags = JSON.stringify([...(msg.flags ?? new Set<string>())]);
          if (flags !== k.flags) {
            await locations.setFlags(k.message_id, path, flags);
            touched.add(k.message_id);
          }
        }
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
    const pending = await store.pendingBodies(options.bodiesPerSync ?? 500);
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
            const parsed = await parseRaw(msg.source);
            await sink.setBody(id, parsed.text, parsed.html, parsed.captureUnavailable ? undefined : parsed.attachments, parsed.captureUnavailable ? { captureUnavailable: parsed.captureUnavailable } : undefined);
          }
        }
      } finally {
        lock.release();
      }
    }
    await sink.setSyncState({ bodiesPending: await store.countPendingBodies() });
  }

  type Loc = { message_id: number; mailbox: string; uid: number; uidvalidity: number };

  /** Throws (retryable) if the mailbox's UIDVALIDITY no longer matches our stored UIDs. */
  function assertValidity(c: ImapFlow, mailbox: string, items: Loc[]) {
    const current = Number(c.mailbox && c.mailbox.uidValidity);
    if (items.some((i) => i.uidvalidity !== current)) {
      throw new ProviderError(`UIDVALIDITY of ${mailbox} changed; waiting for resync before touching messages`, true);
    }
  }

  function targetedCapability(c: ImapFlow, capability: "MOVE" | "UIDPLUS"): boolean {
    // IMAP4rev2 folds both extensions into the active base protocol.
    return c.capabilities.has(capability) || c.enabled.has("IMAP4REV2") || (c.capabilities.has("IMAP4rev2") && !c.capabilities.has("IMAP4rev1"));
  }

  async function moveLocations(c: ImapFlow, locs: Loc[], destination: string | (() => Promise<string>), mode: "move" | "copy" = "move") {
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
        assertValidity(c, mailbox, items);
        if (mode === "move" && c.mailbox && c.mailbox.readOnly) throw new ProviderError(L("errors.imap.readOnly"), false);
        const uids = items.map((i) => i.uid);
        const res = mode === "move" ? await c.messageMove(uids, target, { uid: true }) : await c.messageCopy(uids, target, { uid: true });
        if (!res) throw new ProviderError(`Could not ${mode} messages to ${target}`, true);
        // the new places first, then the old ones go together (sliced, each thread looked at once: Codex R54, one
        // removal a message walked a long conversation again each time)
        for (const item of items) {
          const newUid = res.uidMap?.get(item.uid);
          if (newUid && res.uidValidity) await upsertLocation(item.message_id, target, Number(res.uidValidity), newUid, []);
        }
        if (mode === "move") await locations.removeMany(items.map((i) => i.message_id), mailbox);
      } finally {
        lock.release();
      }
    }
  }

  async function ensureMailbox(c: ImapFlow, role: Role, fallbackName: string): Promise<string> {
    const r = await discoverRoles(c);
    if (r[role]) return r[role]!;
    await c.mailboxCreate(fallbackName).catch(() => {});
    r[role] = fallbackName;
    return fallbackName;
  }

  async function send(payload: SendPayload): Promise<{ providerMsgId: string; warning?: Localized }> {
    const password = await ctx.getSecret("password");
    if (!password) throw new ProviderAuthError(L("errors.imap.noPassword"));
    // its own connection, made for this send: a network change never touches it (an outcome after DATA stays ambiguous)
    const { raw, rejected } = await sendViaSmtp({ ...config.smtp, password, allowInsecure: options.allowInsecure, socketTimeoutMs: timeouts.smtpSocketMs }, payload);
    if (config.appendToSent) {
      // Best effort: the message is already sent; a failed APPEND must not resend it.
      try {
        const c = await connection();
        const sent = await ensureMailbox(c, "sent", "Sent");
        await c.append(sent, raw, ["\\Seen"]);
      } catch {
        /* next sync still shows the local copy */
      }
    }
    return { providerMsgId: messageKey(payload.messageId)!, warning: rejected.length ? L("errors.smtp.notDeliveredTo", { recipients: rejected.join(", ") }) : undefined };
  }

  return {
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
        // one LIST a pass: the roles (kept) and the account's own folders (fresh: plan 68)
        const list = await c.list();
        const r = await discoverRoles(c, list);
        // plan 68 (Codex R3): mailboxes by path in a map with no prototype, so a folder named "__proto__" is a path like any other
        const loaded = await ctx.loadCursor<Cursor>();
        const cursor: Cursor = {
          ...loaded,
          mailboxes: Object.assign(Object.create(null) as Cursor["mailboxes"], loaded?.mailboxes),
          ...(loaded?.resetPending && { resetPending: Object.assign(Object.create(null) as Record<string, number[]>, loaded.resetPending) }),
        };
        cursor.pass = (cursor.pass ?? 0) + 1;
        const touched = new Set<number>();
        const folders = customFolders(list, r);
        // listed before they sync: a location in a listed folder is membership as it's written
        await sink.setFolders?.(folders);
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
        let skipped = 0;
        for (const f of folders) {
          if (!f.selectable || boxes.has(f.key)) continue;
          try {
            if (cursor.fullCheck || cursor.mailboxes[f.key] === undefined || !(await unchanged(c, f.key, cursor))) custom.push(f.key);
            else skipped++;
          } catch (error) {
            tolerate(error);
          }
        }
        // first what the server expunged everywhere, then new mail anywhere: a message moved between folders keeps its identity (Codex R5)
        const swept = new Map<string, Snapshot | null>();
        for (const path of boxes) {
          if (sink.signal.aborted) return;
          swept.set(path, await sweepMailbox(c, path, cursor, touched));
        }
        for (const path of custom) {
          if (sink.signal.aborted) return;
          try {
            swept.set(path, await sweepMailbox(c, path, cursor, touched));
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
        const listed = new Set(list.filter((m) => !m.flags.has("\\Noselect") && !m.flags.has("\\NonExistent")).map((m) => m.path));
        const vanished = Object.keys(cursor.mailboxes).filter((path) => !boxes.has(path) && !listed.has(path));
        const vanishedIds = new Set<number>();
        for (const path of vanished) await addAll(vanishedIds, (await readMailbox(locations, path, cursor.mailboxes[path]!.uidvalidity)).map((l) => l.message_id));
        // what sweeps unlocated (this pass, or one that failed before reconciling): reconciled at the end, and recognised if found again
        await addAll(touched, cursor.unlocated ?? []);
        // one index of everything that lost a place: vanished folders, the journal (sweeps, resets), orphans a partial
        // pass kept, resets still pending; shared by every mailbox, so each message is claimed once (Codex R10, R11)
        // gathered a few thousand at a time (Codex R43: 500,000 spread and flattened at once)
        const pending = new Set<number>();
        await addAll(pending, vanishedIds);
        await addAll(pending, cursor.unlocated ?? []);
        await addAll(pending, cursor.orphans ?? []);
        for (const ids of Object.values(cursor.resetPending ?? {})) await addAll(pending, ids);
        // a journal that was cut: every message with no location, a window at a time, before any mail is identified,
        // so one moved past the limit is recognised like the rest, never a new message beside a deleted one (Codex R15, R16)
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
        const ask = [...pending];
        const breathe = breather();
        for (let i = 0; i < ask.length; i += 500) {
          for (const l of await locations.of(ask.slice(i, i + 500))) if (!vanishedPaths.has(l.mailbox)) pending.delete(l.message_id);
          await breathe();
        }
        const recover = new AdoptIndex();
        await recover.add(pending, (ids) => locations.envelopes(ids));
        const ambiguous: Ambiguous[] = [];
        const twins = new Map<string, number[]>();
        for (const path of boxes) {
          if (sink.signal.aborted) return;
          await syncMailbox(c, path, cursor, sink, touched, { checkpoint: swept.get(path) ?? null, recover, ambiguous, twins });
        }
        for (const path of custom) {
          if (sink.signal.aborted) return;
          try {
            await syncMailbox(c, path, cursor, sink, touched, cursor.mailboxes[path] === undefined ? { reidentify: true, recover, ambiguous, twins } : { checkpoint: swept.get(path) ?? null, recover, ambiguous, twins });
          } catch (error) {
            tolerate(error);
          }
        }
        await tellApart(c, ambiguous, new Set([...boxes, ...listed]), sink, touched);
        if (sink.signal.aborted) return;
        // told apart: their folders acknowledged up to what the server had when read
        for (const a of ambiguous) {
          const state = cursor.mailboxes[a.path];
          if (state) state.uidnext = Math.max(state.uidnext, a.uidnext);
        }
        // a folder that's gone takes its locations now; what was only there (not found again under a new name) goes in reconcile
        for (const path of incomplete ? [] : vanished) {
          // written down before they go (Codex R9): a crash right after still reconciles them
          await journal(cursor, (await readMailbox(locations, path, cursor.mailboxes[path]!.uidvalidity)).map((l) => l.message_id));
          await addAll(touched, await locations.resetMailbox(path));
          delete cursor.mailboxes[path];
        }
        // what a failed pass kept is looked at again once a pass completes: still nowhere on the server, it goes
        // only a pass that read every folder and failed nowhere may delete an orphan: one that skipped a quiet
        // folder (STATUS) may have missed where a message moved, so its orphans wait and the next pass reads all (Codex R9)
        const full = !incomplete && skipped === 0;
        await addAll(touched, cursor.unlocated ?? []);
        if (full) await addAll(touched, cursor.orphans ?? []);
        // what the cut journal's scan found (those found again have a place now: their flags, nothing more)
        const overflowed = full && cursor.overflow === true;
        if (overflowed) await addAll(touched, lost);
        const kept = await reconcile(touched, sink, !full);
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
        await ctx.saveCursor(cursor);
        await sink.setSyncState({ syncedSince: sink.windowStart });
        await syncBodies(c, sink);
      });
    },

    async execute(op: ProviderOp) {
      if (op.kind === "send") return send(op.payload as SendPayload);
      const ids = op.target.messageIds ?? [];
      if (ids.length === 0) return;
      await withConnection(async (c) => {
        const r = await discoverRoles(c);
        const locs: Loc[] = await locations.of(ids);
        const inRole = (role: Role) => locs.filter((l) => l.mailbox === r[role]);
        const flagOp = async (flag: string, add: boolean) => {
          const byMailbox = new Map<string, Loc[]>();
          for (const l of locs) byMailbox.set(l.mailbox, [...(byMailbox.get(l.mailbox) ?? []), l]);
          for (const [mailbox, items] of byMailbox) {
            const lock = await c.getMailboxLock(mailbox);
            try {
              assertValidity(c, mailbox, items);
              const uids = items.map((i) => i.uid);
              const ok = add ? await c.messageFlagsAdd(uids, [flag], { uid: true }) : await c.messageFlagsRemove(uids, [flag], { uid: true });
              // imapflow resolves false when the server rejects the STORE
              if (ok === false) throw new ProviderError(`Server refused to update ${flag} in ${mailbox}`, false);
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
            if (r.archive || !r.all) return void (await moveLocations(c, inbox, r.archive ?? (() => ensureMailbox(c, "archive", "Archive"))));
            if (!targetedCapability(c, "UIDPLUS")) throw new ProviderError(L("errors.imap.unsafeMove"), false);
            // Gmail-style: archiving = removing the INBOX copy; All Mail keeps it
            const lock = await c.getMailboxLock(r.inbox!);
            try {
              assertValidity(c, r.inbox!, inbox);
              if (c.mailbox && c.mailbox.readOnly) throw new ProviderError(L("errors.imap.readOnly"), false);
              const deleted = await c.messageDelete(inbox.map((l) => l.uid), { uid: true });
              if (!deleted) throw new ProviderError(L("errors.imap.changeRefused"), false);
              await locations.removeMany(inbox.map((l) => l.message_id), r.inbox!);
            } finally {
              lock.release();
            }
            return;
          }
          case "trash":
            return void (await moveLocations(c, locs.filter((l) => l.mailbox !== r.trash), r.trash ?? (() => ensureMailbox(c, "trash", "Trash"))));
          case "spam":
            return void (await moveLocations(c, locs.filter((l) => l.mailbox !== r.junk && l.mailbox !== r.sent), r.junk ?? (() => ensureMailbox(c, "junk", "Junk"))));
          case "notSpam":
            return void (await moveLocations(c, inRole("junk"), r.inbox!));
          case "moveToInbox": {
            const away = locs.filter((l) => l.mailbox !== r.inbox && l.mailbox !== r.sent);
            const all = away.filter((l) => l.mailbox === r.all);
            await moveLocations(c, away.filter((l) => l.mailbox !== r.all), r.inbox!);
            if (all.length) await moveLocations(c, all, r.inbox!, "copy");
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
          if (toProviderError(error) instanceof ProviderAuthError) return;
          schedule();
        }
      };
      const watcher = {
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
