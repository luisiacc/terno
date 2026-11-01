# Plan 98: First-run setup (layout, look, then the first account)

## Request (verbatim)

> ok now that we are doing this, we need a good first-time setting, i want users to set up 2 things, first the style, they want otsee a grid or a list
>
> then the design and the color palette.
>
> for each, we need a real live preview with actual data so they can see a preview of how each thing actually looks.
>
> then after those 2 steps are done, we jump into adding the 1st account, have 75ms transitions animations that are clean and smooth.

> the defaults will be:
> - for light theme, lumen + github light
> - for dark theme, lumen + github dark.
> - defaults to system decisions of light dark

## What exists

- **First run** (`apps/web/src/components/first-run.tsx`): one centred welcome (mark, "Welcome to Terno", Add account / Not now). Shown by `app.tsx` while `fresh` (ready, no accounts, no owner, not demo), no other dialog is open and `localStorage["terno:first-run"] !== "done"`. "Add account" closes it and opens `AddAccountDialog` (a second dialog). It also picks a local Ollama / LM Studio model as the AI when local mode is on.
- **"Grid or list"** is the existing `layout: "split" | "list"` setting (plan 24; Settings → General → Layout, labels "Split" / "List"). Split = the conversation beside the list (columns); List = the list full width, the conversation opening in its place.
- **Design** (plan 15): `design: DesignId` (`macos`, `atelier`, `lumen`; default `lumen`), compiled to `[data-design=…]` CSS, so a subtree can render in any design. Settings → Appearance has `StyleCard` / `DesignPreview` (a hand-drawn mini-mock) and `ThemeCard` / `ThemePreview` (palette mini-mocks), all private to `appearance-tab.tsx`.
- **Palettes**: `lightTheme` / `darkTheme`, each `"design"` (the design's own palette, today's default) or a built-in id (`github-light`, `github-dark` exist) or `custom:<id>`. `theme: "system" | "light" | "dark"` (default system). Changes go through `updateAppearance()` (`lib/appearance.ts`), which paints `<html>` synchronously and persists.
- **Pre-paint** (`apps/web/public/theme.js`): with no cached appearance it paints Lumen in `lumen-light` / `lumen-dark`.
- **Settings defaults** (`packages/backend/src/settings.ts` `DEFAULT_SETTINGS`): stored settings are a partial object merged over the defaults, so changing a default changes it for every profile that never chose. Read-time migrations are versioned (`appearanceVersion`, …).
- **The real list row** (`thread-row.tsx` `ThreadRow`) renders from a `ThreadSummary` plus per-row store selectors (selection, checked, drafts, codes, reminders). It has a `wide` mode (List's one-line row) and the design's row variant.
- **Motion**: `--motion-base` is the user's motion setting (75 ms default; 0/50/75/100), `duration-base` utilities use it, `data-motion="off"` and `prefers-reduced-motion` turn everything off.

## Design

### 1. Flow

One dialog, three steps, one window that never closes between them:

1. **Layout**: "How do you like to read?" Two choices, **Columns** (split) and **List**, each with a one-line description. The preview shows the chosen layout.
2. **Look**: "Pick a style and colors." The three designs (`StyleCard`s), then the palettes of the mode being previewed (`ThemeCard`s) with a **Light / Dark** switch that changes which mode the preview shows and which palette slot the cards set. The mode setting stays **System** (the default); Settings changes it.
3. **Account**: "Add your first account." The add-account form itself, inside the same window (not a second dialog). On success the setup ends and the inbox fills.

Footer: step dots ("Step 1 of 3" for screen readers), **Back** (steps 2–3), **Continue** (steps 1–2), and **Skip setup** (quiet, every step) which ends the setup with whatever is chosen so far. Esc = Skip setup. Enter on a step = Continue (not inside a text field, where it submits the form as today).

The step is saved in `localStorage["terno:first-run"]` (`layout` | `look` | `account` | `done`), so a reload resumes on the same step (never lose position). Old values (`"mode"`, `"account"`) map to `layout` and `account`.

### 2. Choices apply live, to the real app

Every pick calls `updateAppearance()` at once: the whole app (and the setup window) repaint in the new layout, design and palette, exactly what the user will get. Back keeps the picks; nothing is applied twice. Skip keeps what was picked. No "apply" step, no undo needed: Settings has every one of these choices.

### 3. The live preview: real components, sample mail

There is no mail yet, so "actual data" is a small **sample mailbox** (`first-run-sample.ts`): 7 threads and the open conversation's 2 messages, written for the purpose (a friend's dinner plan, a flight receipt with an attachment, a starred project update, a newsletter, a verification-free notification, …), in the user's language through the catalog (`firstRun.sample.*`, `en` and `es`). Dates are relative to now (minutes, hours, yesterday, last week) so the list's date column reads naturally.

