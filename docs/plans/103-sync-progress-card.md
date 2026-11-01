# Plan 103: the sync card's progress

## Request (verbatim)

> lets make this little section here show a caret on hover, if you click the card it expands(with a nice transition) and it shows how much is left for each, if we can't say a number lets say how many days left are to sync, i think we can calculate this), of course user should be able to collapse it as well, lets show there some nice progress bards with some kind if animation inside them, but they should be fairly thin and look nice and premium, clean.

## Design

- **The card** (`first-sync-pill.tsx`): its head is a button (`aria-expanded`, `aria-controls`); a caret shows on hover, while open, and when reached with Tab. A click opens the panel (the sidebar's grid-rows 0fr→1fr transition, `duration-base`) to a row per account still syncing (first syncs and backfills, plan 101): its name, what's left (short; the full sentence is the bar's `aria-valuetext`), and a 3 px bar (`role="progressbar"`) with a soft light passing along it (`sync-sheen`, in motion tokens; off when motion is reduced or off, like every animation). A click closes it.
- **What's left** (`syncLeft`): messages left of a total (Gmail: "~4,321 left", from Google's `resultSizeEstimate`), folders left (IMAP: "3 folders left"), else days left (the oldest mail reached, newest first, to where the sync stops: the window's start, or the backfill's), "Finishing up" while a first sync reads its flags again, "Starting" before anything is known. Numbers in Terno's language.
- **Progress** (`AccountSyncState.progress`): providers report through `sink.progress`; the core writes it at most every 2 s (a change of phase at once), keeps it between chunks and while a backfill is pending, and clears it when the sync is done. Gmail counts what its pages held (`Reconciliation.listed`, `BackfillProgress.listed`); a total is Google's estimate while it's beyond the pages listed, exact on the last page, else none (never "0 left" with more to come). IMAP counts folders, on a first read (a regular pass says nothing) and in a backfill.

## Codex review

Six findings, each fixed with a test that fails without it (the IMAP count is a set, by inspection): pages assumed full; an underestimate showed "0 left" too early; "Finishing up" held back by the throttle; an IMAP count that scanned the done list per report; a pending backfill's progress cleared between retries; numbers in the system's locale.

## Tests

`first-sync-pill.test.ts` (labels, es), `gmail-first-sync-arrivals.test.ts` (estimate, partial pages, underestimate, finishing), `backfill-requests.test.ts` (kept between chunks, cleared when done, finishing at once, pending backfill), `imap-backfill.int.test.ts` (folders on a first read), `sync-progress.spec.ts` (caret on hover, open, labels, axe, light/dark, close).

## Performance and resource review of the first sync (the user's ask, after the card)

What plans 101–103 add to a long first sync, checked:

- **Live progress was an accounts event every 2 s.** Every component that reads the account list (the open message, the composer, the thread list when scoped to an account, the sidebar) re-rendered each time, for hours. Now live progress is its own `syncProgress` event into its own small store (`state/sync-progress.ts`) that only the card reads; the account's state saves it only with the pass's own writes (a chunk's end), and the end of a pass sends one event only for an account that showed progress. Test: a pass reporting 120 times sends as many accounts events as one reporting once.
- **The bars' light ran while the card was closed** (its panel stays mounted for the transition). It's paused while closed: nothing animates out of sight. The loop is in motion tokens and off when motion is reduced or off.
- **Throttle without timers.** Progress is written at most every 2 s by comparing `performance.now()` (a change of phase at once); no trailing timer exists, so an idle account keeps no timer.
- **Chunks.** A first sync's chunk (~60 s) and a backfill's (~30 s) add per pass: one history read (2 quota units), the cached label check, two small state writes and their accounts events, and one unref'd continuation timer per account. Against a minute of downloads that's well under 1 %. Done: no timer, no continuation.
- **Hot path.** The download path adds, per message, a min-date comparison and a `Map.set` of its receive time (cleared per batch of 50). The 50k-message and 50k cached-refresh perf gates pass (`gmail-batches.perf.test.ts`); one failed once inside a fully loaded run and passed five times alone.
- **Memory.** The look at new mail holds at most `HISTORY_PAGES` × 500 ids; a batch's receive-time map at most 50 entries; progress is a few numbers an account.
- **IMAP.** Folder progress counts with a set (no scan per report); IMAP's first sync reports a folder at a time.
- **Gates.** `pnpm test:ui-perf`: 33 of 34 pass; the failing one ("toggling More with 80 categories") fails at setup with "Category identity is retired or invalid", the same without these changes (other work in progress on category identities).
