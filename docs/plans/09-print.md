# Plan 09: printing and PDF

- **Status:** shipped (§10).
- **Builds on:** 7b65035 (the rename to Terno shipped).
- **Request:** "Nice print options, ability to print with only the contents of the email and not the metadata like title, sender, etc., allow PDF prints. Have tests and visually verify the quality of the prints."

## 1. What exists

Nothing. The desktop menu has no File menu, so ⌘P does nothing, and printing the window from Chromium would print the app UI. The reader renders HTML mail in sandboxed iframes, with no scripts, styled with theme colors. Some bodies may still be `null` while sync downloads them.

## 2. User-facing design

### Entry points

| Where | What |
|---|---|
| ⌘P (`thread.print`, `mod+p`) | Opens the print sheet for the thread in the reader. Does nothing when no thread is open. |
| Desktop menu: new **Archivo** menu | "Imprimir…" ⌘P and "Exportar como PDF…" ⇧⌘P (`thread.exportPdf`). Each sends a command to the renderer over IPC, so the menu never prints the app window. Opening the sheet when it's already open is a no-op, so a key event and a menu accelerator for the same press can't open it twice. |
| Reader toolbar | A Printer icon after the reply group. Tooltip "Imprimir ⌘P". |
| Thread context menu | "Imprimir…". Only when exactly one thread is targeted; there is no multi-thread printing in v1. |
| A message in the reader | Right-click → "Imprimir este mensaje…" / "Exportar mensaje como PDF…". Opens the sheet scoped to that message. |
| ⌘K palette | "Imprimir conversación" and "Exportar como PDF". |
| Shortcuts dialog | Both shortcuts listed. |

### The print sheet

The print sheet is a dialog, about 920×640. Printing is a modal, Apple-sheet-style task; the inline-only rule covers composing, not printing.

- **Left: live preview.** The real print document, in a sandboxed iframe, drawn as white paper at the selected paper width, scaled to fit, on a `tint` backdrop with a soft page shadow. It scrolls continuously. On desktop, a caption shows the exact page count, taken from a background `printToPDF` that is debounced and drops stale results. On the web the caption is omitted.
- **Right: options.** Inset-grouped like General, each control with an accessible name:
  - **Alcance:** "Toda la conversación (N)" / "Solo este mensaje". This shows only when the conversation has more than one message. From ⌘P, "this message" means the last one; from a message's menu, it means that message.
  - **Contenido:** "Con encabezados" / "Solo el contenido".
    - Con encabezados: the subject once at the top, then per message: sender name and address, full date, Para, Cc, and attachment names.
    - Solo el contenido: only the bodies. No subject, no names, no dates, no attachment list, no page footer. Messages are separated by whitespace and one hairline.
  - **Texto citado:** Ocultar / Incluir. The default is Ocultar for a whole conversation, because otherwise every reply reprints the history, and Incluir for a single message. Hidden means:
    - plain text: the `>` run and its "escribió:"/"wrote:" line, with the same rule as `TextBody`
    - HTML: `.gmail_quote`, `blockquote[type=cite]`, `#appendonsend`, and the Outlook `divRplyFwdMsg` block plus everything after it
  - **Papel:** Carta / A4. The default comes from the locale region: US, CA, MX and the other Letter countries get Carta. It is used for the PDF and the preview. The system print dialog keeps its own choice.
  - **Imágenes remotas:** follow the reader: printed only where the reader would load them (the setting or the per-message "Cargar contenido"), and never in local mode. A short note says so when some are blocked.
- **Footer buttons:** "Guardar PDF…" (secondary) and "Imprimir…" (primary, Enter). Esc closes. While printing or saving, both are disabled and show a spinner.
- **Remembered:** Contenido, Texto citado and Papel persist in `localStorage` (`terno:print`). Alcance always starts from the entry point.
- **Bodies not downloaded yet:** the sheet asks for the thread again. If a body is still missing, its message prints "Contenido aún no descargado", and the sheet shows a warning row naming how many are missing. It never prints a loading placeholder silently.

### Outcomes

| Action | Desktop | Web |
|---|---|---|
| Imprimir… | The macOS print dialog for a hidden window holding the print document. That dialog also has the system "PDF" menu. | `print()` on the preview iframe. The browser's dialog includes "Save as PDF". |
| Guardar PDF… | A save panel opens first, with `Downloads/<subject>.pdf`. Then `printToPDF` runs and the file is written atomically. A toast says "PDF guardado" with "Mostrar en Finder". | The print dialog opens with a hint row: "Elige «Guardar como PDF» como destino". `document.title` is set to the subject during the print, so the suggested file name is right, and restored on `afterprint`. |

