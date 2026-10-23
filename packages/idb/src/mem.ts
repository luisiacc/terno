/**
 * The in-memory half of the IndexedDB adapter: every table but message
 * bodies, as rows keyed like their SQL counterparts, with secondary indexes,
 * foreign-key cascades and an undo log. A store command runs synchronously
 * against it (nothing can interleave, like a SQLite transaction), then the
 * rows it touched are written to IndexedDB in one readwrite transaction; if
 * that fails the undo log puts memory back.
 */

export type Key = number | string;
export type Row = Record<string, unknown>;

export interface TableSpec {
  name: string;
  /** primary key columns */
  key: readonly string[];
  /** secondary indexes: name → columns (rows with a null column are left out, like a partial index) */
  indexes?: Record<string, readonly string[]>;
  /** integer primary key handed out by the table (max + 1, never reused) */
  autoId?: boolean;
  /** not loaded on open: rows enter memory when read for a command or written by one (message bodies) */
  lazy?: boolean;
}

export interface ForeignKey {
  table: string;
  column: string;
  parent: string;
  onDelete: "cascade" | "setNull";
}

const keyOf = (values: readonly unknown[]): Key => (values.length === 1 ? (values[0] as Key) : JSON.stringify(values));

interface UndoEntry {
  table: Table;
  key: Key;
  prev: Row | undefined;
}

export class Table<R extends Row = Row> {
  readonly rows = new Map<Key, R>();
  private readonly indexes = new Map<string, { cols: readonly string[]; map: Map<Key, Set<Key>> }>();
  private nextId = 1;
  /** lazy tables: keys known to have no row in IndexedDB */
  readonly absent = new Set<Key>();

  constructor(
    readonly spec: TableSpec,
    private readonly db: MemDb,
  ) {
    for (const [name, cols] of Object.entries(spec.indexes ?? {})) this.indexes.set(name, { cols, map: new Map() });
  }

  keyOfRow(row: Row): Key {
    return keyOf(this.spec.key.map((c) => row[c]));
  }

  key(...values: unknown[]): Key {
    return keyOf(values);
  }

  get(...values: unknown[]): R | undefined {
    return this.rows.get(keyOf(values));
  }

  has(...values: unknown[]): boolean {
    return this.rows.has(keyOf(values));
  }

  /** rows whose index columns equal `values` */
  by(index: string, ...values: unknown[]): R[] {
    const keys = this.indexes.get(index)?.map.get(keyOf(values));
    if (!this.indexes.has(index)) throw new Error(`${this.spec.name} has no index ${index}`);
    if (!keys) return [];
    const out: R[] = [];
    for (const k of keys) out.push(this.rows.get(k)!);
    return out;
  }

  /** how many rows an index holds for `values` */
  count(index: string, ...values: unknown[]): number {
    return this.indexes.get(index)?.map.get(keyOf(values))?.size ?? 0;
  }

  all(): IterableIterator<R> {
    return this.rows.values();
  }

  get size(): number {
    return this.rows.size;
  }

  /** the next integer key (autoId tables) */
  allocateId(): number {
    return this.nextId++;
  }

  /** INSERT: false (and nothing written) if the key exists */
  insert(row: R): boolean {
    const k = this.withId(row);
    if (this.rows.has(k)) return false;
    this.write(k, row);
    return true;
  }

  /** INSERT OR REPLACE */
  put(row: R): R {
    this.write(this.withId(row), row);
    return row;
  }

  /** UPDATE of one row (rows are values: a new object replaces the old) */
  update(row: R, patch: Partial<R>): R {
    const next = { ...row, ...patch } as R;
    const oldKey = this.keyOfRow(row);
    const newKey = this.keyOfRow(next);
    if (newKey !== oldKey) {
      this.remove(oldKey);
      this.write(newKey, next);
    } else this.write(oldKey, next);
    return next;
  }

  /** DELETE by primary key, cascading to children; returns the deleted row */
  delete(...values: unknown[]): R | undefined {
    return this.remove(keyOf(values));
  }

  deleteRow(row: R): void {
    this.remove(this.keyOfRow(row));
  }

