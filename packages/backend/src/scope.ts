/**
 * "Select all N": actions over every thread of a view or a search, on the
 * backend. A scope is resolved ONCE into thread ids, so the set is fixed
 * before anything changes it: a view straight from the indexes (ids only,
 * one store call), a search by keyset pages of the same search the
 * renderer shows (≤ 500 rows per store call, a yield between pages). The work
 * then goes through runSliced: one store command per slice, each its own
 * transaction with one provider op per account.
 */
import { listFilterOf, searchWithFilter } from "@terno/core";
import type { ThreadScope } from "@terno/core/rpc";
import { StaleCursorError, type MessageState } from "@terno/store";
import { SliceSizer } from "./slicer";
import type { BackendCore } from "./core";

/** More than this and a scope is refused as capped (a count says "100 000+"). */
export const SCOPE_CAP = 100_000;
const PAGE = 500;

export async function resolveThreadScope(b: BackendCore, scope: ThreadScope, cap = SCOPE_CAP): Promise<{ ids: number[]; capped: boolean }> {
  const ids: number[] = [];
  const { accountId, categoryId } = scope;
  const filter = listFilterOf(scope);
  // one clock for every page: the Waiting filter's window doesn't move under the walk
  const now = b.now();
  if (scope.kind === "view") {
    // keyset pages sized by the time they take (an 18,000-row read in one go is a stall on a busy machine)
    const sizer = new SliceSizer({ targetMs: 15, initial: 500, floor: 100, ceiling: 20_000 });
    for (let after = 0; ids.length <= cap; ) {
      const limit = sizer.size;
      const started = performance.now();
      const page = await b.store.threads.scopeIds({ view: scope.view, accountId, categoryId, filter, now, after, limit });
      sizer.record(Math.max(1, page.length), performance.now() - started);
      for (const id of page) ids.push(id);
      if (page.length < limit) break;
      after = page[page.length - 1]!;
      await b.yieldTurn();
    }
    return { ids: ids.slice(0, cap), capped: ids.length > cap };
  } else {
    // the same query the list ran (threads.search): the quick filter is part of it (attachments: the threads that have them)
    const { query, threadFilter } = filter ? searchWithFilter(scope.query, filter, now) : { query: scope.query, threadFilter: undefined };
    if (query === null) return { ids: [], capped: false };
    // a write landing between pages (sync) invalidates the cursor: start over, a few times
    for (let attempt = 0; ; attempt++) {
      try {
        let cursor: Parameters<BackendCore["store"]["threads"]["searchText"]>[0]["cursor"];
        for (;;) {
          const page = await b.store.threads.searchText({ query, accountId, categoryId, threadFilter, cursor, limit: PAGE, now });
          for (const t of page.items) ids.push(t.id);
          if (!page.nextCursor || ids.length > cap) break;
          cursor = page.nextCursor;
          await b.platform.yield();
        }
        break;
      } catch (error) {
        if (!(error instanceof StaleCursorError) || attempt >= 3) throw error;
        ids.length = 0;
      }
    }
  }
  const unique = [...new Set(ids)];
  return { ids: unique.slice(0, cap), capped: unique.length > cap };
}

/** How many threads a scope holds: a view is counted, a search is resolved. */
export async function countThreadScope(b: BackendCore, scope: ThreadScope, cap = SCOPE_CAP): Promise<{ count: number; capped: boolean }> {
  if (scope.kind === "view") {
    const n = await b.store.threads.scopeCount({ view: scope.view, accountId: scope.accountId, categoryId: scope.categoryId, filter: listFilterOf(scope), now: b.now(), limit: cap + 1 });
    return { count: Math.min(n, cap), capped: n > cap };
  }
  const { ids, capped } = await resolveThreadScope(b, scope, cap);
  return { count: ids.length, capped };
}

/** Progress events for one job: the first and last always, at most every 100 ms in between. */
export function progressReporter(b: BackendCore, jobId: string | undefined, total: number): (done: number) => void {
  let last = 0;
  return (done) => {
    if (!jobId) return;
    const now = performance.now();
    if (done !== 0 && done < total && now - last < 100) return;
    last = now;
    b.server.emit("bulkProgress", { jobId, done, total }, { origins: ["renderer", "dev"] });
  };
}

/**
 * The undo journal of thread actions: each message an action changed, as it
 * was before (read, star, place), in memory (a restart loses the undo, never
 * the action), the last 16 actions.
 */
export class UndoJournal {
  private readonly entries = new Map<number, MessageState[]>();
  private seq = 0;

  remember(before: MessageState[]): number {
    const id = ++this.seq;
    this.entries.set(id, before);
    while (this.entries.size > 16) this.entries.delete(this.entries.keys().next().value as number);
    return id;
  }

  /** One-shot: an undo is taken out of the journal as it starts. */
  take(id: number): MessageState[] | null {
    const e = this.entries.get(id) ?? null;
    this.entries.delete(id);
    return e;
  }
}
