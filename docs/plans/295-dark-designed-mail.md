# Plan 295: designed mail in the dark theme

- **Status:** planned.
- **Builds on:** `90b113df6` (main).
- **Request (verbatim):** "in dark mode sometimes we receive emails that have hardcoded white background and text, which doesn't fit with our dark theme. i think we need to convert these into dark mode, we need a dark-mode-converter when we have dark mode and we notice clear backgrounds on coming emails that we can change […] it needs to use the current design palette that is used instead of plain black always." Then, after seeing the examples: "lets do the 'show original' like small text. so start implementing it and proceed. also this should be the default mode when they install it, the 'always paper' things that doesnt change it should be opt-in".

## 1. What it means

In a dark theme with **HTML mail: Match theme** (the default since plan 158), a designed mail, one with its own colors, is no longer a light paper card in a dark reader. Its colors are rewritten onto the theme's palette:

- its white page becomes the theme's background, a white card on a grey page the theme's card, other light greys steps along the theme's background → card → foreground ramp (so they carry the theme's tint, never plain grey or black);
- vivid brand colors (a blue band, a pink button) stay exactly as written, pastels keep their hue as a dusky tint, a black call-to-action turns into the theme's light button;
- plain text takes the theme's foreground or muted ink by how strongly it stood out, colored text keeps its hue and only moves in lightness, unstyled links take the theme's link; everything rewritten is at least AA (4.5:1) on its new surface;
- after pictures load (desktop), a dark see-through logo or icon that would vanish on the dark page is turned light, and a mixed one gets a soft plate.

A mail that can't be converted well keeps the paper, as today: already mostly dark, text mostly over background pictures, mostly large pictures with little text, a mail the mapping would leave mostly light, or one too large to walk.

Each converted mail has a small text control, **Show original**, that puts that message back on its paper for the session (and **Match theme** to convert it again). **Always paper** in Settings stays the opt-in for never converting. Light themes are unchanged.

## 2. What exists

- `apps/web/src/components/mail-body.tsx` `HtmlBody`: DOMPurify (`FORBID_TAGS: ["style"]`, so only inline styles and legacy color attributes reach the frame) → `mailDesign()` → quote folding / CID → a sandboxed srcdoc frame (no scripts, `allow-same-origin` so the parent measures and marks). Colors are CSS variables on the frame's root (`mailLook`, `paint`): a theme or setting change repaints the loaded document in place; **a rebuild (reload) must never come from theming** (`mail-repaint.spec.ts`).
- `apps/web/src/lib/mail.ts` `mailDesign()` (plan 158): designed = a surface that isn't a white page, a picture behind, hued text, drawn art or an `!important` color. Designed mail keeps "paper" (`--m-bg: mail-paper`, padding 16, a hairline card around the frame); simple mail is "themed" (a sheet forces every color to inherit).
- `apps/web/src/lib/appearance.ts` `mailColors()`: the painted theme's colors as hex literals (themed: background, foreground, muted-foreground, primary as link, star; paper: mail-paper, mail-ink, mail-link).
- Setting `htmlMailAppearance: "auto" | "paper"`, default `"auto"` (`packages/backend/src/settings.ts`); Settings → Appearance → HTML mail ("Match theme" / "Always paper").
- Full message view (`full-message.tsx`): sections of the same mail in `section` mode, given `appearance={paper ? "paper" : appearance}`.
- Print (`print-sheet.tsx`) prints on paper; unaffected.
- `packages/ui/src/themes/color.ts`: OKLCH/sRGB/WCAG helpers (private OKLab conversions).
- Desktop main `network-backstop.ts`: `isMailFrame()` identifies the reader's srcdoc frames; `app.ts` lets only their image requests out.
- `remote-consent.ts`: the per-message, per-session store pattern ("Load content").

## 3. Research

Two independent researchers (Codex Astra, Claude Fable) surveyed Apple Mail, Gmail, Outlook, Fastmail, Spark, HEY, Superhuman, Thunderbird, Chromium Auto Dark Mode and Dark Reader, and each built a prototype run on 91 real newsletters from the owner's mailbox (renders kept out of the repo). Findings that shaped this plan:

