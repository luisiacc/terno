# Plan 34: recipient chips, and reply / reply-all addresses that survive other clients

- **Status:** implemented (see "Implementation notes" and "What the Codex code review changed" at the end).
- **Builds on:** `76c2ab9` (main after plans 20–24).
- **Numbering:** first written as 26 beside the re-sign-in work (25). Main then took 26 (provider reliability), 27 (Reply-To), 28 (Google sign-in), 29 (mail attachments), 30 (search date boundaries), 31 (account sync lifecycle), 32 (refresh credential rotation) and 33 (incoming mail pipeline), so this is 34.
- **Request (verbatim):** "for the emails that are the destinies and the ccs, lets have nice little clean bubbles there instead of plain text, it is annoying sometimes to have it but its prettier and nice, make it so the ux while interacting there is good to, so they can hit backspace before an email and delete it, so the interaction there needs to be world class intuitive and good ux.
  lets also cover scenarios that i see sometimes where i hit reply all, but the user comes with a CC that is messed up because of the email client they are using like `\"_David_Sucre_L.?= <david@sucre.net> , Luis Alberto Medina\" <lmedina@sucre.net>`
  which will fail in things like Mac mail.
  investigate also other potential issues with that reply-all when the cc or To directions could be messed up, investigate all bad scenarios that happen with other email clients, and lets make sure we handle them all graciously and performantly, of course have tests for those."
- The request came with a screenshot of the inline reply. It showed the From row, then "To  Björn Peña <bjorn.pena@acme.studio>" as plain text, with the Cc / Bcc / Subject toggles on the right.

## 1. What exists

- **Recipient fields** (`apps/web/src/components/recipient-input.tsx`, plan 18): a plain `<input role=combobox>` per field (To, Cc, Bcc) in `DraftFieldsForm` (`inline-draft.tsx`). The inline reply and the new message share it.
  - The draft keeps each field as text (`toText`, `ccText`, `bccText`) plus `auto` (the addresses Terno filled in, per field).
  - The suggestions come from the backend's contact index. The list is portaled. ↑/↓ move, Enter/Tab accept, Esc closes, `,`/`;` accept unless a complete address was typed. Paste goes through `pastedAddresses`/`pasteInto` (dedupe against this field and the others).
  - Pure helpers live in `lib/recipients.ts` (`tokenAt`, `acceptAt`, `emailsIn`, `pastedAddresses`, `insertPasted`, `pasteInto`, `highlight`), with tests.
- **Drafts** are saved as `DraftAddress[]` (`recipients()` in `drafts.ts`, which parses the text with core `parseAddressList` and keeps unfinished ones like "bob@"). They load back through `formatAddressList`. The contract caps each field at 200 (`draftAddress`), and sends at 200 with zod's `z.string().email()`.
- **Send** (`compose.ts` `send`) refuses when any typed entry isn't `isValidEmail`. It then says only "Check the recipients" (`compose.checkRecipients`), without naming the entry.
- **Core addresses** (`packages/core/src/address.ts`):
  - `formatAddress` quotes a name containing `",;<>@()[]:\`. `.` is not in that set, although RFC 5322 says it should be.
  - `parseAddressList` splits on unquoted, unbracketed `, ; \n` and takes `Name <addr>` or a bare address. It knows nothing of comments, groups, `mailto:`, smart quotes, or `Name addr` without brackets.
  - `isValidEmail` is a loose `x@y.z`.
- **Ingest:**
  - **Gmail (desktop and web):** `gmail-api.ts` fetches `format=raw` and runs `parseRaw` (`packages/mail/src/mime.ts`), which uses **postal-mime**'s address objects, lowercased.
  - **IMAP:** `imap.ts` maps imapflow's ENVELOPE, parsed by the server, with names decoded by libmime.
  - Neither path stores Reply-To. Measured postal-mime 4.1.3 behaviour on real-world shapes:

  | header (Cc) | postal-mime gives |
  |---|---|
  | `"=?utf-8?Q?Jos=C3=A9?=_David_Sucre_L.?= <david@sucre.net> , Luis Alberto Medina" <lmedina@sucre.net>` | **one** recipient `lmedina@sucre.net`, name `José_David_Sucre_L.?= <david@sucre.net> , Luis Alberto Medina` (the user's case; david is lost) |
  | `=?UTF-8?Q?Ana_<ana@x.com>?= <real@x.com>` | address **`ana@x.com`**, name `Ana  real@x.com`. Encoded words are decoded *before* the address is parsed, so a From can be spoofed this way (the Mailsploit class). |
  | `"Unbalanced <u@x.com>, b@x.com` | one junk address `"Unbalanced <u@x.com>, b"@x.com` |
  | `mailto:m@x.com, “Smart” <s@x.com>, …` | a *group* named "mailto" swallowing every later address |
  | `Outlook User [mailto:ol@x.com] <ol@x.com>` | a group "Outlook User [mailto" with name `ol@x.com]` |
  | `<<dbl@x.com>>` | name `>` |
  | `'Ana Torres' <a@x>`, `“Smart” <s@x>` | the quotes kept in the name |
  | `"ANA@x.com" <ana@x.com>` | the name is the address again |
  | `=?UTF-8?Q?Jos=C3=A9_P=C3=A9rez <jp@x>` (no `?=`) | name `=?UTF-8?Q?Jos=C3=A9_P=C3=A9rez` |
  | `JosÃ© PÃ©rez <jp@x>` (UTF-8 read as Latin-1 upstream) | mojibake kept |
  | `<a@x.com.>`, `Ana <mailto:ana@x.com>` | the trailing dot and `mailto:` kept in the address |
  | `"\u{202E}gnp.exe" <b@x>` | the bidi override kept (the name renders reversed) |
  | ks_c_5601-1987, gb2312, windows-1252, RFC 2231 `*lang`, UTF-8 split across adjacent words, folded lines, comments `(Jane)` | fine |

- **Reply recipients** (`autoRecipients` in `apps/web/src/lib/compose-fields.ts`):
  - **Reply** goes to the sender of the last message someone else sent, or to the original To when every message is mine.
  - **Reply-all** puts that message's To and Cc in Cc, minus the account's address, without dedupe inside Cc, and without looking at Reply-To or other identities.
  - It reads `MessageDetail.to/cc`, which come straight from `to_json`/`cc_json` (`packages/db/src/queries.ts`, `packages/idb/src/mail.ts`).
