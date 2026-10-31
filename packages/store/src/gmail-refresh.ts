import { FLAG_COLUMNS, flagObservationValid, flagTick, putFlagIntent, type FlagRepository } from "./flag-protocol";
import type { FlagObservation } from "./types";
import type { LocalFlagField } from "./flag-intents";

/** Only enumeration guarantees a future cache read; a refresh page may already be in flight. */
function coveredByEnumeration(cursor: unknown): boolean {
  if (!cursor || typeof cursor !== "object" || !("reconciliation" in cursor)) return false;
  const phase = cursor.reconciliation;
  return !!phase && typeof phase === "object" && "version" in phase && phase.version === 1
    && "stage" in phase && (phase.stage === "enumerate" || phase.stage === "restart");
}

/** Same transaction as identity admission; trusted provider observations already own fresh metadata. */
export function requireGmailRefresh(repo: FlagRepository, ids: readonly number[], account: (id: number) => { kind: string; cursor?: unknown } | null, observation?: FlagObservation): boolean {
  if (!repo.clocks().length) return false;
  let changed = false;
  const accounts = new Map<number, ReturnType<typeof account>>();
  for (const id of ids) {
    const message = repo.message(id);
    if (!message?.provider_msg_id || message.provider_msg_id.startsWith("local:")) continue;
    const accountId = message.account_id;
    if (!repo.clock(accountId) || flagObservationValid(repo, accountId, observation)) continue;
    if (!accounts.has(accountId)) accounts.set(accountId, account(accountId));
    const owner = accounts.get(accountId);
    if (owner?.kind !== "gmail" || coveredByEnumeration(owner.cursor)) continue;
    const epoch = flagTick(repo, accountId);
    changed = true;
    for (const field of Object.keys(FLAG_COLUMNS) as LocalFlagField[]) {
      const current = repo.intent(id, field);
      putFlagIntent(repo, { message_id: id, field, account_id: accountId,
        intent_version: 0, desired: Number(message[FLAG_COLUMNS[field]]), owner_op_id: null, last_observation_epoch: 0, pending_count: 0,
        ...current, provider_msg_id: message.provider_msg_id, barrier_epoch: epoch, needs_snapshot: 1 });
    }
  }
  return changed;
}
