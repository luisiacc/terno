# Plan 227: changes during a Gmail first sync

## Request (verbatim)

> Bug 1: mail you send to yourself doesn't reach the Inbox until the first Gmail sync finishes
>
> **Repro:** connect a Gmail account. While the first sync is still downloading (the "Downloading your mail · The last 30 days" card is showing), send a message to the account's own address. Gmail labels that one message INBOX and SENT. Terno doesn't list it in the Inbox, and doesn't offer Archive on it, until the first sync ends. For 30 days of real mail that's about 15–30 minutes, since Gmail reads are paced at about 85 messages a minute and then every message's labels are re-read.
>
> Expected: a message the user sent, or any message that changes on the server, shows its current labels within the normal new-mail delay, even during a first sync. Constraints: documented Gmail API behaviour only; respect the read pacing and quota; don't block the backend loop (plan 112 slices); keep the 50k perf gates green; read plans 102 and 103 first; check whether IMAP has the same gap, and decide whether it's in scope.

## What exists (verified)

- A send stores the local copy under Gmail's id as soon as Gmail accepts it (`sql-store.ts` `ops.complete`; the IndexedDB store the same). Gmail's answer carries the id, not the labels the message ends with: a message to yourself gets INBOX when Gmail delivers it, which history records.
- During a first sync (a reconciliation, plan 102) each chunk starts with `peekArrivals`: history since the last look, asking only for `messageAdded` and `messageDeleted`, downloading what isn't stored as live mail. A stored message (the sent copy) is skipped, and label changes aren't asked for at all.
- The send's flag snapshot (`requireGmailRefresh`) is skipped while the reconciliation is listing (`coveredByEnumeration`): the refresh stage reads every stored message's labels later anyway. So nothing reads the sent copy's labels until the refresh stage reaches it, then the catch-up replays history from the baseline.
- The same holds for any message already downloaded and then changed elsewhere (archived on the phone, starred on the web): its labels wait for the refresh stage, which on a large mailbox is many minutes to hours away.

## Design

