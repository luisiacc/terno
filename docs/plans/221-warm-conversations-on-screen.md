# 221: Conversations on screen are ready before the click

## The request (owner, 2026-11-19)

> ok this works, could we preload this for any visible item in the inbox so its instant seen when i click on that email
>
> it would need to preload things as they come up on the view so we need logic for that, lets also centralize logic so its easily reutilizable, lets also beware of resources usages and performance.

Asked whether remote pictures should be pre-loaded too (fetching one is what tells a sender's tracking pixel the mail was opened), the owner chose **conversations only**: pictures still load only when a mail is opened.

## What exists

- `state/threads.ts`: `loadThread(id)` caches `threads.get` answers (an LRU of 150 details, in-flight requests shared, stale marks after a change). The reader, the menus and compose all read it.
- Two places warm conversations ahead of the user by hand: `keyboard.ts` `move()` loads the next two in the direction of travel, and `select.ts` `extendSelection()` loads the next one. Each repeats plan 24's R12 rule ("no conversation work for threads nobody opened while List's list page is up") in its own words.
- The list is a TanStack virtualizer (`thread-list.tsx`, overscan 10); its `range` is the rows actually on screen.
- Measured on the demo mailbox (web build, machine load ≈ 11), mousedown → the reader showing the conversation: **~55 ms when it isn't cached, ~6 ms when it is.** The HTML frame then shows ~15–20 ms later either way (the frame's parse). Gmail bodies arrive with sync, so a click downloads nothing but remote pictures.

## Design

One module, `lib/warm.ts`, owns warming conversations ahead of a click. Callers say *what* is likely next; it decides *whether, when and how much*.

```ts
/** The rows on screen, top first, and whether the list is scrolling. Replaces the last set; warmed once the list rests. */
export function warmOnScreen(ids: readonly number[], scrolling?: boolean): void
/** The keyboard's next conversations (at most two): warmed now, ahead of what's on screen. Replaces the last ones. */
export function warmNext(ids: readonly number[]): void
/** The list went: nothing waits. */
export function warmNothing(): void
```

- **Gates, in one place.** Nothing is fetched unless a conversation can show (`readerShown()`: R12, List's list page warms nothing) and the window is visible. In List the rows on screen never warm (on its list page by R12; under a conversation's page they're covered); the keyboard's next still do on that page, as today. A hidden window keeps the wanted set and resumes on `visibilitychange`; the listener exists only while work waits (idle means idle). The digest's row (id 0), the open conversation (the reader's to load), cached conversations and ones already in flight are skipped (`threadCached()` from `threads.ts`; a fetch that left before a change doesn't count).
- **Settling.** `warmOnScreen` restarts one 150 ms timer, started only once the virtualizer says the list stopped scrolling (a slow scroll can keep the same rows on screen for longer than the timer); while it scrolls, nothing on screen starts, even as earlier requests land. A fling fetches only the resting screen. `warmNext` skips the timer (the keyboard's next step is ~one key-repeat away), as today.
- **Bounded.** At most 48 on-screen conversations per set (a tall window of compact 32 px rows shows ~45), ordered before trimming; at most 2 requests in flight; queued ids that left the screen are dropped before they start (one in flight finishes; it only fills the cache).
- **Order.** `warmNext` ids first, then on-screen rows from the open row outward (nearest first), else top first.
- **The cache stays bounded and safe** (`threads.ts`). Warming goes through `loadThread`, so the cache's bounds are warming's: 150 conversations, and now also 16M characters of bodies (warming fills it by itself; a conversation's size is counted once per answer, memoised on the object). Eviction drops the oldest but never the open conversation nor the one just answered (until now 150 newer loads could drop the open one, and warming makes that reachable by scrolling: the reader would blank and refetch).
- **No new invalidation path.** A backend change drops changed conversations from the cache and refreshes the list; the list's items change, `ThreadList` calls `warmOnScreen` again and only the dropped ones refetch.
- **Callers.** `ThreadList` reports `virtualizer.range` (rows on screen, no overscan) and `isScrolling` whenever they or the items change (the virtualizer re-renders on both already: no render added), and `warmNothing()` on unmount. `move()` and `extendSelection()` call `warmNext` instead of their own loops, and their R12 checks move into the gate.
- **Privacy.** Only `threads.get`, a read of this Mac's store: no network, no read state, nothing to AI. Remote pictures load only in an opened mail, as before (owner). Spam rows are warmed like any other (a local read; plan "spam triggers nothing" is about AI, filters, learning, counts and offers, and none of them runs).

## Tests

- `lib/warm.test.ts` (unit, fake timers, over the **real** cache with only the RPC and the layout stood in for): settles after the last report and fetches only the resting set, two at a time; scrolling (same rows or not) starts nothing, even as earlier answers land; a fling's middle sets fetch nothing; skips id 0, the open one, cached and in-flight ones; 48 per set, nearest the open row first; ids that left the screen never start; `warmNext` goes first, doesn't wait and replaces; R12 and List's covered list; a hidden window waits on one listener, removed when it shows or when nothing is left (`warmNothing`); a conversation changed while warming is fetched again on the next report, and then served from the cache.
- `state/threads.test.ts`: past 150 conversations or the character budget, the oldest go but never the open one nor the newest; `threadCached` while current or on its way, not once changed.
- e2e `warm.spec.ts` (Split, one page, "Always load remote images" on): the Inbox's rows on screen are fetched, exactly (none of the overscan); warming sends no body download, action or AI call and loads no remote picture; a click on a warmed row opens with no `threads.get`; a fling in All Mail warms only the screen it rests on. `list-layout.spec.ts` R12: the list page issues no `threads.get` at all after it loads (fails without the gate).

## Perf

- No work during scrolling; after a rest, ≤ 48 local reads, 2 at a time. Answers land in the cache map without re-rendering anything on screen (each subscriber selects one id). One exception, a correction: `loadThread` → `syncRow` updates a row whose read, star or categories were stale in the list, re-rendering that row; the list then reports the same screen again and, all cached, nothing more is fetched.
- Gates re-run with warming live: `perf.spec.ts` scrolling, holding j, sustained j.

## Revisions after the Codex review

Codex's critique (8 points), all taken:

1. On-screen warming needs its own gate: `readerShown()` is true on List's conversation page, where the list is mounted but covered. The screen queue is off in List; the keyboard's next still warm there.
2. A range debounce doesn't prove scrolling stopped. `isScrolling` from the virtualizer now holds the timer and stops screen starts.
3. The keyboard queue needed a lifetime: `warmNext` replaces and holds two; `warmNothing()` on unmount clears both, and the visibility listener goes when nothing is left.
4. Invalidation had to be tested against the real cache: `warm.test.ts` runs over `state/threads`, and `threadCached` doesn't count a fetch that left before a change.
5. 24 rows didn't cover compact rows in a tall window: 48, ordered nearest-first before trimming.
6. An entry count isn't a memory bound: the cache also holds at most 16M body characters.
7. `syncRow` can re-render a stale row: noted under Perf as a correction.
8. Counts weren't enough: the e2e asserts the exact ids, waits for them before the click, and checks no hydration, action, AI call or remote picture; R12 now also covers loading the list page.

## Out of scope

- Remote pictures (owner: not pre-loaded).
- IMAP bodies not yet downloaded (`bodyState: "none"`): they're fetched from the server on open, as today.
- What matters' feed items, and List's list page (R12) warm nothing.
- Pre-rendering mail frames (memory per frame, for ~15 ms).
