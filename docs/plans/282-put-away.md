# Plan 282: Put away: every automatic move says why, and one place shows what left the Inbox

- **Status:** plan.
- **Owner decisions (2026-11-25):** box B (a hairline box, no fill) around the reason in the reader; a help icon with a tooltip on the view's title; Put away is the last row under More, after Trash. The rest of the recommendations stand as decided: the engine keeps filing into categories hidden from the Inbox (Put away and Needs a look cover it), Needs a look means "from someone you've written to", "Keep {sender} in the Inbox" is a lasting per-sender rule, and the box shows wherever the conversation is opened, for the same 7 days it's in Put away.

## The request (verbatim)

The research, as the owner passed it on:

> Context: research on what people want from AI in email found that people don't trust tools that hide mail. One user ran both Superhuman and Shortwave because neither categorized the way they wanted, and their main fear was missing something important. The suggestion: explain every automatic decision ("Similar to 12 messages you previously moved to Notifications"), with ways to fix it (show future similar messages, edit the rule, undo), and a place to review what was hidden, perhaps as a daily digest.

> Your job in this thread: discuss with me and come up with solutions. […] Map every place Terno puts mail out of sight […] and for each say whether the user can see why today and fix it. Then propose solutions: how a reason is shown and phrased in plain English, the one-step fixes, whether there should be a single place to review what was put away (today, this week) and what it looks like, and how it stays calm (no new dashboard nobody opens).

After the mockups:

> i like it, we need a help icon with a tooltp on the 'put away' title so they know what this view is for, and it should be that last view under 'More', not avove 'archived'
>
> also this [the reason line in the reader] i imagine it only shows while its opened on this list, i think it needs a little box, show me how that looks

> lets do box B. commit the plan, then start building this on a worktree

## What exists

Where Terno takes mail out of the Inbox today, and what the user can see:

