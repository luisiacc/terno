# 39 · Live autolinks in the composer

## Request (verbatim)

> there is a bug on the composer for links, if i type `https://santo.com` then delete  `.com` and it becomes 'https://santoqwe.com', only the 'https://santo' stays highlighted as a link, lets fix this, also explore multiple variations and edge cases around this automatic link we create when the user writes and make it bulletproof and performant.

## What exists

- `apps/web/src/components/composer/editor.ts` (plan 16 §6): `linkTypedUrl()` adds a link mark to a URL just typed, from an `InputRule` on whitespace (`autolink`) and from Enter (`withAutolink`). It looks back 500 characters with `/(?:^|\s)((?:https?:\/\/|www\.)\S+)$/`, trims `[.,;:!?)\]]+` at the end and validates with `urlIn`. Links aren't inclusive (`inclusive: false`), so typing right after a link goes outside it.
- `packages/richtext/src/links.ts`: `isSafeHref` (http, https, mailto only), `normalizeHref` (the link dialog), `urlIn` (a whole string that is an http(s) or `www.` URL).
- `packages/richtext/src/schema.ts`: `link` has one attribute, `href`. `html.ts` writes `<a href>`, `parse.ts` reads it back (the draft's storage is the mail HTML), `text.ts` writes "text (url)" or the URL alone.
- The quoted history isn't in the editor: it is `quotedText`, shown read-only and linked by `quote.ts` (`URL_RE`) when sent.

### The bug

Once "https://santo.com" is linked its mark keeps `href: "https://santo.com"` whatever happens to the text:

1. Delete ".com": the link shows "https://santo" but still points to santo.com. A **stale href** is a deceptive link in mail, sent as is in both the HTML and the plain-text part ("https://santo (https://santo.com)").
2. Type "qwe.com" after it: the text goes outside the non-inclusive mark and nothing relinks it.

Other defects found reading the code:

- A typed NBSP (⌥Space) after a URL goes in raw: the autolink rule inserts `match[0]`, bypassing the NBSP-to-space handler.
- URLs longer than 500 characters never link (the lookback).
- `(https://x.com)`, `<https://x.com>` and `"https://x.com"` don't link (the regex wants whitespace before the scheme), and `https://en.wikipedia.org/wiki/Foo_(bar)` loses its `)`.
- ⇧Enter (a line break) doesn't link the URL before it.
- Applying a manual link over part of a link leaves the rest of the old link with its href.
- A pasted plain text with URLs in it links nothing (only a URL pasted alone does).

## Design

### Auto and manual links

The link mark gets a second attribute, **`auto`** (default `false`). An auto link is one whose text spells its href: Terno made it from what was typed or pasted. Its invariant:

> **An auto link's href is always the URL its text spells.** When the text changes, the href follows; when the text no longer spells a URL, the link goes.

A manual link (the link dialog with other text, a pasted `<a>` with a label, a URL pasted over a selection) is never rewritten.

Why an attribute and not "text equals href" checked on the fly: after an edit the text no longer equals the href, so a comparison can't tell an auto link that needs updating from a manual link whose text is a different URL (`<a href=tracker>https://real.example</a>`). The attribute is set where the link is made, so the decision never depends on the edit.

What sets `auto: true`:

- the autolink (whitespace, Enter, ⇧Enter), a URL pasted alone, the URLs in a pasted plain text;
- `applyLink` (the dialog) when the final text spells the href exactly (`www.x.com` → `https://www.x.com`, `ana@x.com` → `mailto:ana@x.com`), so a link made in the dialog and one typed behave the same, and save/reopen gives the same document;
- parsing: `<a href=H>T</a>` is auto when T spells H. The stored draft is mail HTML, which carries only `href` (plan 16 §3), so the attribute is derived on reopen; the rule above makes `parseHtml(toEmailHtml(doc))` the same document.
- The editor's DOM and Terno's copies say which kind a link is: `data-rt-auto` or `data-rt-manual` on the `<a>` (`toDOM`; never the mail HTML). Parsing reads them back as drawn, so a link ProseMirror re-reads from the DOM while it is edited is the mark it drew (see Implementation notes). What a copy carries is made honest before it leaves (`transformCopied`: a partial copy of "https://santo.com" as "https://santo.co" links to santo.co), and a pasted autolink whose href its text doesn't spell is put right by the live links like any edit. A foreign `data-rt-auto` can only make a link follow its text, never point elsewhere, so the attribute is kept on any paste.

### One scanner (`links.ts`, pure)

`linkIn(token)` finds the link in a **token**, a run of text between delimiters, and returns `{ start, end, href }` or null. Delimiters: whitespace (NBSP included), a non-text leaf (a line break: U+FFFC in the text), `< > "` and the curly quotes `“ ” ‘ ’ « »`, and, in the editor, the edges of a manual link.

- **Start:** the first `http://`, `https://`, `www.` or `mailto:` (any case) at the token's start or after a character that can't precede a URL in a word. Letters, digits and `@ . / - + : # = & ? % $` block a start; `( [ { ' * _ ~ ¿ ¡` and other punctuation allow it. Without a scheme, a token that is an email address once its opening punctuation is off becomes `mailto:`.
- **End:** the token's end, then trailing `. , ; : ! ? …` trimmed; `)`, `]`, `}` trimmed only while unbalanced inside the URL (`…/Foo_(bar)` keeps its `)`, `(https://x.com)` loses it); `* _ ~ '` trimmed only when the same mark stands right before the URL (`_https://x.com/a_` loses it, `https://x.com/user_` keeps it).
- **Valid:** http(s) with a host that has a letter or digit (`isSafeHref`: `new URL` parses it, hostname not empty); `www.` followed by a dotted host (href `https://` + text); `mailto:` followed by an address; an address `local@domain.tld`. The href is the text as typed (uppercase schemes, IDN, punycode, ports, userinfo, IPv4, `[::1]`, localhost all link as typed, so the href always matches what the reader sees). At most `MAX_URL_LENGTH` (8,192) characters.
- **Never:** `javascript:`, `data:`, `file:`, `ftp:`, `vbscript:` (no allowed scheme starts them), bare hosts (`example.com`, `file.txt`, `node.js`: too many false positives; the link dialog still completes them).
- **Linear:** one pass with char-code checks; only anchored, non-nested regexes on fixed-length pieces. A hostile token (100 k of `.`, `(`, `www.www.…`, `a@a@a…`, `http://http://…`) is scanned in O(n), and only the first candidate start is validated.

`spelledHref(text)` is the href when the whole text is one link (`linkIn(text)` spans it), else null. `urlIn` stays for paste-a-URL (whole string) and becomes `spelledHref` restricted to http(s) and `www.`.

### Creating a link (the triggers)

A URL becomes a link where the user ends the word, as in Docs, Gmail and Notion:

| Trigger | Links |
|---|---|
| Space, any typed whitespace (NBSP goes in as a space) | yes |
| Enter, ⇧Enter (line break) | yes |
| Tab | no: outside a list it leaves the editor, in a list it moves the item |
| Blur, moving the caret with arrows or the mouse | no (an unlinked URL at the end still reaches the recipient as text, and every mail client links it on display; nothing we send has a wrong href) |
| IME composition | no linking while composing (the input rules already skip it) |
| Paste a URL alone | yes (auto) |
| Paste plain text containing URLs (⌘V, text only) | each URL (auto) |
| ⇧⌘V | never (plain means plain) |
| Paste HTML | the HTML's own links only; bare URLs in it stay text. A URL alone in the plain text is linked by the paste-a-URL path only when the HTML has no link to anywhere else (a labelled or tracking `<a>` pastes as copied) |

`linkTypedUrl(state, end, tr)` reads the word before `end` (back to whitespace or a link's edge, at most `MAX_URL_LENGTH` + 1 characters), splits it into tokens at quotes and angle brackets, and links what each spells (`linksIn`) unless it is in fixed-width text (`font: mono`, the composer's code). Enter and ⇧Enter link and break the line in one transaction (one undo step, as a space's link is).

### Keeping auto links live (`liveLinks` plugin, `appendTransaction`)

For each transaction that changed the document, the plugin collects the **changed ranges**: every replace step's mapped range, plus the range of any `AddMarkStep`/`RemoveMarkStep` of the link type (a manual link applied over part of an auto link). Ranges are mapped to the final document and merged. For each textblock a range touches:

1. **Fast path:** look at the textblock's children within `MAX_URL_LENGTH` of the range. No link there → nothing to do. This is the cost per keystroke almost always: one walk over the line's children (ProseMirror's own position lookups already walk them), never the document, no text read.
2. **Promotion:** a manual link the change touches whose text now spells its own href becomes an autolink: what reopening the draft would make of it (the mail HTML can't carry the attribute), so a session and a reopen behave the same.
3. **Tokens:** expand the range to token boundaries (delimiters, manual link edges), and further to cover any auto link run it meets, within a window of `MAX_URL_LENGTH` + 1 characters each side (`textBetween` with U+FFFC for leaves). A token longer than the window spells nothing.
4. **Desired links:** each token that contained auto-link text gets the link `linkIn` finds in it now when that link covers the autolink text; failing that, each autolink part in it that still spells a URL keeps a link to that URL ("a" typed right before "https://x.com" leaves the link alone), and the rest is unlinked. A token without auto-link text is left alone: plain text never links without a trigger.
5. **Apply only differences:** compare the desired runs with the auto runs there now (same range and href → nothing). Otherwise remove those auto marks and add the desired ones. The plugin's own transaction then changes nothing on its next pass, so `appendTransaction` converges in one round.

Consequences:

- Extending: "https://santo" + "q" typed right after it → the token "https://santoq" contained auto-link text → the link covers it, href `https://santoq`.
- A space typed after the link ends the token: what follows isn't linked.
- Typing inside the link (the mark is inherited there), deleting, replacing a selection: the href follows.
- The appended transaction joins the user's history event (prosemirror-history groups appended transactions), so undo and redo restore text and href together. An undo or redo is itself a change, reconciled the same way.

**IME composition.** Changing marks around the text being composed would end the composition (ProseMirror redraws the node). A transaction carrying `composition` meta (ProseMirror marks those; the NBSP handler copies it from ProseMirror's default transaction) is not reconciled; its ranges accumulate in the plugin's state, mapped through later transactions, with the composition's id. Once the composition is over (the plugin view's next update with `view.composing` false, and a one-shot check after `compositionend`, since ProseMirror may end one without dispatching), they are reconciled in a transaction carrying the composition's id: prosemirror-history groups it with the composition, so undoing the composition puts back a link the reconciliation removed.

### What is sent

`toEmailHtml` and `toPlainText` write an auto link with the href its text spells, and an auto link that spells nothing as plain text. The plugin keeps the document right; this makes a stale href impossible in a sent mail whatever the editor's state (a composition finishing as Send is pressed). The plain text writes a link whose text spells its href as the text alone (`www.x.com`, not `www.x.com (https://www.x.com)`).

### Around other content

- Bold, italic or a color on the URL: kept, the link is added over them.
- A manual link is its own unit: its edges are delimiters, so an auto link next to it is never extended into it, and a manual link never becomes part of an auto link.
- List items and quotes: textblocks like any other.
- Fixed-width text (the composer's code): no new autolinks.
- The quoted history: outside the editor, unchanged.
- Two URLs with nothing between them are one token: one link to what the text spells (`https://a.comhttps://b.com` is a valid URL). Whitespace or `<>` between them: two links.

## Behaviour table

| Variation | Result |
|---|---|
| "https://santo.com " then delete ".com" | link "https://santo" → `https://santo` |
| … then type "qwe.com" | one link "https://santoqwe.com" → `https://santoqwe.com` |
| type inside ("exa" + "X" + "mple") | href follows |
| delete "s" of https | `http://santo.com` |
| delete the whole scheme | "santo.com" spells nothing: unlinked |
| delete the scheme of `https://www.x.com` (selected) | `https://www.x.com` (the www. form); backspaced one character at a time it passes through "https:/www…", which spells nothing, and the link goes |
| backspace through the link | gone; nothing left over |
| select "santo" and type "x" | `https://x.com` |
| space typed inside | the left part keeps a link if it is still a URL; the right part is plain |
| a letter or a bracket typed right before it ("ahttps://…", "(https://…") | the link stays as it was, the letter outside |
| undo / redo of each | text and href restored together, exactly |
| `https://x.com.` `,` `;` `:` `!` `?` `…` | the punctuation stays outside |
| `'https://x.com'` `*https://x.com*` `_https://x.com/a_` | the URL only (the mark closes one before it) |
| `https://x.com/user_` `https://x.com/a'` | the whole URL (nothing opened before it) |
| `https://en.wikipedia.org/wiki/Foo_(bar)` | whole URL, `)` included |
| `(https://x.com)` `<https://x.com>` `"https://x.com"` `“https://x.com”` | the URL only |
| `www.x.com` | `https://www.x.com` |
| query, fragment, port, userinfo, IDN, punycode, IPv4, `[::1]`, localhost | linked as typed |
| `example.com` (bare) | not linked |
| `ana@x.com` | `mailto:ana@x.com` |
| `mailto:ana@x.com` | as typed |
| `HTTPS://X.COM` | linked, href as typed |
| a 600- or 8,000-character URL | linked; past 8,192: not linked |
| `javascript:…` `data:…` `file:…` `ftp:…` | never |
| a URL in fixed-width text | not linked |
| a URL right after a manual link (no space) | linked on its own; the manual link unchanged |
| a manual link applied over part of an auto link | the manual link; the auto leftovers relinked by what they spell, or removed |
| pasted "see https://a.com and www.b.com" | two auto links |
| ⇧⌘V of the same | plain text |
| partial copy of an auto link pasted | a link to what the copied text spells (or none) |

## Tests

- **Unit, `@terno/richtext`** (`links.test.ts`): the scanner on every row of the table above (start, end, trimming, balance, validity, kinds of URL, emails, schemes refused, length cap); `spelledHref`; linear time on hostile tokens (100 k of `.`, `(`, `)`, `www.`, `a@`, `http://`) under a fixed budget and scaling ~linearly (10× input ≤ 20× time); the parse rule (`auto` derived, `data-rt-auto` normalizing or dropping); round trip `parseHtml(toEmailHtml(doc))` with auto links (generated docs include them); `toEmailHtml`/`toPlainText` write the spelled href of an auto link even when its mark is stale, and a stale manual link as is.
- **Unit, editor** (`autolink.test.ts`, states without a DOM like `ghost.test.ts`): each editing variation, extension, undo/redo after each (the href equals what the text spells after every step), manual links untouched, mark steps over auto links, convergence (the appended transaction's own pass is empty), composition deferral and the pending flush, the triggers (space, NBSP, Enter, ⇧Enter), plain paste parsing with URLs, the fast path (no reconciliation work when no auto link is near: counted).
- **E2E** (`apps/web/e2e/composer.spec.ts`, `@design` for the visible link): the user's exact scenario (type "https://santo.com ", go back, delete ".com", type "qwe.com" → one `<a>` with text and href `https://santoqwe.com`); deleting the scheme; parentheses and angle brackets; undo/redo; ⇧Enter; paste of text with several URLs; an IME composition inside a link (CDP `Input.imeSetComposition`); the bubble shows the live href.
- **Send** (`composer-send.spec.ts`): edit an autolink after it was linked, send, the captured MIME's HTML and text parts carry the new href and never the old.
- **Perf** (`perf.spec.ts`): typing next to and inside an auto link in a 2 MB draft and in the 250 KB paragraph stays within the existing gates (`HUGE_MS`, `HUGE_FRAME_MS`), the drafts carrying auto links.
- **Screenshots:** a live-edited link in light and dark, macOS, Lumen and Atelier, under `/tmp/unica-scratch/autolink/`.

## Performance and resources

- Per keystroke: the fast path reads the children of one textblock near the caret; with an auto link near, one token of at most 8 k characters is scanned once. Nothing walks the document. Measured (test builds time the plugin, `window.__composer.links`): 0.4–0.5 ms p50 in a 2 MB draft with an autolink on every line, 1.3 ms p50 / 3 ms p95 on a paragraph of 30,000 formatted runs; gated at 4 ms.
- ProseMirror's view redraws a line's children whenever a mark in it changes (as ⌘B on a word does), and an autolink's href changes with each key typed in it. On an ordinary line that is nothing; on the 30,000-run paragraph it is ~7 ms over a plain key (gated: a key in the link within 25 ms of a plain key's p50). A custom link mark view that updates its attributes in place was tried: ProseMirror still marks the line changed and walks it, so it bought nothing and was left out.
- Paste and whole-document commands (indent everything) visit the changed textblocks once (linear, already the cost of the change itself).
- No timers; the composition flush is one microtask after a composition ends.
- Nothing new in the entry chunk: the scanner is in `links.ts`, already imported by `quote.ts`; the plugin lives in the lazy composer chunk.

## Out of scope

- Linking on blur, caret moves or send (see the trigger table).
- Bare domains and other schemes (tel:, sms:).
- Linking bare URLs inside pasted HTML.
- The quoted history's linker (`quote.ts`): unchanged in behaviour.

## Revisions after the Codex review

Codex (`codex exec -s read-only`, 11 points) against the plan and the code. What changed:

1. **Composition and undo.** Reconciling a composition's changes outside history couldn't put back a link it removed (undo restores the text, and with no autolink left nothing relinks). The flush now carries the composition's id and joins its undo step. Test: a composition that breaks a link, flushed, then one undo gives the exact document back.
2. **Enter was two undo steps** (the link, then the split, as separate root transactions). One transaction now: the key's command runs on the linked state and its steps follow the link's. ⇧Enter too. Test: one undo restores the document before Enter.
3. **A composition can end without a dispatch** (ProseMirror clears `composing` in `compositionend`; its later update is conditional). A one-shot check after `compositionend` flushes what is pending. E2E with a CDP composition and no edit after it.
4. **Edits during a composition that bypass ProseMirror's transaction** (the NBSP handler) weren't tagged. The handler copies the `composition` meta from ProseMirror's default transaction. Test.
5. **Partial copies left the app with the old href.** `transformCopied` writes every autolink in the slice with the href its text spells (or none), so the clipboard HTML is honest for any app. Tests on the slice and in e2e on the clipboard.
6. **A manual link edited until its text spells its href** was manual in the session and auto after reopening. Such a link is promoted when touched, so both behave the same. Test.
7. **Paste precedence.** The paste-a-URL path read `text/plain` even when the HTML had a labelled or tracking link, replacing it with a link to the text. It now steps aside when the HTML links anywhere other than the URL the text spells. E2E with both flavours.
8. **Run equality.** The plain text grouped links by href; it now groups by the whole mark (an autolink and a manual link to one place are two). A link containing a line break spells nothing, in parsing and serializing alike. Tests.
9. **Traversal.** A character window doesn't bound a walk over a line's children. ProseMirror's own position lookups (`resolve`, `findIndex`) and `Fragment.replaceChild` already walk them on every keystroke, so ours adds a constant factor; the fast path reads no text, and the perf suite gains a densely formatted 250 KB paragraph with an autolink near the end.
10. **Trailing `_ ~ * '` trimmed from whole URLs** (`https://x.com/user_` pasted lost its `_`). They come off only when the same mark opens before the URL. Tests.
11. **`normalizeHref`'s address regex was quadratic** ("a@" + "a." × n + ":": 380 ms at 32 k). Labels are dot-separated now (linear). The hostile-input suite covers it.

Also found by the tests while implementing: `<https://x.com>` and `"https://x.com"` typed then a space didn't link (the closing mark is a delimiter, so the token before the caret was empty). `linkTypedUrl` now takes the word back to whitespace and links each token in it. A link made in the dialog right after a word (`hola` + `www.x.com`) was removed at once (the token "holawww.x.com" spells nothing). Hence rule 4's fallback: an autolink whose own text still spells a URL keeps it.

## Implementation notes (what differs from the plan above)

- **Reading a link back from the DOM.** The first version derived an autolink's href from its text when parsing an `<a data-rt-auto>`. ProseMirror re-reads an edited range from the DOM: with the caret inside the `<a>` at its end (where a click at a link's end puts it), Backspace re-read the link with a new href, the re-read mark differed from the drawn one, and ProseMirror retyped the whole link through `insertText`, whose `marksAcross` drops a non-inclusive mark. The link vanished on the first key. Parsing now returns exactly the drawn mark (`data-rt-auto`, `data-rt-manual`); the e2e for the report places the caret that way.
- **A letter typed right before an autolink** leaves it linked (rule 4's fallback), instead of the plan's first "unlinked".
- **The e2e clock.** The e2e fixture freezes `Date.now`, so prosemirror-history never starts an undo step by time there; the undo/redo e2e runs with the real clock.

## What the Codex code review changed

Round 1 (`codex exec -s read-only`, review of `5a972a3..a2fc1a6`, 4 findings), each fixed with a regression test that fails without it:

1. **High: an autolink longer than the window looped forever.** The span's growth was flagged even when clamping to the window left it where it was. Growth now continues only while the bounds move, and a `data-rt-auto` link past the cap parses as manual (the editor never draws a longer one). Tests: typing near the start of a 20,000-character autolink ends and unlinks it; the parse test.
2. **High: a line of thousands of links reconciled quadratically** (every token filtered every run: ~2.5 s for 16,000 URLs). One cursor walks the runs with the tokens. Test: 4× the links costs under 9× the time (the quadratic version measured ~16×) and 8,000 links under 300 ms.
3. **Medium: a link right after a long unbroken word was removed** (the token was cut by the window, which also disabled the fallback). An autolink wholly inside the window is still read. Test: a dialog link after 9,000 letters stays, and follows an edit inside it.
4. **Low: the 30,000-run paragraph's gate had no tail.** A p95 gate relative to plain keys in the same line (an absolute `HUGE_MS` would gate ProseMirror's own plain keys there, 25–35 ms p95 measured on this machine).
