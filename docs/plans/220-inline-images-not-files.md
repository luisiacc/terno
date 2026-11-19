# 220: Images a message shows in its text are not listed as files

## Request

> this happens sometimes, someone i'm writing to has a huge signature with stuff and photos inside, and then i get this whole of attachments here, which i don't want, is htere a way to filter this and not show those?

(With a screenshot of a conversation's Attachments strip: "Attachments 15", `image001.gif` … `image012.png`, "Show all 15", all of them the signature's pictures.) Then: "yes build it".

## What exists

- Every MIME part with bytes is an `AttachmentInfo` (with its `contentId`), whether it is a file or a picture the HTML shows with `<img src="cid:…">`.
- The reader resolves those pictures in `apps/web/src/lib/cid.ts` (`resolveCidHtml`), after the message's "Show inline images" consent: only an unambiguous Content-ID, only PNG, GIF and JPEG, at most 4 MiB each, 8 MiB of bytes per message and 8 MiB of data URLs in its text (counted per `<img>`), a raster check on the bytes before decoding.
- Yet every part is also listed as a file: under each message (`ReaderAttachments`, `reader.tsx:520`; the full-message view; a held message), in the conversation's strip (`ThreadAttachments` over `threadFiles`, plan 177), in print (`print.ts`), and the folded message's paperclip reads the provider's flag (`m.hasAttachments`), which counts these pictures too.
- Copy as text (`thread-text.ts:410`) already leaves out a part the HTML names (a plain `includes("cid:…")`), and the agents server (plan 185) marks a part `inline` by `inlineParts` in `packages/mcp/src/attachment-content.ts` (over `cidReferences` in core): three rules for one question.
- On the desktop app a right-click in a mail's text opens the message menu (`wantsNativeMenu` is false there), so a picture shown in the text cannot be saved from the text. Its chip is the only way to save it today.

## Design

**One rule, in core** (`packages/core/src/attachments.ts`):

- `cidImageSources(html)`: the `cid:` sources of the `<img>`s in a body, in document order, by a linear scan: comments and the content of `script`, `style`, `textarea`, `title`, `noscript`, `template` and `xmp` skipped (they show no image), each tag read only up to its `>`, references in the value decoded, the URI once. It replaces `cidReferences` (any tag's `src`).
- `inlineImageAdmission(attachments)`: the reader's admission as a stepper. `reserve(cid)` answers the part a `cid:` image may show (an unambiguous Content-ID, PNG/GIF/JPEG, at most 4 MiB, within the message's 8 MiB of bytes, spent once per part whether its read succeeds or not; a part whose bytes aren't kept here is the text's picture too, costing nothing, and the reader skips it as today); `place(part)` spends the 8 MiB of data URLs per image, only for a picture actually placed. `cid.ts` calls `reserve` before reading and `place` after its bytes pass, exactly today's order: what the reader shows doesn't change.
- `inlineImageIds(html, attachments)`: the same stepper over `cidImageSources`, every read assumed to succeed: the parts the text shows. `messageFiles(html, attachments)` is the rest, in order, cached per attachments array (a WeakMap, keyed again on the HTML), so a conversation's strip and its messages scan each body once. A quick reject skips the scan when no part has a Content-ID.

**Nothing becomes unreachable.** A prediction can still be wrong (bytes that fail the raster check, a read that fails, markup the scanner reads differently from the sanitizer), and on the desktop app a picture in the text can't be saved from the text. So a message whose pictures are left out of its files offers them in its menu, the ⋯ and the right-click alike: **Save image ▸**, a submenu naming each (filename and size), which downloads it as the strip's Download does (a failure says so in the snack). Keyboard: ⋯ is reachable by Tab, the submenu by the arrows.

A part the reader would not show (an unsupported type, too big, over the budget, an ambiguous Content-ID, a `cid:` never used as an image) stays a file. A picture whose bytes aren't on this Mac (old mail, past the account's file limits) is still the text's: its menu item asks the server for it, as a file's tile does. Nothing guesses from names like `image001.png`.

