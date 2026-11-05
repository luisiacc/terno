# 140 · Search: a comma means "any of", an address means that address

## Request

> lets imrpove the search here, and lets make sure it stays fast across thousands of emails.
>
> if i write `acme.test,acme.studio` i want to look for things that contain iehter acme.test or acme.studio, the ',' is the thing that determines that.
>
> also if 1 or more email addresses are typed in, the search results should be results that have one of the email addresses there.

## What exists

- **The parser** (`packages/core/src/search/parse.ts`) splits on whitespace. Every message term must match the same message, so there is no OR at all. A comma is a tokenizer separator: `acme.test,acme.studio` is today the single phrase "acme test acme studio", which nothing contains.
- **A bare address** is plain text: `ana@acme.test` is the phrase "ana acme test" in any column, body included. That finds `maria.ana@acme.test` and `ana@acme.test.evil.com`, and any message that merely mentions it. Two addresses must both be in the same message.
- **`from:ana@acme.test`** is exact on `from_email` (`isFullEmail`). Nothing is exact for recipients; `to:` is a phrase.
- **Four implementations** read the terms and are held to each other by conformance: the FTS5 planner (`db/search.ts`, with the segmented form for captured bodies), the instant index (`store/instant/engine.ts`), IndexedDB's exact scan (`idb/search.ts`) and the oracle (`store/conformance/oracle.ts`). `db/sql-store.ts` (twice) and `idb/store.ts` also read the text terms, to prepare captured-body tests.
- **Recipients are stored** as `recipients_text`, `name email name email`, joined by plain spaces, in both stores (`recipientsText`), and normalized as `recipients_norm`. So an address is always one space-bounded word there; no migration is needed to match one exactly.

## Design

### What the query means

| Typed | Means |
|---|---|
| `acme.test,acme.studio` | contains acme.test **or** acme.studio |
| `acme.test, acme.studio` | the same: spaces around a comma don't matter |
| `factura acme.test,acme.studio` | factura **and** (either). A comma binds tighter than a space, as Gmail's `OR` does, so `is:unread a,b` stays unread |
| `from:ana,bob` | from ana or from bob: a comma keeps the key |
| `from:ana,subject:hola` | either, each with its own key |
| `"a, b",c` | the phrase "a, b" or c: a comma inside quotes is text |
| `-a,b` | neither: the negation carries along the comma |
| `a,-b` | a and not b: an exclusion stands alone, there's no "or not" |
| `ana@acme.test` | a message whose sender or a recipient (To, Cc, Bcc) **is** that address |
| `ana@acme.test bob@globex.test` | either address, with or without the comma. Typed addresses are one "any of" |
| `ana@acme.test,bob@globex.test factura` | either address, and factura, in the same message |
| `ana@acme.test,factura` | a message with that address or the word |
| `"ana@acme.test"` | the phrase, anywhere, body included: the way to ask for a mention |
| `-ana@acme.test` | unchanged: a text exclusion |

Details:

- **Trailing comma:** `acme.test,` is `acme.test`, no longer prefix-matched (like `acme.test `). Leading and repeated commas are ignored. `,` alone is an empty query.
- **Numbers stay whole.** A comma between a digit and one to three digits, then a boundary, is part of the number: `1,000`, `12,50`, `$1,200.50` remain what they were (an invoice amount is a real search, and `12,50` is how Spanish writes it). `2024,2025` is either year.
- **Operators other than free text, `from:`, `to:` and `subject:` keep commas literal.** `category:a,b` may be a category's real name, `account:` already widens when repeated, and the rest have a closed vocabulary. A trailing comma on them is stripped, so `is:unread, foo` reads as written.
- **An alternative with no searchable characters is dropped**: `foo,---` is `foo`.
- **`<ana@acme.test>`** counts as the address (pasted from a header); the brackets go.
- **The address being typed.** The token at the end of the input that has an `@` and something before it (`ana@`, `ana@acme`, `ana@acme.te`) is an address *prefix*: it matches addresses starting with it. So typing narrows steadily through the address instead of emptying the list at `ana@acme.t` and jumping back. Once followed by a space or comma, a token that isn't a full address is ordinary text again.
- **The word match.** An address matches a space-bounded word of `from_email + recipients_norm`. A display name that is itself an address (Outlook writes those) counts; that's what "has the address" reads as anyway.

The choice to look in sender and recipients only, not bodies, is deliberate: a row should visibly involve the address, every quoted reply otherwise matches ("ana@acme.test wrote:"), and quotes ask for the mention.

### The query shape

```ts
interface MessageTerm { field: "text" | "from" | "to" | "subject" | "address"; … }
interface SearchQuery {
  terms: MessageTerm[];       // as today: every one must hold
  anyOf: MessageTerm[][];     // every group must have a term that holds; groups of 2 or more, positive terms only
}
```

All of them still apply to the same message. A query without a comma or address is exactly what it was, so nothing on the existing paths changes. A single address is an ordinary `terms` entry. `searchTerms(q)` gives `terms` and `anyOf` flattened, for the places that prepare captured-body tests.