The preview (`first-run-preview.tsx`) is a framed miniature of the app, rendered at real size inside a fixed 1180×720 virtual canvas and scaled to the frame with a CSS transform (text, row heights and spacing are the real ones, just smaller). It contains:

- a sidebar with the real nav item look (Inbox selected with its count, Starred, Sent) and two categories;
- the **real `ThreadRow`** for every sample thread (classic / avatar / large-avatar from the design, `wide` in List), one of them shown selected;
- in Columns, the reader beside the list: the conversation header and the newest message, using the same type roles, header variant and body styles as `reader.tsx` (extract the presentational header pieces from `reader.tsx` where they are pure; otherwise a faithful composition of the same classes, kept next to the reader with a comment so they change together). In List, the list alone at full width.

Isolation: the preview is `inert` and `aria-hidden` (no focus, no clicks, no announcements); sample thread ids are negative so no store selector (selection, drafts, codes, reminders) ever matches a real thread; the "selected" look comes from a `preview` prop on `ThreadRow` (one boolean, default false; the hot path is unchanged). No backend calls, no sender icons (`icons={false}`), no network.

Each step's preview is the whole app in the current choice. Step 2's cards keep their own mini-mocks (each in its own `[data-design]` / `[data-theme]`), so every option is visible at once while the big preview shows the picked one. `StyleCard`, `ThemeCard` and their previews move from `appearance-tab.tsx` to `settings/appearance-cards.tsx` and are shared.

### 4. Window and motion

- A wide dialog: `min(960px, 94vw)` × `min(640px, 90vh)`. Left column (≈ 320 px): title, description, choices, footer. Right: the preview, filling its column, on the `pane` surface with a hairline.
- Below 720 px wide the preview moves above the choices and shrinks.
- **Step change**: the outgoing step's column fades out and the incoming one fades in with a 6 px horizontal slide (forward from the right, Back from the left), `duration-base` (`--motion-base`, 75 ms by default) with `ease-motion`. The preview cross-fades when its content changes (layout, design, palette), same duration. No layout shift: the window keeps its size across steps.
- Motion off / reduced: instant swaps (the global rules already zero durations; the slide uses `motion-safe:`).

### 5. Account step

`AddAccountDialog`'s body becomes `AddAccountForm` (`add-account-form.tsx`): the sync window, Gmail button, IMAP fields, errors. `AddAccountDialog` wraps it in its dialog as today; the setup renders it in step 3. On success the form calls `onDone` (the dialog closes itself; the setup marks `done`). The web's Mac nudge (`OnboardingNudge`) sits under the form on step 3.

### 6. New defaults

- `DEFAULT_SETTINGS.lightTheme = "github-light"`, `darkTheme = "github-dark"` (design stays `lumen`, theme stays `system`).
- **Existing profiles keep what they see.** A new `appearanceVersion` 3 migration: a stored settings object that is non-empty and below version 3 gets `lightTheme` / `darkTheme` written as `"design"` when they're absent (that was their effective value). A fresh profile (empty store) gets the new defaults.
- `theme.js`: with no cached appearance it paints Lumen with `github-light` / `github-dark`, so a fresh install's first frame already matches.
- The palette cards keep the registry's order; the default is simply the selected one.

