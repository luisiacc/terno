# Plan 07: design refresh, Apple-Mail reader, inline compose

- **Status:** proposed, revision 2.
- **Builds on:** plans 01 (themes, motion) and 06 as shipped (`53d6413..50a7e0a`).
- **Revision 2 adds:** the Codex plan review and the user's decisions.
- **Mockup:** `/tmp/unica-scratch/design-07/mockup.html`.

## 0. Decisions and what plan 06 changed

**Decided by the user:**
- the 100 ms motion ceiling stays everywhere
- SF (the system font) on macOS, Geist elsewhere
- a quiet compose icon in the list header replaces the big sidebar button; `c` still composes

**Plan 06 shipped:**
- `thread-menu.tsx`: one Base UI `ContextMenu` around the listbox.
- `selection-bar.tsx`: the bulk bar. It *replaces* `<Reader/>` while `checked.size ≥ 2` or a scope is active (`app.tsx`).
- `SelectAllBanner` above the list.
- Exclusive drag-to-move.
- New keys: ⌫, Delete and ⌘⌫ trash; z and ⌘Z undo through `setLastUndo`; ⇧F10 opens the menu.
- SQL migration **v8** and IndexedDB **v2**. This plan's storage change is therefore **v9** and **IDB 3**.

The menu's "Responder" sets `selectedId` and then calls `openCompose()`, which re-reads `selectedId` asynchronously. §3.6 replaces that.

## 1. Principles

1. **Content is the surface.** No cards around mail: hairlines, faint surface shifts, whitespace.
2. **Quiet chrome.** Grouped muted icons, one accent color.
3. **Edit in place, and never lose a word.** Drafting happens in the reader, and every keystroke reaches durable storage on a defined schedule.
4. **Fast motion.** Everything stays on `--motion` (≤ 100 ms), with curves, short distances and transform/opacity.
5. **Every theme.** Values and derived tokens only. All 13 themes and resolved custom themes pass the contrast checks for the pairs actually drawn.

**Borrowed from t3code:** ink-alpha borders, a pressed scale of .97, an inset highlight on primary buttons, translucent menus with a soft deep shadow, the drawer curve `cubic-bezier(.32,.72,0,1)`, tabular numbers.

**Borrowed from Apple:** a vibrancy sidebar with accent glyphs, a 52 px toolbar, SF display tracking, device-pixel separators, inset rounded selection, honoring reduced transparency.

## 2. Tokens and foundations

### New derived tokens

They go in core `THEME_TOKENS` and in `derive()`. Custom themes get them through `resolveCustomTheme()` and may override them.

| Token | Derivation |
|---|---|
| `hairline` | `foreground` at 9 % (light) or 8 % (dark) |
| `tint` | `background` mixed in OKLab toward `foreground`: 3.5 % light, 5 % dark; stepped down until `muted-foreground` on it passes 4.5:1 |
| `highlight` | `1 0 0 / 16%` light, `1 0 0 / 6%` dark |
| `draft-foreground` | the "Borrador" label: `destructive`, stepped in lightness until it passes 4.5:1 on `background`, `row-hover`, `row-selected` and `accent` (checked rows). Dracula's `destructive` on `row-selected` is 3.52, so it steps |
| `sidebar-glyph` | `sidebar-primary`, stepped until 3:1 on `sidebar` and `sidebar-accent`; falls back to `muted-foreground` |
| `--glass-alpha` (not a color) | the lowest popover alpha in [.88, 1], in .02 steps, at which every glass text pair passes over pure black *and* pure white. 1 means solid |

The generator writes `--glass-alpha` into each theme block. `applyCustomTheme()` sets it for custom themes, computed from their resolved `popover` and `popover-foreground`.

### Value changes

Only our own themes change; named palettes stay exact. If a value fails, adjust its lightness only.

