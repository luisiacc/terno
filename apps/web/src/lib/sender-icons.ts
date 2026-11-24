/**
 * Sender icons in the renderer (plan 22): a small store keyed by address,
 * with a listener set per address, so an icon arriving re-renders exactly the
 * avatars showing that sender (never a row). Avatars ask only once they are
 * on screen (one shared IntersectionObserver); what became visible in a frame
 * goes in one lookup (chunked at the contract's 200), and icons' bytes in one
 * data request (chunks of 50). Nothing happens while both sources are off.
 */
import { parseSearch } from "@terno/core";
import type { IconAnswer, IconRef } from "@terno/core/rpc";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { measureIcon, WHOLE, type IconFit } from "~/lib/icon-fit";
import { client } from "~/rpc/connection";
import { useApp, type AppState } from "~/state/app";

export interface ShownIcon {
  ref: IconRef;
  url: string;
  /** how it sits in the disc (plan 252), measured when its bytes arrived */
  fit: IconFit;
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
/** `${id}:${v}` → its measured fit, kept and evicted with its bytes (plan 252) */
const fits = new Map<string, IconFit>();
/** addresses on screen now (the observer's view) */
const visible = new Set<string>();
const batch = new Set<string>();
const dataBatch = new Map<string, IconRef>();
let flushQueued = false;
/** addresses that already looked up again after their icon's bytes were gone (once each) */
const refetched = new Set<string>();
let wired = false;
let generation = 0;
/**
 * After a reset, the on-screen addresses being asked again: each keeps drawing its icon until its new answer can be
 * drawn, so a reset never blanks the avatars on screen (they'd flash to initials and back).
 */
const held = new Set<string>();
/** A held address's new icon, drawn once its own bytes arrive (never on another request's answer). */
const replacing = new Map<string, IconRef>();

/** Done holding: the address shows what `entry` says from now on. */
function release(email: string, entry?: Entry): void {
  held.delete(email);
  replacing.delete(email);
  if (entry) setEntry(email, entry);
}
/** `shown` cache per address, so useSyncExternalStore sees the same object until something changes */
const snapshots = new Map<string, ShownIcon | null>();

/** Website icons, where the host can fetch them and the setting allows (plan 258 removed Google photos). */
export function iconsEnabled(s: AppState): boolean {
  return !!s.settings?.senderIcons && s.host?.capabilities.siteIcons === true;
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

function putData(k: string, url: string, fit: IconFit): void {
  data.set(k, url);
  fits.set(k, fit);
  // a mounted <img> keeps its own src: evicting only costs a refetch on the next mount
  while (data.size > MAX_DATA) {
    const old = data.keys().next().value!;
    data.delete(old);
    fits.delete(old);
  }
}

function setEntry(email: string, e: Entry): void {
  entries.delete(email);
  entries.set(email, e);
  if (entries.size > MAX_ENTRIES) {
    for (const k of entries.keys()) {
      if (entries.size <= MAX_ENTRIES) break;
      if (!listeners.get(k)?.size) {
        entries.delete(k);
        snapshots.delete(k);
      }
    }
  }
  notify(email);
}

function apply(answers: Record<string, IconAnswer>): void {
  const epoch = generation;
  for (const [email, a] of Object.entries(answers)) {
    // a held icon stays until its replacement's bytes are here; the same icon (or none) settles it now
    if (held.has(email) && a === "again") {
      // the backend is busy: still drawn, asked again shortly
      setTimeout(() => {
        if (epoch !== generation || !visible.has(email)) return;
        batch.add(email);
        schedule();
      }, AGAIN_MS);
      continue;
    }
    const now = entries.get(email);
    if (held.has(email) && a !== null && a !== "again" && getData(a) === undefined && !(now?.state === "ref" && dataKey(now.ref) === dataKey(a))) {
      replacing.set(email, a);
      if (wantData(a)) dataBatch.set(dataKey(a), a);
      continue;
    }
    release(email);
    if (a === "again") {
      setEntry(email, { state: "idle" });
      setTimeout(() => epoch === generation && visible.has(email) && request(email), AGAIN_MS);
    } else if (a === null) setEntry(email, { state: "none" });
    else {
      setEntry(email, { state: "ref", ref: a });
      if (wantData(a)) dataBatch.set(dataKey(a), a);
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
      generation++;
      // stale-while-revalidate: what's on screen keeps showing and asks again (the source turned on or off, icons
      // forgotten); each avatar changes only when its new answer can be drawn. The rest is forgotten.
      for (const email of entries.keys()) {
        if (visible.has(email)) continue;
        entries.delete(email);
        snapshots.delete(email);
      }
      // nothing off screen is held or replaced: an answer from before the reset can't come back later (a source just
      // turned off must not show again)
      held.clear();
      replacing.clear();
      batch.clear();
      dataBatch.clear();
      // measurements under way land in the old generation (dropped); their bytes are asked for again
      measuring.clear();
      measureQueue.length = 0;
      for (const email of visible) {
        if (entries.get(email)?.state === "ref") held.add(email);
        batch.add(email);
      }
      schedule();
    }
    apply(icons);
  });
}

/** requests in flight at once (lookups and data alike): a busy backend doesn't pile them up */
const MAX_INFLIGHT = 2;
let inflight = 0;

function schedule(): void {
  if (flushQueued || inflight >= MAX_INFLIGHT || (batch.size === 0 && dataBatch.size === 0)) return;
  flushQueued = true;
  const run = () => {
    flushQueued = false;
    pump();
  };
  if (typeof requestAnimationFrame === "function" && document.visibilityState === "visible") requestAnimationFrame(run);
  else setTimeout(run, 16);
}

/** Starts requests up to MAX_INFLIGHT: lookups first (what's on screen now), then icons' bytes; each finishing starts the next. */
function pump(): void {
  while (inflight < MAX_INFLIGHT && (batch.size > 0 || dataBatch.size > 0)) {
    let job: Promise<void>;
    if (batch.size > 0) {
      // only what is still on screen; the rest is dropped (it asks again when it comes back)
      const emails: string[] = [];
      for (const e of batch) {
        batch.delete(e);
        if (!visible.has(e)) continue;
        emails.push(e);
        if (emails.length === LOOKUP_CHUNK) break;
      }
      if (emails.length === 0) continue;
      job = lookup(emails);
    } else {
      const refs: IconRef[] = [];
      for (const [k, r] of dataBatch) {
        dataBatch.delete(k);
        refs.push(r);
        if (refs.length === DATA_CHUNK) break;
      }
      job = fetchData(refs);
    }
    inflight++;
    void job.finally(() => {
      inflight--;
      schedule();
    });
  }
}

async function lookup(emails: string[]): Promise<void> {
  const epoch = generation;
  // asked: but an icon on screen stays drawn while it's asked again
  for (const e of emails) if (entries.get(e)?.state !== "ref") entries.set(e, { state: "asked" });
  try {
    const answers = await client.call("icons.lookup", { emails });
    if (epoch !== generation) return;
    apply(answers);
  } catch {
    if (epoch !== generation) return;
    // the initials stay (a held icon too); a later mount or scroll asks again
    for (const e of emails) {
      release(e);
      if (entries.get(e)?.state === "asked") entries.delete(e);
    }
  }
}

async function fetchData(refs: IconRef[]): Promise<void> {
  const epoch = generation;
  let got: Record<string, string | null>;
  try {
    got = await client.call("icons.data", { ids: [...new Set(refs.map((r) => r.id))] });
  } catch {
    if (epoch !== generation) return;
    // a replacement whose bytes didn't come: its address looks up again (never stuck on the old icon)
    const keys = new Set(refs.map(dataKey));
    for (const [email, ref] of replacing) {
      if (!keys.has(dataKey(ref))) continue;
      release(email, { state: "idle" });
      if (visible.has(email)) request(email);
    }
    return;
  }
  if (epoch !== generation) return;
  const gone = new Set<string>();
  for (const ref of refs) {
    const url = got[ref.id];
    if (!url) gone.add(ref.id);
    // measured first (plan 252), off this request's slot: it lands at its own size
    else measure(ref, url, epoch);
  }
  // replacements whose bytes are gone: initials (one whose bytes came is swapped in when they land)
  const keys = new Set(refs.map(dataKey));
  for (const [email, ref] of replacing) if (keys.has(dataKey(ref)) && gone.has(ref.id)) release(email, { state: "none" });
  // bytes the backend no longer has (evicted, a lost file): those addresses look the icon up again, once
  if (gone.size) {
    for (const [email, e] of entries) {
      if (e.state !== "ref" || !gone.has(e.ref.id)) continue;
      if (refetched.has(email)) {
        setEntry(email, { state: "none" });
        continue;
      }
      refetched.add(email);
      setEntry(email, { state: "idle" });
      if (visible.has(email)) request(email);
    }
  }
}

/** An icon's bytes, stored with its fit: a replacement waiting on them is swapped in, and every address showing it redraws. */
function landed(ref: IconRef, url: string, fit: IconFit, epoch: number): void {
  if (epoch !== generation) return;
  const k = dataKey(ref);
  putData(k, url, fit);
  for (const [email, r] of replacing) if (dataKey(r) === k) release(email, { state: "ref", ref: r });
  for (const [email, e] of entries) if (e.state === "ref" && dataKey(e.ref) === k) notify(email);
}

/** icons measured at once: a page of new senders decodes a few at a time, never fifty */
const MAX_MEASURING = 4;
/** `${id}:${v}` → bytes being measured: on their way, not asked for again */
const measuring = new Map<string, { ref: IconRef; url: string; epoch: number }>();
const measureQueue: string[] = [];
let measuringNow = 0;

function measure(ref: IconRef, url: string, epoch: number): void {
  const k = dataKey(ref);
  if (measuring.has(k)) return;
  measuring.set(k, { ref, url, epoch });
  measureQueue.push(k);
  drainMeasures();
}

function drainMeasures(): void {
  while (measuringNow < MAX_MEASURING && measureQueue.length) {
    const k = measureQueue.shift()!;
    const job = measuring.get(k);
    if (!job) continue;
    measuringNow++;
    // measureIcon never rejects: what it can't measure is the whole image as a mark
    void measureIcon(job.url).then((fit) => {
      measuringNow--;
      if (measuring.get(k) === job) measuring.delete(k);
      landed(job.ref, job.url, fit, job.epoch);
      drainMeasures();
    });
  }
}

/** Bytes not here and not on their way: asked for. */
function wantData(ref: IconRef): boolean {
  return getData(ref) === undefined && !measuring.has(dataKey(ref));
}

function request(email: string): void {
  wire();
  const e = entries.get(email);
  if (e && e.state !== "idle") {
    if (e.state === "ref" && wantData(e.ref)) {
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

/** Listens to one address; the last listener leaving drops its snapshot (an unmounted avatar keeps no image alive). */
export function subscribeIcon(email: string, cb: () => void): () => void {
  let set = listeners.get(email);
  if (!set) listeners.set(email, (set = new Set()));
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size > 0) return;
    listeners.delete(email);
    snapshots.delete(email);
  };
}

/** The icon an address shows now (cached until it changes, for useSyncExternalStore). */
export function shown(email: string): ShownIcon | null {
  if (snapshots.has(email)) return snapshots.get(email)!;
  const e = entries.get(email);
  const url = e?.state === "ref" ? getData(e.ref) : undefined;
  const s = e?.state === "ref" && url ? { ref: e.ref, url, fit: fits.get(dataKey(e.ref)) ?? WHOLE } : null;
  snapshots.set(email, s);
  return s;
}

/**
 * The icon for an address, once its avatar is on screen: null until there is one (and while the
 * sources are off). Re-renders only when this address's icon changes.
 */
export function useSenderIcon(email: string, el: React.RefObject<Element | null>, active: boolean): ShownIcon | null {
  const enabled = useApp(iconsEnabled) && active;
  const subscribe = useCallback((cb: () => void) => subscribeIcon(email, cb), [email]);
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

/**
 * Plan 22: never icons in spam (no request to a spammer's site, no borrowed logo on a phish): the
 * Spam view, or a search that is in it (`in:spam`, `en:spam`, `in:"spam"`, the parser's aliases).
 */
export function iconsAllowed(view: string, query: string): boolean {
  if (view === "spam") return false;
  return !query.trim() || parseSearch(query).view !== "spam";
}

/**
 * The same for the rows on screen, by the key they were loaded for (`[view, account, category,
 * review, filter, (folder,) (Gmail tab,) query]`, the query always last): leaving Spam, its rows stay until the next results replace them.
 */
export function iconsAllowedForList(itemsKey: string | null): boolean {
  if (!itemsKey) return false;
  try {
    const key = JSON.parse(itemsKey) as unknown[];
    // the query is the key's last element (plan 68 puts a folder before it, Codex R2)
    const query = key.at(-1);
    return iconsAllowed(String(key[0] ?? ""), typeof query === "string" ? query : "");
  } catch {
    return false;
  }
}

/** tests */
export const __senderIconsForTests = {
  entries,
  data,
  fits,
  visible,
  snapshots,
  request,
  get inflight() {
    return inflight;
  },
  measuring,
  reset: () => [entries, data, fits, visible, batch, dataBatch, snapshots, listeners, refetched, held, replacing, measuring].forEach((m) => m.clear()),
};
