import { t } from "@terno/i18n";
import { focusDraft, openStoredDraft, supersedeCompose } from "~/lib/compose";
import { authored, draftEditsHeld, draftPresentationThread, flushDraft, forgetDraft, setDraftUi, useDrafts } from "~/lib/drafts";
import { useAppearance } from "~/lib/appearance";
import { pageOf } from "~/lib/page";
import { snack } from "~/lib/snack";
import { focusPinned, pinnedKey, pinning, usePinned } from "~/lib/pinned-draft-state";
import { getApp, setApp } from "~/state/app";
import { useDraftRecovery } from "~/lib/draft-recovery-ui";

let stopWatch: (() => void) | null = null;

function clear(): void {
  stopWatch?.();
  stopWatch = null;
  usePinned.setState({ key: null, threadId: null, inset: 0 });
}

/**
 * Pins a draft: the very same draft (its key, its editor state) moves to the
 * card. A new message leaves the reader pane, which shows what it showed
 * before. Another pinned draft is put away first.
 */
export function pinDraft(key: string): boolean {
  const d = useDrafts.getState().drafts[key];
  // Review drafts owns every draft while it is open (its own slot, its own checkpoints)
  if (!d || d.sending || draftEditsHeld() || useDraftRecovery.getState().open) return false;
  const current = usePinned.getState().key;
  if (current === key) { focusPinned(); return true; }
  if (current) unpinDraft(current, { focus: false });
  // an open still waiting to focus this draft's slot would land in a form that is gone
  supersedeCompose();
  const app = getApp();
  if (app.compose?.key === key) setApp({ compose: null });
  if (app.draftFocus?.key === key) setApp({ draftFocus: null });
  if (d.uiState !== "open") setDraftUi(key, "open");
  usePinned.setState((s) => ({ key, threadId: d.mode === "new" ? null : draftPresentationThread(d), focus: s.focus + 1 }));
  // the draft gone (sent, discarded, scheduled, forgotten): the card goes with it
  const stopDrafts = useDrafts.subscribe((state) => { if (!state.drafts[key]) clear(); });
  // Review drafts takes the window: the card lets go (the draft stays where it lives), so recovery's slot shows the editor
  const stopRecovery = useDraftRecovery.subscribe((state) => { if (state.open) clear(); });
  stopWatch = () => { stopDrafts(); stopRecovery(); };
  return true;
}

pinning.pin = pinDraft;

/** Is the draft's own conversation the one on screen? */
function onScreen(threadId: number | null): boolean {
  const app = getApp();
  if (threadId === null || app.selectedId !== threadId || app.compose || app.scope !== null || app.checked.size >= 2) return false;
  // List shows it only on its page; Split's reader always shows the selected conversation
  return useAppearance.getState().layout !== "list" || pageOf(app) === "thread";
}

/** Focus goes back to where reading happens (List's page, else the list); `left` only when the card took it away with it. */
export function focusReading(left = true): void {
  const active = document.activeElement;
  if (left && active && active !== document.body && active.isConnected) return;
  // List's page (a conversation, or a new message being written over the list); else the list, if it can take focus
  const page = document.querySelector<HTMLElement>("[data-testid=list-page] [data-testid=reader]") ?? document.querySelector<HTMLElement>("[data-testid=list-page] [data-testid=compose-to]");
  const list = document.querySelector<HTMLElement>("[data-testid=thread-list] [data-keep-scroll=list]");
  const target = page ?? (list && !list.closest("[inert]") ? list : null);
  if (target) target.focus({ preventScroll: true });
  else if (active instanceof HTMLElement && active.closest("[data-testid=pinned-draft]")) active.blur();
}

/**
 * Unpins a draft. Its conversation on screen: it drops back there, open and
 * focused. Elsewhere: what was written is saved and put away (collapsed into
 * its conversation, or in the strip), and a snack says so and offers to open
 * it; an untouched new message just goes, as Esc on one does.
 */
export function unpinDraft(key: string | null = pinnedKey(), { focus = true }: { focus?: boolean } = {}): void {
  if (!key || usePinned.getState().key !== key) return;
  const from = usePinned.getState().threadId;
  clear();
  const d = useDrafts.getState().drafts[key];
  if (!d) return;
  if (d.mode !== "new" && onScreen(from)) {
    // its placement there may have expired while it was pinned (another conversation read): the strip's own open checks it again
    if (draftPresentationThread(d) !== from) { void openStoredDraft(key); return; }
    setApp({ draftShown: { threadId: from!, key } });
    if (focus) focusDraft(key, "body");
    return;
  }
  if (focus) queueMicrotask(focusReading);
  if (!authored(d)) {
    if (d.mode === "new") forgetDraft(key);
    return;
  }
  if (d.mode !== "new") setDraftUi(key, "collapsed");
  // after the dock has given focus back (the action's own click): an open gives up on any focus move under it
  const open = { label: t("compose.openDraft"), name: t("compose.openSavedDraft"), onClick: () => void setTimeout(() => void openStoredDraft(key)) };
  void flushDraft(key).then(() => {
    const now = useDrafts.getState().drafts[key];
    if (!now) return;
    // only an acknowledged save is "saved"; anything else says the work is kept, and where (its own Retry is there)
    if (now.status === "saved" && !now.recovery) snack(t("compose.savedAway"), { action: open });
    else snack.warning(t("compose.keptAway"), { action: open });
  });
}