- **Outgoing:**
  - **Desktop** uses nodemailer's MailComposer (`compose.ts`): RFC 2047, folding, punycode.
  - **Web** uses `buildRawPortable` (`compose-portable.ts`): a single base64 encoded word for any non-ASCII name, however long. RFC 2047 limits an encoded word to 75 characters. A Unicode domain goes out as is.
- **Global keys** (`lib/keyboard.ts`) skip editable targets only: INPUT, TEXTAREA, SELECT and contentEditable.

## 2. Part A: recipients as chips

### 2.1 Model

`RecipientInput` keeps `value: string` and `onChange(value)` as its API, so the draft model, autosave, `auto`, conversions and every caller stay unchanged. **No migration.** Inside, the field is:

```
chips: Chip[]          // { key, address: Address, text: string (as written), valid: boolean }
text: string           // the <input>'s value: what is being typed
at: number             // where the input sits among the chips (normally chips.length)
selected: Set<number>  // chip keys
```

- `serialize(chips, text, at)` writes the chips' text joined by `", "`, with `text` in its place. A valid chip's text is `formatAddress(address)`. An invalid chip keeps what was written, with quotes and angle brackets removed so it can never swallow its neighbours on the next parse.
- `deriveChips(value, focused)` reads text into chips (pure, in `lib/recipients.ts`): split on unquoted, unbracketed separators, then each part goes through the lenient parser (§3.2). A part may give several chips: "a@x.com b@y.com".
  - The trailing part without a separator stays as `text` only while the field is focused. Unfocused, everything is chips.
  - The component re-derives only when `value` differs from the last value it emitted: a draft loaded, a mode converted, a reply filled in.
  - When it re-derives, its undo history restarts.
- What the user typed is never lost. An unfinished entry ("bo") saved by autosave comes back as an invalid chip, so it is visible and editable, and "bob@" still survives a reload.

### 2.2 Committing text to chips

| trigger | outcome |
|---|---|
| `,` or `;` | If the suggestion list is open and the text isn't a complete address, accept the highlighted suggestion (plan 18). Otherwise commit the text. Inside an open quote or `<…>` the character is typed. |
| Enter | List open: accept. Otherwise commit, and Enter never submits the form (today a bare Enter in To would implicitly submit, i.e. send). ⌘↵ still sends. |
| Tab | List open: accept and stay in the field. Otherwise commit and move on (not prevented). |
| Space | Commits only when the text is exactly one complete address ("ana@x.com␣"), the way Gmail does. A name being typed ("Ana ") keeps typing. |
| blur | Commit, unless focus moved to one of this field's own chips. |
| paste | A list (a separator, `mailto:`, several addresses, or `Name <addr>`) becomes chips at the caret, with plan 18's dedupe rules. One bare address is ordinary text. |
| accept a suggestion | Insert a chip at `at`. The text clears and the caret stays in the field. |

- A chip that duplicates one already in this field (same address, any case) isn't added twice.
- Each commit is one undo step.

### 2.3 Keyboard (focus never leaves the field)

Chips are real focus targets (`tabindex=-1`, roving): the selected chip has DOM focus, so a screen reader reads it. Tab never stops on a chip; the input is the field's single tab stop.

| where | key | does |
|---|---|---|
| input, caret at 0 | Backspace | selects the chip before the input (first press). The **second press deletes it**, like Apple Mail. A held Backspace (`repeat`) that deleted text never selects or deletes chips: deleting a recipient takes a deliberate press. |
| input, caret at 0 | ← | selects the chip before |
| input, caret at end | Delete / → | selects the chip after (only when the input sits between chips) |
| input, empty | ⌘A | selects every chip (with text, ⌘A selects the text first) |
| chip | Backspace / Delete | removes the selected chips, announces it, and focus returns to the input at the chips' place. ⌘Z brings them back. |
| chip | ← / → | previous / next chip. Past the last one, back to the input. Shift extends the selection. |
| chip | Home / End | first chip / the input |
| chip | Enter or F2, or a double click | edit: the chip turns back into text in the input, in its own place, with the caret at the end. The next commit puts it back where it was. |
| chip | ⌘C / ⌘X | copies the selected chips as an RFC 5322 list (`formatAddressList`); ⌘X also removes them |
| chip | ⌘V | pastes at the chips' place, replacing them |
| chip | ⌘A | all chips |
| chip | a character | focus goes to the input and the character is typed there. The chip stays: typing never destroys a recipient. |
| chip | Esc | back to the input. The next Esc is the draft's (it collapses), as with the suggestion list. |
| anywhere in the field | ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Y elsewhere), and the Edit menu's Undo/Redo (`beforeinput` historyUndo/historyRedo) | the field's own history: commits, removals, edits, pastes and accepted suggestions, and typing in runs (a run ends at a space or a chip change). Up to 100 steps. |

- `isEditable` in `keyboard.ts` also counts focus inside `[data-recipient-field]`, so Backspace, Delete, `e`, `#` and the other single-key shortcuts never act on the conversation while a chip is focused.

**Why select first, not delete at once:** a reply opens with its recipients already filled in. Deleting at once would let a run of Backspaces through typed text silently remove someone. Apple Mail and Superhuman select first, Gmail deletes. The highlighted chip shows what the next press will do, and ⌘Z covers the rest.

### 2.4 Mouse

- Click a chip to select it. ⇧-click selects a range, ⌘-click toggles one.
- Double-click edits.
- An × on hover, and on the selected chip, removes it; focus goes to the input.
- A click on the field's empty space puts the caret at the end.

### 2.5 Looks (tokens only; each design's ladder and scale)