The look at new mail during a reconciliation also reads label changes, the documented way the ordinary pass reads them (`users.history.list` with `historyTypes` `labelAdded` and `labelRemoved`, then `messages.get?format=minimal` for each changed message's `labelIds`):

- **One history read, four types.** `peekArrivals` asks for `messageAdded`, `messageDeleted`, `labelAdded`, `labelRemoved` (the catch-up's set). Same pages, same bounds (`HISTORY_PAGES`, the 256 KB page cap that turns into a gap), same cursor (`peek`).
- **What's stored and changed is read again.** A message history names (added or relabeled) that is already stored, wasn't deleted in the same look, and wasn't downloaded by this look, has its labels read (`format=minimal`, 20 units) and applied through `sink.updateFlags`, the path the catch-up uses (flag intents and barriers decide as they do there). The sent copy is such a message: history reports it added, it's stored, so its labels (INBOX, SENT) are read and it appears in the Inbox.
- **Bounded.** At most `PEEK_RELABEL` messages a look (see the revisions: 250, about a chunk of reads), the added-and-stored ones (the user's own sends) first, then the latest changes. Correctness never depends on the bound: the refresh stage reads every stored message's labels and the catch-up replays history from the baseline (or from `refreshFrom`, set after the peek it follows), so a change the bound skipped is applied there, as today. A bulk change elsewhere (5,000 archived on the web) costs one look's share instead of stalling the download for twenty minutes.
- **Deletions stay the catch-up's**, as plan 102 decided: a 404 on a label read is left for it.
- **The shared part.** The catch-up's "read these messages' labels again, 50 at a time" loop in `incremental` becomes a helper (`relabel`) that both use; it takes the id lookup and what to do with a 404 (the catch-up removes, the look leaves it).

Delay: a change appears within the look that follows it, that is within one first-sync chunk (about a minute: a chunk is `FIRST_SYNC_CHUNK_MS` checked between batches), the same delay plan 102 gave new mail during a first sync.

The flag-snapshot skip during enumeration stays: a snapshot read right after the send would race Gmail's delivery to the Inbox; history is the documented record of when INBOX was added.

## IMAP: out of scope

IMAP has a smaller, deferred version of the gap, not this one. A message to yourself is two messages there: the server delivers its own copy into INBOX (a new UID) and the Sent copy is appended. A first IMAP pass reads INBOX first (plan 79's preview) and isn't quota-paced. A copy that lands after INBOX was read waits for the next pass: IDLE or the poll only queue one, they can't interrupt the pass, which reads the other folders first (minutes, not the Gmail first sync's half hour). Flags are read every pass, and nothing waits for a late stage like Gmail's refresh. Splitting IMAP's first pass into chunks with a look at INBOX between them is its own change, left out.

## Tests

`gmail-first-sync-arrivals.test.ts` (fails without the fix):
- a message stored by a send (its id stored before the look) that history reports added has its labels read during the first sync's next chunk, while the listing is still enumerating; updateFlags carries INBOX.
- a stored message relabeled elsewhere (`labelsAdded`) is read again in the next look; one not stored is not read; one deleted in the same look is not read.
- at most 50 a look, the newest first, sends ahead of relabels; the rest are left (the look's cursor still advances).
- a 404 on the look's label read removes nothing.

The fakes that told the look from the catch-up by its history types (`gmail-first-sync-arrivals`, `gmail-catchup.int`, `gmail-refresh-invocation.int`, `incoming-admission`, `durable-message-repair.int`) learn the new shape. `gmail-history-expansion`, `gmail-history.perf` (catch-up) unchanged.

## Performance and resources

- A look with nothing new costs what it did: one history read (2 units). Label changes add at most 50 minimal reads a chunk, paced like every read; the download behind it slows by at most that.
- Store lookups for changed ids yield every 50, as in `incremental`. Memory: the look's sets as before plus one of changed ids, bounded by `HISTORY_PAGES` × 500.
- `gmail-batches.perf.test.ts` and `gmail-history.perf.test.ts` stay green (the download and catch-up paths are unchanged apart from the helper).

## Out of scope

- Deletions during a first sync (the catch-up's, plan 102).
- The flag-snapshot skip during enumeration (`gmail-refresh.ts`): unchanged.
- IMAP (above).

## Revisions after the Codex review

Codex read the plan against the code (eight points); each changed the design or the tests:

1. **The bound delayed what it skipped** to the refresh, contradicting "the next look". The share is now about a chunk of reads (`PEEK_RELABEL` = 250: 5,000 units, a minute at the pace) and the plan says plainly that what's past it in one look (a bulk change elsewhere) waits for the refresh and the catch-up as before. Test: 300 stored changes and a send, 250 read.
2. **A send waited behind the look's downloads** (500 new messages are minutes). Sends' labels are now read before the look downloads new mail; other changes after it.
3. **The look's page limit and a repeated page token returned without moving on**, so every chunk read the same history again. They (and a reference total past `HISTORY_TOTAL_REFS`) now start the look again from the profile's id with `gap`, as an expired history does. Tests: a repeated page, too many references.
4. **Memory bound**: a page holds up to 2,000 references, and the look had no total. It now stops at `HISTORY_TOTAL_REFS` (10,000, as the catch-up) and yields between pages; store lookups yield every 50. New perf case in `gmail-history.perf.test.ts`: a look over 10,000 references within the 15 ms slice budget.
5. **"Newest" was first occurrence.** A changed id moves to the end when it changes again; ids not stored or deleted don't take a share. Test: an id changed first and again last is read; 40 unstored changes don't count.
6. **IMAP wording**: it has a deferred gap (above), not normal-delay delivery.
7. **Fakes couldn't show Inbox membership or the flag barrier.** New integration test in `gmail-catchup.int.test.ts`, SQLite and IndexedDB: a real send through the worker while the first sync is still listing, Gmail then delivers it (labels added), the next look puts it in the Inbox; archived here before the archive reaches Gmail, a later look reading INBOX leaves it archived while a star from elsewhere lands.
8. **Failures mid-look**: a failed label read or a failed write leaves the look's cursor where it was, and the next pass reads the change again (test).

Also: the fakes that told the look from the catch-up by its history types (`gmail-catchup.int`, `gmail-refresh-invocation.int`, `incoming-admission`, the arrivals fake's overflow) now tell them apart by order or count; `gmail-refresh-invocation`'s history case reads the admitted message once more (the resumed refresh's look).

## Codex code review

One finding, fixed with a test that fails without it: **a send whose INBOX came a look later lost its place.** The first look read the send's labels (SENT only); when Gmail then added INBOX, the next look saw a label change and read it after its downloads (minutes behind 500 new messages), or not at all behind 250 newer changes. Stored messages from your own address (`fromEmail`, which the store's lookup already gives) now go with your sends, before the downloads, whether history added or relabeled them. Test: SENT in one look, then INBOX with a hundred arrivals and other changes in the next: your send's labels are read before any download.

## Tests run

Typecheck (store, mail, backend, db, idb) and lint on the touched files. Unit and integration: `gmail-first-sync-arrivals`, `gmail-history-expansion`, `gmail-quick-pass`, `gmail-history-bounds`, `gmail-history-ownership`, `gmail-backfill`, `gmail-refresh`, `gmail-flag-snapshots`, `gmail-catchup.int`, `gmail-refresh-invocation.int`, `gmail-deletion-observation.int`, `incoming-admission`, `durable-message-repair.int` (IndexedDB), `backfill-requests`. Perf: `gmail-history.perf.test.ts` (both cases) and `gmail-batches.perf.test.ts` pass.