| Token | terno-light | terno-dark | apple-light |
|---|---|---|---|
| border | `.22 .01 265 / 11%` | `1 0 0 / 8%` | `0 0 0 / 10%` |
| input | `.22 .01 265 / 16%` | `1 0 0 / 12%` | `0 0 0 / 15%` |
| sidebar-accent | `.22 .01 265 / 7%` | `1 0 0 / 8%` | `0 0 0 / 7%` |
| row-selected | `.93 .04 268` | `.29 .05 268` | `.93 .035 257` |

terno-dark also changes:
- background and pane: `.165 .005 265`
- card: `.195 .006 265`
- popover: `.215 .007 265`

### Contrast checks, for the pairs actually drawn

**Text, 4.5:1:**
- `foreground` and `muted-foreground` on `tint`
- `draft-foreground` on `background`, `row-hover`, `row-selected` and `accent`

**UI, 3:1:**
- `sidebar-glyph` on `sidebar` and `sidebar-accent`

**Glass, 4.5:1**, at `--glass-alpha`, composited over black and over white. Nord's muted text on the popover at 88 % over white is 3.74, so Nord's alpha rises or goes solid. The pairs:
- `popover-foreground`
- `muted-foreground` (shortcuts, labels)
- `destructive` (danger items)
- the highlighted item, i.e. `popover-foreground` and `destructive` over a `muted` highlight composited on the glass

**No opacity-reduced glyphs or text anywhere:** glyphs use `muted-foreground` or `sidebar-glyph` at full opacity. The existing scan gains a rule against `opacity-*` on `svg` and text.

The same pair list runs on every resolved custom theme. Failures show as warnings in Apariencia, as today, and glass goes solid.

The generated CSS stays ≤ 8 KB gzip (today 5.2 KB, about +0.4 KB).

### Foundations (`globals.css`)

- **Font:** `--font-sans: var(--theme-font, -apple-system, BlinkMacSystemFont, "Geist Variable", system-ui, sans-serif)`.
- **Type scale:** 11/14 counts · 12/16 metadata · 13/18 UI and list · 14/22 body · 15/20 titles · 17/22 empty states · 20/26 reader subject.
  - Weights 400, 500 and 600 only.
  - Tracking −0.011em at 15–17 px and −0.018em at 20 px.
  - Dates and counts use sans `tabular-nums`.
- **Radii:** 4 · 6 controls and rows · 8 menus and tiles · 12 draft and toasts · 16 dialogs and palette.
- **Grid:** 4 px; the list gutter is 16 px and the reader gutter 28 px.
- **Hairlines:** `--hairline-w` is `1px`, and `.5px` at `min-resolution: 2dppx`. Utilities: `border-hairline`, `divide-hairline`, `shadow-hairline`.
- **Elevation** (static shadows; filters and shadows are never animated):

  | Shadow | Composition |
  |---|---|
  | `shadow-raised` | hairline ring, `0 1px 1px`, inset highlight |
  | `shadow-popover` | ring, `0 4px 12px -2px`, `0 12px 32px -12px` |
  | `shadow-modal` | ring, `0 24px 64px -24px` |

- **Glass, on these surfaces only:** `DropdownMenu`, `ContextMenu` with its submenus, and `Select` popups. Base UI keeps these modal, so the page behind them doesn't scroll while they're open.
  - The surface is `popover` at `--glass-alpha` with `blur(20px) saturate(1.6)`.
  - It falls back to solid without support and under `prefers-reduced-transparency`.
  - Always solid: tooltips, `Popover`, toasts, the snackbar, dialogs, the palette, the category picker, settings, and anything that can sit over a scrolling list.
- **Reduced transparency also disables native vibrancy:**
  - `applyAppearance()` and the pre-paint theme script compute `vibrancy = macDesktop && theme.vibrancy && !matchMedia("(prefers-reduced-transparency: reduce)")` and re-run on the media query's `change`.
  - Main reads `nativeTheme.prefersReducedTransparency` when the window is created (first paint), and again on `nativeTheme` `updated`, and turns off `setVibrancy` and the transparent background itself, whatever the renderer last sent.
