import { FlagObservationError, flagSnapshotBounds, type FlagClock, type FlagEffect, type FlagIntent, type FlagMessage, type FlagOp, type FlagRepository, type FlagSnapshotRequest, type LocalFlagField } from "@terno/store";
import type { Db, Param } from "./sqlite";

const repositories = new WeakMap<Db, SqlFlagRepository>();
export function sqlFlags(db: Db): SqlFlagRepository {
  let repo = repositories.get(db);
  if (!repo) repositories.set(db, (repo = new SqlFlagRepository(db)));
  return repo;
}
export class SqlFlagRepository implements FlagRepository {
  constructor(private readonly db: Db) {}
  private put(table: string, row: object) {
    const entries = Object.entries(row);
    this.db.run(`INSERT OR REPLACE INTO ${table} (${entries.map(([k]) => k).join(",")}) VALUES (${entries.map(() => "?").join(",")})`, ...entries.map(([, value]) => value as Param));
  }
  account(id: number) { return !!this.db.get("SELECT id FROM accounts WHERE id=?", id); }
  clock(id: number) { return this.db.get<FlagClock>("SELECT * FROM flag_clocks WHERE account_id=?", id) ?? null; }
  clocks() { return this.db.all<FlagClock>("SELECT * FROM flag_clocks"); }
  putClock(row: FlagClock) { this.put("flag_clocks", row); }
  message(id: number) { return this.db.get<FlagMessage>("SELECT id,account_id,provider_msg_id,is_read,is_starred,in_inbox,is_trash,is_spam FROM messages WHERE id=?", id) ?? null; }
  intent(id: number, field: LocalFlagField) { return this.db.get<FlagIntent>("SELECT * FROM message_flag_intents WHERE message_id=? AND field=?", id, field) ?? null; }
  putIntent(row: FlagIntent) { this.put("message_flag_intents", row); }
  effect(op: string, id: number, field: LocalFlagField) { return this.db.get<FlagEffect>("SELECT * FROM flag_op_effects WHERE op_id=? AND message_id=? AND field=?", op, id, field) ?? null; }
  putEffect(row: FlagEffect) { this.put("flag_op_effects", row); }
  deleteEffect(row: FlagEffect) { this.db.run("DELETE FROM flag_op_effects WHERE op_id=? AND message_id=? AND field=?", row.op_id, row.message_id, row.field); }
  effects(op: string, ids?: readonly number[]) { return ids ? ids.flatMap((id) => this.db.all<FlagEffect>("SELECT * FROM flag_op_effects WHERE op_id=? AND message_id=?", op, id)) : this.db.all<FlagEffect>("SELECT * FROM flag_op_effects WHERE op_id=?", op); }
  op(id: string) { return this.db.get<FlagOp>("SELECT id,account_id,seq,kind,state FROM ops WHERE id=?", id) ?? null; }
  upperSeq(account: number) { return this.db.get<{seq: number}>("SELECT coalesce(max(seq),0) AS seq FROM ops WHERE account_id=?", account)!.seq; }
  headers(account: number, seq: number, op: string, through: number, limit: number) { return this.db.all<FlagOp>("SELECT id,account_id,seq,kind,state FROM ops WHERE account_id=? AND seq<=? AND (seq>? OR (seq=? AND id>=?)) ORDER BY seq,id LIMIT ?", account, through, seq, seq, op, limit); }
  targets(op: string, after: number, limit: number) { return this.db.all<{message_id:number}>("SELECT message_id FROM op_targets WHERE op_id=? AND message_id>? ORDER BY message_id LIMIT ?", op, after, limit).map((r) => r.message_id); }
  hasTarget(op: string, id: number) { return !!this.db.get("SELECT 1 FROM op_targets WHERE op_id=? AND message_id=?", op, id); }
  uuid() { return this.db.uuid(); }
  snapshots(accountId: number, request: FlagSnapshotRequest) {
    const p = flagSnapshotBounds(request);
    const clock = this.clock(accountId);
    if (!clock) return { items: [], throughMessageId: 0, hasMore: false };
    if (!clock.phase) throw new FlagObservationError();
    const through = p.through ?? this.db.get<{id:number|null}>("SELECT max(message_id) AS id FROM message_flag_intents WHERE account_id=? AND needs_snapshot=1 AND pending_count=0", accountId)!.id ?? 0;
    const rows = this.db.all<{id:number;providerMsgId:string}>("SELECT DISTINCT f.message_id AS id,f.provider_msg_id AS providerMsgId FROM message_flag_intents f JOIN messages m ON m.id=f.message_id AND m.account_id=f.account_id AND m.provider_msg_id=f.provider_msg_id WHERE f.account_id=? AND f.needs_snapshot=1 AND f.pending_count=0 AND f.message_id>? AND f.message_id<=? ORDER BY f.message_id LIMIT ?", accountId, p.after, through, p.limit + 1);
    return { items: rows.slice(0, p.limit), throughMessageId: through, hasMore: rows.length > p.limit };
  }
}
