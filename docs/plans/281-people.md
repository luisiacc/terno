# Plan 281: People, and what's open between you and each

- **Status:** plan. Not built.
- **Builds on:** plan 18 (the recipient index), plan 142 (follow-ups), plans 204/210/215 (What matters' items, their acts and Undo), plan 177 (people chips), plan 180 (the person menu), plan 194 (a one-to-one conversation's ⋯ is the way to its person), plan 251 (morph), plan 271 (the motion vocabulary), plan 147 (the AI gate).

## The request

Research on what people want from AI in email found demand for "contact intelligence": before replying, a compact view of your relationship with that person (the last important conversation, unresolved requests, what you promised them, what they owe you, what you're waiting on). Four proposals were mocked up (a person card in the person menu, a line on the summary card, a line in the composer, a page per person). The owner:

> i lik A, but i think we would also need a view like a sidebar where we can have a list of all persons, basically contacts, sorted at the top by the ones who actually have activity and owe something or we owe something or we have some kind of tasks with them or something is open between us, it would be a view on itself, for each person when clicked it would be a view simlar to the D variant then, there would be a search and the search would only search for contacts names/emails, not content, and of course needs to be instant.

Then: the list holds the people you've written to plus anyone with something open (search finds anyone); the person page opens in the reader (mockup 1); People sits **below Inbox**. And:

> ok i really like this lets build it. build it in a worktree. this is only available in the Pro plan or with ai activated. lets also ensure we have nice transitions/animations when doing stuff tehre like marking things or clicking an optn item inside a contact and when that moves fromthe detail view to the left sidebar.

After building: a review round by Astra and Fable subagents (bugs, improvements, optimizations, simplification), every finding fixed.

## What exists

- **What matters' open part** (`TodayService.list`, `packages/backend/src/today.ts`): one projection of your promises (follow-ups of kind `promise`), dated items read from incoming mail (a person's ask, a bill, a renewal…), conversations waiting on your answer (`needsYou` over `NEEDS_WALK`, with `waiting_acts`' Done/Later), and reminders due today; Trash and Spam left out, the per-account switches and the user's words (plan 249) applied. Each `TodayItem` carries its `thread` (a `ThreadSummary`: `fromName`/`fromEmail`, the waiting row's person), its `why` (a promise's `personName`/`personEmail`), and for a dated item its own sender (`from`). The renderer turns an item into a sentence (`todaySentence`), a when (`todayWhen`) and a task (`taskOf`), and acts with `actOnTask(task, action, at, left)` (`lib/dated.ts`): the act, its snack, its exact Undo; `left` is the caller's way to take rows out at once and put them back on Undo.
- **Follow-ups waiting on them** (`kind: "awaiting"`): not in What matters (the sixth panel round), listed under Follow-ups; acted on by `actOnFollowup(row, action, at, left)` (`lib/followups.ts`). Rows of conversations in Trash or Spam show nowhere (`FollowupWorker.awayAmong`).
- **The recipient index** (`packages/store/src/autocomplete/contacts.ts`, in the backend as `b.autocomplete`): every address seen in headers, with how much you wrote to them (`sent`), how much they wrote to you (`recv`), the last date (`last`), a rank (`key`: people you wrote to above everyone else), flags (own, automated, dead, spam, sender), a name; prefix search by name words, initials, address and domain in typed arrays (`suggest`). Cold until warmed (`warmAutocomplete`: restores a snapshot or builds in slices).
- **The person menu** (plan 180, `components/person-menu.tsx`): a chip under the subject opens it: who, then New message, Reply only, Conversations with (a search), Copy address, the sender's items. A one-to-one conversation has no chips: the message's ⋯ carries the same items (`PersonItems`, plan 194).
- **Own lists** (`state/app.ts`): Reminders, Follow-ups and What matters are flags (`reminders`, `followups`, `today`), one at a time (`navigate`), each with its own list in the list pane (`App.tsx`: the feed or `ThreadList`) and its place kept by `listKey()`.
- **The gate**: `aiFeaturesOffered` (`lib/ai.ts`): Dev mode's switch on a local build, then a Pro entitlement or a working AI setup (`aiFeaturesAvailable`). The backend's `TodayService.available` is the same rule.
- **Motion** (plans 195–198, 251, 271): every duration through `--motion` (≤ 100 ms), none with motion off or reduced; `lib/morph.ts` runs a change as one view transition where elements marked `data-morph="<name>"` glide to their new places and the rest cross-fades; `lib/flash.ts` has the leaving copy, the reflow and the arrival.

Nothing here needs a schema change: every fact the view shows is already stored or in memory.

## Design

### 1. Who is a person here

A person is an address, compared by `addressKey` (lower case, `+tag` dropped), never the user's own (`identitiesIn`'s rule on the backend: the accounts' addresses and the index's `OWN`). One person per address: two addresses of one human are two rows (merging them is out of scope).

### 2. What's open between you (`PeopleService.open`)

