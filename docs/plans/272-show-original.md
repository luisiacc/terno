# Plan 272: Show original (a message's headers, its HTML and its source)

## Request (verbatim)

> lets have on an email thread, inside the 3 dots menu or right click menu of each message, the ability to see metadata of each email like gmail does, and see them too as html so they can be inspected.

Read as Gmail's **Show original**: a summary of the message's metadata (Message ID, when it was created, from, to, subject, and how SPF, DKIM and DMARC judged it), every header, and the message's source; plus its **HTML**, the text/html part decoded, shown as code so it can be inspected, and saved as an `.html` file to open in a browser and its developer tools.

## What exists

- **The message's menu** (`components/message-menu.tsx`): `MessageItems` is shared by the ⋯ menu at the end of each header (`MessageActions`, a `DropdownMenu`) and the conversation's right-click (`MessageMenu`, a `ContextMenu` that learns the message from `[data-message-id]`). Reply, Reply all, Forward; who it's between; Copy text; Save image, Print, Export as PDF.
- **A view that takes over the reader** (`components/mail-reader-view.tsx`, plan 188's full-message view): `MailReaderView` wraps the reader (`reader.tsx`); `open(lease, trigger)` hides the conversation (inert, kept in place) and shows a host the opener portals into; Esc, Back or the mouse's back button close it, and focus and scroll go back to the trigger exactly. `FullMessage` is its one user.
- **Nothing keeps the original locally.** The store keeps parsed fields (addresses, subject, date, Message-ID, references, List-Id, unsubscribe) and the body (`bodyHtml`, `bodyText`), never the header block or the MIME source. So the original is read from the mail server, on the user's click, as Gmail's own Show original does.
- **On-demand reads already exist**: `reader.hydrate` → `BackendCore.hydrateBody` → `MailProvider.readBody` (Gmail only), with the account's lifetime, credential and eviction checks, the reader admission lane (`admission: "reader"`) and the incoming read permits (`ctx.incoming.acquire`).
- **Big mail is decoded off the event loop**: Gmail's `format=raw` answer is read bounded (`readIncomingBody`, `INCOMING_GMAIL_WIRE_BYTES`), small ones (≤ 64 KB) decoded inline, larger ones by the incoming worker (`ctx.incomingProcessor.run`, `incoming-processing-worker.ts`). IMAP fetches `source` with `maxLength: MAX_INCOMING_MIME_BYTES + 1` (75 MB) and hands it to the same worker.
- **Downloads** (`lib/attachments.ts`): bytes pulled from the backend a piece at a time, a Blob, an `<a download>`.

## Design

### 1. Providers read the original (`packages/mail`)

`MailProvider.readOriginal?(target: { id: number; providerMsgId: string }, signal): Promise<{ bytes: Uint8Array; release(): void } | null>`: the message's RFC 822 source as the server holds it, up to `MAX_INCOMING_MIME_BYTES` (larger: a `ProviderError` saying so); `null` when the server no longer has it. Read only on the user's click; stores nothing.

- **Gmail**: `GET /messages/{id}?format=raw&fields=id,raw` on the reader lane, read bounded as incoming mail is (`readIncomingBody`, the permits); decoded (JSON, base64url) inline when small and by the incoming worker otherwise (a new job, `{ kind: "raw" }`, returning the bytes, transferred). 404 on that path → `null`.
- **IMAP**: the message's places (`locations.of([id])`), each tried in turn on the account's connection (`withConnection`): lock the mailbox, skip a place whose UIDVALIDITY changed, `FETCH uid (BODY.PEEK[])` with `maxLength` one over the cap. No place answers → `null`.
- **Demo**: a small fixed original built from the stored subject and sender (`messageByProviderId`), with demo `Received`, `Authentication-Results` and an HTML part, so the dev build and e2e show the feature.
- **Outlook** (plan 259, not on main): `GET /me/messages/{id}/$value` when it lands; noted in its plan.

### 2. What the original says (`packages/mail/src/original.ts`, pure)

`describeOriginal(bytes): OriginalView`, run by the incoming worker for anything over 64 KB (a new job kind, `"original"`, which takes the bytes and returns only this, bounded), inline otherwise:

- `headers`: the header block as written (up to 256 KB), and `fields`: `{ name, value }[]` unfolded, in order.
- `summary`: Message-ID, Date (as written, and as a time), From, To, Cc, Subject (encoded words decoded), Delivered-To, and **SPF, DKIM, DMARC**: the verdicts from the topmost `Authentication-Results` (the receiving server's), with what each names (`smtp.mailfrom`, `header.d`/`header.i`, `header.from`, the client IP from `Received-SPF` or the result's comment). Absent: the row isn't shown.
- `html`: the text/html part as decoded by postal-mime (charset and transfer encoding undone, nothing sanitised), up to 2 M code units (`htmlTruncated` past it); `null` without one.
- `source`: the first 1 MB of the source as text (UTF-8, invalid bytes as U+FFFD), `size` in bytes and `truncated`.

### 3. The backend (`packages/backend`)

`reader.original { messageId }` → `OriginalView & { file: { id, pieces } | null }`; `reader.originalPiece { id, index }` → `{ dataBase64 }` (1 MB pieces); `reader.originalClose { id }`.

- `BackendCore.readOriginal` follows `readSelectedBody`: the account's lifetime, credentials and eviction checked before and after the read; a signed-out account, a local-only message (`local:` id) or a provider without `readOriginal` answer `{ unavailable: "signin" | "local" | "unsupported" }`; `null` from the provider → `"gone"`.
- **Bytes kept for the download** in `OriginalFiles` (`original-files.ts`): at most two at once (the oldest let go), each dropped on `reader.originalClose`, when its account goes, or after two minutes untouched. A piece asked of one that's gone answers `NOT_FOUND`, and the renderer reads the original again.
- Two reads at most at a time; a third waits for neither (`UNAVAILABLE`, "busy").

### 4. The view (`apps/web`)

- **Show original** in `MessageItems`, after Export as PDF (so in the ⋯ menu and on a right-click). Icon: Hugeicons' source-code glyph (one catalog line).
- `OriginalHost` (in `reader.tsx`, inside `MailReaderView`): a context the menu calls (`openOriginal(messageId, trigger)`; the trigger is the ⋯ button, or the message's header on a right-click), owning which message is open and portalling `OriginalMessage` into the view while its lease is active. Back, Esc or the mouse's back button return to the conversation with focus on the trigger and the scroll where it was (the view's own restoration).
- `OriginalMessage` (`components/original-message.tsx`): a header like the full message's (Back · *Original message* · Copy · Download), then the summary as a two-column list on hairlines (label muted, value selectable, SPF/DKIM/DMARC with a quiet PASS/FAIL word, never a colour alone), then BoardUI line Tabs: **Headers**, **HTML** (only when the message has one), **Source**. Each tab is a monospaced, wrapped, selectable `pre` in its own scroll region. Copy copies the open tab; Download saves `<subject>.eml` from the backend's pieces; on the HTML tab, Save HTML saves `<subject>.html`.
- Loading: a status line ("Reading the original from your mail server…"). Failures say what happened and what to do: offline / server unreachable ("Terno couldn't reach your mail server. Check your connection and try again." + Try again), gone ("This message is no longer on your mail server."), local-only ("This message hasn't reached your mail server yet."), signed out ("Sign in to this account again to read its original."), too large.
- Truncation says so: "Showing the first 1 MB of 14.2 MB. Download the original to see all of it."

All copy through `t()`, `en` and `es`.

## Tests

- `original.test.ts`: header unfolding and order, encoded-word subject, the topmost Authentication-Results wins, SPF/DKIM/DMARC with and without comments, an HTML part in quoted-printable and base64 with a charset, no HTML part, the 1 MB source cut and its size, the 256 KB header cut.
- Worker: the `raw` and `original` jobs round-trip, with their bounds.
- Gmail: `readOriginal` asks `format=raw` on the reader lane, decodes, 404 → null. IMAP (`imap.int.test.ts`): reads the source of a message, a stale UIDVALIDITY place is skipped.
- Backend (`original-files.test.ts`, `core` via the demo): pieces add up to the bytes, two kept at most, idle drop, close, an account's removal drops its files, the unavailable reasons.
- e2e (`original-message.spec.ts`): ⋯ → Show original shows the summary and Headers; the HTML tab shows the HTML source; Download saves an `.eml`; Esc returns focus to ⋯; the right-click path opens it too; axe clean in light and dark.

## Performance and resources

Nothing runs until the user asks. One server read per opening; parsing over 64 KB in the incoming worker; the renderer gets at most ~3 MB of text (headers 256 KB, HTML 2 M units, source 1 MB). Kept bytes bounded (two originals, two minutes). No hot path changes, so no perf gate is touched.

## Out of scope

Outlook's read (with plan 259), syntax highlighting, a palette command or shortcut, a conversation-wide original, showing the original of a draft or of a message only on this computer.

## Revisions after the Codex review

Twelve points; each changed the design as follows (this section supersedes the sections above where they differ).

1. **Renderer-only, bound to the client.** All three RPCs refuse non-renderer callers (as `reader.hydrate` does). The open takes `{ threadId, messageId, requestId }` and checks the message is in that conversation; the kept file is keyed by the opening client and its `requestId`, and a piece or close from another client finds nothing.
2. **Gmail's raw read has its own bounded mode.** `format=raw&fields=id,raw`, collected as incoming mail is (`readIncomingBody`: the bound, the read and large-read permits, the reader lane), 404 on that path → `null`. No `JSON.parse` of the whole answer and no worker: the `raw` string is found in the bytes and base64url-decoded a slice at a time with the backend's yield between slices (`decodeGmailRaw`, `original.ts`); the rest of the answer, with `raw` emptied, is parsed as JSON and must be `{ id: expected, raw: "" }`. Anything else is a malformed answer, told apart from one over the size bound.
3. **IMAP keeps the repair fetch's checks.** Places held for identity reconciliation (`locations.unresolved`) are not read; a place whose UIDVALIDITY changed is skipped; the FETCH is exhausted before its bytes are trusted, a second answer or another UID is a broken exchange. Only every place confirmed missing (no such mailbox, no such UID) is `null` (gone); a refusal or a stale place is an error, never "gone". The read runs under the backend's `afterFolderChange`, as `readBody` does.
4. **Buffer and permit ownership.** The provider holds the incoming read permit (and the large one over 64 KB) only while it reads; it returns plain bytes it no longer needs, and the backend's `OriginalFiles` owns them under its own bound (two originals at most). Nothing is handed to the incoming worker, so no transfer detaches them.
5. **Cancellable before a file exists.** The renderer makes the `requestId`; `reader.originalClose { requestId }` aborts a read still in flight (admission waits included) and drops a result that arrives after it. Closing the view, opening another message's original, or leaving the conversation closes it.
6. **Focus and the full-message view.** The return target is the message's ⋯ button (both menus; on a right-click the ⋯ of the message it landed in), the menu restores no focus of its own when Show original opens the view (`handedOff`), and Back takes focus on entry. Show original is not offered inside the full-message view (one view at a time). Tests cover keyboard and right-click return.
7. **Authentication results are reported claims.** The summary shows SPF, DKIM and DMARC as the topmost `Authentication-Results` reports them **and names the reporter** (its authserv-id, in a last row: "Checked by mx.google.com"). No IP or verdict is taken from `Received-SPF` or comments. A fixture with two conflicting reporters shows the topmost one, named.
8. **The HTML is the HTML Terno renders, from this computer.** Not a new parse of the original: the message's stored `bodyHtml` (the same postal-mime parse at capture: its text/html parts, with any plain parts in a mixed message turned into HTML as the reader shows them) before the reader's sanitising. The tab is offered only when the message has HTML (postal-mime sets `html` only when a text/html part exists). It needs no server, so it shows even when the original can't be read. Headers, Source and Download never depend on it.
9. **No HTML file is saved.** An `.html` opened in a browser would run its scripts and load its remote content, which the reader never does. The HTML tab shows the source as text, with Copy; nothing else.
10. **Download budget.** Its own path, not `attachmentBlob`: 1 MiB pieces (index validated, the total checked against the size), one at a time, into a Blob of at most `MAX_INCOMING_MIME_BYTES`. A file that expired mid-download discards what it had; Download again reads the original again from the start.
11. **The preview is bounded as a whole.** No parsed `fields` array goes to the renderer: Headers shows the verbatim block, cut at the blank line or at 256 KB (`headersCut` says so). The summary's values are capped at 2,000 characters each. Tests: a cut inside a folded header; no blank line within the first 256 KB.
12. **Verification.** Light and dark screenshots of the menu row and the view in the classic and one more design, looked at. `pnpm ui:rate` is for main screens; this adds a view behind a menu and one menu row, so it is not run unless the owner asks.

## As built

- `packages/core/src/original.ts`: `describeOriginal` (the bounded view and its summary), `authenticationResults`, the bounds and the RPC's result type.
- `packages/mail/src/gmail-original.ts`: `decodeGmailRaw`; `gmail-api.ts` `readOriginal` (`responseMode: "original"`, reader lane, 404 → null); `imap.ts` `readOriginal`; `demo.ts` a made-up original.
- `packages/backend/src/originals.ts`: `Originals` (reads, kept bytes, pieces, close, idle, account removal, failures said plainly); `core.ts` `readOriginal`; three renderer-only handlers.
- `apps/web`: `components/original-message.tsx` (`OriginalHost`, the view, `Summary`, `Code`: text in blocks laid out with `content-visibility: auto`), `lib/original.ts` (reading, download), `saveBlob` shared with attachments, the menu row in `message-menu.tsx` (its focus handed to Back through `finalFocus`), the `Code` icon.
- Tests: `original.test.ts`, `gmail-original.test.ts` (decoder and the Gmail provider), `originals.test.ts`, two cases in `imap.int.test.ts` (exact source in pieces, gone, a changed UIDVALIDITY), `e2e/original-message.spec.ts` (@variant: Classic, Lumen's sender card, Atelier); `copy-thread.spec.ts` lists the new row.
- Screenshots of the menu and the three parts, light and dark, looked at: the tabs' hairline was inset to the summary's.
