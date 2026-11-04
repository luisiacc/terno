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
}

export interface LeaveFolderPayload {
  folder: string;
  /** the folder it goes back to */
  back: string | null;
  /** it goes back to the Inbox (IMAP: this copy is the one that left it) */
  toInbox: boolean;
  /** it was in `folder` before the move: it stays, and only comes back to `back` */
  stays: boolean;
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
}

export const movedNothing = (m: FolderMoved): boolean => !m.fromInbox.length && !m.fromFolder.length && !m.added.length && !m.leftOnly.length;

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

/** The op groups of what a move changed, ready to queue. Empty groups stay out. */
export function leaveFolderOps(m: FolderMoved): { payload: LeaveFolderPayload; messageIds: number[] }[] {
  const op = (messageIds: number[], o: Pick<LeaveFolderPayload, "back" | "toInbox" | "stays">) => ({ payload: { folder: m.folder, ...o }, messageIds });
  return [
    op(m.fromInbox, { back: null, toInbox: true, stays: false }),
    op(m.fromFolder, { back: m.from, toInbox: false, stays: false }),
    op(m.added, { back: null, toInbox: false, stays: false }),
    op(m.leftOnly, { back: m.from, toInbox: false, stays: true }),
  ].filter((o) => o.messageIds.length > 0);
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
