import { t } from "@terno/i18n";
import type { ScheduledInfo, ScheduledSnapshot } from "@terno/core/rpc";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { forgetScheduledDrafts, loadDrafts, scheduledDrafts, useDrafts } from "~/lib/drafts";
import { reminderWhen } from "~/lib/when";
import { registerUndo, snack } from "~/lib/snack";
import { pinnedKey, pinning } from "~/lib/pinned-draft-state";
import { getApp, getSelectionWriteRevision, setApp, useApp } from "~/state/app";
import { openStoredDraft } from "~/lib/compose";
import { playSendSound, primeSendSound } from "~/lib/sounds";
import { heldById, settleHeld } from "~/lib/held-sends";

/**
 * Plan 94: the scheduled sends as the windows see them (the backend's
 * snapshot: at startup and on its `scheduled` event), and what the UI does
 * with them: a new time, Send now, and Edit (a draft again, opened).
 */

interface ScheduledState {
  items: readonly ScheduledInfo[];
  byDraft: ReadonlyMap<number, ScheduledInfo>;
}

export const useScheduled = create<ScheduledState>(() => ({ items: [], byDraft: new Map() }));

scheduledDrafts.has = (id) => useScheduled.getState().byDraft.has(id);

/** failures already said in this window (the ack may not have landed yet) */
const said = new Set<string>();

export function applyScheduled(snapshot: ScheduledSnapshot): void {
  const before = useScheduled.getState().byDraft;
  const byDraft = new Map(snapshot.items.map((s) => [s.draftId, s]));
  useScheduled.setState({ items: snapshot.items, byDraft });
  // unscheduled (in any window) or given back: a draft again here too. Its `drafts` event may have come first,
  // while the id was still excluded from hydration; a sent one is simply not there to load
  if ([...before.keys()].some((id) => !byDraft.has(id))) void loadDrafts().catch(() => {});
  // scheduled in another window: it leaves this one's composers (its edits, if any, win instead)
  const compose = getApp().compose?.key;
  const gone = forgetScheduledDrafts();
  if (compose && gone.includes(compose)) setApp({ compose: null });
  // plan 182: a hold that couldn't go is a listed send now, or a draft again: nothing is coming for its card
  for (const id of [...byDraft.keys(), ...snapshot.failed.map((f) => f.draftId)]) if (heldById(id)) settleHeld(id);
  const fresh = snapshot.failed.filter((f) => !said.has(f.id));
  if (fresh.length === 0) return;
  for (const f of fresh) {
    said.add(f.id);
    snack.error(t("sendLater.failed", { subject: f.subject || t("compose.untitled") }), {
      description: f.message,
      duration: 12_000,
      action: { label: t("sendLater.openDraft"), name: t("sendLater.openDraft"), onClick: () => void openDraftById(f.draftId) },
    });
  }
  void client.call("scheduled.ackFailed", { ids: fresh.map((f) => f.id) }).catch(() => {});
}

