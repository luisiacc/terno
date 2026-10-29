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

type Placed = Pick<ThreadSummary, "id" | "inInbox" | "inSpam" | "inTrash">;

/**
 * A search's selection can span places: each action is offered for the rows
 * it fits, and acts on those only (Restore the trashed ones, Not spam the
 * spam, Archive what's in the Inbox…). Null when a row's place is unknown
 * (an older backend): the view's actions then.
 */
export function placeActions(rows: readonly Placed[]): { archive: number[]; trash: number[]; spam: number[]; notSpam: number[]; toInbox: number[]; restoreOnly: boolean } | null {
  if (rows.length === 0 || rows.some((r) => r.inInbox === undefined)) return null;
  const by = (keep: (p: ReturnType<typeof placeOf>) => boolean) => rows.filter((r) => keep(placeOf(r))).map((r) => r.id);
  const toInbox = by((p) => p === "archive" || p === "trash");
  return {
    archive: by((p) => p === "inbox"),
    trash: by((p) => p !== "trash"),
    spam: by((p) => p === "inbox" || p === "archive"),
    notSpam: by((p) => p === "spam"),
    toInbox,
    restoreOnly: toInbox.length > 0 && by((p) => p === "trash").length === toInbox.length,
  };
}
