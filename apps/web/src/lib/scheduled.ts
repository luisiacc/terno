import { t } from "@terno/i18n";
import type { ScheduledInfo, ScheduledSnapshot } from "@terno/core/rpc";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { forgetScheduledDrafts, loadDrafts, scheduledDrafts, useDrafts } from "~/lib/drafts";
import { reminderWhen } from "~/lib/when";
import { dismissSnack, newsWaiting, registerUndo, snack, useSnack } from "~/lib/snack";
import { pinning } from "~/lib/pinned-draft-state";
import { forgetHeldSend, revealHeldSend } from "~/lib/sent-reveal";
import { getApp, setApp } from "~/state/app";
import { openStoredDraft } from "~/lib/compose";

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

/** A draft back from the backend (unscheduled, given back), opened in the composer. */
async function openDraftById(draftId: number, pinned = false): Promise<void> {
  await loadDrafts();
  const d = Object.values(useDrafts.getState().drafts).find((x) => x.id === draftId);
  if (!d) return;
  // sent from the pinned card: back on the card, with the reader left where it is
  if (pinned && pinning.pin(d.key)) return;
  await openStoredDraft(d.key);
}

/** Not scheduled anymore: a draft again, opened to edit (Undo of a schedule, "Edit message"). */
export async function editScheduled(draftId: number): Promise<boolean> {
  try {
    await client.call("scheduled.cancel", { draftId });
  } catch (error) {
    snack.error(t("sendLater.editFailed"), { description: errorText(error) });
    return false;
  }
  // the snapshot may come after this: the hydration mustn't wait for it to know it's a draft again
  const byDraft = new Map(useScheduled.getState().byDraft);
  byDraft.delete(draftId);
  useScheduled.setState({ items: [...byDraft.values()], byDraft });
  await openDraftById(draftId);
  return true;
}

/** A new moment (Send now: this one); a snack says when, with Undo back to the one before. */
export async function rescheduleScheduled(draftId: number, sendAt: number, now = false): Promise<void> {
  const before = useScheduled.getState().byDraft.get(draftId)?.sendAt;
  try {
    await client.call("scheduled.reschedule", { draftId, sendAt });
  } catch (error) {
    snack.error(t("sendLater.rescheduleFailed"), { description: errorText(error) });
    return;
  }
  if (now) {
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

let holds = 0;

/**
 * Plan 158: Send's Undo window: the backend holds the message (`compose.schedule`'s `hold`) and sends it at its moment
 * whatever happens here. Undo cancels that row: it either wins, and the draft is back as it was saved, or the message has
 * already gone, and it says so.
 */
export function heldSendSnack(draftId: number, threadId: number | null, holdMs: number, pinned = false): void {
  const id = `held-send-${++holds}`;
  if (threadId !== null) revealHeldSend(threadId, holdMs);
  const undo = registerUndo(async () => {
    if (await cancelHeldSend(draftId, pinned) && threadId !== null) forgetHeldSend(threadId);
  });
  // set before the snack's own timer, so it runs first and finds the snack still up: the spinner goes on, the Undo's gone
  setTimeout(() => {
    if (undo.state !== "ready") return;
    if (useSnack.getState().undo === undo) useSnack.setState({ undo: null });
    // the backend's clock started first: its "Message sent" can already be waiting behind the Undo
    if (useSnack.getState().current?.id !== id) return;
    if (newsWaiting()) dismissSnack(id);
    else sendingSnack(id);
  }, holdMs);
  snack.loading(t("compose.sending"), { id, duration: holdMs, action: { label: t("common.undo"), name: t("compose.undoSend"), undo } });
}

/** False if it had already gone. Anything else that goes wrong is Undo's to say, with a retry. */
async function cancelHeldSend(draftId: number, pinned: boolean): Promise<boolean> {
  try {
    await client.call("scheduled.cancel", { draftId });
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== "NOT_FOUND") throw error;
    snack(t("compose.undoSendTooLate"));
    return false;
  }
  await openDraftById(draftId, pinned);
  return true;
}

/** Scheduled from a composer (lib/compose's send): the snack, with Undo back to the draft. */
export function scheduledSnack(draftId: number, sendAt: number): void {
  const undo = registerUndo(() => editScheduled(draftId).then(() => undefined));
  snack.success(t("sendLater.scheduled", { when: reminderWhen(sendAt) }), { action: { label: t("common.undo"), name: t("sendLater.undo"), undo } });
}
