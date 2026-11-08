/**
 * The list pane's title types, by the header's kind (plan 158). Plan 160: List's selection toolbar, which stands on the
 * header's line, names the selection in the same type, so the two share a baseline.
 */
export type ListTitleKind = "title" | "display" | "greeting";

export const LIST_TITLE: Record<ListTitleKind, string> = {
  title: "text-md font-semibold tracking-tight",
  display: "type-list-title",
  greeting: "type-greeting",
};
