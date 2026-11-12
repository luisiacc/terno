import { t } from "@terno/i18n";
import { announce } from "~/lib/announce";
import { useApp, type AppState } from "~/state/app";
import { useList } from "~/state/list";

/** How many conversations the selection holds: "select all N" counts its whole mailbox. */
const selected = (s: Pick<AppState, "scope" | "checked">) => (s.scope ? s.scope.count : s.checked.size);

/**
 * Plan 188: what the list says when it changes where focus isn't. A mailbox opened from the sidebar (focus stays on its
 * row) says what came, once its first page is committed: how many, or that there are more, or that it's empty. The
 * selection says its size whenever it grows or shrinks, whatever changed it (x, ⇧J, * a, a click, Select all).
 */
export function installListSpeech(): () => void {
  /** the list a sidebar row asked for: said once it's in (a later list replaces it) */
  const waiting: { key: string | null } = { key: null };
  const offList = useList.subscribe((l, prev) => {
    if (l.key !== prev.key) waiting.key = document.activeElement?.closest("#app-sidebar") ? l.key : null;
    if (!waiting.key || l.loading || l.itemsKey !== waiting.key) return;
    waiting.key = null;
    const mailbox = document.querySelector("#app-list h1")?.textContent?.trim() ?? "";
    const count = l.items.length;
    announce(count === 0 ? t("list.announce.empty", { mailbox }) : l.nextCursor ? t("list.announce.more", { mailbox, count }) : t("list.announce.all", { mailbox, count }));
  });
  const offApp = useApp.subscribe((s, prev) => {
    if (s.checked === prev.checked && s.scope === prev.scope) return;
    const n = selected(s), was = selected(prev);
    if (n === was) return;
    // (cleared: said too, Codex review: the cursor's row still reads as selected, so nothing else says it)
    announce(n > 0 ? t("list.announce.selected", { count: n }) : t("list.announce.selectionCleared"));
  });
  return () => {
    offList();
    offApp();
  };
}
