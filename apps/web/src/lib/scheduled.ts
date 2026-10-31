import { t } from "@terno/i18n";
import type { ScheduledInfo, ScheduledSnapshot } from "@terno/core/rpc";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { forgetScheduledDrafts, loadDrafts, scheduledDrafts, useDrafts } from "~/lib/drafts";
import { reminderWhen } from "~/lib/when";
import { registerUndo, snack } from "~/lib/snack";
import { getApp, setApp } from "~/state/app";

/**
 * Plan 89: the scheduled sends as the windows see them (the backend's
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
  useScheduled.setState({ items: snapshot.items, byDraft: new Map(snapshot.items.map((s) => [s.draftId, s])) });
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
async function openDraftById(draftId: number): Promise<void> {
  await loadDrafts();
  const d = Object.values(useDrafts.getState().drafts).find((x) => x.id === draftId);
  if (!d) return;
  const { openStoredDraft } = await import("~/lib/compose");
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
    snack.success(t("compose.sending"));
    return;
  }
  const undo = before === undefined ? undefined : registerUndo(() => client.call("scheduled.reschedule", { draftId, sendAt: before }).then(() => undefined));
  snack.success(t("sendLater.scheduled", { when: reminderWhen(sendAt) }), undo && { action: { label: t("common.undo"), name: t("sendLater.undoReschedule"), undo } });
}

/** Scheduled from a composer (lib/compose's send): the snack, with Undo back to the draft. */
export function scheduledSnack(draftId: number, sendAt: number): void {
  const undo = registerUndo(() => editScheduled(draftId).then(() => undefined));
  snack.success(t("sendLater.scheduled", { when: reminderWhen(sendAt) }), { action: { label: t("common.undo"), name: t("sendLater.undo"), undo } });
}
