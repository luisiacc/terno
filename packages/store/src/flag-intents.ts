import type { ThreadAction } from "@terno/core";
import type { MessageState } from "./types";

export type LocalFlagField = Exclude<keyof MessageState, "id">;

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
} as const satisfies Record<ThreadAction, readonly LocalFlagField[]>;

/** Sends and other operations do not own incoming message flags. */
export function operationFlagFields(kind: string): readonly LocalFlagField[] {
  return Object.hasOwn(EFFECTS, kind) ? EFFECTS[kind as ThreadAction] : [];
}


type LocationState = Pick<MessageState, "inInbox" | "isTrash" | "isSpam">;
const placeOf = (s: LocationState) => s.isTrash ? "trash" : s.isSpam ? "spam" : s.inInbox ? "inbox" : "archive";

export function sameLocation(a: LocationState, b: LocationState): boolean {
  return a.inInbox === b.inInbox && a.isTrash === b.isTrash && a.isSpam === b.isSpam;
}

/** Canonical destinations may need to clear secondary flags hidden by display precedence. */
export function restoreLocationOps(from: LocationState, to: LocationState): ThreadAction[] {
  if (sameLocation(from, to)) return [];
  const source = placeOf(from), destination = placeOf(to);
  const out: ThreadAction[] = source === "trash" || source === "spam" ? ["moveToInbox"] : [];
  if (destination === "inbox") return out.length ? out : ["moveToInbox"];
  out.push(destination);
  return out;
}
