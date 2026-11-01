# Plan 105: unread counts on Archive and Spam

## Request (verbatim)

> these folders need to say how many unread messages they have inside, should be light gray numbers on the far right of the line

(The screenshot showed an account open in the sidebar: Inbox, Sent, Archive, Spam, Trash, Promotions, Social and the account's own folders.)

## What existed

The Inbox (plan 67), Gmail's Promotions and Social (plan 86) and an account's own folders (plan 68) already showed their unread threads on the right of their row, muted (`NavItem`'s `nav-count`). Sent, Archive, Spam and Trash showed nothing, at the top or under an account.

## Design

- **Archive and Spam count; Sent and Trash don't.** A thread in Sent with an unread reply is already the Inbox's count; a trashed message is never unread (recompute counts only messages outside Trash), so Trash's count would always be zero.
- **Counts:** `Counts.viewUnread`, by `viewRef(accountId, view)` ("1:archive"), for both stores. A thread counts where its list shows it (the views' own tests: Archive is out of the Inbox, Trash and Spam; Spam is in Spam and not in Trash).
- **SQLite:** a tally (`view_unread`, migration v41) kept by triggers on `threads` (insert, delete, and updates to account, unread, Inbox, Trash and Spam that move a thread between slots), as `folder_unread` is for own folders. Counts read one row per account and folder. Counting the unread index on every refresh would cost about 0.25 µs per unread thread (about 12 ms with 50k unread archived threads). The mail already there is tallied after the open, a slice of threads at a time by id, in the backend's folder rebuild runner (`rebuildFolders`); the triggers count only threads at or below the slice cursor, so each thread is counted once, and the counts show none until the tally is done.
- **IndexedDB:** `getCounts` already walks every thread for the Inbox's count; the walk adds Archive and Spam for unread threads.
- **Sidebar:** an account's Archive and Spam show its counts (props as numbers, so `AccountEntry` stays memoized); the top-level Archive and Spam (behind More) show all accounts' together. Muted, like every count but the Inbox's.

## Tests

- `store/conformance/view-unread.ts` (both stores): per-account counts where lists show them; archive, read and trash move them.
- `db/view-unread.test.ts`: the tally matches a direct count through random churn of each column alone, deletes and a removed account (each trigger column dropped fails it); an upgrade from v40 does no tally in the open, then tallies a slice at a time, exact through writes on both sides of the cursor, a delete and a late insert, with no counts until done (dropping the cursor gate fails it).
- `e2e/account-folders.spec.ts` (`@design`): an open account's Archive and Spam show their counts, Sent and Trash none, the top Archive and Spam all accounts'; a read from the backend takes one off.
- Perf: the sidebar counts gate is unchanged against HEAD (p50 2.59 vs 2.55 ms); ingest throughput holds.

## Out of scope

Counts on Sent, Trash and All Mail; total (not unread) counts.

## Codex review

One finding, fixed: the migration's one-pass tally held the open on a large mailbox (about 0.5 s at 500k unread threads). It now runs in budgeted slices after the open (60k unread threads: open 16 ms, slices p50 0.2 ms, max 9 ms on a loaded machine), covered by `view-unread.test.ts` and the folders migration perf gate, which now times these slices too.