One backend read, gated like What matters (`available`: nothing at all when AI features aren't offered), cached until What matters or follow-ups change (`todayChanged`, `followups`), built from what What matters already decided, so the two never disagree:

1. **What matters' open part**, as it lists it (`TodayService.list([])`, every section, Coming up included), each item given to a person:
   - a **promise of yours** → `why.personEmail` (whom you promised);
   - a **conversation waiting on your answer** → its thread's `fromEmail` (who wrote);
   - a **dated item** → its sender (`item.from`, else the thread's `fromEmail`), only when that sender is someone you've written to (the index's `sent > 0`) or the item is a person's request (`ask`, `respond`): a bill from a utility is What matters' business, not a person's;
   - a reminder → nobody (it's yours, about a conversation, not between you and someone).
2. **Replies they owe you**: follow-ups of kind `awaiting`, open or due, with follow-ups on, of accounts with AI on, not in Trash or Spam (`awayAmong`) → `personEmail`.

Each person gets their items, most pressing first: Missed (a promise or dated item past its day), then due today, then conversations waiting on you (oldest first), then what's dated ahead, then replies owed to you (oldest wait first). People are ordered by their first item in the same order. The read returns, per person: key, address, name (the index's, else the items'), items, and the counts by kind.

Bounds: What matters' projection is bounded already (`NEEDS_WALK`, 1,000 active follow-ups, 1,000 open dated items); the grouping is one pass.

### 3. Everyone (`PeopleService.everyone`)

From the index: the people you've written to (`sent > 0`), not your own, not dead, best first (the index's `key`: how much and how recently you wrote, then they wrote), at most **5,000** (past that, search finds them). Each: address, name, last date. A new index method `written(max)` filters and sorts once per index version (a few thousand ids: well under a millisecond's sort per thousand; the perf gate holds it at 250k contacts). The renderer leaves out the people the Open section shows.

The index is warmed when the view opens (as a draft's recipient field does); until it answers, Everyone says "Getting your contacts ready…" (no spinner loop, no polling: the call resolves when it's ready).

### 4. Search (`PeopleService.search`)

Names and addresses only, never content: the index's prefix search (`suggest`'s matching and ranking, a new `people(query, limit)` without `suggest`'s 20 cap, at most 50), not your own addresses. Anyone the index knows can be found, written to or not (an automated sender ranks low, as in a recipient field). Each hit carries its open count from §2's cache. Typed into the list's field, answered as each key is typed (the latest answer wins; an older one arriving late is dropped), no debounce needed: it's an in-memory walk.

### 5. One person (`PeopleService.person`)

For the person page and the card: §2's items for that key, and their recent conversations: the plan 140 address search (`store.threads.searchText({ query: address })`: sender or recipient, exact), Spam and Trash left out, newest first, **20** at most, with whether there are more. The page's head says when you last heard from each other from the newest conversation.

### 6. The People view

- **Sidebar:** "People" (`nav-people`, the `Users` glyph), right **below Inbox**, shown only when `aiFeaturesOffered`; no count (What matters counts what's due). Active while the view is on.
- **State:** `people: boolean`, a fourth own list (`navigate({ people: true })` turns the others off, as they do each other), and `person: string | null`, the selected person's key. `listKey()` gains `people`, so its scroll and selection are kept.
- **The list pane** (`components/people/people-list.tsx`): the title "People", a subtitle ("5 with something open", or nothing), the search field, then two sections: **Open** (§2's people) and **Everyone** (§3's, less Open's). One virtualized list (`@tanstack/react-virtual`, as the feed), headings and rows as items; `renderProbe("PeopleRow")` asserted. A row: avatar, name, the when at the line's end; the second line, an Open person's first item in a short sentence with a glyph (promise, waiting on you, waiting on them, asked of you) and "+N" for the rest; an Everyone person's address. A late one's when in the destructive ink (`CONTRAST_PAIRS`' pair, as Missed's). Searching replaces both sections with the hits (the address, the match marked, "N open" when there is).
- **Keys:** j/k move between people (the page follows, as a conversation follows the list's cursor), `/` focuses the search, Esc in the search clears it, then leaves it. No animation on any of these.
- **The reader** shows the person page (`components/people/person-page.tsx`) while `people` is on, a person is selected and no conversation is open. In List layout the page is the list's page (`pageOf`: `readerOpen` with a person and no conversation is the page too), so it works in both layouts.
- **The person page:** avatar, name (the reader's subject type), address, "Last email Mon"; New message (to them, from the account you last wrote them from, else the default) and Copy address; **Open between you** with its items, each a sentence, the conversation's subject and the when, and on hover or focus Done and Later (Later's presets, `laterChoices`), the same acts and Undo as What matters (`actOnTask`, `actOnFollowup`: one snack, one Undo); **Conversations**, the recent 20 as rows (subject, snippet, date, unread dot) and "All conversations with Ana" (the address search in the list, as the person menu's item). Clicking an item or a conversation opens that conversation in the reader; Esc (or the reader's close) comes back to the page, its scroll kept.
- **Empty:** no one selected: "Choose someone to see what's open between you." Nobody with anything open: the Open section isn't drawn. A cold index and nothing open: the list says it's getting contacts ready.

### 7. The person card (proposal A)

The chip's menu (plan 180) gains a head under who: **Open between you** (up to 4 items, each a menu item that opens its conversation), then **Last time**: the newest other conversation with them (subject, date, its stored summary's first sentence when there is one; no AI request). Read when the menu opens (`people.person` with `conversations: 2`), drawn when it answers (the menu's items don't wait or move: the head's room is reserved only once the answer is in, and the menu opens at its first frame). Only when AI features are offered. Both the chip's menu and the message's ⋯ (plan 194) gain "Open in People", which opens the view on that person.

### 8. Motion (the owner's "marking things, clicking an open item, and the move from the detail view to the left list")

One vocabulary, the existing one, ≤ `--motion` (100 ms at most), none with motion off or reduced; nothing on keys pressed hundreds of times (j/k, `/`, typing in search).

1. **Done, Later, Remove on the person page:** the change is optimistic and runs inside `morph()`. The item leaves (cross-fades out), the items under it glide up; in the left list the person's row changes in the same transition: its line becomes its next item, or, with nothing left open, the row glides from Open into its place in Everyone (both lists are loaded, so its place is known). Rows are `data-morph="person-<n>"` (a short stable id per key) and items `data-morph="item-<id>"`; the list's scroller and the page's are `data-morph-clip`, so only what's wholly in view glides (morph's rule). Undo comes back the same way (the reload that answers it runs in `morph()`).
2. **Opening an item or a conversation from the page:** the conversation is read first (`loadThread`), then shown in one change, so there's never an empty reader frame; Esc back to the page is instant (it's kept in the store), its scroll restored.
3. **The card's head** appears with the menu's own open (no motion of its own).
4. Search, j/k, the view's open: none.

### 9. Copy (en and es)

`people.title` "People"/"Personas", `people.nav`, `people.openCount` "{count} with something open"/"{count} con algo pendiente", `people.search` "Search people"/"Buscar personas", `people.open` "Open"/"Pendiente", `people.everyone` "Everyone"/"Todos", `people.warming` "Getting your contacts ready…"/"Preparando tus contactos…", `people.none` "Choose someone to see what's open between you."/"Elige a alguien para ver qué hay pendiente entre ustedes.", `people.between` "Open between you"/"Pendiente entre ustedes", `people.conversations`, `people.allConversations` "All conversations with {name}"/"Todas las conversaciones con {name}", `people.lastEmail` "Last email {when}"/"Último correo {when}", `people.more` "+{count}", `people.openIn` "Open in People"/"Abrir en Personas", `people.lastTime` "Last time"/"La última vez", the item lines: `people.item.promise` "You promised {text}", `people.item.waiting` "{name} is waiting on you: {subject}", `people.item.awaiting` "Waiting on {name}: {subject}", `people.item.asked` "{name} asked you: {text}", and a few more as built. Names only, never pronouns.

## Data and performance

- **No migration, no store contract change.** The reads are What matters' projection (already gated), `followups.active` (≤ 1,000), `threads.summaries`, the address search, and the in-memory index.
- **Cache:** §2's grouping is kept until `todayChanged` or `followups` fires (one invalidation, no timer); the list, the card and the search's counts share it.
- **Index methods** (`written`, `people`): typed-array walks; `written` sorted once per index version. Perf gate (`contacts.perf.test.ts`): 250k contacts, 20k written: `written(5000)` and a cached second call, and `people(query)` within the existing suggest budget.
- **Backend perf gate** (`people.perf.test.ts`, the 50k mailbox copy, SQLite and IndexedDB): `people.open` and `people.person` under the budget What matters' list holds.
- **Renderer:** the list is virtualized (≤ 5,000 + Open rows), its render count asserted; the page's lists are bounded (items by What matters' bounds, 20 conversations).
- **Idle is idle:** nothing is read until the view or a card opens; while the view is open, it reloads on the two events only.

## Tests

- Unit: the index's `written` (own, dead, never-written left out; order; the cap) and `people` (prefix by name, address, domain; own left out; > 20); `PeopleService` grouping (each kind's person; a utility's bill left out; a person's ask kept; own addresses never; ordering; awaiting only with follow-ups on, not in Trash or Spam; the cache cleared by both events; nothing when not available); `person` (conversations exclude Spam and Trash, the cap and `more`).
- Renderer unit (jsdom): the list's sections and the Everyone filter; a person with nothing left moves from Open to Everyone in the optimistic change; Undo restores; the nav row's gate; `pageOf` with a person.
- e2e (`people.spec.ts`, one `scenario()`): the sidebar row below Inbox; the list's Open and Everyone; search by a name's prefix and by domain; the page's items; Done on an item → snack, the item gone, the row's line updated, Undo brings it back; opening an item's conversation and Esc back; the person card in a chip's menu; "Open in People" from a one-to-one ⋯; axe on the view and the page in light and dark; the row hidden when AI features aren't offered.
- Motion (`motion.spec.ts`, recorded per frame): Done on the page: the item's copy fades, the row moves in the same transition, nothing over 100 ms; motion off: nothing.
- Perf gates above; the existing `test:ui-perf` unchanged.

## Out of scope

- Merging one human's several addresses; editing names; a contacts store.
- Their promises to you (plan 280, "Owed to you"): when it lands, its rows join §2 as a fifth kind.
- A keyboard shortcut to open People (none of What matters' and Follow-ups' have one).
- A custom date in Later (presets only, as What matters' row menu's first level).

## Revisions after the Codex review

Twelve points. These override the sections above where they differ.

1. **The gate:** People uses What matters' own rule, on every People call before anything is warmed or read (`TodayService.offered`). A Pro entitlement isn't wired anywhere yet (plan 85: none to ask); when it is, it reaches People through that one rule. Not a People change.
2. **Not `TodayService.list`:** its reminders refresh, waiting-summary lines, digest and history are none of People's. `TodayService.openItems()` is the projection's rows as items (the same sections, senders read in one batch, the same Trash/Spam, account and words rules), and `list()` is built on it. An item's act stays one act: a row that carries another promise of the same reply (`also`, `with`) goes to the row's person, whole, with its linked revisions, so Done and Undo stay one.
3. **Replies owed to you, their own rule:** the active `awaiting` rows (≤ 1,000), their conversations read now (`threads.summaries`: Trash and Spam from what's stored now, never the worker's last look), and the worker's own account rule (`followupsWanted`, extracted in `core.ts` from `accountWanted`: the account's AI and What matters switches and its follow-ups switch). No `look()`: nothing is closed, made due or said.
4. **One identity:** people are grouped by `addressKey`; every lookup (the index, the address search, a new message) uses an address as it was seen, never the key. Your own addresses are left out by key too (the accounts' addresses and the index's own ones, `+tags` dropped and Gmail's dots folded, as Reply's `identitiesIn` does), not only by the exact `OWN` flag. Everyone is deduplicated by key before its cap.
5. **The cache's keys:** What matters' revision and the index's version (a catch-up can change who's written to and names). Overlapping asks share one read. The person page reads again on `todayChanged` and on mail changes (`changed`) while it's open. The index that gives up (`warm()` resolves without one) is said: "Contacts couldn't be loaded. Search and Everyone come back when you open People again."
6. **The index's costs:** `written` keeps its sorted ids and its entries per version (a hit builds nothing); the perf gate measures a cold sort and a re-sort after new mail at 250k contacts (20k written), and People's search at one letter (past the short cache). The search is latest-wins per client before it runs (as `threads.search`), and the renderer drops a late answer.
7. **The page's conversations:** the address search with `place: "all"` (Spam and Trash left out by the store, not after), `more` from its cursor. New message goes from the account of the newest conversation with them (the plan said "last wrote from", which nothing stores cheaply).
8. **People's boundary:** `people` is an own list in `navigate` and in `keepFolderValid`'s normalization (any write that sets a mailbox, a query or another own list turns it off; losing the gate does too). The mail list doesn't load, auto-select or keep a cursor while People is on (`fetchPage` and `openedOn` see it). People keeps its own selection (`person`) and the list's scroll by `listKey()`. "All conversations with …" leaves People for the search, as the person menu's item does. The row is a `NavItem` below Inbox, checked beside its neighbours in light and dark.
9. **List layout:** there the person page is drawn in the list pane (the mockup's second layout): a person opens over the People list with "‹ People" (and Esc) back; a conversation opens as List's ordinary thread page over it, Back returning to the person page as it was. No new page kind or history entry. In Split it's the reader, as designed. Opening a conversation guards against a newer click (the person or the view changed meanwhile: nothing opens).
10. **The card never moves under the keyboard:** its data is asked for on the chip's hover or focus and cached per person until What matters changes; the menu opens with the head when the answer is in (at most 250 ms after the click), else without it, and nothing is inserted later. "Open in People" is an item of `PersonItems` (both menus), handing focus off as its other navigating items do. "Last time" comes through `summaryLine` (current summary, the account's AI on).
11. **Later:** an item put off stays open (What matters keeps it, in Coming up), so Later never takes it out optimistically: only Done and Remove do; Later's answer re-reads and the item moves to its place. A reply owed to you gets its own Later (plan 87's presets, through `actOnFollowup`'s `later`). A person whose last item goes leaves Open; if they aren't in Everyone (never written to, or past its cap) they leave the list.
12. **Motion's edges:** the act's request runs first, outside any transition; the optimistic change (and later the settled read) commits inside `morph()`'s synchronous update. What isn't wholly in view, or isn't visible (List's covered list: `morph` now skips elements `checkVisibility()` says are hidden), isn't named and simply changes. `morph` now honours the paused-motion state (`motion-paused`) as `flash.ts` does. The motion spec records a visible move, a destination out of view (no glide, no flash) and motion off.

## As built

- **Backend:** `PeopleService` (`packages/backend/src/people.ts`) over `TodayService.openItems()` (the projection's rows as items, without reminders, summary lines, digest or history; `list()` is built on the same `itemsOf`) and the follow-ups waiting on someone (their own account rule, `followupsWanted`, shared with the worker). Grouped by `personKey` (core: `addressKey` with Gmail's dots folded, now also Reply's identity in `compose-fields.ts`). The grouping is cached by What matters' `revision` (bumped by every `todayChanged` and every mail change), the index's `scoreVersion` and the follow-ups switch. Your own addresses are the accounts' and every address the index has seen you send from (`ownEmails`). Renderer-only RPCs: `people.list` (`known`: Everyone isn't sent again while unchanged), `people.ready`, `people.search` (latest wins per client), `people.person` (`except`: the card's "Last time" is another conversation's, its summary read only for the card).
- **Index:** `written(max)` (the top cut by a native typed-array sort, then the few thousand above it sorted by the full rule; cached per version), `people(query, limit)` (suggest's matching, past its 20), `person(email)`, `ownEmails()`.
- **Renderer:** `state/people.ts` (the list, the search, the page; rows derived once, an Everyone entry's row the same object while the entry is), `lib/people.ts` (reads, acts, the card's reads, the keyboard's moves), `components/people/` (the list, the page, an item's line, the card's head). People is a fourth own list (`ownList()` replaced the scattered `reminders || followups || today` checks). The person page is the reader's in Split and the list pane's in List (its "‹ People" back).
- **Motion:** Done and Remove take the item off the page and its person's row at once in one morph; when the act has answered, the list and the page as they now are land together in one more, after the first finished (`morphSettled`). Later moves nothing until its answer. j/k, mail changes, selection and search never move. `morph` now skips hidden elements and honours paused motion.

## What the reviews changed (Astra, Fable)

Two independent reviews of the built branch (Astra: gpt-6.2-astra; Fable: claude-fable-5-2), 30 findings, every one fixed, each with a test where a test can hold it:

- **Stale state:** any mail change reads the grouping again (a trashed conversation leaves Open); a read, a page or a morph that lands after a newer selection or act never overwrites it; a read already on its way never brings back an item an act is taking out; a failed act reads the truth again instead of restoring an old copy; coming back to People (from Review, a preview) reads the page too.
- **Motion:** the act's change and its settled answer are two morphs in sequence, never a second cutting the first; nothing moves outside an act (the earlier 2-second "owed motion" window made j/k glide); the person's row moves in the same transition as the page (Everyone holds the open people at their places, so a row whose last item goes falls into Everyone there).
- **Keyboard and focus:** List's Back from a conversation leaves none selected behind the page (its keys would act on mail not shown); List's page takes the keyboard from the list it covers and gives it back to the row; the page keeps its scroll and the line a conversation was opened from; j/k work on the drawn rows and carry the keyboard; `/` and the skip link reach People's field.
- **The card:** never opens after its chip has gone (which left the app's keys waiting), goes with the AI gate, is read on a resting pointer (focus at once), at most 40 kept, cleared on mail changes.
- **Errors and states:** the list's and the page's failed reads say so with Retry; a conversation that can't be read stays unopened with a snack; a search typed while the index warms says so and runs again when it's ready; a failed search keeps its last hits.
- **Cost:** People read once on opening; rereads one at a time with the next owed; Everyone sent only when it changed; a busy person's items drawn 30 at a time; your own address has no page.
- **Simplification:** one `isPersonRequest` in core; the item line's words in the catalog; `taskOf` and `itemParts` once per render.

## Tests run

- Unit: `contacts.test.ts` (39), `people.test.ts` backend (10), `state/people.test.ts` (13), `people.test.ts` core, `today.test.ts`, `followups.test.ts`, `compose-fields.test.ts`.
- e2e: `people-view.spec.ts` (Split and List), `motion.spec.ts` (People: the item and the row glide in one transition, ≤ 100 ms; none with reduced motion), `people.spec.ts` (plan 17's filter), `graphite.spec.ts`, `folder-actions.spec.ts` (the sidebar's rows now include People), `list-layout.spec.ts`, `reader.spec.ts`, `keyboard.spec.ts`; the screenshot specs, 61 baselines updated (the sidebar's new row). The whole `e2e` project ran once (713 passed): of its failures, 2 were the sidebar's row (fixed), 3 passed on a second run, and 8 (`provider-errors`, `settings-pass` axe, `what-matters-feed` 1194, `print-quality`, `scrollbars`) plus `today.spec` 935 fail the same way on the base commit b4bf84456.
- Perf: `contacts.perf.test.ts` People case passes at load ~5 (Everyone cut 20 → under 16 ms after the native-sort change; search p95 1.4 ms); `today.perf.test.ts`'s People case measured on IndexedDB (list 29.5 ms, page 48.7 ms, search 0.6 ms, at a 1.5× multiplier under load); its What matters scenarios before it fail on the base commit too on this busy machine, so SQLite's People numbers wait for a quiet run.

## UI rating (plan 158): three rounds

The owner asked for at least two iterations. People's set (`scripts/ui-rating/sets.mjs`: the list beside a person's page, an item hovered, the search, Everyone, a chip's card, List layout, a small window) on the local stand-in, five styles × light and dark, Claude and Codex in clean rooms.

| Round | Commit | Claude | Codex | Cells under 9 |
|---|---|---|---|---|
| r01b | 475d33fe4 | 6–6.5 | 6.5–7.5 | 390+ |
| r02 | 75ca11760 | 6.5 | 7 | 386 |
| r03 | 8717f200a | 6.5–7 | 7.5–8 | 383 |

- **Iteration 1 (75ca11760):** the keyboard through People (/ at once, ↓ and Enter from the search, one Tab stop, Enter and → into a page, Esc and ← back), the person acted on held in place, Done and Later at an item's top right, a one-band page header, the card led by the person.
- **Iteration 2 (8717f200a):** every row says its kind; the header's counts jump to Open and Everyone; the chosen person kept; the card's items on two lines with their kind and when, who wrote last; Done and Later a size up with their keys; put-off items under their own heading; the header wraps in a narrow pane.
- **Iteration 3 (d458b9023, with the QA panel's fixes below):** an item's kind, conversation and when on one line, the when never cut; Done and Later always there and quiet; Later's section called Later; People's title and avatars in the design's list sizes.

Still under the bar after r03, most often: Open's rows look alike (nearly every one "Waiting on you"), its order (newest first, the longest waits at the bottom), the card can't act on an item and is a long menu, selection and hover too close in Graphite and Atelier dark, Everyone's rows don't show why they're in that order. Several of these wait on the owner (below).

## QA panel (seven personas)

Marta (keyboard consultant), Diego (impatient founder), Priya (accessibility), Tom (breaker, privacy), Ana (first week, mouse), Lukas (designer), Theo (reviewer); Claude and Codex, each on the frozen r03 build in a sandbox of its own. Their scores: would use weekly 6–8, look 7–9, clarity 5–8, speed 5–8, trust 4–7. What they found that was fixed (1ee70d590, 7a571b677, 71cacccc0, d458b9023):

- **Trust:** the card said "You wrote last" for someone else's email (the backend now says whether you wrote it); a promise put off with Later vanished from People (What matters hides an undated one until it's back: People's read keeps it, under Later); Later on a reply owed seemed to do nothing (it moves when you'll follow up, now shown); the card counted put-off items the page didn't.
- **Focus never lost:** Tab always lands on a drawn row; Esc in an empty search, Later, Undo, a conversation opened and Open in People each leave the keyboard somewhere; a focus asked for a frame or two on never lands after the user has typed (Esc then / at once typed into a new message); j/k go on from the focused row, and in List walk the rows rather than opening pages; Done on someone's last item goes back to their row, not to New message.
- **Keys:** G P (in ? and the palette); Enter in the search opens what's typed, waiting for its answer; / selects the old query; Esc on a hit clears the search; C on a person's page writes to them.
- **Words and screen readers:** the list's region is named People; the search's count is said; +N in words and on hover; "Undo this date" on a waiting conversation's Undo is "Undo"; List's Back names the person; a search for mail words says People finds names and addresses; the first 50 hits say so; a hit found by its address shows it.
- **By design, kept:** the Undo pill's border steps once a second under reduced motion (plan 182); chips only on conversations of two or more messages (plan 177); one Undo at a time (plan 161).

## What the Codex review of the QA fixes changed

Astra (gpt-6.2-astra) on 75ca11760..021c8457a, ten findings; nine fixed, the tenth (the rating bar) waits on the owner's decisions:

- A click on Done guards the items against a double click's second by how it was pressed, not by whether the button had focus (Electron focuses it first). Test: Done by a click.
- `/` from a person's page in List leaves for the search alone (the row no longer takes the keyboard back a frame later).
- Later and Undo put the keyboard back on their item after the settled read is drawn, only if nothing was typed or pressed meanwhile and it's still the same person.
- Enter pressed before a search's answer opens nothing if the user typed or pressed elsewhere meanwhile, or left People; a cleared search's answer is no answer to the same words typed again; an answer while the contacts warm up isn't one (Enter waits for the ready one). Tests: Enter in the search (three).
- The header's jumps opt out of the window's drag region.
- Esc on a hit beyond Everyone's bound, or Done on the last item of someone not in the list, leaves the keyboard in the search.
- A busy person's Later section is drawn 30 at a time too.
- The rows' badges count what's open now; one with only put-off items shows none.

## The owner's decisions after the QA panel (2026-11-25)

The branch was rebased onto main first (plan 278's "who is a person" rules, plan 282's Put away: People joins `ownList` and `keepOwnListValid`'s checks; Put away leaves People and People leaves Put away). Twelve questions; the owner's answers, as built:

1. **Open is longest waiting first, with the age shown.** The backend orders a person's items (what's open now, longest waiting first; then what's put off, soonest back first: `sortPersonItems`) and Open by its people's longest wait (`sortPeopleOpen`; `PersonOpen.since`). An item waits since: a promise, when you made it; a conversation, since it began waiting on your answer (`waitingSince`); a request, when it came; a reply owed you, when you asked. The row's right column says how long ("Today", "3 days", "2 weeks", "2 months"; "Open for 3 days" to a screen reader), red when the item is late; Open's heading says "Longest waiting first", as Everyone's says its own order. The page lists its items in the same order.
2. **Kinds told apart.** A conversation waiting on your answer says its kind by its glyph alone (the words for a screen reader only: `itemParts(...).quiet`); "You promised" and "Owes you a reply" keep their words, their glyphs tinted: the promise in the unread's ink, the reply owed in the success ink, both 3:1 on the list, a hovered or selected row, the page and the menu (two new `CONTRAST_PAIRS` lines).
3. **Only what's put off: Open's end, not counted.** `since` is null for them; Open's count and the header's line count `openNow`.
4. **The card acts.** Each card item has Done (✓) and Later (its presets, then Pick a date…) beside it, menu items of their own (arrow keys reach them; each named with the item's words); the choice closes the menu and says itself in the snack, with its Undo (`actOnCardItem`, What matters' own acts). The person menu's "about their mail" (Always show in What matters, Counts as a person, File all their mail, Create rule) is folded under **More**, in the chip's menu and a message's ⋯ alike (one `PersonItems`).
5. **Chips on every group email.** `ThreadPeople` no longer waits for a second message: two or more other people on the conversation is the rule (one other person is still a one-to-one conversation, plan 194).
6. **Undo stays one level** (plan 161); no "Done today" list.
7. **"Between you" keeps group emails, marked.** `people.person` also asks the store for the conversations they sent mail in (`from:<address>`: theirs are a subset of the page's, newest first by the same date, so the newest N of theirs hold every one of the page's they wrote); the page's conversations they never wrote in say "Not from Ana" (`PersonPage.wrote`). The card already says who wrote its last one.
8. **Naming.** The Inbox's filter is "From people" ("De personas"), the view stays People; Settings' hint names the filter so. "Open" stays.
9. **Esc after Open in People** goes back to the conversation it was asked from (its place, a search's words, the conversation open: `returnFromPeople`), while it's still that person's page and nothing was opened over it; another person, or leaving People, forgets the way back.
10. **Only people in People.** The search, Everyone and Open leave out an address that isn't a person by plan 278's rule on an address alone (`senderIsPerson(addressOnly(...))`: a no-reply, a role or service address you've never written to, your word on the sender, Always or Never), and a sender whose mail was marked as spam (the index's `spam()`); the grouping is read again when the rules change (`rulesChanged`), and the renderer on `personRules`.
11. **Later's "Pick a date…"**, What matters' own picker (`LaterDialog`, shared with `TodayLaterDialog`), on the page's Later menu and the card's.
12. **Selection and hover in Graphite and Atelier dark** stay as they are.

## What the Codex review of the decisions changed

Astra (gpt-6.2-astra) on 114e090fa, nine findings, all taken (each test fails without its fix):

- Esc after Open in People: never back to a rule's preview (going to People ended it, as Review's way back has it); the account a search was focused on comes back with its words (plan 108); from a conversation opened on another person's page, back to that person, People's search and the conversation. Tests: Esc after Open in People (three).
- Everyone's version is the index's scores and the rules together: a rule set or removed sends Everyone again though the renderer holds the index's version. Test.
- "Not from" asks the store for the address as seen (a `+tag` kept), so a tagged sender's own mail is theirs; the card never asks (it doesn't show it). Test.
- Written to is plan 17's correspondents, by `addressKey` (the facts' and the Inbox filter's rule): `support+ticket@` written makes `support@` someone's, for the search, Everyone and Open alike. Test.
- The search asks the index for four times what it shows (at most 200) before leaving out who isn't a person.
- "How long" counts calendar days: yesterday at 4 PM is "1 day" at noon. Test.

## UI rating round 4 (after the owner's decisions)

| Round | Commit | Claude | Codex | Cells under 9 |
|---|---|---|---|---|
| r04 | 114e090fa | 6.5–7 | 7–7.5 | 389 |

(A first try stopped once captured: this shell's Node had no `codex`; run again with the one under fnm's v24.21.0 on the PATH.)

Clarity was the weakest facet everywhere (5.2–6.7). The raters' most common points, and what came of them:
- **A waiting conversation's kind by its glyph alone** (decision 2) was read as hidden: nearly every rater asked for the words back on the row, the page and the card. Kept as the owner decided; put back to the owner.
- **"Not from Wei"** said who didn't write: a group conversation they never wrote in now says who wrote its last message ("Yuki wrote last", "You wrote last"), in the snippet's weight.
- **The card named a third person as its heading** ("Emilio wrote last"): the section is "Last conversation", who wrote last a quiet line under its subject.
- **The card's ✓ and clock** read as states, without a visible name: Done and Later in words, small, under the item's text (aligned with it), as the page has them.
- Not taken (the owner's or out of this series): dark selection vs hover in Graphite and Atelier (decision 12); a compact row; Everyone's second line; the age's words on the row ("4 weeks" reads unlabeled to some); the card closing after Done.

After round 4 the owner brought "Waiting on you" back in words (decision 2 reversed): every kind says itself on the row, the page and the card; the tinted glyphs stay.

| r05 | ab8ad3067 | 6.5–7 | 7–7.5 | 382 |

Round 5 (the kinds in words again, the card's Done and Later in words, "X wrote last"): clarity up a little (5.7–7.3), hierarchy the new floor: with "Waiting on you" on ten of eleven rows, the raters now call the repeated words noise and ask for Open grouped by kind, or the default kind unsaid. Also: the card's "Last conversation" leaves out the open one without saying so; Done closes the card; a three-item card pushes the menu's commands down; Everyone's rows say only an address; List layout's rows stretch the window's width.

The owner kept Open one list by date (no grouping by kind). After round 5: the card's last section is "Before this one" (it leaves out the conversation open beside it); Done keeps the card open, the item leaving in place and the keyboard on the next; the card shows two items and "N more in People"; Everyone's rows say when you last wrote each other; a row's +N sits after its line, not across the row.

| r06 | de17e87a7 | 6.5–7 | 7–7.5 | 390 |

Round 6: level with rounds 4 and 5. Still raised: the card's "Before this one" isn't the last time you and they wrote each other (a group thread someone else wrote last); the page's Done and Later are words alone where the card's have glyphs; the right column means "open for" in Open and "last email" in Everyone, unlabeled; most of Open reads "Waiting on you" (kept: the owner's date order).

After round 6: the card's last section is the last time you wrote each other (the newest other conversation they wrote in, or whose last message is yours: never a group email they were only on; none when there is none); the page's Done and Later wear the card's glyphs; Everyone's column says "Last email Oct 12" in words.

| r07 (Lumen, Graphite) | 69962c622 | 6.5–7 | 7.5 | 154 of 4 reports |

Round 7, a small one: level. "Before this one" was wrong once the card's conversation could be newer than the open one: it says "Last between you". Still raised: Open's repeated "Waiting on you" (the owner's date order kept), the dark selection near hover (decision 12), "Last email" in the list (the index's last date) and on the page (the newest conversation) disagreeing, the card's actions under the item while the page's sit at its right.

After round 7 (owner): "Last email" is one date everywhere, a person's last conversation as their page heads with it (its newest, never in Spam or Trash): Everyone's and a search's rows ask it for the rows drawn (`people.lastEmails`, one indexed search each, at most 60 at once, again when mail changes), never the recipient index's last date.

After round 7 (owner): Done and Later at each item's side on the page and the card alike (A + D of the mockups), shown on hover only (or while the keyboard is on the item, or Later's menu is open).

## After the owner, 2026-11-26: Coming up isn't open now

> ok so on the new people menu i see this […] this item showed as the first becaus it was the oldest, but as you cna see on the picture, i had previously marked it to do later on january 12, if i marked something todo later already, i feel it shouldn't be here first because its action i said i will do later, for me it doesn't make sense for it to be first

> lets follow what matters, these things should all be centralized so they obey one source of truth, any action i do on the "People" or "What matters" should take that action on both, so it makes sense they get the info truth from a single place.

**What happened** (the owner's own mailbox): Gonzalo's reminder to renew a registered agent ("antes del 13/01/2027") came Nov 13. On Nov 24 the owner put the conversation off with Later in What matters (its waiting row, until Dec 30); an hour later the dated items read the renewal out of it as its own item (due Jan 12, time to act Jan 5), which carries no Later. What matters shows neither: the waiting row is put off, and the renewal waits under Coming up until Jan 5. People asked only "is it put off with Later?" (`personItemBack`), so the renewal counted as open now, waiting since Nov 13, and Gonzalo led Open with "13 days".

**The rule:** People takes "open now or not yet" from What matters' projection, never from its own reading of an item. What the projection places under Coming up (put off with Later, or its time to act still ahead) is not yet in People: under the page's Later, the person after everyone with something open now, the row saying its when instead of an age. What's open now counts from when its time to act came, never from before What matters showed it (on Jan 5 the renewal is "Today", not "7 weeks").

**Design:**
- `TodayWhy.ahead` (core): the projection sets it on every Coming up row, when What matters shows it again: the later of its time to act and Later's `back`. It's the projection's own verdict, carried to whoever reads its items. `back` stays Later's moment, for the words ("Back Dec 30").
- `TodayWhy.from` (core): on a row shown now, its time to act (What matters' lead before its day, Later aside: `showsFrom`, `promiseActFrom`, the functions the placement uses; a promise with no day, when it came due), set only when that's after the item came and not ahead of now.
- `personItemAhead` replaces `personItemBack` in People's order, Open's `since`, the open counts and the page's split: Coming up's `ahead` (its presence is the verdict, its value the order), or a reply owed put off (`deferredUntil`). `personItemSince` is the later of what it was and `from`.
- `itemWhen`: put off with Later says "Back …" as before; not yet without a Later says What matters' own when ("Jan 12, 2027"), drawn quieter as Later's are.
- What matters is unchanged: the two fields are read by People alone; the count's pass (`o.count`) sets neither.

**Not in this change:** a Later on a conversation covering items read from it afterwards (the owner chose following What matters as it is).

**Tests:** core: the projection sets `ahead` on a Coming up dated item, a put-off promise and a put-off waiting row, never on a row shown now nor in the count's pass; `from` on a dated item whose lead is after its arrival, absent when not. People's order: a person whose only item is Coming up sits after everyone open now; a person's item Coming up sorts after one open now; `since` of an item shown now from its lead. Renderer: `itemWhen` of a not-yet item without Later. An e2e isn't needed: the split and the quieter line are Later's, already covered.

**Revisions after the Codex review** (of the plan, 11 points):
1. `ahead` was the start of the heading's day, which for a deadline is its due day: a renewal due Jan 12 that shows Jan 5 would sort after one that shows Jan 8. It's now when it shows (the later of its time to act and Later's back).
2. A broken promise given a new day weeks off is Today's at once: its lead is ahead, so `from` is never set ahead of now.
3. A promise with no day shows when it comes due (three days after you wrote): `from` is that, not nothing.
11. The backend test is clock-driven: What matters and People before the renewal's time to act (Coming up; Gonzalo last, his search hit counting nothing open) and after it (open since that moment, counted).

Not taken: a missed item or a conversation back from Later keeping its first age (4: Later never resets an age, as before); `keepDeferred`'s order against a reply's other promises (5), the Spam/Trash fallback's first live member (6), an ask's Later past its window (7), the held row (9) and an open card's snapshot (10) are as they were, outside this change; a reply owed's Later moves when you'll follow up and keeps it open (8, by design: "Later on a reply owed … moves when you'll follow up, now shown").

**Codex code review** (7 points): fixed with tests: a promise moved to a new day (broken, or its request's) is open since the first day's lead, its age never reset when the new day's lead comes (2); an optimistic Done that leaves a person only what isn't open yet stops counting them in Open at once (`since` read again from what's left, 3); `ahead` and `from` are made on People's read alone (`forPeople`), so What matters' list does none of that work (4); the backend test checks What matters and People one millisecond before the renewal's time to act and at it (5); People's order is tested with deadlines and times to act in opposite orders (6); the row's words are "Jan 12, 2027", asserted as such (7). Not taken: a broken promise put off with Later sorting by its new day's lead rather than its Later (1: a rare case, and only its place among what isn't open yet).
