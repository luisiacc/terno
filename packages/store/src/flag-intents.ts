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
