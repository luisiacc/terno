# Plan 18: autocomplete while writing (recipients and body)

- **Status:** in progress.
- **Builds on:** `d3b6e78` (main after plans 15 and 16).
- **Request (verbatim):** "implement autocompletion when writing emails, wether its the body of an email or on the sender, sendee, ccs, implement autocompletion. ensure always the performance of this needs to be extremely fast with low resource usage, consider extreme scenarios like hundreds of thousands of emails in your tests and autocompleting inside a body that is huge, have tests with those to make sure this feature is battle tested. as always have codex do code reviews."
- **Plan 17** is reserved for People / waiting-for-reply; this is 18.

## 1. What exists

- **Recipient fields** are plain `<input>`s in `DraftFieldsForm` (`inline-draft.tsx`), shared by the inline reply and the new message. The draft keeps them as text (`toText`, `ccText`, `bccText`), parsed by `parseAddressList` (core `address.ts`) only when saved or sent. The From picker is a `Select` of the accounts (shown with more than one). No suggestions anywhere.
- **The body** is a bare ProseMirror editor in the lazy `composer` chunk (plan 16). `editor.ts` builds the plugins once (`PLUGINS`); `rich.tsx` wires hooks: `onChange` (document changed: draft dirty, O(1)), `onUpdate` (toolbar state, once per frame). Plan 16 chose ProseMirror for transient **widget decorations**: not in the document, the history or the serialized HTML.
- **The store's change log** (plans 03/04, SQL v7 and the IDB outbox): every commit appends one revisioned batch of the message and thread ids it touched (`search_outbox`, `searchChangeIds`), retained up to 32 MB and protected by leases (`search_leases`) while a rebuild scans. The instant search (`@terno/store/instant`) is the model consumer: restore a snapshot at revision R, replay (R, head], rebuild on a gap, time-sliced (`SliceClock`, `sortSliced`), a checksummed portable snapshot container (`packSnapshot`), memory caps per platform (desktop/web), `Platform.files` for caches beside the database (node fs on desktop, OPFS on the web).
- **Messages** carry `from_name/from_email`, `to_json/cc_json/bcc_json`, `date`, `is_sent`, `is_spam`, `is_draft`, `body_state`; bodies in `message_bodies` (SQL) or read lazily (IDB; message rows are all in memory).
- **Backend** (`BackendCore`): the single writer; every write path it runs ends in `notifyChanged()` (ingest slices, bodies, flags, removals, op completion, sends). RPC methods are zod-validated (`contract.ts`), MCP sees only an allowlist.
- **Diagnostics** (plan 10): codes with allowlisted typed fields only; nothing about mail content leaves the machine. RPC breadcrumbs carry the method name, never params.

## 2. Design overview

```
renderer (entry chunk)                     backend (utility process / web worker)
RecipientInput ── compose.suggestRecipients ─▶ Autocomplete (service)
  (combobox, per keystroke, latest wins)          ├─ ContactIndex  (in memory, sliced build, snapshot)
composer chunk (lazy)                             ├─ PhraseModel   (in memory, sliced build, snapshot)
  ghost plugin ── compose.suggestText ──────────▶ │
  (debounced, cancellable, bounded window)        └─ follows store.autocomplete (the change log)
```

Both models live in the backend, next to the data, built from the store's change log like the instant index, never per keystroke from the database. A lookup is a pure in-memory function (microseconds); the RPC round trip is the main cost (≈ 0.1–0.5 ms on desktop's MessagePort, a worker hop on the web).

**No work until it is used.** Nothing is read or built at startup. The first `compose.warm` (sent when a draft opens or a recipient field gets focus) restores the snapshots, or builds them in time slices. From then on, commits wake a catch-up (settled 50 ms, sliced); after it, nothing runs (no timers). Snapshots are written after a build, after 2,000 applied messages or 5 minutes with unsaved changes, and on close.

### 2.1 The store seam: `MailStore.autocomplete`

A new port in `@terno/store`, implemented by `SqlMailStore` (node and wasm drivers) and `IdbMailStore`:

```ts
interface ContactMessage { id; accountId; date; sent; spam; draft; from: Address; to: Address[]; cc: Address[]; bcc: Address[]; hasBody: boolean }
interface SentText { id; accountId; date; fromName: string; to: Address[]; text: string }
interface AutocompleteSource {
  /** where the snapshots live (`<db>.contacts`, `<db>.phrases`; `/<name>.idb.*` on the web); null: in-memory database */
  snapshotBase: string | null;
  identity: string;                               // store kind + schema: a snapshot from another kind is ignored
  head(): Promise<Revision>;                      // the search log's head
  /** the projections of the messages each batch in (after, through] touched (absent ids: removed) */
  changes(after, through, maxCommits): Promise<{ from; to; messages: ContactMessage[]; removed: number[] }[]>;
  /** a lease on the log from the head, and every message in id order, in pages */
  beginBuild(): Promise<{ from: Revision; messages(): AsyncIterable<ContactMessage[]>; release(): Promise<void> }>;
  /** sent mail with a stored body, in id order (phrase model build), and by ids (catch-up) */
  sentAfter(afterId: number, limit: number): Promise<SentText[]>;
  sentTexts(ids: readonly number[]): Promise<SentText[]>;
}
```

