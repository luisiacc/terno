# 266: an IMAP account's new Inbox mail arrives first, whatever another folder does

## Request

> look for other possible issues that could cause email not getting fetched … then fix them all, that is the most
> important part of an email client is to actually receive the email

(the owner, 2026-11-24, after plan 262). Two read-only audits found three IMAP issues; this plan takes them.

## What exists

`packages/mail/src/imap.ts`, `sync()`: one pass on one command session.

1. `LIST`, roles, folder records (plans 68, 107), `setFolders`.
2. A `STATUS` per known custom folder (plan 68) to choose which to read (up to 10,000).
3. **Sweeps** (plan 68, Codex R5): for every role mailbox in `boxes` (Inbox, Sent, Archive/All, Junk, Trash), then every
   chosen custom one, `sweepMailbox`: `SELECT`, `UID SEARCH ALL`, journal and remove what's gone, `UID FETCH FLAGS` of
   every known UID. They run first so a message another app moved between folders has lost its old place before its
   new one is read, and is recognised (plan 114 adopts it) rather than held.
4. **Reads**: `syncMailbox` for every box, then every custom folder: `UID SEARCH uidnext:*`, envelopes, `ingest`.
5. Reconcile, save the cursor, `syncBodies` (up to `bodiesPerSync ?? 500` bodies, one `UID FETCH BODY[]` at a time),
   backfill (plan 101).

Custom folders are wrapped in `tolerate`: a non-retryable failure sets `incomplete` (vanished folders, deletions and
renames wait; `full` is false, so orphans are kept and `fullCheck` makes the next pass read every folder). The role
boxes are not wrapped.

The IDLE session (`watch`) selects INBOX; an `EXISTS` calls `onChange`, which the backend turns into
`syncAccount` → `syncAgain` while a pass runs (`core.ts`), so the next pass starts when the running one ends.

## Findings, checked against the code

### 1. A role folder that fails, or is large, stops or delays the Inbox: confirmed

`for (const path of boxes) swept.set(path, await sweepMailbox(...))` has no `try`. `SELECT Sent` answered `NO`
(RFC 3501 §6.3.1 allows it for any mailbox: permissions, a damaged mailbox on the server) throws out of `sync()`
before any `syncMailbox`, every pass, so the Inbox is never read again until the server changes. A refusal the server
calls temporary (`NO [UNAVAILABLE]`, RFC 5530) fails the pass the same way, before the Inbox. And with every folder
readable, the Inbox's new mail waits for a `STATUS` per custom folder and a `SEARCH ALL` plus a flags fetch of every
known UID in every swept folder: with large folders, seconds to minutes.

### 2. Up to 500 sequential body downloads delay the next envelope check: confirmed

`syncBodies` takes `pendingBodies(bodiesPerSync ?? 500)` and awaits one `UID FETCH BODY[]` plus processing per item.
An `EXISTS` on the IDLE session during that only sets `syncAgain`; the new message is looked for when all of them are
done. After a first sync or a backlog, at a second each, that is over eight minutes before a new message shows.

### 3. Custom folders past the catalog cap are never synced: confirmed, deferred

`customFolders` keeps at most `FOLDERS_PER_ACCOUNT_MAX` (10,000) of at most `2 × 10,000` listed, and the pass reads
only catalogued folders. Mail a server rule files into an omitted folder is never fetched. Deferred: a message's only
place would be a folder the store doesn't list, and plan 68 makes a location in a listed folder the membership (a
location outside the catalog is in no view, and the store's folder counts and views key on the catalog). Reading those
folders needs a model for mail whose folder isn't shown (an "other folders" bucket, or a catalog that rotates), which is
a refactor of the folder catalog, not a change to sync. It also needs 10,000+ folders, which no account we know has.

## Design

### Inbox arrivals first (finding 1)

Right after the folder records are settled and before the `STATUS` loop and every sweep, a pass whose Inbox has a
cursor reads the Inbox's new UIDs: `syncMailbox(..., { arrivals: true })`. It is the ordinary read with two limits:

- It runs only on a mailbox with state under the same `UIDVALIDITY` (no first read, no reset: both stay in the ordered
  read after the sweeps, Codex R11), and searches `UID uidnext:*` as the ordinary read does.
