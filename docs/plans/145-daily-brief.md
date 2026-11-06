# Plan 145: Daily brief (Today)

- **Status:** built and on `main`, code-reviewed in two rounds (see "What building it changed" and "What the code review changed"). The real-model eval (`scripts/ai-real/digest.real.ts`) is written and not run: it and the owner's read wait for the owner's go-ahead. "Revisions after the Codex review" overrides the sections before it.
- **Builds on:** plan 17 (`waiting_since`, who is a person), plan 142 (due follow-ups), plan 87 (reminders, one timer, group headings in a list), plan 86 (Gmail tabs), plan 132 (stored summaries, the worker's rules), plan 131 (AI base), plan 113 (tips), plan 122 (the Time Field).

## The request

> **Daily brief:** a short list of what needs you today, with newsletters folded into one digest.

## Decisions (the user, 2026-11-05)

| Question | Decision |
|---|---|
| Where | A **Today** row at the top of the sidebar opens a list with labelled sections, using ordinary rows. The digest is one row that opens in the reader |
| When | At a set time, 8:00 by default and changeable, with one timer. If the app was closed, at the next open. A notification is optional and off by default |
| AI | "Needs you" comes from local facts and summaries already stored. **Only the newsletter digest calls a model** |
| Newsletters | Digest, with an **Archive all** that has exact undo. The Inbox is untouched until then, and nothing moves on its own |
| What the digest reads | The Inbox and Gmail's Promotions tab, not Social |
| Who sees it | "it's on by default when they enable the pro plan or have their own ai keys, otherwise it doesn't show for free users" |

**How the last one reads in the design:** Today appears for anyone with an AI provider set up (their own key or a local model today, Pro once it exists). Without one, there is no row, no list and no work, even though most of the list wouldn't need a model. **The digest stays its own opt-in inside Today,** because it sends mail with no click, and plan 132's rule is that such a feature is never on by default.

## What exists

- **Inputs, all local:** `waiting_since` and `inboxWaiting` (plan 17), due reminders (`reminders.threads`), and follow-ups (plan 142). Stored summaries (`ai_summaries`, plan 132) when that's on.
- **Lists that aren't views:** `reminders` and `reviewCategoryId` in `state/app.ts`, `fetchPage`'s one bounded page, `currentScope()` null. `navigate` already resets them.
- **Group headings:** the Inbox's top uses a heading as the virtualizer's `paddingStart` and extra size on a group's last row (plan 87's follow-up). That handles one group; Today has up to three.
- **Newsletter signals:** `list_id`, `is_bulk`, `person`, `gmail_labels`, `threads.tab` (0 Primary, 1 Promotions, 2 Social). Notifications such as GitHub's also carry a `List-Id`, so these signals find candidates, not newsletters.
- **Codes:** `findCode` (plan 72). **No Drafts view:** drafts are the strip above a list, which Today keeps.
- **Shortcuts:** `g t` is Sent, so Today has none by default (plan 86: "shortcuts stay scarce"). The palette has "Go to Today".
- **Time Field:** ported, lazy (`BOARDUI.md`, plan 122).

## Design

### 1. Who sees it

`aiFeaturesAvailable(settings, entitlement?)` in `@terno/core`: true when a provider is configured, and when Pro exists, also with an active entitlement. One helper, so Pro joins in one line (plan 85 decision 10). It reads no provider ids beyond "none", and the architecture test still passes.

- **Available:** the row shows, unless **Settings → General → "Show Today"** is off. It's on by default.
- **Not available:** no row, no palette entry, no timer and no queries. If the key is removed while Today is open, the app goes to the Inbox. The digest's data stays until Clear AI data.
- **The app still opens on the Inbox.** Today never takes the first screen.
- **A tip** (plan 113), `today-first`, the first time the row appears, with a picture of the row. Once, as tips are.

### 2. The list

App state gains `today: boolean`, as `reminders`: no scope, no quick filters, one bounded page. A new RPC:

```ts
"today.list": m<{ sections: TodaySection[]; digest: DigestRow | null; now: number }>()(empty)
type TodaySection = { kind: "needsYou"; items: TodayItem[]; more: number } | { kind: "reminders"; items: TodayItem[] };
interface TodayItem { thread: ThreadSummary; why: { kind: "promise" | "nudge" | "waiting" | "reminder"; text?: string; dueAt?: number }; summary?: string }
```

```
Today                               Thursday, 5 Nov
NEEDS YOU
  Tom Reed     You said: send the contract by Friday
  Ana Ruiz     No reply in 5 days · Nudge
  Sara Lin     Can you make the 19th?
  Show all 9 waiting
REMINDERS
  Greenway     Lease renewal                     9:00
NEWSLETTERS
  ▤ 14 newsletters · today's digest
```