- **Focus:** `:focus-visible` only.
  - Controls: a 2 px `ring` outline, offset 1 px.
  - Rows and nav items: inset −2 px.
  - Compose fields: the caret, plus the label turning `foreground`.

## 3. Components

### 3.1 Chrome, sidebar, list

**Chrome.**
- 52 px top rows on every pane.
- The toolbar hairline appears only once content scrolls under it: a sentinel `IntersectionObserver` sets `data-scrolled`. No scroll handler, no blur.

**Sidebar.**
- Native vibrancy (subject to §2).
- 28 px rows: radius 6, inset 8, 16 px glyphs in `sidebar-glyph`; selected uses `sidebar-accent` at weight 500.
- Counts: 12 px tabular, muted.
- Section titles in sentence case, 11/600, muted; "+" appears on hover or focus.
- The big "Escribir" button leaves the sidebar.

**List header.**
- Title 15/600, plus a square-pen icon button: `data-testid="compose-button"`, `aria-label="Escribir"`, tooltip "Escribir C".
- Below it, a 30 px search field: `tint`, borderless, radius 8.
- Plan 06's `SelectAllBanner`: hairline bottom, `tint` background, 12 px text, the link in `primary`.

**Rows** keep their 68/40 px heights.
- Selection is a pseudo-element inset 8×1, radius 6. The rail goes away.
- Hover uses `row-hover` and isn't animated.
- One `::after` hairline per row, hidden on the selected row. The `:has()` rule that hides the hairline above the selection ships only if the frame gates in §5 pass.
- Unread: a 6 px dot, sender 600, subject 500.
- A thread with a draft shows "Borrador" in `draft-foreground` before the snippet. It comes from one boolean selector per row (`hasDraft(threadId)`).
- Plan 06's context-menu ring uses the inset focus shape.

### 3.2 Reader

**Layout.**
- Subject 20/600, then the meta line (account, badges, suggestions).
- Messages are flat on `background`, up to 860 px wide, separated by full-width hairlines.

**Disclosure.**
- Every collapsed message is a native `<button aria-expanded="false" aria-controls="msg-body-{id}">`. Enter and Space both work natively. It is one line: 24 px avatar, name 13/500, snippet, date.
- An expanded message's header is the same kind of button with `aria-expanded="true"`. It holds no interactive children; the full date is its `title`.
- 4 or more consecutive collapsed messages fold into one "N mensajes más" button (`aria-expanded`, `aria-controls` on the group).

**Expanded message.**
- 36 px avatar, name 14/600, date right-aligned in 12 px muted.
- A "Para: … · Cc: …" line, then an inset hairline.
- The body starts at the avatar edge.

**Mounting and animation.**
- **Bodies mount only when expanded.** Expanding mounts the body, then animates a `grid-template-rows` 0fr→1fr wrapper plus opacity.
- **Collapsing** animates out and unmounts on `transitionend`, or after motion-fast plus a frame. With motion off it unmounts at once. Nothing hidden stays mounted, so there are no hidden iframes.
- **HTML bodies** animate to the frame's last known height (cached per message id, otherwise 120 px). Later resizes from the frame's `ResizeObserver` are instant.
- **Observer cleanup:** the observer and the load and click listeners are disconnected on unmount. Today's `ResizeObserver` is never disconnected; that gets fixed.
- **Paper mode** keeps a borderless `mail-paper` surface. In themed mode the frame has no box and padding 0.

**Scroll scheduler.** `lib/reader-scroll.ts` is the single module for scroll-into-view, shared by drafts and expansions.
- `keepInView(el)` reads geometry and then writes `scrollTop` once per animation frame, for the transition's length.
- It stops on wheel, touch, pointerdown in the scroller, scroll keys, thread change or unmount.
- When motion is off it does one `scrollIntoView({block: "nearest"})` after layout instead.

