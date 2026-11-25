/**
 * Plan 127: mail moved to one of an account's own folders. The provider ops, what one drop changed (an undo takes
 * back exactly that) and whether a thread stays in the Inbox.
 */

/** Put a message in `folder`, out of `from` and (unless `keepInbox`) out of the Inbox. */
export const MOVE_TO_FOLDER = "moveToFolder";
/** Takes a move back; runs before the undo's own moveToInbox, so that op finds the message in place. */
export const LEAVE_FOLDER = "leaveFolder";

export interface MoveToFolderPayload {
  folder: string;
  from: string | null;
  keepInbox: boolean;
  /**
   * Plan 259: a one-folder (Outlook) filing's messages it took out of the Inbox here. The move is the only op (no
   * archive after it: Codex code review #3), so one that never lands puts these back in the Inbox.
   */
  fromInbox?: number[];
}

export interface LeaveFolderPayload {
  folder: string;
  /** the folder it goes back to */
  back: string | null;
  /** it goes back to the Inbox (IMAP: this copy is the one that left it) */
  toInbox: boolean;
  /** it was in `folder` before the move: it stays, and only comes back to `back` */
  stays: boolean;
  /** Plan 259: a one-folder (Outlook) message that came from Archive or Sent goes back there (`back` is null) */
  role?: ReturnRole;
}

/** Plan 259: the role folders a one-folder message's filing can be taken back to, besides the Inbox */
export type ReturnRole = "archive" | "sent";

/** Plan 259: messages a one-folder (Outlook) filing took from somewhere the other groups don't say. */
export interface FolderReturn {
  /** another of the account's folders (null: the role folder) */
  back: string | null;
  role?: ReturnRole;
  messageIds: number[];
}

/** Which messages a move changed, in the groups an undo treats differently. */
export interface FolderMoved {
  accountId: number;
  folder: string;
  from: string | null;
  /** new in the folder, and out of the Inbox by this move */
  fromInbox: number[];
  /** new in the folder, and out of `from` */
  fromFolder: number[];
  /** new in the folder, and nothing left: a kept thread's, an archived one's */
  added: number[];
  /** already in the folder, and out of `from` */
  leftOnly: number[];
  /**
   * Plan 259: a one-folder (Outlook) account's messages that came from another of its folders, or from Archive or Sent:
   * its server keeps a message in one place, so an undo moves each back to exactly where it was
   */
  elsewhere?: FolderReturn[];
}

export const movedNothing = (m: FolderMoved): boolean => !m.fromInbox.length && !m.fromFolder.length && !m.added.length && !m.leftOnly.length && !m.elsewhere?.some((r) => r.messageIds.length);

export interface MoveToFolderResult {
  threadIds: number[];
  opIds: string[];
  /** the archive part: each message it took out of the Inbox, as it was */
  before: import("./types").MessageState[];
  moved: FolderMoved;
  /** the threads kept in the Inbox: in a category shown there, in none hidden */
  kept: number[];
  /** the threads that left the Inbox (their due reminders end, as an archive's do) */
  leftInbox: number[];
}

/** Is a thread in the Inbox kept there, given its categories' `showInInbox`? Hidden wins, as in the Inbox's own test (plan 83). */
export function keptInInbox(inInbox: boolean, shownInInbox: readonly boolean[]): boolean {
  return inInbox && shownInInbox.length > 0 && shownInInbox.every(Boolean);
}

/** Plan 128: a filter's move, collected while its actions run and made once the mail's categories are known. */
export interface FolderFilterMove {
  accountId: number;
  folder: string;
  messageIds: number[];
}

/** Can a filter still move mail there? An account with no list yet (a first sync) is trusted: a stale key fails as an op. */
export function folderReachable(listed: readonly { accountId: number; key: string; selectable: boolean }[], accountId: number, folder: string): boolean {
  const own = listed.filter((f) => f.accountId === accountId);
  return own.length === 0 || own.some((f) => f.key === folder && f.selectable);
}

/** Does this rule move mail to a folder? Only then does anyone need to know what was in the Inbox. */
export const movesToFolder = (rule: { actions: readonly { type: string }[] }): boolean => rule.actions.some((a) => a.type === "moveToFolder");

export const isFolderOp = (kind: string): boolean => kind === MOVE_TO_FOLDER || kind === LEAVE_FOLDER;

/**
 * What a message's folders are with an op on its way (plan 127): ops are applied in queue order, so A → B → C shows
 * only C and an undo shows at once. Both stores' membership ends with this while one is pending.
 */
export function applyFolderOp(folders: Set<string>, kind: string, payload: MoveToFolderPayload | LeaveFolderPayload): void {
  if (kind === MOVE_TO_FOLDER) {
    const p = payload as MoveToFolderPayload;
    if (p.from !== null) folders.delete(p.from);
    folders.add(p.folder);
    return;
  }
  const p = payload as LeaveFolderPayload;
  if (!p.stays) folders.delete(p.folder);
  if (p.back !== null) folders.add(p.back);
}