  private withId(row: R): Key {
    if (this.spec.autoId) {
      const col = this.spec.key[0]!;
      if (row[col] === undefined || row[col] === null) (row as Row)[col] = this.allocateId();
      else this.nextId = Math.max(this.nextId, Number(row[col]) + 1);
    }
    return this.keyOfRow(row);
  }

  private write(k: Key, row: R): void {
    this.db.checkParents(this.spec.name, row);
    const prev = this.rows.get(k);
    this.db.logUndo(this, k, prev);
    this.set(k, row, prev);
  }

  private remove(k: Key): R | undefined {
    const prev = this.rows.get(k);
    if (!prev) {
      // lazy rows may exist only in IndexedDB: record the delete anyway
      if (this.spec.lazy && !this.absent.has(k)) this.db.logUndo(this, k, undefined, true);
      return undefined;
    }
    this.db.logUndo(this, k, prev);
    this.set(k, undefined, prev);
    this.db.cascade(this.spec.name, prev);
    return prev;
  }

  /** raw: rows and indexes only (loading, undo) */
  set(k: Key, row: R | undefined, prev: R | undefined = this.rows.get(k)): void {
    if (prev) this.unindex(k, prev);
    if (row) {
      this.rows.set(k, row);
      this.index(k, row);
      this.absent.delete(k);
      if (this.spec.autoId) this.nextId = Math.max(this.nextId, Number(k) + 1);
    } else this.rows.delete(k);
    this.db.onRowChange(this.spec.name, row, prev);
  }

  /** lazy tables: drops rows from memory (they stay in IndexedDB) */
  evict(keys: Iterable<Key>): void {
    for (const k of keys) this.rows.delete(k);
  }

  /** loading: a row read from IndexedDB, not a change */
  load(row: R): void {
    this.set(this.keyOfRow(row), row, undefined);
  }

  private index(k: Key, row: R): void {
    for (const { cols, map } of this.indexes.values()) {
      const values = cols.map((c) => row[c]);
      if (values.some((v) => v === null || v === undefined)) continue;
      const ik = keyOf(values);
      let set = map.get(ik);
      if (!set) map.set(ik, (set = new Set()));
      set.add(k);
    }
  }

  private unindex(k: Key, row: R): void {
    for (const { cols, map } of this.indexes.values()) {
      const values = cols.map((c) => row[c]);
      if (values.some((v) => v === null || v === undefined)) continue;
      const ik = keyOf(values);
      const set = map.get(ik);
      if (!set) continue;
      set.delete(k);
      if (set.size === 0) map.delete(ik);
    }
  }
}

export interface Committed {
  /** the final state of every row the transaction touched (null: deleted) */
  writes: Map<Table, Map<Key, Row | null>>;
}

export class MemDb {
  readonly tables = new Map<string, Table>();
  private readonly children = new Map<string, ForeignKey[]>();
  private readonly parents = new Map<string, ForeignKey[]>();
  private undo: UndoEntry[] | null = null;
  private depth = 0;
  private readonly rowListeners: ((table: string, row: Row | undefined, prev: Row | undefined) => void)[] = [];

  constructor(specs: readonly TableSpec[], foreignKeys: readonly ForeignKey[]) {
    for (const s of specs) this.tables.set(s.name, new Table(s, this));
    for (const fk of foreignKeys) {
      const list = this.children.get(fk.parent) ?? [];
      list.push(fk);
      this.children.set(fk.parent, list);
      const up = this.parents.get(fk.table) ?? [];
      up.push(fk);
      this.parents.set(fk.table, up);
      const child = this.table(fk.table);
      if (!child.spec.indexes?.[`fk_${fk.column}`] && !(child.spec.key.length === 1 && child.spec.key[0] === fk.column)) {
        throw new Error(`${fk.table}.${fk.column} needs an index fk_${fk.column} for its foreign key`);
      }
    }
  }

  table<R extends Row = Row>(name: string): Table<R> {
    const t = this.tables.get(name);
    if (!t) throw new Error(`no table ${name}`);
    return t as unknown as Table<R>;
  }

  /** derived state (the recency order) follows every row change, undo included */
  onRow(fn: (table: string, row: Row | undefined, prev: Row | undefined) => void): void {
    this.rowListeners.push(fn);
  }