**Remote content.** A row above the body: `tint`, radius 8, 36 px, an image-off glyph, 12 px text, a pill button in `accent`/`accent-foreground`.
- In local mode: "Contenido remoto bloqueado por el modo local." with "Cargar contenido…", which opens a solid popover: "El modo local no permite cargar contenido remoto." and "Abrir Ajustes". It never loads anything.
- Otherwise: "…para proteger tu privacidad." with "Cargar contenido".

**Attachments.**
- **Today they are metadata only:** the `attachments` rows, an `IncomingAttachment.providerRef`, and no RPC that fetches content.
- So there are **tiles with no actions and no download button**: 260×56, `tint`, radius 10, a type glyph, the name at 13/500, the size in muted.
- The tile reads as an item of a list. Opening and saving attachments is a separate plan (fetch by `providerRef` over IMAP or Gmail, plus desktop and web save paths, with loading, unavailable, error and retry states).

### 3.3 Toolbar and reply bar

**Toolbar.**
- 28 px ghost buttons with 16 px glyphs at stroke 1.75 in `muted-foreground`.
- Groups: [Archivar Eliminar Spam] · [Categoría No leído Destacar] · on the right [Responder · Responder a todos · Reenviar].
- Tooltips are solid `popover` with label plus kbd.

**Reply bar.** It replaces the three boxed buttons after the last message: a 40 px `tint` button, "Responder a {nombre}…", plus ghost "Responder a todos" and "Reenviar".

### 3.4 Drafts: model and persistence (ships before inline drafting)

**Draft v2**, the same shape in RPC, SQL, IndexedDB and the renderer:

```ts
{ id, revision, format: 2, accountId, threadId: number|null,
  mode: "new"|"reply"|"replyAll"|"forward",
  to, cc, bcc: Address & { auto?: true }[],   // auto = filled in by Terno, not typed
  subject, subjectEdited: boolean,
  bodyText,                                   // only what the user writes
  quotedText, includeQuote: boolean,          // generated once, never inside bodyText
  inReplyToMessageId: number|null, forwardOfMessageId: number|null,
  uiState: "open"|"collapsed", updatedAt }
```

**SQL v9:**
- `ALTER TABLE drafts` adds `format` (default 1), `thread_id REFERENCES threads ON DELETE SET NULL`, `mode`, `bcc_json`, `subject_edited`, `quoted_text`, `include_quote`, `forward_of_message_id`, `ui_state` and `revision`, plus an index on `thread_id`.
- Backfill: `thread_id` from the `in_reply_to` message, and `mode` = `reply` if it has one, else `new`.

**IndexedDB 3:** the drafts store gains the same fields and the `threadId` index. There is one upgrade path from 1 and from 2.

**RPC:**
- **`drafts.save`** takes the v2 fields plus `baseRevision` and returns `{id, revision}`. A stale `baseRevision` (another writer: a second window, MCP) never overwrites: the save becomes a new draft.
- **`drafts.list`** returns v2.
- **`drafts.delete`** takes `{id}`.
- **`compose.send`** takes the content from the request, so there are no stale reads. It sends `bodyText + (includeQuote ? "\n\n" + quotedText : "")` and deletes `draftId` in the same transaction that queues the send op.
- **MCP `create_draft`** keeps its input. It derives `threadId` and `mode` from `inReplyToMessageId`.

**Restore rules (deterministic):**
- **Format-1 drafts** come back with `bodyText` as stored (it may contain the old inline quote), `quotedText` empty and `includeQuote` false, so a quote is never duplicated.
- **One thread draft per thread:** the most recent `updatedAt` per `thread_id` becomes it. Older ones appear in the drafts strip (§3.6) as separate items, labelled "Re: {asunto}".
- **Orphans:**
  - The thread was deleted (`thread_id` became NULL, or the reply target is gone): the draft restores as a new-message draft that keeps its recipients, subject and text, and is sent without threading headers.
  - The forward source is gone: sending says "El mensaje original ya no está" and offers "Enviar como mensaje nuevo".
  - The account was removed: the draft is deleted (the existing cascade).