**Needs you,** at most 12 rows, in this order, a thread appearing once:

1. Promises due, by due time (plan 142).
2. Nudges due.
3. Threads waiting for your reply in the Inbox, newest first, through `threads_waiting_inbox`. The second line is the stored summary's first sentence if there is one and it's current, otherwise the snippet. No request is made for it.

**Show all N waiting** goes to the Inbox with plan 17's Waiting filter. **Reminders:** those due, and those coming due today, by time. **Newsletters:** the digest row (§4), or nothing.

**It's live, not a snapshot.** Facts come from the store each time, so replying removes a row on the next refresh, the way the rest of the app behaves. The open and checked rows stay until the selection moves (`keptIds`). The 8:00 preparation only concerns the digest and the notification.

**Empty:** "Nothing needs you today." with the digest row still shown if there is one.

**Rows are the ordinary thread rows,** so j/k, the reader, menus, undo and virtualization are all as elsewhere, with their render counts asserted.

**Headings:** plan 87's trick generalizes: a heading is space on the section's first row, reserved by its size function, drawn at its offset, and hidden from arrow keys. Named for screen readers as a group. Checked in all five designs: a section heading follows the list's content line.

**The digest row** isn't a thread. It's a list item with the reserved id `DIGEST_ROW_ID` (0, which no thread has). The list's selection and j/k treat it like a row, the reader shows the digest for it, and thread actions and the context menu are disabled on it. A test walks every place that takes `selectedId` as a thread.

### 3. The row in the sidebar

**Today**, at the top of the sidebar above Inbox, with an icon from the catalog beside its neighbours. It's named "Today" and shows the number of Needs-you items in the unread tone, and nothing at zero. **That count rides on the `counts` event:** `inboxWaiting` plus due follow-ups, both already known or a single indexed count, and `null` while plan 17's backfill runs, in which case no number shows. The Inbox's unread count and the Dock don't change.

### 4. The digest

**Off by default.** With it off, the Newsletters section is one row, "14 newsletters", that opens the same reader page without lines, with **Archive all** and a line: "Turn on the digest to get a line on each." Listing them sends nothing.

**Turning it on,** in that line or in **Settings → AI → Newsletter digest**: "Sends the opening of up to 40 unread newsletters a day to {provider}, to write a line on each. About {cost} a day." With the provider and model row.

**Candidates, all local.** A thread is a candidate when all of these hold:

- Its newest message is inbound and **unread**, and arrived since the last digest, at most 3 days back.
- `in_inbox = 1` and `tab` isn't Social. So the Inbox and Promotions, and threads in a user's hidden category, since a "Newsletters" category is the likeliest place for them.
- `person = 0`, and `list_id` is set or `is_bulk` is true.
- Not Gmail's Updates: those are receipts and alerts (plan 86). IMAP has no such label, so the model decides there.
- Not starred, not replied in, no `findCode`, not Spam or Trash.

At most 40, newest first. **The list without a digest uses the same query.**

**The task.** `AiTasks.digestNewsletters`, structured output through the ladder, `effort: low`:

```ts
input: { items: { label: string; from: string; subject: string; text: string /* ≤ 600 tokens, visible text */ }[]; language: string }
output: { items: { label: string; kind: "newsletter" | "other"; line: string /* ≤ 140 characters */ }[] }
```

- **`other` falls out:** ads, receipts, notifications. They don't appear and aren't in Archive all. Ones the model forgot fall out too.
- **Mail is material,** in delimited blocks. Unknown labels are dropped. No tools.
- **A small window** splits into batches of 10, sized from the session.
- **`AI_TASK_NAMES` gains `digest`:** the summary row's target if one is set up, else `claude-haiku-5-5` on Anthropic, `gpt-6-luna` on OpenAI, else the configured model. A default never moves mail silently, and the switch names it.
- **Limits:** a background task, 5 requests and 60k input tokens a day, and the monthly limit applies.
- **Cost:** 40 × 600 tokens on GPT Luna: about $0.002 to $0.004 a day.

**Data:**

```sql
CREATE TABLE ai_digests (
  day TEXT PRIMARY KEY,                -- YYYY-MM-DD, local
  state TEXT NOT NULL CHECK (state IN ('pending','ready','failed')),
  body_json TEXT,                      -- label-free: thread id, message id, from, subject, line
  attempts INTEGER NOT NULL DEFAULT 0,
  model TEXT, provider TEXT, prompt_version INTEGER,
  generated_at INTEGER
) WITHOUT ROWID;
```

