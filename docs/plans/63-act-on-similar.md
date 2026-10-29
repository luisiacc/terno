# 63 · Archive, delete or spam similar mail

## Request

> One of the same we do with, when you move … an email to a category. I want to do the same, something similar to that pop up which show on the bottom. When they archive, or they mark spam …, so they can do it for, like, the same sender, for example. … when they are right clicking and archiving, or marking a spam, we could make those via a sub menu inside, where they can say mark a spam, like only this, like all with this sender, all with this subject. And, of course, when they click subject, it will be, it means sender and subject. And maybe all from this domain, those would be the three things in the subtitle, and also have it when they click it, suggested on the bottom.

The request was dictated; the passage above is lightly cleaned up. Agreed in the conversation that followed:

- A plain Archive or Spam stays one action. The "similar" choices live in their own submenus and in the snackbar.
- "Subject" always means the same sender *and* the same subject.
- Domain is hidden for shared mail providers (gmail.com…) and for the user's own domains. "This mailing list" is offered when the mail has a List-Id.
- Starred threads and threads the user replied in are skipped, and the snackbar says so.
- One Undo reverses the whole batch.
- **Spam similar also sends their future mail to Spam** (user: "of course it would also send to spam future senders like that"). It creates a filter, and Undo removes it.
- Archive and Delete similar are one-time. The result offers **Always** to make them a filter.

## What exists

- **Category snackbar** (`category-snackbar.tsx`, plan 02). After a filing it shows chips (sender, domain, list, topic, Always → filter) with lazily streamed counts, keys 1–5, z and Esc (`snackbarControls`, `keyboard.ts`). The counts come from `categorize.count`, and `categorize.apply` files a scope.
- **Thread actions** (`lib/actions.ts`).
  - `act()` updates the list optimistically and calls `threads.act`. It then shows a plain snack ("Archived", with Undo) whose undo token comes from `registerUndo`.
  - `actScope()` runs "select all N" through `threads.actScope`, with `trackJob` progress and one undo.
- **Backend** (`handlers.ts`).
  - `actOn(ids, action, signal, progress, alwaysSliced)` runs `store.threads.act` in time-budgeted slices, queues provider ops per account, and journals every message's prior state into `UndoJournal`. `threads.undo` puts them back.
