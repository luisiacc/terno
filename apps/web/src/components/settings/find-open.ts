import { useAiDraftUi } from "~/lib/ai-draft-state";
import { closeSnippetEditor } from "~/lib/snippet-editor-state";
import { getApp, setApp, useApp } from "~/state/app";
import type { FindTarget } from "./search-index";
import { leaveStyleEditors } from "./writing-style";

/**
 * Plan 203: opening a search result. The section (and page) changes, then the setting is waited for as it mounts (a
 * MutationObserver on the pane, no polling): a scoped one opens its account's or category's disclosure first. One that
 * doesn't come (its switch is off, drafting is off, the provider doesn't use it) gives way to the row that shows it,
 * then to its scope. Found, it scrolls into view, is marked for a moment, and its control takes focus.
 */

/** how long a setting is waited for before its fallback is shown */
const WAIT_MS = 1500;
/** how long it stays marked as found */
const MARK_MS = 1600;
/** a disclosure just opened grows within the motion cap (≤ 100 ms): the row is measured after it has */
const GROW_MS = 120;

/** what the current open is waiting for and the mark it left: a newer open ends both */
let cancel: (() => void) | null = null;
let marked: { el: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;

/** The first control in a setting that takes focus (itself, when it's a control). */
const CONTROL = "button, input, textarea, select, [role=switch], [role=radio][tabindex='0'], [role=combobox], [tabindex='0']";
function controlOf(el: HTMLElement): HTMLElement | null {
  const usable = (c: HTMLElement) => !c.matches(":disabled, [aria-disabled=true], [tabindex='-1']") && c.getClientRects().length > 0;
  if (el.matches(CONTROL) && usable(el)) return el;
  return [...el.querySelectorAll<HTMLElement>(CONTROL)].find(usable) ?? null;
}

function unmark() {
  if (!marked) return;
  clearTimeout(marked.timer);
  marked.el.removeAttribute("data-found");
  marked = null;
}

/**
 * Only a row (or a single control) is tinted: a whole group's tint read as a slab over the section's top (owner's call,
 * 2026-11-12: "lets not do that for any page"), as did an account's or category's disclosure standing in for a row.
 */
const tinted = (el: HTMLElement) => el.hasAttribute("data-setting") && el.tagName !== "SECTION";

/**
 * Scrolls to a setting and focuses its control; a row is marked for a moment (a tint that fades out, globals.css
 * `[data-found]`), a group just comes into view from its top.
 */
function reveal(el: HTMLElement) {
  unmark();
  if (!tinted(el)) {
    el.scrollIntoView({ block: "start", behavior: "instant" });
    controlOf(el)?.focus({ preventScroll: true });
    return;
  }
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.setAttribute("data-found", "on");
  const timer = setTimeout(() => {
    // the tint fades out (none when motion is off), then the mark goes
    el.setAttribute("data-found", "off");
    if (marked) marked.timer = setTimeout(unmark, 200);
  }, MARK_MS);
  marked = { el, timer };
  // a disabled control (Undo send's window while Undo send is off) leaves focus in the search field
  controlOf(el)?.focus({ preventScroll: true });
}

const pane = () => document.querySelector<HTMLElement>("[data-testid=settings-scroller]");
const scopeOf = (root: ParentNode, target: FindTarget) => (target.scope ? root.querySelector<HTMLElement>(`[data-setting-scope="${target.scope.kind}:${target.scope.id}"]`) : null);
/** a setting in an element, or the element itself (a row that is its own scope) */
const settingIn = (root: HTMLElement, id: string) => (root.matches(`[data-setting="${id}"]`) ? root : root.querySelector<HTMLElement>(`[data-setting="${id}"]`));
/** in a group still loading (drafting's preferences), a row may be about to go: it isn't found yet */
const settled = (el: HTMLElement | null) => (el && !el.closest("[aria-busy=true]") ? el : null);

/** Waits for the target in the pane, opening its disclosure on the way; the fallback when it doesn't come. */
function seek(target: FindTarget) {
  let opened = false;
  let done = false;
  const finish = (el: HTMLElement | null) => {
    if (done) return;
    done = true;
    stop();
    if (!el) return void pane()?.scrollTo({ top: 0 });
    // (gone in the meantime, as Settings closed: nothing to show)
    if (opened) setTimeout(() => el.isConnected && reveal(el), GROW_MS);
    else reveal(el);
  };
  const look = () => {
    const root = pane();
    if (!root) return;
    const scope = scopeOf(root, target);
    if (target.scope && !scope) return;
    const opener = scope?.querySelector<HTMLElement>("[data-setting-open]");
    // the switch for the scoped one (Auto-add) is on the item's own line: no need to open it
    const found = settled(settingIn(scope ?? root, target.id));
    if (found) return finish(found);
    if (opener && opener.getAttribute("aria-expanded") === "false" && !opened) {
      opened = true;
      opener.click();
    }
  };
  const observer = new MutationObserver(look);
  const timer = setTimeout(() => {
    const root = pane();
    if (!root) return finish(null);
    const scope = scopeOf(root, target);
    const within = scope ?? root;
    finish((target.under && settingIn(within, target.under)) || scope?.querySelector<HTMLElement>("[data-setting-open]") || scope || null);
  }, WAIT_MS);
  // the person went elsewhere (another section, the page, Settings closed) before it came: it no longer opens
  const style = target.tab === "ai" && target.page === "style";
  const leftApp = useApp.subscribe((s) => (s.settingsTab !== target.tab || s.dialog !== "settings") && cancel?.());
  const leftPage = useAiDraftUi.subscribe((s) => target.tab === "ai" && s.stylePage !== style && cancel?.());
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
    leftApp();
    leftPage();
  };
  cancel = () => {
    done = true;
    stop();
  };
  const root = pane();
  // a loading group's aria-busy going is a change too
  if (root) observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy"] });
  look();
}

/** Opens a result: its section and page, then the setting itself. */
export function openFound(target: FindTarget) {
  cancel?.();
  cancel = null;
  const style = target.tab === "ai" && target.page === "style";
  const go = () => {
    setApp({ settingsTab: target.tab });
    if (target.tab === "ai") useAiDraftUi.setState({ stylePage: style });
    // a snippet open in its editor covers the list (its edits are saved as the editor goes, as when Settings closes)
    if (target.tab === "snippets") closeSnippetEditor();
    seek(target);
  };
  // leaving Writing style asks first when a profile there has changes (its back button does the same)
  const onStylePage = getApp().settingsTab === "ai" && useAiDraftUi.getState().stylePage;
  if (onStylePage && !style) leaveStyleEditors(go);
  else go();
}

/** Settings closed: nothing waits and nothing stays marked. */
export function endFind() {
  cancel?.();
  cancel = null;
  unmark();
}
