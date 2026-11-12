import { dockCameFrom, focusDock, inDock } from "~/components/snack-dock";
import { focusRows, skipToList } from "~/components/thread-list";
import { useList } from "~/state/list";
import { useSnack } from "~/lib/snack";

/**
 * Plan 188: F6 and ⇧F6 move between the app's panes, as in Mail and every desktop app: the sidebar, the conversation list,
 * the main pane (the conversation, or what's written there), and the snack dock while a snack is up. A snack that's up is
 * F6's first stop, once (what it was before: the dock never takes focus by itself); from the dock, F6 goes on from the pane
 * focus came from. A pane that isn't on screen (List's covered list, an empty main) is passed over.
 */
type Pane = "sidebar" | "list" | "main" | "dock";
const ORDER: readonly Pane[] = ["sidebar", "list", "main", "dock"];

/** The snack F6 already took focus to: it isn't the first stop again (else F6 would never leave it). */
const visited: { seq: number | undefined } = { seq: undefined };

const listSection = () => document.querySelector<HTMLElement>("[data-list-section]");
/** The main pane's element: Split's <main>, List's page over the list (List's list itself is the list pane). */
const mainPane = () => document.querySelector<HTMLElement>("main, [data-testid=list-page]");

function paneOf(el: Element | null): Pane | null {
  if (!el || el === document.body) return null;
  if (inDock(el)) return "dock";
  if (el.closest("#app-sidebar")) return "sidebar";
  if (el.closest("[data-list-section]")) return "list";
  if (mainPane()?.contains(el)) return "main";
  return null;
}

const shown = (el: HTMLElement | null): el is HTMLElement => !!el && el.getClientRects().length > 0 && !el.closest("[inert]");

function focusIn(pane: Pane): boolean {
  const before = document.activeElement;
  switch (pane) {
    case "sidebar": {
      const side = document.getElementById("app-sidebar");
      if (!shown(side)) return false;
      const current = side.querySelector<HTMLElement>("[aria-current=page]");
      (shown(current) ? current : side.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
      break;
    }
    case "list": {
      const section = listSection();
      if (!shown(section) || section.hasAttribute("data-covered")) return false;
      if (useList.getState().items.length) focusRows();
      else skipToList();
      break;
    }
    case "main": {
      const main = mainPane();
      if (!shown(main)) return false;
      // the conversation (named by its subject), else the first thing to work with that's on screen and not under
      // something (a new message's first field; the full message's Back, over the inert conversation: Codex review)
      const reader = main.querySelector<HTMLElement>("[data-testid=reader][tabindex]");
      const target = shown(reader) ? reader : [...main.querySelectorAll<HTMLElement>("input:not([type=hidden]):not(:disabled), [contenteditable=true], button:not(:disabled), [tabindex='-1'][aria-labelledby]")].find(shown) ?? [...main.querySelectorAll<HTMLElement>(":is(h1, h2)[tabindex]")].find(shown);
      if (!target) return false;
      target.focus({ preventScroll: true });
      break;
    }
    case "dock":
      if (!focusDock()) return false;
      visited.seq = useSnack.getState().current?.seq;
      return true;
  }
  return document.activeElement !== before && paneOf(document.activeElement) === pane;
}

/** F6 (1) and ⇧F6 (−1). Whether focus moved: when nothing did, the key is left alone (the browser's own F6, on the web). */
export function movePane(step: 1 | -1): boolean {
  const active = document.activeElement;
  // a dialog, a menu or a popover holds the keyboard: its own Tab order, never a pane under it
  if (active?.closest("[role=dialog], [role=alertdialog], [role=menu]")) return false;
  const here = paneOf(active);
  const snack = useSnack.getState().current;
  if (step === 1 && here !== "dock" && snack && visited.seq !== snack.seq && focusIn("dock")) return true;
  // F6 from the dock goes on from where focus came from; ⇧F6 is the plain reverse (Codex review)
  const from = here === "dock" && step === 1 ? (paneOf(dockCameFrom()) ?? "main") : here;
  const start = from === null ? (step === 1 ? -1 : 0) : ORDER.indexOf(from);
  for (let i = 1; i <= ORDER.length; i++) {
    const pane = ORDER[(start + step * i + ORDER.length * 2) % ORDER.length]!;
    if (pane === here) continue;
    if (focusIn(pane)) return true;
  }
  return false;
}