- **The chip:**
  - Size: 22 px high, `text-sm`, `rounded-md` (each design's own ladder), horizontal padding 6 px, gap 4 px; the chips wrap.
  - Colours: `bg-muted text-foreground` at rest, `bg-accent text-accent-foreground` on hover, `bg-primary text-primary-foreground` when selected.
  - Text: the name, or the address when there is none. Its accessible name is "Björn Peña, bjorn.pena@acme.studio", and a tooltip (`title`) gives the full address.
  - No avatar. At 22 px it would cost a picture per chip, against plan 22's budget, and the name already identifies the person.
- **An invalid chip:**
  - Drawn the same, but the text is `text-destructive-ink` with a dotted destructive underline.
  - Its accessible description is "Not a valid email address". `destructive-ink / muted` is added to `CONTRAST_PAIRS`, and the suite must pass.
- **A no-reply address** (`noreply`, `no-reply`, `donotreply`, `mailer-daemon`, as plan 18 detects) keeps a normal chip. Its tooltip and accessible description add "This address may not accept replies". It is never removed.
- **Many recipients:**
  - Focused, the chips wrap over as many lines as they need.
  - Unfocused, with more than 3 chips, the field shows the first 2 and a quiet "and 12 more" button (`text-muted-foreground`). It reads as "Ana, Bob and 12 more" (Apple Mail's summary).
  - Clicking or focusing expands the list. The collapsed form renders 3 elements, not 200.
- **Motion:** a new chip fades in with `duration-base`, within `--motion`; with motion reduced, nothing animates.
- The collapsed draft line ("Draft · To …") shows the same names summary instead of the raw text.

### 2.6 Send explains

When an entry isn't an address, Send stays. The snack names the entry: "“bob” isn’t an email address. Fix or remove it, then send." Focus goes to that field, with the chip selected. "Add a recipient to send" appears when To is empty.

### 2.7 Accessibility

- **The field:** a group labelled by its row label ("To").
- **The chips:** a `listbox` (`aria-multiselectable`, labelled "To recipients") of `option`s with `aria-selected`.
- **The input:** stays the plan 18 combobox, with its own listbox of suggestions and `aria-activedescendant`.
- **Announcements:** removal and restore are announced through a polite live region ("Removed Björn Peña", "Restored 2 recipients").
- **The ×:** `aria-hidden`, mouse only. The keyboard removes with Backspace/Delete, and the chip's description says so ("Press Delete to remove"). This keeps axe's `nested-interactive` rule clean.
- axe runs in light and dark, in every design.

### 2.8 Performance

- Chips are memoized: a keystroke renders the input and none of the chips. The render probe counts `RecipientChip` renders, and the test asserts 0 per keystroke with 200 chips.
- Deriving and serializing are linear.
- The unfocused summary renders 3 nodes.
- The plan 18 gate (keystroke → suggestions painted ≤ 1 frame, p95) stays as it is, and a new gate types with 200 chips in the field: keystroke → painted p95 ≤ 1 frame.
- The draft and send caps rise from 200 to 1,000 per field: a reply-all to 250 people must save. Gmail itself allows 500 for consumer accounts and 2,000 for Workspace.

### 2.8a Drag between fields: out of scope

Apple Mail has it; Gmail and Superhuman don't. ⌘X in To then ⌘V in Cc moves recipients with the keyboard, keeps names and is one undo step each. Drag would add a second DnD system next to plan 01's, with its own focus and announcement problems. It is listed as a follow-up.

## 3. Part B: addresses that survive other clients

### 3.1 Where each problem is fixed

| layer | what | why there |
|---|---|---|
| **ingest, Gmail/raw** (`parseRaw`) | From, To, Cc, Bcc and Reply-To are parsed **by our parser** (§3.2) from postal-mime's raw (unfolded) header values. Every occurrence of a header is read, since some clients write two Cc lines. Then `repairAddresses` (§3.3) runs, then lowercasing as today. | Encoded words must be decoded after the structure is parsed (RFC 2047 §5): this closes the Mailsploit-class spoof, and the original case is still available. |
| **ingest, IMAP** (`imap.ts`) | the envelope's addresses (server-parsed) go through `repairAddresses`. Reply-To is taken from the envelope, unless it equals From (RFC 3501 fills it from From). | the server already tokenized; we fix what it and libmime leave |
| **read** (`queries.ts` thread detail, `idb/mail.ts` thread detail) | `repairAddresses` on From (name only, never split), To, Cc and Reply-To | messages stored before this change are fixed everywhere they are shown or replied to, with no backfill. It costs a regex fast-path test per address when nothing needs fixing. |
| **reply time** (`autoRecipients`) | the reply-all semantics (§3.4). Repair again: it is idempotent and cheap, and protects anything that bypassed the store. | |
| **outgoing** (`formatAddress`, `compose-portable.ts`, `compose.ts`, contract) | RFC 5322-correct names, encoded words of ≤ 75 characters, IDN domains as punycode, the contract validating with core's `isValidEmail` | §3.5 |

### 3.2 The parser (`parseAddressHeader` in core; `parseAddressList` becomes a wrapper for typed text)

- **One pass, linear:** a tokenizer for quoted strings (escapes; an unterminated one ends at the line end), comments (nested, escaped), angle addresses, the specials `, ; : @ <>` and atoms.
- **Grammar, leniently:**
  - The list splits on top-level `,`, and on `;` when no group is open (Outlook writes `;`).
  - **Groups:** `name: a, b;` gives its members; an empty group (`undisclosed-recipients:;`) gives nothing.
  - **A mailbox:** a phrase plus `<addr>`; a bare address with a `(comment)` as its name when there is no phrase; or `Name Words addr@x` without brackets (the last token containing `@`).
  - `<<a@x>>` and `<mailto:a@x>` give the address. A source route `<@relay,@r2:user@x>` gives `user@x`.
  - Several `<…>` in one part give several addresses.
  - `Name [mailto:a@x]` drops the bracket.
- **Encoded words are decoded only in phrases and comments**, after the structure is known:
  - adjacent encoded words separated only by whitespace are joined (RFC 2047 §6.2), and their bytes are decoded together, so UTF-8 split across words works;
  - Q and B, `charset*lang` (RFC 2231);
  - the charset goes through `TextDecoder` labels (windows-1252, iso-8859-*, gb2312→gbk, ks_c_5601-1987→euc-kr, shift_jis, big5, koi8-r…). An unknown charset is tried as UTF-8, then Latin-1;
  - encoded words inside quotes are decoded too (not allowed, but common).
- **Typed text** (`parseAddressList`) uses the same tokenizer without encoded-word decoding. It keeps today's guarantees:
  - a quoted name containing `,` or an address stays one recipient (the existing anti-injection test);
  - "bob@" survives;
  - anything that isn't an address keeps its text as an (invalid) entry.

### 3.3 `repairAddresses(list, { split })` (idempotent; a fast path when nothing looks wrong)

Each `{ name, email }` goes through the following steps.

1. **Address:**
   - trim, drop `mailto:`, surrounding `<>` and quotes, a source route, and a trailing `.` on the domain;
   - an address that still isn't valid but contains one valid address is replaced by it. If quotes or brackets show a swallowed phrase, the whole is re-parsed as `name email` (old rows from postal-mime: `"luis alberto medina <lmedina"@sucre.net>`).
2. **Name:**
   - decode leftover complete encoded words;
   - repair **orphan fragments**. A whitespace-delimited run ending in `?=` with no opening, or starting `=?cs?Q?` with no end, is decoded as Q-encoding: `_`→space, `=XX`→bytes, and the delimiters are dropped. "José_David_Sucre_L.?=" becomes "José David Sucre L.". Underscores elsewhere are left alone;
   - repair **mojibake**: a name whose characters all fit CP1252, and whose CP1252 bytes are valid UTF-8 containing a multi-byte sequence, is decoded ("JosÃ© PÃ©rez" becomes "José Pérez");
   - strip C0/C1 controls, bidi embeddings, overrides and isolates (U+202A–202E, U+2066–2069, U+200E/F) and zero-width spaces (U+200B, U+2060, U+FEFF). ZWJ and ZWNJ stay (emoji, Persian, Indic);
   - collapse whitespace;
   - strip one pair of surrounding quotes, whether `"…"`, `'…'`, `“…”`, `‘…’`, `«…»` or `„…“`, and unescape `\x`;
   - a name equal to the address, case-insensitively, or to `'address'`, is dropped, so it shows once;
   - cap the name at 256 characters.
3. **Recovery** (`split: true`: To, Cc and Bcc; never From or Reply-To, see the reconciliation review):
   - when the cleaned name contains `<valid address>`, `name <email>` is re-parsed as a list, and each part goes through step 2 (once, no recursion). The user's case becomes "José David Sucre L." <david@sucre.net> and "Luis Alberto Medina" <lmedina@sucre.net>;
   - a name containing a bare address in prose (`"leak@attacker.example, Support" <support@…>`, "Write to ana@x.com") is **not** split: without brackets there is no evidence of a swallowed recipient;
   - From is never split: one sender, the real address. Its name is cleaned only.
   - **Safety:** recovery only ever produces addresses written in the same header, which the sender could have listed directly, and each one shows as its own chip before anything is sent.
4. **Dedupe** case-insensitively on the address, keeping the first position. A later duplicate's name fills an empty one.

Invalid leftovers stay in To/Cc as invalid chips, never silently dropped (step 1 couldn't make them valid). Entries without any address (empty groups) are dropped at ingest, as today.

### 3.4 Reply semantics (`autoRecipients(mode, detail, mine)`)

**`mine` (my identities)** is a case-insensitive set:
- every account's address;
- every From of a message in this thread marked sent: Gmail send-as aliases, other identities;
- `local+tag@domain` counts as `local@domain`;
- for gmail.com/googlemail.com, dots in the local part are ignored.

**The message answered** is the last one whose From isn't mine (today: the last not marked sent). If every message is mine, it is the last one.

| case | To | Cc (reply-all) |
|---|---|---|
| ordinary | From | original To + Cc − mine − To |
| Reply-To present (one or more), not all mine | Reply-To (all of them, minus mine) | original To + Cc − mine − To. The From isn't added: the author said where replies go (RFC 5322 §3.6.3; Thunderbird and Apple Mail do the same). |
| Reply-To is only me | nobody: To left empty (plan 27's rule, kept) | To + Cc − mine |
| Reply-To equals a mailing list (munging) | the list | To + Cc − mine − list |
| answering my own message (everything in the thread is mine) | its To | its Cc − mine − To |
| my identity in the original From (an alias) | treated as my own message | |
| Bcc | never | never: not even mine, and it isn't exposed |
| duplicates across or within To and Cc, any case | once | once |
| a no-reply address | kept, with a hint | kept, with a hint |
| an invalid leftover | an invalid chip | an invalid chip |
| To empty after the rules (all mine) | From (or my own address when answering myself with nobody else) | |
| hundreds of recipients | linear (Sets), at most 1,000 per field (§2.8) | |

**Reply-To storage is plan 27's** (see "Reconciliation with plan 27" at the end). Its pieces:
- SQL v15 `reply_to_json TEXT NOT NULL DEFAULT '[]'`;
- IDB version 5;
- `IncomingMessage.replyTo?`: absent means not known and never erases a stored value;
- `MessageDetail.replyTo`.

Messages stored before v15 read `[]`, so replying to them uses From. A message ingested again fills its Reply-To in.

**Out of scope:**
- **Mail-Followup-To / Mail-Reply-To** (mutt's, rarely sent by anything else).
- **List-Post** ("reply to list"), its own feature.

### 3.5 Outgoing (what we write must parse everywhere)

- `formatAddress` quotes any name containing an RFC 5322 special, `.` included ("John Q. Public" becomes `"John Q. Public"`). It drops control and bidi characters, and never writes CR or LF.
- **portable builder:**
  - non-ASCII names become RFC 2047 B-words of at most 75 characters each, split on UTF-8 character boundaries and separated by folding whitespace;
  - header lines are folded at 78 where a list allows;
  - a Unicode domain goes out as punycode (`URL` hostname, available in browser and node).
- **nodemailer (desktop):** the same addresses. Its own encoding is kept, and its output is tested.
- **contract:** `address.email` is validated with core `isValidEmail`, not zod's `email()`. Zod's rejects RFC-valid local parts (`o'brien` passes; `a!b`, `a/b`, `a=b` don't) and IDN domains, so a send would fail with a validation error the user can't act on.
  - `isValidEmail` becomes a real check: a dot-atom local part of atext, ≤ 64 characters; a domain of ≥ 2 labels (letters, digits, `-`, `_`, Unicode letters), ≤ 253 characters; no IP literals or quoted local parts. Those are shown as invalid, with the reason.
- **Round-trip tests:** `parseAddressHeader(format(x))` equals `x` for nasty names (quotes, commas, `@`, `<>`, dots, accents, CJK, emoji, a 200-character name, RTL text), through both builders and back through `parseRaw`.

### 3.6 The scenario catalog (each one a test row)

| # | input (header or stored value) | outcome | fixed at |
|---|---|---|---|
| 1 | `"=?utf-8?Q?Jos=C3=A9?=_David_Sucre_L.?= <david@sucre.net> , Luis Alberto Medina" <lmedina@sucre.net>` | José David Sucre L. <david@…>, Luis Alberto Medina <lmedina@…> | ingest |
| 2 | stored `{ name: "_David_Sucre_L.?= <david@sucre.net> , Luis Alberto Medina", email: "lmedina@sucre.net" }` (the user's exact value) | David Sucre L. <david@…>, Luis Alberto Medina <lmedina@…> | read, reply |
| 3 | `=?UTF-8?Q?Ana_<ana@x.com>?= <real@x.com>` in From | From real@x.com, name "Ana <ana@x.com>" (shown as is, never the address) | ingest |
| 4 | `=?UTF-8?Q?Jos=C3=A9_P=C3=A9rez <jp@x>` (no `?=`) | José Pérez | ingest, read |
| 5 | adjacent encoded words, UTF-8 split between them, mixed Q/B | joined, correct | ingest |
| 6 | windows-1252, iso-8859-1, gb2312, ks_c_5601-1987, unknown charset | decoded, or UTF-8 then Latin-1 | ingest |
| 7 | RFC 2231 `=?UTF-8*es?Q?…?=` | decoded | ingest |
| 8 | encoded word inside quotes | decoded | ingest |
| 9 | raw 8-bit UTF-8 / Latin-1 in the header | as postal-mime decodes the header | ingest |
| 10 | mojibake `JosÃ© PÃ©rez` | José Pérez | ingest, read |
| 11 | `"Medina, Luis" <l@x>` | one recipient | — (holds) |
| 12 | unbalanced `"Unbalanced <u@x.com>, b@x.com` | u@x.com (Unbalanced), b@x.com | ingest; stored junk at read |
| 13 | smart quotes `“Ana” <a@x>`, Outlook `'Ana Torres' <a@x>` | Ana / Ana Torres | ingest, read |
| 14 | escaped quotes `"Esc \"q\"" <e@x>` | Esc "q" | — (holds) |
| 15 | `"a@x.com" <a@x.com>`, `'A@X.COM' <a@x.com>` | a@x.com shown once | ingest, read |
| 16 | `"leak@attacker.example, Support" <support@…>` | one recipient, name kept | — (holds) |
| 17 | `undisclosed-recipients:;` | nobody | ingest |
| 18 | `Team: a@x, b@y;, c@z` | a, b, c | ingest |
| 19 | `(Jane Doe) jane@x`, `jane@x (Jane)` | Jane Doe / Jane | ingest |
| 20 | `<@relay:user@x>` | user@x | ingest |
| 21 | `Ana Torres ana@x.com` (no brackets) | Ana Torres <ana@x.com> | ingest, typed |
| 22 | `<<a@x>>`, `<mailto:a@x>`, `mailto:a@x` | a@x | ingest, typed, read |
| 23 | `Outlook User [mailto:ol@x] <ol@x>` | Outlook User <ol@x> | ingest |
| 24 | folded header, tabs, newlines | one line, correct | ingest |
| 25 | `<a@x.com.>` | a@x.com | ingest, read |
| 26 | `B <B@X.COM>` beside `b@x.com` | once (case-insensitive) | reply |
| 27 | `user@bücher.de` | kept for display; sent as `user@xn--bcher-kva.de` | outgoing |
| 28 | `"\u{202E}gnp.exe" <b@x>`, zero-width spaces | controls stripped | ingest, read |
| 29 | duplicate Cc headers | both read | ingest |
| 30 | 2,000 recipients in one header | linear (benchmark) | — |
| 31 | an address that can't be repaired (`foo bar`) | an invalid chip, Send explains | reply, send |
| 32 | Reply-To list / several / mine | §3.4 table | reply |
| 33 | my own sent message, my alias, `me+tag@`, Gmail dots | §3.4 | reply |
| 34 | a no-reply sender | kept, with a hint | UI |
| 35 | `Name <a@x>` where the name is 2 KB | capped at 256 | ingest, read |

## 4. Strings (en and es together)

```
compose.recipients.list          "{field} recipients"                  / "Destinatarios en {field}"
compose.recipients.invalid       "Not a valid email address"           / "No es una dirección de correo válida"
compose.recipients.noReply       "This address may not accept replies" / "Es posible que esta dirección no acepte respuestas"
compose.recipients.removeHint    "Press Delete to remove"              / "Pulsa Suprimir para quitarlo"
compose.recipients.removed       "Removed {name}" / "Quitado: {name}"
compose.recipients.removedMany   "Removed {count} recipients" / "Quitados {count} destinatarios"
compose.recipients.restored      "Restored {count, plural, …}"  (catalog style as the others)
compose.recipients.more          "and {count} more"                    / "y {count} más"
compose.recipients.summary       "{names} and {count} more"            / "{names} y {count} más"
compose.recipients.showAll       "Show all {count} recipients"         / "Mostrar los {count} destinatarios"
compose.invalidRecipient         "“{entry}” isn’t an email address. Fix or remove it, then send." / …
compose.noRecipient              "Add a recipient to send"             / "Añade un destinatario para enviar"
```

## 5. Tests

- **core** (`address.test.ts`, table-driven):
  - every catalog row;
  - `repairAddresses` is idempotent on every row;
  - the format→parse round trip for nasty names;
  - `isValidEmail` accepts and refuses the right things;
  - the encoded-word decoder (charsets, splits, orphans).
- **core perf** (`address.perf.test.ts`): 5,000 nasty headers parse and repair in ≤ 150 ms; one 2,000-recipient header scales linearly (8× the input ≤ 12× the time); the fast path on clean addresses costs ≤ 0.5 µs each.
- **mail:**
  - `parseRaw` with the raw headers: the user's case, the spoof, duplicate headers, Reply-To;
  - the IMAP envelope mapping (pure function, exported);
  - both builders round-trip nasty names and long non-ASCII names (every encoded word ≤ 75), and send IDN as punycode.
- **store conformance:** the thread detail repairs a stored mangled row (row 2), in every store. Reply-To storage is plan 27's conformance.
- **db migrations:** plan 27's v15; this plan adds none.
- **web lib:**
  - `autoRecipients` for every §3.4 row;
  - `deriveChips`/`serialize` round trips, commits, edits and undo snapshots (pure);
  - `convertFields` unchanged.
- **e2e** (`apps/web/e2e/recipients.spec.ts`, `@design`):
  - typing and the commit keys;
  - Backspace selects then deletes, and a held Backspace stops;
  - arrows, Home/End, ⌘A, ⌘C/⌘X/⌘V, edit by Enter and double-click, × by mouse;
  - undo and redo, with the Edit menu path through `beforeinput`;
  - paste of a list;
  - blur commits; invalid chips and Send's message; the no-reply hint;
  - 200 recipients collapse and expand, with 0 chip renders per keystroke;
  - suggestions still work;
  - the single-key shortcuts don't fire on a focused chip;
  - a reload keeps typed text;
  - axe in light and dark, with screenshots.
- **e2e reply-all:** a message ingested through `parseRaw` with the user's exact header, and one stored with the user's exact mangled value, give two clean chips. Reply-To is honoured. Mine are excluded (the account, an alias From in the thread, `+tag`).
- **Existing specs** asserting `compose-to` text values move to chips. The chips carry `data-testid=recipient-chip` and `data-email`.
- **UI perf** (`autocomplete-perf.spec.ts`): plan 18's recipient gate unchanged, and a new 200-chip keystroke gate.
- **Desktop smoke:** `packaged.smoke.ts`'s recipient flow on chips.

## 6. Performance and resources

- The repair's fast path is one regex test per name and per address. Thread detail reads hold (`pnpm test:perf`).
- Ingest parses only the five address headers, linearly. It replaces postal-mime's address work on that path rather than adding to it.
- No new timers or network. The chips field does nothing until focused.
- The undo history is bounded at 100 steps per field, and dropped when the field unmounts.

## 7. Implementation order (atomic commits)

1. The plan.
2. core: tokenizer, encoded words, `parseAddressHeader`, `repairAddresses`, `isValidEmail`, `formatAddress`, and their tests and perf.
3. mail: `parseRaw` and IMAP use them, Reply-To ingested, outgoing fixes, tests.
4. store: read-time repair in both thread details and the list's From name (Reply-To storage: plan 27).
5. contract: the validator, and limits of 1,000.
6. web: `autoRecipients` semantics and tests.
7. web: the chip model (pure), then the component, keyboard, undo, the collapsed summary, Send's message, strings.
8. e2e, the perf gate, screenshots, baselines.

## Revisions after the Codex review

Codex (`codex exec -s read-only`) made 12 points against the plan and the code. All of them are taken, three of them narrowed as explained.

1. **Recovery could turn display-name text into recipients.**
   - Recovery now needs a bracketed address *and* a separator outside any brackets: the swallowed-list signature. `"Support <leak@attacker.example>" <support@…>` is not split. Its name loses the bracketed part and nothing is added.
   - At ingest, a bracketed address that only appears **after decoding an encoded word** is never structure. It is removed from the name, so read-time repair later finds nothing to split. Only text the header literally carries can be recovered.
   - The user's case is literal: the address sits in a correctly quoted string. So the request stands, and the narrowed rule still recovers david.
   - **Why it stays automatic rather than an explicit action:**
     - recovery is limited to To/Cc/Bcc, never From or Reply-To (the reconciliation review);
     - every recovered address is one the sender could have listed in Cc directly;
     - the reader shows it as its own recipient after the read-time repair, so what reply-all adds is what the reader shows;
     - it appears as its own chip before anything is sent.
2. **Invalid chips must round-trip losslessly.**
   - An invalid entry is written as it was typed when that reparses to exactly one entry. Otherwise it becomes one quoted string, so `"a@x.com, b@x.com"` stays one invalid entry and never two valid ones.
   - `formatAddress` quotes an "address" that contains whitespace or specials instead of stripping them, so draft save → reload never makes something sendable that wasn't.
   - Tested through autosave, reload and Send.
3. **IMAP gets the same structural parser.** The fetch asks for the raw From, Sender, To, Cc, Bcc and Reply-To header fields (every occurrence, 8-bit read as UTF-8 then Latin-1). They are parsed with `parseAddressHeader`; the envelope is the fallback when a header is missing.
   - **Legacy limit:** a From already stored wrong by an earlier ingest can only be cleaned (name), not re-derived. This is stated here, and the tests use raw-versus-envelope fixtures.
4. **One answered message.** `answered(detail, mine)` is resolved once and used by the recipients, the quote, `inReplyToMessageId` and the reader's "Reply to …" bar (`reader.tsx` `replyTo`). Test: the newest message is from my alias but not marked sent.
5. **Re-ingest fills Reply-To.** `updateExisting` (SQL) and the IDB upsert set `reply_to_json` when the incoming message carries it (`replyTo` present, even an empty `[]` = "parsed, none"). `undefined` (a producer that doesn't know) never erases it. The conformance suite ingests the same provider id twice.
6. **One recipient limit.** `MAX_RECIPIENTS = 1000` per field, in core, is used by the contract (drafts, send) and by draft import/export (`backend/import.ts`). Tested with a 250-recipient draft that exports, imports and keeps its body.
   - **Older versions** importing such an export refuse that draft, as they refuse any over-limit draft today. This is noted, not solved.
7. **Recovery runs before the 256-character cap.** The cap applies to each resulting name. Test: a swallowed recipient after character 256.
8. **Paste keeps invalid entries.** `pastedAddresses` no longer filters by validity: `ana@x.com; bob@` makes two chips, Bob's invalid, and dedupe applies to valid ones only. Tested with mixed pastes, replacing a selection, undo and reload.
9. **Ownership of auto recipients.**
   - The field reports the addresses the *user* put in with each change: typed, accepted, pasted, edited or re-added. `DraftFieldsForm` drops those from `auto[field]`, so an edited or deliberately re-added recipient survives a conversion to Forward.
   - Undo restores the text; the address stays user-authored, which is harmless.
   - Tested with the conversion and with save/reload.
10. **Exclusions beyond 600.** Suggestions are filtered on the client against every address in the three fields (a Set) before they show. The request still sends at most 600, the contract's cap. Test: a delayed answer with more than 600 recipients in the draft.
11. **The other readers of stored addresses:**
    - the thread list's From name (both stores' `toSummary`) gets `cleanName` behind the same fast path (one regex test per row);
    - the contact index cleans names when it learns them (`cleanName`), and its snapshot format version is bumped so old snapshots rebuild;
    - plan 17's people facts use addresses only (lowercased keys), so they are unchanged.
12. **postal-mime still parses addresses.** Our parse is a second pass over five short headers; it doesn't replace postal-mime's. The claim is corrected. `parseRaw` is benchmarked whole: a message with a 2,000-recipient Cc and nasty names stays within its budget.

## Implementation notes (what differs from the plan above)

- **The ×** shows on the **selected** chip only, not on hover. With the × hidden but holding its space, chips looked lopsided at rest. Showing it on hover shifted every following chip under a moving pointer. A click selects (the chip turns the accent) and the × removes; Delete/Backspace do the same from the keyboard.
- **An invalid chip** keeps the foreground text on the chip's fill. Its mark is a dotted destructive underline and a small alert glyph. `destructive-ink` on `muted` failed AA in four palettes (4.39–4.47, and Monokai 3.83). The mark is a UI pair instead: `ui("destructive", ["muted"])` (3:1), added to `CONTRAST_PAIRS`, and the contrast suite passes in every theme.
- **Editing a chip** turns it back into text in the input, which stays after the chips. The commit puts the chip back in its original place. Rendering the input in the middle of the chips would have put a combobox inside the chips' listbox (invalid ARIA).
- **Removing a chip** returns focus to the input with the caret at its start, so the next Backspace selects the next chip back. Apple Mail does the same.
- **⌘V on a chip** moves focus to the input, and the paste lands there (a list becomes chips). The selected chips stay.
- **"and N more"** is named by what it says (axe's `label-content-name-mismatch`). "Show all N recipients" is its description.
- **The Edit menu's Undo/Redo** reach the field as native `beforeinput` (`historyUndo`/`historyRedo`). React's `onBeforeInput` is a text-input polyfill that never sees them, so a native listener handles them.
- **Send's messages** replace "Check the recipients": "“bob@” isn’t an email address. Fix or remove it, then send." and "Add a recipient to send". Focus goes to the first invalid chip, through a DOM event on the field (`SELECT_INVALID`).
- **The thread list's From name** and the contact index's names are cleaned at read time (`cleanFromName`), behind the same fast path: one regex test per row.
- **Reply-To from an IMAP envelope** without the raw field is dropped when it equals From (RFC 3501 fills it in from From).
- **Lowercasing at ingest** is kept: the whole store keys on lowercased addresses (people facts, autocomplete, `from_email`). Typed recipients keep their case; dedupe is case-insensitive.
- **Invisible characters** (bidi controls, zero-width spaces) are written as `\u{…}` escapes in source, with the `u` flag on the regex, never as literal characters (Trojan Source).

## What the Codex code review changed

Codex (`codex exec -s read-only`, the review prompt over the branch from its base) made seven findings. All were fixed, each with a regression test that was run against the unfixed code and failed there (commit "fix(addresses, chips): what the Codex code review found").

1. **High: an encoded word could still spoof From.** With a literal `<` inside Q text, `=?UTF-8?Q?Ana_<ana@x.com>?= <real@x.com>` gave `ana@x.com`. Both tokenizers (`scanList`, `tokens`) now treat a complete encoded word as one opaque word: its brackets, `@` and commas are text. Test: core "code review 1".
2. **High: recovery beside a literal address.** A name holding a literal `<…>` let addresses decoded from an encoded word in the same name be recovered. Decoding now neutralizes every decoded chunk (`decodeEncodedWords(text, show)`: no bracketed address, no bracket), so recovery only uses what the header holds literally. Test: core "code review 2".
3. **High: an invalid chip could become a different, sendable one.** `a:b@x.com` serialized plainly reparsed as group `a:` plus a valid `b@x.com`. `formatAddress` now writes an invalid entry plainly only when it parses back as itself; otherwise it writes one quoted entry. Test: core "code review 3" (`a:b@x.com`, `mailto:`, `Team:;`).
4. **Medium: a comment-only typed entry vanished.** `(bob@x.com)` produced no chip. A typed part that yields nothing is now kept as an entry to fix. Test: core "code review 4".
5. **Medium: repeated IMAP header lines were quadratic.** `headerFields` copied the array per line (32,000 Cc lines took 1.5 s). They are now appended in place. Gate: `addresses.perf.test.ts`, 32,000 lines ≤ 16× the cost of 4,000.
6. **Medium: Undo left stale suggestions acceptable.** Undo, redo and an external value change now close the list and drop answers still in flight. Test: autocomplete.spec "undo takes the suggestions…".
7. **Medium: Tab into a collapsed field lost focus.** The "and N more" button moved focus to the input on focus, before the expanded field removed it. Test: recipients.spec, 200 recipients, From → Tab.

Codex also saw the string-scaling gate fail once under load (12.46× against 12×). Linear is about 8× and quadratic 64×, so the bound is now 16×.

## Reconciliation with plan 27 (Reply-To)

Plan 27 landed Reply-To on main (185cb94, 3f83a8a, 24bf111) while this branch carried its own version. The branch was rebased onto main. There is one implementation, plan 27's, and this plan adds only what plan 27 doesn't have: the chips, the lenient parser and its repair on read, the reply-all rules beyond plan 27's, and the security fix.

| piece | plan 27 (kept) | this branch, after reconciliation |
|---|---|---|
| SQL migration | v15 `reply_to_json TEXT NOT NULL DEFAULT '[]'` | this branch's own v15 (a nullable column) is dropped. No migration is added. |
| IDB schema | version 5, `reply_to_json` defaulted on read | no bump of its own |
| fields | `IncomingMessage.replyTo?` (absent: unknown), `MessageDetail.replyTo` (required) | the same fields. This branch's duplicate optional `MessageDetail.replyTo?` is gone. |
| ingest and re-ingest | insert `msg.replyTo ?? []`; `updateExisting` replaces the stored value when a message carries one and keeps it when not | unchanged, which already covers "re-ingest fills a missing Reply-To". This branch's duplicate conformance test was removed (plan 27's "retains Reply-To through ingest, refresh and reopen" covers it). |
| Gmail raw (`parseRaw`) | `replyTo` from postal-mime | the same field, now fed by `parseAddressHeader` over the raw header values (the parser and the Mailsploit fix). Plan 27's `mime.test.ts` Reply-To case passes unchanged. |
| IMAP | `replyTo` from the envelope | the same field, fed by the raw `Reply-To` field through our parser. Without a raw field, the envelope's Reply-To is dropped when it equals From (RFC 3501 fills it in from From). Plan 27's `imap.int.test.ts` case passes. |
| reading | `replyTo: JSON.parse(reply_to_json)` | `storedAddresses()` reads plan 27's column and also repairs Reply-To, To, Cc and the From name |
| replying | `autoRecipients`: Reply-To else From; dedupe; never me | replaced by this branch's version: identities (every account, sent Froms in the thread, `+tag`, Gmail dots), one answered message for recipients, quote and threading, and repair. Plan 27's eleven `compose-fields.test.ts` cases pass unchanged. |
| a Reply-To naming only me | To left empty | **plan 27's rule is kept.** This branch first fell back to From, and briefly changed plan 27's test to say so. Plan 27 covers the case with its own test, and the instruction is to keep plan 27's version where it already decides, so that change was reverted. `reply-all.test.ts` now expects To empty there, with the others in Cc for reply-all. |
| e2e | `reply-to.spec.ts` | the same flows. Only its two field assertions read chips now (the fields are chips). This branch's own Reply-To e2e was removed as a duplicate. |
| people smoke | its v13 fixture didn't know v15 | the fixture drops `reply_to_json` and expects v15. Without this, the smoke fails on main too. |

### What the Codex review of the reconciliation changed

Codex reviewed the reconciled diff, scoped to the Reply-To pieces and the areas they touch, and made three findings. All three were fixed, each with regression tests in core, in mail and in the conformance suite of every store.

1. **P1: a stored or raw Reply-To could gain a destination.** Read-time repair split `"Support <audit@thirdparty.test>, Helpdesk" <session@…>` into two. That address list is where a *plain reply* goes, so the swallowed-list recovery no longer applies to it. Reply-To is never split, whether at ingest (`parseAddressHeader(…, { split: false })`), at read (`storedAddresses`) or at reply time (`autoRecipients`). To, Cc and Bcc keep the recovery, which the user's report needs.
2. **P1: repair could change a valid address.** `'support@example.com` lost its apostrophe, which redirected replies. An address valid as stored is now kept exactly, and only a matching pair of quotes counts as wrapping.
3. **P2: the IMAP envelope fallback dropped a real Reply-To member.** A list containing From lost that member. Without the raw field, only a Reply-To that is exactly From is now dropped. A list that includes From stays whole.

### Suites after the reconciliation (based on main `32de1e9`, load average 6–115)

Every failure below was checked against the same main commit in a separate checkout.

| suite | result |
|---|---|
| `typecheck`, `lint` | pass |
| `pnpm test` | 2,911 passed, 9 failed. All nine fail identically on main `32de1e9`: `db/migrations.test.ts` (v12 drafts, legacy IDB upgrades), `idb/idb.store.test.ts` (plan 27's "version 4 messages default Reply-To", AbortError), `backend/icons/google.test.ts`. They are main's, outside this branch. Earlier timing-only failures (`ops-scale`, IDB `-factura` search timeouts, slice budgets at load 68) passed on an isolated rerun. |
| `test:e2e` | 937 passed, 6 failed. Each is classified below. |
| `test:web` | 31 passed |
| `test:ui-perf` | 57 passed. The 200-chip gate: p95 15 ms. |
| `test:perf` | 140 passed, 5 failed. On main as well: `db/ingest.perf` (0.90–0.93× there, 0.91–0.92× here), the phrase build (34.8 µs there), and `load.perf` "a disk that turns slow mid-job". `categorize.perf` passed 2 of 2 in isolation; main also failed it once at that load. |

The six e2e failures:
- **On main too:** `reader.spec.ts:65` "attachments are view-only tiles" (plan 29 added download controls).
- **Flaky on main too:** `resign-in.spec.ts:126`. Interleaved runs failed 2 of 8 on main and 4 of 8 here. It is a sign-in popover focus race; nothing in this branch touches it.
- **Flaky:** `autocomplete.spec.ts:341` (Atelier ghost text) passed 3 of 3 on rerun.
- **Baseline updated:** `visual.spec` "inline reply" shows the recipient as a chip beside plan 29's attach button. I looked at it.

## Suite results (this machine, load average 9–50, other agents running)

| suite | result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | 2,530 passed, 1 failed, 2 skipped. The failure is `idb/ops-scale.test.ts` "a parked bulk archive…" (a 10 ms budget). It has nothing to do with this feature, fails only in the full parallel run under load, and passes alone (3 of 4 runs). |
| `pnpm test:e2e` (all three designs) | 925 passed |
| `pnpm test:web` | 31 passed |
| `pnpm test:ui-perf` | 20 passed, 2 failed under load: the 10 MB paired ghost gate (plan 18's timing-sensitive gate) and the longest frame of "j at key repeat (macos, compact)". Both passed on rerun. The new 200-chip gate passed: p95 14 ms. |
| `pnpm test:perf` | 141 passed, 1 failed under load: the phrase build CPU (32.2 against 31 µs, not touched here). It passed on rerun. The new address gates passed: 5,000 nasty headers in 30 ms; 0.2 µs for each clean address; linear scaling. |
| `pnpm dist:mac` + `test:smoke` | 51 passed and 1 failed. The failing people smoke's v13 fixture kept v15's new column; the fixture was fixed and that smoke then passed. |

## Screenshots

`/tmp/unica-scratch/chips-26/shots/` holds, for each of `macos`, `lumen` and `atelier` in `light` and `dark`:
- `chips-<design>-<theme>.png`: a few chips, a no-reply chip selected, an invalid one;
- `collapsed-<design>-<theme>.png`: a long list, unfocused;
- `wrapped-<design>-<theme>.png`: the same list focused, wrapping.

The changed baselines are the inline reply in all three designs (`design-reply.png`), where the recipient is now a chip.
