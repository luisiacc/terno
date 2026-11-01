# Plan 102: new mail during a first sync

## Request (verbatim)

> while the initial sync is happening, i think we are not fetching the new email, lets do that even while initial sync is running

## What existed

A Gmail first sync (a reconciliation: list the window, download, read every flag again, then catch up history from its baseline) was one pass. Under the per-user quota (plan 62: about 100 messages a minute) a large mailbox's pass lasts hours, and new mail, with its notices, waited for the catch-up at its end. IMAP is not quota-bound and its first pass is minutes; it is unchanged.

## Design

- **Chunks.** The reconciliation runs about a minute a pass (`FIRST_SYNC_CHUNK_MS`), checked between download batches and refresh pages; a page cut short is listed again next pass (its stored messages skipped). The provider calls `sink.again()`, and the core starts the next pass a second after this one ends (the backfill's continuation, plan 101).
- **New mail first.** A resumed reconciliation first reads history since its baseline (then since its last look, `Reconciliation.peek`): added messages not stored yet are downloaded as live mail (they notify); deletions there are skipped. Flags, moves and deletions stay the final catch-up's, which skips what this stored. History gone or overflowing: the look starts again from the current profile id (the gap is the catch-up's), never the same dead cursor every chunk.
- **The listing too.** A message the listing finds whose Gmail receive time (`internalDate`, never a fallback date) is after the sync began (`Reconciliation.startedAt`) is new mail as well: it notifies.
- **Still a first sync.** A pass that ends with more to do leaves the account `syncing` with no `lastSyncAt` (also when the host went offline meanwhile), so "Downloading your mail" stays until the reconciliation really ends.
- **Announced after a failure.** A pass that fails retryably primes the account's notices (what it brought is in), so a failed first chunk doesn't leave the retry's new mail unannounced.

## Tests

`gmail-first-sync-arrivals.test.ts` (chunk stops between batches and resumes; new mail first, live; catch-up doesn't download it twice; the look's cursor resumes; a listed arrival is live; history gone moves the cursor), `backfill-requests.test.ts` (between chunks: still a first sync; the next chunk starts itself; offline keeps it; a failed first chunk primes). Strict Gmail fakes (`gmail-outcomes`, `gmail-catchup`, `gmail-refresh-invocation`) learned the look's request shape (added/deleted history only); their catch-up assertions are unchanged.

## Codex review

Five findings, each fixed with a test that fails without it: the chunk was checked only after a whole page (about six minutes under the quota); an arrival the listing met was ingested as old mail; a failed first chunk left the retry's arrivals unannounced; the offline branch set `lastSyncAt` mid-sync; an expired look kept retrying its dead cursor.
