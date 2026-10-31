/**
 * Plan 95: a mailbox restored from a backup knows nothing of what happened
 * since the copy was made. Before the backend starts it:
 *
 * - no op reaches a server again: a send queued in the copy may have gone
 *   out since (an "unknown" one stays unknown: the user already decides those)
 * - no scheduled send fires: its draft stays a draft, to schedule again
 * - local mode is on: the copy may predate turning it on, and the most
 *   private choice is the safe one (the user turns it off again)
 *
 * Idempotent: a backend that dies before main hears it ran does it again.
 */
import { encodeText } from "@terno/core";
import { L } from "@terno/i18n";
import { getSetting, setSetting } from "./repos";
import type { Db } from "./sqlite";

export interface RestoreQuarantine {
  ops: number;
  scheduled: number;
}

export function quarantineRestored(db: Db): RestoreQuarantine {
  return db.tx(() => {
    const ops = db.run("UPDATE ops SET state = 'failed', last_error = ?, updated_at = ? WHERE state IN ('queued', 'running')", encodeText(L("errors.op.restoredFromBackup")), Date.now()).changes;
    const scheduled = db.run("DELETE FROM scheduled_sends").changes;
    setSetting(db, "app", { ...getSetting<Record<string, unknown>>(db, "app", {}), localMode: true });
    return { ops: Number(ops), scheduled: Number(scheduled) };
  });
}
