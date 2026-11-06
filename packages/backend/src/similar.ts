/**
 * Plan 63: the filters "similar" actions create (Spam similar always; Archive
 * and Delete when the user says Always). One at a time, so two applies never
 * make two filters; Undo takes back only what it did, and only while the
 * filter is still exactly that.
 *
 * Plan 90: they're Terno's (`auto`). One for the same mail filing elsewhere is
 * retargeted, not doubled; a user's own filter is never changed, only reused
 * as it is. Every write compares the filter it read (an edit meanwhile wins).
 */
import { capFilterName, filterState, LEARNED_FILTER_NAME, sameFilterState, sameRule, similarLearnedKey, similarRule, similarValue, type Filter, type FilterRule, type FilterState, type SimilarAction, type SimilarScope } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { MailStore } from "@terno/store";

/** One filter's change: `before` null means it was created (Undo deletes it). */
interface Change {
  filterId: number;
  before: FilterState | null;
  /** the filter as this left it: an edit since then keeps it */
  after: FilterState;
}

/** the last few, like the thread undo journal */
const KEEP = 16;

export interface Ensured {
  filter: Filter;
  /** null when nothing changed */
  filterUndo: number | null;
  /** plan 90: the same mail's automatic filter filed into this category before */
  retargeted: { from: number } | null;
  /** plan 128: the same mail's automatic filter moved it to this other folder before */
  retargetedFolder: { from: string } | null;
}

/** Where a rule with one action puts mail, as a key: a category or a folder. */
const targetOf = (rule: FilterRule): string | null => {
  const action = rule.actions.length === 1 ? rule.actions[0]! : null;
  if (action?.type === "addCategory") return `cat:${action.categoryId}`;
  if (action?.type === "moveToFolder") return `folder:${action.accountId}:${action.folder}`;
  return null;
};
/** Two different places of one kind. A category and a folder aren't rivals: mail can be in both (plan 127). */
const rivals = (a: string, b: string) => a !== b && a.slice(0, a.indexOf(":")) === b.slice(0, b.indexOf(":"));
/** What mail a rule looks at besides which account's. */
const mailConditions = (rule: FilterRule) => rule.conditions.filter((c) => c.field !== "account");
const accountOf = (rule: FilterRule) => rule.conditions.find((c) => c.field === "account")?.value ?? null;
/** The same conditions (what mail), whatever it does with it. */
const sameMail = (a: FilterRule, b: FilterRule) => sameRule({ ...a, actions: [] }, { ...b, actions: [] });
/** A sender-wide rule's address: one `from equals` and nothing else. */
const senderOf = (rule: FilterRule): string | null => {
  const [c, ...rest] = mailConditions(rule);
  return rest.length === 0 && c?.field === "from" && c.op === "equals" && !c.negate ? c.value.trim().toLowerCase() : null;
};
/** A sender + subject rule's address. */
const subjectSenderOf = (rule: FilterRule): string | null => {
  const conditions = mailConditions(rule);
  if (conditions.length !== 2) return null;
  const from = conditions.find((c) => c.field === "from" && c.op === "equals" && !c.negate);
  const subject = conditions.find((c) => c.field === "subject" && !c.negate);
  return from && subject && typeof from.value === "string" ? from.value.trim().toLowerCase() : null;
};

export class SimilarFilters {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly undos = new Map<number, Change[]>();
  private seq = 0;

  constructor(
    private readonly store: Pick<MailStore, "filters">,
    private readonly now: () => number,
  ) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private remember(changes: Change[]): number | null {
    if (changes.length === 0) return null;
    const id = ++this.seq;
    this.undos.set(id, changes);
    while (this.undos.size > KEEP) this.undos.delete(this.undos.keys().next().value as number);
    return id;
  }

  /** Writes `next` over `f` only if it's still what was read; the change for the journal. */
  private async write(f: Filter, next: Partial<FilterState>, keepApplications = false): Promise<{ filter: Filter; change: Change }> {
    const before = filterState(f);
    const state = { ...before, ...next };
    const filter = await this.store.filters.save({ id: f.id, ...state, source: f.source, keepApplications, expect: before }, this.now());
    return { filter, change: { filterId: f.id, before, after: filterState(filter) } };
  }

