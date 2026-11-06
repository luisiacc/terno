# Plan 143: Actions in plain English

- **Status:** built and on `main`, code-reviewed in two rounds (see "What building it changed" and "What the code review changed"). The real-model eval (`scripts/ai-real/actions.real.ts`) is written and not run: it and the owner's read wait for the owner's go-ahead. The full suite runs once, after plans 141 to 145 are all in (the owner's call). "Revisions after the Codex review" overrides the sections before it.
- **Builds on:** plan 141 (Ask's box, its planning step, its history), plan 63 (sweeps, what they skip, one undo), plan 89 (patterns, `#`), plan 90 (`auto`, compare-and-set), plan 83 (hidden categories), plan 116 (forwarding), plan 128 (moving to a folder), plan 134 (what a model may do by itself).

## The request

> **Actions in plain English (likely the cheapest):** "Archive shipping notices older than a month, except Amazon" or "Send recruiters to a Recruiting category." The model turns the sentence into an action or filter, then shows a preview with exact undo. Filters and categorization already have previews.

## Decisions (the user, 2026-11-05)

| Question | Decision |
|---|---|
| Finding the mail | The model writes a rule. Terno finds candidates locally. The model then checks their senders and subjects, never bodies, and drops false matches |
| Future mail | A "+ new mail too" checkbox in the preview, ticked only when the sentence implies it |
| What a sentence may do | Archive, mark read, star, move to a category or folder, trash, spam, and create a category. **Not** reminders, unsubscribe or forwarding |
| Where | Ask's box in the palette. The preview is in the list, with the exact rows, and nothing runs until Apply |

## What exists, and three things it doesn't do

- **`filters.generate`** (`handlers.ts:883`, `wire.ts`): a sentence to a validated `FilterRule`, sending only the description, account names, category names and today. The filters dialog uses it and shows `filters.preview`: a count and 6 samples.
- **`filters.matchWindow`** finds a rule's messages in id windows, without blocking. `filters.apply` uses it.
- **`actOn`** (`handlers.ts:135`) acts in slices with a journal, one Undo, and a `narrow` that re-reads what a sweep may still touch. `categories.moveThreads` returns a `batchId` for `categorize.undo`. `folders.moveThreads` returns an `undoId`.
- **The list** has a precedent for a list that isn't a view: `reviewCategoryId` and `reminders` in `state/app.ts`, each one bounded page with no scope.

What the request assumes and the code doesn't have:

1. **`filters.apply` has no undo.** It can't be what runs here. "Exact undo" means going through `actOn`, `categories.moveThreads` and `folders.moveThreads`, each of which journals.
2. **A rule is flat:** `match: all | any` over its conditions. "(shipping or delivery) and older than a month and not Amazon" can't be written with `any`. It can with `all` and a `matches` condition, because a regular expression holds the alternation: `subject matches (shipping|delivery|tracking)`. Plan 89's `checkPattern` and 300-character limit apply. Patterns don't run on `body`, so a meaning found only in bodies needs `text contains`, which only ever ANDs.
3. **A rule's age condition can't apply to new mail.** `ageDays gt 30` never matches on arrival, so a sentence with an age limit can't also be a lasting filter. The checkbox goes away for those, and doesn't silently drop the limit.

And one surprise from plan 134: `categories.create` defaults `showInInbox` to false. "Send recruiters to a Recruiting category" takes that mail out of the Inbox, so the preview says so.

## Design

### 1. From a sentence to a plan

The palette's `ask` page (plan 141 §1). `planAsk` says `kind: "command"`, and the page moves on to a new `AiTasks.planAction`, on the same planning model, with the same inputs: the sentence, today, account names and addresses, category and folder names. **No mail.**

```ts
interface ActionPlan {
  summary: string;     // "Archive shipping notices older than a month, except Amazon"
  action:
    | { type: "archive" | "trash" | "spam" | "markRead" | "star" }
    | { type: "moveToCategory"; categoryId: number }
    | { type: "createCategory"; name: string }
    | { type: "moveToFolder"; accountId: number; folder: string };
  conditions: Condition[];  // the existing schema, match always "all"
  lookIn: "inbox" | "everywhere";  // everywhere still leaves out Spam and Trash
  future: boolean;     // the sentence implies new mail too
  meaning: boolean;    // the sentence names a meaning ("recruiters"), not literal words ("from ups.com")
}
```

- **Validation** reuses `filterRuleSchema` and `checkPattern`. A repair goes through the ladder as `generateFilter`'s does. An action outside this list, forwarding above all, fails validation: a page line says "Terno can't do that from a sentence. It can archive, delete, mark as spam, mark as read, star or move mail."
- **Which mail it looks in:** `lookIn` defaults to `inbox` for archive, `everywhere` for the rest, and the sentence can say otherwise. The preview says which.
- **Unclear sentences:** nothing in the plan is guessed silently: the preview shows the rule in words, and a rule with no condition fails ("Which mail do you mean?").
- **A question that looks like a command,** or the reverse: it costs a glance, since a command never acts before Apply.

### 2. Candidates, locally

A job in the backend, with a `previewId` held in memory for that connection (dropped on Cancel, Apply, disconnect, or 30 minutes after last use):

- `filters.matchWindow` in id windows, 4,000 or 1,000 with a pattern, as `filters.apply` does, yielding between them. Messages become threads.
- **Eligibility as plan 63:** archive needs the Inbox; trash and spam skip what's already there. Starred threads and threads you replied in are **skipped and counted**, and the preview offers "Include these".
- Up to `SCOPE_CAP` threads. Beyond it, the job stops and says "That's over 100,000 conversations. Narrow it."
- The palette closes as soon as the job starts, and the preview opens with the count growing, so nobody waits on a page.

### 3. The model checks, when the sentence is about meaning

Only when `meaning` is true. Literal sentences skip this and send nothing but the sentence.

- **Grouped, to be cheap and fair:** distinct `(from name, from domain, normalized subject key)` with their counts, newest first, up to 200 groups a request, labelled `g1`, `g2`. **Never a body, never a full address.** Plan 89's `subjectKey` folds "Order 4379" and "Order 3052" into one.
- `AiTasks.checkCandidates`, on the planning model: `{ drop: string[] }`, the labels that don't fit the sentence. An unknown label is ignored. Mail goes in a data block as material. The result can only remove rows, and the user sees what's left.
- **More than 200 groups:** up to 3 requests, so 600. What's still unchecked is **left out** and said: "1,204 more weren't checked · Check more" is a button. On an archive or a trash, leaving out is the safe side.
- **Consent, once per cloud provider,** inline in the preview before the first check: "This sends the senders and subjects of up to 200 matching conversations to {provider}." · **Continue** · **Skip the check**. Skip leaves the rule's matches as they are. This changes what AI filters promise ("never message content") for this path only, and the Settings hint says so.
- **Cost:** 200 groups at about 25 tokens on Haiku 5.5 or GPT Luna is under $0.001. A person's request: a foreground permit, `byHand`.

### 4. The preview is the list

App state gains `actionPreview: { id, previewId } | null`, one more list that isn't a view (`listKey`, `otherList`, the search-close check, tabs). `fetchPage` pages `threads.summaries` over the preview's ids. It's virtualized like any list, so rows, j/k, the reader and menus are all the ordinary ones. Opening a row to check it marks it read as usual.

```
Archive 412 conversations                 Cancel   Apply
Inbox · subject mentions shipping, delivery · older than a month · not from amazon.com
Skips 6 starred or replied · Include
☐ + new mail too
──────────────────────────────────────────────────────
☑ UPS          Your parcel is on its way       3 Oct
☑ DHL          Delivery scheduled              1 Oct
──────────────────────────────────────────────────────
Left out by AI (12)                                   ⌄
☐ Ana Ruiz     Shipping the prototype         28 Sep
```

- **The header** takes the list header's place, aligned with its content line. The line of conditions uses `describeCondition`, and generated patterns read as their `#` templates. "Edit as a filter" opens the rule in the filter builder, when it's a filter you want.
- **Rows have checks,** the existing check state and `x`. A row's check here means "include", and the count follows it. **Left out by AI** is a collapsed group at the end, each row can be ticked back in.
- **Apply** is the primary button, `mod+enter` too. **Cancel** and Esc go back to the list and scroll position you left, with no trace.
- **Destructive wording:** a trash says "Move 412 conversations to Trash", a spam "Mark 412 as spam". The button repeats the verb.
- **Nothing matches:** the preview doesn't open. The page stays, with the sentence, and says "No mail matches that. Try different words."
- **Category:** a hidden one says "These leave the Inbox." A new one says "Creates the category Recruiting."
- **New mail during the preview** doesn't join. What it does is what it showed.
- **Every design:** the header is one piece in the list's column, with no design-specific variant. `@design` screenshot check beside its neighbours, in light and dark.

### 5. "+ new mail too"

A checkbox, ticked when `future` is true, and otherwise not. On Apply it saves a filter, for mail that arrives from then on.

- `filters.save` with `source: "ai"`, `auto: false` (the user asked for it, so it's under "Your filters", plan 90), named from `summary`, reusing an identical rule (`sameRule`).
- **The saved rule is what the check learned.** Senders the model dropped become `fromDomain` or `from` negated conditions while they fit: 20 conditions, 300 pattern characters. Those that don't fit disable the checkbox: "Too many exceptions to keep as a filter."
- **The checker doesn't run on new mail.** A filter is a rule. So the preview adds, while ticked: "New mail is matched by the rule alone." Plan 134's AI suggestions remain the path for meaning on arrival.
- **Hidden when it can't work:** an `ageDays` condition (new mail is never a month old). **Disabled with a reason** on a category that forwards (plan 116): a rule a model wrote mustn't send mail to a third party. A one-time move to such a category is allowed, since a one-time move doesn't forward old mail, and the preview says so.

### 6. Apply and exact undo

| Action | Runs through | Undo |
|---|---|---|
| Archive, trash, spam, mark read, star | `actOn` with `narrow` (a star added meanwhile wins) | `threads.undo` |
| Move to a category | `categories.moveThreads` (a move is exclusive, the product's rule) | `categorize.undo` |
| Create a category | `categories.create`, then the move | removed only if it's still empty and unedited |
| Move to a folder | `folders.moveThreads` | its `undoId` |
| + new mail too | `filters.save` | `filterUndo` (plan 90: never deletes one edited since) |

- **One Undo reverses it all,** in reverse order, on the existing snack and `z`: "Archived 412 conversations · Undo". Progress is `trackJob`'s, cancellable.
- **A partial failure** keeps what committed with its undo (plan 90's code review), and says how much happened.
- **Spam:** this doesn't create a filter by itself, unlike plan 63's spam sweep. Here the checkbox is the single place that decides the future, and it's ticked by default on spam, since marking a sender spam means that.
- **Training:** filing goes in with the existing `bulk` source: the user approved these exact rows. Unticked rows and the model's choices train nothing.
- **It never runs without Apply.** No code path from a sentence to an action skips the preview. A test holds it.

### 7. History

A command is a turn in plan 141's history with `kind: "command"`, and `sources_json` empty. It stores the sentence, the summary and the outcome ("Archived 412"). Reopening from Previous AI questions shows that and **Run again**, which plans afresh and shows a new preview. Undo isn't offered from history: the journal has its own lifetime.

### 8. Settings

Nothing new to turn on: it shares `ask.enabled` and Ask's planning model, since it's the same box. Ask's hint in Settings → AI gains: "Commands send your sentence, and for meanings like \"recruiters\" the senders and subjects of matching mail, never the text." The filters dialog's generator stays as it is.

### 9. Copy

`t()` and `L()`, `en` and `es` together, with plurals: every verb's header and button, the conditions line, the consent line, reasons a checkbox is off, palette aliases. English-only wire words stay on the model's side.

## Tests

- **Plan validation (unit):** forward, unsubscribe and any other action fail; `match` is always `all`; a pattern over the limit is repaired or refused; a rule with no condition says so; literal vs meaning on a table of sentences with the fake.
- **Candidates (conformance, both stores):** the same ids in both; eligibility per action; starred and replied skipped and counted, included on request; age and negation; `SCOPE_CAP` stops and says so; spam and trash left out of `everywhere`.
- **Check (fake provider):** no body or full address in the request (canary); only `drop` removes; an unknown label is ignored; injected instructions in a subject don't change the result on the scripted attack; 200 groups a request, 3 requests at most, the rest left out and named; Skip sends nothing.
- **Safety:** no path acts without Apply; a `previewId` from another connection is refused; a star added during the preview is respected; a preview past its expiry says so and acts on nothing.
- **Undo, end to end:** each row of §6's table comes back exactly, in both stores; a category created is removed only if empty and unedited; a filter edited since survives; a partial failure keeps its undo; one `z` undoes all of it.
- **New mail:** the checkbox's default follows `future`; ticked saves a filter under Your filters, unticked saves nothing; age hides it; a forwarding category disables it; exceptions that don't fit disable it; the saved rule matches a new arrival.
- **e2e (`plain-actions.spec.ts`, no tag):** both sentences from the request through the fake: palette, preview rows, untick one, Apply, snack, Undo; Cancel returns to the same scroll position; nothing matches; a new category with its hidden-from-Inbox line; history shows the outcome; en and es; axe light and dark. `@design` only for the header, with screenshots looked at.
- **Eval (real model, gated, synthetic):** `scripts/ai-real/actions.real.ts`: 40 sentences in English and Spanish over a labelled mailbox: rule correct, precision and recall before and after the check, right action, literal sentences skipped. **Precision on trash and spam is the bar:** the eval says whether the default needs raising.

## Performance

- **Candidates hold at 50k+ threads in both stores** (`actions.perf.test.ts`): no stall past the slicer's budget, with and without a pattern, reusing plan 89's gate shape.
- **Groups:** counted over the ids in slices, memory bounded by the groups kept.
- **The preview** holds at most `SCOPE_CAP` ints in the backend, for one preview, released on leaving. The list virtualizes, with its render count asserted.
- **No migration:** plan 141's tables hold the history.
- **Lazy:** the preview's header is its own chunk. Idle: no timers, no work.

## Out of scope

Reminders, unsubscribing and forwarding by sentence (the user's choice). A model running on each new mail for a meaning (plan 134's suggestions do that). Rules with nested groups. Scheduling a command to run later. Undo from history. Replacing the filters dialog's generator. Pro gating, which arrives with plan 85.

## Order

1. `planAction`, validation, prompt v1, fake, contract tests, the eval.
2. The candidates job in both stores, gates.
3. The preview list and header, Cancel.
4. Apply and Undo per action, then together.
5. `checkCandidates`, consent, Left out by AI.
6. "+ new mail too" and its rules.
7. History, Settings, copy, real run.

## Revisions after the Codex review

Codex (`gpt-6.1-sol`, high, read-only, `/tmp/terno-plans-141-145/143-actions-in-plain-english.out`) raised 12 points, all accepted. Each replaces what the sections above say.

1. **A one-time move can forward mail.** §5 is wrong: a single-thread move schedules a forward whatever its source (`handlers.ts:591`), so a preview reduced to one recent conversation could send it to a third party. This path passes an explicit no-forward intent, enforced in both stores, and forwarding status is checked again before saving a filter. A sentence never forwards anything.
2. **Thread ids don't freeze what Apply touches.** Both stores act on a thread's current messages (`db/actions.ts:99`, `idb/mail.ts:1077`), so a reply arriving before Apply could be trashed unseen. The preview keeps a stamp per thread. A thread that changed is left alone and counted: "3 changed since the preview and were left alone." Tested during the preview and during a sliced Apply.
3. **Preview inclusion isn't the check state.** Actions go to every checked row (`selection.ts:75`), and a refresh prunes checks (`list.ts:196`), so reusing it could archive the whole preview with `e`, or lose inclusions. The preview has its own exclusion set, which `x` toggles there. Multi-select is off in a preview, and a single row's own action applies to that row alone.
4. **`filters.save` has neither reuse nor undo.** Both live in `SimilarFilters` (`similar.ts:132`, `:200`), which writes `manual` and `auto: true`. A serialized, journaled ensure takes `source: "ai"`, `auto: false`, reuses safely and undoes by compare-and-set.
5. **A category move's failure keeps its undo.** `categories.moveThreads` creates a batch and then awaits, returning nothing on failure, and startup resumes it. This path catches after the batch, returns the batch and what committed, and the compound operation keeps the new category's cleanup.
6. **A dropped group isn't a sender exclusion.** The check can keep one subject from a sender and drop another, and negating a sender or a shared domain removes both. A lasting filter is offered only if a rule can say exactly what was accepted: it's checked locally against every kept and dropped group, and shared domains are never negated. Otherwise the checkbox is disabled with its reason. The conditions show before Apply.
7. **Consent is for a destination,** `destinationOf` as in plan 141 revision 2, validated before each dispatch. The line tells the truth about the amount: "up to 600 groups of senders and subjects".
8. **A sender's name can be an address.** Both stores' summaries fall back to the email when the name is empty (`queries.ts:76`, `idb/mail.ts:1276`), and subjects can hold addresses. A dedicated projection sends name and domain, and address literals are redacted from every field. Tests with nameless senders and addresses in subjects.
9. **Three requests isn't a bound.** Subjects have no length, and the ladder can repair and downgrade (`ladder.ts:56`), and foreground permits skip ceilings. Names ≤ 80, subjects ≤ 120, the serialized prompt and output sized like `summaryBudget`, and at most 6 provider requests for one operation, repairs included. What doesn't fit stays unchecked and left out.
10. **Every action rechecks.** §6's `narrow` covers only `actOn`, and category and folder moves have no such check. Eligibility is read again before each committing slice for every action, in both stores. Rows explicitly included stay included; a thread starred or replied in since the preview is spared.
11. **IndexedDB's windows walk everything.** `matchWindow` enumerates every message key per window (`idb/store.ts:1724`), so small pattern windows multiply full scans. A resumable traversal over existing ids goes once through the mailbox, with the same seam in SQLite. Gates on dense and sparse 50k+ fixtures hold total work and the longest uninterrupted time.
12. **`trackJob` can't cancel.** `stop()` only unsubscribes (`actions.ts:278`), and `actOn` has no abort. So a Stop built on it would hide progress while mail keeps moving. Cancellation is owned by the connection and checked between slices, returns undo handles for what committed, and a stopped category move is persisted so startup doesn't resume it.

## What building it changed

- **The preview opens with its first rows,** and the page stays only when nothing at all matched (§2 and §4 read together): the planning and the walk up to the first match are on the page; the count then grows in the header.
- **Left out by AI** is a line in the header with Show and Hide, whose rows join the end of the list unticked, rather than a group inside the virtualized list. It's the same choice with one list's rows.
- **Starring spares nobody, and mark read needs something unread:** a star on a replied thread costs nothing, so `star` has no "skipped" and needs only what isn't starred yet. A move to a category leaves out what's already there.
- **A row's check is a picture** (`CheckboxMark`): an option's children can't be focusable, so the row carries `aria-selected` and `x`, and the box is for the pointer.
- **The no-forward intent is `bulk` and no `planForwards`** (revision 1): `membershipForwards` already refuses a bulk filing in both stores, at once and in the start's sweep. A reply arriving later in a conversation filed there still goes, as with any filed conversation: that's the category's rule on new mail, not the sentence's.
- **The gates are in `workloads.perf.test.ts`,** beside their neighbours in both stores, and `actions.perf.test.ts` holds the order of 100,000 rows.
- **The pattern limit is 500** in the code (`PATTERN_MAX`), not the 300 this plan assumed: validation reuses it as it is.

## What the code review changed

Codex (read-only, `git diff main..HEAD`) raised 13 points, all fixed with a test that fails without the fix.

1. ⌘↩ in a reply also applied the preview: the shortcut now belongs to the list's own focus (`plain-actions.spec.ts`).
2. Removing an account or Clear AI data left a check sending what it held: `ActionsService.invalidate` ends those previews and their requests.
3. A category move that failed partway lost its Undo: the step is recorded before anything can fail, and `categories.abandonMove` (both stores) leaves nothing for startup to resume.
4. A category move read its threads once for 2,000: now one move per budgeted slice, read again just before it, with Stop between them.
5. Cancel left a check running: a preview's own abort controller, tested before each dispatch.
6. Redaction missed `josé@…` and `"anna smith"@…`: Unicode and quoted local parts.
7. A remembered quick filter on All Mail hid rows Apply still touched: `activeFilter` is off in a preview.
8. Skip after a failed check left every row out: Skip clears what the check set up.
9. Cancel from All Mail left the preview's rows: the list follows `actionPreview`.
10. Cancel lost a place past the first page: the preview keeps the rows you were among and puts them back before the scroll.
11. The stores checked different groups first: groups follow the preview's order, not a store's answer. Tested on both.
12. Body conditions reread the whole SQLite mailbox per window: `matchMessages` prepares only that window's captures, and windows with a body test hold 400 messages, so one stays inside the budget (a gate holds it).
13. Apply and Undo ran only on SQLite: what changed, Undo and the check's order now run on both stores.

Round two, on those fixes (5 points, all fixed):

14. A category move could still commit what changed during `finishMove`'s yield: the batch is written first, then the read, then the slice in the same turn, in both stores. `abandonMove` takes out what the read left out.
15. `admin@[192.168.1.10]` and `root@[IPv6:…]` passed the redaction: bracketed domains too.
16. Clear AI data during a group build left it running and holding what it read: it checks between slices, and a dropped preview lets go of its groups, rows and timer.
17. Leaving a preview by the sidebar kept the rows it meant to come back to: any way out lets go of them.
18. Training that failed after a move committed lost the count and left its due reminders pinned: pins end and the step is recorded as soon as the slice commits; training resumes at the next start.

## What the eval and the panel changed

Real models, on a copy of one real mailbox (5,939 threads, three accounts, Spanish and English) with its keys and queued work removed, read by five reviewers with different concerns: a fact auditor, a busy owner, a safety hawk, a bilingual editor and a recall PM. Four rounds, each reviewer blind to the others. No mail is recorded here. The owner's read is still theirs.

- Prompt version 4. No reviewer flagged anything high-severity on the last read, and two remain that four or more called wrong (both rules that catch too little); round 1 had five.
- **What changed in the plan:** a meaning held only by an age is sent back, since it would catch everything that old. Short words get `\\b` ("PR" caught "Pro"). Alternatives come in both languages. Every sender named goes in; senders plus a kind of mail are the senders, with `meaning` true so each row is checked. Fewest conditions: each one loses mail. `future` is only for explicit words, and "carpeta" with no such folder means a category.
- **What changed in the check:** "drop" read as "delete these" and one batch came back inverted, ticking production errors for Trash. It now says plainly that drop is what the action must not touch. A delete or a spam drops whatever it's unsure of, and service alerts, banks, payments and people unless named. A model answering with a row's words rather than its id used to be ignored, which left those rows ticked; those words now resolve. The output allowance went up to 3,000 tokens: a delete can drop every group.
- **`futureOnly` was added here after the panel and then removed by the owner (plan 153):** "From now on…" acts on what's already here as well, and saves the rule.
- A sentence finding only mail that's done or in Spam and Trash now says so with its count, rather than "nothing matched" (`done`).
- **Limit:** a subject-word rule still misses what doesn't use the words (some job alerts, "login" notices): conditions can't express "subject or sender". Vague orders are refused without asking which mail.
- **The code review:** a rule for mail to come skipped the check, so "from now on delete Tilopay receipts" would have saved a rule trashing every future message from that sender. It keeps its check now: what's doubted becomes the rule's exception, or no rule is saved. A rule that couldn't be saved was announced as saved; it says it wasn't, and that nothing changed.