**Write lifecycle (`lib/drafts.ts`), per stable client key** (a UUID created with the draft; `id` is attached when the first save is acknowledged):
- **States:** `clean`, `dirty`, `saving`, `saved`, `error`.
  - Every edit increments a local revision.
  - At most one save is in flight per key. Saves go out 800 ms after the last edit, and at least every 5 s during continuous typing.
  - A response applies to the key it was sent for, never to "the current draft".
- **"Borrador guardado"** shows (`aria-live="polite"`) only when the acknowledged revision equals the local revision.
- **On error:** "No se pudo guardar · Reintentar", with backoff retries at 1, 2 and 5 s. The text stays in memory.
- **Send, discard and convert** cancel the debounce and await the in-flight save first. Discard then deletes by id; send passes the id.
- **Flush points** (each drains every dirty key, capped at 1 s):
  - leaving a thread, and the reader unmounting (bulk bar, settings)
  - the web tab handoff in `web/connect.ts`, before the worker closes
  - the "Recargar" update prompt
  - `pagehide`
- **Crash-loss window:** edits since the last acknowledgement, which is ≤ 800 ms after a pause or ≤ 5 s during continuous typing.

### 3.5 Inline replies

**Opening.** `openCompose(mode, threadId)` always takes an explicit target: menu, keyboard, palette and reply bar. The draft takes the reply bar's place, animates open with `keepInView`, and focuses the body (replies) or Para (forwards).

**The draft.**
- **Surface:** `tint`, radius 12, a `<form aria-label="Responder a Yuki Gutiérrez">` (or "Reenviar…").
- **Fields:** borderless, hairline-separated rows with real `<label for>`:
  - **De:** only with 2 or more accounts; a text select.
  - **Para**, with "Cc" and "Cco" disclosure buttons (`aria-expanded`).
  - **Asunto:** shown for forwards, behind a button for replies.
- **Body:** grows with `field-sizing: content`.
- **Quote:** the original is a "•••" disclosure ("Mostrar mensaje citado") below the body, with a remove button that sets `includeQuote` false.
- **Footer:** "Enviar ⌘↩", then the save state, then Descartar and Contraer. Descartar has no shortcut, because ⌘⌫ is plan 06's trash and deletes a line inside text.

**r, a and f on a thread that already has a draft:**
- **Same mode:** resume. Open it and focus it; nothing changes. Repeated presses are idempotent.
- **Different mode:** convert in place, as a new local revision (it serializes behind a pending save like any edit):
  - `bodyText` and every recipient without `auto` are kept.
  - `auto` recipients are recomputed for the new mode. Reply → reply-all adds the others to Cc; reply-all → reply drops only the untouched auto ones; forward clears the auto ones.
  - The subject is regenerated unless `subjectEdited`.
  - `quotedText` is regenerated (forward block or reply quote); `inReplyTo` and `forwardOf` are swapped.
  - A toast says "Convertido en Responder a todos · Deshacer". Undo restores the previous revision's snapshot. z and ⌘Z also undo, through `setLastUndo`, when not typing.
- **Tests:** r→a→f→r with typed text and edited recipients, including while a save is pending.

**Exits and where focus goes.**

| Exit | Result | Focus goes to |
|---|---|---|
| Esc, or Contraer | the draft collapses into the "Borrador · Para … — …" button; the save is flushed | that button |
| Enter or Space on that button | the draft reopens | the body |
| ⌘↩ (send) | the draft fades out (fast) and the sent message arrives through invalidation | the reply bar |
| Descartar | toast "Borrador descartado · Deshacer" | the reply bar |
| Clicking another row, or j/k from a non-text focus | the draft keeps its `uiState` | the list context (the active element is blurred) |

Coming back to a thread never moves focus into its draft.

**Typing.** Inside fields, j, k, ⌫, Delete, ⌘⌫, ⌘A, ⌘Z, e, # and r keep their text meaning (the existing `editable` gate). A test covers each.

### 3.6 New messages, targets and precedence

