# Plan 203: search in Settings

## Request (verbatim)

> lets implement the settings search box to look on things, it must be able to search on every setting on every page and show the placement in the dropdown and why it matched that section, wit ha clean ui respecting our design.

## What exists

- **Settings** (`apps/web/src/components/settings-dialog.tsx`): a dialog with a sidebar of sections (`settings/tabs.ts`, `SETTINGS_TABS` plus Dev on a local build) and a pane per section. Rows are `SettingsRow` inside `SettingsGroup` (`settings/parts.tsx`): a label, a hint and the control, about 150 rows across twelve sections. Labels and hints are catalog keys (`t()`), most of them without parameters.
- **Pages and disclosures inside a section.** AI → Drafting opens Writing style as a page of its own (`useAiDraftUi.stylePage`, plan 161). Each account in Accounts is an accordion item whose rows render only while it is open; each category in Categories is a collapsible the same way. Settings opened on an account opens it (`settingsAccount`, plan 106), once.
- **Rows that show only sometimes**: by platform (notifications and the badge, updates, the web's storage and Mac sections), by feature availability (`aiFeaturesAvailable`: Today, the digest), by provider (the AI model, endpoint and keys), by account kind (Gmail's tabs and Google photos), and under a switch (Undo send's window, follow-ups' nudge, drafting's details).
- **No search.** The palette has a Settings group, but it lists only sections ("Settings → Appearance"), never a setting.
- **BoardUI's Combobox** is "port on first use" (`packages/ui/BOARDUI.md`). Its spec (boardui.com/r/combobox.json): a field that filters a list as you type; the list is the menu surface under the field, rows highlighted on the focused option, sections with a muted heading, a quiet empty message.

## Design

### Where it sits and how it looks

A search field at the top of the Settings sidebar, under its "Settings" title, the sidebar's full width at its row inset: where macOS System Settings puts it. `⌘F` (Ctrl+F) inside Settings focuses it.

Typing opens a dropdown under the field: the menu panel (`MENU_PANEL`), wider than the sidebar (it runs over the pane, 360 px, aligned to the field's start), at most about seven results tall and then scrolling. Each result is one option:

```
 [section glyph]  Undo send                      (the setting's name, the match in medium weight)
                  General › Writing              (where it is: section › group, or › the account / category)
                  “…take back a message for a few seconds…”   (why it matched, only when it isn't already visible)
```

- **The name** is the row's label. The matched words are drawn in the foreground at medium weight; the rest of the line stays as it is (no yellow, no colour).
- **The placement** is the section, then the group's title when it has one, then the account or category the row belongs to, then "Writing style" for that page. Separated by a chevron glyph, muted, one line, truncated at the end.
- **Why it matched**, one muted line, only when the reason isn't already on screen:
  - the description (hint) matched: the hint's words around the match, the match emphasized;
  - a related word matched (each setting can carry a few in the catalog: "dark" for Mode, "password" for an account's connection): "Matches “dark mode”";
  - an English word matched while Settings is in Spanish (the palette's rule, `lib/palette-words.ts`): "Matches “…”" with that word.
  When the name or the placement matched, the emphasis there is the reason and no third line shows.
- The section's own glyph (the sidebar's) leads each result, muted, so a column of results reads by section at a glance.
- **Nothing matches:** one quiet line, "No settings match “…”", in the panel.
- **Keyboard:** the arrows move through results (the field keeps focus, `aria-activedescendant`), Enter opens the highlighted one, Esc closes the dropdown, a second Esc empties the field, a third closes Settings (each level steps back, as Writing style's Esc does). Tab leaves the field and closes the dropdown. Screen readers hear a combobox with a listbox; each option's name is the setting, its description the placement and the reason.

### Opening a result

Choosing a result goes to the setting and shows it:

1. The section becomes the current one (Writing style's page opens for its rows; an account's or category's disclosure opens for theirs).
2. The row scrolls into the pane's view, centered when the pane can, without an animated scroll (a smooth scroll runs past the `--motion` cap).
3. The row is marked as found for a moment: a quiet tint behind it (the selection's tint the sidebar uses, `sidebar-accent` at the row's inset, concentric with the card) that fades out over `--motion` after about 1.6 s, and doesn't fade (it just goes) when motion is reduced. The control in the row takes focus programmatically, so the keyboard continues there; there's no focus ring (plan 54: programmatic focus draws none).
4. The field keeps its query, so the next result is one ⌘F and an arrow away.

A row that isn't shown right now (its switch is off, its provider doesn't use it) lands on the row that shows it (`under`): Follow-ups' nudge lands on Follow-ups' switch. A row that can't exist here (another platform, AI features not offered, Dev mode off) is not a result at all.

### The index: one registry, rows tied to it

`settings/search-index.ts` holds every searchable setting, in sidebar order:

```ts
{ id: "general.undoSend", tab: "general", group: "settings.general.writing", label: "settings.general.undoSend", hint: "settings.general.undoSend.hint"?, words: "settings.find.words.undoSend"?, under: "general.undoSend"?, scope: "account" | "category"?, page: "style"?, when: (ctx) => boolean? }
```

- Keys, not strings, so the index follows the language: it is built from the catalog when the field is first typed in, and again after the language changes. Labels and hints are keys with no parameters; a hint that takes one (a provider's name, a number of days) is left out of the index and the row's label, group and words still find it.
- **`SettingsRow` takes `find`, required**: the entry's id, or `false` for a row that isn't a setting (a status, an error, a storage bucket, Dev mode's environment lines). A mistyped id fails the type check. The row puts `data-setting={id}` on itself, which is what opening a result looks for.
- **The row's label and hint default to the entry's**, so a row with a fixed label names it once, in the index. A row whose label or hint depends on state (the badge's desktop or web wording, a hint with the provider's name) still passes its own.
- `settings-search.test.ts` holds the two in step: every `find="…"` in `components/settings` names an entry, every entry is named by at least one row, and no id is used by two rows outside an account or category scope.
- **Scopes:** an entry scoped to accounts is a result once per account ("Signature, Accounts › Work"), and one scoped to categories once per category. Their markup says how to open them: the account's item has `data-setting-scope="account:<id>"` and its trigger `data-setting-open`; opening a result clicks that trigger when it is closed, then looks for the row inside the scope.
- **The account's and category's own names** are part of the placement and are searched with it, so "work signature" finds Work's signature.
- `when(ctx)` takes `{ settings, desktop, devMode }` and mirrors the render's own condition (Today and the digest: `aiFeaturesAvailable`; notifications: desktop or a browser that has them; Gmail-only rows: scoped entries filter by the account's kind).

### Matching and ranking (`lib/settings-find.ts`, pure)

- Text is folded (lower case, accents removed: "notificación" matches "notificacion") and split into words.
- The query is split into words; **every query word must match** somewhere in the entry: the start of a word in the name, the placement (section, group, account, category), the related words, the description, or the English name and words in another language. A query word of three letters or more also matches inside a word ("mode" in "darkmode", "sync" in "resync").
- Score: a word matched in the name counts most (4, plus 1 at the name's start), then related words and the account or category (3), the section or group (2), the description (1). Ties keep sidebar order, so General comes before About. At most 50 results.
- The reason comes from where each word matched: name or placement → emphasis only; else related word or English → "Matches “…”"; else the description excerpt (about 60 characters around the first match, cut at word boundaries, ellipses where it was cut).
- Pure and synchronous: about 150 entries plus a dozen per account and five per category, under a millisecond per keystroke. No debounce.

### The control: BoardUI's Combobox, ported (`packages/ui/src/components/combobox.tsx`)

On Base UI's `Autocomplete` (a combobox whose value is the typed text; its list filters by our own matcher, `filter={null}`, items given already ranked). Parts: `Combobox` (root), `ComboboxInput` (the field: `SearchField`'s look, the glyph at the start, the clear at the end), `ComboboxPopup` (the menu panel, `MENU_PANEL` + `MENU_MOTION`, in a positioner), `ComboboxItem` (a menu row, highlighted in `muted` like every menu, free content inside), `ComboboxEmpty` (the quiet empty line).

Deviations from BoardUI, written in BOARDUI.md:
- **The list can be wider than the field** (`popupClassName` sets its width): Settings' field is the sidebar's 164 px and a result carries its placement and reason. BoardUI's list is the field's width.
- **Multi-line rows**: a result is up to three lines, at the menu row's padding, not the 28 px single line.
- **No toggle**: a search field has nothing to open without a query, so the chevron button isn't drawn.

### Copy (en and es together)

`settings.find.placeholder` "Search settings" / "Buscar en Ajustes"; `settings.find.label` (the field's name); `settings.find.none` "No settings match “{query}”"; `settings.find.matches` "Matches “{word}”"; `settings.find.results` (the listbox's name); `settings.find.words.<id>` for the settings with related words. Placement uses the existing section and group titles.

## Tests

- **Unit** (`lib/settings-find.test.ts`): folding and accents; every word must match; prefix and infix; ranking (name over description, sidebar order on ties); the reason kinds (name, placement, related word, English word in Spanish, description excerpt and its ellipses); scopes expand per account and category and search their names; `when` hides what can't exist; the 50 cap.
- **Unit** (`settings/settings-search.test.ts`): the index and the rows in step (above); every entry's keys exist and take no parameters (the type check also holds this); every scoped entry has a scope that the markup provides.
- **Unit** (`combobox.test.tsx` in packages/ui): the field is a combobox with its listbox, the arrows highlight, Enter chooses, Esc closes then clears.
- **e2e** (`settings-search.spec.ts`, one `scenario()`): typing "undo" shows Undo send with "General › Writing", Enter opens General with the row marked found and its switch focused (no ring); a description match shows its excerpt; "signature" shows one result per account and opens the account's accordion; a Writing style row opens that page; an under-row (follow-ups' nudge with follow-ups off) lands on its switch; Esc steps back field → empty → closed; ⌘F focuses the field; Spanish finds by English words; axe on the open dropdown in light and dark.
- **Visual**: screenshots of the dropdown and of a found row, light and dark, in the default design and Graphite, looked at.

## Performance and resources

- Nothing runs until the field is typed in: the index is built on the first keystroke and kept for the dialog's life (rebuilt when the language, accounts or categories change). Matching is a pure pass over a few hundred entries.
- The results list is bounded (50) and plain; no virtualization needed for 50 rows.
- No timers except the found mark's one timeout, cleared on unmount or the next find.
- Plain imports throughout (no lazy loading).

## Out of scope

- The palette finding individual settings (the index makes it a small follow-up: it can read the same registry).
- Searching user content inside Settings beyond account and category names (filters' conditions, snippets' bodies, writing-style profiles).
- Searching the values a select offers (the theme names, the languages).

## Revisions after the Codex review

1. **The query stays after a choice.** Base UI's Autocomplete fills the input with the chosen item's text (`fillInputOnItemPress` is forced on): the root ignores a value change whose reason is `item-press`, and the item's own click opens the setting. Tested by pointer and by Enter.
2. **Enter opens the first result.** `autoHighlight` is on, so the first result is highlighted as soon as there is one. Rows are styled on `data-highlighted` (focus stays in the field), not on `:focus` as `MENU_ROW` is.
3. **Esc, one level at a time.** With the list open, Esc closes it (Base UI's). With it closed and a query in the field, Esc empties the field and stops there (the field's handler takes it: `preventBaseUIHandler`, `preventDefault`, `stopPropagation`; an IME's Esc is left alone). With the field empty, Esc goes on to the dialog as before: back from Writing style to Drafting, else Settings closes.
4. **The parts are Portal → Positioner → Popup → List**, the List being the listbox with a name ("Settings found"); each option is named by its setting (`aria-labelledby`) and described by its placement and reason (`aria-describedby`), not read as one run of text. The popup is portalled, so the dialog's `overflow-hidden` doesn't clip it.
5. **Opening is a pending destination.** The choice closes the list, switches the section (and page), then waits for its target with a MutationObserver on the pane (no polling): a scoped row first opens its account's or category's disclosure, then waits for the row inside it; a row that doesn't come (switch off, drafting off, a provider that doesn't use it) falls back to its `under` row, then to its scope, then to the section's top, after at most 1.5 s. A newer choice cancels the older one. The row is scrolled to, then its control focused with `preventScroll`.
6. **Writing style both ways.** A result on the page opens it (`stylePage: true`); any other AI result while the page is open closes it (`stylePage: false`). Leaving the page or the section through search goes through `leaveStyleEditors`, so a changed profile asks first, as the back button does.
7. **No cache.** Entries are resolved from the catalog on every query with the live context (settings, accounts, categories, locale): a few hundred `t()` lookups of compiled messages, well under a millisecond. Render conditions that depend on loaded state (drafting's switch, the provider catalog) aren't modelled in `when`; they're `under` fallbacks.
8. **API keys** are one entry with a search label of its own ("API key"); with both keys shown, it opens the first.
9. **The control to focus** is the row's first enabled focusable element (switch, select trigger, radio, button, field). A row whose control is disabled (Undo send's window while Undo send is off) is shown and marked, and focus stays in the search field. A text field focused this way shows its ring, as text fields always do.
10. **Controls outside rows** get anchors: each category's Auto-add switch (scoped), the account list's Add account, Forget saved icons, Test connection, New category; groups that are a list of the user's own (Rules, Snippets, Custom themes, Your style, Mail by mailbox) are anchored on the group.
11. **The query survives a language change** (the app remounts on one): it lives in a small store, not component state; results are rebuilt in the new language.
12. **`find` is optional on `SettingsRow`** (Print reuses the row); `settings-search.test.ts` requires it on every row under `components/settings/` and the web's storage section, so Settings can't grow an unsearchable row.