### 7. Strings

`firstRun.*` (en, es): step titles and descriptions, Columns / List names and one-liners, Light / Dark, Back, Continue, Skip setup, step counter, and the sample mailbox (senders, subjects, snippets, the open message). `account.addTitle` etc. are reused. Removes `firstRun.welcome`'s current description if unused.

## Tests

- **Unit**
  - `settings.test.ts`: a fresh store reads `github-light` / `github-dark`; a pre-v3 non-empty store without palettes reads `"design"`; a stored explicit palette is kept; the v2 migration (previous palettes) still holds.
  - `first-run-sample.test.ts`: every sample thread renders in en and es (no missing key), ids are negative and unique, dates are in the past.
  - `theme.js` fresh-paint test (where theme.js is tested today): no cache → `data-theme` github-light / github-dark per system mode.
- **E2E** (`apps/web/e2e/first-run.spec.ts`, `@design` where it applies)
  - Fresh install: step 1 shows the preview with sample rows in split; choose List → `html[data-layout=list]` and the preview's rows are wide; Continue.
  - Step 2: pick Atelier → `html[data-design=atelier]`; switch the preview to Dark, pick a dark palette → settings `darkTheme` saved; light untouched; Back returns to step 1 with List still selected.
  - Step 3: add an IMAP account in the setup window → setup gone, account listed, owner set (`ownerClaims`).
  - Reload on step 2 resumes on step 2; Skip setup ends it and it doesn't come back.
  - The preview isn't focusable and has no accessible content (Tab order skips it; axe clean) in light and dark.
  - Motion off: the step swap has no running animation.
  - Existing identity spec's first-run test follows the new flow.
- **Visual**: each step, light and dark, in the default design; step 2 also in Atelier. Baselines that change because of the new default palettes are regenerated and looked at.
- **Perf**: `pnpm test:ui-perf` (entry chunk gate: the setup, the sample and the preview are one lazy chunk loaded only when the setup shows); the `ThreadRow` render counts are unchanged.

## Perf and resources

- Lazy: `first-run.tsx` becomes a tiny loader; the setup module (wizard, preview, sample, shared cards, account form import) is a dynamic import, fetched only on a fresh install.
- The preview renders ≤ 8 rows once per choice; nothing animates while idle; no timers (the relative dates are computed once on open).

## Out of scope

- Choosing the mode (System / Light / Dark) and density in the setup: Settings has them.
- Custom palettes in the setup.
- Showing the setup again to existing users (a "Run setup again" entry can come later).

## Revisions after the Codex review

Twelve points; each changes the design above as follows (this section overrides it where they differ).

