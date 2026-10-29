import { FOLDERS_PER_ACCOUNT_MAX, MAX_INCOMING_MIME_BYTES } from "@terno/core";
import { createHash } from "node:crypto";
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { bulkHeaders } from "@terno/core";
import { L, type Localized } from "@terno/i18n";
import type { IncomingMessage, ProviderFolder } from "@terno/store";
import { headerFields, messageAddresses, parseListId, parseRaw, splitIds } from "./mime";
import { isNetworkError } from "./net-errors";
import { comparePaths } from "./paths";
import { AdoptIndex } from "./adopt";
import { sendViaSmtp } from "./smtp";
import { ProviderAuthError, ProviderError, type FlagUpdate, type ImapAccountConfig, type MailProvider, type ProviderContext, type ProviderOp, type SendPayload, type SyncSink } from "./types";

type Role = "inbox" | "sent" | "archive" | "all" | "junk" | "trash" | "drafts";

interface MailboxState {
  uidvalidity: number;
  uidnext: number;
  /** plan 65: what STATUS compares before a custom folder is synced again (absent: never skipped) */
  messages?: number;
  modseq?: string;
}

interface Cursor {
  mailboxes: Record<string, MailboxState>;
  /** plan 65: sync passes so far; without CONDSTORE an unchanged-looking folder is still checked every CHECK_EVERY */
  pass?: number;
  /** plan 65 (Codex R4): messages a failed pass left without a location; the next complete pass reconciles them */
  orphans?: number[];
  /** plan 65 (Codex R5): per mailbox, the messages a UIDVALIDITY reset unlocated, kept until that mailbox syncs, so a retry can still recognise them */
  resetPending?: Record<string, number[]>;
  /** plan 65 (Codex R8, R9): messages any step unlocated (a sweep, a reset, a vanished folder), written down before their locations go; cleared once reconciled */
  unlocated?: number[];
  /** plan 65 (Codex R9): orphans are waiting for a pass that reads every folder (no STATUS skip), the only kind that may delete them */
  fullCheck?: boolean;
}

/** Plan 65: a LIST longer than this is cut before any work (a catalog keeps FOLDERS_PER_ACCOUNT_MAX at most). */
const LISTED_MAX = 2 * FOLDERS_PER_ACCOUNT_MAX;

/** Plan 65: a mailbox as STATUS compares it (its message count, its mod-sequence where the server has one). */
interface Snapshot {
  messages: number;
  modseq?: string;
}
const snapshotOf = (mb: { exists: number; highestModseq?: bigint }): Snapshot => ({ messages: mb.exists, ...(mb.highestModseq !== undefined && { modseq: String(mb.highestModseq) }) });

/** Plan 65: without HIGHESTMODSEQ, flag changes don't show in STATUS: a quiet folder is checked on every fourth pass. */
const CHECK_EVERY = 4;

type ListedMailbox = Awaited<ReturnType<ImapFlow["list"]>>[number];

/**
 * Plan 65: the account's own folders in a LIST: what holds no role, isn't a server special (Gmail's Starred,
 * Important…) and exists. A \Noselect parent is listed only to group folders under it. A leading INBOX in the
 * path (servers that keep every folder under it) isn't shown. Bounded: names, path length and count.
 */