/**
 * Plan 259: a provider that keeps a message in exactly one folder (Microsoft Graph). Its user folder is the store's
 * `message_folders` row (a role folder has none: the message's flags say which), never IMAP's locations or Gmail's labels.
 */
export const oneFolderPerMessage = (kind: string | null | undefined): boolean => kind === "outlook";

/**
 * Plan 259: applyFolderOp for a one-folder message: the user folder it's in (null: none) once the op lands. A move
 * replaces where it was, whatever `from` says (Graph has no second place for it: A → B never leaves it in both); an
 * undo puts it back where it came from, or out of the folder when it came from no user folder.
 */
export function applyFolderOpOne(folder: string | null, kind: string, payload: MoveToFolderPayload | LeaveFolderPayload): string | null {
  if (kind === MOVE_TO_FOLDER) return (payload as MoveToFolderPayload).folder;
  const p = payload as LeaveFolderPayload;
  if (p.back !== null) return p.back;
  return !p.stays && folder === p.folder ? null : folder;
}

/** The op groups of what a move changed, ready to queue. Empty groups stay out. */
export function leaveFolderOps(m: FolderMoved): { payload: LeaveFolderPayload; messageIds: number[] }[] {
  const op = (messageIds: number[], o: Pick<LeaveFolderPayload, "back" | "toInbox" | "stays">) => ({ payload: { folder: m.folder, ...o }, messageIds });
  return [
    op(m.fromInbox, { back: null, toInbox: true, stays: false }),
    op(m.fromFolder, { back: m.from, toInbox: false, stays: false }),
    op(m.added, { back: null, toInbox: false, stays: false }),
    op(m.leftOnly, { back: m.from, toInbox: false, stays: true }),
    ...(m.elsewhere ?? []).map((r) => op(r.messageIds, { back: r.back, toInbox: false, stays: false, ...(r.back === null && r.role && { role: r.role }) })),
  ].filter((o) => o.messageIds.length > 0);
}

/** What a one-folder (Outlook) filing reads of a message: its user folder (null: a role folder) with what's queued replayed. */
export interface OneFolderRow {
  id: number;
  thread_id: number;
  is_sent: boolean;
  in_inbox: boolean;
  folder: string | null;
}

/**
 * Plan 259 stage 2b: a one-folder (Outlook) filing. Graph keeps a message in one folder, so filing is one move per
 * message (never a copy: `keepInbox` is false, and a thread whose category shows in the Inbox leaves it on the server
 * too), and each message's way back is journalled: `from`, the Inbox, another folder, or Archive or Sent (a received
 * message in no folder and out of the Inbox is in Archive; your own in Sent). Your own mail stays in Sent, as IMAP's
 * does, unless it's all there is or it's in the folder this leaves. The messages to move, and the undo's journal.
 */
export function planOneFolderMove(to: { accountId: number; folder: string; from: string | null }, rows: readonly OneFolderRow[]): { moved: FolderMoved; messageIds: number[] } {
  const { accountId, folder, from } = to;
  const moved: FolderMoved = { accountId, folder, from, fromInbox: [], fromFolder: [], added: [], leftOnly: [] };
  const received = new Set(rows.filter((m) => !m.is_sent).map((m) => m.thread_id));
  const elsewhere = new Map<string, FolderReturn>();
  const back = (key: string, r: Omit<FolderReturn, "messageIds">, id: number) => {
    const group = elsewhere.get(key) ?? { ...r, messageIds: [] };
    group.messageIds.push(id);
    elsewhere.set(key, group);
  };
  const messageIds: number[] = [];
  for (const m of rows) {
    if (m.folder === folder) continue;
    const inFrom = from !== null && m.folder === from;
    if (m.is_sent && received.has(m.thread_id) && !inFrom) continue;
    messageIds.push(m.id);
    if (inFrom) moved.fromFolder.push(m.id);
    else if (m.folder !== null) back(`folder:${m.folder}`, { back: m.folder }, m.id);
    else if (m.in_inbox) moved.fromInbox.push(m.id);
    else if (m.is_sent) back("role:sent", { back: null, role: "sent" }, m.id);
    else back("role:archive", { back: null, role: "archive" }, m.id);
  }
  if (elsewhere.size) moved.elsewhere = [...elsewhere.values()];
  return { moved, messageIds };
}

/** A Gmail message's labels after a move (null: unchanged), and after its undo. */
export function labelsMoved(labels: readonly string[], folder: string, from: string | null): string[] | null {
  const next = labels.filter((l) => l !== from);
  if (!next.includes(folder)) next.push(folder);
  return next.length === labels.length && next.every((l, i) => l === labels[i]) ? null : next;
}

export function labelsLeft(labels: readonly string[], folder: string, back: string | null, stays: boolean): string[] | null {
  const next = stays ? [...labels] : labels.filter((l) => l !== folder);
  if (back !== null && !next.includes(back)) next.push(back);
  return next.length === labels.length && next.every((l, i) => l === labels[i]) ? null : next;
}
