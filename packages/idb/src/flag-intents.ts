import { FlagObservationError, FLAG_COLUMNS, flagSnapshotBounds, operationFlagFields, type FlagClock, type FlagEffect, type FlagIntent, type FlagMessage, type FlagOp, type FlagRepository, type FlagSnapshotRequest, type LocalFlagField } from "@terno/store";
import type { MemDb, Row } from "./mem";

const repositories = new WeakMap<MemDb, IdbFlagRepository>();
export function idbFlags(c: { db: MemDb; uuid(): string }): IdbFlagRepository {
  let repo = repositories.get(c.db);
  if (!repo) repositories.set(c.db, (repo = new IdbFlagRepository(c.db, () => c.uuid())));
  return repo;
}
export class IdbFlagRepository implements FlagRepository {
  preparation: { headers: FlagOp[]; targets: Map<string, number[]> } | null = null;
  constructor(private readonly db: MemDb, readonly uuid: () => string) {}
  account(id: number) { return this.db.table("accounts").has(id); }
  clock(id: number) { return this.db.table("flag_clocks").get(id) as unknown as FlagClock ?? null; }
  clocks() { return [...this.db.table("flag_clocks").all()] as unknown as FlagClock[]; }
  putClock(row: FlagClock) { this.db.table("flag_clocks").put({ ...row }); }
  message(id: number) { return this.db.table("messages").get(id) as unknown as FlagMessage ?? null; }
  setMessageFlags(id: number, values: Partial<Record<LocalFlagField, number>>) {
    const messages = this.db.table("messages"), row = messages.get(id);
    if (row) messages.update(row, Object.fromEntries(Object.entries(values).map(([field, value]) => [FLAG_COLUMNS[field as LocalFlagField], value])));
  }
  intent(id: number, field: LocalFlagField) { return this.db.table("message_flag_intents").get(id, field) as unknown as FlagIntent ?? null; }
  putIntent(row: FlagIntent) { this.db.table("message_flag_intents").put({ ...row }); }
  effect(op: string, id: number, field: LocalFlagField) { return this.db.table("flag_op_effects").get(op, id, field) as unknown as FlagEffect ?? null; }
  putEffect(row: FlagEffect) { this.db.table("flag_op_effects").put({ ...row }); }
  deleteEffect(row: FlagEffect) { this.db.table("flag_op_effects").delete(row.op_id, row.message_id, row.field); }
  effects(op: string, ids?: readonly number[]) {
    const all = this.db.table("flag_op_effects").by("fk_op_id", op) as unknown as FlagEffect[];
    if (!ids) return all;
    const wanted = new Set(ids);
    return all.filter((row) => wanted.has(row.message_id));
  }
  op(id: string) {
    const row = this.db.table("ops").get(id);
    return row ? { id: row.id as string, account_id: row.account_id as number, seq: row.seq as number, kind: row.kind as string, state: row.state as string } : null;
  }
  upperSeq(_account: number) {
    // The table's tracked peak is an upper bound, not a causal epoch or an account scan.
    return this.db.table("ops").peak("seq");
  }
  headers() { if (!this.preparation) throw new Error("Flag initializer page was not prepared."); return this.preparation.headers; }
  targets(op: string, after: number, limit: number) {
    if (!this.preparation) throw new Error("Flag target page was not prepared.");
    return (this.preparation.targets.get(op) ?? []).filter((id) => id > after).slice(0, limit);
  }
  hasTarget(op: string, id: number) { return this.db.table("op_targets").has(op, id); }
}

function cursorValues(idb: IDBDatabase, table: string, index: string | null, range: IDBKeyRange, direction: IDBCursorDirection, limit: number, keys = false): Promise<(Row | IDBValidKey)[]> {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(table, "readonly");
    const store = tx.objectStore(table);
    const source = index ? store.index(index) : store;
    const request = keys ? source.openKeyCursor(range, direction) : source.openCursor(range, direction);
    const rows: (Row | IDBValidKey)[] = [];
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error ?? new Error("Flag cursor aborted."));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || rows.length === limit) { resolve(rows); return; }
      rows.push(keys ? cursor.primaryKey : (cursor as IDBCursorWithValue).value as Row);
      if (rows.length === limit) resolve(rows); else cursor.continue();
    };
  });
}

export async function prepareIdbFlagPage(idb: IDBDatabase, repo: IdbFlagRepository, clock: FlagClock) {
  const keys = await cursorValues(idb, "ops", "flag_account_seq", IDBKeyRange.bound([clock.account_id, clock.after_seq, clock.after_op], [clock.account_id, clock.upper_seq, "\uffff"]), "next", 64, true);
  const headers = keys.map((key) => repo.op(key as string)).filter((row): row is FlagOp => row !== null);
  const targets = new Map<string, number[]>();
  let budget = 128;
  for (const op of headers) {
    if (!budget || (op.id === clock.after_op && clock.after_message === -1) || !operationFlagFields(op.kind).length || !["queued", "running", "unknown"].includes(op.state)) continue;
    const after = op.id === clock.after_op ? clock.after_message : 0;
    const values = await cursorValues(idb, "op_targets", null, IDBKeyRange.bound([op.id, after + 1], [op.id, Number.MAX_SAFE_INTEGER]), "next", budget, true);
    const ids = values.map((key) => (key as IDBValidKey[])[1] as number);
    targets.set(op.id, ids); budget -= ids.length;
  }
  return { headers, targets };
}

export async function idbFlagSnapshots(idb: IDBDatabase, repo: IdbFlagRepository, accountId: number, request: FlagSnapshotRequest) {
  const p = flagSnapshotBounds(request);
  const clock = repo.clock(accountId);
  if (!clock) return { items: [], throughMessageId: 0, hasMore: false };
  if (!clock.phase) throw new FlagObservationError();
  const range = IDBKeyRange.bound([accountId, 0], [accountId, Number.MAX_SAFE_INTEGER]);
  const last = p.through === undefined ? await cursorValues(idb, "message_flag_intents", "flag_snapshots", range, "prev", 1) : [];
  const through = p.through ?? (last[0] as Row | undefined)?.message_id as number | undefined ?? 0;
  if (through <= p.after) return { items: [], throughMessageId: through, hasMore: false };
  const rows = await cursorValues(idb, "message_flag_intents", "flag_snapshots", IDBKeyRange.bound([accountId, p.after], [accountId, through], true), "next", (p.limit + 1) * 5) as Row[];
  const items: {id:number;providerMsgId:string}[] = [];
  let previous = -1;
  for (const row of rows) {
    const id = row.message_id as number;
    if (id === previous) continue;
    previous = id;
    const message = repo.message(id);
    if (message?.account_id === accountId && message.provider_msg_id === row.provider_msg_id) items.push({ id, providerMsgId: row.provider_msg_id as string });
    if (items.length > p.limit) break;
  }
  return { items: items.slice(0, p.limit), throughMessageId: through, hasMore: items.length > p.limit };
}
