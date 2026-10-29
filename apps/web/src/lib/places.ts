import { parseSearch, type ThreadSummary, type View } from "@terno/core";

/** Where a row lives (the stores' aggregate: trash wins over spam). */
export function placeOf(t: Pick<ThreadSummary, "inInbox" | "inSpam" | "inTrash">): "inbox" | "archive" | "spam" | "trash" {
  if (t.inTrash) return "trash";
  if (t.inSpam) return "spam";
  return t.inInbox ? "inbox" : "archive";
}

/**
 * Which view's actions fit these rows (plan 64). Outside a search, the
 * sidebar's view. A search looks everywhere, so its rows decide: the place
 * they all share (Restore in Trash, Not spam in Spam, Move to Inbox when
 * archived), "all" for a mix (Archive, Delete, Spam and Move to Inbox).
 * A search that says in:… is that view's.
 */
export function actionView(view: View, query: string, rows: readonly Pick<ThreadSummary, "inInbox" | "inSpam" | "inTrash">[]): View {
  const q = query.trim();
  if (!q) return view;
  const said = parseSearch(q).view;
  if (said && said !== "anywhere") return said;
  if (rows.length === 0 || rows.some((r) => r.inInbox === undefined)) return "all";
  const first = placeOf(rows[0]!);
  return rows.every((r) => placeOf(r) === first) ? first : "all";
}
