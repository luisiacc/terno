/**
 * Plan 38 in main: the Dock badge and system notifications, from what the
 * backend reports over the parent port (validated again here), and a
 * notification's click opening its conversation in a window, once that
 * window's page listens. Electron stays behind the deps, so this is tested
 * with fakes.
 */
import { badgeText, NOTICE_SENDERS, noticeText, type MailNotice } from "@terno/core";

const MAX_TEXT = 300;
/** live notifications kept so their click handlers survive garbage collection */
export const MAX_LIVE = 20;

const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const text = (v: unknown, max = MAX_TEXT): string | null => (typeof v === "string" ? v.slice(0, max) : null);

/** A badge count from the backend, or null. */
export function parseBadge(v: unknown): number | null {
  return Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null;
}

/** A notice from the backend, or null: every field checked and bounded. */
export function parseNotice(v: unknown): MailNotice | null {
  if (!v || typeof v !== "object") return null;
  const n = v as Record<string, unknown>;
  const id = text(n.id, 100);
  const subject = text(n.subject);
  const snippet = text(n.snippet);
  if (!id || subject === null || snippet === null) return null;
  if (!Number.isSafeInteger(n.count) || (n.count as number) < 1) return null;
  if (!Number.isSafeInteger(n.senderCount) || (n.senderCount as number) < 1) return null;
  if (n.threadId !== null && !isId(n.threadId)) return null;
  if (!Array.isArray(n.senders) || n.senders.length === 0 || n.senders.length > NOTICE_SENDERS) return null;
  const senders = n.senders.map((s) => text(s));
  if (senders.some((s) => s === null)) return null;
  return { id, count: n.count as number, threadId: n.threadId as number | null, senders: senders as string[], senderCount: n.senderCount as number, subject, snippet };
}

export interface NotificationLike {
  show(): void;
  close(): void;
  on(event: "click" | "close" | "show" | "failed", listener: () => void): unknown;
}

export interface DesktopAttentionDeps {
  setBadge(text: string): void;
  supported(): boolean;
  create(options: { title: string; subtitle?: string; body: string; silent: boolean }): NotificationLike;
  /** a click: bring a window forward and open the conversation (null: the Inbox) */
  open(threadId: number | null): void;
  /** diagnostics: how many messages a shown notice stood for */
  shown?(count: number): void;
  /** diagnostics: the system refused to show one */
  failed?(): void;
}

export class DesktopAttention {
  private readonly live = new Set<NotificationLike>();
  private badgeShown: string | null = null;

  constructor(private readonly deps: DesktopAttentionDeps) {}

  badge(raw: unknown): void {
    const count = parseBadge(raw);
    if (count === null) return;
    const text = badgeText(count);
    if (text === this.badgeShown) return;
    this.badgeShown = text;
    this.deps.setBadge(text);
  }

  /** what the Dock shows (tests) */
  get badgeText(): string | null {
    return this.badgeShown;
  }

  notify(raw: unknown): void {
    const notice = parseNotice(raw);
    if (!notice || !this.deps.supported()) return;
    const { title, subtitle, body } = noticeText(notice);
    const n = this.deps.create({ title, ...(subtitle && { subtitle }), body, silent: false });
    const forget = () => this.live.delete(n);
    n.on("click", () => {
      forget();
      this.deps.open(notice.threadId);
    });
    n.on("close", forget);
    n.on("show", () => this.deps.shown?.(notice.count));
    n.on("failed", () => {
      forget();
      this.deps.failed?.();
    });
    this.live.add(n);
    // the oldest go first: Notification Center keeps them, only their click handlers are let go
    for (const old of this.live) {
      if (this.live.size <= MAX_LIVE) break;
      // only Terno's reference goes: the banner stays in Notification Center, and a click on it just brings Terno forward
      this.live.delete(old);
    }
    n.show();
  }

  get liveCount(): number {
    return this.live.size;
  }
}

/**
 * A notification's open, held until the window it was meant for has a page
 * that listens (`terno:open-ready`, sent again after every load), so a click
 * that had to create or reload a window is never lost. One at a time: a newer
 * click replaces an undelivered one.
 */
export class OpenRelay {
  private readonly ready = new Set<number>();
  private pending: { windowId: number; threadId: number | null } | null = null;

  constructor(private readonly send: (windowId: number, threadId: number | null) => void) {}

  want(windowId: number, threadId: number | null): void {
    this.pending = { windowId, threadId };
    this.deliver();
  }

  /** the window's page listens */
  listening(windowId: number): void {
    this.ready.add(windowId);
    this.deliver();
  }

  /** its page went (a reload, a navigation) or the window closed */
  gone(windowId: number): void {
    this.ready.delete(windowId);
  }

  private deliver(): void {
    const p = this.pending;
    if (!p || !this.ready.has(p.windowId)) return;
    this.pending = null;
    this.send(p.windowId, p.threadId);
  }
}
