import { FlagObservationError, operationFlagFields, type LocalFlagField } from "./flag-intents";
import type { FlagObservation, FlagReconciliation, FlagSnapshotRequest } from "./types";

export interface FlagClock { account_id: number; protocol_id: string; epoch: number; phase: number; upper_seq: number; after_seq: number; after_op: string; after_message: number }
export interface FlagIntent { message_id: number; field: LocalFlagField; account_id: number; provider_msg_id: string; intent_version: number; desired: number; owner_op_id: string | null; barrier_epoch: number; last_observation_epoch: number; pending_count: number; needs_snapshot: number; snapshot_account_id?: number }
export interface FlagEffect { op_id: string; message_id: number; field: LocalFlagField; account_id: number; intent_version: number | null; value: number; active: number }
export interface FlagOp { id: string; account_id: number; seq: number; kind: string; state: string }
export interface FlagMessage { id: number; account_id: number; provider_msg_id: string | null; is_read: number; is_starred: number; in_inbox: number; is_trash: number; is_spam: number }

export const FLAG_COLUMNS: Record<LocalFlagField, keyof FlagMessage> = { isRead: "is_read", isStarred: "is_starred", inInbox: "in_inbox", isTrash: "is_trash", isSpam: "is_spam" };
const VALUES: Record<string, Partial<Record<LocalFlagField, number>>> = {
  markRead: { isRead: 1 }, markUnread: { isRead: 0 }, star: { isStarred: 1 }, unstar: { isStarred: 0 },
  archive: { inInbox: 0 }, trash: { isTrash: 1, inInbox: 0 }, spam: { isSpam: 1, inInbox: 0 },
  notSpam: { isSpam: 0, inInbox: 1 }, moveToInbox: { inInbox: 1, isTrash: 0, isSpam: 0 },
};

/** Synchronous point/range operations, always used inside an adapter-owned transaction. */
export interface FlagRepository {
  account(id: number): boolean;
  clock(id: number): FlagClock | null;
  clocks(): FlagClock[];
  putClock(row: FlagClock): void;
  message(id: number): FlagMessage | null;
  setMessageFlags(id: number, values: Partial<Record<LocalFlagField, number>>): void;
  intent(id: number, field: LocalFlagField): FlagIntent | null;
  putIntent(row: FlagIntent): void;
  effect(op: string, id: number, field: LocalFlagField): FlagEffect | null;
  putEffect(row: FlagEffect): void;
  deleteEffect(row: FlagEffect): void;
  effects(op: string, messageIds?: readonly number[]): FlagEffect[];
  messageEffects(id: number): FlagEffect[];
  op(id: string): FlagOp | null;
  upperSeq(account: number): number;
  headers(account: number, afterSeq: number, afterOp: string, through: number, limit: number): FlagOp[];
  targets(op: string, after: number, limit: number): number[];
  hasTarget(op: string, id: number): boolean;
  uuid(): string;
}

const stable = (message: FlagMessage | null): message is FlagMessage & { provider_msg_id: string } => !!message?.provider_msg_id && !message.provider_msg_id.startsWith("local:");
export function putFlagIntent(repo: FlagRepository, row: FlagIntent): void {
  const { snapshot_account_id: _, ...value } = row;
  repo.putIntent(row.needs_snapshot && row.pending_count === 0 ? { ...value, snapshot_account_id: row.account_id } : value);
}
export function flagTick(repo: FlagRepository, accountId: number): number {
  const clock = repo.clock(accountId);
  if (!clock || !Number.isSafeInteger(clock.epoch) || clock.epoch >= Number.MAX_SAFE_INTEGER) throw new Error("Flag observation epoch is exhausted.");
  repo.putClock({ ...clock, epoch: clock.epoch + 1 });
  return clock.epoch + 1;
}
export function startFlagObservation(repo: FlagRepository, accountId: number, authoritative: boolean): FlagClock | null {
  if (!repo.account(accountId)) throw new Error("Account no longer exists.");
  const current = repo.clock(accountId);
  if (!authoritative) { if (current) throw new FlagObservationError(); return null; }
  if (current) return current;
  const row: FlagClock = { account_id: accountId, protocol_id: repo.uuid(), epoch: 1, phase: 0, upper_seq: repo.upperSeq(accountId), after_seq: 0, after_op: "", after_message: 0 };
  repo.putClock(row);
  return row;
}