SQL reads the columns directly (`to_json` etc. parsed in JS; no new table, **no migration**); the build pages `WHERE id > ? ORDER BY id LIMIT 500` under a `search_leases` row, exactly like `beginSearchBuild`. IDB reads its in-memory rows (bodies through `readLazy`), in exclusive slices of 500 like its feed. A conformance suite (`defineAutocompleteConformance`) runs on node:sqlite, SQLite-WASM and fake-indexeddb.

### 2.2 The service: `Autocomplete` (`@terno/store/autocomplete`)

One loop for both models (like `InstantSearch`): `warm()` → restore both snapshots (verify identity, checksum, epoch, revision ≤ head; else rebuild) → catch up from the snapshot's revision through `changes()` (a gap or another epoch: rebuild) → rest. `notify()` (the backend's `notifyChanged`) marks pending; ignored until warmed. Each applied message goes to the contact index; a sent message with a body not yet learned goes to the phrase model (bodies fetched by `sentTexts`, at most 50 per slice). A removed id clears its "seen" bit (ids can be reused by SQLite) but contributions stay (§3.5).

Lifecycle and safety:

- every unit of work runs inside a `SliceClock` (4 ms desktop, 6 ms web) and yields with `platform.yield()`;
- memory caps checked after every page; over the peak the model trims itself (§3.4, §4.4), never throws away the other one;
- `close()` stops the loop and persists what changed; `reset()` (account removed, "clear" in tests) drops both models and their snapshots: the next warm rebuilds;
- `setPhrases(false)` (the setting off) drops the phrase model and removes its snapshot; `true` builds it on the next warm;
- a failure logs a diag code (`autocomplete.rebuild`, fields `count`, `durationMs`, `errorClass`) and rebuilds; three in a row disable that model for the session (suggestions just don't appear).

## 3. Recipients: the contact index

### 3.1 What a contact is

One per normalized address (lowercased, trimmed; `mailto:` dropped; invalid addresses skipped). Per contact (dense id, typed arrays that grow by doubling):

- `sent` (f64): Σ 2^((t − T0)/H) over messages I sent to them (To/Cc/Bcc), H = 120 days, T0 = 2020-01-01: frequency and recency in one number, comparable across contacts without rescaling (2^62 at 2040, far inside f64). Dates in the future are clamped to the build's now + 1 day.
- `recv` (f64): the same for messages they sent me (From); co-recipients of mail I received (To/Cc besides me) add a quarter weight.
- `last` (f64, the newest date), `count` (u32), `accounts` (u32 bitmask, `accountId % 32`), `flags` (u8: own, automated, dead).
- `name`: the most frequent display name (weighted by the same decay), up to 3 alternates kept with their weights; a name equal to the address, containing `@`, or empty is ignored. Alternates are searchable.
- **automated**: local part `noreply`, `no-reply`, `donotreply`, `mailer-daemon`, `notifications`, `bounce*`: ×0.1.
- **spam** and **drafts** contribute nothing.

### 3.2 Own addresses

The accounts' addresses plus every From address of a sent message are "own". Own contacts are never suggested, except when the query equals the full address. The backend passes the account list on warm and on `accounts` changes.

### 3.3 Tokens and lookup

Each contact has tokens, all folded (NFKD, combining marks removed, lowercased, ß→ss, æ→ae, ø→o, ł→l, đ→d, ı→i; an ASCII fast path):

| token | class |
|---|---|
| first name word; address local part | 3 |
| other name words; local part pieces after `.` `_` `-` `+` | 2 |
| CJK names: every suffix (≤ 8 chars) of a name word (王小明 → 小明, 明) | 2 |
| initials of a name of ≥ 2 words (Arjun Patel → `ap`) | 1 |
| first label of the domain, unless a common provider (gmail, outlook, hotmail, yahoo, icloud, me, live, aol, proton…) | 1 |

Storage: one **main segment**, sorted by token (UTF-16 code units): `chars: Uint16Array` (all tokens concatenated), `start: Uint32Array`, `len: Uint8Array`, `ids: Int32Array`, `cls: Uint8Array`; plus a **delta** (JS array of up to 4,096 entries, kept sorted by binary insertion) for contacts added since. A full delta is merged into a new main segment in slices; the old one answers until the swap.

A query (≤ 320 chars) is folded and split into terms on whitespace and punctuation; `@` keeps the address part (`ana@ac` → term `ana`, plus "the address starts with `ana@ac`"). For each term, a binary search gives its prefix range in main and delta. Terms are processed from the smallest range up with a generation-stamped `Uint32Array` (a contact survives term k only if it matched terms 0..k−1): no strings built, no allocation per candidate. Ranking among survivors, top-K by a small insertion array:

1. **tier**: contacts I've sent to above contacts that only wrote to me;
2. **score** = (3·sent + recv) × class weight (3: 1, 2: 0.6, 1: 0.3, the best class among the first term's matches) × 1.5 when a term equals a whole token × 1.25 when the contact has mail in the draft's account × automated penalty;
3. newest `last`, then id (stable).

Dead and own contacts are skipped (own unless exact), as are the `exclude` addresses (what is already in To/Cc/Bcc). **Short queries** (one term of 1–2 chars: the largest ranges, up to ~60 % of entries for a common letter) answer from a per-prefix cache of the top 32 (invalidated by a version bump on any score change, refilled lazily on the next miss); if exclusions leave fewer than K, the full range is scanned.

### 3.4 Memory and eviction

Caps (`allocatedBytes()` counts typed arrays at their capacity, strings at 2 bytes per char + 40 bytes, the address map at 64 bytes per entry): desktop 64 MiB steady, web 40 MiB, and at most 250,000 / 150,000 contacts. Over a cap, the lowest-ranked 10 % (received-only first, then by score) are marked dead and dropped from the address map; their tokens disappear at the next merge, and a snapshot never writes them (a restore is compact). Measured target: 100k contacts in ≤ 32 MiB.

### 3.5 Incremental maintenance

A message is applied once: a bitset of seen message ids (grows with the largest id; 300k messages = 37.5 KB) skips re-served ids (a body arriving, a flag change of the same message). A removed message clears its bit but its contribution stays: a person you corresponded with remains a person you know (Gmail's "Other contacts" behaves the same), and an account removal resets the index (no contacts of a removed account linger). Score updates are O(1); a new contact costs one map insert and ≤ ~8 delta inserts.

### 3.6 Snapshot

The instant index's container (`packSnapshot`/`unpackSnapshot`: magic, header, checksum, 8-byte-aligned sections), kind `{ tokenizer: 1, format: 1, identity }`: live contacts only (ids compacted), their arrays, names (`{strings}`), the merged token segment, the seen bitset, the revision. Restore = typed-array copies, the strings, and one map build: no re-tokenizing or sorting. A damaged, foreign or newer file is ignored (rebuild). Snapshot size cap: 64 MiB (desktop), 40 MiB (web); over it, no snapshot (the index works, rebuilds next time).

## 4. Body: ghost text from your own sent mail

### 4.1 Learning

From the user's own **sent** mail with a stored body, never anything else, never sent anywhere (works in local mode):

- **Own text only**: the body is cut at the first quote attribution (`On … wrote:`, `El … escribió:`, `-----Original Message-----`, `Le … a écrit :`, a `From:` header block), lines starting with `>` are dropped, and the signature (`-- ` line) and everything after go. At most the first 4 KB of what remains.
- **Tokens**: words (`\p{L}[\p{L}\p{M}\p{N}'’-]*`), numbers, and `, . ! ? ; :` as their own tokens; a line break or `. ! ?` ends a sentence. Each sentence starts with `<s>`.
- **Names**: a word right after a greeting (hi, hello, hey, dear, hola, buenas, buenos, estimado/a, querido/a, qué tal…) that matches the first name of one of the message's recipients becomes `<name>`; the sender's own first name in the last three lines becomes `<me>`. At suggestion time they expand to the draft's first recipient's first name and the From account's sender name. ("Hi <name>," learned from "Hi Arjun," / "Hi Laura," suggests "Hi Ana," to Ana.)
- **Language**: each message gets en / es / other from a 20-stopword count each (≥ 2 hits and more than the other); sentence-start contexts (those containing `<s>`) are kept per language, so "Hola" and "Hi" don't compete. A draft's language is detected the same way over the window; undecided → the language most of the user's sent mail is in.

### 4.2 The model

- **Vocabulary**: folded word → id (`Map`), ≤ 60,000 words (later new words are unknown: contexts with them aren't kept), with counts of how each is written mid-sentence (lowercase, Capitalized, UPPER) to choose its surface form (`i` → `I`, `pdf` → `PDF`).
- **Contexts**: orders 1–3 (the previous 1, 2, 3 tokens within the sentence). One open-addressing table of fixed capacity (2^18 slots desktop, 2^17 web): per slot two 32-bit hashes of (order, token ids, language when `<s>` is in it), the context's total, and its **top 4 continuations** with counts maintained by Space-Saving (a new continuation replaces the smallest, starting from its count + 1), so frequent continuations survive in bounded memory. `Uint32Array`s only: 44 bytes a slot (11.5 MiB desktop, 5.8 MiB web).
- **Bounded memory**: at 70 % load the table is pruned in slices: every count halves, contexts whose total falls below 2 go (rehash into a fresh table of the same size). This doubles as recency.

### 4.3 Suggesting

`compose.suggestText({ before, accountId, names })`: `before` is at most 1,000 characters immediately before the caret (the renderer never sends more, so a 10 MB draft costs the same as a short one), `names` the first names of the draft's To recipients (≤ 10).

1. The window's last sentence is tokenized; a word fragment at the end is the **partial** word.
2. Decode greedily up to 8 tokens: try the context of order 3, then 2, then 1 (order 1 only right after `<s>` or for the first token); take the best continuation that starts with the partial (folded; strictly longer than it).
   - First token: count ≥ 3 and probability ≥ 0.35 (≥ 0.6 among the partial's candidates when mid-word: "mid-word unless confident").
   - Each next token: count ≥ 3 and probability ≥ 0.5.
   - Stop after `.`, `!`, `?` or when confidence falls; `<name>`/`<me>` expand, or stop before them when unknown.
3. The result keeps what the user typed (only the rest of a partial word is suggested), adds a leading space when the caret is right after a whole word, and must add ≥ 3 characters; otherwise null.

Cost: tokenizing ≤ 1,000 characters and ≤ 24 table probes: microseconds.

### 4.4 The editor (`composer/ghost.ts`, lazy chunk)

- **Plugin state** `{ text, pos } | null` and one `Decoration.widget(pos, span.rt-ghost, { side: 1, ignoreSelection: true })` kept in the state (created once per suggestion, mapped otherwise); the span is `aria-hidden`, `contenteditable=false`, `pointer-events: none`, `user-select: none`. Never in the document, the history, the draft or the HTML.
- **When it asks**: after a document change typed by the user (not paste, not undo/redo, not an accepted suggestion), debounced 60 ms, only if: suggestions are on; the editor is focused and editable; no IME composition (`view.composing`, and `compositionstart` dismisses); the selection is a caret at the end of its line (only whitespace after); not inside a link, a quote or a code-like font (`mono`); the line has text before the caret. The request carries a sequence number; an answer that arrives after any later transaction is dropped.
- **Typing through**: typing the ghost's next characters consumes them (the ghost stays, shortened, no new request); anything else (another character, deletion, caret move, selection, blur, a send starting) dismisses it.
- **Keys** (a keymap before the editor's own): `Tab` accepts the whole suggestion; `→` at the ghost accepts the next word; `Esc` dismisses (and stops the event, so the draft doesn't collapse). Without a ghost, they do what they did. An accepted suggestion is one undo step (`closeHistory` around it), so ⌘Z removes exactly what was accepted and ⇧⌘Z brings it back.
- **Screen readers**: a visually hidden polite live region in the composer announces "Suggestion: … Press Tab to accept." once per new suggestion.
- **Style**: the design's `--muted-foreground` (AA, ≥ 4.5:1 on every draft surface, tested), same font, size and marks as the text before it (it is inside the line).
- **Cost per keystroke**: the plugin's `apply` is O(1); the request is a timer; the window is read from the caret's own line and up to 4 previous sibling lines (ProseMirror resolved positions, O(1) each), never `doc.textBetween` over the whole document.

### 4.5 The setting

`AppSettings.composeSuggestions: boolean` (default `true`), in Settings → General → a new **Writing** group: "Suggest text while writing" / "Completes sentences from mail you've sent. It's learned and kept on this device." Off: no requests, the phrase model is dropped and its snapshot deleted. Recipient suggestions are always on.

## 5. Recipients UI (`RecipientInput`, entry chunk)

- Replaces the three `<input>`s (To, Cc, Bcc); the draft's model (`toText`…) is unchanged, so saving, sending, conversions and every existing test keep working.
- **The token being typed** is the text between the previous unquoted `,`/`;` before the caret and the next one after it (quotes and angle brackets respected, like `parseAddressList`). A token with `<…>` (already chosen) or empty asks nothing.
- **Per keystroke**: `compose.suggestRecipients({ query, exclude, accountId, limit: 6 })` with a sequence number (answers to older keystrokes are dropped). `exclude` is every address already in To, Cc and Bcc except the token being typed.
- **List**: a listbox under the field, portaled (`position: fixed`, aligned to the field row, kept in view while the reader scrolls), the design's popover surface (hairline ring, `--popover`, rounded per design), at most 6 rows: avatar, name (the matched part in medium weight), address in `--muted-foreground`. Motion: none beyond the existing popover fade (≤ `--motion`, off when reduced).
- **Keys**: ↓/↑ move (wrapping), Enter or Tab accept, Esc closes (the draft stays open; a second Esc collapses as today), `,` or `;` accept the highlighted suggestion when what's typed isn't already a complete address; mouse hover highlights, click accepts. Accepting replaces the token with `Name <address>, ` and keeps typing there. Blur closes.
- **ARIA**: the input is `role=combobox`, `aria-autocomplete=list`, `aria-expanded`, `aria-controls`, `aria-activedescendant`; the list is `role=listbox` with a name ("Suggestions"); options `role=option`, `aria-selected`.
- **Paste**: a pasted text with a separator (`,` `;` newline), `mailto:` or more than one address is parsed (`parseAddressList`, `mailto:` dropped, duplicates of what's already there skipped) and inserted formatted (`a, b, c, `).
- **From**: the Select keeps typeahead (Base UI) over the identities; no extra index is needed (a handful of entries).

## 6. Resource limits (summary)

| | desktop | web |
|---|---|---|
| contact index | 64 MiB / 250k contacts | 40 MiB / 150k contacts |
| phrase model | 2^18 slots (11.5 MiB) + ≤ 60k words | 2^17 slots (5.8 MiB) + ≤ 60k words |
| snapshots | ≤ 64 MiB each | ≤ 40 MiB each |
| background slice | 4 ms | 6 ms |
| idle | nothing scheduled after catch-up and snapshot | same |

## 7. Copy (en + es)

`compose.suggest.list` (Suggestions / Sugerencias), `compose.suggest.announce` (Suggestion: {text}. Press Tab to accept. / Sugerencia: {text}. Pulsa Tab para aceptarla.), `settings.general.writing` (Writing / Redacción), `settings.general.suggestions` (Suggest text while writing / Sugerir texto mientras escribes), `settings.general.suggestions.hint` (as §4.5, both languages).

## 8. Tests

**Unit**

- fold (diacritics, ß, CJK untouched, ASCII fast path);
- contact index:
  - ranking: frequency and recency, sent-to above received-only, class weights, whole-token bonus, account boost, automated penalty;
  - matching: diacritics both ways, initials, CJK suffixes, multi-term, `@` queries, domain;
  - identity: duplicates with different names (one contact, most frequent name, alternates searchable), same name with different addresses (both, distinguished by address);
  - own addresses (hidden unless exact), exclusions, spam and drafts ignored, re-served ids counted once;
  - an oracle property test (random contacts and queries vs a brute-force ranker, through deltas and merges), eviction under a cap, snapshot round trip and corrupted/foreign snapshots;
- phrase model: quote/signature stripping corpus (Gmail, Outlook, Apple Mail, Spanish), tokens, `<name>`/`<me>`, suggestions after training, no suggestion for unseen or low-confidence text, mid-word threshold, language separation, pruning keeps frequent phrases under a full table, snapshot round trip;
- service: restore + catch up, gap → rebuild, notify before warm ignored, close persists, phrases off deletes its snapshot, reset on account removal, three failures disable;
- store conformance (both engines): projections, changes after ingest/send/remove, lease keeps the log, sent texts;
- renderer: token at caret, accept/replace formatting, paste parsing, the ghost plugin's state rules (consume, diverge, caret move, undo, paste, composition) on `EditorState` in Node.

**Perf (`pnpm test:perf`)**, new files only:

- `contacts.perf.test.ts`: 300k messages, 100k+ contacts:
  - build: CPU per message ≤ 15 µs, max stall ≤ 16 ms;
  - memory: heap after GC ≤ 32 MiB, `allocatedBytes` within it;
  - snapshot: ≤ 24 MiB, restore ≤ 250 ms CPU;
  - lookups: p95 ≤ 0.25 ms, p99 ≤ 1 ms over 5,000 realistic keystroke queries (1 to 12 characters, names, addresses, initials);
  - an incremental message ≤ 20 µs CPU.
- `phrases.perf.test.ts`: model from 100k sent messages: CPU per message ≤ 60 µs, max stall ≤ 16 ms, memory within the cap, suggest p99 ≤ 0.5 ms (windows up to 1,000 characters).
- Through the stores: SQLite (node) and IndexedDB (fake-indexeddb) at 300k messages, the service end to end: build wall time and max stall, cold start from the snapshot, a lookup while the build runs.
- **Robust to a loaded machine**: throughput gates use process CPU time (`process.cpuUsage`), not wall time; latency gates take the best of 5 rounds of the p95/p99 (preemption by other processes doesn't repeat, a regression does); stalls use best-of-3. Each gate has an **injected-regression twin** in the same file that runs the same measurement with a deliberate regression (the lookup without its token index: a scan; the build with a per-message busy loop) and asserts the gate would fail.

**UI perf (`pnpm test:ui-perf`, `autocomplete-perf.spec.ts`)**

- 5 MB and 10 MB drafts (many lines, one long paragraph), caret at start, middle and end:
  - typing bursts with suggestions on vs off, interleaved (paired): p95 with ≤ 1.15× + 2 ms of without;
  - keystroke → ghost painted: p95 ≤ 120 ms, debounce included;
  - no editor re-render beyond the ghost (a MutationObserver sees only the widget span change);
- paste of 1 MB with suggestions on;
- 300 accept/dismiss/undo cycles: heap growth ≤ 2 MiB after GC (CDP);
- recipients: keystroke → list painted p95 within a frame (≤ 16.7 ms, best of 3);
- injected twins via a probe-build flag (`__ternoInject`: a 6 ms busy loop per keystroke in the ghost plugin) asserting the paired gate fails.

**E2E (`autocomplete.spec.ts`, @design: macOS, Lumen, Atelier × light/dark)**

- recipients: suggestions for a name prefix, a diacritic-free query, initials; ↓/↑/Enter/Tab/Esc/comma; click; already-added addresses excluded; own address hidden; paste a list; Esc closes the list, not the draft; axe with the list open in light and dark;
- body:
  - ghost appears after typing the start of a phrase the seeded sent mail repeats, styled with the muted token; Tab accepts it (one undo step), → accepts a word;
  - Esc dismisses (draft stays open); typing through consumes it, diverging dismisses;
  - a greeting with the recipient's name;
  - the setting off: no ghost;
  - axe with a ghost shown.
- Screenshots in `/tmp/unica-scratch/autocomplete-18/`, inspected.

## 9. Performance and resources

- Entry chunk: `RecipientInput` (small, no new dependency); the ghost plugin lives in the lazy composer chunk.
- Per keystroke: recipients, one RPC and one in-memory lookup; body, a plugin `apply` and a timer reset (the request after 60 ms quiet).
- Background: only after warm, only on commits, time-sliced; idle afterwards.

## 10. Out of scope

A contacts manager or address book sync (CardDAV, Google Contacts), groups/lists as recipients, recipient chips, AI (LLM) completions (the local model only; an AI-provider option could come later behind the AI settings), suggestions in the subject, learning from received mail's text.

## Revisions after the Codex review

Codex (`codex exec -s read-only`, 12 points) against the plan and the code. What changed:

1. **Flag changes the log doesn't carry.** SQL's dirty-message trigger doesn't fire for `is_spam`/`is_sent`/`is_draft` or the recipient columns. Recipients, `is_sent` and `is_draft` never change after ingest (headers are immutable; an adopted provider id keeps them). `is_spam` does (marking spam later), and it reaches the log as a thread change: `changes()` also returns the senders of the touched threads now in spam, and those contacts get a **spam** flag (not suggested unless you've written to them). New non-spam mail from them clears it. No migration (v14 stays free).
2. **Additive learning is a policy, stated.** A message's contribution is applied once (seen bit); later states of the same message don't re-apply. Removals keep contributions (people you corresponded with stay known); an account removal resets both models. An id reused by SQLite (the newest message deleted, another ingested) before a catch-up is counted as already seen: one message's contribution is lost, never doubled. Tested.
3. **Bounded body reads.** SQL serves `substr(body_text, 1, 65536)`; IDB reads bodies 8 at a time in their own exclusive units (commands interleave) and truncates before returning; `ownText` keeps ≤ 4 KB. A test feeds 10 MB bodies and runs a command during learning.
4. **Eviction reclaims memory.** After eviction the index **compacts** (sliced): live contacts get dense ids, every per-contact array and the token segment are rebuilt at their live size, dead strings go. Tokens per name are capped (12), names at 200 characters, tokens at 32 characters (the length byte can't wrap). The seen bitset is sized by the largest message id (in the byte count; 5M ids = 625 KB). Tests: repeated eviction cycles stay under the cap; hostile long names.
5. **Peaks.** Each model's steady cap is checked after every page, and a snapshot (or a merge/compaction/prune) runs only when `2.5 × allocatedBytes` fits under the peak cap (desktop 160 MiB, web 96 MiB for both models together). String sections are decoded in slices by the models themselves. The perf gates measure `heapUsed + arrayBuffers` after GC.
6. **Short-prefix cache.** Keyed by the account boost too; accounts get collision-free bits (the first 32 distinct account ids seen; later ones get no boost, documented) instead of `id % 32`. A cache miss costs one range scan (gated with an import running).
7. **Space-Saving error.** Each continuation keeps the count it inherited (`Uint16` error term); thresholds use the guaranteed count (`count − error`). Slots are 52 bytes (desktop 2^18 = 13 MiB, web 2^17). Test: a context with many one-off continuations never suggests.
8. **Bounded editor window.** The window is collected by walking inline children backwards from the caret's child index (`$from.index()`), at most 1,000 characters, hard breaks as line ends; the "end of the line" check walks forward at most 256 characters and gives up (no suggestion) beyond. The perf suite counts requests, so a position that silently asks nothing fails.
9. **Key ownership.** The ghost's keys are handled in `handleKeyDown` with the native event: `preventDefault` and `stopPropagation` (the forms ignore `defaultPrevented` for Esc). Only unmodified Tab/→/Esc; IME (`isComposing`, keyCode 229) is left alone. With a ghost shown, Tab accepts it even in a list (no ghost, Tab indents as before). Recipient Enter/Tab/Esc/comma with the list open are prevented and stopped (Enter never submits the form). Browser tests for both forms.
10. **Stale answers.** A ghost answer is shown only if, when it arrives, the editor still has focus, is editable, suggestions are still on, and the document, selection and the draft's recipients/account are those of the request. Recipient or account changes, blur, a send starting and the setting turning off dismiss a shown ghost. In the backend, `reset()`/`setPhrases(false)` wait for the unit in flight before deleting files; `close()` runs before the store closes.
11. **Kept states.** Plugin state is plain data (`{ text, pos }`); the widget's DOM is made per view. The state kept for a remount has the ghost cleared. Suggestion-only transactions are `addToHistory: false`; an acceptance is its own undo step on both sides (`closeHistory` on it and on an empty transaction after it).
12. **Forwards and recipient formatting.** `ownText` is tested against the real `quoteFor` → `sendBody` output in both languages (Terno's own "Forwarded message"/"Mensaje reenviado" and attributions). Accepted recipients are written with `formatAddress` (names with commas or quotes are quoted), with save/send round trips.

## Implementation notes (what differs from the plan above)

- **The ghost is a layer, not a decoration.** Measured as a widget decoration, every suggestion shown or consumed made ProseMirror walk the whole document (a decoration change at the root) and Chromium lay the caret's paragraph out again: +18 ms a keystroke at 5 MB, double in a 1 MB paragraph. It is now an absolutely positioned layer beside the editor (never in its DOM, its text or a copy): it starts at the caret's line box (snapped to the block's line grid), continues the line with `text-indent` at the caret in the caret's own font, is trimmed to the whole words that fit on that line (what shows is exactly what Tab inserts; nothing fits → nothing shows), and is placed in the frame's animation callback, where layout is due anyway. Suggestions require a left-aligned line. Plugin state stays plain data (`{ text, pos }`), so kept states and undo are as planned.
- **Recipient lists paint in the keystroke's frame.** A recipient field prefetches the best 20 people per first letter and digit when it gets focus (`compose.recipientInitials`, sliced on the backend, at most every 30 s per account); a keystroke shows them, or narrows what is shown, at once, and the backend's answer replaces them a frame later.
- **The contact index ranks with one key per contact**: (3·sent + recv) × penalty, scaled by 2^500 for people written to (exact for doubles, far above any other key), so most token entries are rejected with one multiplication. One-letter words of a multi-word query are checked against per-contact first-letter masks (by class, and one-letter tokens) instead of walking a sixth of the index. Tokens are kept as order-preserving bytes (one per UTF-16 unit below 0xFF, three otherwise): half the memory of UTF-16, comparisons on bytes, snapshots copy them as is.
- **No `count` per contact** (nothing ranked on it); name weights are `Float32`.
- **Snapshots**: contacts 16 MiB and phrases 13 MiB at 110k people / 105k sent messages (format 3: no start offsets, strings as escaped bytes).
- **The slice clock restarts after resting** (an idle sleep isn't running time); snapshots, merges, restores and the IndexedDB id scans yield throughout.
- **Peak check** estimates a snapshot's copies (about what the model holds) instead of 1.5× the model: under web caps the contact snapshot was never written and every start rebuilt.
- **Drafts are limited to 5M characters** (plan 16): the 10 MB draft of the gates is Chinese text (three bytes a character in UTF-8).
- **Known limitation:** the backend answers one request at a time, so a suggestion asked while a multi-megabyte draft is being saved waits for that save (seconds at 5 MB); it is shown when it arrives if nothing changed meanwhile.

### Measured (this machine, loaded by other work; budgets in the tests)

| | measured | gate |
|---|---|---|
| contacts build, 300k messages / 110k people | 8 µs CPU a message, longest stall 4.6 ms | ≤ 15 µs, ≤ 16 ms |
| contacts memory | 30 MiB measured, 37 MiB counted | ≤ 32 MiB; counted ≥ measured, ≤ 1.6× |
| contacts lookup, 5,000 realistic keystrokes | p50 97 µs, p95 197 µs, p99 336 µs | p95 ≤ 0.25 ms, p99 ≤ 1 ms |
| contacts snapshot / cold start | 16 MiB / 107 ms CPU | ≤ 24 MiB / ≤ 250 ms |
| contacts incremental | 14.6 µs a message | ≤ 20 µs |
| phrases build, 100k sent | 46 µs CPU a message, stall 4 ms, 13 MiB | ≤ 60 µs, ≤ 16 ms, ≤ 24 MiB |
| phrases suggest | p95 9 µs, p99 10 µs; 27 µs after a 1 MB line | p95 ≤ 0.1 ms, p99 ≤ 0.5 ms |
| SQLite end to end (300k) | both models 5 s, stall 23 ms, cold start 123 ms, catch-up 78 µs | ≤ 120 s, ≤ 32 ms, ≤ 1.5 s, ≤ 150 µs |
| IndexedDB end to end (300k, fake-indexeddb) | 20 s, stall less GC within 48 ms, cold start 206 ms, catch-up 241 µs | ≤ 300 s, ≤ 48 ms, ≤ 3 s, ≤ 300 µs |
| typing with vs without suggestions (5 MB, 10 MB, 1 MB paragraph) | per-round ratio 0.99–1.02 | ≤ 1.10 + 1 ms |
| typing stopped → ghost shown | 61–81 ms (60 of it the pause) | ≤ 120 ms |
| keystroke → recipient list painted | p50 4 ms, p95 15 ms | ≤ 16.7 ms |
| 300 suggestion cycles | heap +1.3 MiB | ≤ 2 MiB |

Each gate has an injected-regression twin that must fail it: lookups by scanning (p95 151 ms), 30 µs extra per indexed message, 80 µs extra per learned message, an unbounded suggestion window (17 ms), 6 ms extra per keystroke in the editor (ratio 1.54).

## What the Codex code review changed

Round 1 (`codex-review.sh d3b6e78`, focused on scale, memory, ranking, editor edge cases, the combobox and privacy; 11 findings), each fixed with a regression test that fails without the fix:

1. **High:** a snapshot behind a pruned log was restored again and again (977 restores in 100 ms). The log's reach is checked before a snapshot is used; after a gap the files go and the session builds. Conformance test on all three engines.
2. **High:** a commit's headers were applied in one go (12,000 new people: one 1.9 s stretch, the delta at ~60,000 tokens). Applied in slices with merges and caps inside. Service test (stretch < 60 ms, delta near its threshold).
3. **High:** the vocabulary cap counted words, not bytes. Words over 32 characters aren't kept; 1M characters at most. Unit test.
4. **High:** IndexedDB read whole bodies before cutting them. Sent mail over 512 KB (raw) isn't learned from, in both stores. Conformance test.
5. **High:** an old list stayed acceptable for a newer word. An unmatched list goes at once; acceptance checks the query. E2E with the backend's answer held 3 s.
6. **Medium:** pasting over a selection dropped the addresses it replaced. Deduplication looks only at what stays and the other fields. Unit test.
7. **Medium:** the ghost was fitted while hidden (0 high: every word "fit", wrapping over the next line). Measured laid out but unseen. E2E at a line's end with text below.
8. **Medium:** a cancelled IME composition left an unseen ghost for Tab. Composition start dismisses it. E2E.
9. **Medium:** digits shared one mask bit ("ana 1" matched 2@x.io). Digits are walked; the oracle property test covers digit queries.
10. **Medium:** a page of empty sent bodies ended learning (IndexedDB). `sentAfter` returns its cursor apart from its results. Conformance test.
11. **Medium:** the UI gates held medians only, and latency was taken before the ghost was placed. Added a paired gate on each round's slowest quarter, with a twin (10 ms on one key in four: medians 1.03, slowest quarter 1.47 against a 1.32 gate); latency now runs to the frame that places the ghost.

Round 2 (only the round-1 fixes, 3 findings), fixed with regression tests: the caps also hold while a large commit applies, and merges inside it respect the peak (service test with a 1,000-contact cap and a 12,000-person commit); a phrase snapshot over today's vocabulary limits is refused, and the format is bumped (unit test); the line-end test is deterministic (the editor narrowed so " you have" fits and " you have any" doesn't, in each design's own type: the ghost shows " you have", one line high, and Tab inserts exactly that; it fails without the round-1 fix).

Also fixed while running the suites: the ops worker kept claiming batches after `stop()` gave up waiting for it (a long archive-all-then-undo queue on a loaded machine hit a closed database in e2e teardown); it now stops claiming once the backend is stopping.

## Timing-sensitive gates (for the load-aware policy)

Machine-load sensitive (wall clock): every event-loop stall gate (`contacts.perf` build stall; `phrases.perf` build stall; `autocomplete.perf` in `packages/db` and `packages/idb`: build, cold start), the cold-start and build wall times, and all of `autocomplete-perf.spec.ts` (paired ratios, suggestion latency, recipient paint). CPU-time gates still inflate under heavy contention (cache, frequency): phrase build µs a message, IndexedDB catch-up µs a message. The contact index's lookup, build, memory, snapshot and incremental gates held at a load average of 35 on 12 cores.

## The perf gates under the load-aware policy (October 2026)

The timing-sensitive gates above now follow plan 04's policy (§11, `packages/db/src/test/timing.ts`). Budgets are unchanged.

- **Build stalls** (`contacts.perf`, `phrases.perf`, and the SQLite and IndexedDB builds) are the event loop's (`watchLoop`). On a busy machine a rare hold of the OS counts at its CPU time; on a quiet one nothing is excused. A build over its stall or CPU budget is measured again, up to three builds in all (on SQLite and IndexedDB without the snapshots of the last one). The best of each figure counts.
- **Collections only excuse their own gap.** The SQLite and IndexedDB build stalls used to subtract the stage's longest collection from its longest stall, wherever each fell. An injected 60 ms block passed the 48 ms IndexedDB gate at 45.7 ms when spun, and at 14.0 ms off a CPU on a quiet machine, because a 44–75 ms collection had happened elsewhere. Now each gap leaves out only the collections inside it (`watchGc`, `stallLessGc`, unit-tested). The same injections fail at 70.2 and 80.6 ms.
- **Cold start.** Only the first start is cold: later ones run compiled code, 101–119 ms against 120–157 ms for the first. So the time is the first start's, less the holds excused on a busy machine. A stall over budget (the restore's slices, which compiled code doesn't change much) is measured again with another start.
- **Catch-up.** The first catch-up after a start costs about a second of CPU however few the messages: 1.25 s for 300 messages (4.2 ms a message, thread CPU 1.06 ms), against 22–82 µs a message for each 3,000 after it. That cost is compiling and lazy reads. So the 241–693 µs a message measured before was mostly that one-time cost, and a re-measured catch-up would have been warm while the first was cold. An untimed 300-message warm-up now runs first; each timed catch-up then follows other new mail and is measured again if over budget. **This gate is now much less sensitive in practice:** 300 µs against about 30–80 µs a message warm under load. Tighten it once it has been measured on a quiet machine.
- **CPU time on a loaded M2 Max.** This machine has 8 performance and 4 efficiency cores. Once load passes about 8, threads run on efficiency cores, and CPU time grows on the thread itself: the phrase build measured 71.2 µs of thread CPU against 72.3 µs of process CPU. Re-measuring can't fix sustained load. The phrase build CPU gate (60 µs a message) failed in every run here: 72–100 µs, and also on main's unchanged test at 97 µs (load 5–8, 1-minute average). It measured 46 µs when this plan was written.
- **The UI spec** (`autocomplete-perf.spec.ts`) is unchanged; its header now states the gates it asserts. It already pairs and interleaves its runs, and takes the best of three for latencies.

**Proof.** Each regression was injected temporarily, never committed: a block of 25 ms per 100 pages (store builds), 60 ms per 20 sent-mail reads (SQLite and IndexedDB builds), 60 ms plus 10 ms chunks over the time budget in a cold start's snapshot read, and 300 µs a message in a catch-up. Each was run spun with `PERF_MACHINE` unset (busy by load), and off a CPU (`Atomics.wait`) with `PERF_MACHINE=quiet` and `=busy`:

| gate (budget) | spun, busy by load | off-CPU, quiet | off-CPU, busy |
|---|---|---|---|
| contacts build stall (16 ms) | 25.5 ✗ | 30.6 ✗ | 30.5 ✗ (holds recur: none excused) |
| phrases build stall (16 ms) | 25.3 ✗ | 30.8 ✗ | 31.0 ✗ |
| phrases build CPU (60 µs, +30 µs spun) | 89.3 ✗ | — | — |
| SQLite build stall less GC (32 ms) | 54.9 ✗ | 75.8 ✗ | 66.2 ✗ |
| IndexedDB build stall less GC (48 ms) | 70.2 ✗ (was 45.7, passing) | 80.6 ✗ (was 14.0, passing) | — |
| SQLite cold start (1.5 s / 32 ms) | 1,959 ✗ / 70.1 ✗ | 2,291 ✗ / 77.6 ✗ | 2,225 ✗ / 14.4 (one hold: excused by design) |
| IndexedDB cold start (3 s / 48 ms) | 3,781 ✗ / 70.1 ✗ | 4,403 ✗ / 74.0 ✗ | 4,337 ✗ / 36.6 (two holds: excused by design) |
| SQLite catch-up (150 µs) | 321.6 ✗ | — | — |
| IndexedDB catch-up (300 µs) | 324.1 ✗ | — | — |

Off-CPU waits add no CPU, so the CPU gates take only the spun injection.

**Codex review** (`codex-review.sh 76f512b autocomplete-perf-policy`, 1 finding). Medium: `watchGc().stop()` disconnected after one timer, so a collection whose entry Node hadn't delivered yet could be dropped and then count as a stall of ours. That errs strict, never lenient. Its reproduction missed 3 of 300 entries, but it counted collections that began after `stop()`. Counting only the collections inside the stage, the old helper missed none of 5,000 here. `stop()` now also waits for the check phase and takes the undelivered records (`takeRecords()`). A unit test forces a collection at the end of each of 50 stages, with real GC, and expects it reported. It passes on the old helper too: it guards the drain rather than reproducing a miss.
