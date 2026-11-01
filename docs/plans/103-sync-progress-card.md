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
