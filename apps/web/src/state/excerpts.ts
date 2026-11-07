import { rowExplains, type RowMatch, type ThreadSummary } from "@terno/core";
import { create } from "zustand";
import { client } from "~/rpc/connection";

/**
 * Plan 158: the sentence a result matched in, for the rows on screen whose own words don't show why they're there. Asked
 * for after the search answered, a few at a time, one ask at a time, and only once a row; the row keeps its own line
 * until it comes, or if nothing does.
 */
export const useExcerpts = create<{ match: RowMatch | null; byThread: ReadonlyMap<number, string> }>(() => ({ match: null, byThread: new Map() }));

const SETTLE_MS = 120;
/** the most the backend takes at once (threads.excerpts) */
const ASK_MAX = 10;

const work: { query: string; asked: Set<number>; wanted: number[]; timer: ReturnType<typeof setTimeout> | null; busy: boolean } = { query: "", asked: new Set(), wanted: [], timer: null, busy: false };

function ask(match: RowMatch): void {
  work.timer = null;
  if (work.busy || useExcerpts.getState().match !== match) return;
  const threadIds = work.wanted.slice(0, ASK_MAX);
  work.wanted = work.wanted.slice(ASK_MAX);
  if (!threadIds.length) return;
  const { query } = work;
  for (const id of threadIds) work.asked.add(id);
  work.busy = true;
  void client.call("threads.excerpts", { query, threadIds }).then(
    ({ excerpts }) => {
      const s = useExcerpts.getState();
      if (s.match === match && excerpts.length) useExcerpts.setState({ byThread: new Map([...s.byThread, ...excerpts.map((e) => [e.threadId, e.text] as const)]) });
    },
    // nothing lost: the row keeps its own line
    () => {},
  ).finally(() => {
    work.busy = false;
    ask(useExcerpts.getState().match ?? match);
  });
}

/** The rows on screen now, for this search (null: no search, and what was kept goes). */
export function wantExcerpts(query: string, match: RowMatch | null, rows: readonly ThreadSummary[]): void {
  if (useExcerpts.getState().match !== match) {
    if (work.timer) clearTimeout(work.timer);
    work.timer = null;
    work.wanted = [];
    work.asked = new Set();
    work.query = query;
    useExcerpts.setState({ match, byThread: new Map() });
  }
  if (!match) return;
  // Spam and Trash aren't read for this: their rows keep their own line
  work.wanted = rows.filter((t) => !work.asked.has(t.id) && !t.inSpam && !t.inTrash && !rowExplains(match, [t.fromName, t.subject, t.snippet])).map((t) => t.id);
  if (work.timer) clearTimeout(work.timer);
  work.timer = work.wanted.length ? setTimeout(() => ask(match), SETTLE_MS) : null;
}