## 3. The print document

It is built by `apps/web/src/lib/print.ts`, a pure function:

```ts
buildPrintDocument(input: { subject: string; messages: PrintMessage[]; account?: string }, options: PrintOptions): string
```

- It is always paper: near-black text on white, whatever the app theme. It uses the system font stack (SF on Mac). Sizes are in points: body 10.5pt/1.5, header labels 9pt in grey, subject 16pt semibold. Links are dark blue and underlined.
- Each HTML body goes through DOMPurify with the reader's config: no `<style>`, no `srcset`, no scripts, no event handlers. Remote `img`s are removed when not allowed, and their alt text is kept. The CSP matches the reader's `csp(allowRemote)`.
- Layout:
  - `@page { size: <paper>; margin: 18mm 16mm }`
  - message headers: `break-inside: avoid` and `break-after: avoid`
  - `img { max-width: 100% }`
  - `pre` and plain text use `white-space: pre-wrap`
  - `overflow-wrap: anywhere`
- **Fit pass:** after the preview frame loads, the parent measures each HTML body, which is allowed because the frame is same-origin and runs no scripts. A body wider than the printable width gets a CSS `zoom` that brings it down to that width. No mail is cut off at the right edge. The document that is printed or turned into a PDF is the fitted one: the preview's `documentElement.outerHTML` after the pass.
- **PDF footer:** with headers, the PDF footer is "subject · N / M" in 8pt grey, through `displayHeaderFooter` and the templates. Content-only has no footer.
- **No branding.** The file name is the subject, sanitized and length-capped, falling back to "Correo".

## 4. Desktop main

`apps/desktop/src/print.ts`, registered from `app.ts`:

- **`terno:print` (`ipcMain.handle`).** Takes `{ html, action: "print" | "pdf", pageSize: "Letter" | "A4", title, footer, allowRemote }`. Checks:
  - the sender is the main window's webContents
  - `html` is a string under 64 MB
  - every enum is validated
- **The hidden window:** `BrowserWindow({ show: false })` with sandbox on, `javascript: false`, `contextIsolation: true`, and a dedicated in-memory partition `terno-print`.
  - The document is served by `protocol.handle` on that partition, from memory, not as a data URL (size limits) and not as a temp file.
  - `webRequest.onBeforeRequest` cancels everything except the document itself, and except `http(s)` image requests when `allowRemote` is set.
  - `will-navigate` is prevented and window opening is denied.
  - The window is destroyed after the job, and after a 20 s timeout.
- **`print`:** `webContents.print({ silent: false, printBackground: true })`. The result is "printed / cancelled / failed".
- **`pdf`:**
  - The save dialog opens first; cancel returns `cancelled`.
  - Then `printToPDF({ preferCSSPageSize: true, printBackground: true, displayHeaderFooter, footerTemplate })`.
  - The file is written to `<path>.tmp` and renamed into place.
  - Only the path that was just saved can be shown in Finder, through `terno:show-saved` with `shell.showItemInFolder`.
- **`terno:print-pages`:** returns the page count for the preview caption. It reuses the same window code, with no dialog.
- **Test hook:** with `TERNO_TEST_PDF_DIR` set and the app not packaged for release (or with the smoke flag), the save dialog is skipped and the file goes to that directory. This exists only for the packaged smoke.
- **Preload:** `print(job)`, `printPages(job)` and `showSaved()`, plus `onCommand(cb)` for the menu commands. Only `thread.print` and `thread.exportPdf` are whitelisted.

## 5. Privacy and safety

- The print document never leaves the machine. The hidden window's session allows no network except remote images the user already allowed, and in local mode it allows none at all.
- A sanitized, script-less document is used everywhere: the preview iframe sandbox is `allow-same-origin allow-modals`, without `allow-scripts`, and the desktop window runs with JS off.
- Subjects, names and addresses are HTML-escaped. There is a unit test for each.

## 6. Performance

