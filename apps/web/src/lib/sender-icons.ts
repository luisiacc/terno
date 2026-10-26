/**
 * Sender icons in the renderer (plan 22): a small store keyed by address,
 * with a listener set per address, so an icon arriving re-renders exactly the
 * avatars showing that sender (never a row). Avatars ask only once they are
 * on screen (one shared IntersectionObserver); what became visible in a frame
 * goes in one lookup (chunked at the contract's 200), and icons' bytes in one
 * data request (chunks of 50). Nothing happens while both sources are off.
 */
import type { IconAnswer, IconRef } from "@terno/core/rpc";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { client } from "~/rpc/connection";
import { useApp, type AppState } from "~/state/app";

export interface ShownIcon {
  ref: IconRef;
  url: string;
}

type Entry = { state: "idle" } | { state: "asked" } | { state: "none" } | { state: "ref"; ref: IconRef };

const LOOKUP_CHUNK = 200;
const DATA_CHUNK = 50;
const MAX_ENTRIES = 3000;
const MAX_DATA = 400;
/** an address the backend dropped from a full queue asks again after this, if it's still on screen */
const AGAIN_MS = 1500;

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
/** `${id}:${v}` → data: URL (LRU) */
const data = new Map<string, string>();
/** addresses on screen now (the observer's view) */
const visible = new Set<string>();
const batch = new Set<string>();
const dataBatch = new Map<string, IconRef>();
let flushQueued = false;
let wired = false;
/** `shown` cache per address, so useSyncExternalStore sees the same object until something changes */
const snapshots = new Map<string, ShownIcon | null>();

/** Both sources: website icons where the host can fetch them, or any account with photos from Google. */
export function iconsEnabled(s: AppState): boolean {
  const set = s.settings;
  if (!set) return false;
  return (set.senderIcons && s.host?.capabilities.siteIcons === true) || Object.keys(set.googlePhotos ?? {}).length > 0;
}

function notify(email: string): void {
  snapshots.delete(email);
  for (const l of listeners.get(email) ?? []) l();
}

function dataKey(ref: IconRef): string {
  return `${ref.id}:${ref.v}`;
}

function getData(ref: IconRef): string | undefined {
  const k = dataKey(ref);
  const url = data.get(k);
  if (url !== undefined) {
    data.delete(k);
    data.set(k, url);
  }
  return url;
}

function putData(k: string, url: string): void {
  data.set(k, url);
  // a mounted <img> keeps its own src: evicting only costs a refetch on the next mount
  while (data.size > MAX_DATA) data.delete(data.keys().next().value!);
}

function setEntry(email: string, e: Entry): void {
  entries.delete(email);
  entries.set(email, e);
  if (entries.size > MAX_ENTRIES) {
    for (const k of entries.keys()) {
      if (entries.size <= MAX_ENTRIES) break;
      if (!listeners.get(k)?.size) entries.delete(k);
    }
  }
  notify(email);
}

function apply(answers: Record<string, IconAnswer>): void {
  for (const [email, a] of Object.entries(answers)) {
    if (a === "again") {
      setEntry(email, { state: "idle" });
      setTimeout(() => visible.has(email) && request(email), AGAIN_MS);
    } else if (a === null) setEntry(email, { state: "none" });
    else {
      setEntry(email, { state: "ref", ref: a });
      if (getData(a) === undefined) dataBatch.set(dataKey(a), a);
    }
  }
  // asked and not in the answer: on its way (the `icons` event); it stays "asked"
  schedule();
}

function wire(): void {
  if (wired) return;
  wired = true;
  client.on("icons", ({ icons, reset }) => {
    if (reset) {
      entries.clear();
      data.clear();
      batch.clear();
      dataBatch.clear();
      snapshots.clear();
      for (const email of listeners.keys()) notify(email);
      // what's on screen asks again (a source turned on or off, photos listed, icons forgotten)
      for (const email of visible) request(email);
    }
    apply(icons);
  });
}

function schedule(): void {
  if (flushQueued || (batch.size === 0 && dataBatch.size === 0)) return;
  flushQueued = true;
  const run = () => {
    flushQueued = false;
    void flush();
  };
  if (typeof requestAnimationFrame === "function" && document.visibilityState === "visible") requestAnimationFrame(run);
  else setTimeout(run, 16);
}