Last 14 days, pruned in a background slice. Shape-only migration, empty, and the same table in `packages/idb/src/schema.ts`. Clear AI data empties it. Not exported or synced, not in search, not on `MCP_ALLOWED`. An import never turns it on. Removing an account drops its items at read. Failures follow plan 132 revision 4's table.

**The reader page.** Lazy, in the reader's column.

```
Today's digest                       Thursday, 5 Nov
14 newsletters                        [ Archive all ]
──────────────────────────────────────────────────
☑ Stratechery      Why AI margins look like cloud's
☑ Morning Brew     Fed holds; oil down 3%
☐ Pointer          A guide to Postgres index bloat
Written by GPT Luna. It can make mistakes.
```

- **A row opens that thread,** in the reader, with back returning to the digest.
- **Checks:** all ticked. Unticking leaves one out of Archive all. It's for now: no "never include this sender" in this version.
- **Archive all N** goes through `threads.act` with `narrow`, so what's starred since is spared, on the ordinary snack with Undo and `z`: "Archived 14 newsletters · Undo". Only ids this page lists: mail that arrived since isn't touched. After it, the row reads "14 archived".
- **It hides what's gone:** a thread already archived or read elsewhere stays listed with a muted tone and out of the count, so the page doesn't reshuffle while it's read.
- **A failed digest:** "Couldn't prepare today's digest." `errorHelp(kind)` and Try again, which counts as a person's request.
- Plain text only, never links: a line is a model's rewording of mail (plan 141's rule).

### 5. When it's prepared

**Settings → General → Today:** "Prepare at" (the Time Field, 8:00), and "Notify me when it's ready", off.

**One timer,** `armBrief`, as `armReminders`: at `start()`, on wake, on a settings change, and when it fires. Absent when Today isn't available, or when neither the digest nor the notification is on, since then there's nothing to prepare.

At the time, or at the first start or wake after it the same day:

1. If the digest is on and today has no row, write `pending` in one unit, so two wake-ups can't start two, and run it in the background. **Nothing waits on it.** Today shows its list at once, with the row reading "Preparing today's digest…" and the previous one reachable until it's done.
2. If the notification is on, and something needs you, and this is within 2 hours of the set time: one `MailNotice` of kind `brief`, "3 things need you today", with no names or subjects at all. A click opens Today. Once a day, kept in a setting. A late open says nothing: you're already here.

**Before the set time,** the list is live as always, and the digest row shows the last digest, with its date. **A day with no candidates** writes nothing and sends nothing.

### 6. Copy

`t()` and `L()`, `en` and `es` together: the row (es: **Hoy**), section headings, `why` lines, the digest page, settings, the notice, palette aliases. Plurals through the catalog. Dates through `Intl`.

## Tests

- **Availability:** no provider means no row, no palette entry, no timer, no `today.list`; a key removed while open goes to the Inbox; Pro's future entitlement is one line and tested with a fake; the setting hides the row.
- **`today.list` (conformance, both stores):** order and one row a thread; a promise beats a wait on one thread; caps and `more`; archived and answered threads leave; `null` count during plan 17's backfill; plan 142 absent or off leaves the section working; summaries only when current.
- **Candidates (conformance, both stores):** Inbox, Promotions, hidden category; Social out; a person, a read one, starred, replied, a code, Updates, Spam and Trash out; the 3-day and 40 limits.
- **The digest (fake provider):** off sends nothing; `other` and unmentioned items fall out; unknown labels dropped; injection on the scripted attack doesn't change the output; canary absent from logs and MCP; a body not here yet uses the snippet; failures per plan 132's table; limits; turning it off mid-run writes nothing.
- **The timer:** with fake timers, fires once at the time; a late start prepares once; two wakes don't double (the `pending` unit); a time change re-arms; absent with nothing to do; DST; `stop()` clears.
- **Notification:** off by default; once a day; none when nothing needs you; none past 2 hours; no names or subjects in it.
- **Archive all:** exact Undo in both stores; only listed ids; unticked spared; a star added since spared.
- **The digest row:** j/k stops on it; the reader shows it; thread actions and the menu are off; every `selectedId` consumer takes it safely.
- **e2e (`today.spec.ts`, `@design` for the row and headings):** with a fake provider the row shows, without one it doesn't; sections and rows; replying removes a row; Show all goes to Waiting; digest off and on; Archive all and Undo; the tip; en and es; axe light and dark; screenshots looked at beside their neighbours, in all five designs.
- **Eval (real model, gated, synthetic):** `scripts/ai-real/digest.real.ts`: labelled newsletters, ads, receipts and notifications in English and Spanish. Precision on `newsletter` matters most, since it decides what Archive all can touch. Invented facts in lines.
- **Release gate:** a run on a copy of a real profile, with the digest read by the owner.

