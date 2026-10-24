# Plan 07: design refresh, Apple-Mail reader, inline compose

Status: proposed · on top of plans 01 (themes, motion) and 06 (context menu) · mockup: `/tmp/unica-scratch/design-07/mockup.html`

## 1. Principles

1. **Content is the surface.** No cards around mail; structure comes from 0.5 px hairlines, faint surface shifts and whitespace.
2. **Quiet chrome.** Grouped muted icons, one accent; the unread dot is the loudest pixel.
3. **Edit in place.** Replies and new mail are written where you read.
4. **Fast, not slow.** Everything stays on `--motion` (≤ 100 ms). The premium feel comes from the curves, short distances and transform/opacity.
5. **Every theme.** Only values and derived tokens change; all 13 themes and custom JSON keep passing AA.

Borrowed:
- **t3code:** ink-alpha borders, press `scale(.97)`, inset highlight on primary buttons, glass menus with a deep soft shadow, the drawer curve `cubic-bezier(.32,.72,0,1)`, tabular numbers.
- **Apple:** vibrancy sidebar with accent glyphs, 52 px toolbar, SF display tracking, device-pixel separators, inset rounded selection.

## 2. Tokens and foundations

**New derived tokens** go in core `THEME_TOKENS` and in `derive()`. Custom themes get them through `resolveCustomTheme()` and may override them.

| Token | How it's derived |
|---|---|
| `hairline` | `foreground` at 9 % (light) / 8 % (dark) |
| `tint` | `background` mixed in OKLab toward `foreground`, 3.5 % (light) / 5 % (dark); stepped down by .005 until `muted-foreground` on it passes 4.5:1 |
| `highlight` | `1 0 0 / 16%` (light) / `1 0 0 / 6%` (dark) |

**Value changes** apply only to our own themes; the named palettes stay exact. If a value fails AA, adjust its lightness only.

| Token | unica-light | unica-dark | apple-light |
|---|---|---|---|
| border | `.22 .01 265 / 11%` | `1 0 0 / 8%` | `0 0 0 / 10%` |
| input | `.22 .01 265 / 16%` | `1 0 0 / 12%` | `0 0 0 / 15%` |
| sidebar-accent | `.22 .01 265 / 7%` | `1 0 0 / 8%` | `0 0 0 / 7%` |
| row-selected | `.93 .04 268` | `.29 .05 268` | `.93 .035 257` |

unica-dark also moves bg/pane to `.165 .005 265`, card to `.195 .006 265` and popover to `.215 .007 265`.

**Contrast test changes:**
- `foreground` and `muted-foreground` on `tint` (51 pairs per theme).
- A glass check: `foreground` on `popover` at 88 % alpha, composited over pure black and pure white, must reach 4.5:1. A theme that fails renders its menus solid.
- The generated CSS stays ≤ 8 KB gzip (5.2 KB today, about +0.3 KB).

**Foundations (globals.css):**
- **Font:** `--font-sans: var(--theme-font, -apple-system, BlinkMacSystemFont, "Geist Variable", system-ui, sans-serif)`. That's SF on macOS, in Electron and in the web build; Geist elsewhere. Mono only for kbd and code.
- **Type scale:** 11/14 counts, 12/16 metadata, 13/18 UI and list, 14/22 body, 15/20 titles, 17/22 empty states, 20/26 reader subject.
  - Weights 400/500/600 only.
  - Tracking −0.011em at 15–17 px and −0.018em at 20 px.
  - Dates and counts use sans `tabular-nums` (no more mono).
- **Radii:** 4 · 6 controls and rows · 8 menus and tiles · 12 popovers, draft and toasts · 16 dialogs and palette.
- **Spacing:** 4 px grid. Gutters are 16 px in the list and 28 px in the reader.
- **Hairlines:** `--hairline-w: 1px`, and `.5px` under `@media (min-resolution: 2dppx)`. Chromium paints that as one device pixel.
  - Utilities: `border-hairline`, `divide-hairline`, and `shadow-hairline` (a ring for floating surfaces).
