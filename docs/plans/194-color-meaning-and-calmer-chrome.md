# Plan 194: one meaning per color, and calmer chrome

- **Status:** building.
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
- **The rule, held by a test.** In every built-in palette, every category color with chroma ≥ 0.05 is at least **30°** of hue from `unread` (when unread has chroma ≥ 0.05). Palettes that break it after the swap move the *category* color, never `unread` (each palette's accent and unread stay as their authors made them): Catppuccin's violet becomes its pink, Dracula's rose its red, Monokai's lime its yellow and emerald a teal-green, Apple's and Tokyo Night's cyan move toward teal, Tokyo Night's slate loses chroma. The contrast suite already derives and checks each `-ink`.
- **Old values.** One function in core, `categoryColor(raw)`: a known color is itself, `"indigo"` (retired) is `"brown"` (its slot, so a user's colors stay as distinct as they were), anything else `"slate"`. Each store's `toAccount`/`toCategory` reads through it, so nothing is rewritten and no migration runs. Inputs that may carry an old value accept it the same way: a backup's categories and the RPC color inputs (`categoryColorSchema`, a preprocess before the enum). A saved custom theme's `cat-indigo`/`cat-indigo-ink` keys are dropped on parse (a blue for the brown slot would be wrong), so the theme stays valid instead of failing `.strict()`.

### 2. Accounts are rings, categories dots

- `AccountRing` beside `CategoryDot` (`packages/ui/src/components/category-dot.tsx`): the same 8 px box, a 1.5 px ring in the account's color, hollow. Accounts use it everywhere they're marked (sidebar's accounts, Move/focus lists, the reader's account, sign-in, Settings → Accounts, the account menu's header); categories keep the dot. The color pickers keep their swatches.
- A row names its account in words, as now; once its marks leave the preview's line (3), no dot sits beside the name.

### 3. A three-line row's marks go up to its date

- The marks (≤ 2 dots, paperclip, star, bell) end line 1, before the code chip and the date; line 3 is the preview and the account's name only. Review already keeps them there. With no preview (plan 187), the subject's line keeps only the account. One-line rows (compact, wide) are unchanged.
- The sender gives way first on line 1 (it truncates; the marks and date don't shrink), as the code chip already makes it.

### 4. A calmer reader header

- `classic` and `sender-card`: the subject on its own line (it may wrap), then `ThreadChips` as a quiet second line under it (account, N messages · Expand all, category chips, suggestions). `chips-display` already does this the other way round and stays.
- `ThreadPeople` shows only when the conversation has **two or more** people besides the user; a 1:1 conversation's message headers already say who.

### 5. The toolbar

- Its groups get one more divider: [Archive Trash Spam] | [Star Pin Remind (Summarize)] | More. No labels: tooltips name each with its key.
- Reminders get a clock (`AlarmClock`, `AlarmClockOff` for Clear), everywhere the bell meant a reminder, so the toolbar's glyph reads as "remind me", not notifications. Send later keeps `Clock`.

### 6. The site's picture tools

- Hidden until the picture is hovered or holds focus (`:hover`, `:focus-within`), always shown where there's no hover (`@media (hover: none)`); a fade within the site's 80 ms, none under reduced motion.
- A focus ring only for keyboard focus (`:focus-visible`), drawn in the site's own ring; none after a click.

### 7. The count as a pill

- The message count beside the sender is a neutral `Badge` (BoardUI), tabular, in every layout; its sr-only words stay.

### Pictures

`pnpm --filter @terno/site shots` retakes the site's pictures (the showcase mailbox: Personal and Dev were indigo; Personal becomes rose, Dev brown).

## Tests

- `registry.test.ts`: the 30° rule over every built-in palette (fails today); `contrast.test.ts` keeps every `cat-*-ink` pair AA (brown included).
- `types`/core unit: `categoryColor` maps known, `indigo`, junk; `categoryColorSchema` and `customThemeSchema` accept an old backup and an old custom theme.
- Store conformance (`packages/store`): an account and a category written as `indigo` read back as `brown`, in both engines.
- `thread-people.test.ts`: one other person, nothing; two, both.
- e2e: `inbox-scan`/`list-layout` (marks on the date's line, the preview line ends with the account), the reader spec (subject alone on its line; chips under it; no people line for a 1:1 thread), the sidebar (accounts are rings, categories dots). Site: `apps/site` test that the tools are hidden at rest and shown on hover/focus.
- Visual: the inbox in light and dark (classic, macOS, Lumen), looked at; `pnpm ui:rate` + `ui:gate` (list and reader change).

## Performance

No new subscription, query or render: a row renders the same elements on another line; `categoryColor` is a Set lookup per account/category read (a few dozen). The list perf gate (`test:ui-perf`) is run for the row change.

## Out of scope

- Account initials or avatars (rings do the job without a new shape per account).
- Text labels on toolbar buttons.
- Changing any palette's `unread` or accent.

## Revisions after the Codex review
