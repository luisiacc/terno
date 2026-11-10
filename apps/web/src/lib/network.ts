/**
 * Plan 20 in the renderer. A window coming back to the front with an account offline retries it
 * at once (the backend rate-limits too), and one that needs a sign-in has its saved password rechecked
 * (plan 25; the backend does that at most every ten minutes). The web build also passes the page's online/offline on:
 * there it is the only network signal (desktop's main watches the network itself).
 *
 * Plan 176, on the web: the page's focus, as it changes, goes to the backend too; for a minute after a focus it checks
 * the accounts without push every 5 s (someone coming to Terno is often waiting for a code or a link). Desktop's main
 * tells the backend itself: the OS knows a window's focus, which a click into a mail frame hides from the page.
 */
import { client } from "~/rpc/connection";
import { getApp } from "~/state/app";

const WEB = import.meta.env.VITE_TARGET === "web";
/** a focus retry at most this often (the backend's limit is the same) */
const FOCUS_EVERY_MS = 15_000;

export function installNetworkEvents(): () => void {
  let lastFocus = Number.NEGATIVE_INFINITY;
  const retryOffline = () => {
    if (document.visibilityState !== "visible" || Date.now() - lastFocus < FOCUS_EVERY_MS) return;
    // offline or backing off, or (plan 25) an IMAP account whose saved password the backend may recheck
    if (!getApp().accounts.some((a) => a.syncState.connection || (a.kind === "imap" && a.syncState.authRequired && a.syncState.authScope !== "send"))) return;
    lastFocus = Date.now();
    void client.call("sync.now", { reason: "focus" }).catch(() => {});
  };
  let focused: boolean | null = null;
  let offAttach = () => {};
  const focusChanged = () => {
    const now = document.visibilityState === "visible" && document.hasFocus();
    if (now === focused) return;
    focused = now;
    void client.call("sync.focus", { focused: now }).catch(() => {});
  };
  const network = () => void client.call("sync.network", { online: navigator.onLine }).catch(() => {});
  window.addEventListener("focus", retryOffline);
  document.addEventListener("visibilitychange", retryOffline);
  if (WEB) {
    window.addEventListener("focus", focusChanged);
    window.addEventListener("blur", focusChanged);
    document.addEventListener("visibilitychange", focusChanged);
    // opening Terno is coming to it too; a backend that's (re)attached hears where focus is (what it heard went with it)
    focusChanged();
    offAttach = client.onAttach(() => {
      focused = null;
      focusChanged();
    });
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    // a page that loads offline says so
    if (!navigator.onLine) network();
  }
  return () => {
    window.removeEventListener("focus", retryOffline);
    document.removeEventListener("visibilitychange", retryOffline);
    window.removeEventListener("focus", focusChanged);
    window.removeEventListener("blur", focusChanged);
    document.removeEventListener("visibilitychange", focusChanged);
    offAttach();
    window.removeEventListener("online", network);
    window.removeEventListener("offline", network);
  };
}
