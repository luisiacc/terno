# Plan 149: Copy conversation as text

- **Status:** built.
- **Builds on:** plan 06 (context menus), plan 09 (printing, its quote stripping and the message menu).

## The request

> I wanna have an option inside an email for copying the entire thread as text, like to paste it into. Uh, an AI or something. But I'm not sure where to produce in the top, there's a lot of buttons. I think maybe when you write click anywhere, on the, If you write click without selecting anything, like in the background of the thread, of the email, somewhere where you're, where you're not selecting anything, you're just right clicking, we show some options, I think we could show it there. What do you think?

After a proposal (the existing right-click menu, anywhere in the thread, plus the palette and the list's menu; quoted history out; oldest first):

> Yeah, yeah, let's start building it this way. Also, when the tech, when there is HTML, make sure to copy the text only and format it correctly. As it chose like as text, but format it correctly with proper spaces and stuff. Also, I think for this, you don't have to run the full suite of tests, maybe just some tests for this specific behavior, that you'll create. But you don't have to run the folds through of that of tests for these or anything like that. Because this likely applies only to that action. So it won't cause any other issues in the app.

So this plan runs its own tests, typecheck and lint, not `pnpm test:all` (the user's call for this feature).

## What exists

- `MessageMenu` (`components/message-menu.tsx`): one Base UI context menu around the reader's header and conversation. Print and Export PDF for the message under the click, Copy when text is selected. A click outside `[data-message-id]` opens nothing; the margins and the area under the conversation are outside its trigger altogether.
- `ThreadMenu`: the list's menu, Print for one conversation. The palette's `printable` gate and `printableThread()`.
- `htmlToText` (`packages/mail/src/visible-mail-text.ts`) flattens to one line for the search index; it can't format.
- `stripTrailingQuote` in `lib/print.ts` (trailing Gmail, Apple and Outlook history in HTML) and `splitTextQuote` in `lib/quote.ts` (the same in plain text, inline replies kept whole).
- `loadThread(id, true)` returns a fresh `ThreadDetail`, oldest first, bodies hydrated, or null.

## Design

### 1. Where it lives

"Copy conversation as text":

- **Reader:** a right-click anywhere in the thread gets `MessageMenu`: on a message, in HTML mail (its frame replays the click), on the header, in the margins, under the conversation. On a message: Copy (if text is selected), then this, then Print and Export for that message. Off a message: only this. The composer, the suggested reply and the scheduled line stay out of it: they aren't the conversation, and the composer has its own editing.
- **Thread list:** beside Print, one conversation only, as Print is.
- **Palette:** beside Print, same gate. It is the keyboard's way in (`⇧F10` doesn't reach the reader's menu).

No toolbar button and no shortcut.

### 2. The text

```
Subject: Contract renewal

From: Ana Ruiz <ana@acme.com>
To: Luis <l@x.io>, Bob <b@x.io>
Cc: …
Date: Tuesday, November 3, 2026 at 10:12 AM
Attachments: terms.pdf

Hi Luis, can we move the renewal to…

---

From: …
```

- Oldest first, the labels in the UI's language (`To`, `Cc`, `Attachments` reuse `print.doc.*`).
- **Quoted history goes, except in the first message.** Later messages repeat what is above them, and a long thread pasted with its quotes is the same text many times over. The first message's history is in no message above it: someone added late, or a forward, has only that copy. A message that is nothing but history (a bare forward) keeps it, as `splitTextQuote` already does in plain text. Inline replies are kept whole, by the same rules printing uses.
- **Attachments:** names only. An inline image the HTML references by `cid:` is not an attachment to the reader of this text.
- **No body:** the reader's wording in the text (`attachments.bodyUnavailable`, `print.doc.notDownloaded`), so a gap is never silent, and the snack counts them. A message whose body is complete and empty says `attachments.noBody` and doesn't count as missing.

### 3. HTML to text

`lib/thread-text.ts`, a lazy chunk, parses with `DOMParser` into an inert document: nothing loads, nothing runs, and the output is a string, never HTML, so no sanitizer is needed. Which body: what the reader shows, HTML when there is one. A line model, not string replacement:

- **Inline:** whitespace collapses across inline elements, `&nbsp;` is a space, zero-width spaces, BOMs and soft hyphens go. Formatting goes, and **links are their text** ("text only"; tracking URLs are long and an AI has no use for them).
- **Lines:** `<br>` ends a line; a `<br>` at the end of a block adds nothing, as in a browser, and `<div><br></div>` is one empty line (Gmail's blank line). `<div>` starts a line; `<p>`, headings, lists, tables, `<pre>`, `<blockquote>` and `<hr>` are set apart by one blank line. `<p style="margin:0">` and Outlook's `MsoNormal` are lines, not paragraphs, because their margin is zero; `<div>&nbsp;</div>` and `<o:p>&nbsp;</o:p>` are their blank line. Never two blank lines in a row.
- **Lists:** `- item`, `3. item` (`start` kept), nested by two spaces; a wrapped item's lines align under its text.
- **Tables:** mail uses them for layout, so a cell with several lines reads as blocks, in order. A row of one-line cells is `a | b | c` (real data, and a two-column layout reads fine). An empty row is a gap (a spacer).
- **Quotes kept** (inline replies, the first message): `> ` per line.
- **`<pre>` and `white-space: pre*`:** exactly as written.
- **Hidden:** `display:none`, `visibility:hidden`, `hidden`, `opacity:0`, `font-size:0`, `max-height:0` with `overflow:hidden` (preheaders), `script`, `style`, `head`, `noscript`, `template`, `svg`, `select`. Inline styles only: the reader strips `<style>` too, so this is what it shows.
- **Images:** their `alt`, what the reader shows while they're blocked. Spacers have none.
- **Plain text bodies:** line endings normalized, line ends trimmed, blank runs to one, indentation kept.

`stripTrailingQuote` moves from `print.ts` to `lib/quote-html.ts` (so this chunk doesn't load the print document's), taking an element as well as a fragment. `ATTRIBUTION` stops being declared twice.

### 4. Copying

`lib/copy-thread.ts` (small, in the main chunk) calls `clipboard.write` in the click with a `ClipboardItem` holding a promise of the text: a browser may refuse a write that starts after a wait. It loads the chunk and `loadThread(id, true)` (what print does: bodies downloaded since). A snack confirms: "Copied 5 messages", plus how many weren't downloaded. A failure says what to do. Between messages the build yields, so a long thread doesn't freeze the window.

## Tests

- `thread-text.test.ts` (jsdom), one behaviour each: paragraphs, Gmail's blank lines, Outlook's lines, trailing `<br>`, whitespace and `&nbsp;`, inline across elements, links, lists nested and numbered, data rows, layout tables, spacer rows, `<pre>`, hidden preheaders, blockquotes; the document's shape; history out except in the first message; bare forward; inline reply; `cid:` attachments; missing bodies counted; Spanish labels.
- `quote.test.ts`/`print.test.ts` keep holding the moved function.
- `e2e/copy-thread.spec.ts`: from the reader on a message and in a margin (only this item there), in an HTML frame, from the composer (no menu), from the list's menu, from the palette, each reading the clipboard. Menu in light and dark: a screenshot, looked at.

## Performance

Nothing runs until the click. The converter is a lazy chunk, out of the entry. The parse is linear; the HTML parser caps element depth at 512, so the recursive walk is safe. No hot path changes; no perf gate needed. The menu's trigger moving adds no render: one wrapper with no DOM of its own.

## Privacy

The text goes to the clipboard on the user's click and nowhere else.

## Out of scope

Keeping link URLs (a later option if it's missed), a shortcut, a toolbar button, copying several conversations, the desktop's File menu.

## Revisions after the Codex review

The design above stands except where this says otherwise.

1. **The trigger doesn't move.** Base UI cancels the native menu for every right-click inside its trigger, even one its handler skips, so a trigger on the scroller would take the composer's menu away. It stays around the conversation. A right-click on the background itself (the scroller or its padded column, nothing inside them) is passed to it, the way a mail frame's already is. `data-no-thread-menu` isn't needed.
2. **Off-message opens the menu only inside the trigger's own DOM.** The full-message view is a portal under the reader's trigger, so React bubbles its controls' right-clicks there. Those stay without a menu.
3. **A bare forward keeps its history in HTML too.** `stripTrailingQuote` removes everything there (print's behaviour, unchanged). The converter renders stripped, and if nothing is left, renders again whole.
4. **Outlook inline answers:** rejected, known limit. Answers typed below Outlook's header go with it, as they do when printing with quotes hidden; telling them from the history would mean diffing against the messages above, and getting that wrong either keeps every history or drops a reply. Written down, and said to the user.
5. **A missing body above keeps the history below,** the same reason as the first message: nothing above covers it.
6. **Copying downloads what's missing.** `threads.get` doesn't: `reader.hydrate` does, per message, and a thread copied from the list may never have been opened. Copy asks for those first (a "Downloading…" snack meanwhile, the clipboard holding its promise). What still doesn't arrive is marked. A partial body is copied with a line saying so.
7. **No loading is verified, not assumed.** `hasRemoteContent` already parses raw mail with `DOMParser` on every print, but the e2e counts requests: a pixel, a frame, a stylesheet.
8. **Inherited hiding is tracked.** `font-size:0` wrappers (they remove the gaps between inline-block columns) and `visibility:hidden` can be undone by a descendant, so they are carried down the walk and text decides, not the element. `display:none`, `opacity:0` and `max-height:0` take the subtree. Inline-block boxes are separated by a space, since a zero font removes the whitespace between them.
9. **`display` overrides tag defaults:** `<div style="display:inline">` doesn't break a line, `<span style="display:block">` does. A block with an inline margin is set apart as a paragraph (mail that makes paragraphs from `div`s).
10. **Whitespace modes:** `pre`, `pre-wrap` and `break-spaces` keep everything, blank runs included; `pre-line` keeps line breaks and collapses spaces; only normal text gets the blank-line cleanup.
11. **The digest row isn't a conversation:** the palette's item and the copy command leave it out (`loadThread(0)` is null).
12. **Rejected:** yielding inside one message and rewriting the stripper's quote search. One parse can't be split, the stripper already runs on every print preview, and this runs once per click. **Rejected:** dropping the `MsoNormal` rule because the reader removes the stylesheet that defines it. The rule isn't about how the reader draws it but what the sender wrote: Outlook lines with an explicit `&nbsp;` paragraph between them. Treated as paragraphs, a signature becomes double-spaced.

## What the code review changed

First round, each with a regression test:

- Hidden elements and `<style>` are removed before anything reads the mail. Unseen content after a quote used to read as a reply below it and hold the history back. This also covers a hidden `<tbody>`, which `table.rows` walks past.
- A row inherits from its section as well (`visibility:hidden` on a `<tbody>`).
- `pre-line` keeps its blank runs, like `pre`.
- The no-loading test copies a real message holding a pixel, a frame, a stylesheet and an object, instead of parsing them apart from the action.

Second round: nothing.

**What the tests found along the way:** the reader's own mail frame asks for a remote image as it opens, and its CSP refuses (`blockedReason: csp`): nothing leaves. Copying asks for nothing. The spec starts counting after the frame is up.

## Test scope

By the user's choice (the request above), this ran its own tests and what shares its code, not `pnpm test:all`: `thread-text.test.ts`, `copy-thread.test.ts`, `print.test.ts`, `quote.test.ts`, `palette-commands.test.ts`, the i18n package, `e2e/copy-thread.spec.ts` (ten times over, in parallel), and `print`, `reader` and `sender-header` in macOS and Lumen, plus typecheck and lint. The menu was looked at in light and dark. The converter is its own chunk, not in the entry.

## Known limits

- Answers typed below Outlook's reply header go with the history (revision 4).
- Link addresses aren't copied, by request ("text only"): "click here" reads as "click here".
- `stripTrailingQuote` empties a bare forward when **printing** with quotes hidden. Copying guards against it; print is unchanged here.