- **Exact sender, domain and list scopes.**
  - SQLite: `categorize-bulk.ts` `scopeSql` uses the `messages_from`, `messages_domain` and `messages_list` indexes, and matches only received mail (not sent, not from one of the user's own addresses).
  - IndexedDB: `categorize.ts` `scopeThreads` uses `messages.by("from" | "domain" | "list")`.
  - A thread's root inbound message (`threadFeatures`, with `features.sender`, `features.domain` (already null for consumer and own domains), `features.list` and `root.source.subject`) is what quick actions read.
- **Filters** (`rules/schema.ts`). Rules can say `from equals`, `fromDomain equals`, `listId equals` and `subject equals` (compared with `normalizeText` on both sides; SQL uses `m.subject_norm`). Saved filters run on incoming mail only.
- **Learned filters** (`learning/propose.ts`) propose a filter after 5+ archive, trash or spam actions on one source. The key `scope:value:action` is excluded once a filter carries it as its `learnedKey`.
- **Thread menu** (`thread-menu.tsx`) already has Base UI submenus (Categories, Move to, Everything from X ▸ To category).

## Design

### Scopes

`SimilarScope` lives in core (`similar.ts`), next to its rule builder:

| kind | matches received mail (`is_sent = 0`, not from the user's own addresses) where | rule (for the future) |
|---|---|---|
| `sender` | `from_email = email` | `from equals email` |
| `subject` | `from_email = email AND subject_norm = normalizeText(subject)` | `from equals email` ∧ `subject equals subject` |
| `domain` | `from_domain = domain` | `fromDomain equals domain` |
| `list` | `list_id = listId` | `listId equals listId` |

- **The subject.** The subject is the root inbound message's own subject, verbatim. Notifications repeat it exactly, so equals is right. The filter normalizes both sides the same way, so the scope and the rule agree. A subject longer than the rule's 500 characters gets no subject offer.
- **Which mail is eligible**, depending on the action:
  - archive: in the Inbox;
  - trash and spam: not already in Trash or Spam.
- **Skipped:** starred threads and threads with a message the user sent. A thread the user explicitly targeted (the clicked or selected rows) is never skipped.

### Backend

- **`similar.offers({ threadIds ≤ 200, action })`** returns what the targets share, from their root inbound messages:
  - the sender (and its display name);
  - the subject, when the sender is shared;
  - the domain, when it is a feature (not consumer, not own);
  - the list.

  For each offer it returns `{ scope, count, capped }`. `count` covers eligible threads not yet acted on, explicit targets included. It is capped at `COUNT_CAP` (1,000+). `skipped` is the number of starred or replied threads the scope leaves out. One call with four indexed counts: no reads until the submenu or snackbar asks.
- **`similar.apply({ threadIds, scope, action, jobId })`**:
  1. resolves the scope once, up to `SCOPE_CAP`, and refuses when capped;
  2. unions in the explicit targets;
  3. runs `actOn` with progress, never as a learning signal (it is a sweep);
  4. for **spam**, saves the scope's rule as a filter named `Spam: {value}` with `learnedKey = proposalKey(...)` when no filter already has that rule (compared by its canonical JSON). The learned banner then won't propose it again.

  It returns `{ affected, skipped, undoId, filterId | null }`. `filterId` is set only when this call created the filter.
- **`similar.always({ scope, action })`** saves the filter for archive or trash (the result snack's **Always**), with the same deduplication. It returns the filter.
- **Store.** `similar.count(scope, action, now)` and `similar.resolve(scope, action, limit)`, implemented in both stores:
  - SQLite with the existing indexes;
  - IndexedDB with `messages.by(...)`.

  Results come newest first, and the shared conformance suite pins both stores to the same answers.

### Renderer

- **Snackbar** (`similar-snackbar.tsx`, lazily imported by `actions.ts`):
  - **When it appears:** after `act()` archives, trashes or marks spam from an explicit action (not quiet, not a scope sweep). The snackbar first looks exactly like today's snack: title and Undo. It then calls `similar.offers` with the targets (first 200).
  - **Chips:** one per offer, with keys 1–4 in the order sender, subject, domain, list.
    - **Archive and trash:** a chip shows only when its count is greater than 0. Domain and list hide when they hold no more than the sender does, as in the category snackbar.
    - **Spam:** chips show even at 0, because they also catch future mail. A short note reads "Also future mail".
  - **Snack behavior:** z, Undo, Esc and the dock's lifetime work as in the category snackbar, and the same `snackbarControls` slot drives it.
  - **Choosing a chip** runs `applySimilar`.
- **`applySimilar(action, targets, scope, label)`**:
  - the progress snack is `trackJob`;
  - the result snack reads "Archived 23 from Uber" (plus "· skipped 2 starred or replied" when there were any);
  - **Undo** = `threads.undo` + `filters.delete(filterId)`;
  - **Always** (archive and trash) → `similar.always` → "Filter created · Edit";
  - for spam, the result reads "… Future mail from Uber goes to Spam."
- **Thread menu.** After the place items, **Archive similar ▸** and **Spam similar ▸** (with `menu-archive-similar` and `menu-spam-similar`):
  - **Where they show:** only for explicit targets (not a "select all N" scope), and only in views where that action is enabled.
  - **Contents:** the submenu calls `similar.offers` when it opens, with the menu's targets (rows show "…" until counts arrive). It lists "All from Uber · 23", "From Uber with “Your receipt” · 9", "All from uber.com · 41" and "This mailing list · 12". The Spam submenu starts with a muted note: "Their future mail goes to Spam too."
  - **When nothing is shared:** a disabled "Nothing similar".
  - **Choosing an item:** the targets leave the list at once (optimistic, as in `act`), then `applySimilar`.
- **Strings** in `en` and `es`.

### Out of scope

- "Not spam" removing the filter that spam similar created. Today the filter dialog does that. Noted as a follow-up.
- Similar actions for "select all N" scopes.
- AI suggestions for any of this.

## Tests

- **Core unit:** `similarRule` per scope; offers from feature sets (shared sender only, no consumer domain, subject only with a shared sender, a subject over 500 characters dropped).
- **Store conformance** (SQLite native, SQLite-WASM, IndexedDB):
  - counts and resolve per scope and action;
  - the user's own sent mail excluded;
  - starred and replied threads skipped;
  - Inbox only for archive;
  - Trash and Spam excluded;
  - the subject matched exactly;
  - caps.
- **Backend handler tests** (`handlers` with an in-memory store):
  - apply acts on the scope plus the explicit targets, and undo restores every message;
  - spam creates the filter once, and its `learnedKey` silences the learned proposal;
  - a second apply doesn't duplicate the filter;
  - `similar.always` deduplicates;
  - a capped scope is refused.
- **Web unit:** the snackbar shows offers, hides zero chips for archive, keeps them for spam, and keys 1–4 run them; undo deletes the filter.
- **e2e** (`similar.spec.ts`, `@design`):
  - archive one Uber mail, then the snackbar's sender chip archives the rest, and z brings them back;
  - right-click → Spam similar → sender sends all of them to Spam and creates the filter (the Filters dialog lists it);
  - the snackbar is axe-clean in light and dark;
  - the menu is reachable with the keyboard.
- **Perf:** a 50k-thread SQLite query-plan test (`similar.count` uses the from, domain and list indexes, with no scan of `messages`), and a budget assertion on `similar.offers` at 50k threads in both stores.

## Performance and resources

Offers are read only when the snackbar or submenu appears: one RPC with up to four indexed counts, each capped at 1,001 rows. Apply goes through the existing sliced `actOn` and per-account ops. The filter is one row. Nothing runs while idle.

## Revisions after the Codex review

The read-only critique made 12 points. Eleven are taken. One is kept as designed, with the reason below.

1. **One Undo covers everything.** Applying a chip from the snackbar takes over the original action's undo token. Its Undo restores the sweep and then the original targets. The menu path (targets inside the sweep) already has one journal.
2. **A sweep that fails partway is still undoable.** `similar.apply` journals the slices that committed and returns their undo id in the error's details. The renderer offers Undo on the error snack. A failure while saving the filter doesn't fail the sweep: the result says the filter couldn't be created.
3. **The compound undo is backend-side (`similar.undo`) and retry-safe.**
   - It deletes or disables the filter first, so no new mail is spammed while the threads are being restored.
   - It then restores the messages, which is idempotent.
   - On failure it puts the journal entry back, so Retry repeats the whole undo.
4. **Kept as designed:** a sender rule (`from equals address`) also matches mail whose display name is exactly that address. That is how every existing sender filter and learned filter behaves, in both evaluators. A display name copying another sender's address is a spoofing pattern, so catching it in a Spam rule is wanted, and for Archive it is harmless. Adding an address-only field would change the filter language, the builder and AI generation for a case that doesn't hurt.
5. **Protection is rechecked per slice.** Before each slice is acted on, the store re-reads which of its threads are starred or replied, in the same turn as the act, so a star added mid-sweep is honored. Explicit targets are exempt.
6. **The subject scope has no learned key.** Only the sender, domain and list scopes carry `learnedKey`, so a narrow subject rule never silences a sender-wide proposal.
7. **One subject contract.** A subject is offered only when it is non-empty, has no surrounding whitespace and is at most 500 characters. The store compares `subject_norm = normalizeText(subject)` exactly, the same way the rule evaluators do.
8. **IndexedDB counts are bounded.**
   - They stop at `COUNT_CAP + 1` and don't sort. Only resolve sorts.
   - Skipped counts are capped the same way.
   - A perf test covers a dominant sender at 50k threads.
9. **SQLite counts are bounded.** Counts are `count(*)` over `SELECT DISTINCT thread_id … LIMIT 1001`, so they stop early, with no ORDER BY. The perf test covers a dominant sender and domain at 50k threads, and a zero-eligible scope (all archived).
10. **No sampling.** `similar.offers` takes at most 200 threads. A larger selection gets no offers. A target without received mail means nothing is shared.
11. **Filter ownership.**
    - Filters are ensured one at a time on the backend (a queue), so concurrent applies can't create duplicates.
    - An identical *enabled* filter is reused. An identical *disabled* one is enabled, and Undo disables it again.
    - Undo deletes a filter only if this apply created it and it is unchanged (same name, rule and enabled state). An edited filter is left alone.
12. **The menu reuses `act()`'s view-aware optimistic transition** (cursor advance, page close, rows staying in All Mail, Sent, Starred and searches) and reloads on failure.

## What the Codex code review changed

The first round (`ff2417a0..3121638c`) found five issues. Each is fixed with a test that fails without the fix:

1. **z pressed before the sweep answered lost the Undo.** The Undo now waits for the sweep's outcome, then takes back the sweep, the filter and the original action, as `act()`'s Undo already did. Test: `apps/web/src/lib/similar.test.ts`, z while the RPC is pending.
2. **The two-step Undo couldn't be retried.** After the sweep is restored, a failure in the original action's undo made the retry call the spent journal entry. The Undo now remembers that the sweep is back, so a retry goes straight to the original action. Test in the same file.
3. **Count caps didn't bound the work.** A dominant sender, a rare subject or a scope with nothing in place could walk a whole index bucket.
   - **What a read costs now:** at most `OFFER_SCAN` (2,000) of the scope's newest messages per offer. Every check past the index (subject, own addresses, place, value) is computed rather than filtered, so it can't make the index walk longer.
   - **A scope bigger than that** shows its count as "N+".
   - **Tests:** conformance pages that stop after `limit` messages, and perf gates at 50k for one sender that sent every message (dominant, rare subject, nothing in place), in both stores.
4. **Resolve read everything before checking the cap.** The store now has `resolvePage`, newest messages first, in pages of 2,000 messages. The handler yields between pages and refuses as soon as the scope passes the cap. Test: `similar.test.ts`, which refuses after three pages of four and moves nothing.
5. **Equal counts hid the subject chip.** Only domain and list hide when they hold no more than the sender. The subject is the narrower choice, and Always makes it a filter of its own.

Round 2 (`3121638c..`) found three more issues, each fixed with a test that fails without the fix:

1. **IndexedDB pages still read the whole index bucket** and sorted it. The in-memory index keeps no id order: an update re-adds a row at the end of its bucket. So a sweep now walks the index live (`keysBy`), and the cursor is a token for that walk, kept between pages (8 at most). A lost token starts the walk over; the backend's sets keep each thread once. Test: `packages/idb/src/similar.test.ts` counts index entries walked across pages, 10 now against 40 before.
2. **SQLite's `(? IS NULL OR m.id < ?)` hid the cursor from the index.** Later pages reread everything before them. Pages now go in message order, with `m.id > ?` only on later pages. Test: `packages/db/src/similar.test.ts` asserts the query plan is `(from_email=? AND rowid>?)` with no temp B-tree. Both perf gates time every page of a full sweep at 50k, the last ones included.
3. **A capped zero isn't proof that nothing is left.**
   - A scope read in part stays offered even at 0, shown without a count.
   - Domain and list hide as the sender's equal only when neither count is partial.