- The sheet is `React.lazy`, so the main chunk only gains the command and the menu entries. A bundle-size check exists, and a test asserts the print code isn't in the entry chunk.
- `buildPrintDocument` for a 100-message thread runs in under 30 ms in a perf test.
- Option changes rebuild the preview after a 120 ms debounce. The page-count `printToPDF` is debounced at 400 ms and cancelled when stale.
- Nothing runs until the sheet opens.

## 7. Tests

- **Unit, `print.test.ts`:**
  - both content modes: content-only has no subject, address, date or "Para"
  - escaping of a hostile subject or name
  - DOMPurify applied: no `script`, no `on*` attributes
  - remote images dropped or kept by `allowRemote`
  - quoted-text removal for text and for each HTML pattern
  - attachment list only with headers
  - `@page` size per paper
  - the paper default by locale
  - file-name sanitization
  - the 100-message timing
- **Desktop unit:**
  - job validation: sender, size, enums
  - the request filter: the document is allowed; remote images only with `allowRemote`; every other request is cancelled
  - the menu sends whitelisted commands
- **e2e, web fixture, `print.spec.ts`:**
  - ⌘P, the toolbar, the thread menu, the message menu and the palette each open the sheet with the right scope
  - switching to content-only removes the headers from the preview frame
  - quoted text toggles
  - paper changes the preview width
  - Imprimir calls `print()` on the preview frame (stubbed) and the title is restored afterwards
  - axe on the sheet in light and dark
  - focus returns to the opener
- **Print quality, e2e:**
  - Fixtures: a long plain-text thread with quotes, a 600px newsletter, a 1000px-wide table mail, CJK and emoji, very long URLs, and inline images.
  - Each fitted document goes through Playwright `page.pdf()` in both papers and both modes and is parsed with `pdfjs-dist`. Assertions:
    - page count within bounds
    - expected text present
    - header text absent in content-only
    - no text item outside the printable box, so nothing is clipped at the right edge
  - Visual baselines: `emulateMedia({ media: "print" })` screenshots of the fitted documents.
- **Packaged smoke:** export a PDF through the real `printToPDF` path into `TERNO_TEST_PDF_DIR`, check the `%PDF` header, a page count above 0, and the expected text.
- **Manual visual check:** desktop PDFs of the fixtures and of a real seeded thread, in both modes and both papers, rendered with `pdftoppm` and inspected. The PNGs go to the scratch directory.

## 8. Out of scope

- Printing several threads at once.
- Printing attachments.
- Print-only custom headers or footers.
- A paged preview on the web.

## 9. Revisions after the Codex plan review

These revisions override the sections above where they conflict. The full review is in `/tmp/unica-scratch/plan-09-codex.txt`.

1. **Remote-image consent is per message.** "Cargar contenido" moves from `HtmlBody`'s local state into a small store keyed by message id: `remoteAllowed`, kept for the session.
   - The print builder strips remote resources from every message that isn't allowed. Allowed means the setting is "always" or the message is in the set, and local mode is off.
   - Main enforces local mode on the print session itself, using the same source of truth as the existing `defaultSession` backstop in `app.ts`. When local mode is on, every non-document request is cancelled, including requests already in flight.
2. **Native print from a hidden window must be proven on the pinned Electron version first.** Test cancel, no printer configured, and the system PDF menu, and keep a fallback to a visible print window.
   - There is no destroy timer while the native dialog is open. The 20 s limit applies only to loading the document.
   - The result is reported as "submitted" or "cancelled" or "failed", never "printed".
3. **One command policy.** Menu IPC commands go through the same dispatcher as keyboard commands, with the same eligibility rules: no thread open, a modal open, composing, lifecycle-inert. It is tested with real native accelerators, including while focus is inside a mail iframe.
4. **Sessions and jobs.**
   - The protocol handler is registered with `session.fromPartition("terno-print").protocol.handle(...)`, never the global `protocol`.
   - The protocol handler and the `webRequest` filter are each registered once and look up an immutable job by its URL, `terno-print://job/<random id>`.
   - Jobs are serialized: one at a time. Document buffers are released when the job ends, and the session's storage is cleared.
5. **Main owns the trust boundary.**
   - The sender must be the main window's top frame, on the trusted app URL.
   - Main adds the CSP `<meta>` itself and builds the footer template itself from an escaped, truncated subject.
   - Permissions and downloads are denied on the print session.
   - Only the job's exact document URL is served. Remote images are allowed only for an allowlist of URLs that the renderer extracted from approved messages, and redirects are checked against the same policy.
   - The print window has no preload and no backend port.