async function flush(): Promise<void> {
  // only what is still on screen
  const emails = [...batch].filter((e) => visible.has(e));
  batch.clear();
  for (const e of emails) entries.set(e, { state: "asked" });
  for (let i = 0; i < emails.length; i += LOOKUP_CHUNK) {
    const chunk = emails.slice(i, i + LOOKUP_CHUNK);
    try {
      apply(await client.call("icons.lookup", { emails: chunk }));
    } catch {
      // the initials stay; a later mount or scroll asks again
      for (const e of chunk) if (entries.get(e)?.state === "asked") entries.delete(e);
    }
  }
  const refs = [...dataBatch.values()];
  dataBatch.clear();
  for (let i = 0; i < refs.length; i += DATA_CHUNK) {
    const chunk = refs.slice(i, i + DATA_CHUNK);
    let got: Record<string, string | null>;
    try {
      got = await client.call("icons.data", { ids: [...new Set(chunk.map((r) => r.id))] });
    } catch {
      continue;
    }
    for (const ref of chunk) {
      const url = got[ref.id];
      if (url) putData(dataKey(ref), url);
    }
    // every address showing these icons
    const ids = new Set(chunk.map((r) => r.id));
    for (const [email, e] of entries) if (e.state === "ref" && ids.has(e.ref.id)) notify(email);
  }
}

function request(email: string): void {
  wire();
  const e = entries.get(email);
  if (e && e.state !== "idle") {
    if (e.state === "ref" && getData(e.ref) === undefined) {
      dataBatch.set(dataKey(e.ref), e.ref);
      schedule();
    }
    return;
  }
  batch.add(email);
  schedule();
}

// ───────────────────────────── visibility ─────────────────────────────

const observed = new Map<Element, string>();
const visibleEls = new Set<Element>();
let observer: IntersectionObserver | null = null;

/** An address is on screen while any of its avatars is. */
function recompute(email: string): void {
  if ([...observed].some(([el, e]) => e === email && visibleEls.has(el))) visible.add(email);
  else visible.delete(email);
}

function observe(el: Element, email: string): () => void {
  observer ??= new IntersectionObserver((records) => {
    for (const r of records) {
      const who = observed.get(r.target);
      if (!who) continue;
      if (r.isIntersecting) visibleEls.add(r.target);
      else visibleEls.delete(r.target);
      recompute(who);
      if (r.isIntersecting) request(who);
    }
  });
  observed.set(el, email);
  observer.observe(el);
  return () => {
    observer?.unobserve(el);
    observed.delete(el);
    visibleEls.delete(el);
    recompute(email);
  };
}

function shown(email: string): ShownIcon | null {
  if (snapshots.has(email)) return snapshots.get(email)!;
  const e = entries.get(email);
  const url = e?.state === "ref" ? getData(e.ref) : undefined;
  const s = e?.state === "ref" && url ? { ref: e.ref, url } : null;
  snapshots.set(email, s);
  return s;
}

/**
 * The icon for an address, once its avatar is on screen: null until there is one (and while the
 * sources are off). Re-renders only when this address's icon changes.
 */
export function useSenderIcon(email: string, el: React.RefObject<Element | null>, active: boolean): ShownIcon | null {
  const enabled = useApp(iconsEnabled) && active;
  const subscribe = useCallback(
    (cb: () => void) => {
      let set = listeners.get(email);
      if (!set) listeners.set(email, (set = new Set()));
      set.add(cb);
      return () => {
        set.delete(cb);
        if (set.size === 0) listeners.delete(email);
      };
    },
    [email],
  );
  const icon = useSyncExternalStore(subscribe, () => (enabled ? shown(email) : null));
  useEffect(() => {
    const node = el.current;
    if (!enabled || !node || typeof IntersectionObserver === "undefined") return;
    return observe(node, email);
  }, [email, enabled]);
  return icon;
}

/** An <img> that failed to decode: initials for that address from now on. */
export function iconFailed(email: string): void {
  setEntry(email, { state: "none" });
}

/** tests */
export const __senderIconsForTests = { entries, data, visible, reset: () => [entries, data, visible, batch, dataBatch, snapshots, listeners].forEach((m) => m.clear()) };
