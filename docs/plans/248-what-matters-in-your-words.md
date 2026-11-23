# Plan 248: What matters, in your words

- **Status:** plan. "Revisions after the Codex review" override the sections before them.
- **Builds on:** plan 204 (dated items; its decision table gave "the user's own words" to plan 206, which was never written), plan 210 (the feed, mutes by sender, kind and pair, the reading prompt v16), plan 211 (per-account switches), plan 240 (Always shown), plan 239 (the reader's order), plan 247 (What matters' own Settings section, on another branch).
- **Advice taken:** a map of the pipeline by Fable 5.2 and a technical review by Codex (gpt-6.2-astra), both before this plan; their points are folded in below and named where they decided something.

## The request

> we had a plan to buidl a customization box for the what matters section, right now the logic is in a pretty good place for clasiffying it, so if the box is empty i expect to be no changes at all whatsoever to the current logic.
>
> i want you to start planning this with the assistance of subagents from fable 5.2 and codex astra 6.2 for some technical advise.
>
> then start building the plan and implementing it fully, lets make sure to truly accomodate for eveyer possible scenario with smart prompting or meta-prompting if needed, do whatever is the best option so the user gets what they want with the prompts they write, we truly need to go the extra mile here to accomodate this.

From plan 204's decision table (the owner, 2026-11-13): *"The user's own words: a box: what they want there and what they don't, merged with our rules."* From plan 210's round 14: *"order it by what matters to me belongs to the preferences plans."*

## What exists

