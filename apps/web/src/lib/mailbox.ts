import { GATE_OPEN, gateBlocks, type MailboxGate } from "@terno/core/mailbox";
import { localeTag, t } from "@terno/i18n";
import { create } from "zustand";
import { snack } from "~/lib/snack";

/**
 * Plan 95, desktop: the mailbox gate in the window. Main owns it (the
 * backend reports, main decides about restarts) and pushes every change;
 * this mirrors it and asks. Started with the window, before the mail engine
 * is connected: a mailbox that can't open never gets that far. Nothing here
 * polls.
 */

let bridge = typeof window === "undefined" ? undefined : window.ternoDesktop?.mailbox;

interface MailboxStore {
  gate: MailboxGate;
  /** an ask is with main (Try Again, Update Without a Backup, Restore); cleared by the next gate */
  busy: boolean;
}

export const useMailbox = create<MailboxStore>(() => ({ gate: GATE_OPEN, busy: false }));

export const useGateBlocks = () => useMailbox((s) => gateBlocks(s.gate));

let started = false;

/** Idempotent; the window calls it as it mounts. */
export function startMailbox(): void {
  if (started || !bridge) return;
  started = true;
  bridge.onState((gate) => adopt(gate));
  void bridge.state().then((gate) => gate && adopt(gate));
}

function adopt(gate: MailboxGate): void {
  useMailbox.setState({ gate, busy: false });
  if (gate.kind === "open" && gate.restoredFrom !== null) {
    snack(t("mailbox.restored", { date: backupDate(gate.restoredFrom) }), { id: "mailbox-restored", duration: 12_000 });
  }
}

export function backupDate(at: number): string {
  return new Date(at).toLocaleDateString(localeTag(), { month: "long", day: "numeric", year: "numeric" });
}

async function ask(fn: (b: NonNullable<typeof bridge>) => Promise<boolean>): Promise<void> {
  if (!bridge) return;
  useMailbox.setState({ busy: true });
  const ok = await fn(bridge).catch(() => false);
  // refused (it no longer applied): the screen is as it was, ready for another try
  if (!ok) useMailbox.setState({ busy: false });
}

export const retryMailbox = () => ask((b) => b.retry());
export const skipMailboxBackup = () => ask((b) => b.skipBackup());
export const restoreMailbox = () => ask((b) => b.restore());

/** render-probe builds: a stand-in for main (e2e) */
export function setMailboxBridgeForTests(fake: NonNullable<typeof bridge>): void {
  bridge = fake;
  started = false;
  startMailbox();
}