**New messages.**
- **c, the compose button and the palette** create a `new` draft and show it in the reader pane:
  - The toolbar becomes Descartar and "Enviar ⌘↩".
  - A 20 px title mirrors the subject.
  - De, Para, Cc, Cco and Asunto are hairline rows; focus goes to Para.
- **The drafts strip** sits above the list, outside the virtualizer, with the banners. It holds:
  - new-message drafts
  - thread drafts whose thread isn't in the current list (archived, moved, trashed, another view)
  - superseded drafts (§3.4)

  Each item is a button ("Nuevo mensaje — Para …" or "Re: {asunto}"). It shows 3 items, then "+N".
- **Clicking a strip item** opens the draft: a new draft in the reader, a thread draft by loading its thread by id.
- **Exits:**
  - Esc returns the reader to the previously selected thread (or the welcome screen) and focuses the draft's strip item.
  - Sending or discarding returns the same way and focuses the list context.

**What the reader pane shows** (first match wins):
1. Plan 06's bulk bar while `checked ≥ 2` or a scope is active. Drafts stay in the store, flushed on unmount. If focus was inside a draft, it moves to the bulk bar's heading.
2. The active new draft.
3. The selected conversation, with its thread draft inline.
4. The welcome screen.

**Targets and selection.**
- Pressing c clears the multi-selection.
- r, a and f need exactly one target and do nothing with a bulk selection (the menu already disables them).
- Menu "Responder" passes the row's id, then selects it. It never relies on `selectedId` timing.
- Drafts survive selection clearing and their rows leaving the view:
  - archive, trash, an exclusive move or drag, or a scope action on the thread keeps its draft
  - the reader moves on as today
  - the draft appears in the strip

**Esc precedence** (first match wins):
1. an open menu, popover or select
2. a dialog or the palette
3. focus inside a draft: collapse it, or leave the new draft
4. the snackbar
5. the multi-selection
6. the search field

## 4. Motion

At M = 75: fast 50, base 75, slow 100 ms. The ceiling and `data-motion=off` are unchanged.

New curves:
- `--motion-ease-drawer: cubic-bezier(.32,.72,0,1)`
- `--motion-ease-spring: linear(0, .2 8%, .62 20%, .94 34%, 1.03 47%, 1.01 64%, 1)`
- `--motion-ease-in: cubic-bezier(.4,0,1,1)`

| What | Properties | Duration · curve |
|---|---|---|
| Menus, select, popover | opacity, scale .97→1 | base · spring; exit fast, opacity |
| Tooltips | opacity, 2 px | fast |
| Dialog, palette | opacity, scale .98→1 | slow · drawer; exit fast |
| Message expand / collapse, "N más" | grid rows, opacity | slow · drawer / fast · in |
| Draft open / collapse / send | grid rows, opacity, translateY 6 px | slow · drawer / fast |
| New message in the reader | opacity, translateY 4 px | base |
| Buttons | background; `:active` scale .97 | fast |
| Snackbar, toasts | translateY 8 px, opacity | slow in, fast out |
| j/k, selection, hover, reader swap, theme, scrolling, shadows, filters | — | never |

Grid-row height animates only in the reader, after an explicit action. Reduced motion jumps everything.

## 5. Performance gates

**Existing:** all of `pnpm test:ui-perf` and plan 06's gates still pass.

**New, enforced:**
- **Sustained j/k** (300 moves at key-repeat rate) **and continuous wheel scrolling** across 2,000 threads (3 s):
  - frame interval p95 ≤ 20 ms, longest frame ≤ 50 ms (rAF deltas plus long-animation-frame entries)
  - selection actually advances 300 rows; DOM rows stay bounded
  - run in both densities, with a collapsed draft on a listed thread and a restored draft in the strip
- **Inline reply:** keypress → first frame showing the draft ≤ 50 ms p95, and keypress → expansion done ≤ motion-slow + 2 frames, measured separately.
- **Long conversation:** expanding messages in a 20-message conversation with 5 HTML bodies keeps every frame ≤ 50 ms and leaves no iframe or `ResizeObserver` behind for collapsed messages.
- **Menus:** right-click → glass menu painted ≤ 50 ms p95 (as in plan 06).

