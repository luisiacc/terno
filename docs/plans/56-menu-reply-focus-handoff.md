# 56 · Reply never silently does nothing

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

## Revisions after the Codex review

Codex had six findings. Its analysis of the quick-reply bar gave the most likely cause of the user's report:

- **A refresh mid-open cancels the reply silently (#2).** Any change to the open conversation (its read state, a sync, a send landing; the user's screenshot followed a send) refetches it. If that lands while the quote is being measured, `loadThread(threadId) !== detail` returns. Now `openComposeNow` reports `"stale"`, and `openCompose` retries with the refreshed conversation (twice at most) when nothing newer was asked for.
- **Failures with no message (#3, #4).** A failed thread load and a failed `drafts.sourceContext` returned silently. While the request is still current they now report `"failed"`, and the user sees "Couldn't start the reply. Try again." (or the forward version, in `en` and `es`). A request superseded by a newer choice stays silent.
- **The menu callback opted out of Base UI's guard (#1).** A `finalFocus` callback skips Base UI's "focus already moved elsewhere" check, so the callback now applies it itself. With the modal context menu that move can't happen by pointer, so the check is defensive.
- **A refused menu reply left focus on the page body (#5).** When the reply didn't open (judged from the drafts store, since the editor may focus a frame later), focus goes back to the list.
- **Coverage (#6).** The e2e now covers Reply, Reply all (body focus) and Forward (To focus) from the menu, plus a plain close that still returns focus to the list after a hand-off.

Found on the way: **the React Compiler miscompiled a reassigned module-level `let`**. In `const handedOff = focusHandedOff; focusHandedOff = false; if (handedOff) …` it folded the copy into the later read, so the build cleared the flag and then read it. The flag is now a property on a module-level object.

Tests:

- `open-compose-outcome.test.tsx`: a mid-open refresh retries and opens; source-context and load failures show the message; a superseded request stays silent. The first three fail without the fix.
- `selection.spec.ts`: the three menu tests fail against main's menu and pass 150 of 150 across the designs (twice each).

Round 2 found two more problems (both P2):

- **A retry could pull focus back after the user moved on.** Moving focus invalidates the lease but not `intent`, so a `"stale"` retry could take focus back into a composer (and a failure could show a message) after the user went elsewhere. An outcome now counts only while the lease is still held (`stillAsked`).
- **A stored draft opened in the reader pane wasn't recognized as opened.** Such a draft (its source moved) didn't count, so the menu's fallback could focus the list and cancel the pane's focus. `replyOpened()` now counts a change in the reader pane too.

Tests:

- `open-compose-outcome.test.tsx`: after the user focuses another control mid-open, neither a stale nor a failed open retries, takes focus or complains. Both fail on the round-1 code.
- `replyOpened` is unit-tested for the inline and reader-pane cases.
- `focus-ring.spec.ts` now waits for focus to settle after Esc before reading it (it was flaky in Lumen).