### The engines

**Oracle:** `anyOf.every(group => group.some(matches))`, with the address test written separately (words of `fromEmail + normalizeText(recipients)` split on a plain space).

**FTS5** (`db/search.ts`):
- A new FTS column set: `{from_text recipients} : "ana@acme.test"`, optionally with `*`. It gives a superset of the address's messages, cheap, no new index.
- The exact check on hits: `instr(' '||m.from_email||' '||m.recipients_norm||' ', ?) > 0` with the needle `" ana@acme.test "`, or `" ana@acme.te"` for a prefix.
- A group adds `(a OR b)` to the `MATCH`. If it has an address or an exact `from:`, it also adds a message predicate where each alternative is its exact test (`m.from_email = ?`, the `instr`, or `m.id IN (… MATCH ?)` for a plain alternative).
- The segmented form compiles a group the way it compiles a term: `(p1 OR p2)` over the same per-term predicates, captured-body tests included.

**Instant index:**
- A fifth forward-index field, `addresses`, mask bit 16. Its terms are the address with `@` in front (`@ana@acme.test`), which the tokenizer can never emit, so a text prefix never reaches them and a typed prefix (`@ana@acme.te*`) is the existing sorted-dictionary range scan. Exact lookups, prefixes, deltas, caching, compaction and snapshots all come from the postings as they are. Sender plus every word of the recipients with an `@`, in slices for a huge header.
- **`INDEX_FORMAT` 3.** An old snapshot is discarded and the index rebuilt in the background once; FTS5 (or the exact scan) answers meanwhile, as on any build.
- `plan()` builds, per group, a bitset of alternatives that are decided (one token, an address, an exact sender) and a list of `{ candidates, phrase }` for phrases (`acme.test` is two tokens). The group's union is ANDed into the plan's candidate set. Phrases are verified lazily on the doc, in `walk` and `sparse`, so a page of a dense query stops as early as it does today, within the same budget. Over budget, each is swapped for the FTS5 phrase doclist (`sourceSet`) and ORed in, as the existing escape hatch does.

**IndexedDB's exact scan** (`planScan`): `anyOf`, and the address as a string test on `from_email + recipients_norm`, without tokenizing or reading a body. An address-only query doesn't read bodies.

### Copy

- MCP's `search_emails` description and its server instructions gain the two forms.
- README's search section gets a line.
- No UI string changes. Teaching the comma (a hint or a tip) is left for the user to ask for.

## Tests

- **Parser:** every row of the table above, plus numbers, prefix flags, `<…>`, the typed-address prefix.
- **Conformance, every engine and both stores against the oracle:** new `SEARCH_CASES` with their FTS5 strategies; fixtures where the wrong implementation fails: a lookalike (`maria.ana@…`, `ana@….evil.com`), an address only in Cc, only in Bcc, only in a body, uppercase. `generateQueries` gains any-of and address parts, so the fuzz, the mutation sequences and the snapshot round trip all cover them. The fixture's recipients join with a space, as production does.
- **Instant:** an address's postings survive compaction and a snapshot round trip, an old-format snapshot is refused, a text prefix never returns an address term.
- **IndexedDB:** an address-only scan reads no body.
- **e2e:** one flow, typing `x,y` and an address through the search field, with results from both and from neither (`search-any-of.spec.ts`), no tag: it reads the same in every design.

## Performance

Held at 57k threads / 100k messages, everywhere and `in:all`, in both stores (`search-everywhere.perf.test.ts` in `db` and `idb`), at their existing budgets (instant ≤ 1 ms a query, ≤ 5 ms a phrase, ≤ 5 ms a keystroke through the store, FTS path ≤ 35 ms):