- **Elevation** (all in `--shadow-color`; panes, rows and messages are flat):
  - `shadow-raised` for buttons: hairline ring + `0 1px 1px` + inset highlight.
  - `shadow-popover` for menus, tooltips and toasts: ring + `0 4px 12px -2px` + `0 12px 32px -12px`.
  - `shadow-modal` for dialogs and the palette: ring + `0 24px 64px -24px`; dark mode adds the inset highlight.
- **Glass:** `surface-glass` is the popover at 88 % with `blur(20px) saturate(1.6)`. It goes solid without support and under `prefers-reduced-transparency`.
- **Focus:** `:focus-visible` only, a 2 px `ring` outline. Offset 1 px on controls; inset −2 px on rows and nav items. Compose fields show focus with the caret and the label turning `foreground`.

## 3. Components

**Window chrome and sidebar.**
- Every pane's top row is a 52 px drag region (was 44).
- Toolbar hairlines appear only once content scrolls under them (a sentinel `IntersectionObserver` sets `data-scrolled`; no scroll handler, no blur).
- The sidebar keeps its vibrancy (`:root[data-vibrancy]`).
- **Rows:** 28 px, radius 6, inset 8 px, 16 px glyphs in `sidebar-primary`; selected = `sidebar-accent` at 500; counts 12 px tabular muted. Section titles in sentence case, 11/600 muted, "+" on hover or focus.
- **"Escribir"** becomes a square-pen icon button in the list's title row (keeps `compose-button`, tooltip "Escribir C").

**Thread list.**
- **Header:** title 15/600 in the 52 px row; below it a 30 px search field (`tint`, no border, radius 8, `/` kbd).
- **Rows** keep 68/40 px.
  - **Selection:** a pseudo-element inset 8×1 px, radius 6, in `row-selected`; the left rail goes (the `row-rail` token stays).
  - **Hover:** `row-hover`, not animated.
  - **Separators:** one `::after` hairline per row, inset 16 px, hidden on the selected row. Hiding the one above it via `:has()` ships only if the j-key gate passes.
  - **Unread:** 6 px dot, sender 600, subject 500, date in `foreground`.
  - **Drafts:** a thread with a draft shows "Borrador" (`destructive`) before the snippet, from a one-boolean per-row selector.
- Plan 06's context-menu ring uses the inset focus shape.

**Reader.**
- **Header:** subject at 20/600, then the meta line (account, badges, suggestion chips) as today.
- **Messages are flat** on `background`, up to 860 px wide, separated by full-width hairlines. No border, radius or card.
- **Expanded message:** 36 px avatar, name 14/600, date right-aligned 12 px muted, a "Para: … · Cc: …" line, an inset hairline, then the body from the avatar edge (no indent).
- **Collapsed message:** one 44 px line with avatar 24, name 13/500, muted snippet and date. Hover shows `tint` with radius 8.
- **Expand and collapse** animate a `grid-template-rows: 0fr↔1fr` wrapper plus body opacity, only on click or Enter; the hidden part is `inert`.
- 4+ consecutive collapsed messages fold into "N mensajes más".
- **HTML frame:** no border box, padding 0 in themed mode; paper mode keeps a borderless `mail-paper` surface (radius 8, 16 px padding).
- **Remote content:** a row above the body: `tint`, radius 8, 36 px, an image-off glyph, 12 px text, and a pill button (`accent`/`accent-foreground`).
  - Local mode: "Contenido remoto bloqueado por el modo local." + "Cargar contenido…". The button opens a popover ("El modo local no permite cargar contenido remoto." + "Abrir Ajustes") and never loads anything.
  - Otherwise: "…para proteger tu privacidad." + "Cargar contenido".
- **Attachments:** 260×56 `tint` tiles, radius 10: type glyph, name 13/500, muted size, a round download button (60 % opacity, 100 % on hover or focus).

**Toolbar.**
- 28 px ghost buttons, radius 6, 16 px glyphs at stroke 1.75 in muted (foreground + `muted` fill on hover).
- **Groups** 12 px apart with no rules: [Archivar Eliminar Spam] · [Categoría No leído Destacar] · on the right [Responder, Responder a todos, Reenviar].
- **Tooltips:** label + kbd on `popover` with `shadow-popover`. 500 ms the first time, then instant within the group.

