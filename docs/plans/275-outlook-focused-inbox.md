# Plan 275: Outlook's Focused Inbox (Other out of the Inbox)

## Request (verbatim)

> yes do all o that including focused inbox, do them all

What "Focused Inbox" refers to is the product-parity item in [`docs/research/outlook-reliability-checklist.md`](../research/outlook-reliability-checklist.md):

> **Plan 86 (Promotions and Social out of the Inbox).** … Outlook has no such tabs, but it does have **Focused Inbox**: Graph's `message.inferenceClassification` (`focused` / `other`), with user corrections through `inferenceClassification/overrides` (per sender). Do the same for Outlook: an account's "Other" lives under the account and stays out of the Inbox and its counts, "Move to Inbox" writes the classification (and offers the sender override), and the per-account setting matches Gmail's. Reuse plan 86's thread `tab` and its conservative rule (one Focused message keeps the conversation in the Inbox). Confirm first that `inferenceClassification` is returned on delta and that consumer (outlook.com) accounts report it.

## What Microsoft documents

- `message.inferenceClassification`: "The classification of the message for the user, based on inferred relevance or importance, or on an explicit override. The possible values are: `focused` or `other`." ([message](https://learn.microsoft.com/en-us/graph/api/resources/message))
- It is updatable with `PATCH /me/messages/{id}` (the update page's own example sets `"inferenceClassification": "other"`; no draft-only qualifier). ([message-update](https://learn.microsoft.com/en-us/graph/api/message-update))
- Delta "support[s] `$select`" for messages, "as in any GET request". ([message-delta](https://learn.microsoft.com/en-us/graph/api/message-delta))
- "the classification system learns and applies classification only on incoming messages in the Inbox. Messages in other folders are by default "Focused"." Overrides are per sender SMTP address, affect only future Inbox mail ("doesn't modify the inferenceClassification property in existing messages"), at most 1,000 a mailbox. ([manage-focused-inbox](https://learn.microsoft.com/en-us/graph/api/resources/manage-focused-inbox))
- Not documented: whether consumer accounts report it (the overrides API lists personal-account permissions), or what a mailbox with Focused Inbox turned off reports. Terno reads what Graph says and never guesses: a message without the property is Focused (shown).

## What exists

- **Plan 86's model, both stores.** Every message has `category` (null: not Gmail; 0 none, 1 Primary, 2 Promotions, 3 Social, 4 Updates, 5 Forums), owned by the flag protocol like read, star and place (a pending category op wins over a stale read). Every thread has `tab` (0 the Inbox, 1 Promotions, 2 Social), folded by `threadTabState` (`@terno/core/tabs.ts`) in both stores' recompute: one eligible Inbox message that isn't tabbed keeps the conversation in the Inbox. Partial indexes walk a tab's pages, scopes and unread counts; the Inbox predicate adds `t.tab = 0` only when some account separates its tabs (`separatesTabs`, `AccountPrefs.separateTabs`, missing = on).
- **Category moves are thread actions** (`CATEGORY_ACTIONS`: `toPrimary`, `toPromotions`, `toSocial`, and `toUpdates`, `toForums`, `toNoCategory` for undo), snapshotted only by a category action (`stateOf(…, isCategoryAction)`), with Move to Inbox merging the untab and the move into one undo (`untabThreads`, `mergeBefore`).
- **The UI** knows tabs as `TABS = ["promotions", "social"]`: the sidebar rows under a Gmail account, `navigate({ accountId, gmailTab })`, the list keys, the palette's Go to, the thread menu's Move to Promotions/Social, the selection bar, `tabUnread` counts, Settings → Accounts' "Separate Promotions and Social" (Gmail only).
- **Outlook (plan 259)** syncs `id, receivedDateTime, isRead, isDraft, flag, parentFolderId` (`SELECT`), sets flags and the one user folder by `FlagUpdate`, and writes with `PATCH` in `$batch`es of 20 (`graph-writes.ts`). Its messages' `category` is null today (no labels).

## Design

### The rule

For an Outlook account with Other separated (the default): **a conversation whose Inbox mail is all Other is not in the Inbox**, neither the unified one nor the account's. It lives under the account, below Trash, in **Other**. Outlook decides; Terno never classifies Outlook mail itself. It's plan 86's rule exactly, with Other as a third tab.

### The model (`@terno/core/tabs.ts`)

- A seventh category, **6 Other** (Outlook's `other`), and 1 Primary doubles as Outlook's `focused`. `CATEGORY_LABELS[6]` is `""`: no Gmail label means 6, so Gmail never reads or writes it.
- A third tab, **3 Other**: `TABS = ["promotions", "social", "other"]`, `TAB_CODE.other = 3`, `tabOfCode(3) = "other"`.
- `threadTabState` treats 6 as a tab category beside 2 and 3: tab 3 when every eligible Inbox message is Other.
- `CATEGORY_ACTIONS.toOther = 6`, `TAB_ACTION.other = "toOther"`; `ThreadAction` gains `"toOther"`.
- **Which tabs an account has:** `tabsOf(account)`: Gmail `["promotions", "social"]`, Outlook `["other"]`, IMAP none. `separatesTabs` is true for Gmail and Outlook unless turned off. Everything that lists tabs (sidebar, palette, the menu's Move to…, the RPC's tab check) reads `tabsOf`, never `TABS` whole.

### Sync (`graph-api.ts`)

- `SELECT` gains `inferenceClassification` (delta, listings, reads by id).
- A message in the **Inbox** takes its classification as its category: `focused` → 1, `other` → 6, absent → 1. Anywhere else its category is 1 (Microsoft: other folders are Focused). A message's category never leaves Outlook's word.
- It reaches the store the way Gmail's does: `IncomingMessage.category` and `FlagUpdate.category` (new, Outlook-only; Gmail keeps deriving it from `gmailLabels`). The stores take it on insert and update under the flag protocol (`category` is already a local flag field, so a pending `toPrimary` owns it against a stale delta).
- Delta reports a classification change as an update of that message (it's a property of it), so a correction made in Outlook arrives with the next round.

### Writes (`graph-writes.ts`)

- `toPrimary` on an Outlook message: `PATCH { inferenceClassification: "focused" }`; `toOther`: `"other"`. Same `$batch` path as read and flag, idempotent.
- Any other category action (`toPromotions`, `toSocial`, `toUpdates`, `toForums`, `toNoCategory`) is refused for an Outlook op (the store never queues one: the actions are offered per `tabsOf`).
- **The sender override is not offered in v1.** It only changes future mail, can't be seen or undone from Terno's history, and a mailbox holds at most 1,000; correcting one conversation already teaches Outlook's classifier. Out of scope, below.

### Store (both engines)

- The untab of Move to Inbox (`untabThreads`, SQLite `actions.ts`'s `category IN (2, 3)`) covers 6: Move to Inbox on an Other conversation is `toPrimary` on its Other messages, one action, one undo.
- Ingest's insert reads `msg.category ?? categoryOf(msg.gmailLabels)`; `updateExisting` and `updateFlags` take `category` when given, protected by the flag protocol as Gmail's is.
- The tab backfill (plan 86) is Gmail's labels' work; Outlook's categories arrive with sync. Existing Outlook mail gets its classification the next time each message is read: a one-time **reclassification pass** after the update reads every stored Inbox message's `inferenceClassification` by id (the flag snapshot path, `pendingFlagSnapshots`), so Other mail already here moves out of the Inbox. (No users yet, but the dev accounts have mail.)
- No migration: `messages.category` and `threads.tab` exist with no CHECK on their values (plan 267's rule; checked in the store). IndexedDB the same.

### The UI (`apps/web`)

- **Sidebar:** under an open Outlook account, after Trash and before its folders: **Other** (an inbox-tray glyph from the catalog), with its unread count. `navigate({ accountId, gmailTab: "other" })` (the state's name stays `gmailTab`; renaming it is churn), title "Other · Account".
- **Move to Inbox** from Other works as from Promotions (row, reader, menu, `m i`, selection bar). **Move to Other** in the thread menu for an Outlook Inbox conversation (`TAB_ACTION.other`), as Move to Promotions is for Gmail.
- **Palette:** "Go to Other" for the Outlook account in scope.
- **Settings → Accounts** (Outlook): **"Separate Other"**, on by default, hint "On: what Outlook's Focused Inbox puts in Other stays out of the Inbox and its unread count, under this account." The same `separateTabs` preference.
- Copy through `t()`, `en` and `es`: `view.tab.other` ("Other" / "Otros"), `actions.toOther`, the setting and its hint, the snack texts reused from plan 86 where they fit.

## Tests

- **Core:** `threadTabState`: all-Other → 3; one Focused → 0; Other with Promotions never mixes (one account is one kind); `tabsOf` per kind; `toOther` is a category action.
- **Conformance (SQLite, SQLite-WASM, IndexedDB):** an Outlook message ingested with category 6 tabs its thread 3; a `FlagUpdate` category change re-tabs it; Move to Inbox on an Other thread moves it to the Inbox with one undo that restores Other; a stale update while `toPrimary` is pending keeps Primary; the Inbox, its counts and `tabUnread` leave Other out and the tab list has it; the setting off brings it back; Gmail threads unchanged.
- **Graph provider:** `SELECT` asks for `inferenceClassification`; Inbox `other` → 6, `focused` / absent → 1, any other folder → 1; a classification change in a delta round updates the category; `toPrimary` / `toOther` PATCH the right body in batches of 20; another category action is refused; the reclassification pass reads stored Inbox mail once.
- **Backend:** `accounts.update { separateTabs }` on an Outlook account; the RPC accepts `tab: "other"` only with an Outlook account.
- **Web unit:** `tabsOf`-driven rows and menu items (Gmail: two, Outlook: Other); Move to Other.
- **e2e:** extend `gmail-tabs.spec.ts`'s scenario with the Outlook account (`outlook-connect.spec.ts`'s synthetic Microsoft): an Other conversation is out of the Inbox and in Other; Move to Inbox brings it in and Undo returns it; light and dark screenshots of the sidebar.

## Perf

- Plan 86's indexes and predicates cover tab 3 (they test `tab > 0` and `tab = ?`), so no new index and no migration. The 50k tab gate gets an Other case beside Promotions.
- Sync: one more selected property per envelope; no extra request except the one-time reclassification pass, which runs through the flag-snapshot share of a pass (bounded per pass).

## Out of scope

- The per-sender **override** (above).
- Outlook categories (colored tags): not folders, not tabs.
- Focused Inbox for IMAP (no such thing) and the web build (Outlook isn't on the web yet).

## Revisions after the Codex review

Twelve points; each changes the design as follows (this section wins where it differs from the sections above).

1. **Select all in a tab acted on the account's Inbox** (`backend/scope.ts`: `resolveThreadScope` and `countThreadScope` never passed `tab` to the store). This is plan 86's own bug for Promotions and Social too. Both pass `tab`; a conformance-backed backend test selects all in a tab holding one tabbed and one Inbox conversation and acts on the scope.
2. **A saved delta link keeps the old `$select`.** The cursor gains `projection` (a number; absent = 0). A pass that finds an older projection restarts every folder's round from its saved window (`fresh(state.after)`), with the live boundary kept as an expired link keeps it (round 4 #8), and saves the new projection. The first round lists the window again: stored messages take their classification as a flag update, nothing is downloaded again. A quick check defers to that pass (it needs a finished round).
3. **A sparse update never invents a classification.** `Envelope.inference` is set only when Graph sent the property. A stored message takes a category only from an envelope that carries it; one without leaves the category as it is. A new message without it is Primary (shown). The category is Graph's value whatever the folder: the tab rule only reads Inbox messages, so a message moved out keeps its classification and nothing is invented by a move.
4. **No per-message pass for existing mail.** Point 2's restart is the reclassification: a listing a page at a time, resumable by the cursor, with no targeted reads and no intent rows. The "reclassification pass" in Store above is dropped.
5. **Category actions are checked against the account's kind** before anything changes, in both stores' `plan()`: Gmail messages take `toNoCategory` … `toForums`; Outlook messages take `toPrimary` and `toOther`; anything else in the selection is left out (and IMAP never). Gmail's provider maps only the categories that have a label, so `toOther` never reaches a `batchModify`, and Outlook's refuses any category action but those two.
6. **Move to Inbox untabs Other too.** SQLite's two filters and IndexedDB's one take category 6 for Outlook accounts, as 2 and 3 for Gmail. What else Move to Inbox moves is plan 86's rule, unchanged (an archived sibling comes back too, as for Gmail).
7. **A category undo puts back the category alone.** `flagScope` gives category actions `only: "category"`, and `undoTarget` restores only that field over the message as it is. The untab half of Move to Inbox snapshots the same way. `mergeBefore` keeps the place only for messages the move itself moved. Tests: undo of Move to Other after a later read, star and move leaves those alone.
8. **The numeric effect.** `toOther` joins the protocol's action-to-field and action-to-value maps beside `toPrimary`. Outlook's observed value travels as `FlagUpdate.category` / `IncomingMessage.category` (numbers, never through the boolean flag loop), through the same owner and epoch checks as Gmail's label-derived category. Test: a read begun before `toPrimary` settled and committed after it keeps Primary; a fresh one after it takes Graph's.
9. **The tab refresh's thread phase covers Outlook.** Learning an address is yours re-tabs Outlook conversations too (its scheduling and its walk read the tabbed kinds, Gmail and Outlook). The message phase stays Gmail's (labels).
10. **One hiding rule for lists, counts and arrivals.** `inbox-hiding.ts` (SQLite) and `inbox-hidden.ts` (IndexedDB) read the tabbed kinds and each account's own setting, so an Outlook account with separation off shows its Other whatever a Gmail account does. IndexedDB's count loop reads bucket 3. Arrivals use the same helpers, so a new Other message isn't news. Tests cover mixed preferences, both SQLite count branches and arrivals.
11. **The tab is checked against the account in the backend.** The schema checks shape; a shared backend check (`checkTab(account, tab)`) refuses a tab the account's kind doesn't have, for lists, scope counts and scope resolution. `ListParams` and `ScopeParams` take the shared `Tab`; the RPC action enum gains `toOther`.
12. **The UI follows each account's tabs.** The menu offers a destination only when every selected conversation's account has it. `staysInView`, the optimistic row update and the undo snack (`SNACK_ALWAYS`) take `toOther`. Both sidebar variants read `tabUnread` per `tabsOf`. Settings search finds "Separate Other" for Outlook.

**The sender override is built too** (the owner asked for everything on the checklist): in Other, "Always keep mail from {sender} in the Inbox", and in an Outlook Inbox, "Always send mail from {sender} to Other". Each moves the conversation now (`toPrimary` / `toOther`) and asks Graph for the override (`POST /me/inferenceClassification/overrides`, classifyAs and the sender's SMTP address; one already there is updated). The snack's Undo deletes the override it made and puts the conversation back. A new op kind, `classifySender { address, as }`, queued with the move, so it's retried and its outcome is the op's.
