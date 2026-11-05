/** Stand-ins for main's gate host and updater (render-probe builds expose them): plan 95's screens, the mailbox gate and the required update. */
import type { MailboxGate } from "@terno/core/mailbox";
import type { UpdateState } from "@terno/core/updates";
import type { Page } from "@playwright/test";

export const base: UpdateState = {
  status: "idle",
  unsupported: null,
  mode: "auto",
  channel: "stable",
  current: "0.1.0",
  available: null,
  target: null,
  ready: null,
  percent: null,
  checkedAt: null,
  error: null,
  deferred: null,
  justUpdated: null,
  required: null,
  updatingNow: false,
};
export const release = { version: "0.2.0", notes: "Fixes", size: 118_542_629, releaseDate: "2026-10-24T12:00:00.000Z" };
export const BACKUP = { createdAt: Date.UTC(2026, 9, 20, 12), appVersion: "0.2.0", fromSchema: 37 };

/** Stand-ins for main: they record what the window asks, and `gate` / `upd` push like main does. */
export async function fakeMain(page: Page, o: { gate?: MailboxGate; updates?: Partial<UpdateState>; answers?: { updateNow?: Partial<UpdateState> } } = {}) {
  await page.evaluate(
    ({ gate, updates, answers }) => {
      const w = window as unknown as Record<string, unknown> & { __terno: { mailboxBridge(b: unknown): void; updatesBridge(b: unknown): void } };
      const calls: string[] = [];
      const gateListeners = new Set<(g: unknown) => void>();
      const updListeners = new Set<(s: unknown) => void>();
      const box = { gate, upd: updates as Record<string, unknown>, calls };
      w.__p95 = {
        calls,
        gate(g: unknown) {
          box.gate = g as typeof gate;
          for (const l of gateListeners) l(g);
        },
        upd(s: unknown) {
          box.upd = s as Record<string, unknown>;
          for (const l of updListeners) l(s);
        },
      };
      const asked = (name: string) => async () => (calls.push(name), true);
      w.__terno.mailboxBridge({
        state: async () => box.gate,
        retry: asked("retry"),
        skipBackup: asked("skipBackup"),
        restore: asked("restore"),
        onState: (l: (g: unknown) => void) => (gateListeners.add(l), () => gateListeners.delete(l)),
      });
      const answer = (name: string, next?: unknown) => async () => {
        calls.push(name);
        if (next) (w.__p95 as { upd(s: unknown): void }).upd({ ...box.upd, ...(next as object) });
        return box.upd;
      };
      w.__terno.updatesBridge({
        state: async () => box.upd,
        check: answer("check"),
        download: answer("download"),
        install: answer("install"),
        updateNow: answer("updateNow", answers.updateNow),
        setPrefs: async () => box.upd,
        seen: () => {},
        onState: (l: (s: unknown) => void) => (updListeners.add(l), () => updListeners.delete(l)),
      });
    },
    { gate: o.gate ?? { kind: "open", restoredFrom: null }, updates: { ...base, ...o.updates }, answers: o.answers ?? {} },
  );
}

export const gate = (page: Page, g: MailboxGate) => page.evaluate((g) => (window as unknown as { __p95: { gate(g: unknown): void } }).__p95.gate(g), g);
export const upd = (page: Page, s: Partial<UpdateState>) => page.evaluate((s) => (window as unknown as { __p95: { upd(s: unknown): void } }).__p95.upd(s), { ...base, ...s });
export const calls = (page: Page) => page.evaluate(() => (window as unknown as { __p95: { calls: string[] } }).__p95.calls);

export const failed = (reason: "migration" | "corrupt" | "unwritable" | "backup", o: Partial<Extract<MailboxGate, { kind: "failed" }>> = {}): MailboxGate => ({ kind: "failed", reason, step: reason === "migration" ? 38 : null, backup: null, restoreFailed: null, ...o });