**Reply bar.** Replaces the boxed buttons: a 40 px `tint` field ("Responder a Yuki…") with ghost "Responder a todos" and "Reenviar". Clicking it, or r/a/f, turns it into the inline draft.

**Inline compose.** `compose` becomes a drafts store keyed by thread id (or `new:<n>`): `{…ComposeDraft, bcc, quoted, state: open|collapsed}` plus the active key.

Replies and forwards:
- **Opening:** the draft takes the reply bar's place at the end of the conversation. It animates open while the scroller stays pinned to it (instant, no smooth scroll). Focus goes to the body for replies and to Para for forwards.
- **Surface:** `tint`, radius 12, no border.
- **Fields:** borderless hairline-separated rows with 12 px muted labels: **De** (only with 2+ accounts; a text select defaulting to the thread's account), **Para** (with "Cc"/"Cco" toggles), **Asunto** (forwards; replies open it on click).
- **Body:** grows with `field-sizing: content`. The quoted original is a "•••" chip outside the textarea, joined on save and send.
- **Footer:** "Enviar ⌘↩" (primary, raised), then "Borrador guardado" (fades in after each autosave, 800 ms debounce as today), then Descartar and Contraer on the right.
- **⌘↩** sends: the draft fades out and the sent message appears through the existing invalidation.
- **Esc** collapses the draft into one line ("Borrador · Para Yuki — …") and flushes the save; Enter or a click reopens it.
- **Descartar** deletes it and shows the toast "Borrador descartado · Deshacer".

New messages:
- **c** opens the draft **in the reader pane**. A **drafts strip** above the list (outside the virtualizer, where the banners sit) shows it selected ("Nuevo mensaje — Para …"). The toolbar becomes Descartar · "Enviar ⌘↩"; a 20 px title mirrors the subject; De, Para, Cc, Cco, Asunto are hairline rows, then the body; focus goes to Para.
- **Switching threads:** each draft stays with its thread, open or collapsed; the save is flushed on leave; coming back never steals focus; the strip keeps new drafts one click away (3, then "+N").
- **At startup**, `drafts.list` restores reply drafts onto their threads (through `in_reply_to_message_id`) and new ones into the strip.
- **Backend:** drafts gain `bcc_json` and `forward_of_message_id`, in the next SQL migration after plan 06's v8 and the next IndexedDB version, plus the matching `drafts.save` fields. `compose.send` already takes `bcc`.

**Overlays.**
- **`popover-surface`** (glass, `shadow-popover`, radius 8, p-1) is shared by `DropdownMenu`, `ContextMenu` (plan 06 inherits it), `Select`, `Popover` and the category picker.
  - Items are 28 px, radius 4, with a `muted` highlight, glyphs at 80 % and shortcuts right-aligned.
- **Palette:** 640 px glass sheet, radius 16, `shadow-modal`.
- **Settings:** macOS System Settings style. A 180 px nav with accent glyphs, and inset-grouped `tint` sections (radius 10, hairline-separated rows, controls on the right).
- **Snackbar and toasts:** popover surface, radius 12, 13 px, bottom-left.

**Empty states** (reader welcome, empty list, plan 06's bulk bar): a monochrome 28–40 px glyph, a 17/600 title, a muted line.

## 4. Motion

At M = 75: fast 50 · base 75 · slow 100 ms. The 100 ms ceiling and `data-motion=off` are unchanged.

New curves: `--motion-ease-drawer: cubic-bezier(.32,.72,0,1)`, `--motion-ease-spring: linear(0, .2 8%, .62 20%, .94 34%, 1.03 47%, 1.01 64%, 1)`, `--motion-ease-in: cubic-bezier(.4,0,1,1)` (exits); `--motion-ease` stays for colors.

| What | Properties | Duration · curve |
|---|---|---|
| Menus, select, popover, context menu | opacity + scale .97→1 from origin | base · spring; exit fast, opacity only |
| Tooltips | opacity + 2 px | fast |
| Dialog, palette | opacity + scale .98→1; backdrop opacity | slow · drawer; exit fast |
| Message expand / collapse | grid rows + body opacity | slow · drawer / fast · in |
| Draft open / collapse / send | grid rows, opacity, translateY 6 px | slow · drawer / fast |
| New message in the reader | opacity + translateY 4 px | base |
| Buttons | background; `:active` scale .97 | fast |
| Star, dot pop | scale | base · spring |
| Snackbar, toasts | translateY 8 px + opacity | slow in, fast out |
| j/k, selection, hover, reader swap, theme, scrolling | — | never |

Grid-row height runs only in the reader, after an explicit action. `scrollIntoView` is instant. Reduced motion jumps everything, as today.

## 5. Performance guardrails

- `backdrop-filter` is allowed only on short-lived overlays over static content. It is never on the list, the reader, the sidebar (native vibrancy) or toolbars.
- **Rows:** no shadows or transitions, at most two pseudo-elements, one new boolean selector; `contain: strict` stays.
- The iframe height and the virtual rows never animate.
- The theme switch stays at 0 row renders.
- **Gates:** all of `pnpm test:ui-perf` and plan 06's gates, plus:
  - j held with a draft open: p95 ≤ 16 ms, 2 rows per move
  - inline reply opened and painted: ≤ 50 ms p95

## 6. Tests and baselines

- **`compose.spec.ts`**, rewritten.
  - Kept: r/a/f prefill; ⌘↵ sends and the message appears; reply-all never Cc's me; invalid recipients keep the draft.
  - New:
    - the draft is inline in `reader` (no `role=dialog`), focused and in view
    - Esc collapses it and the text survives a thread switch
    - Descartar + Deshacer
    - c opens in the reader with the strip
    - Bcc sends
    - drafts are restored after a reload
- **`motion.spec.ts`:** message expand and draft open ≤ 100 ms; nothing animates at 0; `compose-button` is in the list header.
- **`e2e-web/web.spec.ts`:** the composer testid.
- **Unit:** tint derivation, glass contrast, drafts store (keys, restore, flush), quote join.
- **Visual baselines:**
  - regenerate visual (17), themes (18) and dnd (2)
  - `composer-reply.png` becomes `reply-inline.png`
  - add `compose-new-inline.png`, `reader-conversation(-dark).png` and `context-menu.png`
  - each commit updates only the baselines it changes, after reviewing the diff images; never wholesale to turn a run green

## 7. Commits (after plan 06)

1. `feat(ui): hairline, tint, highlight tokens; Única/Apple values; glass contrast test`
2. `feat(ui): system font, type scale, radii, hairline width, elevation, curves, focus rings`
3. `feat(ui): popover-surface (menus, select, popover, context menu), tooltip, button, dialog, command, sonner`
4. `feat(web): 52 px chrome, scroll-linked hairlines, compose in the list header, sidebar`
5. `feat(web): rows with inset selection, hairline separators, tabular dates`
6. `feat(reader): flat messages, collapsed rows, animated expand, "N mensajes más"`
7. `feat(reader): borderless HTML frame, remote-content row, attachment tiles`
8. `feat(reader): grouped toolbar, reply bar`
9. `feat(db,idb,core): drafts keep Bcc and the forwarded message`
10. `feat(compose): inline reply/reply-all/forward per thread; Esc collapses; discard with undo`
11. `feat(compose): new message in the reader, drafts strip, restore at startup`
12. `feat(web): inset-grouped settings, palette, toasts, empty states`
13. `test: inline compose, motion and perf cases; remaining baselines`
14. `docs: PLAN §9 and README`

Every commit passes typecheck, lint, `pnpm test`, `test:e2e` and `test:ui-perf`. The last also passes `test:web` and the packaged smoke.

## 8. Risks

- SF changes every baseline (a Linux CI would render Geist).
- Glass over busy content can't be proven AA, hence the solid fallback.
- Per-thread drafts must survive web tab takeovers: they live in the drafts table; the renderer only caches them.