  onRowChange(table: string, row: Row | undefined, prev: Row | undefined): void {
    for (const fn of this.rowListeners) fn(table, row, prev);
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  logUndo(table: Table, key: Key, prev: Row | undefined, blind = false): void {
    if (!this.undo) throw new Error(`write to ${table.spec.name} outside a transaction`);
    this.undo.push({ table, key, prev: blind ? BLIND : prev });
  }

  /** FOREIGN KEY: a row may only point at rows that exist (SQLite with foreign_keys = ON) */
  checkParents(table: string, row: Row): void {
    for (const fk of this.parents.get(table) ?? []) {
      const v = row[fk.column];
      if (v !== null && v !== undefined && !this.table(fk.parent).rows.has(v as Key)) throw new Error(`FOREIGN KEY constraint failed (${table}.${fk.column} → ${fk.parent} ${String(v)})`);
    }
  }

  cascade(parent: string, row: Row): void {
    for (const fk of this.children.get(parent) ?? []) {
      const child = this.table(fk.table);
      const id = row.id ?? row[this.table(parent).spec.key[0]!];
      const rows = child.spec.key.length === 1 && child.spec.key[0] === fk.column ? [child.get(id)].filter((r): r is Row => !!r) : child.by(`fk_${fk.column}`, id);
      if (fk.onDelete === "cascade") {
        for (const r of rows) child.deleteRow(r);
        if (child.spec.lazy && child.spec.key.length === 1 && child.spec.key[0] === fk.column && rows.length === 0) child.delete(id);
      } else for (const r of rows) child.update(r, { [fk.column]: null });
    }
  }

  /**
   * Runs fn as one unit. Nested calls are savepoints: a nested failure rolls
   * back only its own writes. The top level returns what to persist.
   */
  tx<T>(fn: () => T): T {
    const top = this.depth === 0;
    if (top) this.undo = [];
    const savepoint = this.undo!.length;
    this.depth++;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error("MemDb.tx callbacks must be synchronous");
      return result;
    } catch (error) {
      this.rollbackTo(savepoint);
      throw error;
    } finally {
      this.depth--;
      // several top-level units before a commit (a command's body and its outbox append) persist together
      if (top && this.undo) this.pending = this.pending ? this.pending.concat(this.undo) : this.undo;
      if (top) this.undo = null;
    }
  }

  /** the undo log of the last top-level transaction, until committed or rolled back */
  private pending: UndoEntry[] | null = null;

  /** what the last top-level transaction changed (final row states); call once, then persist and confirm */
  takeCommit(): Committed | null {
    const log = this.pending;
    if (!log || log.length === 0) {
      this.pending = null;
      return null;
    }
    const writes = new Map<Table, Map<Key, Row | null>>();
    for (const e of log) {
      let m = writes.get(e.table);
      if (!m) writes.set(e.table, (m = new Map()));
      m.set(e.key, e.table.rows.get(e.key) ?? null);
    }
    return { writes };
  }

  /** keys of the given tables the uncommitted unit touched (deletes included) */
  touched(tables: readonly string[]): Map<string, Key[]> {
    const out = new Map<string, Key[]>(tables.map((t) => [t, []]));
    const seen = new Set<string>();
    for (const e of [...(this.pending ?? []), ...(this.undo ?? [])]) {
      const list = out.get(e.table.spec.name);
      if (!list) continue;
      const id = `${e.table.spec.name}\u0000${e.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      list.push(e.key);
    }
    return out;
  }

  /** the persisted transaction is final */
  confirm(): void {
    this.pending = null;
  }

  /** persisting failed: memory goes back to before the transaction */
  revert(): void {
    const log = this.pending;
    this.pending = null;
    if (!log) return;
    this.undo = log;
    this.rollbackTo(0);
    this.undo = null;
  }

  private rollbackTo(savepoint: number): void {
    const log = this.undo!;
    for (let i = log.length - 1; i >= savepoint; i--) {
      const e = log[i]!;
      if (e.prev === BLIND) continue;
      e.table.set(e.key, e.prev as Row | undefined);
    }
    log.length = savepoint;
  }
}

/** a delete recorded for a lazy row that isn't in memory */
const BLIND = Object.freeze({}) as Row;
