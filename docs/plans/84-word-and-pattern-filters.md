# 84: Filters that match words and patterns

## Request (verbatim)

> proceed to build a filter that matches words then, make it really intuitive to do, also make it so the phrase in the filter text can just be a regular expression, so you cna do things like numbers , when creating filters, if we detect a number in the subject, we can substitute it with a regex in its place for that number, then we can do those for past messages and have it as a filter.

> for the safeguards needed and the speed at 50k threads, thsi is fine, when there is a regex we can do batches in the background, here beware of performance and resource usage.

Agreed before this plan: a regex is never typed by most people. A subject the app turns into a filter shows its numbers as `#` ("Tu pedido # está en camino"); raw regex is for the filter editor. Patterns are checked before they are saved, and applying one to existing mail runs in background batches.

## What exists

- `rules/schema.ts`: text conditions on `from`, `fromDomain`, `recipients`, `subject`, `body`, `listId` with `contains | equals | startsWith | endsWith`. `evaluate.ts` (both the IDB store and ingest) and `db/rules.ts` (SQL) must agree; the conformance suite checks 120+ generated rules for parity.
- Subject scopes (plans 63, 80) are "same sender and exactly this subject". An order mail ("Tu pedido 43790 está en camino") is its own scope: neither the sweep nor its filter ever catches the next order.
- The category snackbar's 4 ("Everything mentioning …", plan 81) files a search (`termsQuery`) once. No filter can say "mentions these words", so it has no "+ new mail".
- `filters.apply` matches in 4,000-id windows, then applies in slices, inside one RPC with a 120 s timeout. The filter dialog waits for it.

## Design

### 1. A `matches` op (regular expressions)

- `TEXT_OPS` gains `matches`. Its value is a JavaScript regular expression source, applied with the `i` and `u` flags to the field's normalized text (`normalizeText`: accents stripped, lower case). The pattern itself only has its accents stripped, never its case, so `\D` stays `\D`.
- It applies to `from`, `fromDomain`, `recipients`, `subject` and `listId`, not `body`: bodies are large, and body rules are FTS-backed. The schema refuses `matches` on `body` (and on `text`, below).
- **Safety (`checkPattern`, `rules/pattern.ts`):** a pattern must compile and must not contain:
  - a backreference (`\1`, `\k<…>`)
  - a quantified group that itself holds an unbounded quantifier (`(a+)+`, `(?:x*y)*`), the exponential-backtracking shape
  - more than 8 unbounded quantifiers in total.

  It is at most 300 characters, and the text it runs on is cut to 1,000 characters. A failed check is a schema issue (`filters.invalid.pattern`) that names the problem in the builder.
- **Evaluation:** a compiled-pattern cache (an LRU of 64 entries) in core. SQLite gets a UDF `terno_matches(pattern, text)` that calls the same core function, registered next to `terno_body_match`. IDB already runs core's `evaluateRule`.

### 2. Numbers become `#` in subject scopes

- **`subjectKey(subject)` (core):** the normalized subject with every run of ASCII digits replaced by one placeholder character (U+2063). Two subjects with the same key are "the same subject".
- **`similarScopes`** compares subjects by key, so "Tu pedido 43790" and "Tu pedido 3052" are one scope. The scope keeps the first root's verbatim subject.
- **Stores:** the sweep and count pages (db `pageSql`, the IDB walks, and the categorize `scopeSql` for `subject`) compare `terno_subject_key(m.subject_norm) = ?` instead of `m.subject_norm = ?`. They still walk the sender's index, so the cost stays bounded by the sender's mail.
- **The rule (`similarRule` and `categoryRule`):** when the subject has digits, the subject condition is `matches` with `subjectPattern(subject)`: `^` + the escaped normalized subject, with each digit run as `[0-9]+`, + `$`. Matching the pattern and having the same key are the same test, and a unit test holds them together. A subject without digits keeps `equals`, so existing filters keep working.
- **Display:** `subjectTemplate(subject)` replaces digit runs with `#`. `patternTemplate(pattern)` reads a generated pattern back into its `#` template (null for a pattern someone typed). The filter list, menus, snackbars and filter names show the template, and `#` is styled as a small muted "any number" token with an accessible label.

### 3. A word filter