- **The reading** (`DatedWorker.consider`, `packages/backend/src/dated.ts:1364`): gates (settings and the AI gate, draft/sent/own/Spam/Trash/spam thread, the account's `reads`, a muted sender, an untrusted sender, mail from before `enabledAt`), open items read first, Social/Promotions dropped unless a relayed ask or a sender Always shown, the cost filter (`hasTimeCue`) for automated mail, then `readDates` (prompt v16, `packages/ai/src/dated.ts`), the second look, `checkDates` (pure, many vetoes), `store.dated.finish`. A new prompt version re-reads nothing; the 14-day check (`scanPicks`, `DATED_SCAN_DAYS`) excludes messages with an item and runs once per account (plan 211).
- **Rows** come from four places, projected once for the list, the count and the notice (`TodayService.project`, `packages/backend/src/today.ts:627`): open dated items (`datedRows`: `withoutMuted`, `withoutUntrusted`, the account gate), your promises (`followups.active`), conversations waiting on you (`store.today.waitingPage` → `needsYou` → `stillWaiting`) and your reminders. `placeItems` and `projectRows` (`packages/core/src/today-projection.ts`) place and order them; `ordered` sorts each section.
- **Taking things out** (plan 210): mutes by sender (not read at all), kind and sender+kind pair (read, not stored, hidden), bounded, in Settings and the gear's popover. **Putting things in** (plan 240): Always shown senders (read whatever their tab or words, in Needs you whatever they look like).
- **Nothing takes the user's words.** No field, no prompt input, no UI.

## Design

### 1. The principle: preferences decide what shows, the reading still says what the mail says

The v16 reading is tuned over 14 panel rounds and 259 eval cases. It stays **byte-identical whatever the box says**: the same system and user messages, schema, budget, gates, second look, checks and writes (Codex 1, 5). The user's words act around it, on three paths of their own:

| Path | What it does | Where |
|---|---|---|
| **Hide** | Takes rows out of the feed, the count and the notice: dated items, your promises, conversations waiting on you | at projection, from local matches and stored verdicts |
| **First** | Puts matching rows first within their section ("order it by what matters to me") | at projection, same matches |
| **Show** | Brings in mail the built-in rules leave out (a sale the user wants, a school newsletter, an automatic renewal), as an ordinary item | a second, separate reader on admitted mail |

So: an empty box is the code path of today, literally (§9). A non-empty box never changes what v16 is asked, only what is shown and what a second reader adds. Settlements, moves, "nothing asked" and replaced promises keep their factual meaning, since hiding happens after them (Codex 5).

### 2. The words, compiled once (meta-prompting)

Pasting raw text into every classification would make each reading depend on phrasing, cost tokens on every mail and perturb the tuned prompt. Instead the box is **compiled once, on Save**, by a structured task (`AiTasks.compilePreferences`, `PREFERENCES_COMPILER_VERSION`), into rules that are checked locally and shown back in plain words. This compile is the meta-prompt: it turns whatever the user wrote (any language, vague, negated, with exceptions, several wishes in one sentence) into precise, English criteria written *for a classifier*, plus the words a cheap local filter needs.

```ts
interface PreferenceRule {
  id: string;                        // r1…; `key` is its stable identity across saves (a hash of what it means)
  key: string;
  said: string;                      // the user's own words it came from (must be in the text)
  effect: "show" | "hide" | "first";
  kinds?: PreferenceKind[];          // DatedKind | "promise" | "waiting": only these rows
  senders?: string[];                // exact addresses or "@domain", only when the text writes them
  about?: string | null;             // English criterion: "mail about the reader's children's school"
  unless?: string | null;            // English exception: "the delivery needs a signature or an adult present"
  cues?: string[];                   // show only: words, in English, Spanish and the user's own, that may signal it
  understood: string;                // the app's language: "Hide package deliveries, unless they need a signature"
}
interface PreferenceNote { said: string; kind: "unsupported" | "conflict" | "unclear" | "safety"; text: string }
```

- **Deterministic or semantic.** A rule with only `kinds` and `senders` is matched locally, exactly. One with `about` or `unless` needs a judgment, by a model, item by item (§4).
- **The compiler's prompt** (frozen, versioned, examples in English and Spanish) teaches: one rule per wish; a negation is a hide, "matters", "always", "I want" a show, "first", "on top", "most important" a first; "unless", "except", "only if", "solo si", "a menos que" become `unless` (or the show's own criterion: "deliveries only if signature" is hide deliveries unless signature); kinds when the words name them (bills → pay, trips/flights/bookings → event, packages → delivery, subscriptions/trials → renew, cards/documents/passwords expiring → expire, RSVPs/forms → respond, account problems → alert, requests from people → ask and waiting, "what I said I'd do" → promise); senders only as written (an address or a domain), never invented; a name ("my landlord", "Ava's school", "LinkedIn") stays in `about`, which the classifier reads with the mail's sender name; cues as distinctive words, never generic ones ("email", "update").
- **Notes** say what can't be done, in the user's language: a schedule ("only on weekdays"), notifications, other screens than What matters, timing ("show bills a week before": the time to act is the app's, plan 204 §2), anything about Spam or scams (a **safety** note: "Mail in Spam and messages that look like scams never show in What matters"), a show and a hide of the same thing (a **conflict**, the hide wins until the words change), and words it couldn't place (**unclear**).
- **Local checks** (`checkPreferences`, pure, `packages/core`): `said` found in the text (normalized), an address or domain only if the text writes it, kinds from the closed set, effect from the three, at least one selector, `cues` only on a show and at most 24 of at most 40 characters, `about`/`unless` at most 240 characters, at most 20 rules and 10 notes; a rule failing any is dropped and becomes an **unclear** note with its words. A model that invents an address can't make it a rule.
- **Explicit Save**, never on every keystroke: the compile costs a request. The draft is kept as it's typed (never lost, §7). The last working rules stay in force until a Save succeeds; a failed compile keeps them and says why in plain English. **Clear** needs no AI and works offline.

### 3. Storage

- **The record** (`whatMatters:preferences` in the store's small values, atomic update in both engines; not `AppSettings`, which is broadcast on every change and could carry names and addresses into logs, Codex 11): `{ revision, text, draft, rules, notes, compiledWith: { version, provider, model } | null, savedAt, shownAdded }`. Bounded: text ≤ 2,000 characters, rules ≤ 20. `revision` bumps on every Save and Clear; a save is compare-and-swap on it, so two windows can't overwrite each other's words silently.
- **Verdicts** (`preference_verdicts`, a new table in SQLite and a store in IndexedDB, shape only): `target` (primary key: `d:<item id>`, `p:<promise id>`, `w:<thread id>:<message id>`), `basis` (a hash of the semantic rules' keys it was judged against), `hide`, `first` (0/1), `rules` (the matched keys), `at`. A verdict counts only while its basis is the current one, so a Save that changes only exact rules re-judges nothing. Bounded at 3,000 rows (oldest first); pruned when the basis changes and when their target closes; emptied by Clear AI data (it's what AI read) and by Clear of the box.
- **Items a show rule brought** are ordinary `dated_items`, with one new column, `wanted` (the show rule's `key`; null for every v16 item). Such an item shows only while a current show rule has that key; an edit that keeps the rule keeps its items, one that drops it hides them (hidden, not closed: put back, they're back). Shape-only migration in both stores.
- **The look back** (§6) is a queue of at most 300 message ids with its revision in the small values (`whatMatters:preferenceScan`), resumable.
- **Always shown, owned.** A show rule for one exact address with nothing else (no kinds, no criterion) *is* "always show this sender": Save adds it to plan 240's list and records it in `shownAdded`; a later Save without that rule, or Clear, removes only those it added. A sender already shown by hand is never recorded, so never removed. (Codex 6's caution about trust and mutes: it's the user's explicit address, and plan 240's own rules already handle a mute.)

### 4. Hide and first: matching the rows

- **Where:** `TodayService.project`, before `placeItems`, so the list, the badge, the count and the morning notice agree (Codex 8). Dated rows in `datedRows()` beside `withoutMuted` (cached by its generation), promises after `aiMade`, waiting conversations after `waitingPage` (against the waiting message itself, not the thread's newest, Codex 8). A conversation waiting on you is never held back just because a hidden item of the same mail is: `represented` already merges those. Your reminders aren't touched: you set them by hand. History (finished items) follows the same rule. The digest is out of scope except an exact sender hide, which it honours as a "Not a newsletter"-style exclusion does today.
- **Exact rules** match locally: kinds (`d:` its kind, `p:` "promise", `w:` "waiting") and senders (the item's `senderKey`, the promise's `personEmail`, the waiting message's sender; a domain by the address's domain or a subdomain).
- **Semantic rules** need a verdict: `AiTasks.matchPreferences` (frozen, versioned) takes the semantic rules (`about`, `unless`, their exact parts as context) and up to 25 targets: each with its kind, its words, the sender's name, the subject and an excerpt (the item's quote and its paragraph, at most 600 characters; for a waiting conversation, the start of the waiting message), and answers, per target, the rules that apply, each with **evidence** copied from the target. A match whose evidence isn't in what was sent is dropped (`checkMatches`). An `unless` that holds means the rule doesn't apply.
- **When:** the projection lists targets with no current verdict that a semantic rule could reach (its exact part passes); the matcher (`PreferenceMatcher`, in the backend's background slices, the dated task's provider and limiter) takes them in batches, re-checking each target's Spam, Trash, account gates and mutes before any of its words go out, writes verdicts, and says `today.changed()`. No timer and no polling: it runs because a projection found work, and goes idle when there's none.
- **Withholding** (Codex 9): a new item a semantic hide could reach (it came after the rules were saved) isn't shown until it's judged, so "never show X" doesn't flash X; seconds, normally. If judging fails for good (provider gone, refused, three attempts), it shows: a failure never hides mail. Items already shown when the words were saved stay until their verdict lands (the Settings row says it's applying, with a count).
- **First:** a row a first rule matches sorts first within its own section (`ordered`), keeping the section's own order among the first and among the rest. It never moves a row to another day or section.
- **Conflicts at runtime:** a hide wins over a show and a first for the same row.

### 5. Show: a second reader for what the user asked for

- **Admission** (`wantedCandidate`, pure): a message is a candidate when a show rule's senders match it, or one of its cues is in its subject or text (normalized words, en and es). Read in `consider` beside the built-in path, and in the look back. Never past the hard gates: Spam, Trash, the spam thread, drafts and sent mail, the account's switches, a muted sender, an untrusted sender, mail from before `enabledAt` (Codex 4, 7). The built-in filters (Social/Promotions, the cost filter) are what a show lifts.
- **The built-in path is untouched:** v16 runs exactly when it ran before, on exactly what it was given. A candidate the built-in filters dropped gets only the second reader; one the built-in path read gets the second reader after its finish, when a show rule's criterion could add something v16 left out.
- **`AiTasks.readWanted`** (frozen, versioned): the same delimited mail blocks as v16 (`dataText`), the show rules that admitted it (their criterion, kinds and exceptions) as **data in its own block under fixed instructions** (its delimiter neutralized in mail and in the rules, Codex 5), and the open items v16 just wrote for this message, so it doesn't repeat them. It answers at most two items: `{ rule, kind, text, quote, due, time }`, kind one of v16's (an undated piece of news is an `alert`). Its instructions: only what the rule describes; never a scam, a demand for a password, a code or a payment by gift card; never an item the open ones already say; the quote is the mail's own words; a date only when the mail gives it.
- **Its checks** (`checkWanted`, pure): the rule is one it was given and admitted this message; the quote is in the mail; the date parses, isn't past, isn't a year out; the kind is v16's; at most two; **the safety checks v16's items get** (`scamPressure`, `giftCardScam`, `asksForSecrets`, the untrusted sender, Codex 7); not the relevance checks (a newsletter's call to action is exactly what a user may ask for). Then `store.dated.addWanted` writes them as `dated_items` with `wanted` set and item numbers after v16's, revision-checked against the record (a stale reading after a Clear writes nothing), deduplicated against the message's items by kind and day.
- **How they look:** ordinary rows, placed by their kind and day like any item (plan 204 §2), with Done, Later, Remove and Undo. An undated one is an alert (Deadlines' for its week, never Missed), without the "the email says" attribution, since it's not an alert the mail raised. The reader's line names why it's there: "You asked for: school mail".
- **Cost:** only candidates are read (cues are chosen to be distinctive); the Settings hint says the second reader reads mail it lets in with the same provider.

### 6. Changing the words

- **Hide and first** apply to what's there at once: exact rules on the next projection (no AI), semantic ones as the matcher judges what's open (item words and short excerpts, at most 25 a request; a full feed of 1,000 items is about 40 small requests). No mail is read again for this.
- **Show** applies to new mail. After a Save with show rules, Settings offers **"Look in the last 14 days"**, with the count of candidate messages (local, the same walk as plan 211's check: 3,000 walked, 300 at most) and the cost. With a yes, the second reader reads them, new mail first, the queue resumable, writing only show items (never `dated.finish` again: no moves, settlements or "nothing asked" replayed, Codex 10). A message that already has v16 items is still a candidate (Codex 10's trap: the built-in scan skips those).
- **Clear** removes every effect at once: the record's rules, the verdicts, `shownAdded`'s senders from Always shown, the show items hidden (their rule gone), the look back's queue. One Undo puts the words back (and Saves them again, without a compile: the rules are kept with the Undo).

### 7. Settings and the feed

- **Settings → What matters** (General's group today; plan 247 moves the group to its own section, and this row moves with it): **"In your words"**, stacked:
  - a text area (BoardUI's textarea), placeholder: *"For example: Never show package deliveries unless they need a signature. Anything about Ava's school matters. Put bills first."*, its own count only near the 2,000 limit;
  - **Save** (⌘↩ in the field) and, with saved words, **Clear**; a draft not saved says so quietly ("Not saved"). The draft is kept as it's typed (in the record's `draft`, debounced), so closing Settings or the app loses nothing;
  - **What Terno understood:** a line per rule in the user's language with a quiet icon (shown, hidden, first), and how many rows it's hiding or bringing now; then the notes, muted; while matching, "Applying to What matters… 40 of 120"; with show rules, the look-back offer;
  - the hint: who reads the words and the mail (`datedReaderLine`'s provider), and that mail in Spam never shows.
- **The gear on What matters** gains **"Your words…"**, opening Settings at the row with the field focused: where the result is seen.
- **en and es** together, `settings.find.words` gains "words, preferences, customize, personalize".

### 8. Safety and privacy

- The words go only to the user's AI provider, to compile; the compiled rules go with the mail and items they judge, to the same provider. Never logged, never in telemetry, never in Sentry (scrubbed like mail).
- In every prompt the rules are data, in their own block, and the mail is material: an instruction in a mail can't change a rule, and a rule can't lift the safety rules (§5's checks are local).
- Spam reaches no new path (the owner's rule); the matcher and the second reader check Spam and Trash again right before a request leaves, as v16's worker does.

### 9. The empty box

`rules.length === 0` (no record, an empty or whitespace text, a Clear) is one early return on each new path: no candidate, no matcher, no second reader, no filtering pass in the projection, no Always shown entries. v16 is unchanged in every case. Tests hold it at the transport (§Tests).

## Tests

- **core:** `checkPreferences` (an invented address, a rule with no selector, a cue on a hide, sizes, notes); the matching of exact rules (kinds, address, domain and subdomain); `wantedCandidate` (cues en/es, words not substrings, the gates not its business); a stable `key`; `ordered` with first rows in each section.
- **ai:** the three tasks' shapes and versions frozen by snapshot; delimiters neutralized; the v16 snapshot unchanged; `readDatesTask` identical (system, prompt, schema) with and without any preferences.
- **backend (scripted transport):** the empty record and an absent one make exactly the same requests, in order, as before, for a message set covering every gate (the transport records them); with rules, v16's requests are still the same; the matcher hides a semantic match and keeps an `unless`; evidence not sent is dropped; withholding a new item until judged and showing it after a final failure; Spam or Trash meanwhile sends nothing; the second reader brings a Promotions sale for a show rule and never a scam; its items hidden when the rule goes and back with it; a stale reading after Clear writes nothing; Always shown added and removed by ownership; the look back counts and reads candidates, a message with v16 items included, never calls `finish`.
- **Conformance (both stores):** the verdicts table (basis, bound, pruning, clear), `wanted` on items and `addWanted`'s revision check, the record's compare-and-swap.
- **Migration:** the shape-only step in SQLite (`migrations.perf.test.ts`) and IndexedDB's upgrade.
- **web:** the row's states (empty, draft, saving, understood, notes, applying, failed), Undo of Clear; e2e (`what-matters-words.spec.ts`, fake provider): type, Save, see the understood lines, a row hidden, Clear and Undo, the gear's link, axe in light and dark.
- **Evals** (`scripts/ai-real/preferences.real.ts`, corpus `scripts/ai-real/corpus/preferences/`): compile cases (what a sentence becomes: effect, kinds, criterion, exceptions, notes; en and es; vague, negated, mixed), match cases (rule × item → applies or not, with the owner's examples: a check-in beside a cancellation, a school newsletter beside a personal permission slip, ordinary and signature-required parcels, a landlord's notice) and show cases (rule × mail → an item or none: the wanted sale, a phishing "sale", an automatic renewal asked for), scored on what the feed would show: forbidden rows shown, wanted rows missed, unrelated rows lost, unsafe rows (Codex 12). Run on the dated task's models (Luna, Haiku) with a fresh ledger.

## Performance

- The empty box adds one cached read of the record per projection (the small values; cached by revision), nothing else.
- With rules: exact matching is a set lookup a row; verdicts are one batched read per projection, keyed, cached by the dated rows' generation; the 1,000-item bound holds. The Today perf gate runs with 20 rules and 3,000 verdicts.
- The matcher and the second reader run in background slices, bounded batches, no timers when idle.
- Migration: one column and one empty table, shape only.

## Out of scope

Rules on the digest's lines beyond an exact sender; timing of when items show (plan 204's table is the app's); notifications; rules about other screens; learning rules from Remove (the mute offer stays); a rule's own Undo per line (the words are the rules: edit them).
