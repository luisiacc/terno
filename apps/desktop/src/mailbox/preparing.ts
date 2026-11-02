/**
 * Plan 112: the backup before a migration, as the backend's shutdown sees it.
 * A shutdown while it runs ends a clone in flight, waits for it, and keeps
 * the mailbox from being opened after (Codex code review #1): "closed" then
 * means nothing of the mailbox is running.
 */
export class Preparation {
  private running: Promise<unknown> | null = null;
  /** a shutdown came while the backup ran: nothing opens the mailbox after it */
  stopped = false;

  async run<T>(work: Promise<T>): Promise<T> {
    this.running = work;
    try {
      return await work;
    } finally {
      this.running = null;
    }
  }

  /** Before a shutdown answers: ends the backup (`cancel`) and waits for it. Nothing to do when none runs. */
  async stop(cancel: () => void): Promise<void> {
    if (!this.running) return;
    this.stopped = true;
    cancel();
    await this.running.catch(() => {});
  }
}
