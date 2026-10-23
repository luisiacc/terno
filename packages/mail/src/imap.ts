import { createHash } from "node:crypto";
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import type { IncomingMessage } from "@unica/store";
import { parseListId, parseRaw, splitIds } from "./mime";
import { sendViaSmtp } from "./smtp";
import { ProviderError, type FlagUpdate, type ImapAccountConfig, type MailProvider, type ProviderContext, type ProviderOp, type SendPayload, type SyncSink } from "./types";

type Role = "inbox" | "sent" | "archive" | "all" | "junk" | "trash" | "drafts";

interface MailboxState {
  uidvalidity: number;
  uidnext: number;
}

interface Cursor {
  mailboxes: Record<string, MailboxState>;
}

export interface ImapProviderOptions {
  /** plaintext/self-signed servers (tests, local bridges like Proton Bridge) */
  allowInsecure?: boolean;
  /** max bodies downloaded per sync pass */
  bodiesPerSync?: number;
}

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

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const e = error as { authenticationFailed?: boolean; code?: string; responseStatus?: string; message?: string };
  const message = e?.message ?? String(error);
  if (e.authenticationFailed) return new ProviderError(`IMAP login failed: ${message}`, false);
  if (e.responseStatus === "NO" || e.responseStatus === "BAD") return new ProviderError(`IMAP: ${message}`, false);
  return new ProviderError(`IMAP: ${message}`, true);
}

const messageKey = (id: string | undefined | null) => (id ? id.replace(/[<>]/g, "").trim().toLowerCase() : null);

