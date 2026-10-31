/**
 * Plan 63: the filters "similar" actions create (Spam similar always; Archive
 * and Delete when the user says Always). One at a time, so two applies never
 * make two filters; Undo takes back only what it did, and only while the
 * filter is still exactly that.
 */
import { capFilterName, LEARNED_FILTER_NAME, sameRule, similarLearnedKey, similarRule, similarValue, type Filter, type FilterRule, type SimilarAction, type SimilarScope } from "@terno/core";
import { L } from "@terno/i18n";
import type { MailStore } from "@terno/store";

interface FilterUndo {
  filterId: number;
  /** created: Undo deletes it; enabled: Undo disables it again */
  change: "created" | "enabled";
  /** the filter as this left it: an edit since then keeps it */
  snapshot: string;
}

const snapshotOf = (f: Filter) => JSON.stringify({ name: f.name, enabled: f.enabled, rule: f.rule });
/** the last few, like the thread undo journal */
const KEEP = 16;

export class SimilarFilters {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly undos = new Map<number, FilterUndo>();
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

  private remember(u: FilterUndo): number {
    const id = ++this.seq;
    this.undos.set(id, u);
    while (this.undos.size > KEEP) this.undos.delete(this.undos.keys().next().value as number);
    return id;
  }

  /** The scope's filter, enabled: an identical one is reused (a disabled one enabled), else a new one. `filterUndo` is null when nothing changed. */
  ensure(scope: SimilarScope, action: SimilarAction, name?: string): Promise<{ filter: Filter; filterUndo: number | null }> {
    const key = similarLearnedKey(scope, action);
    // the learned banner won't propose what this already does (a subject rule covers less: no key)
    return this.ensureRule(similarRule(scope, action), name ?? L(LEARNED_FILTER_NAME[action], { value: similarValue(scope) }).message, key ?? undefined);
  }

  /** Plan 80: any rule, the same way (identical reused, a disabled one enabled, else created). */
  ensureRule(rule: FilterRule, name: string, learnedKey?: string): Promise<{ filter: Filter; filterUndo: number | null }> {
    return this.serial(async () => {
      const same = (await this.store.filters.list()).filter((f) => sameRule(f.rule, rule));
      const on = same.find((f) => f.enabled);
      if (on) return { filter: on, filterUndo: null };
      const off = same[0];
      if (off) {
        const filter = await this.store.filters.save({ id: off.id, name: off.name, enabled: true, source: off.source, rule: off.rule }, this.now());
        return { filter, filterUndo: this.remember({ filterId: filter.id, change: "enabled", snapshot: snapshotOf(filter) }) };
      }
      const filter = await this.store.filters.save(
        { name: capFilterName(name), enabled: true, source: "manual", rule, learnedKey },
        this.now(),
      );
      return { filter, filterUndo: this.remember({ filterId: filter.id, change: "created", snapshot: snapshotOf(filter) }) };
    });
  }

  /** Takes back what `ensure` did; a filter edited since (or gone) is left as it is. Once. */
  undo(filterUndo: number): Promise<void> {
    return this.serial(async () => {
      const u = this.undos.get(filterUndo);
      if (!u) return;
      const current = await this.store.filters.get(u.filterId);
      if (current && snapshotOf(current) === u.snapshot) {
        if (u.change === "created") await this.store.filters.delete(u.filterId);
        else await this.store.filters.save({ id: current.id, name: current.name, enabled: false, source: current.source, rule: current.rule }, this.now());
      }
      this.undos.delete(filterUndo);
    });
  }
}