- It ingests only mail with **no stored twin** (no Message-ID match, no envelope twin): anything that may already be
  here is left to the ordered read, and its candidates go into the pass's `seen` (plan 107's deletion evidence). An
  exact locator already stored only has its flags refreshed. (Revised after the Codex critique, #1 and #2.)
- It **acknowledges nothing**, like the plan 79 preview: no `uidnext`, no snapshot written. The ordinary read after
  the sweeps reads the same UIDs again; what the arrivals read stored is found by its location (`locations.at`) and only
  its flags are refreshed. A pass that stops in between reads them again next time, the same way; nothing is lost and
  nothing is announced twice (`live` ingest happens once, when the message is new).

Identity stays safe. A message another app moved into the Inbox has a stored twin, so the arrivals read leaves it;
the ordinary read after the sweeps meets it and plan 114 adopts it, as today. Only mail with no stored twin is ingested
early, which is what the ordinary read would ingest too.

Cost: the new UIDs' envelopes are fetched twice a pass (only new Inbox mail, usually none: one `SELECT` and one
`UID SEARCH`).

### Every other folder isolated (finding 1)

The role boxes other than the Inbox get the custom folders' `tolerate` around their sweep and their read: a refusal
(`NO`/`BAD`, not temporary) marks the pass `incomplete` and the rest goes on. `incomplete` already keeps every piece
of move and deletion evidence (vanished folders, deletions, renames wait; orphans kept; `fullCheck` set) until a pass
reads every folder, and the folder is tried again every pass. A temporary refusal or a dead connection still ends the
pass (the server asked us to wait; the backend retries with its backoff), but the Inbox's arrivals are already stored.
The Inbox itself stays unwrapped: a failing Inbox fails the pass, as now.

### Bodies yield to an arrival (finding 2)

The provider counts the IDLE session's `EXISTS` (and a restored push, which stands for whatever arrived meanwhile).
The pass notes the count when it **starts** (Codex critique #7: an `EXISTS` between the Inbox read and the bodies
counts too) and `syncBodies`, after each body, stops if it changed: the pass ends, the backend's `syncAgain` runs the
next one at once, and that pass reads the arrival first; its body is among the newest, which `pendingBodies` returns
first. At least one body is fetched per pass, so a flood of arrivals can't stop bodies. No timer, no polling: the
signal is the IDLE event that already exists. A server without IDLE has no event and keeps today's behaviour.

Backfill (plan 101) is left as it is: a pass gives it at most `BACKFILL_CHUNK_MS` (30 s), and pausing it on arrivals
would multiply its pauses, each of which forgets the run's `introduced` set and arms a second wake-up (Codex critique
#9, #11).

### A mailbox the body run can't open (Codex critique #4)

`syncBodies` opens each mailbox with pending bodies. A Sent the server refuses (not temporarily) now skips its group:
its bodies stay pending, the other mailboxes' bodies and the rest of the pass go on. A temporary refusal or a dead
connection still ends the pass.

## Tests

`packages/backend/src/imap.int.test.ts` (real imapflow ↔ ImapKit through the Backend):

- `SELECT Sent` answered `NO [NOPERM]` (non-retryable): a new Inbox message and a new Archive message are stored; the
  pass completes; a message expunged from Sent meanwhile isn't removed until Sent can be read; once `SELECT` works, the
  next pass removes it. Fails on the old code (nothing stored).
- `SELECT Sent` answered `NO [UNAVAILABLE]` (temporary): the pass fails, and the new Inbox message is stored anyway.
  Fails on the old code.
- A Sent body left pending, then `SELECT Sent` refused: the pass ends without an error, the Inbox body is fetched, Sent's
  stays pending, and comes once Sent opens. Fails without the `syncBodies` change.
- A message another app moved from Archive into the Inbox keeps its row, thread and body, beside a new Inbox message.

`packages/backend/src/imap-idle-foreground.int.test.ts` (IDLE fixture):

- Bodies pending for many messages, each `UID FETCH BODY[]` slowed by the fixture: an `EXISTS` on the IDLE session
  during the body run stops it after the current body, the next pass stores the new message, and every body is still
  fetched in the end. Fails on the old code (the arrival waits for every body).

## Perf

No hot path gets slower: the arrivals read is one `SELECT` and one `UID SEARCH` of the Inbox a pass. `folders.perf`
and the IMAP perf gates are unchanged in what they time; run `packages/mail/src/folders.perf.test.ts`.

## Revisions after the Codex review (plan critique, 12 points)

Taken:
- #1, #2: the early read ingests only mail with no stored twin and never adopts; candidates go into `seen`.
- #4: a mailbox `syncBodies` can't open keeps its bodies pending; the rest goes on (test above).
- #7: the arrival baseline is the pass's start, shared by both body runs of a first sync.
- #9, #11: answered by leaving backfill alone (above).

