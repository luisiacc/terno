/**
 * Plan 38: the Dock's unread count. The badge rides on the sidebar's counts
 * (no query of its own): the number shown is theirs, sent to the host only
 * when it changes, 0 while the setting is off.
 */
import type { Counts } from "@terno/core";
import type { MailStore } from "@terno/store";
import { readAttention } from "./settings";

/** Where a host shows it itself (desktop main); the web's page reads the counts on its own. */
export interface AttentionHost {
  /** the Inbox's unread count to show (0: none) */
  badge(count: number): void;
}

export interface AttentionOptions {
  store: Pick<MailStore, "settings" | "secrets">;
  host: AttentionHost | null;
  /** the sidebar's publisher (coalesced): at start it reports the counts the badge needs */
  publishCounts(): void;
}

export class Attention {
  private dockBadge = true;
  /** what the host shows now (null: nothing sent yet, so the first count always goes) */
  private shown: number | null = null;
  private last: Counts | null = null;
  private stopped = false;

  constructor(private readonly o: AttentionOptions) {}

  /** Settings, then the counts through the sidebar's publisher: a restarted backend puts the badge back. */
  async start(): Promise<void> {
    await this.refresh();
    if (this.o.host) this.o.publishCounts();
  }

  /** Settings changed (or at start): the badge follows at once. */
  async refresh(): Promise<void> {
    const s = await readAttention(this.o.store);
    this.dockBadge = s.dockBadge;
    if (this.last) this.counts(this.last);
    else if (!this.dockBadge) this.show(0);
  }

  /** The sidebar's counts, just computed: the badge shows their Inbox number when it changed. */
  counts(c: Counts): void {
    this.last = c;
    this.show(this.dockBadge ? c.inboxUnread : 0);
  }

  private show(n: number): void {
    if (!this.o.host || this.stopped || n === this.shown) return;
    this.shown = n;
    this.o.host.badge(n);
  }

  stop(): void {
    this.stopped = true;
  }
}
