/**
 * Plan 63: the filters "similar" actions create (Spam similar always; Archive
 * and Delete when the user says Always). One at a time, so two applies never
 * make two filters; Undo takes back only what it did, and only while the
 * filter is still exactly that.
 *
 * Plan 85: they're Terno's (`auto`). One for the same mail filing elsewhere is
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
  /** plan 85: the same mail's automatic filter filed into this category before */
  retargeted: { from: number } | null;
}

/** The category an addCategory-only rule files into. */
const targetOf = (rule: FilterRule): number | null => (rule.actions.length === 1 && rule.actions[0]!.type === "addCategory" ? rule.actions[0]!.categoryId : null);
/** The same conditions (what mail), whatever it does with it. */
const sameMail = (a: FilterRule, b: FilterRule) => sameRule({ ...a, actions: [] }, { ...b, actions: [] });
/** A sender-wide rule's address: one `from equals` and nothing else. */
const senderOf = (rule: FilterRule): string | null => {
  const [c, ...rest] = rule.conditions;
  return rest.length === 0 && c?.field === "from" && c.op === "equals" && !c.negate ? c.value.trim().toLowerCase() : null;
};
/** A sender + subject rule's address. */
const subjectSenderOf = (rule: FilterRule): string | null => {
  if (rule.conditions.length !== 2) return null;
  const from = rule.conditions.find((c) => c.field === "from" && c.op === "equals" && !c.negate);
  const subject = rule.conditions.find((c) => c.field === "subject" && !c.negate);
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

  /** Plan 80: any rule, the same way; plan 85: an automatic category filter for the same mail elsewhere moves here instead. */
  ensureRule(rule: FilterRule, name: string, learnedKey?: string): Promise<Ensured> {
    return this.serial(async () => {
      const all = await this.store.filters.list();
      const same = all.filter((f) => sameRule(f.rule, rule));
      // anyone's identical filter, on, is already doing it: reused, never changed
      const on = same.find((f) => f.enabled);
      if (on) return { filter: on, filterUndo: null, retargeted: null };
      const changes: Change[] = [];
      let filter: Filter;
      let retargeted: { from: number } | null = null;
      // a disabled one is turned back on only if it's Terno's: the user turned theirs off
      const off = same.find((f) => f.auto);
      const target = targetOf(rule);
      const elsewhere = target === null ? [] : all.filter((f) => f.auto && sameMail(f.rule, rule) && targetOf(f.rule) !== null && targetOf(f.rule) !== target).sort((a, b) => b.id - a.id);
      if (off) {
        const w = await this.write(off, { enabled: true });
        filter = w.filter;
        changes.push(w.change);
      } else if (elsewhere[0]) {
        // the same mail filed elsewhere before: it files here now (old mail isn't re-filed: its claims stay)
        const from = targetOf(elsewhere[0].rule)!;
        const w = await this.write(elsewhere[0], { rule, name: capFilterName(name), enabled: true }, true);
        filter = w.filter;
        changes.push(w.change);
        retargeted = { from };
      } else {
        filter = await this.store.filters.save({ name: capFilterName(name), enabled: true, source: "manual", auto: true, rule, learnedKey }, this.now());
        changes.push({ filterId: filter.id, before: null, after: filterState(filter) });
      }
      // a sender's mail filed here: their automatic subject filters filing elsewhere would split it (plan 86 R9)
      const sender = target === null ? null : senderOf(rule);
      if (sender) {
        for (const f of all) {
          if (!f.auto || !f.enabled || f.id === filter.id || subjectSenderOf(f.rule) !== sender) continue;
          const to = targetOf(f.rule);
          if (to === null || to === target) continue;
          changes.push((await this.write(f, { enabled: false })).change);
        }
      }
      return { filter, filterUndo: this.remember(changes), retargeted };
    });
  }

  /** Plan 85: filters on or off at once ("Stop filing…", "Turn all off"), each only if unchanged since it was read; one Undo. */
  setEnabled(ids: readonly number[], enabled: boolean): Promise<{ changed: number; filterUndo: number | null }> {
    return this.serial(async () => {
      const changes: Change[] = [];
      for (const id of new Set(ids)) {
        const f = await this.store.filters.get(id);
        if (!f || f.enabled === enabled) continue;
        changes.push((await this.write(f, { enabled })).change);
      }
      return { changed: changes.length, filterUndo: this.remember(changes) };
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
        if (c.before === null) await this.store.filters.delete(c.filterId);
        else {
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