1. **Staged migration.** `migrateAppearance` keeps running only below version 2 (it strips palettes). A new `migratePaletteDefaults` runs below 3: freshness is read from the **raw** stored object before any migration (`{}` = fresh); a non-fresh profile gets `lightTheme` / `darkTheme` = `"design"` where absent; every profile is then marked 3. `APPEARANCE_VERSION` becomes 3 with the v2 step gated on `< 2`. Tests: v1 profile (previous palettes kept, palettes "design"), v2 profile without palettes ("design"), v2 with explicit palettes (kept), fresh (github), repeated reads, and the first unrelated write persisting the marker.
2. **theme.js: fresh and legacy apart.** `LUMEN` (lumen-light / lumen-dark) stays the conversion target for pre-v2 caches; a new `FRESH` (Lumen, github-light / github-dark) is used only when there's no cache at all. Tests for both paths.
3. **The preview is its own appearance subtree.** It sets `data-design`, `data-theme` (or the custom tokens), the `dark` class and `color-scheme` on its own root, from the choices and a **preview mode** (Light / Dark on step 2; the resolved mode elsewhere). It never touches `<html>` or the persisted mode. Tests: system light + preview dark, and system dark + preview light.
4. **A presentational row.** `ThreadRow`'s markup moves to `ThreadRowView`, which takes every piece of state as props (selected, checked, inSelection, account label, categories, draft, code, reminder, reminders-list flag). `ThreadRow` keeps its selectors and memo and renders the view; `renderProbe("ThreadRow")` stays where it is, so the render-count gates are unchanged. The preview renders `ThreadRowView` with sample state only: no store, no code timers. Test: changing the real store's selection, checked set, scope, categories and reminders doesn't change the preview.
5. **No sender icons anywhere in the preview.** The preview's avatars are `SenderAvatar` with no icon source (initials in the sample colors); the reader part passes no `icons`. Test: mounting the preview and switching every design issues no icon request (the backend's icon RPC isn't called).
6. **Faithful structure.** The preview includes the list header in the design's `listHeader` variant (title / display / greeting), search (`field` / `button`), compose (`list-header` / sidebar outline / sidebar pill), quick filters (`menu` / `chips`), and the reader header variant, all driven by the same `variants` the app switches on and the same type-role classes, plus the real `ThreadRowView`. The pieces are pure functions of `(design, sample)`, kept in `first-run-preview.tsx` with a comment pointing at the app components they mirror; `designs.spec.ts`-style test: each design's preview shows its variant's marker (e.g. chips in Lumen, a search button where `search: "button"`).
7. **It fits.** Window `min(1040px, 94vw)` × `min(680px, 90vh)`. The left column (360 px) is a flex column: header, a **scrolling** choices/form region, and a footer that's always visible. Step 2 lists designs as compact radio rows (name + description; the big preview shows the look) and palettes as `ThemeCard`s two per row. Below 760 px the preview hides (choices only, still live in the app behind). Verified with screenshots at 1280×800, 900×600 and in Spanish.
8. **Account work survives Back.** The form's values live in the setup host (memory only; never localStorage) and are passed to `AddAccountForm` controlled. While a connection is in flight, Back, Skip and Esc are disabled. Test: type, Back, Continue: the values are there; Back is disabled while connecting.
9. **The Gmail client-ID route.** `AddAccountForm` takes `onNeedsSetup()`; the dialog keeps today's behavior (open Settings → Accounts). The setup saves step `account` first, then opens Settings; when Settings closes, the setup (still `fresh`, step `account`) shows again. Google preloading moves to the form's mount.
10. **No global Enter.** Continue is a normal button; choices are radios (arrow keys move, Space/Enter select, as `RadioGroup` does). On a step change focus moves to the step's heading (`tabIndex=-1`, programmatic: no ring), which also announces it. Keyboard test: Tab to a design, Enter selects it and does not advance.
11. **Animations, not transitions.** The incoming step and the preview's content enter with a keyframe fade + 6 px slide (`animate-in fade-in-0 slide-in-from-right-[6px]`, `duration-base`, `ease-motion`), keyed on the step / choice. Only the incoming element animates (one 75 ms phase, nothing fades out), and `data-theme-switching` only suppresses transitions, so the entrance survives an appearance switch while colors still swap in one frame. Motion off or reduced: the global rules remove animations. Test: with motion 0, the step container has no running animation (`getAnimations()` empty).
12. **The preview follows the reconciled state.** The preview's design, layout and palettes read from the settings in the app store (optimistic, then reconciled or rolled back by `commitAppearance`), not from local picks, so a refused save or a superseded design choice shows the truth. The design rows' selection also reads from it, so a design waiting up to 300 ms for its faces shows selected only once applied. Tests: a refused `settings.update` rolls the preview back; two quick design picks end on the second.

### Where the build differs from the design above

