/**
 * Plan 38 in the page. Desktop: main shows the badge and the notifications,
 * and a click comes back here to open its conversation. Elsewhere (the web,
 * a browser on the dev backend) the page does both: the unread count on the
 * installed app's icon where the browser has setAppBadge, and a notification
 * for the backend's `notify` event while this tab is hidden.
 */
import { noticeText, type MailNotice } from "@terno/core";
import { client } from "~/rpc/connection";
import { reconcileSettings } from "~/lib/appearance";
import { openThread } from "~/lib/page";
import { getApp, navigate, setApp, useApp } from "~/state/app";
import { reloadList } from "~/state/list";

type BadgeNavigator = Navigator & { setAppBadge?(n?: number): Promise<void>; clearAppBadge?(): Promise<void> };

const desktop = () => typeof window !== "undefined" && !!window.ternoDesktop;

/** The browser can put a number on the installed app's icon. */
export const badgeSupported = (): boolean => !desktop() && typeof (navigator as BadgeNavigator).setAppBadge === "function";

/** The browser can show a notification from this page (the constructor exists; mobile browsers throw from it, see show()). */
export const pageNotificationsSupported = (): boolean => !desktop() && typeof Notification === "function";

/**
 * A notification's click: the unified Inbox with that conversation open (or
 * just the Inbox). One operation: dialogs close, the Inbox loads, and the
 * reload keeps this selection instead of picking the first row.
 */
export function openFromNotice(threadId: number | null): void {
  const s = getApp();
  if (s.dialog) setApp({ dialog: null });
  if (s.view !== "inbox" || s.accountId !== null || s.categoryId !== null || s.reviewCategoryId !== null || s.query !== "") navigate({ view: "inbox", accountId: null, categoryId: null, reviewCategoryId: null });
  if (threadId === null) return;
  openThread(threadId);
  // supersedes the navigation's own reload (which would select row 0)
  void reloadList({ keepSelection: true });
}

/** The page's notifications, closed when it loses its backend (a takeover): a click must never drive a page without one. */
const live = new Set<Notification>();

export function closePageNotifications(): void {
  for (const n of live) n.close();
  live.clear();
}

/** The tag: the same burst replaces itself, scoped to this mailbox (the web keeps several by name). */
function tagOf(notice: MailNotice): string {
  const mailbox = new URLSearchParams(location.search).get("mailbox") || "terno";
  return `${mailbox}:${notice.id}`;
}

function show(notice: MailNotice): void {
  const s = getApp().settings;
  if (!s?.notifications || !pageNotificationsSupported() || Notification.permission !== "granted") return;
  // a visible tab already shows the mail
  if (document.visibilityState !== "hidden") return;
  const { title, subtitle, body } = noticeText(notice);
  let n: Notification;
  try {
    n = new Notification(title, { body: [subtitle, body].filter(Boolean).join("\n"), tag: tagOf(notice) });
  } catch {
    // mobile browsers only show them through a service worker: nothing here
    return;
  }
  live.add(n);
  n.onclick = () => {
    window.focus();
    n.close();
    openFromNotice(notice.threadId);
  };
  n.onclose = () => live.delete(n);
}

/** Saved on, but this browser won't show them: off, so the backend does no work for nothing and the switch says the truth. */
async function reconcilePermission(): Promise<void> {
  const s = getApp().settings;
  if (desktop() || !s?.notifications) return;
  if (pageNotificationsSupported() && Notification.permission === "granted") return;
  try {
    setApp({ settings: reconcileSettings(await client.call("settings.update", { notifications: false })) });
  } catch {
    // the next start tries again
  }
}

function syncBadge(): void {
  const nav = navigator as BadgeNavigator;
  const { settings, counts } = getApp();
  const n = settings?.dockBadge ? counts.inboxUnread : 0;
  const done = n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.();
  // not installed, or not allowed: nothing to show
  void done?.catch(() => {});
}

/** At the end of boot (history restored, the first list asked for): a click main queued is delivered only now. */
export function startAttention(): void {
  if (desktop()) {
    window.ternoDesktop?.onOpenThread?.((threadId) => openFromNotice(threadId));
    return;
  }
  if (badgeSupported()) {
    syncBadge();
    let last = "";
    useApp.subscribe((s) => {
      const key = `${s.settings?.dockBadge}:${s.counts.inboxUnread}`;
      if (key === last) return;
      last = key;
      syncBadge();
    });
  }
  client.on("notify", show);
  // the web: a tab that lost its mailbox (taken over, stopped) lets go of what it showed
  if (import.meta.env.VITE_TARGET === "web")
    void import("~/web/lifecycle").then(({ useWeb }) =>
      useWeb.subscribe((s) => {
        if (s.phase !== "ready") closePageNotifications();
      }),
    );
  void reconcilePermission();
  // a permission taken away later (the site's settings) turns the setting off too
  void navigator.permissions
    ?.query({ name: "notifications" as PermissionName })
    .then((status) => status.addEventListener("change", () => void reconcilePermission()))
    .catch(() => {});
}