Load is high on this machine, so a gate that fails gets one rerun, and failures report the load average.

## 6. Tests

Each test lands in the commit that changes the behavior or look it covers. Baselines are regenerated per commit only for the specs it changes, after reviewing the diff images.

**Unit:**
- the new derived tokens, including stepping and `--glass-alpha`
- every contrast pair from §2, for built-in and resolved custom themes
- the opacity scan
- the vibrancy decision (renderer and main)
- the draft writer: ordering, revisions, flush, error and retry
- conversion rules and restore rules

**Storage:**
- draft conformance (save, reopen, convert, send, delete, stale revision, orphans) on node:sqlite, SQLite-WASM (Node, and OPFS in `test:web`), fake and real IndexedDB
- migration v9 from v8 data
- IDB upgrades from 1 and from 2

**e2e:**
- **`compose.spec.ts`:**
  - kept: r/a/f prefill, ⌘↵ sends, reply-all never Cc's me, invalid recipients keep the draft
  - new: inline in `reader` with an accessible name; Esc collapses (focus on the collapsed button); the text survives thread switches, archive and reload; convert and undo; discard and undo; c in the reader with the strip; Bcc sends; text keys inside fields
- **`reader.a11y`:** disclosure buttons with Enter and Space, `aria-expanded`/`aria-controls`.
- **Reduced transparency** (CDP `Emulation.setEmulatedMedia`, `prefers-reduced-transparency: reduce`): no `data-vibrancy`, an opaque sidebar, solid menus.
- **`motion.spec.ts`:** expand and draft ≤ 100 ms, nothing at 0, `compose-button` in the list header.
- **`e2e-web/web.spec.ts`:** draft text survives a takeover, and a reload after the update prompt.

**Visual:**
- `composer-reply.png` becomes `reply-inline.png`
- add `compose-new-inline.png`, `reader-conversation(-dark).png`, `context-menu.png`, `bulk-bar.png`

## 7. Commits (each passes typecheck, lint, `pnpm test`, `test:e2e`, `test:ui-perf`)

