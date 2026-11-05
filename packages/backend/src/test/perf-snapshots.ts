import { copyMailbox, LARGE_MAILBOX, PERF_MAILBOX, scratchDir } from "../../../db/src/test/perf-mailbox";
import { SLICE_MAILBOX } from "./slice-mailbox";

/**
 * Plan 139: the gates run side by side, so a cold tree's seeds happen here, one after another, before anything is timed:
 * a seed beside a gate is a stall the gate didn't cause. Nothing to do when the tree's snapshots are already on disk.
 */
export default function setup(): void {
  const scratch = scratchDir("perf-snapshots");
  try {
    for (const mailbox of [SLICE_MAILBOX, PERF_MAILBOX, LARGE_MAILBOX]) copyMailbox(mailbox, scratch.path(mailbox.key));
  } finally {
    scratch.done();
  }
}
