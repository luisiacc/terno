# Plan 194: one meaning per color, and calmer chrome

- **Status:** built.
- **Touches:** plan 15 (palettes), 23 (a row's account), 87 (reminders' bell), 97 (the site's pictures), 173 (a row's marks), 177 (who's on a conversation), 179 (Pin).

## The request (verbatim)

> check the picture, what changes you propose we can do with that, i think we should remove blue as a possible category color so to not clash with the unread one .

Then, on the proposal: "implement them all in this branch". The feedback, on the inbox picture on terno.app (Terno Light, classic, three-line rows):

> 1. Categories and accounts use the same dots and the same colors. […] Accounts and categories need different visual treatments, such as a colored dot for one and an outlined tag for the other, or account initials.
> 2. The blue unread dot clashes with blue account dots. […] Unread state should have its own color that no account or category can use.
> 3. The reader header is crowded. The title, the Studio dot, "3 messages", "Expand all" and the Clients chip all compete on one line. The "PN Priya" participant chip under it repeats information. I'd move the metadata to a quieter second line and drop the participant chip for 1:1 threads.
> 4. The list metadata row is cramped. When a row has a dot, a paperclip, a star and an account name, the preview gets cut down […]. Moving the icons to the time row would give the preview room.
> 5. The reader toolbar has no labels. […] pin vs. bell isn't obvious. […] grouping the icons or giving the main action a label would help more.
> 6. The floating buttons at bottom right (theme toggle and expand) sit on top of the content and look like dev tooling. The visible focus ring makes them stand out even more.
> 7. The thread count "3" next to "Priya Natarajan" is easy to miss. A small pill would make it readable.

And what to keep: the type scale and ~70-character reading column, the code chip, "9 unread · 19 to reply to", the `R` hint, folded earlier messages, attachments at the top, the soft selected fill, and color kept for meaning.

## What exists

- **One palette for two things.** `CATEGORY_COLORS` (`packages/core/src/types.ts`: rose, amber, lime, emerald, cyan, indigo, violet, slate) colors categories *and* accounts (`account-menu.tsx`, `settings/parts.tsx`), and `CategoryDot` draws both as the same filled 8 px dot (sidebar, reader, sign-in, settings, palette). Each palette (`packages/ui/src/themes/registry.ts`) gives the eight a value (`cats`), and `cat-<name>` / `cat-<name>-ink` are theme tokens (`THEME_TOKENS`, `packages/core/src/themes.ts`) a custom theme may set.
- **Unread is each palette's own color** (`unread`), not always blue. Measured as hue distance from `unread` to each category color with chroma ≥ 0.05: indigo sits within 25° in 15 of 22 palettes (0° in Terno, GitHub, Solarized, Atelier, Tokyo Night); violet is unread's own hue in both Catppuccins (0°), emerald in Monokai (0°) and lime 24°, rose 18° in Dracula, cyan 23–28° in Apple and Tokyo Night, Tokyo Night's slate (C .08) 13°.
- **Where the colors are stored.** `accounts.color` and `categories.color` in SQLite (`packages/db`) and IndexedDB (`packages/idb`), read by each store's `toAccount`/`toCategory`; a backup's categories (`exportCategorySchema`); a custom theme's tokens (`customThemeSchema`, `.strict()` over `z.enum(THEME_TOKENS)`).
- **A three-line row** (plan 173): line 1 sender, count, (code), date; line 2 subject; line 3 preview, then the marks (≤ 2 category dots, paperclip, star, bell) and the account's name at the right edge. The count is bare `text-xs` muted digits.
- **The reader header** (`ReaderHeader`): in `classic` and `sender-card`, the subject and `ThreadChips` (account dot + name, "N messages · Expand all", category chips, suggestions) share one wrapping line; `chips-display` puts the chips above the subject. `ThreadPeople` (plan 177) closes the header for two or more messages, a chip per person other than the user, even when that's one person.
- **The reader toolbar:** [Archive Trash Spam] divider [Star Pin Bell (Summarize) More] then Reply/Forward. Reminders use `Bell` everywhere (toolbar, rows, menus, palette, sidebar's Reminders, selection bar).
- **The site** (`apps/site/src/parts/shot.tsx`): every picture has a light/dark switch and an enlarge button pinned over its bottom-right corner, always visible, with the browser's default focus outline.

## Design

### 1. Unread owns its hue

- **Indigo leaves; brown takes its slot.** `CATEGORY_COLORS` becomes rose, amber, lime, emerald, cyan, **brown**, violet, slate: still eight, so auto-assignment and existing distinctness hold, and none of them is blue. The theme tokens follow (`cat-brown`, `cat-brown-ink`; `cat-indigo*` are gone), and every palette gives brown a value: amber's family, redder (H ≈ 50), lower in chroma (≈ .07) and lightness, so it reads as brown beside amber.
- **The rule, held by a test.** In every built-in palette, every category color with chroma ≥ 0.05 is at least **30°** of hue from `unread` (when unread has chroma ≥ 0.05). Palettes that break it after the swap move the *category* color where the palette has room: Dracula's rose becomes its red, Monokai's lime a yellow and emerald a teal-green, Apple's and Tokyo Night's cyan move toward teal, Tokyo Night's slate loses chroma. Catppuccin has none (its pink sits 23° from its red in Mocha), so there `unread` takes the palette's own blue, the slot indigo freed; its accent stays mauve. The contrast suite already derives and checks each `-ink`.
- **Old values.** One function in core, `categoryColor(raw)`: a known color is itself, `"indigo"` (retired) is `"brown"` (its slot, so a user's colors stay as distinct as they were), anything else `"slate"`. Each store's account reader (`toAccount`) and category list and create read through it, so nothing is rewritten and no migration runs. Inputs that may carry an old value accept it the same way: a backup's categories and the RPC color inputs (`categoryColorSchema`, a preprocess before the enum). A saved custom theme's `cat-indigo`/`cat-indigo-ink` move to `cat-brown`/`cat-brown-ink` (`upgradeThemeTokens`, one the theme set under the new name wins), in the schema (imports, edits) and where settings are read, so the theme stays valid and the categories that were indigo keep the user's own color.

### 2. Accounts are diamonds, categories dots

- `AccountMark` beside `CategoryDot` (`packages/ui/src/components/category-dot.tsx`): a small filled diamond in the account's color, a 7 px square turned 45°, about the dot's area so neither weighs more. (Built first as a hollow ring; the owner preferred filled diamonds.) Accounts use it everywhere they're marked (sidebar's accounts, Move/focus lists, the reader's account, sign-in, Settings → Accounts, the account menu's header); categories keep the dot. The color pickers keep their swatches.
- A row names its account in words, as now; once its marks leave the preview's line (3), no dot sits beside the name.

### 3. A three-line row's marks go up to its date

- The marks (≤ 2 dots, paperclip, star, bell) end line 1, before the code chip and the date; line 3 is the preview and the account's name only. Review already keeps them there. With no preview (plan 187), the subject's line keeps only the account. One-line rows (compact, wide) are unchanged.
- What gives way on a short line 1: the marks take only what the sender (65% at most), the count, the code and the date leave, and drop whole from the end (their box is one glyph tall and wraps, so what doesn't fit goes below it, out of sight); then the sender truncates. The code, Spam/Trash/Opened and the date never shrink. A screen reader still hears every mark in the row's sentence.

### 4. A calmer reader header

- `classic` and `sender-card`: the subject on its own line (it may wrap), then `ThreadChips` as a quiet second line under it (account, N messages · Expand all, category chips, suggestions). `chips-display` already does this the other way round and stays.
- `ThreadPeople` shows only when the conversation has **two or more** people besides the user; a 1:1 conversation's message headers already say who. The chip was also the way to that person's menu (plan 180), so each message's ⋯ (and its right-click) now offers what's done about whoever wrote it: New message to, Conversations with, Copy address and the sender's filing (`PersonItems`, shared with the chip's menu).

### 5. The toolbar

- Its groups get one more divider: [Archive Trash Spam] | [Star Pin Remind (Summarize)] | More. No labels: tooltips name each with its key.
- Reminders get a clock (`AlarmClock`, `AlarmClockOff` for Clear), everywhere the bell meant a reminder, so the toolbar's glyph reads as "remind me", not notifications. Send later keeps `Clock`.

### 6. The site's picture tools

- Faded out (opacity, never hidden, so Tab still reaches them) until the picture is hovered or holds focus (`:hover`, `:focus-within`); always shown where there's no hover (`@media (hover: hover)` gates the fade); an 80 ms fade, none under reduced motion.
- The site already rings only keyboard focus (`:focus-visible`); the ring in the feedback's picture was a Tab's.

### 7. The count as a pill

- The message count beside the sender is a neutral `Badge` (BoardUI), tabular, in every layout; its sr-only words stay.

### Pictures

`pnpm --filter @terno/site shots` retakes the site's pictures (the showcase mailbox: Personal and Dev were indigo; Personal becomes rose, Dev brown).

## Tests

- `registry.test.ts`: the 30° rule over every built-in palette (fails today); `contrast.test.ts` keeps every `cat-*-ink` pair AA (brown included).
- `types`/core unit: `categoryColor` maps known, `indigo`, junk; `categoryColorSchema` and `customThemeSchema` accept an old backup and an old custom theme.
- Store conformance (`packages/store`): an account and a category written as `indigo` read back as `brown`, in both engines.
- `thread-people.test.ts`: one other person, nothing; two, both.
- e2e: `inbox-scan`/`list-layout` (marks on the date's line, the preview line ends with the account), the reader spec (subject alone on its line; chips under it; no people line for a 1:1 thread), the sidebar (accounts are diamonds, categories dots). Site: `apps/site` test that the tools are hidden at rest and shown on hover/focus.
- Visual: the inbox in light and dark (classic, macOS, Lumen), looked at; `pnpm ui:rate` + `ui:gate` (list and reader change).

## Performance

No new subscription, query or render: a row renders the same elements on another line; `categoryColor` is a Set lookup per account/category read (a few dozen). The list perf gate (`test:ui-perf`) is run for the row change.

## Out of scope

- Account initials or avatars (a diamond does the job without a new shape per account).
- Text labels on toolbar buttons.
- Changing any palette's `unread` or accent.

## Revisions after the Codex review

1. **A theme that set only indigo's tokens** would have been left empty and invalid (and an import validates the list whole). Retired tokens now move to brown's names instead of being dropped; `registry.test.ts` covers a theme with only them and one with both.
2. **Stored themes** were read without the schema; `resolveThemes` (backend settings) applies the same `upgradeThemeTokens`. `settings.test.ts` reads a stored theme with `cat-indigo`.
3. **The stores' boundaries** are named as they are: `toAccount`, the category list and `createCategory`'s returned object, so create, list and a reopen agree. The conformance case writes `indigo` as an older build did and reads `brown` in both engines.
4. **Other color consumers**: the avatar palette (`format.ts`, now `CATEGORY_COLORS` itself), the storage chart, the appearance previews, the color labels in `en` and `es`.
5. **The Tailwind bridge** (`globals.css`) and the generated theme CSS were updated; `generate.test.ts` passes.
6. **Contrast where account and category marks are drawn.** Adding pairs for the sidebar surfaces showed that category dots never reached 3:1 there in about half the palettes, before this change too. Not done here: a dot or diamond is never the only cue (its name is always beside it), and a sidebar-wide palette retune is its own plan.
7. **Custom themes** can still pick a category color near their unread: the 30° rule holds the built-in palettes; a user's own colors are theirs.
8. **Overflow on line 1**: the policy above (marks drop whole, then the sender), with `account-label.spec` checking the narrowest list keeps 40 px of sender and the marks on the date's line.
9. **The people chip was a menu**: kept as each message's ⋯ (above); e2e drives it by keyboard and axe-checks it.
10. **The clock icon**: `AlarmClock`/`AlarmClockOff` added to the catalog and generated; a due reminder is a 20% wash inside the clock, not a solid fill.
11. **The site's focus ring** was already keyboard-only; the tools fade with opacity so `:focus-within` and Tab keep working; the `display: contents` wrapper is untouched.
12. **Tests that pinned the old layout** (`thread-row-marks.test.tsx`, `designs.spec`, `account-label.spec`, `account-menu.spec`) were updated; the 1:1 case is in `thread-overview.test.tsx`. MCP's category creation sends brown.

## Revisions after the Codex code review

1. **A conversation the user only wrote to** lost its one recipient's actions with the chip: no message there is theirs, and the ⋯ offered only a message's writer. The ⋯ of the user's own message now offers the conversation's only other person (`messagePerson`, `thread-overview.test.ts`).
2. **"Reply to X only"** was dropped from the ⋯ though the chip offered it when a Reply-To sends a plain Reply elsewhere. The ⋯ now uses the chip's own rule (`conversationPeople`, shared by both), tested with a Reply-To.

## Atelier's dark palette (the owner, after the series)

> make the atelier dark style color palette be like the dark palette of graphite, its currently too dark

Atelier's dark palette (`atelier-dark`) now wears Graphite's dark palette whole: one `GRAPHITE_DARK` input in the registry that both themes spread, so they can't drift. Atelier keeps its name, type and structure; only its colors change. `registry.test.ts` holds the two equal; the control-edge test, which pinned Graphite's control overrides to Graphite alone, now names Atelier's dark too.

## The row a sidebar menu is for (the owner, after the series)

> for the right click menu here of these items categories and accounts, tehre is no marker on which of them the right click menu is, lets have a nice clean marker for that item when the right lcick menu is active for it

A sidebar row (a category, an account, a folder, a favorite, the focused account's title) is outlined while its right-click menu is open: the list's own mark for the row a menu is for (`ROW_OUTLINE`, 2 px of `--ring` inside the row's shape). Pure CSS on the menu trigger's `data-popup-open` (each trigger wraps its row alone), so opening a menu renders nothing. `account-menu.spec` checks an account's and a category's row: outlined while open, only that row, gone when it closes.
