# Plan 212: open an attachment, download it from its menu

- **Status:** built.
- **Builds on:**
  - plan 29, mail attachments (the store's chunked bytes, `attachmentBlob`);
  - plan 177, the conversation's files strip above the first message;
  - plan 107, a file main writes for the page (`mbox-export.ts`), and plan 41's `trusted` sender check;
  - plan 106, ⇧F10 opens the right-click menu of what has focus (`data-context-menu`).

## The request

> for attachments that are pdfs, images and things that can be previewed (not video) we should have a way to preview them on the app, at least images, for pdfs we should try to open them so the OS decides how to open them, for example macos would open them using their PReview tool, or maybe lets just always let the OS preview them, but not download them, lets have a download available on the right click menu.

The screenshot shows the conversation's files strip (plan 177). Choosing any file there, or a message's file tile, downloads it.

## What exists

- `apps/web/src/components/attachments.tsx`:
  - `ReaderAttachments` draws a message's tiles, and `ThreadAttachments` draws the conversation's strip.
  - Both call `useAttachmentOpen().open`, which downloads the file or, when the bytes aren't on this device yet, asks the backend to fetch them (`attachments.retry`).
  - Each file is a single button named "Download {name} {size}".
- `apps/web/src/lib/attachments.ts`:
  - `attachmentBlob` reads the store's chunks over RPC, checking the size, type and name against the backend's `attachments.info`.
  - `downloadAttachment` clicks an `<a download>`. On desktop, Electron shows its default save panel.
- Main already writes files the page hands it (the PDF export, the mbox export), always behind `trusted(event)`. The packaged smoke tests send those files to `testPdfDir` and show no panel.
- There is no right-click menu on a file. A right-click there opens the conversation's menu (`MessageMenu`).

## Design

### 1. Which files open

Opening hands the file to the OS. The OS picks the app by the file's extension, not its declared type, so the extension decides.

A new `packages/core/src/attachment-open.ts` exports `opensInPlace(filename)`. It reads the extension of the cleaned name (`attachmentFilename`), case-insensitive, and matches it against a closed list of document types:
- **PDF:** `pdf`.
- **Images:** `png`, `jpg`, `jpeg`, `gif`, `webp`, `heic`, `heif`, `tif`, `tiff`, `bmp`.
- **Text:** `txt`, `csv`, `rtf`.
- **Documents:** `docx`, `xlsx`, `pptx`, `pages`, `numbers`, `key`.

These types are never on the list:
- **Video and audio**, as the request says.
- **Types that run code:** apps, scripts, installers, `.command`, `.terminal`, `.jar`.
- **Types that could:** macro formats (`doc`, `xls`, `ppt`, `docm`, `xlsm`) and the web's (`html`, `svg`, `xml`). The web's would open in a browser and could load remote content (plan 37).
- **Types whose default app acts on them:** `ics` adds to Calendar, `vcf` to Contacts, `eml` opens Mail and archives get extracted.

Everything else keeps today's behaviour: choosing it downloads it.

### 2. What a file does

- **A click, Enter or Space:** a file that opens in place opens. Any other file downloads, as today.
- **A right-click or ⇧F10:** opens the file's own menu, and not the conversation's (`stopPropagation`, as the person chip does). The menu has:
  - **Open:** only for a file that opens in place;
  - **Download:** for every file.
- **Not on this device yet:** choosing it asks for the bytes (`attachments.retry`) whichever item was picked, as today.
- **Names:**
  - a file that opens is named "Open {name} {size}", and one that doesn't keeps "Download {name} {size}";
  - `aria-description` keeps the file's type;
  - a menu item is just "Open" or "Download".
- **The tile's trailing glyph:**
  - a file that opens has none: Mail's tiles show none either, and the menu offers Download;
  - a file that only downloads keeps the download icon, since that's what a click does.
  - The strip has no trailing glyph today, and stays that way.

The menu is one component, `AttachmentMenu`, used by both the tile and the strip. It is built on `ContextMenu` from `@terno/ui` (BoardUI). Like `folder-rows`, it sets `setApp({ menuOpen })` while open, so the reader's shortcuts wait.

### 3. Opening on desktop

The page reads the bytes as it does today (`attachmentBlob`, which checks them against `attachments.info`). It then hands them to main once: `ternoDesktop.openAttachment(name, bytes)`, an `ArrayBuffer` of at most 18 MB (`MAX_ATTACHMENT_BYTES`).

Main does the rest in a new `apps/desktop/src/attachment-open.ts`, registered beside `registerPrint` (`terno:open-attachment`):

1. **Check:**
   - the sender is `trusted`;
   - the name is a string;
   - the bytes are an `ArrayBuffer` or `Uint8Array` of at most `MAX_ATTACHMENT_BYTES`;
   - `attachmentFilename(name)` passes `opensInPlace`.

   Main checks this itself, so a page that skips the check still can't hand the OS an app.
2. **Clear old copies:** it removes copies under `<userData>/Opened Attachments/` older than 24 hours. A crashed run's copies go on the next open, and nothing runs at launch or while idle.
3. **Write:**
   - the path is `<userData>/Opened Attachments/<random 16 hex>/<cleaned name>`, a new directory per open, so two files with one name never collide and a stale viewer never sees another file;
   - the file is created exclusively (`wx`, 0600) and written in full.
4. **Mark it:**
   - On macOS, it sets `com.apple.quarantine` (`/usr/bin/xattr -w`, `0081;<hex seconds>;Terno;`). Downloads carry the same mark, and Office uses it to open in Protected View. If it fails, the open still goes ahead, since only the document types above get this far.
   - Then it makes the file read-only (0444). An edit in Preview asks to duplicate instead of saving into a copy that's cleared a day later, so the user's work is never lost.
5. **Open:**
   - Main calls `shell.openPath(path)`.
   - Electron reports a failure as a non-empty string. That means no app on this Mac opens the file, and main returns `{ status: "no-app" }`.
   - Otherwise it returns `{ status: "opened" }`.
   - Under `testPdfDir` (the packaged smoke), main writes into that directory, does not call `shell.openPath`, and returns `opened`.

What the page says:
- **opened:** nothing; the app comes forward.
- **no-app:** a snack: "No app on this Mac opens {name}. Download it from its menu instead."
- **failed** (a bad name, size or disk error): a snack: "Couldn't open {name}. Try again, or download it from its menu."

A shell older than this has no `openAttachment`, and the page downloads instead.

### 4. Opening on the web (parity)

A browser can't hand a file to the OS, but it can show a PDF or an image itself. The web build opens those in a new tab:
- **Which files:** `opensInBrowser(filename)` is a stricter subset of the list: `pdf`, `png`, `jpg`, `jpeg`, `gif` and `webp`.
- **The blob's type** comes from the extension, never from the message (`application/pdf`, `image/png`, …). A blob URL shares the app's origin, so a type the message chose (`text/html`, `image/svg+xml`) could run script there. These types never do.
- **The tab** opens synchronously in the click (`window.open("", "_blank")`) so pop-up blocking doesn't apply. Once the bytes arrive, the tab's `opener` is cleared and it goes to the blob URL. The URL is revoked a minute later.
- **If the read fails,** the tab closes and the snack says so.
- **Every other file** downloads on the web, as today.

`apps/web/src/lib/attachments.ts` gets:
- `canOpenAttachment(filename)`: the desktop's rule when a desktop bridge exists, otherwise the browser's;
- `openAttachment(accountId, ref)`.

The UI only asks those two questions.

### 5. What doesn't change

- The composer's attachment chips. A draft's own files aren't part of the request.
- The backend and its RPC contract. The bytes travel as they do for a download.
- Inline images in a message body.

## Tests

- **Core unit** (`attachment-open.test.ts`):
  - the list, case-insensitively;
  - a double extension (`invoice.pdf.app`) doesn't open;
  - a name with no extension, or only a dot, doesn't open;
  - a path in the name is cleaned first;
  - the browser rule is a subset of the OS rule.
- **Desktop unit** (`attachment-open.test.ts`, Electron mocked as in `print`'s tests):
  - an untrusted sender, a refused extension and an oversized buffer are refused, and nothing is written;
  - a good request writes a read-only file under its own directory with the bytes intact, and opens it;
  - copies older than a day are removed and newer ones kept;
  - `openPath`'s error string becomes `no-app`;
  - under `testDir`, nothing is opened.
- **Web e2e** (`reader.spec.ts`'s attachments scenario, extended, with no new page):
  - a cached PDF's strip file is named "Open …";
  - a right-click shows Open and Download, and not the conversation's menu;
  - Download fires a download with the file's name;
  - a click opens a tab (`context.waitForEvent("page")`);
  - a `.fig` file's click still downloads, and its menu has only Download;
  - ⇧F10 on a focused file opens its menu;
  - axe runs with the menu open.
- **Unit tests for `attachments.tsx`** aren't needed beyond what e2e covers.

## Performance and resources

- Nothing runs until a file is opened:
  - no timers;
  - clearing old copies happens only when the user opens a file;
  - the menu mounts on right-click (Base UI).
- Disk is bounded: copies live a day at most and are cleared on the next open, at most 18 MB each.
- No network: the bytes are already on the device.
- No hot path is touched: the reader's render is the same buttons, wrapped in a trigger.

## Out of scope

- A Quick Look panel inside the app (`BrowserWindow.previewFile`, Space on a focused file). It would be a natural follow-up, macOS-only.
- Thumbnails of image attachments.
- Opening a draft's own files.

## Revisions after the Codex review

Codex critiqued the plan against the code in 12 points. All 12 are taken, and they change the design above as follows:

1. **The quarantine mark fails closed.** If `xattr` fails or takes longer than 5 s, the file is not opened: it is removed, and main answers `failed`. `xattr` runs through `execFile`, with arguments and no shell. "No network" now reads "Terno itself reaches nothing"; what the app that opens the file does is that app's business, which is the same as for a download.
2. **The copies stay private:**
   - The root `Opened Attachments` is created 0700 and must be a real directory: `lstat`, never a link.
   - Each open gets its own directory from `mkdtemp`, which is exclusive, random and 0700.
   - The file is written `wx` 0600, then set to 0400, owner-read only.
   - Cleanup lists the root's entries without following links and removes only directories it can recognise by their `mkdtemp` prefix.
3. **Disk has a hard bound.** At most 8 copies are kept. Each open first removes copies older than a day, then the oldest ones until 7 remain, so worst case is 8 × 18 MB. A copy whose write, mark or open fails is removed at once. A viewer that still has a removed copy open keeps reading it, since macOS keeps an open file alive.
4. **Main takes one open at a time.**
   - A second request while one runs gets `busy`, before anything is written.
   - The name is refused over 1,000 characters, before it is cleaned.
   - The bytes are copied exactly from a typed view's `byteOffset` and `byteLength`.
5. **One menu per list,** not per file. The list (`ul`) is the `ContextMenuTrigger`, marked `data-context-menu`. On right-click it finds the file under the pointer (`closest("[data-attachment]")`):
   - **On a file:** it remembers that file and calls `stopPropagation`, so the conversation's menu stays shut.
   - **Off a file** (a gap between files): it calls `preventBaseUIHandler` and lets the event go on to the conversation's menu.

   ⇧F10 already dispatches a `contextmenu` on the focused button (`openFocusedMenu`), and that event bubbles to the list. Each file stays a plain `<button>`, so a click, Enter and Space are untouched. This also answers Codex #12: a list costs one Base UI root, not twelve.
6. **Focus.**
   - The buttons are no longer `disabled` while work runs. `open` returns early while busy, and the busy file says so through `aria-busy` and is dimmed. Focus never lands on a disabled button.
   - The menu's `finalFocus` is the file it was opened on, while that file is still on the page.
   - `menuOpen` is cleared on unmount, as in `FolderMenu`.
7. **The web tab** is reserved before any `await`, by the click or the menu item:
   - **If it's `null`** (blocked), the file downloads instead.
   - **Its `opener`** is cleared at once.
   - **If the user closed it** before the bytes came, nothing more happens.
   - **If the read fails,** the tab closes and the snack says so.
8. **Blob URLs aren't revoked on a timer.** The web build keeps the last 3 preview URLs and revokes the oldest when a 4th opens, at most 54 MB held. A PDF left open for an hour still saves and prints.
9. **What a file can do follows the bridge itself:**
   - `canOpenAttachment` is the desktop rule when `ternoDesktop.openAttachment` exists;
   - it's false on a desktop shell without it (Electron denies pop-ups, `app.ts:752`);
   - it's the browser rule when there is no bridge.

   The label, the glyph, the menu and the action all follow the same answer.
10. **Errors are general and platform-neutral.**
    - Any `openPath` error, or a rejection, is `failed`.
    - The copy reads "Couldn't open {name}. Download it from its menu instead." It doesn't claim a missing app or name the Mac.
    - `busy` says nothing, since a click is already running.
11. **Tests seed real bytes.**
    - **e2e** extends `attachment-controls.spec.ts`. Its fixture already stores bytes (`msg({ attachments: [{ bytes }] })`), so it gains a cached PDF. Download checks the downloaded file's name and bytes. The new tab must reach the `blob:` URL, not just open.
    - **Library unit tests** (`attachments.test.ts`) cover a hostile declared type (`text/html` on `x.png` gives a blob of `image/png`), a blocked tab, a closed tab, a failed read and the 3-URL cap.
    - **The packaged smoke** (`incoming.smoke.ts`, which already ingests attachments) goes through the real preload, IPC and file path under `testPdfDir`: a `.pdf` is written with its bytes and mode 0400, and a `.bin` sent straight to the bridge is refused.
12. **Verification:**
    - typecheck and lint;
    - `en` and `es` strings together;
    - light and dark screenshots of the strip and a tile with the menu open, looked at beside their neighbours;
    - `pnpm ui:rate`/`ui:gate` on the reader screen.

    Render cost: one `ContextMenu` root per list, the popup not mounted until opened (Base UI), and no new state per file. The reader has no perf gate on attachments, so this is argued here, not measured.

## Codex code review

Codex reviewed the first three commits, `0c237e0ff..fef369cea`, and reported three findings. All three are fixed. Each fix has a regression test, and each test was checked to fail without its fix.

1. **A long press could act on the wrong file.**
   - **The bug:** Base UI opens a touch long press itself, without a `contextmenu` event. So the menu kept the file a right-click had picked before, or had none.
   - **The fix:** the list now picks the file on `touchstart` as well. A touch between files is left to the conversation's own long press.
   - **Test:** `thread-overview.test.tsx`, "a long press picks the file under the finger".
2. **A long name in a many-byte script couldn't be written.**
   - **The bug:** filesystems limit a name to 255 bytes. The cleaned name is limited in characters, so ninety `報` and `.pdf` made 274 bytes, and the exclusive create failed.
   - **The fix:** `diskName` shortens the stem by whole characters until the name is at most 200 UTF-8 bytes. The extension is kept, so the OS still opens it with the same app.
   - **Test:** `opened-attachments.test.ts`.
3. **A busy list's menu offered items that did nothing.**
   - **The bug:** while one file's work ran, Open and Download in the menu stayed enabled. Choosing one only closed the menu.
   - **The fix:** the list's busy state now reaches the menu, and its items are `disabled`, as the files are `aria-disabled`.
   - **Test:** `thread-overview.test.tsx`, "while one file's work runs, its items say they're unavailable".

## Verification

- typecheck (web, desktop, core, i18n) and lint;
- unit tests: `attachment-open.test.ts`, `opened-attachments.test.ts`, `attachments-open.test.ts`, `thread-overview.test.tsx`, plus the source scan, the architecture check and i18n;
- e2e: `attachment-controls.spec.ts`, `reader.spec.ts` and `attachments.spec.ts`;
- the desktop bridge through the real preload, IPC and file path: `print.smoke.ts`, plan 212's test, run against `dist` (`TERNO_PRINT_SMOKE_DEV=1`);
- light and dark screenshots of the strip and the tiles with the menu open.

## Follow-up: a Download button on hover

> can we have a button to download that shows on hover on the right?

- **Files that open:** a file that opens shows a Download icon button at its right, on hover or on its own Tab focus. The button is named "Download {name}", and it comes after the file in Tab order.
  - **In the strip,** the file's size steps aside (fades out) and the button takes its place. Nothing moves, and no letter is cut: an earlier version that faded the button over the size left half a number showing.
  - **On a tile,** it sits in the trailing slot. The text leaves that slot free (`pe-11`).
- **Files whose click downloads** show the download glyph in that place instead of a second control that would do the same thing. On a tile the glyph shows at rest; in the strip it shows on hover.
- **Hover** now belongs to the file as a whole, not its button, so the hover background holds while the pointer is on Download. The button carries `data-attachment`, so a right-click on it opens the file's menu.
- **Codex code review:** one finding, fixed. The hidden button still took the pointer, so on a touch screen, which never hovers, a tap at a file's end downloaded it instead of opening it. The button now takes the pointer only while it shows (`SHOWN_ON_HOVER`), and Tab still reaches it. The e2e checks `pointer-events` at rest and on hover, and that check was confirmed to fail without the fix.