6. **Readiness.**
   - The desktop window keeps JS off and attaches its `did-finish-load` and `did-fail-load` listeners before it navigates.
   - In the renderer, the preview enables the buttons only after `document.fonts.ready`, every `img` has decoded or failed (`loading="lazy"` attributes are stripped), and the fit pass has run. Each of these waits has a bounded timeout.
7. **Fitting.**
   - The document has a fixed printable-width wrapper per paper size: Letter is 8.5in minus the margins, A4 is 210mm minus the margins. That gives a definite width on screen, independent of `@page`.
   - Fitting is reset on every rebuild, and the preview's scaling stays outside the document.
   - The minimum zoom is 0.5. Past that, the body keeps its zoom and wraps with `overflow-wrap`, and the content at the right edge is allowed to break onto new lines, never clipped.
   - The serialized output keeps `<!doctype html>`.
8. **PDF options.**
   - `headerTemplate: "<span></span>"` whenever there's a footer.
   - Explicit bottom margin space for the footer.
   - Paper and margins are identical for preview and export.
9. **Web print.**
   - The iframe's `<title>` is the subject. The outer `document.title` is swapped too and restored in a parent-owned `finally`, on `afterprint`, after a timeout, and on unmount.
   - The hint row also says to turn off the browser's "Encabezados y pies de página" for a clean page.
   - The content-only file name is still the subject: the name is the user's choice in the dialog. The PDF metadata title is the subject only in headers mode; content-only uses "Correo".
10. **Targets and data.**
    - The sheet stores immutable `{ threadId, messageId? }` when it opens and refreshes with `loadThread(id, true)`.
    - A fetch error is shown separately from missing bodies.
    - `cid:` images are dropped and their alt text kept: attachment content isn't fetched.
    - "Ocultar texto citado" removes only a *trailing* quoted block. Interleaved inline replies are kept whole, and there are fixtures for that.
    - Right-click inside an HTML mail frame is wired by a `contextmenu` listener on the frame document, like the click handler, so "Imprimir este mensaje" works there too.
11. **Quality tests rasterize real PDFs.**
    - The PDFs come from Playwright `page.pdf()` on web and from Electron `printToPDF` in the packaged smoke.
    - The pages are rendered in a Playwright browser page with `pdfjs-dist` (pinned, rendering to a canvas inside Chromium, so there is no native canvas in Node) and compared with `toHaveScreenshot` baselines.
    - The tests also assert the page dimensions per paper size, check that the text is there, check that header text is absent in content-only, and check that no text item lies outside the printable box.
12. **Simpler lifecycle.**
    - The live page count is dropped from v1.
    - The PDF is written to an exclusive, randomly named sibling temp file with mode 0600, renamed into place, and the temp file is removed in `finally`.
    - "Mostrar en Finder" is tied to the export that produced that file.

## 10. As shipped

Commits `8866856..3701dba`, plus this note.

### The hidden-window print proof

Run first, on Electron 45.0.0, macOS (Darwin 25.6), with a scratch app: a `show: false` window on an in-memory partition, its document served by `session.fromPartition(...).protocol.handle`, JS off.

- `printToPDF` from the hidden window works, and is what every export uses.
- `webContents.print({ silent: false })` on this Mac, which has **no printer configured**, never shows a dialog. Electron fails it at once with "No printers available on the network", and the callback returns cleanly. A visible window behaves the same, so the visible-window fallback was not built: it would change nothing here.
- The sheet maps that failure to "No hay impresoras configuradas" and points to «Guardar PDF…». The packaged smoke checks this whenever `lpstat` lists no printer.
- Not exercised: the dialog itself (cancel, the system PDF menu). Adding a printer changes the Mac's system configuration, so I left it alone. The code holds no timer while the dialog is up, and reports "submitted", "cancelled" or "failed".

### Departures from the plan