- **Names.** The layouts keep Settings' names, **Split** and **List** (one name per thing), with a one-line description each; "Columns" isn't used.
- **Step 2's styles** are a row of three tiles (an "Aa" in the style's own title type, and its name), with the picked one's description under them, instead of rows with descriptions: the styles stay in view and the palettes get the room. The palettes scroll on their own; a window too short for a row of them scrolls the step as a whole.
- **The old single-step values** (`"mode"`, `"account"`) in `terno:first-run` map onto `layout` and `account`.
- **E2E projects keep their designs' own colors.** The fixture sets `lightTheme`/`darkTheme` to `"design"` with a project's design, so existing baselines stand; a new install (`design: null`) gets the GitHub defaults. backend-dev's seeded profile is stamped with the current appearance version (it's a new install's settings, not an older profile's).
- **Freshness** is an empty stored settings object. A profile that existed but never wrote a setting reads as new and gets the GitHub palettes; every install that finished the old first run wrote `localMode` (or an AI choice), so in practice that's only installs that never got past it.

## What the Codex code review changed

Two rounds (`codex exec -s read-only` over `5a4e9a09..HEAD`, the prompt asking for at most 12 findings against this plan and AGENTS.md). Every finding was fixed with a regression test, run first against the code before the fix to see it fail.

Round 1 (3 findings):

1. **The account draft was lost on the Google detour.** No client ID yet sends the user to Settings → Accounts, which unmounts the setup; it came back empty. Now a module object keeps the draft in memory until the setup ends (then it's dropped). Test: type, detour, Esc, the email is still there.
2. **A short window couldn't reach the palettes.** At 900×400 only the palette grid scrolled and it collapsed to nothing. Now the grid keeps at least a row and the step scrolls as a whole. Test: at 900×400 the last palette scrolls into view and is picked; Continue stays in view.
3. **List's preview had no inbox tabs, and Split's chips missed "With attachments".** The preview now draws the tabs with list-tabs.tsx's own `tabClass` (pill or underline by design) and the full chip set. Test: chips include "With attachments"; List shows All, Unread and the categories as tabs.

Round 2 (2 findings; round 1's fixes confirmed):

4. **Coming back from the detour ran the local-model discovery again**, overwriting an AI chosen in Settings meanwhile. It now runs once per setup session. Test with the Ollama stub: discovery picks Ollama, the user picks none in Settings during the detour, coming back keeps none.
5. **brand.spec and the web first-run spec still expected the old welcome.** The brand test names the dialog by step 1's title; the web test walks to the account step and finds the Mac nudge under the form.

## Follow-up: bigger window, bigger preview

> the initial window size of the entire ap should be bigger, and also the preview of the app when chaning grid/list and palette should also be bigger

- **The desktop window** opens at 92% of the primary display's work area, at most 1920×1200 and never below 980×600 (`apps/desktop/src/window-size.ts`, unit-tested), instead of a fixed 1400×880: 1590×993 on a 16-inch MacBook Pro, and it now fits a 13-inch Air, which 1400×880 overflowed. Sizes aren't remembered across launches (out of scope).
- **The setup** is up to 1360×860 (380 px of choices). The preview's canvas keeps a 1180 px width and takes its height from the panel's shape (680 to 980 px), so it fills the panel at about twice the old scale.
- Codex review of both: no findings. Checked: the first-run, identity, brand and visual specs (baselines regenerated and looked at, light and dark), `pnpm dist:mac` and the packaged smoke (75 passed).

## Follow-up: System, Light and Dark

> here we need s 'system' which chooses whatever the system has

The colors' switch is now the appearance setting itself (Settings' Mode): **System** (the default) follows the Mac and offers both modes' palettes, light then dark, the preview showing the mode last picked in (the system's until then); **Light** and **Dark** switch the app and offer that mode's palettes only. New strings (`firstRun.look.mode` is now "Appearance"; `firstRun.look.modeHint.light`/`.dark`) in `en` and `es`. Codex review: no findings. E2E covers both groups under System, a dark pick previewing dark in a light window, and Light/Dark switching the app.
