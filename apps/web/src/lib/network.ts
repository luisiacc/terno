/**
 * Plan 20 in the renderer. A window coming back to the front with an account offline retries it
 * at once (the backend rate-limits too). The web build also passes the page's online/offline on:
 * there it is the only network signal (desktop's main watches the network itself).
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
    if (!getApp().accounts.some((a) => a.syncState.connection)) return;
    lastFocus = Date.now();
    void client.call("sync.now", { reason: "focus" }).catch(() => {});
  };
  const network = () => void client.call("sync.network", { online: navigator.onLine }).catch(() => {});
  window.addEventListener("focus", retryOffline);
  document.addEventListener("visibilitychange", retryOffline);
  if (WEB) {
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    // a page that loads offline says so
    if (!navigator.onLine) network();
  }
  return () => {
    window.removeEventListener("focus", retryOffline);
    document.removeEventListener("visibilitychange", retryOffline);
    window.removeEventListener("online", network);
    window.removeEventListener("offline", network);
  };
}