function ensureIntent(repo: FlagRepository, message: FlagMessage & { provider_msg_id: string }, field: LocalFlagField): FlagIntent {
  const current = repo.intent(message.id, field);
  if (current) return current;
  const row: FlagIntent = { message_id: message.id, field, account_id: message.account_id, provider_msg_id: message.provider_msg_id, intent_version: 0, desired: Number(message[FLAG_COLUMNS[field]]), owner_op_id: null, barrier_epoch: repo.clock(message.account_id)!.epoch, last_observation_epoch: 0, pending_count: 0, needs_snapshot: 1 };
  putFlagIntent(repo, row);
  return row;
}
export function bindFlagTarget(repo: FlagRepository, op: FlagOp, messageId: number, version: number | null): void {
  if (!repo.clock(op.account_id) || !repo.hasTarget(op.id, messageId)) return;
  const message = repo.message(messageId);
  if (!stable(message) || message.account_id !== op.account_id) return;
  for (const field of operationFlagFields(op.kind)) {
    if (repo.effect(op.id, messageId, field)) continue;
    const row = ensureIntent(repo, message, field);
    const active = +(op.state === "queued" || op.state === "running");
    const value = VALUES[op.kind]![field]!;
    repo.putEffect({ op_id: op.id, message_id: messageId, field, account_id: op.account_id, intent_version: version, value, active });
    putFlagIntent(repo, { ...row, pending_count: row.pending_count + active, owner_op_id: version !== null && row.intent_version === version && row.desired === value ? op.id : row.owner_op_id });
  }
}

/** A step counts empty/ineligible operation headers as work, separately from target rows. */
export function initializeFlagStep(repo: FlagRepository, accountId: number): boolean {
  let clock = repo.clock(accountId);
  if (!clock || clock.phase) return true;
  const headers = repo.headers(accountId, clock.after_seq, clock.after_op, clock.upper_seq, 64);
  let budget = 128;
  for (const op of headers) {
    if (op.id === clock.after_op && clock.after_message === -1) continue;
    const after = op.id === clock.after_op ? clock.after_message : 0;
    const eligible = operationFlagFields(op.kind).length && ["queued", "running", "unknown"].includes(op.state);
    const ids = eligible ? repo.targets(op.id, after, budget) : [];
    const current = repo.op(op.id);
    if (current) for (const id of ids) bindFlagTarget(repo, current, id, null);
    budget -= ids.length;
    if (ids.length && budget === 0) {
      repo.putClock({ ...repo.clock(accountId)!, after_seq: op.seq, after_op: op.id, after_message: ids[ids.length - 1]! });
      return false;
    }
    clock = { ...repo.clock(accountId)!, after_seq: op.seq, after_op: op.id, after_message: -1 };
    repo.putClock(clock);
  }
  if (headers.length === 64) return false;
  repo.putClock({ ...repo.clock(accountId)!, phase: 1 });
  return true;
}

export function localFlagIntent(repo: FlagRepository, accountId: number, messageIds: readonly number[], kind: string, version?: number): number | null {
  if (!repo.clock(accountId) || !operationFlagFields(kind).length) return null;
  const generation = version ?? flagTick(repo, accountId);
  for (const id of messageIds) {
    const message = repo.message(id);
    if (!stable(message) || message.account_id !== accountId) continue;
    for (const field of operationFlagFields(kind)) {
      const row = ensureIntent(repo, message, field);
      putFlagIntent(repo, { ...row, intent_version: generation, desired: Number(message[FLAG_COLUMNS[field]]), owner_op_id: null, barrier_epoch: Math.max(row.barrier_epoch, generation), needs_snapshot: 1 });
    }
  }
  return generation;
}

/** A reaffirmed observed value must not later re-arm a conflicting parked mutation. */
export function reaffirmFlagIntent(repo: FlagRepository, messageIds: readonly number[], kind: string): void {
  if (!messageIds.length || !repo.clocks().length) return;
  const fields = operationFlagFields(kind), versions = new Map<number, number>();
  for (const id of messageIds) {
    const message = repo.message(id);
    if (!stable(message) || !repo.clock(message.account_id) || !fields.every((field) => Number(message[FLAG_COLUMNS[field]]) === VALUES[kind]![field])) continue;
    const conflicting = repo.messageEffects(id).some((effect) => {
      const row = repo.intent(id, effect.field);
      return fields.includes(effect.field) && row?.intent_version === (effect.intent_version ?? 0) && effect.value !== VALUES[kind]![effect.field] && repo.op(effect.op_id)?.state === "unknown";
    });
    if (!conflicting) continue;
    let version = versions.get(message.account_id);
    if (version === undefined) { version = flagTick(repo, message.account_id); versions.set(message.account_id, version); }
    localFlagIntent(repo, message.account_id, [id], kind, version);
  }
}