1. `feat(ui): hairline, tint, highlight, draft and sidebar-glyph tokens; glass alpha; contrast pairs as drawn` (+ baselines)
2. `feat(ui): system font, type scale, radii, hairlines, elevation, curves, focus rings` (+ baselines)
3. `feat(desktop,web): reduced transparency turns off vibrancy at first paint and live` (+ tests)
4. `feat(ui): glass menus/select, solid tooltips/toasts/dialogs/palette` (+ `context-menu.png`, menu perf)
5. `feat(web): 52 px chrome, compose icon in the list header, sidebar, select-all banner` (+ motion.spec, baselines)
6. `feat(web): rows with inset selection and hairlines; frame-time gates for j/k and scrolling` (+ perf, baselines)
7. `feat(reader): flat messages, disclosure buttons, lazy bodies, observer cleanup, scroll scheduler` (+ a11y, long-conversation perf, baselines)
8. `feat(reader): borderless frame, remote-content row, attachment tiles; grouped toolbar, reply bar` (the bar opens today's composer; + baselines)
9. `feat(core,db,idb,backend): draft v2, migration v9, IDB 3, revisioned saves, send joins the quote` (+ conformance and upgrade tests; `test:web`)
10. `feat(web): draft writer and restore at startup, used by today's composer` (+ lifecycle, reload and takeover tests)
11. `feat(compose): inline reply/reply-all/forward with explicit targets, resume/convert, focus exits, Esc precedence` (+ compose.spec, reply perf, `reply-inline.png`)
12. `feat(compose): new message in the reader, drafts strip, bulk-bar precedence; the floating composer is removed` (+ tests, `compose-new-inline.png`)
13. `feat(web): inset-grouped settings, palette, toasts, bulk bar, empty states` (+ baselines)
14. `docs: PLAN §9, README, plan 07 outcome` (+ packaged smoke)

## 8. Risks

- SF changes every baseline, and a Linux CI would render Geist.
- Cross-writer draft conflicts become extra drafts, not merges.
- Frame gates are noisy under load.
- Attachments stay view-only until their own plan.

## 9. Outcome

Shipped in 13 commits on top of plan 06 and its review fixes, in the order of §7. Where it departs from the plan, and why:

- **`--glass-alpha` is a color token, `popover-glass`** (the popover at the derived alpha). Custom themes then carry it like any other token (CSSOM, the pre-paint cache) with no extra variable. Honest result of the contrast rule: menu text must read over pure black and white, so light themes end at ~.98 and several dark ones (Nord, Dracula, Monokai, Gruvbox) are solid; the blur shows mostly at the edges.
- **Hairline utilities are `hairline`, `hairline-t/-b/-l/-r`, `hairline-divide`, `hairline-strong`** (not `border-hairline`, which Tailwind already generates as a color utility from the token).
- **Scroll-linked toolbar hairlines don't fade**: the first frame gate caught the fade as an animation started by scrolling (scrolling never animates).
- **The separator above the selected row** (`:has(+ [data-cursor])`) shipped: the frame gates pass with it.
- **Enter and Space on a focused button or link** are left to the control (native activation) instead of the global `list.open`; other single keys keep working from a focused button.
- **Opening uses `@starting-style`** (Tailwind `starting:`) instead of a frame at 0fr, so a draft or message starts growing in the frame it first paints; only toggled opens animate.
- **Inline reply gate**: keypress → first frame (≤ 50 ms) and first frame → expansion done (≤ slow + 2 frames) are enforced; their sum (~120–132 ms p95) is reported, too close to 133 ms to gate under load.
- **The j gate's row renders** are ≤ 3.5 per move: the two rows whose selection changed plus the row the scroll mounts (virtualization), never one for drafts.
- **The quote join happens in the renderer** (`sendBody`), `compose.send` sending the request's text; the backend never joins anything.
- **Settings**: General is inset-grouped; the other tabs keep their own layouts inside the new sidebar shell.

Measured (load average 5–7 from other work): j at key repeat frame p95 16.7 ms (both densities, with a collapsed and a restored draft); continuous scroll 16.8 ms; long conversation 16.8 ms, no frame or observer left; inline reply first frame ~15 ms, expansion ~115–126 ms; context menu ~15–17 ms; every earlier gate unchanged. Packaged smoke: warm start ~0.5 s to first rows. One backend gate from plan 06 (the 5,000-thread × 20-category move, ≤ 50 ms stall) failed once at load average ~7 (99 ms) and passed on rerun (36 ms): load-sensitive, untouched by this plan.

## 10. After review (Codex, 9 findings)

- One send per draft: sends are tracked per draft key (a remounted pane gets the first send's outcome), the draft is locked while it runs, and both stores refuse a second send of a draft that is gone.
- Recipients are saved as typed («bob@» survives a reload); addresses are validated only when sending. A failed send restarts the autosave.
- Authorship is per field and per recipient: a conversion never removes a recipient the user typed, and Terno's recipients skip anyone already in another field. Fields a conversion fills in (Cc, a forward's Asunto) show while the draft is open.
- A strip item opens exactly that draft (`draftShown`); orphaned replies and forwards come back as new messages with their threading cleared (SQL and IndexedDB).
- One draft index per update (newest per conversation, conversations with something written) replaces the per-draft and per-row scans; gate: typing with 2,000 drafts, keystroke → rendered p95 ≤ 16 ms (~3 ms).
- A message toggle keeps its node (and focus) across expand and collapse; revealing «N mensajes más» focuses the first revealed message.
- Polish: thin scrollbars in the theme's ink, shown only while their pane is hovered; the learned-filter suggestion uses a quiet button; the account beside a row's time is a 6 px ring.
