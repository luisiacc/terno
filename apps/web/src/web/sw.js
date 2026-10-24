/*
 * Única's service worker (web build only; the build injects the build id and
 * the file list). Same-origin files only:
 * - the page (navigations) is network-first, so a deploy shows up on reload, with the cached shell as the offline fallback;
 * - hashed assets, the backend worker and sqlite3.wasm are cache-first from this build's cache.
 * A new build installs alongside and waits; the page offers "Recargar" and
 * activates it (skip-waiting), so the page, the worker and the WASM of one
 * tab always come from the same build. Mail never goes through here.
 */
const BUILD = __TERNO_BUILD__;
const PRECACHE = __TERNO_PRECACHE__;
const CACHE = `unica-${BUILD}`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith("unica-") && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
  if (event.data === "build") event.source?.postMessage({ type: "build", build: BUILD });
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(CACHE);
          return (await cache.match("./", { ignoreVary: true })) ?? Response.error();
        }
      })(),
    );
    return;
  }
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // ignoreVary: hosts often answer "Vary: Origin", and module scripts send an Origin the precache request didn't
      return (await cache.match(request, { ignoreSearch: true, ignoreVary: true })) ?? fetch(request);
    })(),
  );
});