## Performance

- **Not available:** one helper call. No queries or timer.
- **`today.list` ≤ 10 ms at 50k+ threads in both stores** (`today.perf.test.ts`), through existing indexes for waiting and reminders. Candidates need a new partial index only if the gate says so, and a shape-only migration if so: `threads(last_date DESC) WHERE in_inbox = 1 AND person = 0`, measured first.
- **The sidebar count** adds at most one indexed count to `counts`, under its existing budget (≤ 5 ms).
- **The list** virtualizes, with its render count asserted. **The digest page and settings are lazy.** Entry chunk unchanged except the row and its icon.
- **Migration ≤ 1 s:** an empty table. **Idle:** one timer at most, none when there's nothing to prepare. No polling.

## Out of scope

Today as the first screen. AI ranking of what needs you, or lines written for it (the user's choice). A notification by default. Calendar. Weekly digests. A persistent "never in the digest" list. Moving newsletters by themselves. Social in the digest. Pro gating itself, which arrives with plan 85, and joins through `aiFeaturesAvailable`.

## Order

Last of plans 141 to 145, because Needs You is at its best with plan 142.

1. `aiFeaturesAvailable`, `today.list`, conformance, gates.
2. App state, the list with sections, headings, the digest row, the sidebar row and its count.
3. Candidates and the digest page without AI, with Archive all.
4. `digestNewsletters`, table, worker, limits, the eval.
5. `armBrief`, settings, the notification.
6. The tip, copy, screenshots in all five designs.
7. Real run and the owner's read.

## Revisions after the Codex review

Codex (`gpt-6.1-sol`, high, read-only, `/tmp/terno-plans-141-145/145-daily-brief.out`) raised 12 points, all accepted. Each replaces what the sections above say.

1. **`threads.act` has no `narrow`** (`contract.ts:710`, `handlers.ts:405`), so a star added since would be ignored. A dedicated `digest.archive` rechecks eligibility right before each change, on the same undo journal.
2. **A thread id isn't what the digest listed.** Actions expand to a thread's current messages (`db/actions.ts:99`, `idb/mail.ts:1077`), so a new message in a listed thread would go too. The digest keeps its message ids and a stamp. A thread that changed is skipped, and the snack says how many.
3. **With the digest off, nothing has been classified,** and `is_bulk` includes `Auto-Submitted`, so a receipt can pass every candidate test (`people.ts:29`). That page is headed "Automated mail", shows original subjects with rows **unticked**, and its button is **Archive selected**. **Archive all** with its ticked rows needs the digest, because only it has sorted out what's a newsletter.
4. **The monthly ceiling must see it,** by plan 142 revision 8.
5. **A thread appears once in all of Today.** A row keys on the thread id (`list.ts:57`, `thread-list.tsx:675`), and a due follow-up can also have a manual reminder. Each thread goes to one section, Needs You first. A test covers a due follow-up with a reminder.
6. **A `pending` row needs recovery.** §5 starts only when today has no row, so quitting after writing it would block the day. An independent drain of `pending` runs on start and resume, with an in-memory single-flight. Completed batches are checkpointed in `body_json`. The limit becomes 10 requests a day, because four batches and repairs could use up 5 (`ladder.ts:56`).
7. **Delimiting isn't enough.** Every interpolated field, sender and subject included, is neutralized as `summarize.ts:72` does, so a newsletter can't forge a block and aim at another's label. Tested on the serialized hostile prompt as well as in the eval.
8. **"Since the last digest" needs a watermark.** Generation time would lose mail arriving mid-run, and sender dates lose delayed mail. The row persists the candidate scan's arrival cutoff, `created_at` with an id as tie-breaker, apart from `generated_at`.
9. **`keptIds` won't hold Today's rows.** It returns nothing without a filter (`list.ts:85`), so replying would move the reader. `today.list` takes `heldIds`, the open and checked rows, and merges them back at their previous positions until the selection releases them.
10. **The digest row can enter a bulk selection.** Select All and ranges take every loaded row (`select.ts:102`, `:115`), and a bulk action with `0` fails RPC validation. Cursor navigation is separate from actionable selection, and the row can't be checked. Tests: Select All, ranges, mixed.
11. **The read needs a strategy per store.** `threads_waiting_inbox` isn't in date order; `threads_waiting` is (`migrations.ts:839`). Newest-first waiting walks that, and IndexedDB's waiting order. Newsletters walk by arrival within the 3-day bound, so an empty result can't scan the mailbox, and any index is designed for both stores. Gated with sparse and empty results among 50k recent automated threads.
12. **The sidebar's count isn't a sum.** One waiting thread with two due promises would count three. It's the distinct union under Today's own eligibility, `null` during plan 17's backfill. Tested on that case.

## What building it changed

- **Show all N waiting** sits in the list's header rather than among the rows: a listbox holds only its options, and a button between them fails axe.
- **Section headings** are `aria-hidden`, drawn in the space a row leaves, as the Inbox's top is; a screen reader hears each row's own words. A row's second line is what it's there for ("You said: …"); Nudge is on the open conversation's line, not on the row, as it is elsewhere.
- **The digest's row** is a list item with id 0 that takes the cursor. `targetsOf`, `pick`, `addRange`, `toggleCurrent`, `pressRow`, `loadThread` and `scheduleMarkRead` all refuse it, so an action, a range or Select All can't reach it, and `today.list`'s `heldIds` leaves it out.
- **What's automated with the digest off** is kept fresh behind the list, at most every 30 s, since a walk among a lot of recent mail can take longer than the list's 10 ms. The row arrives by `todayDigest`.
- **The walk by arrival** is the same `messageWalk` plan 143 made: newest first, stopping at the 3-day bound or the watermark.
- **A notice's click** has `threadId` -1 (`BRIEF_NOTICE_THREAD`): both the web's and the desktop's notices pass one number through, and no thread has that id.
- **The gate** is `measureToday` in `workloads.perf.test.ts` on both stores, beside its neighbours, rather than a `today.perf.test.ts` of its own.

## What the code review changed

Codex (read-only, `git diff main..HEAD`) raised 15 points. One read main's newer commit as a reversal, and a rebase cleared it. The other 14 are fixed, each with a test that fails without the fix.

1. A pending digest sent what had since moved to Spam or changed: `stillListed` reads each before it's read, sent or checkpointed.
2. Deleted mail stayed in stored digests: reads filter it, and removing an account purges every stored row.
3. Archive read the listing again at action time, so a refresh could accept a newer message: it holds to the stamps the page saw.
4. Desktop rejected every brief's notice: `parseNotice` takes its sentinel and its empty senders.
5. The digest's ticks couldn't be used by keyboard: the named `Checkbox`.
6. Ranges and a selection begun from the digest's row could hold 0: every way in, and an action's targets, leave it out.
7. Undo pressed before Archive answered spent itself: a deferred result, as other sweeps have.
8. Undo didn't refresh an open digest page: it follows the list's refresh.
9. Removing the last key left Today on: `aiFeaturesAvailable` reads whether what's chosen can run (`needsKey`, worked out by the backend so the helper names no provider).
10. Shutdown never stopped it: `stop()` is wired in, and waits for what's underway before the store closes.
11. A bad key ended the day's digest: auth, not configured and blocked pause it, spending no attempt, and Settings or a new key resume it.
12. A small window got oversized batches: `digestBudget` sizes the whole request, headers and repairs included.
13. The gate left out the walk's setting up: each page's time holds it now.
14. The test for a thread appearing once never made its fixture: two real due promises and a reminder, and it says so if they're missing.

Round two, on those fixes (6 points, all fixed):

15. Spam could still reach the provider while a request waited to leave: the limiter asks again as any digest request goes, repairs included, and stops it; the rest are asked about without what went.
16. A late checkpoint brought back what a purge removed: each writes over what's there now.
17. A deleted message's words stayed when older mail kept the thread: entries go by the message they quote, at every read and tick.
18. Repairs could still overflow a small window: the budget holds three answers and what the repairs ask.
19. A kept notification could open a Today that's gone: its click reads whether there is one, else the Inbox.
20. The desktop's brief had no test: it does.

## What the full run showed

- **The listeners moved to boot.** `client.on` at the load of `state/today.ts` and `lib/replies.ts` broke 41 web test files, whose mocks have no connection yet; `installToday` and `installReplies` run where the other listeners do. Plan 144 had landed with the second of these.
- **e2e keeps Today's row off unless a test opts in** (`test.use({ today: true })`, as `tips` does). The demo has an AI provider, so every baseline and every sidebar measure would otherwise hold it. `today.spec` holds the row in all five designs. Settings → General's group does show, so `settings-general` and its Spanish copy were updated, after being looked at.
- **Today's tip can sit over the list's first rows** on a first launch with AI. Two packaged smokes clicked there, and they now close it with Esc, as a person would. A click on the tip's own area doesn't reach the row under it, which is how every tip behaves (plan 113).
