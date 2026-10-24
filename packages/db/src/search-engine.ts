import type { ThreadSummary } from "@terno/core";
import { StaleCursorError, type Revision, type SearchCursor, type SearchEngine, type SearchIdsPage, type SearchRequest } from "@terno/store";
import { SUMMARY_COLUMNS, toSummary, type SummaryRow } from "./queries";
import { runSearch, type SearchStrategy } from "./search";
import type { Db } from "./sqlite";

export interface FusedSearchPage {
  items: ThreadSummary[];
  nextCursor: SearchCursor | null;
  strategy: SearchStrategy;
}

/**
 * The FTS5 planner (search.ts) behind the SearchEngine seam. Always exact and
 * current: it reads the same transaction-consistent tables it is asked about.
 */
export class Fts5SearchEngine implements SearchEngine {
  readonly id = "fts5";

  constructor(private readonly db: Db) {}

  async query(req: SearchRequest, at: Revision): Promise<SearchIdsPage> {
    const { rows, strategy } = this.run<{ id: number; last_date: number }>(req, at, "t.id, t.last_date");
    const { kept, nextCursor } = paged(rows, req, at, (r) => ({ lastDate: r.last_date, id: r.id }));
    return { threadIds: kept.map((r) => r.id), nextCursor, revision: at, strategy };
  }

  /** The same plan with the summary columns in the same statement: the store's search path. */
  page(req: SearchRequest, at: Revision): FusedSearchPage {
    const { rows, strategy } = this.run<SummaryRow>(req, at, SUMMARY_COLUMNS);
    const { kept, nextCursor } = paged(rows, req, at, (r) => ({ lastDate: r.last_date, id: r.id }));
    return { items: kept.map(toSummary), nextCursor, strategy };
  }

  private run<R>(req: SearchRequest, at: Revision, columns: string) {
    const c = req.cursor;
    if (c) {
      if (c.queryKey !== req.search.key) throw new StaleCursorError("query");
      if (c.revision.epoch !== at.epoch) throw new StaleCursorError("epoch");
      if (c.revision.seq !== at.seq) throw new StaleCursorError("revision");
    }
    return runSearch<R>(this.db, req.search, c, columns, req.limit + 1);
  }
}

function paged<R>(rows: R[], req: SearchRequest, at: Revision, key: (r: R) => { lastDate: number; id: number }) {
  const hasMore = rows.length > req.limit;
  const kept = hasMore ? rows.slice(0, req.limit) : rows;
  const last = kept[kept.length - 1];
  const nextCursor: SearchCursor | null = hasMore && last ? { revision: at, queryKey: req.search.key, ...key(last) } : null;
  return { kept, nextCursor };
}
