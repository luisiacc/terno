import { MAILBOX_NOW, type MailboxSpec } from "../../../db/src/test/perf-mailbox";

/**
 * For the gates on a slicer's stall (bulk work, its undo): a slice's bound, set by the items in it, doesn't get stricter
 * from rows no slice touches, and 4,000 threads still take dozens of slices at the 15 ms target. A slice that keeps
 * growing passes 50 ms at a few hundred items, a whole job in one transaction well over it. Reads hold at 50k+ on
 * PERF_MAILBOX and LARGE_MAILBOX.
 */
export const SLICE_MAILBOX: MailboxSpec = { key: "slices", dataset: { threads: 4_000, accounts: 8, seed: 5, now: MAILBOX_NOW, bodyScale: 3 } };
