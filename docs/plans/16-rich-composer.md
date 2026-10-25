# Plan 16: the rich composer

- **Status:** in progress.
- **Builds on:** `2d97038` (main after plan 15).
- **Request (verbatim):** "have a nice, premium composer for drafting emails with similar features like gmail for including rich format to the emails like the picture and also the insert link feature, and make sure when they are send, that the format is actually applied and the final email looks good, have tests for this. this must be for all themes that we have, visually try this and make sure each option is intuitive and nice to use, like visually selecting text and clicking italic should make the selection italic, like almost all rich text composers."
- **The picture:** Gmail's formatting bar (undo, redo, font family "Sans Serif", text size, bold, italic, underline, text color, align, numbered list, bulleted list, indent less, indent more, quote, strikethrough, remove formatting) above its action row (Send, the "Aa" formatting toggle, attach, link, emoji, Drive, image, confidential, signature, more).

## 1. What exists

- **Two composers, one textarea each.** `inline-draft.tsx` (`DraftSlot`: reply, reply all, forward, inline under the conversation, on the design's draft surface) and `new-message.tsx` (`NewMessage`: a new message in the reader pane, Discard · title · Send on top). Both render `DraftFieldsForm` (From, To, Cc, Bcc, Subject), a `<textarea data-testid=compose-body>`, `SignaturePreview` and `SaveState`; the inline one also the folded `Quote` and an action row (Send ⌘↩, save state, Discard, Collapse).
- **Drafts** (`lib/drafts.ts`): one `LocalDraft` per key, `editDraft()` per keystroke bumps `localRev`, an autosave 800 ms after the last edit (≤ 5 s while typing), one save in flight, revisions from the server (`drafts.save` with `baseRevision`; a stale one becomes its own draft). `sendBody()` joins what was written, the account's plain-text signature (`-- ` line) and the quote (`quotedText`, kept apart from `bodyText` since drafts v2, folded in the inline draft).
- **Storage:** `drafts` table (SQL v9 shape; `packages/db/src/repos.ts` `saveDraft`, `listDrafts`) and the IndexedDB `drafts` store (IDB v3, `packages/idb`), same `DraftRow`. Export format 2 carries drafts whole (`ExportedDraft`), import re-creates them. MCP's `create_draft`/`send` pass `bodyText` only.
- **Sending:** `compose.send` (`bodyText` ≤ 5 MB) → `store.compose.queueSend` builds the `SendPayload` (`text` only), ingests an optimistic local copy (`bodyHtml: null`) and queues a durable `send` op. Desktop: IMAP accounts `sendViaSmtp` → `buildRaw` (nodemailer `MailComposer`), Gmail `buildRaw(keepBcc)`; web Gmail: `buildRawPortable` (hand-written single `text/plain` part).
- **Reader:** `m.bodyHtml` renders in the sandboxed, DOMPurify-cleaned `HtmlBody` iframe (themed unless the mail paints its own colors: then on paper); otherwise `TextBody`.
- **Keyboard:** one document-level handler (`lib/keyboard.ts`) that skips events already `defaultPrevented`; ⌘K opens the palette everywhere (also in editables), ⌘Z is the app's undo outside editables. The desktop Edit menu uses roles (undo, redo, paste and match style) that reach the page as `beforeinput`/paste events.
- **Tests:** `e2e/compose.spec.ts` (~40 uses of `compose-body` with `fill`/`toHaveValue`), `designs.spec.ts`, `visual.spec.ts`, `i18n.spec.ts`, `perf.spec.ts` ("typing in a draft with 2,000 drafts around"), web `web.spec.ts`/`updates.spec.ts`; `imap.int.test.ts` already runs nodemailer against an in-process `smtp-server`.

## 2. Editor choice

| | ProseMirror (bare) | Tiptap (on ProseMirror) | Lexical | Own contenteditable |
|---|---|---|---|---|
| IME, undo, selection, paste | mature, schema-driven parse of any paste | same engine | good | `execCommand` is deprecated and inconsistent; we'd own every edge |
| Ghost text (the follow-up plan) | transient **widget decorations**: not in the document, not in undo, not serialized | same, through an extension | no transient decorations: a node in the document (undo, serialization and selection must special-case it) | hand-made |
| Size (min+gz) | ≈ 75 KB for model, state, view, transform, commands, history, keymap, schema-list, inputrules | + ≈ 45 KB core and starter kit | ≈ 30 KB core + ≈ 25 KB plugins | small, until it's correct |
| Huge documents | incremental view updates; Fragment ops are O(children) pointer copies | same | good | the browser's |

**Choice: bare ProseMirror.** It gives exact undo, solid IME, a schema that is our sanitizer (anything not in the schema can't enter the document, whatever is pasted), and decorations for ghost text. Tiptap's abstraction buys nothing we need and costs size; Lexical makes ghost text a document node. Everything ProseMirror lives in one lazy chunk (`composer` chunk, see §8), never the entry.

## 3. The document

A new workspace package **`@terno/richtext`** (pure, no React; `prosemirror-model` only at its core, the view parts imported only by the editor chunk):

- **Schema.** `doc > block+`. Blocks: `paragraph` (attrs `align: left|center|right`, `indent: 0–8`), `blockquote > block+`, `bullet_list`/`ordered_list > list_item+`, `list_item > paragraph block*`. Inline: `text`, `hard_break`. Marks, in nesting order (outermost first): `link {href}` (not inclusive), `bold`, `italic`, `underline`, `strike`, `font {serif|mono}`, `size {small|large|huge}`, `highlight {token}`, `color {token}`. A line is a paragraph with no margins (Gmail/Apple Mail: Enter starts the next line, an empty line is the gap).
- **Palette** (`palette.ts`), tokens with an email hex and two display values (light, dark themes):
  - text: gray `#5f6368`, red `#c5221f`, orange `#b45309`, green `#188038`, blue `#1a73e8`, purple `#8430ce`, pink `#c2185b`: each ≥ 4.5:1 on white and ≥ 3:1 after a full inversion (unit-tested), so they read on white paper and in recipients' dark modes.
  - highlight: yellow `#fff2a8`, green `#ccf0d2`, blue `#d2e3fc`, pink `#fbd3e9`, orange `#fee0c2`, gray `#e8eaed`. A highlighted run always carries a text color (the chosen one, else `#202124`), so a client that keeps the light background but lightens default text (dark modes) still shows dark on light.
  - In the editor, marks render with CSS variables (`--rt-red`, `--rt-hl-yellow`, …) defined for light and dark themes, so a red word is legible in Terno Dark, Dracula, Nord… while the email carries the fixed hex.
- **Email HTML** (`toEmailHtml(doc)`): inline styles only, no `<style>`, no classes, no ids; the only attributes are `style`, `href`, `start`.
  - paragraph → `<div>…</div>` (`<div><br></div>` when empty); `text-align` and `margin-left: 40px × indent` inline when set.
  - lists → `<ul|ol style="margin:0 0 0 24px;padding:0">`, `<li>` (a single-paragraph item inline, more paragraphs as `<div>`s).
  - blockquote → `<blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex">`.
  - marks → `<a href>`, `<b>`, `<i>`, `<u>`, `<s>`, `<span style="font-family:Georgia,'Times New Roman',serif">` / monospace stack, `font-size: 0.8em | 1.4em | 2em`, `background-color`, `color`. Default text gets **no** font, size or color (the recipient's defaults, like Gmail's own mail), so our reader keeps such mail themed and dark modes work.
  - Text is escaped; runs of spaces alternate with `&nbsp;` so they survive. Wrapped as `<html><head><meta charset="utf-8"></head><body>…</body></html>` when sent.
- **Plain text** (`toPlainText(doc)`): lines as written; ordered items `1.`, bullets `•`, nested two spaces deeper; links `text (url)` (just the URL when the text is the URL, `mailto:` dropped); quotes prefixed `> ` per level; indent four spaces per level; NBSP as space.
- **From plain text** (`fromPlainText(text)`): one paragraph per line, so `toPlainText(fromPlainText(t)) === t` for any text (property-tested). This is the migration of every existing draft.
- **Parsing HTML** (`parseHtml(html, document)`, DOM-based, used by the editor to load a draft and by paste): a normalization pass (drop `<style>`, `<script>`, `<head>`, comments, Word's `o:p`/conditional comments, `<img>` and every other element outside the schema keeping its text; remove the trailing `<br>` of a block the way browsers render it; headings → bold + size: h1 huge, h2 large, h3–h6 bold), then ProseMirror's `DOMParser` with the schema's parse rules:
  - `b/strong` (not `font-weight: normal`, which is how Google Docs wraps everything), `font-weight ≥ 600`; `i/em`, `font-style: italic`; `u`, `text-decoration: underline`; `s/strike/del`, `line-through`.
  - links: `http:`, `https:`, `mailto:` only (anything else keeps its text, loses the link).
  - color, highlight, font, size, alignment and indent are read **only from Terno's own HTML** (a draft, or a copy from a Terno editor: ProseMirror marks its clipboard with `data-pm-slice`) and only as palette values; foreign paste keeps bold, italic, underline, strike, lists, links, quotes and headings (as size), and drops the rest.
  - `parseHtml(toEmailHtml(doc))` equals `doc` (property-style round trip over generated documents) — this is what makes the draft storage and the "what you wrote is what arrives" check exact.

## 4. Drafts

- **Model.** `Draft`, `DraftRow`, `DraftInput`, `LocalDraft`, `ExportedDraft` gain `bodyHtml` (`body_html`, default `''`). `bodyHtml` is the written part as email HTML (§3); `bodyText` stays and is always its plain-text alternative (previews, the drafts strip, the collapsed line, search of drafts, MCP, export readers that don't know HTML). `bodyHtml === ''` means a plain draft.
- **Saving.** `drafts.save` takes `bodyHtml` (≤ 10 MB); an omitted `bodyHtml` is saved as `''` (every save rewrites the body; an agent's plain-text save can't leave a stale rich body beside a new text).
- **Migration.** SQL v13 `ALTER TABLE drafts ADD COLUMN body_html TEXT NOT NULL DEFAULT ''`; IDB v4 sets `body_html: ''` on every stored draft. No text changes: an existing draft opens as `fromPlainText(bodyText)`; it becomes rich at its first edit, and its text stays identical (property test above). Export/import carry `bodyHtml` (optional on import: format-2 files from before load as plain).
- **Per-keystroke cost stays O(1).** The editor doesn't serialize on every keystroke: each transaction that changes the document calls `editDraft(key, {})` (dirty, `localRev + 1`) and registers a body source for the key. `save()`, `flushDraft()`, `draftForSend()`, discard and collapse **materialize** the source first (`toEmailHtml` + `toPlainText` once), so a 2 MB draft pays its serialization at the autosave cadence, not per key. Unmounting the editor materializes and unregisters. The drafts index's "has something written" also considers a registered dirty source.

## 5. Sending

- `compose.send` gains `bodyHtml?: string` (≤ 10 MB). The renderer builds both from the stored strings — no editor needed to send:
  - text: `sendBody()` as today with `bodyText`.
  - html (only when `bodyHtml` isn't empty): the body, the signature as `<div>-- <br>line<br>…</div>` (escaped), then the quote: a reply's attribution line as a `<div>` and the quoted lines in nested `<blockquote>`s by `>` depth (`quoteToHtml`); a forward's header block as a `<div>` with `<br>`s, then its text. Inline styles only.
- `SendPayload.html?: string`. `queueSend` (SQL and IDB) stores it in the op payload and ingests the optimistic local copy with `bodyHtml`, so the sent message reads as written in the reader at once.
- `buildRaw` passes `html` to MailComposer (multipart/alternative: text first, html second, both UTF-8, quoted-printable or base64 as nodemailer decides). `buildRawPortable` writes the same structure by hand (boundary, two base64 parts). Old ops in the queue (no `html`) send as before.
- Plain drafts (and agents) keep sending a single `text/plain` part.

## 6. The editor UI

### Surface

- `compose-body` becomes the ProseMirror root: `role=textbox`, `aria-multiline`, `aria-label` "Message", the placeholder as a CSS pseudo-element on an empty document (a `data-placeholder`, read by screen readers through `aria-placeholder`). Type uses the design's `type-body`; the font marks show their families; paragraphs have no margins; lists, quotes and links use theme tokens (`--hairline`, `--muted-foreground`, `--primary`); selection is the theme's.
- **Lazy.** `composer/rich-body.tsx` (editor, toolbar, link popover) is `React.lazy`. Loading starts on intent: when a conversation opens (its reply bar mounts), when the compose button is hovered or focused, and on `openCompose`. While it loads, the body shows a non-editable placeholder of the same size; `focusSoon` waits for the editor (it retries until the editable root exists).

### Formatting

- Standard semantics: with a selection, a command applies to the selection; with a caret it sets the stored marks for what's typed next (ProseMirror's `storedMarks`). Bold/italic/underline/strike toggle Word-style: if the whole selection has it, remove; else apply to all (`toggleMark` with `removeWhenPresent: false`).
- Font, size, color, highlight: menus that apply a mark value (Normal/Sans Serif/Default remove the mark).
- Alignment, lists, indent: block commands. Indent in a list sinks the item, outdent lifts it; elsewhere they change the paragraph's `indent`. Quote toggles a blockquote around the selected blocks. Remove formatting clears every mark in the selection (and stored marks), resets alignment and indent, and lifts lists and quotes.
- Input rules: `- ` / `* ` start a bulleted list, `1. ` a numbered one; a typed URL followed by a space or Enter becomes a link. Backspace right after a rule undoes it.
- Shortcuts (a ProseMirror keymap: handled keys are `preventDefault`ed, so the app's document handler and the menu don't also act): ⌘B, ⌘I, ⌘U, ⇧⌘X strikethrough, ⇧⌘7 numbered, ⇧⌘8 bulleted, ⌘] / ⌘[ indent, Tab / ⇧Tab in a list, ⌘Z / ⇧⌘Z (and ⌘Y), ⌘\ remove formatting, ⌘K link, ⇧⌘V paste as plain text (ProseMirror reads the shift key on paste). Off macOS, Ctrl for ⌘. ⌘K stays the palette outside the editor.

### Toolbar

- Gmail's order: Undo · Redo | Font ▾ | Size ▾ | B · I · U | Color ▾ | Align ▾ | Numbered · Bulleted | Indent less · Indent more | Quote | Strikethrough | Remove formatting. Quiet icon buttons (28 px, the design's toolbar icon stroke), hairline separators, on a rounded tinted strip (`--tint`) in macOS and Lumen, an outlined strip in Atelier (follows `surfaces.draft`); active state is a `--accent` fill plus `aria-pressed`. Tooltips name the command and show its shortcut.
- **Fits any width.** A `ResizeObserver` on the strip folds trailing groups into a "More formatting" (⋯) popover when the reader is narrow (980 px window); nothing wraps or overflows.
- **Active state** at the caret or for the selection (marks present across the whole selection, the first block's alignment and list), computed once per transaction in the editor and published through an external store; the toolbar re-renders only when that state changes (not while typing plain text).
- **Mouse:** buttons `preventDefault` on mousedown, so the editor keeps focus and selection. Menus and popovers return focus to the editor (selection restored) when they close.
- **Keyboard:** `role=toolbar` with a roving tab stop (one Tab stop; ←/→, Home/End move; Enter/Space activate; menus open with ↓ too). Every control has an accessible name; toggles expose `aria-pressed`, menus `aria-haspopup` and radio items with `aria-checked`. The color popover is two labelled radio groups (Text, Highlight) navigable with arrows.
- **Folding.** An "Aa" toggle in the action row shows or hides the strip (`aria-expanded`, `aria-controls`); the choice is remembered on this device (`localStorage`), shown by default. Shortcuts work either way.
- **Placement.** Inline draft: the strip sits between the body (with signature and quote) and the action row; the action row becomes Send · Aa · Link · save state … Discard · Collapse. New message: a sticky footer at the bottom of the pane carries the strip and a row with Aa · Link · save state (Send stays at the top).

### Links

- ⌘K or the Link button opens an inline popover under the selection (anchored to the selection's coordinates, kept inside the composer): Text (prefilled with the selection, hidden when the selection spans more than text) and Link fields, Apply and Cancel. Enter applies, Esc cancels; focus returns to the editor.
- Accepted: `https://…`, `http://…`, `mailto:…`; a bare `example.com/path` gets `https://`, a bare address gets `mailto:`. Anything else (`javascript:`, `data:`, `file:`…) shows "Enter a web address or an email address" and isn't applied.
- With a caret inside a link, a small bubble shows the URL and Open (opens externally, as links in mail do), Edit and Remove. ⌘-click opens a link in the editor.
- Pasting a URL over a selection links the selection; pasting a URL alone inserts it as a link.

### Paste

- HTML paste goes through `parseHtml` (§3): basic formatting stays, everything else goes (scripts, styles beyond the allowed set, classes, images including tracking pixels, Word's markup). ⇧⌘V (and the desktop's Paste and Match Style) pastes plain text.

## 7. Copy (en + es)

New keys under `compose.format.*` (toolbar names, menu items, palette names, link popover and errors, "More formatting", "Formatting options"), `shortcuts.*` for the shortcuts dialog's new rows. Font names: "Sans Serif", "Serif", "Fixed width" / "Sans Serif", "Serif", "Ancho fijo". Sizes: Small/Normal/Large/Huge · Pequeño/Normal/Grande/Enorme.

## 8. Tests

- **Unit (`@terno/richtext`):** email HTML per node and mark (exact strings, inline styles, nothing else: no class/id/style tag); the allowed-attribute scan over generated documents; plain-text alternative (lists, nesting, links, quotes, indent, NBSP); `fromPlainText`/`toPlainText` identity (generated texts incl. `> `, tabs, trailing spaces, CRLF); `parseHtml(toEmailHtml(doc)) == doc` over generated documents (jsdom); hostile paste corpus (script, `onerror`, `javascript:`/`data:` links, `<style>`, classes, tracking `<img>`, Word HTML with `o:p` and conditional comments, Google Docs' `b style=font-weight:normal`, nested tables, `<iframe>`, `<svg>`, `<form>`) → only allowed nodes and marks; palette contrast (≥ 4.5 on white, ≥ 3 inverted); `quoteToHtml`.
- **Unit (renderer):** `sendBody`/`sendHtml` with signature and quote; drafts with a body source (materialized before save, flush, send, discard; one serialization per save); `fromServer` with `bodyHtml`.
- **Storage:** SQL v13 and IDB v4 migrations keep every plain draft's text; `drafts.save` round-trips `bodyHtml`; an omitted `bodyHtml` saves `''`; export/import keep it (store conformance suite runs on both engines).
- **Send path:** `buildRaw` and `buildRawPortable` with html → multipart/alternative, both parts decode to the inputs (postal-mime); without html → single text/plain as today.
- **E2E (`e2e/composer.spec.ts`, @design so it runs in all three designs):** select text → each option (bold, italic, underline, strike, font, size, color, highlight, align, lists, indent, quote, clear) applies to exactly the selection, and the toolbar shows it active; caret mode (⌘B then type); every shortcut; link popover (⌘K with selection, without, edit, remove, open, invalid scheme refused, paste URL over selection); paste rich HTML (kept/stripped) and ⇧⌘V plain; undo/redo exact; folding remembered across reload; roving toolbar keyboard; axe clean in light and dark; the toolbar fits at 980 px; existing flows keep passing with the editor.
- **Round trip (`e2e/composer-send.spec.ts`):** the backend's provider sends through the real `sendViaSmtp`/nodemailer into an in-process `smtp-server`; compose formatted text in the browser (inline reply and new message), send, parse the captured MIME (postal-mime): multipart/alternative, text part readable (lists, links, quote), HTML has only inline styles; the HTML through a Gmail-like sanitizer (drop `<style>`, classes, ids, CSS properties Gmail doesn't keep) is unchanged, and parsing it back gives the editor's document exactly; rendered in Chromium (Arial, white) and on a simulated inverted dark mode, compared with visual baselines. `buildRawPortable` of the same payload parses to the same parts (the web path). The reader shows the sent copy as HTML.
- **Perf (ui-perf):** a 2 MB draft: typing p95 ≤ 16 ms (× the suite's multiplier) handled and rendered, toolbar state update after a selection change ≤ 16 ms, one autosave serialization ≤ 100 ms and none per keystroke (counted). Existing "typing in a draft with 2,000 drafts around" keeps its gate with the editor.
- **Bundle:** the entry chunk contains no ProseMirror (markers: `ProseMirror-` class names, `prosemirror` module ids) and they are in some chunk.
- **Desktop packaged smoke:** demo mode with `TERNO_TEST_SMTP_PORT` (honored only by dev builds or the demo mailbox, like `TERNO_TEST_PDF_DIR`): the demo provider sends through `sendViaSmtp` to the test's `smtp-server`; the smoke writes a formatted reply and asserts the captured MIME's HTML part.

## 9. Performance and resources

- Entry chunk unchanged (ProseMirror lazy); the chunk loads on intent, once.
- Per keystroke: ProseMirror's own update, one `editDraft` bump, the toolbar state compared (re-render only on change). Serialization only at autosave/flush/send.
- No timers when idle; the toolbar's ResizeObserver is the only observer, disconnected on unmount.

## 10. Out of scope

Attachments and inline images (and pasting images: dropped), an emoji picker beyond the OS one (⌃⌘Space works in the editor), confidential mode, Drive, rich signatures (the signature stays plain text, sent as HTML too), quoting the original's HTML (a reply quotes the original's text inside a blockquote), headings as block types, tables.

## Revisions after the Codex review

Codex (`codex exec -s read-only`, 12 points) against the plan and the code. What changed:

1. **One body source contract.** The editor registers a source per draft key; each document change bumps `localRev` (dirty) and marks the source dirty. `materialize(key)` runs synchronously at the start of `save()`, in `settle()` (send, discard), in `flushDraft()` and before every `fieldsOf()` snapshot (conversion and its undo), and writes `bodyHtml` + `bodyText` from the same document without bumping `localRev`; a clean source is a no-op. A body patch that doesn't come from the editor (`editDraft` with `bodyText`/`bodyHtml`, a conversion's undo) bumps a non-persisted `bodyVersion`; a mounted editor that sees a version it didn't write replaces its document. While a send is in flight the editor is read-only (`editable: false`), as edits would be dropped. A source of a deleted draft is ignored.
2. **Import.** The duplicate key includes `bodyHtml`; an orphaned reply restored as a new message appends its quote to the HTML too (`GAP` + `textToHtml(quotedText)`), as it does to the text.
3. **Exact round trip.** The trailing-`<br>` rule is matched by the serializer (a line ending in a break gets the browser's extra `<br>`), a list item's first line sits inline only when it has no alignment or indent, and NBSP is normalized: the editor turns typed and pasted NBSP into spaces, so `parseHtml(toEmailHtml(doc))` is the document exactly, repeated save/reopen included. Plain texts are LF (a textarea never holds CR; `fromPlainText` reads CRLF as LF). A legacy text NBSP reads as a space once the draft is edited (visually the same); documented and tested.
4. **Untrusted HTML.** Every HTML that reaches the editor goes through the inert parse and the schema. Before sending, a rich draft's HTML and text are both produced from a document: the editor's (materialized) or, for a stored body never opened this session, `parseHtml(bodyHtml)` (the richtext chunk is imported for it), so only schema HTML is ever sent and the text always matches it. `drafts.save` and `compose.send` drop `bodyHtml` unless the caller is the renderer (agents send and save text). `data-pm-slice` is untrusted: it only widens a paste to palette colors, fonts, sizes, alignment and indent, each validated by the parse rules. An e2e test opens a stored draft with hostile HTML (`onerror`, remote image, `javascript:` link) and asserts no request and no script ran.
5. **Event ownership.** The composer forms ignore Escape and ⌘↩ that were already handled (`defaultPrevented`) or come from a portaled popover or menu (not inside the form's DOM). The link popover's inputs handle Enter (apply) and Escape (close, back to the editor) themselves; every toolbar control is `type=button`; IME composition is left alone. Tests: Enter/Escape in the link popover and in each menu neither send nor collapse.
6. **Limits.** `drafts.save`: `bodyText` ≤ 5 M characters, `bodyHtml` ≤ 20 M; `compose.send`: `bodyText` ≤ 10 M (body + signature + quote), `bodyHtml` ≤ 25 M. A save refused as invalid (`BAD_REQUEST`) is permanent: the draft says "Too long to save" with Retry and doesn't retry by itself; the text stays in memory.
7. **Measured budgets.** The ui-perf suite covers a 2 MB draft as many short lines, as one giant paragraph and with dense marks: keystroke → transaction → next frame, toolbar update after a selection change, the autosave's serialization (gated, and counted: none per keystroke), opening (parse) and paste of 100 KB of HTML. If serialization exceeds its budget the gate fails; no async fallback is planned.
8. **Editor state survives unmounts.** An LRU of the last 8 `EditorState`s per draft key (undo history, selection, stored marks) restores collapse/reopen and navigation, valid while the draft's `bodyVersion` is the one the state was made for. Focus requests are editor-aware: `focusSoon` on `compose-body` asks the editor (placing the caret at the end) and waits for the lazy chunk instead of a fixed number of frames.
9. **Colors are AA in every pairing.** Text colors are darker (gray `#5a5e63`, red `#b3261e`, orange `#9a4700`, green `#116b2f`, blue `#1557b0`, purple `#7627bb`, pink `#b0175a`): each ≥ 4.5:1 on white, on every highlight, and inverted on every inverted highlight; ink on every highlight ≥ 11:1. The editor's display variables are tested against every palette's draft surface (≥ 4.5:1).
10. **Bundle.** `@terno/richtext/quote` (no ProseMirror) is all the entry chunk may import; the bundle test walks the entry's static import graph in the desktop build for ProseMirror markers, and a render-probe flag shows the editor module evaluated only after a conversation or the composer opened. The web's service worker still precaches every asset for offline use (bytes on disk, nothing executed).
11. **Test migration.** Shared helpers (`bodyText(locator)`, `typeInBody`) replace `toHaveValue`; the web takeover and update-reload tests keep their data-loss oracle by reading the editor's text (`innerText`) and also check that formatting survives.
12. **Real provider paths.** The e2e fixture gets `smtpCapture`: the backend's registry sends through the real `sendViaSmtp` (nodemailer) into an in-process `smtp-server`. A unit test drives `createGmailApi` with a stubbed fetch through the portable builder (HTML part, Bcc kept, `threadId`). The IMAP integration test checks the Sent APPEND carries the HTML part. Round-trip equality compares the authored document with the HTML before the signature; signature and quote are asserted structurally.

## Implementation notes (what differs from the plan above)

- **IndexedDB:** no version bump. Drafts are schemaless rows; the reader maps a missing `body_html` to `''` (exactly what an upgrade would write), so an old tab never blocks an upgrade.
- **Remove formatting** clears every mark but links, and alignment and indent; lists and quotes keep their own toggles (as Gmail).
- **Enter** keeps the line's alignment and indent; Enter on an empty list item or quoted line leaves the list or quote.
- **Each formatting command is its own undo step** (`closeHistory`): typing groups, ⌘] then ⌘[ undo one at a time.
- **No suspense gap:** once the chunk is loaded the editor renders in the same commit as its draft. Before that, an editable stand-in takes what is typed and hands it to the editor.
- **Focus while it moves:** a key pressed while a focus move waits for its frame goes where focus is going (a character follows it, any other key is replayed there). This was the root cause of the `compose.spec` "r, then a, then f, then r" flake (an Esc pressed one frame after r went to the page, and the next r was typed into the text). An open that waited for its conversation does nothing once a later r/a/f or Esc came. 120 consecutive runs pass.
- **Popups:** a value menu closes on a pick; closing any of the bar's popups puts focus back in the text synchronously (keys right after Esc reached the page); Esc with a popup open closes it, never the draft; picking a color keeps the palette open.
- **Huge drafts:** past 2,000 lines, lines off screen skip layout (`content-visibility`, only then: it changes how Chromium edits inside contained blocks). Measured budgets: keystroke → transaction ≤ 30 ms p95 at 2 MB (lines and dense marks) and for a 250 KB paragraph; the remaining cost is Chromium's own editing work. The placeholder check had serialized the document on every key: now O(1). One revision covers the keys until the save, so typing doesn't touch the store.
- **Perf project without trace:** Playwright's trace snapshots walk the whole DOM on every action, on the page's thread, inside the timings.
- **Shortcuts dialog** lists the formatting keys (a section of its own: they aren't app commands).

## What the Codex code review changed

Round 1 (`/tmp/unica-scratch/codex-review.sh 2d97038 …`, 8 findings), each fixed with a regression test:

1. **High:** text typed into the loading stand-in wasn't the draft's body (a send before the editor loaded lost it). The stand-in is now the body source meanwhile (saved and sent as the draft's body plus those lines) and the editor takes it over. Test: the editor chunk held back by a route, type, see it saved, send, see it in the sent copy.
2. **High:** the toolbar's "can indent" check built a step per selected line (quadratic: seconds for a whole-draft selection). Now a pure check that stops at the first line. Gate: select all in a 2 MB draft, toolbar state ≤ 16 ms.
3. **Medium:** toolbar commands could edit under a send in flight. The bar is disabled and the controller does nothing while sending. Test with the send held.
4. **Medium:** Enter right after a typed URL ran the rest of the chain on a stale state. One chain now. Test (with page errors watched).
5. **Medium:** `textToHtml` recursed per quote level (a 10,000-level line overflowed) and a 2 MB quote blocked the import. Iterative, capped at 32 levels, in pieces; the import yields between pieces. Unit tests.
6. **Medium:** a link with only its address at a caret inserted nothing. It goes in as the address. Test.
7. **Medium:** ⇧⌘V of a URL over a selection linked the selection. Plain paste is honored. Test.
8. **Medium:** the huge-draft gates didn't assert the painted frame. They gate its p50 (≤ 50 ms) and the select-all toolbar time.