| Mechanism | Out of the Inbox? | Why, today | One-step fix, today |
|---|---|---|---|
| The local engine files a conversation (`cls_decisions` kind `auto`, `thread_categories.added_by = 'auto'`, `packages/db/src/categorize.ts` `decideThreads`) | Yes when the category is hidden from the Inbox (plan 83). A category made by hand is hidden (`backend/src/actions.ts:694`), and the engine's `policyContext` reads only `auto_apply`, not `show_in_inbox` | The "auto" mark's tooltip on the reader's chip (`reader.tsx` `Reasons`, `reader.auto.title` "Terno added it to {category}"); the toast "Terno added # conversations to {category}" says no reason | "Not {category}" on the chip (`removeFromCategory`, a negative example, the decision `reverted`) |
| The AI files (`ai-assist.ts`, `aiFilingBar`) | No: a hidden category gets a suggestion instead (plan 134) | The same tooltip | The same |
| A rule (Settings → Rules, learned rules, plan 217's "Archive similar" rules) archives, deletes, moves to a folder, or files into a hidden category (`sql-store.ts` `applyFiltersTo` → `runFilterActions`) | Yes | Nowhere. `filter_applications(filter_id, message_id, applied_at)` records it; only forwarding reads it | None from the mail: find it, move it back, then find the rule. "Stop filing" exists only for Terno-made `addCategory` rules, in the remove snack |
| Gmail's Promotions/Social, Outlook's Other (plans 86, 275) | Yes | Only the account's setting hint | Move to Inbox (Outlook also has a per-sender override) |
| Spam | Yes | No | Not spam |
| Kept out of "What matters" (plans 210, 243, 249, 273) | No: the Inbox keeps it | No reason is stored | Per sender only |

Data the design reads, all already in both stores (SQLite `packages/db`, IndexedDB `packages/idb`): `cls_decisions` (`explain_json` holds the reasons, `at` the decision's time), `thread_categories.added_by`, `categories.show_in_inbox`, `filter_applications` (+ `filters`: `name`, `auto`, `created_at`, `rule_json`), `correspondents.written` ("you have sent mail to it"), the threads' `in_inbox`/`in_trash`/`in_spam`.

## Design

### 1. A placement: who moved a conversation out of the Inbox, and why

A conversation is **put away** when, in the last 7 days, something other than the user took it out of the Inbox and it is still out:

- **The engine** filed it into a category hidden from the Inbox: an `auto` decision with no outcome yet (`outcome IS NULL`: not reverted; maturing takes 30 days), its `thread_categories` row still `added_by = 'auto'`, the category's `show_in_inbox = 0`.
- **A rule** acted on one of its messages, and the rule's actions take mail out of the Inbox: `archive`, `trash`, `moveToFolder`, or `addCategory` into a category hidden from the Inbox. `markRead`, `star` and `forward` don't hide anything; `spam` is never listed (the owner's rule: Spam triggers nothing, no count, no offer).
- **Still out:** the thread isn't in Spam, and it's out of the Inbox view: `in_inbox = 0`, or it's in a category hidden from the Inbox.
- **Not taken back since:** the user hasn't brought it back to the Inbox after the move (below, `placement_returns`).

When several apply, the newest wins. One pure function in core (`packages/core/src/placement.ts`) turns a stored placement into what the UI shows; the stores only read rows.

```ts
// packages/core/src/types.ts
export type Placement =
  | { by: "terno"; at: number; categoryId: CategoryId; reasons: Reason[] }
  | { by: "rule"; at: number; filterId: number; name: string; auto: boolean; createdAt: number;
      action: "archive" | "trash" | "moveToFolder" | "addCategory"; categoryId?: CategoryId; folder?: string };
export interface PutAway { placement: Placement; needsLook: boolean }
```

`needsLook`: the newest message from someone else in the conversation is from an address you've written to (`correspondents.written = 1`, not one of yours). Plain data, no AI (the owner: checks never use AI unless reliable without).

### 2. The store

`MailStore.putAway` (new, `packages/store`), implemented by SQLite and IndexedDB, in the conformance suite:

- `of(threadId): PutAway | null`: the reader's.
- `page({ before?: { at, threadId }, limit, since }): { items: { thread: ThreadSummary; putAway: PutAway }[]; next }`: newest first by placement time, then thread id. Needs a look isn't a separate query: the app groups the page (the first page holds the newest; a Needs a look row further down is shown in its day, marked).
- `needsLook({ since, after }): { count, first: { threadId, name } | null }`: for the Inbox's notice, counting placements newer than `after`.

**SQLite.** One query: the engine's decisions in the window through `cls_decisions_maturing` (`kind = 'auto' AND outcome IS NULL`, on `at`), unioned with `filter_applications` in the window through a new index on `applied_at` (only the hiding filters' ids, worked out in JS from `listFilters`, a small table), grouped by thread for the newest, then the thread's flags and the hidden-category check, then the return marks. Migration v{next} adds, shape only:

```sql
CREATE INDEX filter_applications_at ON filter_applications(applied_at);
CREATE INDEX filter_applications_message ON filter_applications(message_id);
CREATE TABLE placement_returns (thread_id INTEGER PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE cls_kept_senders (category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE, sender TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (category_id, sender)) WITHOUT ROWID;
```

**IndexedDB.** The same through its tables: `cls_decisions` and `filter_applications` gain an index on their time, and two new stores mirror the tables. A schema version step adds them (no data rewritten).

**`placement_returns`** is written when the user brings a conversation back: `threads.act` with `moveToInbox` or `notSpam`, and `removeFromCategory` of a hidden category. A placement at or before it no longer counts. Without it, a conversation a rule archived, that you moved back and later archived yourself, would come back as "archived by your rule". Undo of that return deletes the mark (the store journals it with the action).

### 3. The reader: the reason in a box (box B)

Under the subject's chips, when `ThreadDetail.putAway` is set (the store's `of`, sent with `threads.get`), a box with a hairline (`border`, the card radius, no fill), 13 px text: the sentence in the muted ink with its key words in the ink, and its fixes as link buttons (`Button variant="link"`) on the line below. It replaces the chip's "auto" mark only for put-away filings; a filing that stays in the Inbox keeps today's mark and tooltip.

The sentences (en; es with them), who first, then what, then why, from the user's own past actions:

- Engine: "Terno filed this in **{category}**, out of the Inbox: {reason}." The reason is the strongest of the stored ones, said as a sentence: "you keep # conversations from {sender} there" (`sameSender`), "you keep # conversations from this list there" (`sameList`), "you keep # conversations from @{domain} there" (`sameDomain`), else the first intent ("it looks like an invoice or a receipt"), else "it's like the mail you keep there". When there's more than one reason, a second sentence lists the rest: "Also: {rest}."
  - Fixes: **Not {category}** (today's `removeFromCategory`: back to the Inbox, Terno learns) · **Keep {sender} in the Inbox** (below).
- Your rule: "Your rule **“{name}”** {archived | deleted | moved to {folder} | filed in {category}} this."
  - Fixes: **Back to Inbox** · **Edit rule** (opens Settings → Rules on that rule).
- Terno's rule (`auto`): "Archived by a rule Terno made on {date}, when you archived similar mail." (deleted / moved / filed, by the action; "when you sorted similar mail" for a learned rule)
  - Fixes: **Back to Inbox** · **Stop this rule** (turns it off, with Undo; today's "Stop filing" generalized to any of Terno's rules).
- Needs a look adds a second sentence: "{name} isn't a list: you've written to them." (they/them: a name doesn't say pronouns.)

**Back to Inbox** is `moveToInbox` for archived, deleted and moved mail, and removing the category for a rule's filing; every fix is one step, with the snack's Undo (exact, as today's actions).

**Keep {sender} in the Inbox**: `cls_kept_senders(category, sender)`. The engine's policy gets `Vetoes.kept`: an `auto` decision becomes a suggestion (`decide`, gate `veto:kept`), and `aiFilingBar` suggests too. This conversation leaves the category without counting as a wrong filing (no negative example; its decision's outcome is `kept`, so the valve doesn't pause the category). Undo removes the row and files it again. Settings → Categories lists a category's kept senders with Remove (small list, under the category's row).

### 4. Put away, the view

- **Where:** the last row under More, after Trash, no count (`nav-putaway`, icon `FolderInput`). The palette has "Go to Put away". A route flag like Follow-ups' (`putAway: true`, view `all` underneath).
- **The title:** "Put away" with an info icon after it (`Info`, 16 px, muted, keyboard-reachable, its name "About Put away") and a tooltip: "What Terno and your rules moved out of the Inbox in the last 7 days, and why each one went."
- **The rows:** the list's own rows (virtualized, `ThreadRow`); the third line (snippet) is the short reason, in the muted ink: "● {category} · like # from {sender} there", "Archived by your rule “{name}”", "Archived by a rule Terno made {date}", "Deleted by your rule “{name}”". The category's dot leads a filing's line.
- **Sections:** **Needs a look** first (the page's rows that need a look), then by the day they were put away (**Today**, **Yesterday**, then the weekday), with the list's section headings (plans 87, 179: `TopHeading`, generalized from the Inbox top's three kinds to a heading with a name and a count).
- **The footer:** when an account keeps Gmail's or Outlook's sorting apart, one line under the rows: "Gmail and Outlook also keep some mail out of the Inbox. It's under each account." No count, no Spam.
- **Empty:** "Nothing was put away this week" / "When Terno or one of your rules moves mail out of the Inbox, it shows here for 7 days."
- **Actions:** the list's usual ones; **Back to Inbox** in the reader's box. A row leaves the view when it's back in the Inbox.
- **Seen:** opening Put away marks everything in it seen (`settings.putAway.seenAt`).

### 5. The Inbox's one line

Only when Needs a look has something newer than `seenAt`: one line above the rows, as the learned rule's offer (plan 158) sits: "Terno put away mail from {name}, who you write to." / "Terno put away mail from # people you write to." · **Review** (opens Put away) · × (marks it seen). One lead at a time: it goes before the rule offer. Nothing else: no count on the sidebar row, no notification, no toast.

### 6. What stays

- The auto-filing toast ("Terno added # conversations to {category}") stays; a filing into a hidden category gets **View** → Put away.
- What matters' reasons (kept out of the view) are a later plan: that mail is still in the Inbox.

## Tests

- **Core unit** (`placement.test.ts`): each placement's sentence and row line, the strongest reason picked, the action words, Needs a look's sentence; the `kept` veto in `policy.test.ts`.
- **Conformance** (`packages/store/src/conformance/put-away.ts`, both stores): an engine filing into a hidden category is put away, into a shown one isn't; a rule's archive, trash, folder move and hidden filing are, `markRead`/`star`/`spam` aren't; the window's edge; the newest of two placements; a return mark hides it, Undo of the return brings it back; Spam never; `needsLook` from `correspondents.written`; paging by `(at, threadId)`; `cls_kept_senders` turning auto into a suggestion.
- **Migration** test: the new step adds shape only (`migration-rule.test.ts`), and its time at 50k (`migrations.perf.test.ts`).
- **Perf gate:** `putAway.page` and `of` at 50k threads with a week of rule applications, both stores (`packages/db` and `packages/idb` perf suites), under the list's budget.
- **e2e** (`put-away.spec.ts`, one `scenario()`): a rule archives new mail → Put away lists it under its day with its line → the box says why → Back to Inbox → it leaves the view, Undo brings it back; an engine filing into a hidden category → Not {category}; Keep {sender} in the Inbox; Needs a look's Inbox line → Review → seen; the help tooltip; the row under More is last; axe in light and dark. Screenshots in light and dark, looked at.

## Performance

- Reads only: the window is 7 days, through time indexes, grouped once; nothing runs until the view or a put-away conversation is opened, except the Inbox line's count, which reads the Needs a look rows newer than `seenAt` (small, indexed) when the Inbox loads and when mail arrives.
- Ingest pays one more indexed insert per rule application (the new indexes) and nothing else.
- The migration adds two indexes and two empty tables (≤ 1 s at 50k).

## Out of scope

- "What matters" near misses (why a message isn't in that view, and Show it there): a later plan.
- Counting Gmail's and Outlook's tabs in the footer.
- A per-sender "always Inbox" for Gmail's tabs (Gmail offers none to apps).
- A daily digest message: Put away and its one Inbox line are the review.

## Revisions after the Codex review

The critique's twelve points, and what changed. Where a revision contradicts the design above, the revision wins.

1. **Placements are recorded when they happen, not reconstructed** (points 1, 2, 3, 6, 10). A rule's claim (`filter_applications`) is written before its actions run, an action can change nothing, a folder move can fail, and an edited or deleted rule rewrites or loses its claims; an auto decision plus a category hidden today doesn't say when the conversation left the Inbox. So a new table holds one row per put-away conversation, written in the same command as the move, only when the conversation was in the Inbox view before and is out of it after:

   ```sql
   CREATE TABLE placements (
     thread_id INTEGER PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
     at INTEGER NOT NULL,
     by TEXT NOT NULL,             -- 'terno' or 'rule' (descriptive: no CHECK, plan 267; an unknown value reads as unknown)
     needs_look INTEGER NOT NULL DEFAULT 0 CHECK (needs_look IN (0, 1)),
     detail_json TEXT NOT NULL     -- the snapshot the sentence needs (validated by the app)
   ) WITHOUT ROWID;
   CREATE INDEX placements_order ON placements(needs_look DESC, at DESC, thread_id DESC);
   CREATE INDEX placements_at ON placements(at);
   ```

   - **Rules** (`applyFiltersTo`, ingest and body arrival only; "apply to existing mail" is the user's own explicit run and records nothing): the threads the slice's filters touched, read for visibility before the first filter and after the last (and after `flushFolderMoves`, for a move that held). Out now and in before: a row naming the last filter whose action changed it. The snapshot: the filter's id, name, `auto`, `source`, `created_at`, the action (`archive`, `trash`, `moveToFolder` with its folder, `addCategory` with its category) and a hash of its `rule_json`. `spam` actions record nothing (Spam triggers nothing).
   - **The engine** (`decideThreads`): an `auto` add into a category hidden from the Inbox, to a thread that was in the Inbox view: a row with the category, the decision's reasons as stored (`explain_json`, parsed by the existing `parseReasons`) and the sender's label as the decision saw it (the root's `fromName` or address, and the classifier's normalized sender key). Toggling a category's visibility later records nothing.
   - **Needs a look** is decided then: the newest inbound message's sender has `correspondents.written = 1` and isn't one of the user's addresses.
   - A later placement of the same conversation replaces the row (upsert). Rows older than 7 days are deleted as new ones are written (a range delete on `placements_at`): no timer, and IndexedDB's table stays a week's worth, so scanning it is bounded.

   The read (`putAway.of`, `putAway.page`, `putAway.needsLook`) joins the row to the thread and keeps it while the thread is out of the Inbox view (`in_inbox = 0`, or in a category hidden from the Inbox) and not in Spam. `filter_applications` and the reconstruction query go; so do the two `filter_applications` indexes and `placement_returns`.

2. **The user's own move ends a placement; Back to Inbox doesn't** (point 4). When the user (or their agent) takes a put-away conversation somewhere themselves (`threads.act` archive, trash, spam, a folder move, filing it by hand into a hidden category), its row is deleted in that command: it's theirs now. Back to Inbox and Not spam don't delete it: the conversation is in the Inbox, so the read leaves it out; Undo takes it back out, and it's listed again. No return marks, nothing to journal.

3. **Back to Inbox is one backend command** (point 4): `putAway.back({ threadIds })` takes away whatever keeps each conversation out (`moveToInbox` for archived, deleted or moved mail; out of every hidden category it's in), and returns one undo id that puts back both halves exactly (the messages' states and the memberships with their `added_by`). Removing a rule's hidden filing this way records no negative example (the engine didn't file it); the engine's own filing is answered by **Not {category}**, which still teaches.

4. **The rule can have changed** (point 2). Edit rule and Stop this rule show only while the filter exists and its `rule_json` still hashes to the snapshot's; otherwise the box offers Back to Inbox alone and the sentence says "a rule that has since changed". Stop re-checks the hash in the backend before it turns the rule off. Learned rules (`source = 'learned'`, accepted by the user from the offer) read as "your rule"; `auto` ones as "a rule Terno made when you archived similar mail" (or deleted, moved, filed, by the action).

5. **"Keep {sender} in the Inbox" says what it does** (point 5): **Don't file {sender} automatically**, with the box's sentence after it: "Terno won't file {sender}'s mail in {category} by itself; it may still suggest it." Keyed by the classifier's normalized sender (from the snapshot). The policy turns an `auto` into a suggestion (`Vetoes.kept`, gate `veto:kept`), and the AI's filing is re-checked against `cls_kept_senders` where it commits (both stores; `aiFilingBar` takes the sender). This conversation leaves the category with no negative example, and its decision is withdrawn (deleted) rather than marked `kept`, so the safety valve counts neither way. Undo puts back the row's absence, the membership and the decision.

6. **Put away has its own route, list key and scope** (point 7): `putAway: true` in the app state (not `view: "all"` underneath), its own `listKey`, `fetchPage` branch and RPC (`putAway.page`). `currentScope()` returns null for it, as for Review: no "select all N" over a scope the backend can't resolve; checked rows still take the list's actions.

7. **One order, in the store** (point 8): `needs_look DESC, at DESC, thread_id DESC`, the cursor carries all three. Needs a look is a global first section, so pages only ever append. Sections come from the rows in that order: Needs a look, then each day.

8. **The Inbox's line counts conversations and acknowledges what it showed** (point 9): "Terno put away mail from {name}, who you've written to." for one conversation, "Terno put away # conversations from people you've written to." for more (never "isn't a list"). `putAway.needsLook({ after })` returns the count and a watermark (the newest `at` it counted); × and Review mark seen up to that watermark, not up to now. The renderer asks again when the counts change (new mail) and when a placement ends. The reader hides a box whose placement is past 7 days at render (a cached detail can't keep it).

9. **Sentences from structured data, in the catalog** (point 10): core's `placementWords(p)` returns a key and values, never English; `en` and `es` hold every template, with plurals and dates through the existing formatters. A reason without a sender label (an older row, a word match) falls back to "it's like the mail you keep there"; counter-evidence reasons are never shown as reasons.

10. **Layouts and accessibility** (point 11): in Put away a row always shows its reason, in the snippet's place: the third line in the two-line and three-line layouts, after the subject on a wide one-line row, and as its own line even where previews are off (it's the point of the view). The row's accessible description carries the reason; the day headings stay `aria-hidden` as the Inbox's are, and each row's description starts with its section ("Needs a look", "Today"). The Inbox's line reuses the learned offer's measured `Announcement` lead (one lead at a time, this one first) with BoardUI's close button; Put away is a slot of `MoreFolders` (shown while active, focus recovery as Reminders and Follow-ups); when × or Back to Inbox removes the focused control, focus goes to the list (the line) or the reader's toolbar (the box).

11. **Release gates** (point 12): SQLite v84 and IndexedDB 43 (plan 278 landed first with v83 and 42), with both IndexedDB paths (a fresh open and an upgrade) tested, existing rule claims and decisions untouched; the conformance suite registered in `conformance/store.ts`; `pnpm test:all` (a schema and store-contract change); `pnpm ui:rate` then `pnpm ui:gate` for the reader and the new view.

12. **Performance** (point 6): `of` is a primary-key read; `page` walks `placements_order` from its cursor, each row joined to its thread by key; `needsLook` reads the `needs_look = 1` prefix of the same index above the watermark. Ingest pays the visibility reads of the threads its filters touched (already in hand) and one upsert per placement. Perf gates: a mailbox with a dense week (5k placements) at 50k threads, both stores: `page` deep, `of`, `needsLook`, and ingest with rules on.

## Code review (astra and fable, at the owner's request)

Two reviewers read the built branch: Codex `gpt-6.2-astra` (15 findings) and a Claude Fable subagent (15). Merged, these are what changed:

1. **Several sources on one conversation** (astra 1, fable 4): a command keeps every note per conversation, and at its end the one that explains it now wins (`explainingNote` in `packages/store`): a place (Trash, a folder, the archive) over a filing, a rule over the engine, the last of equals, and only among those whose effect still holds. A later rule's delete over an earlier archive, an archive over a filing the user then takes off.
2. **The user's own move ends a placement only when it takes the conversation out of the Inbox view** (astra 5, fable 2): `act` and `moveToFolder` end the placements of conversations that were back in the Inbox view and changed. Deleting a rule-archived conversation keeps its placement (hidden while it's in Trash), so Undo finds it in Put away again; archiving it again keeps it too.
3. **A move on another device** (fable 8): `sync.updateFlags` ends the placement of a conversation the server puts back in the Inbox view.
4. **Every fix acts on the placement the window showed** (astra 2): `putAway.back` takes `{ threadId, at }` items, `putAway.keep` and `putAway.stopRule` an `at`; a newer placement, or none, refuses (`errors.putAway.changed`).
5. **Back to Inbox** (astra 3, astra 6, fable 9): the move back first, then out of every hidden category (the user's own filing too: Back to Inbox means the Inbox), the rows returned whole (`added_by`, `added_at`, `batch_id`), so Undo puts each back as it was; a failure after the move still returns its Undo. With nothing moved it says nothing.
6. **Stop this rule** (astra 9): the hash is checked again where the rule is written (`setEnabled`'s `still`), and Stop shows only while the rule is on (`ruleEnabled`).
7. **Don't file … automatically names who it's about** (astra 4, fable 7): Terno's snapshot keeps the sender the decision read (`senderName`) apart from the newest mail's (`fromName`, Needs a look's). Its Undo takes back only what it did: a kept row made again by another hand stays, a newer decision isn't replaced, `batch_id` comes back.
8. **Visibility as the Inbox shows it** (astra 8): Gmail's and Outlook's tabs an account keeps apart are out of the Inbox view (`hidingSql`, `tabHiddenTest`).
9. **The Inbox's line** (fable 1, fable 3, astra 10, fable 5): a new event, `putAwayChanged`, when ingest or a body puts something away and when a window sees the line; the line asks on it, not on the unread counts. Opening Put away asks fresh and marks what it counted. The seen mark is written one at a time and never moves back; an answer counted before this window's acknowledgment shows nothing. Neutral copy, since it's often the user's own rule: "Mail from {name}, who you've written to, was put away."
10. **Long names** (astra 12): display text is cut to 400 characters when written, so every row reads back; the line counts what the page lists.
11. **The list** (astra 7, fable 11, fable 12): a deep refresh publishes every joined page's placements; the sections carry no counts (a busy day isn't all loaded); the row gets its placement as a prop from Put away's list, so no other list's rows read Put away.
12. **Less work** (fable 6, astra 13): a command builds its watch only when an enabled rule or the engine's own filing can place something; the hidden categories are read once a command; IndexedDB prunes at most once an hour.
13. **Smaller pieces** (fable 10, 13, 14; astra 14, 15): names read reactively; the reasons said once (`whyOf`); the stores share `ruleNote` and the precedence; `ownList(s)` and one `keepOwnListValid` replace the hand-written checks; Edit rule opens that rule in the builder; the auto-filing toast's View opens Put away for a hidden category; failures say what didn't happen and what to do.

Declined, with the measurement: an ordered index for IndexedDB's pages. The table is a week's worth; at 5,000 placements its first and 40th pages take under 1 ms.

## QA panel (seven personas, at the owner's request)

Seven simulated testers, each with their own copy of the demo mailbox, a week of mail that rules and Terno's filing put away, and their own settings: Marta (Spanish, macOS, light), Devon (keyboard only, Graphite list, dark), Priya (rules power user, Lumen), Joe (not technical, Relief, dark), Kenji (designer, Atelier), Amara (compact Luma, many at once) and Sam (macOS, dark). Each drove the web build with Playwright and reported what they did, what they found and six scores. The trust score ranged from 4 to 7 and "I'd keep it on" from 7 to 9; the lowest trust scores came from mail that a rule moved without a trail (Priya, Sam), not from anything Put away showed.

Fixed from the panel:

1. **Every fix speaks and undoes** (Marta 1, Kenji, Joe 1): the box's Not {category} says so in a snack with an exact Undo; the Undo after Back to Inbox is named "Undo: …" for screen readers, as the others are.
2. **Back to Inbox everywhere in Put away** (Marta 6, 7, Amara): it leads every box, Terno's filings too, and is in the row menu and the selection bar (several at once, one Undo); typing "Inbox" in Move to… offers the Inbox instead of creating a category with that name.
3. **The box says what's true now** (Marta 5, 11, Priya): after Don't file … automatically, the box says Terno asks first now instead of offering it again; a rule that's off says "That rule is off now."; Stop on a rule already off and Edit on a deleted rule say so instead of failing.
4. **Plainer words** (Joe 3, 7, Marta 12): "moved this to the Trash", never "deleted"; the footer names Gmail's Promotions and Social and Outlook's Other, says where to find them, and that Spam isn't listed here; Settings calls kept senders "Senders Terno asks about" with "File automatically again".
5. **Row lines that fit** (Marta 13, Amara): shorter reasons ("Archived · your rule “Xataka”", "Recibos · filed by Terno"), the whole sentence in the row's tooltip, no second category dot, room for the reason on compact one-line rows.
6. **The Inbox's line** (Marta 9): the name in bold, the subject left out so it stays one line; Review moves focus to the list.
7. **Position kept** (Marta 2, Devon): search from Put away returns to Put away on Escape; when a fix removes the focused control, focus goes to the box's first fix, else the reader's toolbar; the help (i) opens on click as well as hover.

Not bugs: Priya's missing Inbox line (the setup check had opened her Put away, which marks it seen) and Sam's (he had already reviewed it).

Left for the owner: whether "Save and apply to existing mail" records placements; whether Terno's learned rules may cover a whole domain or people you've written to; whether Stop this rule offers to bring back what it moved; whether Back to Inbox and Undo advance to the next conversation (and mark it read); the Spanish name ("Apartado"); whether Don't file … also brings the sender's other filed mail back; a count or a shortcut for Put away; a setting for the Inbox line.

## The owner's decisions after the panel

The owner took every recommendation:

1. **A rule run by hand puts away too.** "Save and apply to existing mail" (`filters.applyChunk`) watches what it takes out of the Inbox view, as new mail's rules do: each conversation gets a placement at the time of the run, with its fixes, and the Inbox's line for someone you've written to. `putAwayChanged` fires once a run, not once a chunk.
2. **A rule Terno made spares the people you've written to, unless it names that one sender** (`sparesCorrespondents` in core; `withoutCorrespondents` in each store, on new mail and by hand). A domain's or a list's rule learned from newsletters no longer sweeps up a colleague. A rule the user saves becomes theirs (plan 90) and moves everyone it matches.
3. **Stop's second step.** A rule that's off says how many conversations it still keeps put away (`ruleHolding`), and the box offers "Bring back all # it put away" when that's more than this one: `putAway.byRule` lists them (at most 500, Back to Inbox's bound) and Back to Inbox takes them, with one Undo.
4. **In Put away, the open conversation stays.** Back to Inbox (from the box, the menu or the selection), Not {category} and Don't file … keep it open and in its place, as a filtered list keeps the one you read (`leaveList` and `holdOpen`): nothing opens and reads the next one, and Undo finds the same conversation under the reader. It leaves the list once the selection moves.
5. **Spanish: "Fuera de Entrada"**, not "Apartado" (in Mexico "apartar" reads as layaway); the notice and Undo say "salió de Entrada" and "sacar otra vez de Entrada".
6. **Don't file … says it's about new mail:** "From now on Terno asks before filing {sender}'s mail in {category}; what's already there stays."
7. Declined for now: a count or a shortcut for Put away, and a setting for the Inbox line.

## Codex code review of the panel's and the owner's commits

Codex reviewed `a4888e48f..ce60174dd` (11 findings); every one is fixed, each with a test:

1. **Not {category}'s Undo is exact** (#1): a new `putAway.not({ threadId, at })` checks the placement the box showed and leaves the category through the journaled move (`beginMove` with `leave`, plan 77), so `categorize.undo` puts back Terno's own filing, its decision and its examples, and Put away lists it again. Before, Undo filed it as the user's, which Put away doesn't count.
2. **Bring back all acts only on that rule as it was** (#2): `putAway.byRule` takes the conversation's placement (`{ threadId, at }`), refuses while the rule is on, and matches the rule's hash as well as its id.
3. **A +tag address is the same correspondent** (#3): the sparing and Needs a look read `correspondents` by `addressKey` (SQLite's `terno_address_key`), as the table is written.
4. **The scan of a stopped rule's placements is the reader's alone** (#4): `ruleHolding` is added by the backend to the reader's detail, not by `putAway.of`, so Back to Inbox's checks of 500 items pay a key read each. The perf gate times the scan at 5,000 placements: 21 ms in SQLite, 6 ms in IndexedDB.
5. **Spared by conversation, not by message** (#5): a rule Terno made leaves alone any conversation someone you've written to is in, so a notification in a colleague's thread can't file the thread.
6. **The held row leaves when the selection moves** (#6), and the row menu offers Back to Inbox only for a row with a placement.
7. **Focus after a fix waits for the reader's new read** (#7): watched for a second, left alone once the user moves focus.
8. **More than 500 go back in turns, under one Undo** (#8); Bring back lists them all (no cap).
9. **The snack says where it is now** (#9): `putAway.not` and `putAway.keep` answer `inInbox`, and a conversation another hidden category still keeps out is "Out of {category}", not "back in the Inbox".
10. **Move to… → Inbox on a whole view's selection** acts as the bar's Move to Inbox (#10).
11. **A rule run by hand watches only when its actions can put mail away** (#11, `ruleCanPlace`).

## The Put away rating set

Plan 158's sets don't show Put away, so it has its own, `--screens putaway`, like What matters' (plan 214): five states on a seed (`apps/backend-dev/src/put-away-seed.ts`) at the AI set's instant, with `brief-pa.md`. docs/ui-rating.md says how to run it.

## UI rating, first rounds (2026-11-25)

- Everyday set at `ce60174dd` (`/tmp/terno-scratch/rating/p282-r01`): overall 6.5 to 8 by style and rater, below the bar as before this plan (plan 158's first climb stalled near 7.5); one rater named "Put away" among the coined terms, nothing else of this plan's.
- Put away set at `8094aab82` (`/tmp/terno-scratch/rating/pa-r01`): overall 6 to 7 (Claude 6 to 6.5, Codex 7). Their shared points: a row brought back lingers with no state, then leaves and the list jumps; focus falls on the toolbar's Archive after a fix (Enter archives again); the box's fixes read as text, not controls, with text-high targets and no keyboard path; Needs a look's reason ("you've written to them") is what truncates, and its heading looks like a day's; "Don't file … automatically" promises more than its snack says, and the snack truncates at 1100x700; Review in the Inbox line is easy to miss.

## After the first rating (the owner: "start the improvements")

What the raters agreed on, changed:

1. **Focus after a fix goes to the list**, never the toolbar, whose first control archives (Enter undid the fix).
2. **A row brought back says so and keeps its place**: "Back in the Inbox" (or "Out of {category}" when another hidden category still keeps it out) in the row's ink, under its own day, until the selection moves (`returned` in the Put away state; its placement kept for the sections).
3. **The box's fixes are buttons**: BoardUI's small secondary for Back to Inbox, outline for the rest, at the control height rather than the text's.
4. **A keyboard path**: Back to Inbox leads the reader's toolbar for a put-away conversation, before Archive.
5. **Needs a look says who it's about** ("from people you've written to" after its name, the name in the ink), and its rows lead with "You've written to them", so a cut row keeps it.
6. **The window is said under the title**: "The last 7 days" (display headers).
7. **The sender fix and its snack say the same, briefly**: "Ask before filing {sender}"; "Back in the Inbox. Terno asks first for {sender}'s new mail" fits at 1100x700.
8. **The help opens on a click even after hover opened it** (it toggled closed; Base UI's own close on the trigger's press is ignored there).

Kept: the Inbox line's Review stays the learned offer's link (the two share the line's place and look).

Codex reviewed that commit (11 findings). Fixed: Back to Inbox releases the hidden filings first and then moves whatever still keeps the conversation out of the Inbox view, a Gmail or Outlook tab included, through the Inbox action (refiling if that fails), and answers the conversations it brought back (#1, #5); the toolbar shows one Inbox action and its width fit counts it (#1, #8); focus after a fix is shared by the box and the toolbar, and falls to the reader where the list is under it (#2); a row brought back offers nothing more to act on (#3); only a row a fix here brought back is held (#4); a windowed refresh doesn't look for the held row (#7); long fix labels wrap inside their buttons (#9); "The last 7 days" stays on a short window and on scroll (#10); the sender snack names the category again (#11). Declined: a row brought back from Needs a look stays under that heading (#6): it's held where the user acted, and says "Back in the Inbox".

Second rating (`/tmp/terno-scratch/rating/pa-r02`, at `72ee270f4`): overall 6.5 to 7.5 (from 6 to 7). Changed after it: a Needs a look row says who did it, whole (its heading says why it needs a look: leading with "You've written to them" cut off the cause); Terno's rule's date stays in the box (a row under Today read "Oct 13"); the reason line is in the headings' firmer ink, not a preview's; Back to Inbox is the box's primary button.

The owner's calls on the second rating's open points (2026-11-25): no shortcut for Back to Inbox ("nobody will use it"); no extra toolbar icon (it shifted the others), so the reader's toolbar is as on main; Put away stays under More; the Inbox line's Review is a small outline button at the line's end, and the rule offer's Create rule with it (they share the place and look; plan 159's "at the text's weight" test now checks the button at the line's end).

Then the owner: Review back to text, right after the line (no margin of its own: a wrapped line starts it at the left edge), in blue. A palette's primary isn't blue in Lumen, Graphite, Relief or Atelier, so there's a `link` token: the primary where it's a colour (as `ai`), else a blue, held to 4.5:1 on the background, a pane, a card and a menu (four new contrast pairs). The rule offer's Create rule is the same text link, and plan 159's test of it is back as it was.

Third rating (`/tmp/terno-scratch/rating/pa-r03`, at `c698cf50d`): Claude 6.5 to 7, Codex 7.5 in every style (round 1: 6 to 7; round 2: 6.5 to 7.5). Still shared: the reason line reads as a preview, not the row's point; the box's outline fixes look disabled in dark; the fixes are a long Tab away (the owner: no shortcut); a bulk Back to Inbox drops its rows while a single one keeps its row; Put away doesn't hear a rule turned off in Rules until it reads again; "Ask before filing" explains its scope only afterwards.

The owner took all five of the third rating's points (2026-11-25), built in `a136362c3`: the reason line opens with Put away's mark (the Inbox's once brought back); several brought back stay as one does, each saying so, until you leave Put away; the box's other fixes on the secondary fill; Not and Ask before filing say what they do before they're pressed; a rule changed anywhere tells Put away.

Codex reviewed it (10 findings). Fixed: a Back to Inbox in turns marks each turn as it lands, and one that fails partway offers its Undo (#1); the reader's Inbox button (Trash, a separate tab) takes a put-away conversation back by Back to Inbox's path (#2); a selection's Back to Inbox clears its checks, as any action on a selection (#3); another action on a row brought back retires what it says (#4); held rows go back in the store's order, so a section stays one (#5); a rule's Undo in Rules is Put away's news too, and every cached box that speaks of a rule reads afresh (#6); new mail put away updates only the Inbox line, rule changes alone reread boxes and Put away (`putAwayChanged { rules }`, #7); held rows don't deepen a windowed refresh (#8); a row only out of one category shows Put away's mark, not the Inbox's, and Not's hint says what it does (#10). Left: a live rule change removing the focused fix (#9, rare: focus stays where the user was until the box re-renders).