- New text field `text` ("Subject or body"), op `contains` only, value one word or phrase. It matches when the phrase's tokens appear in order in the subject's tokens or, once the body is complete, in the body's tokens. These are the same token semantics as `body`.
- A rule may not negate `text`, so a `text` condition only ever turns true. A message whose body is still incomplete is therefore decided on its subject now, and checked again when its body arrives (ingest's body-completion pass runs `text` filters along with `body` filters).
- **SQL:** `m.id IN (fts 'subject : "w"') OR (m.body_state = 'full' AND m.id IN (fts 'body : "w"'))`, windowed the same way as `body`.
- **The category snackbar's 4** becomes a filter when words are checked:
  - **Rule:** one `text contains` condition per checked word, all of them required, plus `from equals <sender>` when "Only from <name>" is on. That's a new toggle on the words line, on by default when the moved mail has one automated sender.
  - **Now:** it files the matching existing mail and makes the filter for new mail, like 1–3, and the line shows "+ new mail".
  - **More… text** stays a one-time search: arbitrary search syntax isn't a rule, so the line drops "+ new mail" and the tooltip says it applies only to existing mail.
- **Existing mail:** filed through the same search as today, with `from:<email>` added when the toggle is on.
- **The filter's name:** "Mentions “pedido”, “camino” → Facturas" ("… from Mercado Libre" with the toggle).

### 4. Applying a filter to existing mail, in the background

- `filters.apply` takes a `jobId`. It reports progress (`bulkProgress`) as it matches windows and as it applies, and its timeout rises to 30 minutes. The windows stay at 4,000 ids, with a turn yielded between them; a rule with a `matches` condition uses 1,000-id windows, so a UDF window stays within the slicer's budget.
- **The filter dialog** no longer waits. "Save & apply" saves, closes or keeps the dialog as today, and the apply runs behind a progress snack ("Applying “X”… 1,234 / 50,000") that ends with "Applied to N conversations". A second apply of the same filter while one runs is refused, so it can't be queued twice.
- **No new background process or timer:** the work runs only while a job is open, in the existing `runSliced` and `yieldTurn`.

### 5. The filter builder

- **Op label:** "matches pattern" (`filters.op.matches`). Its input shows the pattern in a monospace font.
- **Check while typing:** the pattern is checked as you type, and the issue shows under the field ("This pattern could take too long; avoid nesting repeats like (a+)+").
- **Help line:** "Regular expression. [0-9]+ matches any number." It is visible while the op is selected.
- **Generated patterns** show as their `#` template in the condition summary (`describeCondition` and the `filters-tab` `conditionText`).
- **The `text` field:** labelled "Subject or body" (`filters.field.text`). It offers only "mentions" (`filters.op.mentions`).

## Tests

- **core:**
  - `checkPattern` accepts and refuses specific patterns (nesting, backreferences, length, too many quantifiers).
  - `subjectKey`/`subjectPattern` agree: a property test over generated subjects confirms that a key matches if and only if the pattern matches.
  - `subjectTemplate` and `patternTemplate` round-trip.
  - `evaluateRule` handles `matches` and `text`: an incomplete body is decided on the subject, and no negation is allowed.
  - The schema refuses `matches` on body and text, and negated `text`.
- **db and idb:** the conformance parity suite's generator adds `matches` (from a small safe pattern set) and `text`; SQL and `evaluateRule` agree. Subject-scope sweeps and counts match across different numbers in both stores, and "Tu pedido 1" vs "Tu pedido 1 cancelado" stay distinct.
- **backend:**
  - `filters.apply` reports progress and yields: `backend.perf.test.ts` gains a `matches` rule over the 50k fixture, with interactive RPC latency under the existing gate.
  - A second apply of the same filter is refused.
  - A text filter fires at ingest on the subject, and at body completion on the body.
- **e2e (`filters.spec.ts`):**
  - A pattern filter with an invalid pattern shows the issue and can't be saved.
  - A valid pattern filter, saved and applied, shows the progress snack and its result.
  - The `#` template shows in the list.
- **e2e (`categorize.spec.ts`):** checking words and pressing 4 files the existing matches and creates a filter (+ new mail); the "Only from" toggle narrows the count.

## Perf

- **Subject sweeps:** still sender-indexed pages of 2,000. The key UDF adds one JS call per row; this is measured in `similar.perf.test.ts` (db and idb) with a budget equal to today's +20%.
- **Regex windows:** 1,000 rows per window, with a turn between windows. `rule-scope.perf.test.ts` covers a regex rule at 50k.
- **Pattern cache:** at most 64 compiled patterns; it isn't stored anywhere.

## Out of scope

- Regex on bodies.
- A visual pattern builder beyond `#`.
- Turning arbitrary search syntax into filter rules.

## Revisions after the Codex review (plan)

1. **ReDoS.** `(a|aa)+` passes a shape check, so shape checks alone are not enough. `matches` runs on Terno's own linear-time matcher (`rules/regex.ts`, a Pike VM over a parsed subset), never on `RegExp`. Supported syntax:
   - literals, `.`, classes `[...]` with ranges and negation
   - `\d \D \w \W \s \S \b \B`
   - `^` and `$`
   - groups `(…)`, `(?:…)` and `(?<name>…)`
   - `|`
   - `* + ? {n} {n,} {n,m}`, with lazy marks accepted

   Lookarounds and backreferences are refused (`unsupported`). A program over 2,000 instructions is refused (`complex`). The cost is O(text × pattern) with no backtracking, so the 1,000-character input cut is dropped.
2. **`sameRule` is op-aware.** A `matches` value compares by its accent fold only: never lower-cased, so `\D` ≠ `\d`.
3. **Trimming:** kept for every text value, patterns included. A pattern's leading and trailing spaces are not significant; the builder's help says to use `\s`. Generated patterns are anchored `^…$`, so the spaces inside them are kept.
4. **Length:** `PATTERN_MAX` is 500, the value cap. A subject generalizes only when its generated pattern passes `checkPattern`. Otherwise its scope, its sweep and its rule all stay exact (`subjectGeneralizes`).
5. **Collision-free keys:** `\` and `#` in the subject are escaped before digit runs become `#`, and nothing is cut, so key equality and the anchored pattern agree for every input. Property tests include literal `#`, `\`, U+2063 and very long digit runs.
6. **`text` means what a search word means:** the phrase in the subject, the sender (name + address), the recipients, or the complete body. These are the FTS columns, so the words scope's existing-mail search and its rule agree. One difference remains: a search sees a partial body now, and the rule sees it once it's complete.
7. **Three separate predicates:** `ruleNeedsBody` (requires a complete body), `ruleReadsBody` (loads it and re-runs on completion), and the incomplete-body decision.
8. **A real words scope:** `CategorizeScope` gains `{ kind: "words", terms, email | null }`. It is filterable: its rule is `text` per term plus `from` equals. It resolves through the same search (`termsQuery` plus `from:`) in both stores, and goes through `categorize.apply { always }` with the existing filter-first, `{ batchId, filterUndo }` and partial-failure contract.
9. **Unbounded resolve (accepted, measured):** scope resolution was already unbounded for sender scopes. The key UDF only runs on generalized subjects of one sender. `categorize.perf.test.ts` gains a dominant sender with a rare numbered subject, so the cost is measured, not assumed.
10. **IDB windows:** they stay at 4,000 ids, since the matcher is linear. There is no smaller regex window.
11. **Background apply:** it moves to `lib/filters.ts` (`applyFilter`), which owns the job and its snack independently of the dialog. The backend refuses a second apply of a running filter (a set entry taken before the first await, released in `finally`). A failure partway returns `{ matchedMessages, affectedThreads }` so far in its details, and the snack says how many were done, then reloads the list.

## What the Codex code review changed

- **Compile time is bounded too:** nested empty repeats (`(?:(?:){100}){100}…`) emitted no instructions but expanded exponentially. Compilation now counts its work (20,000 nodes) and refuses past it. Test: such a pattern is `complex` within 250 ms.
- **Case folding matches `/iu`:** `[A-Z]` no longer matches `ß` (its upper case is two letters), and `σ`/`ς` fold together. Escaped surrogate pairs (`\uD83D\uDE00`) are one character, in classes too. Tests compare each case with the native engine.
- **Subject tests are prepared once:** the subject test is prepared once per walk in IndexedDB (`subjectMatcher`), and `subjectGeneralizes` goes through the compiled-pattern cache, so a dominant sender's sweep doesn't recompile per message.

Changes after review (screenshots):
- The snackbar title wraps to two lines instead of truncating ("Moved 21 emails with the same sender and subject to Facturas").
- Offers are counted again after the default and after "No, only…".
- Terno's filters are labelled "Automatic", not "Manual".