export function customFolders(list: readonly ListedMailbox[], roles: Partial<Record<Role, string>>): ProviderFolder[] {
  // paths compare exactly (a server may hold "Sent" and "sent"); only INBOX is case-insensitive (RFC 3501, Codex R2)
  const rolePaths = new Set(Object.values(roles) as string[]);
  const isRole = (m: ListedMailbox) => rolePaths.has(m.path) || m.path.toUpperCase() === "INBOX" || Boolean(m.specialUse);
  const unusable = (m: ListedMailbox) => m.flags.has("\\NonExistent");
  const groupOnly = (m: ListedMailbox) => m.flags.has("\\Noselect");
  // bounded before any work (Codex R1): a server listing more than this is cut, never walked whole
  const bounded = list.length > LISTED_MAX ? list.slice(0, LISTED_MAX) : list;
  const candidates = bounded.filter((m) => !isRole(m) && !unusable(m) && m.path.length <= 1000);
  const names = (m: ListedMailbox) => {
    const parts = m.delimiter ? m.path.split(m.delimiter) : [m.path];
    if (parts.length > 1 && parts[0]!.toUpperCase() === "INBOX") parts.shift();
    // whole segments (a path is at most 1,000 characters): a shortened one could merge two hierarchies (Codex R9)
    return parts;
  };
  // a group with nothing under it says nothing: the ancestors of every real folder, gathered once (linear, Codex R1)
  const ancestors = new Set<string>();
  for (const m of candidates) {
    if (groupOnly(m) || !m.delimiter) continue;
    for (let i = m.path.lastIndexOf(m.delimiter); i > 0; i = m.path.lastIndexOf(m.delimiter, i - 1)) ancestors.add(m.path.slice(0, i));
  }
  return candidates
    .filter((m) => !groupOnly(m) || ancestors.has(m.path))
    .map((m) => ({ key: m.path, path: names(m), selectable: !groupOnly(m) }))
    .sort((a, b) => comparePaths(a.path, b.path))
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

  /** `keepOrphans` (plan 65, Codex R3): a pass where a folder failed part-way may have taken locations it didn't give back yet: nothing is removed for it */
  async function reconcile(messageIds: Set<number>, sink: SyncSink, keepOrphans = false): Promise<number[]> {
    if (messageIds.size === 0) return [];
    const ids = [...messageIds];
    const updates: FlagUpdate[] = [];
    const orphans: number[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = await locations.of(chunk);
      const byMessage = new Map<number, { mailbox: string; flags: string }[]>();
      for (const r of rows) byMessage.set(r.message_id, [...(byMessage.get(r.message_id) ?? []), r]);
      const providerIds = await store.providerIds(chunk);
      for (const id of chunk) {
        const locs = byMessage.get(id);
        // a local optimistic send (no server copy yet) has no locations: keep it
        if (!locs) {
          if (providerIds.has(id) && !providerIds.get(id)?.startsWith("local:")) orphans.push(id);
          continue;
        }
        updates.push({ messageId: id, flags: stateFromLocations(locs) });
      }
    }
    if (updates.length) await sink.updateFlags(updates);
    if (orphans.length && !keepOrphans) await sink.removeMessages(orphans);
    return orphans;
  }

  /** Plan 65 (Codex R8, R9): messages about to lose locations, written down durably first; reconciliation clears them. */
  async function journal(cursor: Cursor, ids: Iterable<number>) {
    const next = new Set([...(cursor.unlocated ?? []), ...ids]);
    if (next.size === (cursor.unlocated?.length ?? 0)) return;
    cursor.unlocated = [...next].slice(-200_000);
    await ctx.saveCursor(cursor);
  }

  /**
   * A UIDVALIDITY reset: every UID stored for the mailbox is meaningless now. Its messages are written down first,
   * durably (with any an earlier pass couldn't finish recognising: `resetPending`, and the journal), and only then
   * unlocated, so a disconnect from here on still finds them (Codex R5, R6, R9). The sweep does it before any
   * identification, so every destination can recognise them (Codex R11).
   */
  async function resetLocations(cursor: Cursor, path: string, olduidvalidity: number, touched: Set<number>): Promise<Set<number>> {
    const ids = new Set<number>(cursor.resetPending?.[path] ?? []);
    for (const l of await locations.inMailbox(path, olduidvalidity)) ids.add(l.message_id);
    cursor.resetPending ??= Object.create(null) as Record<string, number[]>;
    cursor.resetPending[path] = [...ids].slice(0, 200_000);
    cursor.unlocated = [...new Set([...(cursor.unlocated ?? []), ...ids])].slice(-200_000);
    await ctx.saveCursor(cursor);
    for (const id of await locations.resetMailbox(path)) ids.add(id);
    for (const id of ids) touched.add(id);
    return ids;
  }

  /**
   * `reidentify` (plan 65, Codex R1): a folder seen for the first time is read whole once, so mail already stored
   * (older than the window too) gains its location; mail it doesn't know is fetched only inside the window.
   * `recover`: every message that lost a location this pass or before (a vanished folder, a sweep, a reset, kept
   * orphans), by envelope, one index for every mailbox (Codex R11): a copy found anywhere is the same message, even
   * without a Message-ID, never a second one, and each is claimed once.
   * `checkpoint` (Codex R6): for a mailbox we already had, what its sweep saw (message count, mod-sequence): the
   * cursor never acknowledges changes that came after the sweep read the flags; null (a sweep that failed, or none)
   * checkpoints nothing, so the next pass looks again.
   */
  async function syncMailbox(c: ImapFlow, path: string, cursor: Cursor, sink: SyncSink, touched: Set<number>, opts: { reidentify?: boolean; recover?: AdoptIndex; checkpoint?: Snapshot | null } = {}) {
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
      /** provider keys already claimed in this pass (by UID): duplicates within one batch stay distinct */
      const claimed = new Map<string, number>();
      for (let i = 0; i < found.length; i += 250) {
        const batch = found.slice(i, i + 250);
        for await (const msg of c.fetch(batch, { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true, headers: ["references", "list-id", "list-unsubscribe", "precedence", "auto-submitted", ...ADDRESS_HEADERS] }, { uid: true })) {
          const m = msg as FetchMessageObject;
          const flags = [...(m.flags ?? new Set<string>())];
          const env = m.envelope;
          // 1) this exact location is already known (e.g. recorded from a MOVE's COPYUID)
          const atLocation = await locations.at(path, uidvalidity, m.uid);
          if (atLocation !== null) {
            await upsertLocation(atLocation, path, uidvalidity, m.uid, flags);
            touched.add(atLocation);
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
              key = `${key}#${path}:${uidvalidity}:${m.uid}`;
              existing = await store.messageByProviderId(key);
            }
          }
          // a renamed folder's ID-less copy: by its envelope, from the index (Codex R4: never a scan per message)
          const envelope = { subject: env?.subject ?? "", fromEmail: (env?.from?.[0]?.address ?? "").toLowerCase(), date: new Date(env?.date ?? m.internalDate ?? 0).getTime(), size: m.size ?? 0 };
          // ID-less mail that lost its place (moved, renamed, reset, under an older key scheme): by its envelope;
          // a row already re-attached in this mailbox can't be claimed twice
          if (!existing && recover.size && !messageKey(env?.messageId)) {
            const found = await takeAny({ ...envelope, rfcMessageId: null });
            if (found !== null) {
              resetOrphans.delete(found);
              await upsertLocation(found, path, uidvalidity, m.uid, flags);
              touched.add(found);
              continue;
            }
          }
          if (existing) {
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
            // already stored under the old path's key: found by its envelope, re-attached (plan 65, Codex R2)
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
          if (reidentify && new Date(env?.date ?? m.internalDate ?? Date.now()).getTime() < sink.windowStart) continue; // only re-identify old mail
          const role = roleOf(path);
          // the raw address fields, read by our parser (plan 34); the server's envelope where one is missing
          const addrs = messageAddresses(headerFields(m.headers), { from: env?.from, to: env?.to, cc: env?.cc, bcc: env?.bcc, replyTo: env?.replyTo });
          fresh.push({
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
          });
        }
      }
      if (fresh.length) await sink.ingest(fresh, { live });

      for (const m of fresh) {
        const row = await store.messageByProviderId(m.providerMsgId!);
        if (row) touched.add(row.id);
      }
      // a first read or a reset read everything now; a mailbox we had is acknowledged as its sweep saw it
      const seen: Snapshot | null = reset || !hadState ? snapshotOf(mb) : (opts.checkpoint ?? null);
      cursor.mailboxes[path] = { uidvalidity, uidnext: Number(mb.uidNext), ...(seen && { messages: seen.messages, ...(seen.modseq !== undefined && { modseq: seen.modseq }) }) };
      if (cursor.resetPending) delete cursor.resetPending[path];
    } finally {
      lock.release();
    }
  }

  /**
   * Plan 65 (Codex R5): what the server expunged, and flags it changed, for mail we already have: run for every
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
      const serverUids = new Set((await c.search({ all: true }, { uid: true })) || []);
      const known = await locations.inMailbox(path, uidvalidity);
      const byUid = new Map(known.map((k) => [k.uid, k]));
      const gone = known.filter((k) => !serverUids.has(k.uid));
      if (gone.length) {
        // written down first, durably: a moved message is recognised under its new folder, an expunged one
        // reconciled, even if the connection drops before this pass ends (Codex R8)
        await journal(cursor, gone.map((k) => k.message_id));
      }
      // in slices, each thread's membership looked at once (Codex R11: one at a time was quadratic in a long conversation)
      await locations.removeMany(gone.map((k) => k.message_id), path);
      for (const k of gone) touched.add(k.message_id);
      const stillThere = known.filter((k) => serverUids.has(k.uid)).map((k) => k.uid);
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

  /** Plan 65: a custom folder STATUS says hasn't changed since the cursor (UIDVALIDITY included) needs no pass. */
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
    for (const l of locs) if (l.mailbox !== target) byMailbox.set(l.mailbox, [...(byMailbox.get(l.mailbox) ?? []), l]);
    for (const [mailbox, items] of byMailbox) {
      const lock = await c.getMailboxLock(mailbox);
      try {
        assertValidity(c, mailbox, items);
        if (mode === "move" && c.mailbox && c.mailbox.readOnly) throw new ProviderError(L("errors.imap.readOnly"), false);
        const uids = items.map((i) => i.uid);
        const res = mode === "move" ? await c.messageMove(uids, target, { uid: true }) : await c.messageCopy(uids, target, { uid: true });
        if (!res) throw new ProviderError(`Could not ${mode} messages to ${target}`, true);
        for (const item of items) {
          if (mode === "move") await locations.remove(item.message_id, mailbox);
          const newUid = res.uidMap?.get(item.uid);
          if (newUid && res.uidValidity) await upsertLocation(item.message_id, target, Number(res.uidValidity), newUid, []);
        }
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
        // one LIST a pass: the roles (kept) and the account's own folders (fresh: plan 65)
        const list = await c.list();
        const r = await discoverRoles(c, list);
        // plan 65 (Codex R3): mailboxes by path in a map with no prototype, so a folder named "__proto__" is a path like any other
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
        const listed = new Set(list.map((m) => m.path));
        const vanished = Object.keys(cursor.mailboxes).filter((path) => !boxes.has(path) && !listed.has(path));
        const vanishedIds = new Set<number>();
        for (const path of vanished) for (const l of await locations.inMailbox(path, cursor.mailboxes[path]!.uidvalidity)) vanishedIds.add(l.message_id);
        // what sweeps unlocated (this pass, or one that failed before reconciling): reconciled at the end, and recognised if found again
        for (const id of cursor.unlocated ?? []) touched.add(id);
        // one index of everything that lost a place: vanished folders, the journal (sweeps, resets), orphans a partial
        // pass kept, resets still pending; shared by every mailbox, so each message is claimed once (Codex R10, R11)
        const pending = new Set([...vanishedIds, ...(cursor.unlocated ?? []), ...(cursor.orphans ?? []), ...Object.values(cursor.resetPending ?? {}).flat()]);
        const recover = new AdoptIndex();
        await recover.add(pending, (ids) => locations.envelopes(ids));
        for (const path of boxes) {
          if (sink.signal.aborted) return;
          await syncMailbox(c, path, cursor, sink, touched, { checkpoint: swept.get(path) ?? null, recover });
        }
        for (const path of custom) {
          if (sink.signal.aborted) return;
          try {
            await syncMailbox(c, path, cursor, sink, touched, cursor.mailboxes[path] === undefined ? { reidentify: true, recover } : { checkpoint: swept.get(path) ?? null, recover });
          } catch (error) {
            tolerate(error);
          }
        }
        // a folder that's gone takes its locations now; what was only there (not found again under a new name) goes in reconcile
        for (const path of incomplete ? [] : vanished) {
          // written down before they go (Codex R9): a crash right after still reconciles them
          await journal(cursor, (await locations.inMailbox(path, cursor.mailboxes[path]!.uidvalidity)).map((l) => l.message_id));
          for (const id of await locations.resetMailbox(path)) touched.add(id);
          delete cursor.mailboxes[path];
        }
        // what a failed pass kept is looked at again once a pass completes: still nowhere on the server, it goes
        // only a pass that read every folder and failed nowhere may delete an orphan: one that skipped a quiet
        // folder (STATUS) may have missed where a message moved, so its orphans wait and the next pass reads all (Codex R9)
        const full = !incomplete && skipped === 0;
        for (const id of cursor.unlocated ?? []) touched.add(id);
        if (full) for (const id of cursor.orphans ?? []) touched.add(id);
        const kept = await reconcile(touched, sink, !full);
        if (full) {
          delete cursor.orphans;
          delete cursor.fullCheck;
        } else if (kept.length) {
          cursor.orphans = [...new Set([...(cursor.orphans ?? []), ...kept])].slice(-100_000);
          cursor.fullCheck = true;
        }
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
              for (const l of inbox) await locations.remove(l.message_id, r.inbox!);
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