- **Fitting zooms only the block that runs over**, such as a 1000px table, instead of the whole body, so the text around it keeps its size. If something still runs over, the whole body is zoomed as before. MIN_ZOOM is still 0.5, and past it the content wraps.
- **Page breaks.** A message shorter than a third of a page is kept on one page, and paragraphs keep three lines on each side of a break. The first PDFs showed a signature stranded alone on a page.
- **Images that can't load** in the page print as their description, like `cid:` images: relative sources and unknown schemes. Before, they printed a broken-image icon.
- **One quote rule.** `lib/quote.ts` is shared with the reader, so `TextBody` now folds only a trailing quote too. An inline reply is no longer hidden behind "•••".
- **The sheet.**
  - The scope reads "Conversación (N)" / "Solo este mensaje"; "Toda la conversación (N)" doesn't fit a segment.
  - The options are a macOS segmented control (a track with the chosen segment raised): with outline toggles on the tint group, the chosen state couldn't be seen.
  - The buttons stay focusable while the preview settles, so focus starts on the action of the entry point (Return prints, or saves after ⇧⌘P).
  - The preview dims while a rebuild is pending.
- **Print inks** live in `packages/ui/src/themes/print.ts`, with a contrast test: every text ink is AA on white. App code holds no literal colors.
- **Right-click in a message.** On the web, the browser's own menu stays for selected text, links and images. On the desktop, which has no other menu there, it's always the message menu.
- **Web «Imprimir…»** closes the sheet when `print()` returns: the page can't tell a print from a cancel.
- **The footer** puts the subject on the left and "N / M" on the right, both 8pt grey and aligned with the text.
- **`TERNO_TEST_PDF_DIR`** is honored only in an unpackaged build or with the demo mailbox, never for real mail in a release.
- **The 100-message timing** is a gate in `test:ui-perf` (Chromium, production build): about 9 ms p95 against 30 ms. DOMPurify needs a DOM, and jsdom timings aren't representative. The unit tests run `print.ts` on jsdom.
- **Fixtures** live in `@terno/mock-data` (`printFixtures`). The e2e suites ingest them into each test's own backend, so no other test's counts or baselines moved. `seed.ts --print-fixtures` seeds them into a profile for the desktop checks.

### Verification

- **Real desktop PDFs.** The print smoke exported every fixture plus a seeded demo conversation, in both modes and on both papers, through Electron's `printToPDF`: 36 PDFs, 47 pages, first from the dev build and then from the packaged app. I rasterized them with `pdftoppm -r 70` and inspected them; the scratch PNGs are in `/tmp/unica-scratch/print-09/`. They showed the three problems fixed in `85a8515`. After the fixes, the pages are:
  - clean, with near-black text on white in either app theme;
  - free of clipping;
  - showing no header text at all in content-only;
  - wrapping CJK, emoji and long URLs inside the margins.
- **The sheet**, screenshotted at 1440×900 @2x in light and dark.
- **Test runs:**
  - `pnpm test`: 1,433 + 390 (db-wasm).
  - `pnpm test:e2e`: 198, of which 9 are in `print.spec.ts` and 8 in `print-quality.spec.ts` (43 PDF-page baselines).
  - `pnpm test:web`: 27.
  - `pnpm test:ui-perf`: 16/16.
  - `pnpm test:perf`: 102.
  - `pnpm test:smoke` on the packaged app: 21, of which 12 are print.

### Known limitations

- The native print dialog wasn't exercised (see above).
- On the web, the browser's own headers and footers can only be turned off by the user; the hint says how.
- A newsletter's table rows can't split, so a page may end early, with the rest of its background showing.
- The web preview is one continuous sheet, not paged, and there is no page count (both dropped from v1).

### After the Codex code review (7 findings)

- **Remote content** is stripped per message by allowlist. Every attribute that can fetch keeps only `data:`, or absolute http(s) where the message may load remote content. The same goes for every `url()` in styles and SVG attributes; `image-set()` and CSS escapes go, and media, links, frames and objects are forbidden. The URL list main allows comes from approved messages only. An e2e intercepts requests under mixed consent and sees none for the blocked message.
- **The hidden window.** One that fails to load is destroyed on the spot. After `dom-ready`, images get 5 s, then the page prints what arrived.
- **The preview's deadline** runs from navigation (4 s). Images still loading then print as their description.
- **Outlook quote detection** is linear: no suffix copies.
- **PDF names** are cut at 200 UTF-8 bytes on grapheme boundaries. The temp file is `.terno-export-<random>.tmp`.
- **The sheet** builds once changes settle (it counts builds in test builds). Below 768 px it stacks, and the buttons stay pinned in view.
- **Two regressions** turned up and were fixed. A `data:` SVG was rewritten by the `url()` rule; the print-quality baselines caught it. The preload imported `node:path`; the packaged smoke caught it, and the desktop build now fails if the preload requires anything but electron.