export function settleFlagEffects(repo: FlagRepository, op: FlagOp, outcome: "success" | "unknown" | "removed", messageIds?: readonly number[]): void {
  if (!repo.clock(op.account_id)) return;
  const effects = repo.effects(op.id, messageIds);
  if (!effects.length) return;
  const epoch = flagTick(repo, op.account_id);
  for (const effect of effects) {
    const row = repo.intent(effect.message_id, effect.field);
    if (row) putFlagIntent(repo, { ...row, pending_count: row.pending_count - effect.active, barrier_epoch: Math.max(row.barrier_epoch, epoch), needs_snapshot: 1 });
    if (outcome === "unknown") repo.putEffect({ ...effect, active: 0 });
    else repo.deleteEffect(effect);
  }
}

export function flagObservationValid(repo: FlagRepository, accountId: number, observation: FlagObservation | undefined): boolean {
  const clock = repo.clock(accountId);
  return !!clock?.phase && !!observation && observation.accountId === accountId && observation.protocolId === clock.protocol_id && Number.isSafeInteger(observation.epoch) && observation.epoch > 0 && observation.epoch <= clock.epoch;
}
export function acceptFlagObservation(repo: FlagRepository, messageId: number, field: LocalFlagField, observation?: FlagObservation): boolean {
  const row = repo.intent(messageId, field);
  if (!row) return true;
  if (row.pending_count || !flagObservationValid(repo, row.account_id, observation) || observation!.epoch <= row.barrier_epoch || observation!.epoch < row.last_observation_epoch) return false;
  putFlagIntent(repo, { ...row, last_observation_epoch: observation!.epoch, needs_snapshot: 0 });
  return true;
}
export function flagSnapshotBounds(request: FlagSnapshotRequest): { after: number; through?: number; limit: number } {
  for (const value of [request.limit, request.afterMessageId ?? 0, request.throughMessageId ?? 0]) if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid flag snapshot page.");
  return { after: request.afterMessageId ?? 0, through: request.throughMessageId, limit: Math.max(1, Math.min(50, request.limit)) };
}

export function flagEpochs(repo: FlagRepository): Map<number, number> { return new Map(repo.clocks().map((clock) => [clock.account_id, clock.epoch])); }
export function flagReconciliation(repo: FlagRepository, before: ReadonlyMap<number, number>): FlagReconciliation {
  const changed = repo.clocks().filter((clock) => clock.epoch > (before.get(clock.account_id) ?? clock.epoch)).map((clock) => clock.account_id);
  return changed.length ? { flagReconcileAccounts: changed } : {};
}

/** Explicit retry is a new local intention only where the parked binding is still current. */
export function rearmFlagEffects(repo: FlagRepository, op: FlagOp): number[] | null {
  const effects = repo.effects(op.id);
  if (!effects.length) return [];
  const eligible = new Set<number>(), superseded = new Set<number>();
  for (const effect of effects) {
    const row = repo.intent(effect.message_id, effect.field);
    if (!row || row.intent_version !== (effect.intent_version ?? 0) || row.desired !== effect.value) superseded.add(effect.message_id);
    else eligible.add(effect.message_id);
  }
  if (superseded.size && ["archive", "trash", "spam", "notSpam", "moveToInbox"].includes(op.kind)) return null;
  for (const id of superseded) eligible.delete(id);
  if (!eligible.size) return null;
  const version = flagTick(repo, op.account_id);
  for (const effect of effects) {
    if (!eligible.has(effect.message_id)) { repo.deleteEffect(effect); continue; }
    const row = repo.intent(effect.message_id, effect.field)!;
    putFlagIntent(repo, { ...row, intent_version: version, desired: effect.value, owner_op_id: op.id, barrier_epoch: version, pending_count: row.pending_count + (1 - effect.active), needs_snapshot: 1 });
    repo.putEffect({ ...effect, intent_version: version, active: 1 });
    repo.setMessageFlags(effect.message_id, { [effect.field]: effect.value });
  }
  return [...eligible];
}