- No client publishes its mapping; Outlook and Gmail iOS invert lightness (hue kept); Chromium's Auto Dark Mode inverts in LAB and classifies images by their pixels; Dark Reader maps background, text and border roles onto theme endpoints. Thunderbird 140 and Outlook give a per-message way back.
- Sender `@media (prefers-color-scheme)` can't help: our sanitizer drops `<style>`.
- Fable's converter won: brand colors stay exact (Astra's dulled them), gradients map stop by stop, nested cards become stepped surfaces; 81 of 91 converted, 0.2 ms median, 0.7 ms worst, 44 ms at 32,700 elements.
- The failure both shared is pictures: dark transparent logos vanish. A post-load pass that reads the picture's pixels (Chromium's approach) fixed Apple, PostHog, Kharrazian, Hunter's icons in the prototype. Pixels are only readable for CORS-approved images.

## 4. Design

### 4.1 The converter (`apps/web/src/lib/mail-dark.ts`, pure, DOM in, no React)

`darkenMail(root: HTMLElement, palette: DarkPalette): DarkResult` walks `root`'s elements in document order (one `querySelectorAll("*")`), carrying each element's effective background and ink as written and as mapped (own color composited over the parent's, else inherited; the start is white paper). It reads inline styles through the CSSOM (so shorthands, quoting and order don't matter) and the legacy `bgcolor`, `<font color>`, `bordercolor`, `<hr color>`. It decides before it writes: a bail-out returns `{ converted: false, reason }` having written nothing. On success it writes inline declarations (keeping the sender's `!important` where the sender had it) and returns `{ converted: true, undo }`; `undo()` restores exactly the properties it set (value and priority), so later writes by others (the reader's own `overflow-y: clip`) survive.

Mapping (Fable's prototype, §1): surfaces through the theme ramp, vivid colors kept, pastels tinted, thin filled cells (≤ 3 px) and borders as lines (a hairline takes the theme's border, a strong rule stays strong), a black button on a light surface becomes the light button; ink by prior contrast, hue kept, links to the theme's link, text hidden on purpose stays hidden, then pushed to AA (4.6 to absorb 8-bit rounding). Islands left as written: inline SVG and anything over a background picture, their inherited colors pinned. Bail-outs: `too-large` (> 40,000 elements), `already-dark` (> 60% of text on dark), `background-picture` (> 35% of text over pictures), `image-only` (≥ 2 pictures ≥ 400 px wide and < 280 characters), `stays-light` (> 50% of text still on light). Caches per call keep repeated colors cheap.

The OKLab math moves to `packages/ui/src/themes/color.ts` as two exports (`rgbToOklab`, `oklabToRgb` with chroma reduction into the gamut); `luminance` and `composite` are reused. A small CSS color parser for what mail writes (hex with or without `#`, `rgb[a]`, `hsl[a]`, the named colors) lives in the module. `greyOf`/`mailDesign` are untouched: which mail is designed doesn't change.

