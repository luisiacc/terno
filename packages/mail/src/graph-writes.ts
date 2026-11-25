// Plan 259 stage 2b: Outlook's writes over Microsoft Graph. Flags are a PATCH of `isRead` or `flag`; every location op
// (archive, trash, spam, not spam, back to the Inbox, a filing and its undo) is a move (learn.microsoft.com/graph/api/
// message-move), decided per message from where Graph says it is now, so a retry after a partial success moves only
// what's left. Many messages go through JSON batches of 20 (learn.microsoft.com/graph/json-batching). Each move's
// answer names the folder the message is in, which the store keeps as soon as it arrives. Folders are created, renamed
// and deleted in plan 107's contract, and a send is `sendMail` with the MIME, or a draft, upload sessions and its
// `send` when a file is too large to go inline. No Node APIs.
import { FOLDERS_PER_ACCOUNT_MAX } from "@terno/core";
import { L } from "@terno/i18n";
import { LEAVE_FOLDER, MOVE_TO_FOLDER, type LeaveFolderPayload, type MessagePlacement, type MoveToFolderPayload } from "@terno/store";
import { checkedAttachments } from "./attachment-payload";
import { checkName, nameTaken, notFound as folderNotFound, refusedBy, sameName, standardFolder } from "./folder-changes";
import { IMMUTABLE, isRecord, mailboxRefusedCodes, codesOf, ROLES, type Call, type Catalog, type Role } from "./graph-shared";
import { graphMimeBody } from "./outgoing-wire";
import { ProviderError, type FolderChange, type FolderMove, type ProviderContext, type ProviderOp, type RequestRun, type SendPayload } from "./types";

/** "Microsoft Graph supports batching up to 20 requests" (learn.microsoft.com/graph/json-batching) */
export const BATCH_MAX = 20;
/**
 * Upload sessions take a file "between 3 MB and 150 MB" (learn.microsoft.com/graph/outlook-large-attachments). A send
 * with a file this size or larger goes through a draft; 3 MiB is inside that range whichever megabyte the page means.
 */
export const LARGE_ATTACHMENT_BYTES = 3 * 1024 * 1024;
/** "keep each byte range less than 4 MB" (outlook-large-attachments); divisible by three, so base64 cuts cleanly */
export const UPLOAD_PIECE_BYTES = 3 * 1024 * 1024;
/** a batch's answers carry each moved or changed message whole (bodies too): bounded, generously */
const BATCH_BYTES = 32 * 1024 * 1024;
/** a draft's answer is the message with its body */
const DRAFT_BYTES = 16 * 1024 * 1024;
const ID_MAX = 1024;

const enc = encodeURIComponent;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const invalid = () => new ProviderError(L("errors.outlook.invalidResponse"), true);

export interface GraphWriteDeps {
  ctx: ProviderContext;
  /** one Graph request (graph-api.ts's transport); throws GraphApiError for an answer that isn't 2xx */
  api(target: string, call?: Call): Promise<unknown>;
  /** the folder list read now (folder changes check against the server's, never the sidebar's) */
  readCatalog(): Promise<Catalog>;
  /** the role folders' ids, read once (folder ids never change) */
  roleIds(): Promise<Partial<Record<Role, string>>>;
  /** a piece of an upload session: PUT to the session's own URL, no Authorization (it carries its own); true when it was the last */
  upload(url: string, piece: Uint8Array, start: number, total: number, run?: RequestRun): Promise<boolean>;
  /** whether a 4xx says Graph refused this very request (GraphApiError's status and codes) */
  refusal(error: unknown): { status: number; codes: readonly string[] } | undefined;
  buildRaw?: (payload: SendPayload) => Promise<Uint8Array>;
  largeAttachmentBytes?: number;
  uploadPieceBytes?: number;
}

/** A batch's sub-request, and what came back for it. */
interface Sub { method: "GET" | "POST" | "PATCH"; url: string; body?: unknown }
interface Answer { status: number; body: unknown; codes: string[] }