function hasAttachmentPart(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.disposition === "attachment") return true;
  return (node.childNodes ?? []).some(hasAttachmentPart);
}

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

  const makeClient = async (forIdle = false) => {
    const password = await ctx.getSecret("password");
    if (!password) throw new ProviderError("Missing IMAP password", false);
    return new ImapFlow({
      host: config.imap.host,
      port: config.imap.port,
      secure: config.imap.secure,
      // never fall back to plaintext on a non-TLS port: a stripped STARTTLS would leak the password
      doSTARTTLS: options.allowInsecure ? false : config.imap.secure ? undefined : true,
      auth: { user: config.imap.user, pass: password },
      logger: false,
      disableAutoIdle: !forIdle,
      tls: options.allowInsecure ? { rejectUnauthorized: false } : undefined,
      connectionTimeout: 20_000,
    });
  };

  async function connection(): Promise<ImapFlow> {
    if (client?.usable) return client;
    const c = await makeClient();
    c.on("error", () => {});
    // the server may BYE us (e.g. UIDVALIDITY reset, idle timeout): never reuse a dead session
    c.on("close", () => {
      if (client === c) client = null;
    });
    try {
      await c.connect();
    } catch (error) {
      throw toProviderError(error);
    }
    client = c;
    return c;
  }

  /** Runs fn on a live connection; a transient failure gets one retry on a fresh session. */
  async function withConnection<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    try {
      return await fn(await connection());
    } catch (error) {
      const e = toProviderError(error);
      if (!e.retryable) throw e;
      const stale = client;
      client = null;
      await stale?.logout().catch(() => {});
      try {
        return await fn(await connection());
      } catch (again) {
        throw toProviderError(again);
      }
    }
  }

  async function discoverRoles(c: ImapFlow): Promise<Partial<Record<Role, string>>> {
    if (roles) return roles;
    const found: Partial<Record<Role, string>> = { inbox: "INBOX" };
    const list = await c.list();
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

  async function reconcile(messageIds: Set<number>, sink: SyncSink) {
    if (messageIds.size === 0) return;
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
    if (orphans.length) await sink.removeMessages(orphans);
  }

  async function syncMailbox(c: ImapFlow, path: string, cursor: Cursor, sink: SyncSink, touched: Set<number>) {
    const lock = await c.getMailboxLock(path);
    try {
      const mb = c.mailbox;
      if (!mb) return;
      const uidvalidity = Number(mb.uidValidity);
      let state = cursor.mailboxes[path];
      const reset = Boolean(state && state.uidvalidity !== uidvalidity);
      const resetOrphans = new Set<number>();
      if (state && state.uidvalidity !== uidvalidity) {
        // UIDVALIDITY changed: every UID we stored for this mailbox is meaningless now
        for (const id of await locations.resetMailbox(path)) {
          touched.add(id);
          resetOrphans.add(id);
        }
        state = undefined;
      }

      // 1) messages we haven't seen
      // After a UIDVALIDITY reset every message must be re-identified, including ones older
      // than the sync window that we already have (otherwise they'd be dropped as orphans).
      const found = state
        ? ((await c.search({ uid: `${state.uidnext}:*` }, { uid: true })) || []).filter((u) => u >= state!.uidnext)
        : reset
          ? (await c.search({ all: true }, { uid: true })) || []
          : (await c.search({ since: new Date(sink.windowStart) }, { uid: true })) || [];
      const fresh: IncomingMessage[] = [];
      /** provider keys already claimed in this pass (by UID): duplicates within one batch stay distinct */
      const claimed = new Map<string, number>();
      for (let i = 0; i < found.length; i += 250) {
        const batch = found.slice(i, i + 250);
        for await (const msg of c.fetch(batch, { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true, headers: ["references", "list-id"] }, { uid: true })) {
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
            if (live > 0) {
              key = `${key}#${path}:${uidvalidity}:${m.uid}`;
              existing = await store.messageByProviderId(key);
            }
          }
          if (!existing && resetOrphans.size && !messageKey(env?.messageId)) {
            // After a reset, recognise previously-located ID-less mail stored under an older key
            // scheme. Only ID-less rows qualify (a row with a Message-ID is found by key), the size
            // must match, and a row already re-attached in this mailbox can't be claimed twice.
            const candidate = await locations.resetCandidate({
              candidates: [...resetOrphans],
              subject: env?.subject ?? "",
              fromEmail: (env?.from?.[0]?.address ?? "").toLowerCase(),
              date: new Date(env?.date ?? m.internalDate ?? 0).getTime(),
              size: m.size ?? 0,
              mailbox: path,
            });
            if (candidate) {
              resetOrphans.delete(candidate.id);
              await upsertLocation(candidate.id, path, uidvalidity, m.uid, flags);
              touched.add(candidate.id);
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
              continue;
            }
            // …unless a different UID in the same mailbox already holds it: a distinct message
            // that reuses the Message-ID. Keep both instead of collapsing them.
            key = `${key}#${path}:${uidvalidity}:${m.uid}`;
          }
          if (claimed.has(key) && claimed.get(key) !== m.uid) key = `${key}#${path}:${uidvalidity}:${m.uid}`;
          claimed.set(key, m.uid);
          if (reset && new Date(env?.date ?? m.internalDate ?? Date.now()).getTime() < sink.windowStart) continue; // only re-identify old mail
          const role = roleOf(path);
          const addr = (list?: { name?: string; address?: string }[]) => (list ?? []).filter((a) => a.address).map((a) => ({ name: a.name ?? "", email: a.address!.toLowerCase() }));
          fresh.push({
            accountId,
            providerMsgId: key,
            providerThreadId: null,
            rfcMessageId: messageKey(env?.messageId),
            inReplyTo: env?.inReplyTo ? (splitIds(env.inReplyTo)[0] ?? null) : null,
            references: splitIds(headerValue(m.headers, "references")),
            from: addr(env?.from)[0] ?? { name: "", email: "" },
            to: addr(env?.to),
            cc: addr(env?.cc),
            bcc: addr(env?.bcc),
            subject: env?.subject ?? "",
            date: (env?.date ?? m.internalDate ?? new Date()).valueOf() as number,
            snippet: "",
            bodyText: null,
            bodyHtml: null,
            bodyState: "none",
            listId: parseListId(headerValue(m.headers, "list-id")),
            isRead: flags.includes("\\Seen"),
            isStarred: flags.includes("\\Flagged"),
            inInbox: role === "inbox",
            isSent: role === "sent" || addr(env?.from)[0]?.email === ctx.account.email,
            isDraft: role === "drafts" || flags.includes("\\Draft"),
            isTrash: role === "trash",
            isSpam: role === "junk",
            hasAttachments: hasAttachmentPart(m.bodyStructure),
            size: m.size ?? 0,
            locations: [{ mailbox: path, uidvalidity, uid: m.uid, flags }],
          });
        }
      }
      if (fresh.length) await sink.ingest(fresh);

      // 2) flags and expunges for what we already had
      if (state) {
        const serverUids = new Set((await c.search({ all: true }, { uid: true })) || []);
        const known = await locations.inMailbox(path, uidvalidity);
        const byUid = new Map(known.map((k) => [k.uid, k]));
        for (const k of known) {
          if (!serverUids.has(k.uid)) {
            await locations.remove(k.message_id, path);
            touched.add(k.message_id);
          }
        }
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
      }
      for (const m of fresh) {
        const row = await store.messageByProviderId(m.providerMsgId!);
        if (row) touched.add(row.id);
      }
      cursor.mailboxes[path] = { uidvalidity, uidnext: Number(mb.uidNext) };
    } finally {
      lock.release();
    }
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
          for await (const msg of c.fetch(uids, { uid: true, source: true }, { uid: true })) {
            const id = byUid.get(msg.uid);
            if (!id || !msg.source) continue;
            const parsed = await parseRaw(msg.source);
            await sink.setBody(id, parsed.text, parsed.html);
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

  async function moveLocations(c: ImapFlow, locs: Loc[], target: string, mode: "move" | "copy" = "move") {
    const byMailbox = new Map<string, typeof locs>();
    for (const l of locs) byMailbox.set(l.mailbox, [...(byMailbox.get(l.mailbox) ?? []), l]);
    for (const [mailbox, items] of byMailbox) {
      if (mailbox === target) continue;
      const lock = await c.getMailboxLock(mailbox);
      try {
        assertValidity(c, mailbox, items);
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

  async function send(payload: SendPayload): Promise<{ providerMsgId: string; warning?: string }> {
    const password = await ctx.getSecret("password");
    if (!password) throw new ProviderError("Missing password", false);
    const { raw, rejected } = await sendViaSmtp({ ...config.smtp, password, allowInsecure: options.allowInsecure }, payload);
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
    return { providerMsgId: messageKey(payload.messageId)!, warning: rejected.length ? `No se entregó a: ${rejected.join(", ")}` : undefined };
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
        const r = await discoverRoles(c);
        const cursor = (await ctx.loadCursor<Cursor>()) ?? { mailboxes: {} };
        const touched = new Set<number>();
        // Gmail-style servers keep archived mail only in "All Mail"
        const boxes = [r.inbox, r.sent, r.archive ?? r.all, r.junk, r.trash].filter((p): p is string => Boolean(p));
        for (const path of new Set(boxes)) {
          if (sink.signal.aborted) return;
          await syncMailbox(c, path, cursor, sink, touched);
        }
        await reconcile(touched, sink);
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
            if (r.archive || !r.all) return void (await moveLocations(c, inbox, await ensureMailbox(c, "archive", "Archive")));
            // Gmail-style: archiving = removing the INBOX copy; All Mail keeps it
            const lock = await c.getMailboxLock(r.inbox!);
            try {
              assertValidity(c, r.inbox!, inbox);
              await c.messageDelete(inbox.map((l) => l.uid), { uid: true });
              for (const l of inbox) await locations.remove(l.message_id, r.inbox!);
            } finally {
              lock.release();
            }
            return;
          }
          case "trash":
            return void (await moveLocations(c, locs.filter((l) => l.mailbox !== r.trash), await ensureMailbox(c, "trash", "Trash")));
          case "spam":
            return void (await moveLocations(c, locs.filter((l) => l.mailbox !== r.junk && l.mailbox !== r.sent), await ensureMailbox(c, "junk", "Junk")));
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
      let stopped = false;
      let idle: ImapFlow | null = null;
      let backoff = 1000;
      const start = async () => {
        if (stopped) return;
        try {
          idle = await makeClient(true);
          idle.on("error", () => {});
          idle.on("exists", onChange);
          idle.on("expunge", onChange);
          idle.on("flags", onChange);
          idle.on("close", () => {
            if (!stopped) setTimeout(() => void start(), (backoff = Math.min(backoff * 2, 60_000)));
          });
          await idle.connect();
          await idle.mailboxOpen("INBOX");
          backoff = 1000;
          // enter IDLE now so the server pushes EXISTS/EXPUNGE; imapflow re-enters it after each event
          void idle.idle().catch(() => {});
        } catch {
          if (!stopped) setTimeout(() => void start(), (backoff = Math.min(backoff * 2, 60_000)));
        }
      };
      void start();
      return () => {
        stopped = true;
        void idle?.logout().catch(() => {});
      };
    },

    async close() {
      const c = client;
      client = null;
      await c?.logout().catch(() => {});
    },
  };
}
