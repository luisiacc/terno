# 55 · Reply from the context menu always opens

## Request

> clicking on the reply here doesn't work at all, fix this please

(A screenshot of the reader's quick-reply bar, "Reply to Mei…", with Reply all and Forward. Its focus ring shows that focus had just been moved there by the app.)

## What I found

- Clicking the bar works in every sequence I tried on current main: fresh, after `r`/Esc, after send (button and Cmd+Enter), after discard, and after leaving the thread and coming back.
- The user's app is the dev Electron (`Terno-dev-demo`, renderer up since 15:41). It hot-reloads the main checkout's live files, including another session's in-progress edits to `lib/compose.ts`, whose module state (`focusLease`, `intent`) doesn't survive hot updates. A reload should clear that state.
- A real way for Reply to silently do nothing reproduces on committed code: **Reply, Reply all or Forward from the thread context menu.**
  - `openCompose` takes a focus lease, and the lease gives up when focus moves elsewhere.
  - When the menu closes, Base UI hands focus back to its trigger (the list). That usually lands while the reply is still loading, so the lease reads it as the user moving on, and `openComposeNow` returns before any draft exists.
  - It failed 4 of 6 runs in isolation and in every full e2e run: the pre-existing `selection.spec.ts` "reply from the menu opens the composer" failure.

## Design

The menu items that move focus themselves (Reply, Reply all, Forward) set `focusHandedOff`. The menu's `finalFocus` returns false for that one close, so the menu doesn't hand focus back and the composer takes it. Other items, and closing with Esc or a click outside, still return focus to the list.

Waiting for `onOpenChangeComplete` was tried first. Base UI fires it before the focus hand-back, so the reply was abandoned every time.

## Tests

- `selection.spec.ts`: a new `@design` case replies from the menu on three rows in a row. Each time the composer must open with focus in the body, and the list must receive no focus from the menu on. It fails 3 of 3 without the fix and passes 12 of 12 across the designs.
- The existing "reply from the menu" case now passes.

## Out of scope

The focus-lease design itself (plan 43, owned by ongoing work): a focus move during an open cancels the whole open rather than only its focus step.