/** One message an op names: Terno's id and Graph's. */
interface Target { local: number; graphId: string }

/** Where a message is, as Terno reads Graph's parentFolderId: a role folder or another folder (its id). */
interface Place { parent: string; role?: Role }

/** What a location op does to each message: where it goes, and whether one where it is now goes at all. */
interface Rule { to: string; moves(place: Place): boolean }

export function createGraphWrites(deps: GraphWriteDeps) {
  const { ctx, api } = deps;
  const store = ctx.store;

  /**
   * Requests in one JSON batch; each answer by its request. Graph may answer in any order ("might appear in a different
   * order than the requests"); one with no answer is left to the caller (unknown: read again on the next attempt).
   */
  async function batch(subs: readonly Sub[], run?: RequestRun): Promise<(Answer | undefined)[]> {
    const requests = subs.map((s, i) => ({
      id: String(i + 1), method: s.method, url: s.url,
      // the immutable-id header is per request; a batch's own doesn't reach the requests inside it
      headers: { prefer: IMMUTABLE, ...(s.body !== undefined && { "content-type": "application/json" }) },
      ...(s.body !== undefined && { body: s.body }),
    }));
    const value = await api("/$batch", { method: "POST", body: JSON.stringify({ requests }), batch: true, run, admission: "background", limit: BATCH_BYTES });
    if (!isRecord(value) || !Array.isArray(value.responses) || value.responses.length > subs.length) throw invalid();
    const out: (Answer | undefined)[] = subs.map(() => undefined);
    for (const r of value.responses) {
      const at = isRecord(r) && typeof r.id === "string" && /^\d{1,2}$/.test(r.id) ? Number(r.id) - 1 : -1;
      if (!isRecord(r) || at < 0 || at >= subs.length || out[at] || !Number.isInteger(r.status)) throw invalid();
      out[at] = { status: r.status as number, body: r.body, codes: codesOf(r.body) };
    }
    return out;
  }

  const ok = (a: Answer) => a.status >= 200 && a.status < 300;
  /** a 404 that names its reason, and not the mailbox's: what the request named isn't there */
  const gone = (a: Answer) => a.status === 404 && a.codes.length > 0 && !mailboxRefusedCodes(a.codes);
  /** a request inside a batch that failed: throttled or a server error tries again; anything else is Graph's refusal */
  const failure = (a: Answer) => new ProviderError(L("errors.outlook.requestFailed", { status: a.status }), a.status === 429 || a.status >= 500 || a.status === 401);
  /** sent and no answer: what happened is read again on the next attempt */
  const unanswered = () => new ProviderError(L("errors.outlook.requestOffline"), true);

  /** The op's messages Graph knows (a `local:` one hasn't reached the server), in id order. */
  async function targetsOf(op: ProviderOp): Promise<Target[]> {
    const ids = op.target.messageIds ?? [];
    if (!ids.length) return [];
    return [...(await store.providerIds(ids))]
      .sort(([a], [b]) => a - b)
      .flatMap(([local, graphId]) => graphId && !graphId.startsWith("local:") ? [{ local, graphId }] : []);
  }

  /** PATCH each message, 20 a batch: idempotent, so a retry sends them all again. One that's gone is done. */
  async function patch(targets: readonly Target[], body: Record<string, unknown>, run?: RequestRun): Promise<void> {
    for (let i = 0; i < targets.length; i += BATCH_MAX) {
      const chunk = targets.slice(i, i + BATCH_MAX);
      const answers = await batch(chunk.map((t) => ({ method: "PATCH", url: `/me/messages/${enc(t.graphId)}`, body })), run);
      let first: ProviderError | undefined;
      for (const a of answers) {
        if (!a) first ??= unanswered();
        else if (!ok(a) && !gone(a)) first ??= failure(a);
      }
      if (first) throw first;
    }
  }

  /** a message's place from Graph's parentFolderId */
  function placeOf(parent: string, roles: Partial<Record<Role, string>>): Place {
    const role = (Object.keys(roles) as Role[]).find((r) => roles[r] === parent);
    return role ? { parent, role } : { parent };
  }

  /** whether a message there is already where `to` (a well-known name or a folder id) points */
  function at(to: string, place: Place, roles: Partial<Record<Role, string>>): boolean {
    const role = (Object.keys(ROLES) as Role[]).find((r) => ROLES[r] === to);
    return role ? roles[role] === place.parent : to === place.parent;
  }

  /** the store's folder for a message in `parent`: null for a role folder (its flags say which), else the folder's id */
  const folderKey = (parent: string, roles: Partial<Record<Role, string>>) => placeOf(parent, roles).role ? null : parent;

  function parentOf(body: unknown): string | undefined {
    if (!isRecord(body)) throw invalid();
    if (body.id !== undefined && (!nonempty(body.id) || body.id.length > ID_MAX)) throw invalid();
    if (body.parentFolderId === undefined || body.parentFolderId === null) return undefined;
    if (!nonempty(body.parentFolderId) || body.parentFolderId.length > ID_MAX) throw invalid();
    return body.parentFolderId;
  }

  /**
   * A location op over these messages, 20 a batch: where each is read first (a GET of its parentFolderId), then those
   * the rule moves are moved (POST /move, whose answer is the message in its new folder: 201 Created). What's already
   * where it's going isn't moved: a retry after a partial success moves only what's left, and Graph's answer to a move
   * into the folder a message is in isn't one its pages give. Each chunk's confirmed folders are written before the next
   * (and before a failure is thrown), so what's done stays done.
   */
  async function relocate(targets: readonly Target[], rule: Rule, run?: RequestRun): Promise<void> {
    if (!targets.length) return;
    const roles = await deps.roleIds();
    const destination = (Object.keys(ROLES) as Role[]).find((r) => ROLES[r] === rule.to);
    // a role this mailbox doesn't have (an Archive folder: some mailboxes have none)
    if (destination && !roles[destination]) throw new ProviderError(destination === "archive" ? L("errors.outlook.noArchive") : L("errors.folder.notFound"), false);
    for (let i = 0; i < targets.length; i += BATCH_MAX) {
      const chunk = targets.slice(i, i + BATCH_MAX);
      let first: ProviderError | undefined;
      const placements: MessagePlacement[] = [];
      const reads = await batch(chunk.map((t) => ({ method: "GET", url: `/me/messages/${enc(t.graphId)}?$select=id,parentFolderId` })), run);
      const moves: Target[] = [];
      chunk.forEach((t, n) => {
        const a = reads[n];
        if (!a) return void (first ??= unanswered());
        if (gone(a)) return;
        if (!ok(a)) return void (first ??= failure(a));
        const parent = parentOf(a.body);
        if (parent === undefined) return void (first ??= invalid());
        const place = placeOf(parent, roles);
        // already there (a move whose answer was lost, or one never needed): its folder is known
        if (at(rule.to, place, roles)) placements.push({ messageId: t.local, providerMsgId: t.graphId, folder: folderKey(parent, roles) });
        else if (rule.moves(place)) moves.push(t);
      });
      if (moves.length) {
        const answers = await batch(moves.map((t) => ({ method: "POST", url: `/me/messages/${enc(t.graphId)}/move`, body: { destinationId: rule.to } })), run);
        moves.forEach((t, n) => {
          const a = answers[n];
          if (!a) return void (first ??= unanswered());
          // read a moment ago: a 404 now is the destination's (a folder deleted meanwhile), never a message to forget
          if (a.status === 404) return void (first ??= new ProviderError(L("errors.folder.notFound"), false));
          if (!ok(a)) return void (first ??= failure(a));
          const parent = parentOf(a.body);
          const to = parent ?? (destination ? roles[destination]! : rule.to);
          placements.push({ messageId: t.local, providerMsgId: t.graphId, folder: folderKey(to, roles) });
        });
      }
      if (placements.length) await store.placeMessages(placements);
      if (first) throw first;
    }
  }

  /** Where each location op sends a message, and which it moves (as IMAP's moves do, one folder a message). */
  function ruleOf(op: ProviderOp): Rule | undefined {
    switch (op.kind) {
    // out of the Inbox only: a message filed elsewhere stays where it is
    case "archive": return { to: ROLES.archive, moves: (p) => p.role === "inbox" };
    case "trash": return { to: ROLES.trash, moves: () => true };
    // your own mail never goes to Junk
    case "spam": return { to: ROLES.junk, moves: (p) => p.role !== "sent" };
    case "notSpam": return { to: ROLES.inbox, moves: (p) => p.role === "junk" };
    // your own mail stays in Sent and a draft in Drafts
    case "moveToInbox": return { to: ROLES.inbox, moves: (p) => p.role !== "sent" && p.role !== "drafts" };
    case MOVE_TO_FOLDER: return { to: (op.payload as MoveToFolderPayload).folder, moves: () => true };
    case LEAVE_FOLDER: {
      // only what's still in the folder goes back: to the Inbox, the folder it came from, or Archive or Sent
      const p = op.payload as LeaveFolderPayload;
      const to = p.toInbox ? ROLES.inbox : p.back ?? (p.role ? ROLES[p.role] : ROLES.archive);
      return { to, moves: (place) => place.parent === p.folder };
    }
    default: return undefined;
    }
  }

  // ───────────────────────────── send ─────────────────────────────

  /** Base64 of bytes, a piece of a canonical base64 attachment (pieces are cut at multiples of three bytes). */
  function piece(dataBase64: string, start: number, end: number): Uint8Array {
    const binary = atob(dataBase64.slice(start / 3 * 4, Math.ceil(end / 3) * 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  /**
   * A large file into the draft through an upload session (learn.microsoft.com/graph/api/attachment-createuploadsession):
   * the session's URL, then the bytes in order, each piece under 4 MB with its Content-Range; the last answers 201.
   */
  async function uploadFile(draft: string, file: NonNullable<SendPayload["attachments"]>[number] & { dataBase64: string }, run?: RequestRun): Promise<void> {
    const session = await api(`/me/messages/${enc(draft)}/attachments/createUploadSession`, {
      method: "POST", admission: "send", run, limit: 65_536,
      body: JSON.stringify({ AttachmentItem: { attachmentType: "file", name: file.filename, size: file.size, contentType: file.mime, ...(file.contentId && { isInline: true, contentId: file.contentId }) } }),
    });
    if (!isRecord(session) || !nonempty(session.uploadUrl)) throw invalid();
    const width = deps.uploadPieceBytes ?? UPLOAD_PIECE_BYTES;
    if (width % 3 !== 0) throw new Error("an upload piece is a multiple of three bytes");
    for (let start = 0; start < file.size; start += width) {
      const end = Math.min(file.size, start + width);
      const last = await deps.upload(session.uploadUrl, piece(file.dataBase64, start, end), start, file.size, run);
      if (last !== (end === file.size)) throw invalid();
    }
  }

  /**
   * Plan 259 revision 9: a send. With no file at or over LARGE_ATTACHMENT_BYTES, `POST /me/sendMail` with the MIME
   * (202 Accepted, nothing in the body: its Sent copy comes with the Sent Items delta and takes the local row's place by
   * its Message-ID). Otherwise a draft from the MIME without the large files (`POST /me/messages`: 201 with its id), an
   * upload session for each, then `POST /me/messages/{id}/send`. The draft and uploads are safe to repeat (a failure
   * before the send deletes the draft); `beforeSubmission` runs right before the submission; once the submission may
   * have left, a failure is unknown and the message is never sent again (plan 65).
   */
  async function send(op: ProviderOp): Promise<void> {
    if (!deps.buildRaw) throw new ProviderError(L("errors.outlook.actionNotYet"), false);
    const payload = op.payload as SendPayload;
    const files = payload.attachments ?? [];
    const threshold = deps.largeAttachmentBytes ?? LARGE_ATTACHMENT_BYTES;
    const isLarge = files.map((f) => f.size >= threshold);
    const submit = (target: string, body?: Blob) => api(target, { method: "POST", ...(body && { body, contentType: "text/plain" }), submission: true, empty: true, run: op.requestRun, admission: "send" });
    if (!isLarge.includes(true)) {
      const body = await graphMimeBody(await deps.buildRaw(payload));
      await op.beforeSubmission?.();
      await submit("/me/sendMail", body);
      return;
    }
    // checked as buildRaw checks what it carries: present, canonical, the size said
    const large = await checkedAttachments({ ...payload, attachments: files.filter((_, i) => isLarge[i]) });
    const raw = await deps.buildRaw({ ...payload, attachments: files.filter((_, i) => !isLarge[i]) });
    const created = await api("/me/messages", { method: "POST", body: await graphMimeBody(raw), contentType: "text/plain", admission: "send", run: op.requestRun, limit: DRAFT_BYTES });
    if (!isRecord(created) || !nonempty(created.id) || created.id.length > ID_MAX) throw invalid();
    const draft = created.id;
    try {
      for (const file of large) await uploadFile(draft, file, op.requestRun);
      await op.beforeSubmission?.();
    } catch (error) {
      // nothing was sent: the draft goes (best effort; one left over is an ordinary draft the person can delete)
      await api(`/me/messages/${enc(draft)}`, { method: "DELETE", empty: true, admission: "send" }).catch(() => {});
      throw error;
    }
    await submit(`/me/messages/${enc(draft)}/send`);
  }

  // ───────────────────────────── folders (plan 107) ─────────────────────────────

  /** the folder and every folder under it, as the tree says */
  function subtree(tree: Catalog["tree"], key: string): string[] {
    const out = [key];
    for (let i = 0; i < out.length; i++) for (const [id, node] of tree) if (node.parent === out[i] && !out.includes(id)) out.push(id);
    return out;
  }

  /** one of the person's own folders (a role folder is standard; one not listed isn't there any more) */
  function own(catalog: Catalog, key: string): void {
    if (catalog.synced.get(key)?.role) throw standardFolder();
    if (!catalog.folders.some((f) => f.key === key) || !catalog.tree.has(key)) throw folderNotFound();
  }

  /** a name no folder beside it has: at the same place in Graph's tree, and at the same place in Terno's list */
  function free(catalog: Catalog, parent: string | null, path: readonly string[], name: string, except?: string): void {
    const beside = [...catalog.tree].some(([id, node]) => id !== except && node.parent === parent && sameName(node.name, name));
    const shown = catalog.folders.some((f) => f.key !== except && f.path.length === path.length + 1 && path.every((p, i) => f.path[i] === p) && sameName(f.path.at(-1)!, name));
    if (beside || shown) throw nameTaken(name);
  }

  /** Graph refused it (a 4xx that isn't a throttle): what it said, in its own code */
  function refused(error: unknown): ProviderError | undefined {
    const r = deps.refusal(error);
    if (!r || r.status === 429 || r.status >= 500) return undefined;
    return refusedBy("Outlook", r.codes[0] ?? String(r.status));
  }

  /**
   * A change whose answer may have been lost (a timeout, a dropped connection, a server error): the list is read again
   * and `happened` says whether it took effect; if it did, that's the answer, else the failure stands.
   */
  async function recovering<T>(change: () => Promise<T>, happened: (after: Catalog) => T | undefined): Promise<T> {
    try { return await change(); }
    catch (error) {
      const refusal = refused(error);
      if (refusal) throw refusal;
      const after = await deps.readCatalog().catch(() => undefined);
      const done = after && happened(after);
      if (done !== undefined) return done;
      throw error;
    }
  }

  return {
    async execute(op: ProviderOp) {
      if (op.kind === "send") return send(op);
      const targets = await targetsOf(op);
      switch (op.kind) {
      case "markRead": case "markUnread": return patch(targets, { isRead: op.kind === "markRead" }, op.requestRun);
      case "star": case "unstar": return patch(targets, { flag: { flagStatus: op.kind === "star" ? "flagged" : "notFlagged" } }, op.requestRun);
      }
      const rule = ruleOf(op);
      if (!rule) throw new ProviderError(`Unsupported operation ${op.kind}`, false);
      return relocate(targets, rule, op.requestRun);
    },

    async createFolder({ parent, name }: { parent: string | null; name: string }): Promise<FolderChange & { key: string }> {
      checkName(name, null);
      const before = await deps.readCatalog();
      if (before.folders.length >= FOLDERS_PER_ACCOUNT_MAX) throw new ProviderError(L("errors.folder.tooMany"), false);
      if (parent !== null) own(before, parent);
      const path = parent === null ? [] : before.folders.find((f) => f.key === parent)!.path;
      free(before, parent, path, name);
      // learn.microsoft.com/graph/api/mailfolder-post-childfolders (or user-post-mailfolders at the top): 201 with the folder
      const target = parent === null ? "/me/mailFolders" : `/me/mailFolders/${enc(parent)}/childFolders`;
      const key = await recovering(async () => {
        const created = await api(target, { method: "POST", body: JSON.stringify({ displayName: name }), limit: 65_536 });
        if (!isRecord(created) || !nonempty(created.id) || created.id.length > ID_MAX) throw invalid();
        return created.id;
      }, (after) => [...after.tree].find(([id, node]) => !before.tree.has(id) && node.parent === parent && sameName(node.name, name))?.[0]);
      const after = await deps.readCatalog();
      return { folders: after.folders, key };
    },

    async renameFolder({ key, name }: { key: string; name: string }): Promise<FolderChange & { renamed: FolderMove[] }> {
      checkName(name, null);
      const before = await deps.readCatalog();
      own(before, key);
      const node = before.tree.get(key)!;
      const shown = before.folders.find((f) => f.key === key)!;
      free(before, node.parent, shown.path.slice(0, -1), name, key);
      // learn.microsoft.com/graph/api/mailfolder-update: PATCH displayName; a folder's id stays, so its keys and its
      // subfolders' do too (they move with it)
      await recovering(async () => { await api(`/me/mailFolders/${enc(key)}`, { method: "PATCH", body: JSON.stringify({ displayName: name }), limit: 65_536 }); return true; },
        (after) => after.tree.get(key) && sameName(after.tree.get(key)!.name, name) ? true : undefined);
      const after = await deps.readCatalog();
      const listed = new Set(before.folders.map((f) => f.key));
      return { folders: after.folders, renamed: subtree(before.tree, key).filter((k) => listed.has(k)).map((k) => ({ from: k, to: k })) };
    },

    async deleteFolder({ key }: { key: string }): Promise<FolderChange & { deleted: string[] }> {
      const before = await deps.readCatalog();
      own(before, key);
      // learn.microsoft.com/graph/api/mailfolder-delete: 204; one already gone is what was asked
      await recovering(async () => {
        try { await api(`/me/mailFolders/${enc(key)}`, { method: "DELETE", empty: true }); }
        catch (error) {
          const r = deps.refusal(error);
          if (!(r?.status === 404 && r.codes.length && !mailboxRefusedCodes(r.codes))) throw error;
        }
        return true;
      }, (after) => after.tree.has(key) ? undefined : true);
      const after = await deps.readCatalog();
      const listed = new Set(before.folders.map((f) => f.key));
      // what went is what the list no longer has: the folder, and every folder that was under it
      return { folders: after.folders, deleted: subtree(before.tree, key).filter((k) => listed.has(k) && !after.tree.has(k)) };
    },
  };
}

export type GraphWrites = ReturnType<typeof createGraphWrites>;