Not taken, with the reason:
- #3 (an expunge between `UID SEARCH` and `UID FETCH` fails the pass with `listRefused`): already so for the ordered
  read; the next pass's search no longer has the UID. The early read adds a second, equally short window. A tolerant
  FETCH is its own change to every read.
- #5 (a role folder that refuses its *first* read lets the pass stamp `lastSyncAt` and `syncedSince`): the same as a
  custom folder that refuses today; the folder is read again every pass, and nothing it holds is lost. `fullCheck` only
  matters with orphans, which `full = false` already keeps.
- #6 (an Inbox `UIDVALIDITY` reset, or a first sync, behind a temporary refusal of another folder): a first sync's
  sweeps open nothing (no state) and its preview runs before any role read; a reset keeps its ordered read (Codex R11)
  and is rare. Left as is.
- #8 (a new message with an old `Date` header may rank outside the 500 newest pending bodies): its envelope is there;
  its body comes in a later pass. Ranking bodies by arrival is a store query change (both stores), out of scope.
- #10 (backfill gives up on a folder after three refusals): the same rule plan 101 gives every folder; before this
  plan a refused Sent stopped the whole account instead.
- #12 (an IDLE rerun after a temporary refusal skips the backoff): `core.ts` scheduling, plan 263's area. Each rerun is
  caused by one `EXISTS`, so it is bounded by arrivals, and it now stores them.

## Codex code review, round 1 (8 points)

Fixed, each with a regression test that fails without its fix (`imap.int.test.ts`, "plan 266"):
1. **UIDNEXT acknowledged past what was read** (pre-existing, high). imapflow raises `mailbox.uidNext` past any UID a
   FETCH names (`tools.js`), an unsolicited one included (RFC 3501 §7.4.2): mail that arrived after the Inbox's SEARCH
   and that another app flagged at once was acknowledged unread and never fetched. `syncMailbox` now acknowledges
   through UIDNEXT as SELECT gave it and what its SEARCH found (a SELECT without UIDNEXT, which RFC 3501 allows: the
   stored boundary and what was found), and its first-read snapshot is SELECT's too. Test: the unsolicited FETCH comes
   before the ordered read's tagged OK; the next pass stores the message.
2. **A second row for mail moved out of the Inbox mid-pass** (introduced). The early read put its new ids in the pass's
   `introduced`, so if another app moved one to Archive before the ordered Inbox read, the Archive read imported a
   second copy. The early read keeps its own set; an id joins `introduced` only when the ordered read meets it where it
   was stored. Test: the move happens on Sent's SELECT; one row, adopted in Archive the next pass.
3. **A temporary SEARCH refusal tolerated as a folder's** (introduced for role folders, pre-existing for custom ones).
   imapflow answers a refused SEARCH with `false`; `NO [UNAVAILABLE]` was thrown as non-retryable `listRefused`, which
   `tolerate` swallowed, and the pass reported success. A temporary one (the logged error, `refusal()`) is now deferred.
   Test: Sent's `UID SEARCH` answered `NO [UNAVAILABLE]` fails the pass; the Inbox's new mail is stored anyway.
6. **A body fetch started after an arrival announced while it waited for its permits** (introduced). The yield is
   checked again once the permits are held. The IDLE test now checks order: at most one body fetch starts between the
   arrival and its envelope read (it was "fewer than 12"). The permit wait itself isn't reproducible in the fixture.
7. **An expunge between the early read's SEARCH and FETCH failed the pass** (pre-existing for the ordered read; a new
   window here). The early read acknowledges nothing, so a UID the FETCH no longer returns is skipped there; the
   ordered read searches again. Test: one of two new UIDs expunged on the FETCH; the other is stored, no error.
8. **Test gap:** the `UNAVAILABLE` test now checks the Inbox's cursor is where it was after the failed pass. A second
   announcement can't happen: `ingest` (and its `live` notice) runs only for mail with no stored place, and the second
   read finds it by its place.

Not taken:
4. (500 pending bodies all in a refused Sent keep an older Inbox body waiting): needs the body query to leave out
   mailboxes refused this pass, a store change in both engines; before this plan the refusal stopped the whole pass.
5. (after a yield, a backlog over 500 bodies waits for the poll for what the base would have done in the queued pass):
   bodies past 500 already wait for the next pass today; the arrival's pass takes the next 500.

## Out of scope

- Finding 3 (folders past the 10,000 catalog cap), deferred above.
- Scheduling and connectivity (plan 263), Google (264, 265).