**Where it applies.**
- The reader's message (`reader.tsx`) passes `messageFiles(m.bodyHtml, m.attachments)` to `ReaderAttachments`; no strip when it is empty.
- The full-message view: `mail-body` computes the files from the message's own HTML (not the display HTML, which may have its history folded or its sources resolved) and passes them; the view lists them only where it has the message menu (inside a conversation), else every part as today.
- `threadFiles` lists `messageFiles` per message: the conversation's strip, its count and "Show all" follow.
- The folded message's paperclip: shown when the message has files, or, while its parts aren't known yet (`attachments` empty), by the provider's flag as today.
- Print (filtered in `print-sheet.tsx`'s projection, where the metadata is) and Copy as text (its own `includes` rule goes).
- The "Show inline images" consent (`mail-body.tsx`) is offered when `cidImageSources` finds one, not by a raw-text test, so an encoded `c&#105;d:` source gets it too.
- Unchanged: a held message (the user's own send, shown for Undo; no message menu there), Forward (carries every part), and the agents server's `inline` mark (`inlineParts` keeps its own meaning, a part the text names, now on `cidImageSources`).

## Tests

- Core unit (`packages/core/src/attachments.test.ts`): `cidImageSources` — order, entity and case variants, comment/script/textarea/style skipped, a non-`img` tag ignored, an unterminated tag ends the scan; `inlineImageIds` — a shown PNG inline; a PDF named by `<img>`, a part over 4 MiB, an ambiguous Content-ID all stay files; a part without kept bytes is the text's and costs no budget; the byte budget and the per-image data-URL budget leave later parts listed; `messageFiles` returns the rest in order and is cached per array and HTML.
- `cid.test.ts`, `cid-budget.test.ts`, `cid-mime.test.tsx` and the `cid.perf` gate pass unchanged (same admission), plus a mixed case: an invalid 4 MiB image before a valid 3 MiB one still shows the second.
- `thread-overview.test.ts`: `threadFiles` leaves out the shown pictures. `thread-text` unit: its existing case (a logo shown, without kept bytes) passes on the shared rule.
- Perf gate `packages/core/src/attachments.perf.test.ts`: 50 bodies of 200 KB (about 27 ms on a loaded machine, gate 150 ms) and malformed markup (unterminated tags, comments, raw text: ≤ 6 ms, gate 60 ms).
- mcp `attachment-content.test.ts` unchanged.
- e2e (`attachments.spec.ts`, its existing CID scenario): a message with a signature picture and a PDF lists only the PDF under the message and in the conversation's strip; the message's ⋯ → Save image, by keyboard, lists the picture and downloads its exact bytes; axe on the submenu in light and dark; Forward still carries both parts.

## Perf

A linear scan per message body that has a kept part with a Content-ID, cached per message's attachments array; no DOM, no bytes read, nothing until a conversation is shown. The reader's resolution is unchanged. No backend, store or migration change.

## Out of scope

- The list row's paperclip and the "Attachments" filter read the provider's flag, stored at ingest: changing them means deciding at ingest, a later step.
- A picture the mail attaches but never shows (some Outlook signatures) stays a file: no name guessing.
- Saving a picture by dragging it out of the text, or a Save Image on the picture itself (the menu has them).

## Revisions after the Codex review

The critique (`codex exec -s read-only`, 10 points) reshaped the design; all accepted, some answered differently:

1. A picture predicted shown but not placed (failed read, raster check) lost its only save path: hidden pictures are now offered in the message's menu (**Save image ▸**), whatever happens in the text. This replaces the first draft's right-click-on-the-picture item, which only reached placed pictures.
2. The regex didn't know that `textarea`, `script` and the like show no image: the scanner skips their content; a wrong guess now costs a submenu, not the file.
3. Held messages have no message menu: left unchanged.
4. The full-message view had only the display HTML: `mail-body` passes files computed from the message's own HTML.
5. The consent test read raw text: it uses the scanner now.
6. A stepper spending the data-URL budget before the read would change what the reader shows: `reserve` and `place` keep today's order.
7. Keyboard access: the ⋯ submenu.
8. Print's projection drops the metadata: filtered in `print-sheet.tsx`.
9. Linear scanning, each tag read to its `>` only, a cache per message.
10. The agents' `inline` mark keeps its meaning (not the reader's admission), so its tests stand.