`darkenPicture(img, ground, palette)`: draws a loaded picture at ≤ 48 px on a canvas and reads it (a picture that isn't CORS-readable throws and is skipped). Opaque pictures and pictures whose ink already stands out (≥ 3:1) are left; a mostly dark, near-monochrome see-through one gets `filter: invert(1) hue-rotate(180deg) brightness(.94)`; a mixed see-through one with dark parts gets a soft plate (`background` + `box-shadow` spread + radius, no layout change). Tracking pixels (< 100 px²) are skipped. Returns an undo.

### 4.2 The reader (`HtmlBody`)

- New look `"dark"` beside `"paper"` and `"themed"`: the themed colors (background, foreground, link, scheme dark), padding 0, no paper card around the frame. `mailColors().themed` gains `card` and `border` for the palette.
- `wantDark = !section && designed && appearance === "auto" && mode === "dark" && !original(messageId)`.
- The conversion runs **on the loaded document**, in `finish()` before the first height is measured (the frame is hidden until then, so paper never flashes), and again in place when the palette, the mode, the setting or Show original changes (undo, then convert or not). No rebuild: it's the same repaint-in-place path as theming. The result is React state (`darkened`), set in the same `flushSync` that shows the frame; `paper = appearance === "paper" || (designed && !darkened)`.
- Pictures: when darkened, each loaded picture in the flow goes through `darkenPicture` (already-complete ones at once, the rest on their `load`, one capture listener); at most 200 per mail. Undone with the conversion.
- **Show original**: a small muted link-style text button (BoardUI Link Button, `link-secondary` at `text-xs`, muted until hover) above the mail at its right edge, shown when the mail is darkened ("Show original") or put back by it ("Match theme"). Per message, for the session: a store like `remote-consent.ts` (`mail-original.ts`). Keyboard reachable, named.
- Full message view: a darkened mail opens it themed (`appearance` "auto"), like simple mail; "Show original" there keeps paper.
- Held messages (`held-message.tsx`) use `HtmlBody` and get the same.

### 4.3 Desktop: readable pictures

For `darkenPicture` to read a remote picture, the picture must be fetched in CORS mode and the response must allow it:

- the reader's sanitizer instance (a dedicated `DOMPurify(window)` in `mail-body.tsx`, so print and others are untouched) adds `crossorigin="anonymous"` to `<img>` **on desktop only** (`!WEB`): no cookies go with the request (better privacy than today);
- main, in the default session's `onHeadersReceived`, sets `Access-Control-Allow-Origin: *` (replacing any other) on responses to **image requests from a mail frame** (`isMailFrame`), and nothing else. A pure `mailImageHeaders(details, appOrigins)` beside `backstopAllows` in `network-backstop.ts`, unit-tested.

No new request is made: the same picture, the same consent and CSP. The web build gets the color conversion only (its remote pictures stay unreadable and are skipped; CID pictures are same-origin and readable).

### 4.4 Copy

- `reader.mail.showOriginal` "Show original" / "Ver original"; `reader.mail.matchTheme` "Match theme" / "Según el tema".
- `settings.appearance.htmlMail.hint`: "“Match theme” shows mail in the theme’s colors, designed mail too in a dark theme; “Always paper” keeps every mail as it was written." / Spanish to match.

## 5. Tests

- **Unit, `mail-dark.test.ts`** (jsdom): white page → background, white card on grey page → card, vivid band and its white text kept, pastel tinted, black CTA → light button, plain/quiet/colored/link ink and AA on every rewritten pair, hidden preheader stays hidden, `!important` kept, hairline vs strong border, thin cell as line, gradient stops, SVG and background-picture islands pinned, each bail-out, undo restores exactly (and keeps a later foreign property), a second palette after undo.
- **Unit, `darkenPicture`**: a canvas stub isn't available in jsdom, so its pixel classification is split into a pure `pictureFix(pixels, ground)` tested on synthetic RGBA arrays (dark mono glyph → invert, mixed → plate, opaque → none, light glyph → none, tracking pixel → none).
- **Unit, `network-backstop.test.ts`**: `mailImageHeaders` adds ACAO only for a mail frame's image, replaces an existing one case-insensitively, leaves the app frame, other resource types and other frames alone.
- **Unit, `color.test.ts`**: the two OKLab exports round-trip and reduce chroma into gamut.
- **E2E `themes.spec.ts`**: the designed case in Dracula is `data-mail=dark` with the theme's background; Show original → paper, Match theme → dark, same document (no reload); Always paper → paper and no control. `mail-repaint.spec.ts` still passes (no reload on theme changes, now also across dark ↔ paper of a designed mail).
- **Desktop**: in a dev run on a copy of a mailbox, a remote picture still loads with `crossorigin` (ACAO from main) and a dark logo is turned light; the packaged smoke's remote-image check stays green.
- Screenshots in light and dark, several palettes, looked at.

## 6. Performance and resources

The walk is one pass with per-call color caches: 0.2 ms median, 0.7 ms worst on 91 real newsletters, 44 ms at 32,700 elements; bounded at 40,000 elements. It runs once per load and once per palette change, never per render. Pictures: one 48 px canvas read each, at most 200, only when darkened. Nothing new on the network; no timers.

## 7. Out of scope

- Converting in light themes (a dark mail in a light theme stays as written).
- The print sheet (prints on paper).
- Opaque logos on their own white box (Slack's) stay white; an invert for them is riskier and left for later.
- Remembering Show original across sessions.

## Revisions after the Codex review

Codex (`codex exec -s read-only`) made twelve points against the plan and the first port. What changed:

1. **Conversion belongs to the loaded document.** It runs in `finish()` for each document (a rebuild for quote folding, remote content or CID pictures converts its own), the undo is reset there, and the live repaint only touches the document `loaded` names. Kept: the frame stays shown across a rebuild, as today; the new document is converted when parsed, before its first frame.
2. **A repaint remeasures.** Paper's 16 px padding comes and goes with the look, and the frame's observer watches a viewport that doesn't change, so the paint effect calls the loaded document's `measure()`. This also fixes the same gap when "Always paper" is toggled on simple mail.
3. Search marks: not changed. The conversion runs before the first marks; marks carry no inline colors, so on a later repaint their text counts the same and their surface is their parent's. The mark's tint is a 30% wash under inherited ink, as on themed mail.
4. Full message view: a darkened mail opens it themed (`appearance` "auto"). Its sections are read from the live document, so they carry the mapped colors; the themed sheet makes plain colors inherit, and what keeps a sender's `!important` keeps a color already mapped for the dark page. "Show original" puts the live document back before the view is opened again. The dropped `spam` flag on the portal is older than this plan and left for its own fix.
5. Held messages: not changed. A held send is the user's own mail, rarely designed; a "Show original" on it lasts while it's held.
6. Paper colors: not changed. The converter maps the mail **as written** (a white page, dark default ink), not Terno's paper presentation of it; that is what makes a preheader in the page's white count as hidden.
7. **Gradients:** text is judged against the hardest mapped stop (the lightest on a dark mapping), and stops are written opaque, since they were composited over their backdrop to be mapped.
8. **Pictures:** at most 60 per mail. Most arrive after the first paint, one load event each; the first reveal never waits for them.
9. **The size bound** counts a live `getElementsByTagName` collection, so a huge mail bails out without building an array.
10–11. `crossorigin` and the response header: kept, desktop only, verified in Electron (cold load, cache, a redirect). `isMailFrame` also matches the print preview's frame, whose pictures are fetched without CORS; an added header there changes nothing.
12. **E2E fixture:** a light newsletter with a nested card and a call to action; the existing designed fixtures (mostly dark) now check the `already-dark` bail-out.

## What the Codex code review changed

Codex reviewed the five commits (eleven findings). Fixed, each with a test that fails without it:

1. **Undo of mixed sides:** a legacy `bordercolor` and `<hr color>` are written as the four `border-*-color` longhands (only sides the style doesn't name), and a plated picture's corners as the four radius longhands, so `undo` puts back mixed and `!important` sides exactly.
2. **Gradients spanning light and dark** (a white-to-red gradient: white maps dark, red stays) can't hold one ink: such a gradient stays as written, an island, its inherited ink pinned.
3. **A gradient with no stop it can read** (`linear-gradient(transparent, transparent)` over white) no longer hides its fill from the mapping.
4. **Full message view:** mapped declarations are written without `!important` (inline, they replace the sender's whatever its priority; no sheet competes in the reader), so a section's themed sheet takes over the whole of a converted call to action instead of leaving its dark label on a cleared fill.
5. **A late load of the outgoing document** is ignored: `onLoad` checks the document's source id, as the parse path did.
6. **Pictures already loaded** were judged against the frame's paper before it was repainted: the backdrop is now the nearest surface inside the mail, else the dark page it now sits on.
7. **A server that refuses CORS-mode picture requests:** the reader asks again without CORS (removing the attribute refetches), on the picture's error and for any that failed before the document was set up. E2E with a route that answers 403 to a request carrying an Origin.
8. **Call-to-action checks** read a subtree each: at most 100 per mail.
10. **No light slab before the first reveal:** a mail that may darken gets no paper card until its document is converted and measured.
11. **React Compiler:** the look is chosen by a pure `lookOf`; what a load needs is read from one ref.

Also found while testing: simple (themed) mail in a dark theme had the same vanishing dark logo, so the picture pass runs there too (`DarkWork` "pictures").

Not changed: **9**, white text on an unchanged brand button below 4.5:1 (Evexia's pink, 4.25:1). The pair is exactly as the sender wrote it and as it shows on paper; the conversion doesn't make it worse, and rewriting a brand's button label is not the converter's call.

**Not rated (plan 158):** the rated screens' conversation is person-to-person mail, which this doesn't change; designed mail in dark appears in none of them.

**Second round** (on the fix, four findings, all fixed with tests; review rounds stop here):

- A gradient converts only when its mapped stops end up close (≤ 1.5:1 apart), so the ink judged against the hardest stop reads on all of it; a wider one (a brand gradient, light into a kept red) stays as written. A gradient in a notation the parser doesn't read (`oklch()`, `color-mix()`…) stays as written too, never its fill mapped under an unmapped gradient.
- `<hr color>` leaves the fill and any side the style names.
- The themed sheet also clears `background-image`: a simple mail never has one (it would be designed), and a darkened mail's full view, which is themed, no longer puts the theme's ink on a picture or gradient left behind.