  /** The scope's filter, enabled: an identical one is reused (a disabled automatic one enabled), else a new one. */
  ensure(scope: SimilarScope, action: SimilarAction, name?: string): Promise<Ensured> {
    const key = similarLearnedKey(scope, action);
    // the learned banner won't propose what this already does (a subject rule covers less: no key)
    return this.ensureRule(similarRule(scope, action), name ?? L(LEARNED_FILTER_NAME[action], { value: similarValue(scope) }).message, key ?? undefined);
  }

  /**
   * Runs a series of writes; what committed is journaled whatever happens. A
   * filter edited between the read and the write is left as the edit made it
   * (CANCELLED, skipped); any other failure rethrows with the undo of what
   * committed before it in its details (Codex review).
   */
  private async journaled<T>(work: (record: (change: Change) => void, skip: (write: () => Promise<Change>) => Promise<Change | null>) => Promise<T>): Promise<{ result: T; filterUndo: number | null }> {
    const changes: Change[] = [];
    const record = (c: Change) => void changes.push(c);
    const skip = async (write: () => Promise<Change>) => {
      try {
        return await write();
      } catch (error) {
        if (error instanceof RpcError && error.code === "CANCELLED") return null;
        throw error;
      }
    };
    try {
      const result = await work(record, skip);
      return { result, filterUndo: this.remember(changes) };
    } catch (error) {
      const filterUndo = this.remember(changes);
      if (filterUndo === null) throw error;
      throw new RpcError("INTERNAL", error instanceof Error ? error.message : String(error), { filterUndo }, { expected: false, cause: error });
    }
  }

  /** Plan 80: any rule, the same way; plan 90: an automatic category filter for the same mail elsewhere moves here instead. */
  ensureRule(rule: FilterRule, name: string, learnedKey?: string, o: { asked?: boolean } = {}): Promise<Ensured> {
    return this.serial(async () => {
      const all = await this.store.filters.list();
      const { result, filterUndo } = await this.journaled(async (record, skip) => {
        const same = all.filter((f) => sameRule(f.rule, rule));
        // anyone's identical filter, on, is already doing it: reused, never changed
        let filter = same.find((f) => f.enabled) ?? null;
        let retargeted: { from: number } | null = null;
        let retargetedFolder: { from: string } | null = null;
        const target = targetOf(rule);
        if (!filter) {
          // a disabled one is turned back on only if it's Terno's: the user turned theirs off
          const off = same.find((f) => f.auto);
          const elsewhere = target === null ? [] : all.filter((f) => { const to = targetOf(f.rule); return f.auto && sameMail(f.rule, rule) && to !== null && rivals(to, target); }).sort((a, b) => b.id - a.id);
          if (off) {
            const w = await this.write(off, { enabled: true });
            filter = w.filter;
            record(w.change);
          } else if (elsewhere[0]) {
            // the same mail filed elsewhere before: it files here now (old mail isn't re-filed: its claims stay)
            const from = elsewhere[0].rule.actions[0]!;
            const w = await this.write(elsewhere[0], { rule, name: capFilterName(name), enabled: true }, true);
            filter = w.filter;
            record(w.change);
            if (from.type === "addCategory") retargeted = { from: from.categoryId };
            if (from.type === "moveToFolder") retargetedFolder = { from: from.folder };
          } else {
            // plan 143: a sentence's filter is one the user asked for: theirs, under Your filters
            filter = await this.store.filters.save({ name: capFilterName(name), enabled: true, source: o.asked ? "ai" : "manual", auto: !o.asked, rule, learnedKey }, this.now());
            record({ filterId: filter.id, before: null, after: filterState(filter) });
          }
        }
        // a sender's mail filed here: their automatic subject filters filing elsewhere would split it (plan 91 R9), reused or not
        const sender = target === null ? null : senderOf(rule);
        if (sender) {
          for (const f of all) {
            if (!f.auto || !f.enabled || f.id === filter.id || subjectSenderOf(f.rule) !== sender || accountOf(f.rule) !== accountOf(rule)) continue;
            const to = targetOf(f.rule);
            if (to === null || !rivals(to, target!)) continue;
            const change = await skip(async () => (await this.write(f, { enabled: false })).change);
            if (change) record(change);
          }
        }
        return { filter, retargeted, retargetedFolder };
      });
      return { ...result, filterUndo };
    });
  }

