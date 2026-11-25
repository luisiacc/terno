import type { ThreadAction } from "@terno/core";
import { MOVE_TO_FOLDER, RETURN_TO, type ReturnToRole } from "./folder-move";
import type { MessageState } from "./types";

/** plan 259: an undo snapshot's `folder` is a place, not a flag */
export type LocalFlagField = Exclude<keyof MessageState, "id" | "folder">;

export class FlagObservationError extends Error {
  readonly code = "AUTHORITATIVE_FLAGS_UNAVAILABLE";
  constructor() { super("Authoritative flag snapshots are unavailable."); this.name = "FlagObservationError"; }
}

const EFFECTS = {
  archive: ["inInbox"],
  trash: ["isTrash", "inInbox"],
  spam: ["isSpam", "inInbox"],
  notSpam: ["isSpam", "inInbox"],
  moveToInbox: ["inInbox", "isTrash", "isSpam"],
  markRead: ["isRead"],
  markUnread: ["isRead"],
  star: ["isStarred"],
  unstar: ["isStarred"],
  toPrimary: ["category"],
  toPromotions: ["category"],
  toSocial: ["category"],
  toUpdates: ["category"],
  toForums: ["category"],
  toNoCategory: ["category"],
} as const satisfies Record<ThreadAction, readonly LocalFlagField[]>;

/**
 * Plan 86: one undo for an action and the category move it brought (Move to Inbox out of a Gmail tab): each
 * message's place as the action found it, its category as the move found it.
 */
export function mergeBefore(first: readonly MessageState[], then: readonly MessageState[]): MessageState[] {
  const out = new Map(first.map((m) => [m.id, { ...m }]));
  for (const m of then) {
    const was = out.get(m.id);
    out.set(m.id, was ? { ...was, category: m.category } : m);
  }
  return [...out.values()];
}

/** An action that moves mail (archive, trash, spam, not spam, back to the Inbox), not one that marks or files it. */
export const isLocationAction = (action: ThreadAction): boolean => (EFFECTS[action] as readonly LocalFlagField[]).includes("inInbox");

/** Plan 259 (exact undo): a one-folder message back to Archive or Sent ends out of the Inbox, Trash and Junk. */
const RETURN_EFFECTS = ["inInbox", "isTrash", "isSpam"] as const satisfies readonly LocalFlagField[];

/** Sends and other operations do not own incoming message flags. */
export function operationFlagFields(kind: string): readonly LocalFlagField[] {
  if (kind === RETURN_TO) return RETURN_EFFECTS;
  return Object.hasOwn(EFFECTS, kind) ? EFFECTS[kind as ThreadAction] : [];
}


type LocationState = Pick<MessageState, "inInbox" | "isTrash" | "isSpam">;
const placeOf = (s: LocationState) => s.isTrash ? "trash" : s.isSpam ? "spam" : s.inInbox ? "inbox" : "archive";

export function sameLocation(a: LocationState, b: LocationState): boolean {
  return a.inInbox === b.inInbox && a.isTrash === b.isTrash && a.isSpam === b.isSpam;
}

/** Restore supported mixed flags without clearing a saved membership as an intermediate step. */
export function restoreLocationOps(from: LocationState, to: LocationState): ThreadAction[] {
  if (sameLocation(from, to)) return [];
  if (to.isTrash && to.isSpam && !to.inInbox) {
    const ops: ThreadAction[] = [];
    if (!from.isTrash) ops.push("trash");
    if (!from.isSpam) ops.push("spam");
    return ops.length ? ops : ["archive"];
  }
  const source = placeOf(from), destination = placeOf(to);
  const out: ThreadAction[] = source === "trash" || source === "spam" ? ["moveToInbox"] : [];
  if (destination === "inbox") return out.length ? out : ["moveToInbox"];
  out.push(destination);
  return out;
}

/** Out of the Inbox, Trash and Junk: where a one-folder (Outlook) message's folder says where it is. */
const outOfRoles = (s: LocationState) => !s.inInbox && !s.isTrash && !s.isSpam;

/**
 * Plan 259 (exact undo): a one-folder message's place for an undo's snapshot: its user folder (with what's on its way
 * replayed) while its flags are out of the Inbox, Trash and Junk; else null, a role folder its flags name.
 */
export const oneFolderPlace = (s: LocationState, folder: string | null): string | null => outOfRoles(s) ? folder : null;

/** A one-folder message's place: its flags, and its user folder (`oneFolderPlace`). */
export type OneFolderPlace = LocationState & { folder: string | null };

/** One provider op of a one-folder message's undo. */
export type OneFolderRestore = { kind: ThreadAction } | { kind: typeof MOVE_TO_FOLDER; folder: string } | { kind: typeof RETURN_TO; role: ReturnToRole };

/** Is a one-folder message where it was: its flags, and its user folder while they say it's in one? */
export const samePlace = (now: OneFolderPlace, was: OneFolderPlace): boolean => sameLocation(now, was) && oneFolderPlace(now, now.folder) === oneFolderPlace(was, was.folder);

/**
 * Plan 259 (exact undo): the ops that put a one-folder (Outlook) message back exactly where an action found it. A
 * folder's flags are Archive's, so restoreLocationOps alone would leave it in Archive: a user folder is a filing back
 * to it (moveToFolder); Archive, Sent and Drafts are `returnTo` (a draft is Drafts', your own message Sent's, as a
 * filing's journal reads it); the Inbox, Trash and Junk are restoreLocationOps', each exact on Graph and carrying its
 * flag effects. A user folder or a role is one move, from wherever the message is.
 */
export function restoreOneFolderOps(now: OneFolderPlace, was: OneFolderPlace, own: { isSent: boolean; isDraft: boolean }): OneFolderRestore[] {
  if (samePlace(now, was)) return [];
  const back = oneFolderPlace(was, was.folder);
  if (back !== null) return [{ kind: MOVE_TO_FOLDER, folder: back }];
  if (outOfRoles(was)) return [{ kind: RETURN_TO, role: own.isDraft ? "drafts" : own.isSent ? "sent" : "archive" }];
  return restoreLocationOps(now, was).map((kind) => ({ kind }));
}
