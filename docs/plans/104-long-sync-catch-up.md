# Plan 104: a long first sync stays within its window

## Report (verbatim)

> can you cehck this, they say 0days left, waht's going on there, debug this and fix it

## What was wrong

The card's "0 days left" was a symptom. The accounts' saved reconciliations had `after: 0`: they were listing **all mail** (the profile held mail back to 2018 for a 180-day window). A first sync under Gmail's quota (plan 62) lasts hours; its final catch-up replayed history from the sync's start and overflowed (`HISTORY_TOTAL_REFS`); the overflow recovery (and its restart marker) then re-listed **all mail without a date** (plan 26's choice, to keep older imported messages), which under the quota takes days and overflows again. Days left were counted to the window while the listing went past it, so they were 0.

## Fix

- **Catch up from the refresh, on a long sync.** A reconciliation running over `LONG_SYNC_MS` (10 min) reads new mail as its refresh begins and records `refreshFrom`: the catch-up replays history from there. Sound because the refresh reads every stored message's state (a deleted one answers 404) and the look at new mail read every addition before it (as live mail). A look that lost history (`gap`) keeps the catch-up at the baseline. A short sync is unchanged.
- **An overflowing catch-up after such a refresh reads the flags again** (a new cut), the cheap part, instead of listing the window again.
- **Recoveries keep the window.** Overflow and restart markers list the account's window, never all mail. A saved `after: 0` listing (from before) goes on within the window from its start; a first sync legitimately running for days keeps its own window and place.
- **The card** counts days to where the listing stops (`SyncProgress.since`, from the provider), and past it, or with no date, shows how much is here ("1,950 so far"), never "0 days left" while mail still comes.

## Trade-off (decided)

An older message imported into Gmail with a date before the window, added while history was unavailable (an overflow or expiry gap), isn't fetched: no listing reaches it and no history names it. The all-mail recovery covered that, but couldn't finish under the quota and looped. Normal history (no gap) still fetches such imports whatever their date.

## Tests

`gmail-first-sync-arrivals.test.ts` (long sync catches up from the refresh; short keeps its baseline; a gap keeps the baseline; convergence: an arrival before the refresh, a label changed, a message deleted; an overflowing catch-up re-reads flags without re-listing; all-mail listings clamped, multi-day ones not), `first-sync-pill.test.ts` (days to `since`; "so far"), `gmail-catchup.int.test.ts` (the overflow recovery lists the window).

## Codex review

Four findings: refresh-era history could still overflow forever (now: re-read flags, not re-list); the clamp reset legitimate multi-day syncs (now only `after: 0`); the trade-off needed recording (above); the tests didn't prove convergence (added). Each with a test that fails without it, the trade-off by its recovery test.
