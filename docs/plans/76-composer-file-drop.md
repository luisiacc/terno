# Plan 76: drop files into the composer

## Request (verbatim)

“on the composer right now, make it so droping a file works, there needs to be a nice effect when draggin the file so the user knows it cna be dropped, it needs to drop at the cursor, lets make this work really intuitively, spawn a subagent that will emulate 5 qs kinds of users with different personalities trying this feature in multiple scenarios, and make it work intuitively for them so its clear how to do this and have it work all the time.”

## What exists

- Both composers (inline reply/forward in `inline-draft.tsx`, the New Message pane in `new-message.tsx`) are a `form[data-testid=composer]`. Files come in only through the paperclip (`AttachButton` → `attachFiles`, plan 29): staged into local assets in 48 KB chunks, budgeted against the send limit, adopted into `draft.attachments`, shown as chips (`DraftAttachments`).
- Nothing handles a drop. A file dropped on the composer does nothing; dropped on the body, ProseMirror ignores it; in a browser tab a drop anywhere outside a handler navigates away from the app.
- The editor's schema (`packages/richtext/src/schema.ts`) has no images; `cleanDom` drops every `<img>`. Sending already supports inline parts: an `AttachmentRef` with a `contentId` goes out `Content-Disposition: inline` with a `Content-ID` (forwards use it), and the reader resolves `cid:` (`lib/cid.ts`, PNG/JPEG/GIF only).

## Design

### The drag

- A drag carrying files (`dataTransfer.types` has `Files`) over a composer lights it: an inset 2 px ring in `--primary` at low alpha and a faint wash, plus a pill at the composer's foot naming what a drop does. Nothing changes for text dragged inside the editor.
- **Two zones, one rule.** Over the text: images go *where the pointer is*; a 2 px caret in `--primary` follows the pointer to show the spot, and the pill says “Drop to place the image here” (“…images…” for several). Elsewhere in the composer (recipients, subject, chips, toolbar) or for files that aren't images, the pill says “Drop to attach”. A mix over the text: images go inline, the rest attach (“Drop to place images here and attach the rest”).
- A drag that can't land (the draft is sending, or recovering) shows the pill “Can't add files while sending” with no ring and `dropEffect = none`.
- Leaving the composer, Esc, or a drop anywhere clears it at once. No motion beyond the `--motion` cap; with reduced motion the ring just appears.
- A file dropped anywhere else in the app is refused (`dropEffect = none`, `preventDefault`): it never navigates the tab away (and with it the draft).

### The drop

- Images (PNG, JPEG, GIF; the types our reader shows inline) dropped on the text: a preview appears at once at the drop point (the local file, dimmed) while the bytes are staged; when staged the image takes its place as part of the text. One undo step removes it; redo brings it back.
- Everything else: chips, as the paperclip does. Same budget, same errors (“too large”), same busy state.
- Pasting an image (a screenshot) into the text places it at the caret, the same way.

### Inline images

- Schema: an inline atom `image` with `cid`, `alt`, `width`. Parse rule only for `img[src^="cid:"]`; `cleanDom` keeps such an `<img>` (src, alt, width) only in Terno's own HTML; a foreign paste still drops images. A paste of an image node whose `cid` isn't one of this draft's files is dropped (`transformPasted`).
- Mail HTML: `<img src="cid:…" alt="…" width="N" style="max-width:100%;height:auto">`; width is the image's own, capped at 600 px. Plain text: `[image: name]`.
- In the editor a node view shows the file: an object URL from the dropped `File` at once; on reopen it is read from the local asset (`attachmentBlob`). URLs are cached per asset, at most 32, revoked when evicted or the draft goes.
- The draft's `attachments` hold the image's ref with a `contentId` of `terno-img-<uuid>@terno` (our prefix). Chips never show these: an inline image lives in the text. At send, one the text no longer shows (deleted, not undone) is left out.

## Tests

- richtext: image parse/serialize round trip, foreign `<img>` still dropped, own non-cid `<img>` dropped, plain text.
- web unit: drop zone state (files vs text drag, enter/leave nesting, sending), pruning of unreferenced inline refs at send, chips hide inline refs.
- e2e (`apps/web/e2e`): drag a file over the composer → ring and pill; drop a PDF → chip; drop a PNG on the text → image at the drop point and in the sent HTML; undo removes it; drop outside the composer doesn't navigate.

## Perf

Nothing runs until a file drag enters the window (one `dragenter` listener). The caret is positioned in rAF. No change on typing paths: the image node view is only built for image nodes.

## Out of scope

Resizing images by hand, images as a link, dropping a URL or text from another app (ProseMirror's own), inline images in the plain-text stand-in (it attaches).