  /** Plan 90: filters on or off at once ("Stop filing…", "Turn all off"), each only if unchanged since it was read; one Undo. */
  setEnabled(ids: readonly number[], enabled: boolean): Promise<{ changed: number; filterUndo: number | null }> {
    return this.serial(async () => {
      let changed = 0;
      const { filterUndo } = await this.journaled(async (record, skip) => {
        for (const id of new Set(ids)) {
          const f = await this.store.filters.get(id);
          if (!f || f.enabled === enabled) continue;
          const change = await skip(async () => (await this.write(f, { enabled })).change);
          if (change) {
            record(change);
            changed++;
          }
        }
      });
      return { changed, filterUndo };
    });
  }

  /** Takes back what `ensure` or `setEnabled` did, newest first; a filter edited since (or gone) is left as it is. Once. */
  undo(filterUndo: number): Promise<void> {
    return this.serial(async () => {
      const changes = this.undos.get(filterUndo);
      if (!changes) return;
      for (const c of [...changes].reverse()) {
        const current = await this.store.filters.get(c.filterId);
        if (!current || !sameFilterState(filterState(current), c.after)) continue;
        if (c.before === null) {
          try {
            // only what it made, unchanged: an edit made between this read and the delete wins (Codex review)
            await this.store.filters.delete(c.filterId, c.after);
          } catch (error) {
            if (!(error instanceof RpcError && error.code === "CANCELLED")) throw error;
          }
        } else {
          try {
            await this.store.filters.save({ id: c.filterId, ...c.before, source: current.source, keepApplications: true, expect: c.after }, this.now());
          } catch (error) {
            // edited between the read and the write: the edit wins, the rest still comes back
            if (!(error instanceof RpcError && error.code === "CANCELLED")) throw error;
          }
        }
      }
      this.undos.delete(filterUndo);
    });
  }
}

/**
 * Plan 128: filters that move mail to a folder follow what happened to it: a new name is the same folder (what it
 * already filed stays claimed), one deleted turns them off (they couldn't file anything, and off tells the user). Each
 * write compares what it read: an edit meanwhile wins. A failure is logged: the folder's own change already happened.
 */
export async function followFolderFilters(store: Pick<MailStore, "filters">, accountId: number, change: { renamed?: readonly { from: string; to: string }[]; deleted?: readonly string[] | "all" }, now: number, warn: (message: string, detail: unknown) => void): Promise<void> {
  if (!change.renamed?.length && !change.deleted?.length) return;
  const moved = new Map(change.renamed?.map((m) => [m.from, m.to]));
  const gone = change.deleted === "all" ? null : new Set(change.deleted);
  for (const f of await store.filters.list()) {
    const action = f.rule.actions.find((a) => a.type === "moveToFolder" && a.accountId === accountId);
    if (action?.type !== "moveToFolder") continue;
    const to = gone === null ? undefined : moved.get(action.folder);
    const deleted = to === undefined && (gone === null || gone.has(action.folder));
    if ((to === undefined || to === action.folder) && (!deleted || !f.enabled)) continue;
    const before = filterState(f);
    const state: FilterState = deleted ? { ...before, enabled: false } : { ...before, rule: { ...f.rule, actions: f.rule.actions.map((a) => (a === action ? { ...action, folder: to! } : a)) } };
    try {
      await store.filters.save({ id: f.id, ...state, source: f.source, keepApplications: true, expect: before }, now);
    } catch (error) {
      if (!(error instanceof RpcError && error.code === "CANCELLED")) warn(`filter ${f.id} didn't follow its folder`, error instanceof Error ? error.message : error);
    }
  }
}