- two rare words, two common words, two phrases (`acme.test,acme.studio`), a phrase whose words are frequent but rarely adjacent;
- one rare address, **one address on nearly every message** (the user's own: the worst case for the FTS prefilter), three addresses, an address that doesn't exist;
- an address plus a common word, an address group plus `is:unread`;
- every keystroke of `acme.test,acme.studio` and of `ana@acme.test,bob@globex.test`.

The index's memory stays within its gate (`index-cost.perf.test.ts`, about one posting per recipient and a dictionary entry per distinct address) and the rebuild within its own. If the FTS path misses on the dominant address, it gets its own strategy rather than a looser budget.

## Out of scope

- Commas in `category:` and `in:` (either-of for scopes).
- Exact `to:` / `cc:`, and `to:ana@acme.test` (stays a phrase, as `from:` with a non-address does).
- Semicolons or `OR` as words. The comma is what was asked for.
- Search suggestions, highlighting, a teaching tip.

## Revisions after the Codex review

Eight points. Taken or decided:

1. **The FTS prefilter isn't a superset for exotic folding.** `recipients_norm` folds compatibility forms and FTS5 doesn't: a stored `ﬁn@acme.test` passes the exact check for `fin@acme.test` and misses the prefilter. **Kept, as a known limit:** a ligature, a full-width letter or an accented Greek letter in a stored address may be found by the instant index and not by the FTS path. No such address has been seen in mail, and the cost of closing it is an address table.
2. **Exact against still typing.** The address at the end of the input is a prefix, so `ana@acme.com` with the caret after it also finds `ana@acme.com.mx`. A space or a comma commits it to exact. The alternatives are an empty list on every keystroke through the domain, or asking each engine whether the exact address exists. **Kept**, with parser and conformance cases for both states; recorded as a known limit.
3. **IndexedDB has no phrase doclist.** True of every phrase today, and its index verifies without the cutoff. Groups follow phrases. `search-everywhere.perf.test.ts` exists only in `db`, so the IndexedDB gate goes in `idb.perf.test.ts`.
4. **Early keystrokes in a group build dense sets** (`factura,h`). Measured cold, keystroke by keystroke, in the gates. A lazy check inside groups comes only if they miss.
5. **A mixed group still reads every body in IndexedDB's exact scan.** Kept: it's the fallback, free text costs that today, and a mixed group is rare. An address-only query reads none.
6. **Addresses that coalesce.** Only bare addresses standing alone, or in a group of nothing but addresses, join the implicit "any of". `a@x.test,invoice b@y.test` is (a or invoice) and b.
7. **The number exception looked at substrings.** It now looks at the whole whitespace-delimited token: `1,000`, `12,50`, `$1,200.50` and `1.200,50` are numbers; `build1,2` and `2024,2025` are lists.
8. **Conformance didn't cover Bcc or changed headers.** The fixture projects Bcc, and the mutation sequences change a sender and a recipient, so stale address postings would fail.

## What the measurements found

At 57k threads and 100k messages (`search-everywhere.perf.test.ts`), the machine at a load of about 9 from other sessions. The own address sits on 31,930 messages.

| Path | Budget | Worst p95 |
|---|---|---|
| Instant, any of and addresses | 1 ms | 0.18 ms (`factura,uber has:attachment`) |
| Instant, two rarely-adjacent phrases, asking FTS5 | 5 ms | 2.97 ms |
| Instant, every keystroke, cold | 5 ms | 2.10 ms |
| Store, every keystroke (resolve, engine, rows) | 5 ms | 1.06 ms |
| FTS path, ordinary mailbox | 35 ms | 21.7 ms (`pro,pre`) |
| FTS path, with captured bodies | 35 ms | 30.9 ms (`zzqxjv,yyqxjv`) |
| Instant with no FTS5 to ask (the web), two rarely-adjacent phrases | 60 ms | 25 ms |

Index memory at 51k messages is 41 MiB against the 64 MiB gate, and a build is 1.6 s, its longest stall 7.8 ms.

The gates changed the design in three places, all on the FTS path, which answers while the index catches up:

1. **An address on nearly every message missed the budget** (38 to 57 ms): it materialized 32,000 hits and checked the words of each. An address's search now counts its hits first (`LIMIT 4096`, about a millisecond), and past that walks threads newest-first, stopping at the page: 13 to 18 ms.
2. **The segmented form walked every thread for a rare address** (96 to 133 ms). The gate ran on a mailbox with no captured body, and every real mailbox has one, so a new gate holds that form. What asks only for headers now leads through FTS5 on any mailbox, since a captured body can't change its answer (rare address: 0.7 ms). A word's captured-body test is one set for the statement rather than a lookup per message, which also took plain rare words from 31 to 24 ms and `pro` from 23 to 10 ms.
3. **`(m.id IN (…) AND instr(…))` built the words of every message.** SQLite evaluates the side without a subquery first, so it became a `CASE`.

## What the Codex code review changed

Round 1 found two parser bugs, both fixed with a test that fails without the fix:

1. **A quoted scope exclusion negated the next word.** `-category:"Work", invoice` excluded invoices: a comma carried the negation along from a key that isn't a list. It now does so only from a list key.
2. **A trailing comma broke a number.** `1,000,` became 1 or 000, because the number test read the comma as part of the token. Trailing commas no longer count.

Round 2 (`e55a60d8` and the parser and planner as they stand) had no findings, with its own 300 generated queries against the oracle on both FTS forms.

## The full run

`pnpm test:all` (1484 s) did **not** finish green; other sessions held the machine at a load average of 90 to 156.

- **Failed only on the crowded first pass, passed alone:** db-wasm, e2e, smoke.
- **unit:** failed; the runner didn't retry it. All six failing files then passed alone (175 of 175), none of them search.
- **ui-perf:** failed twice in the run; the three remaining passed alone afterwards.
- **perf:** failed twice in the run, and a set of unrelated gates (folder migration, sidebar counts, scope actions, exports) still misses at a load of 23 to 46, a different set each time. This has not had a clean full pass, and needs one on a quiet machine.
- **`search-everywhere.perf.test.ts`:** passed 4 of 4 on the one quiet run. Later runs missed on load spikes, on queries this plan doesn't touch as well (`reunión`, 231 ms).