export async function loadScheduled(): Promise<void> {
  applyScheduled(await client.call("scheduled.list", {}));
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Where the user is when an Undo or Edit begins: the backend's answer and the draft's loading take a moment, and if
 * they've opened, pinned or started writing something else by then, that's theirs; the draft comes back without taking
 * its place (Codex series review). Focus is read at the end, not followed: the snack gives it back as it goes.
 */
function ownership(): { current(): boolean; stop(): void } {
  const app = getApp(), revision = getSelectionWriteRevision(), pinned = pinnedKey();
  const active = typeof document === "undefined" ? null : document.activeElement;
  let moved = false;
  const stop = useApp.subscribe((state) => { if (state.compose !== app.compose || state.dialog !== app.dialog) moved = true; });
  const writing = () => {
    const now = typeof document === "undefined" ? null : document.activeElement;
    return Boolean(now && now !== active && now.closest("input, textarea, select, [contenteditable=true], [role=dialog], [data-draft-key], [data-recipient-field]"));
  };
  return { current: () => !moved && getSelectionWriteRevision() === revision && pinnedKey() === pinned && !writing(), stop };
}

/** A draft back from the backend (unscheduled, given back), opened in the composer: unless the user has moved on since `owner` began. */
async function openDraftById(draftId: number, pinned = false, owner?: ReturnType<typeof ownership>): Promise<void> {
  try {
    await loadDrafts();
    const d = Object.values(useDrafts.getState().drafts).find((x) => x.id === draftId);
    if (!d) return;
    if (owner && !owner.current()) {
      snack(t("compose.undoSendKept"));
      return;
    }
    owner?.stop();
    // sent from the pinned card: back on the card, with the reader left where it is
    if (pinned && pinning.pin(d.key)) return;
    await openStoredDraft(d.key);
  } finally {
    owner?.stop();
  }
}

/** Not scheduled anymore: a draft again, opened to edit (Undo of a schedule, "Edit message"). */
export async function editScheduled(draftId: number): Promise<boolean> {
  const owner = ownership();
  try {
    await client.call("scheduled.cancel", { draftId });
  } catch (error) {
    owner.stop();
    snack.error(t("sendLater.editFailed"), { description: errorText(error) });
    return false;
  }
  // the snapshot may come after this: the hydration mustn't wait for it to know it's a draft again
  const byDraft = new Map(useScheduled.getState().byDraft);
  byDraft.delete(draftId);
  useScheduled.setState({ items: [...byDraft.values()], byDraft });
  await openDraftById(draftId, false, owner);
  return true;
}

/** A new moment (Send now: this one); a snack says when, with Undo back to the one before. */
export async function rescheduleScheduled(draftId: number, sendAt: number, now = false): Promise<void> {
  const before = useScheduled.getState().byDraft.get(draftId)?.sendAt;
  if (now) primeSendSound();
  try {
    await client.call("scheduled.reschedule", { draftId, sendAt });
  } catch (error) {
    snack.error(t("sendLater.rescheduleFailed"), { description: errorText(error) });
    return;
  }
  if (now) {
    // plan 170 (Codex critique #4): Send now is a send
    playSendSound();
    sendingSnack();
    return;
  }
  const undo = before === undefined ? undefined : registerUndo(() => client.call("scheduled.reschedule", { draftId, sendAt: before }).then(() => undefined));
  snack.success(t("sendLater.scheduled", { when: reminderWhen(sendAt) }), undo && { action: { label: t("common.undo"), name: t("sendLater.undoReschedule"), undo } });
}

/** How long "Sending…" stays for a result that isn't coming soon (offline, a long retry): a send's own deadline. Its result takes the dock whenever it comes. */
const SENDING_MS = 30_000;

/** A spinner until it's sent: "Message sent" takes its place, with the check (send-warning). */
export function sendingSnack(id?: string): void {
  snack.loading(t("compose.sending"), { ...(id ? { id } : {}), duration: SENDING_MS });
}

/**
 * Plan 158: Undo of Send's window: cancels the backend's hold. It either wins, and the draft is back as it was saved, or
 * the message has already gone, and it says so. False if it had already gone. Anything else that goes wrong is Undo's to
 * say, with a retry. (Plan 182: what shows the window is `held-sends`.)
 */
export async function cancelHeldSend(draftId: number, pinned: boolean, cancelled?: () => void): Promise<boolean> {
  const owner = ownership();
  try {
    await client.call("scheduled.cancel", { draftId });
  } catch (error) {
    owner.stop();
    if ((error as { code?: string } | null)?.code !== "NOT_FOUND") throw error;
    snack(t("compose.undoSendTooLate"));
    return false;
  }
  // plan 182 (Codex critique #7): it's taken back, whatever reopening it does: a retry would only find it gone
  cancelled?.();
  try {
    await openDraftById(draftId, pinned, owner);
  } catch {
    snack(t("compose.undoSendKept"));
  }
  return true;
}

/** Scheduled from a composer (lib/compose's send): the snack, with Undo back to the draft. */
export function scheduledSnack(draftId: number, sendAt: number): void {
  const undo = registerUndo(() => editScheduled(draftId).then(() => undefined));
  snack.success(t("sendLater.scheduled", { when: reminderWhen(sendAt) }), { action: { label: t("common.undo"), name: t("sendLater.undo"), undo } });
}
