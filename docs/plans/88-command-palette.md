# 88: A better ⌘K

## Request (verbatim)

> investigate the superhuman cmd+k menu, what does it have that we dont

> ok lets proceed to improve our cmd_k bar based on those changes, we'll implement snippets later so make note of how we'll handle them in the cmd bar when we implemen the snippets.

The changes the investigation proposed (in order):

1. List what we already have but the palette doesn't: Reply, Reply all, Forward, Keyboard shortcuts, Spam, All Mail.
2. Rank by use: a small bounded local history, so commands you use often rise and the last ones are at hand.
3. Composer commands when a draft is focused (Send, Attach, Cc/Bcc, Insert link, Discard), and the ⌘K-in-the-editor rule: the first ⌘K inserts a link, the second opens the palette.
4. Show the synonym that matched: typing "done" shows **Archive conversation (done)**.
5. Commands that take a value inside the palette (Move to, Add to, Remind me) instead of a second dialog.

## What exists

- `components/command-palette.tsx`: one cmdk `Command` in `CommandDialog` (`packages/ui/src/components/command.tsx`), hand-written JSX items in four groups (Go to, Actions, Settings, Add to …) and a final "Search for …" item. cmdk's default filter (`command-score`) sorts groups and items by score while typing; with no query the order is the JSX order. `keywords` carry the English words in another locale (`lib/palette-words.ts`).
- Context: actions show only with targets (`scope` count, checked, else the selected thread); Print with one shown conversation; the filters with a mailbox; Remind me (plan 87) without a "select all" scope.
- "Move to…" closes the palette and opens `CategoryPicker` (`dialog: "categoryPicker"`, `pickerMode: "move"`). "Add to" lists every category inline as its own group (one row per category, always).
- "Remind me…" opens the plan 87 picker (`openRemind()`); presets come from `remindPresets(now, kind)` in `@terno/core`, and `setReminder(ids, at, kind)` sets them with a snack and Undo.
- Keys (`@terno/core` keybindings): `mod+k` → `palette.open`, allowed in editable fields and dialogs. In the rich editor ProseMirror's `Mod-k` runs first and opens the link popover (`rich.tsx` `LinkPopover`); the popover handles only Enter and Esc, so a ⌘K inside it reaches the document handler and opens the palette over the popover.
- Composers: `InlineDraft` (`inline-draft.tsx`) and `NewMessage` (`new-message.tsx`) own `send()` and `discard()` (with their focus handoff), Cc/Bcc toggles (`DraftFieldsForm` state), `AttachButton` (a file input) and `LinkButton` (`controller.openLink()`). Nothing outside the form can reach them.
- Tests: no palette spec; palette items are exercised in `categories.spec` ("add to viajes"), `designs.spec` (style items, axe on the palette), `i18n.spec`, `print.spec`, `quick-filters.spec`, `updates.spec`, `unread-filter.spec`, `settings*.spec`, `account-folders.spec`, `people.spec`.

## Design

### 1. Commands as data

The palette becomes a list of command records built by a pure function, rendered by one loop. A record:

```ts
interface PaletteCommand {
  id: string;            // stable: "go.inbox", "thread.archive", "move:12", "remind:tomorrow"
  group: "recent" | "draft" | "goTo" | "actions" | "settings" | "move" | "addTo" | "remind" | "search";
  label: string;
  icon: ReactNode;
  shortcut?: string;     // display text, as today
  aliases?: string[];    // localized synonyms (§4)
  keywords?: string[];   // matched but never shown (English words, "category", account emails)
  testId?: string;
  searchOnly?: boolean;  // hidden until the user types (§5)
  page?: PalettePage;    // Enter opens this page instead of running (§5)
  run?(): void;
}
```

`paletteCommands(ctx)` (`lib/palette-commands.ts`) takes a plain context (targets, printable, filter state, categories, accounts, designs, updates, draft, page, reminder of the target) and returns the records; the component only renders. Every existing item keeps its label, shortcut and test id, so the existing specs keep passing.

New commands:

- **Reply, Reply all, Forward** (`R`, `A`, `F`) when exactly one conversation is the target (no scope, at most one checked). They run the keyboard's `reply(mode)` path (List layout opens the conversation first, plan 24 R3), exported from `keyboard.ts`.
- **Keyboard shortcuts** (`?`) → `dialog: "shortcuts"`.
- **Go to Spam** and **Go to All Mail** (`goToFolder`).

### 2. Ranking by use

`lib/palette-usage.ts` keeps, per command id, `{ n, at }` in `localStorage["terno:palette-usage"]`, at most 50 ids (the least recently used drop off), read when the palette opens and written once per run. Nothing runs while the palette is closed.

- **Recent group.** With an empty query on the root page, a "Recent" group comes first with up to 4 of the available commands, most recent first. They are left out of their home groups while it shows, so nothing is listed twice. Commands built from a page's value (`move:12`) count by their id, so "Move to Work" shows as recent too.
- **Boost while typing.** The cmdk `filter` multiplies the match score by `1 + min(0.5, 0.15 · log2(1 + n)) · decay`, where decay halves every 14 days since the last use. The cap keeps a strong match ahead of a weak one you use often: "arch" still finds Archive first even if you use "Search" daily.
- The filter gets the id through a marked keyword (`\u0001id`), removed before scoring, so ids never match text.
- Usage is local UI state, not mail data, and is never sent anywhere. Clearing site data clears it.

### 3. Composer commands and ⌘K in the editor

- **Which draft.** When ⌘K opens the palette, the handler records the draft whose `[data-testid=composer]` contains the focused element (`data-draft-key`) in `paletteFrom.draftKey` (a module object; React Compiler note). The new message window counts the same way. No focused draft, no draft group.
- **The draft group** comes first (before Recent) while a draft is focused: **Send** (⌘↵), **Attach files…**, **Add Cc**, **Add Bcc** (only when that field is hidden), **Insert link** (⌘K), **Discard draft**. While the draft is sending, Send and Discard are left out (the buttons are disabled then).
- **The seam.** `lib/draft-commands.ts` holds a registry keyed by draft key, like the composer controller: `InlineDraft` and `NewMessage` register `{ send, discard, attach, showCc, showBcc, link }` from a layout effect, pointing at their own handlers through a ref, and unregister on unmount. The palette calls them; their focus handoff and snacks are exactly the buttons' own.
- **Focus.** A draft command runs after the palette has closed and focus is back in the composer (the dialog's return focus): `run` closes the dialog and runs the command on the next `focusin` inside that composer, or after 150 ms if focus never returns (the composer then decides with its own validity checks, as for a click).
- **⌘K in the editor.** The first ⌘K keeps opening the link popover (ProseMirror's `Mod-k`). The popover's key handler takes a second ⌘K: it closes the popover and opens the palette with that draft recorded, so Insert link and the rest are one more key away. ⌘K in To, Cc, Bcc or Subject opens the palette directly.
- **The editor's own ⌘K stays.** The palette's Insert link shows `⌘K` as its shortcut.

### 4. Synonyms

Commands get localized `aliases` from the catalog, one key per command with comma-separated words (`palette.alias.archive`: "done, mark done"; in `es` "hecho, listo"). The English aliases also go into `keywords` in other locales, as today.

While typing, an item whose best-scoring text is an alias (not the label) shows it after the label, muted: **Archive conversation** (done). Computed in render with cmdk's `defaultFilter` for each visible item; at most a few dozen items per keystroke.

Aliases: archive (done), trash (delete, bin, remove), spam (junk), markRead (seen), markUnread (new), star (flag, favorite, important), move (folder, label, file), remind (snooze, later, follow up), compose (new, write, email), reply (respond, answer), forward (send to, share), undo (revert), theme (dark mode, light mode), shortcuts (keys, hotkeys, help), print (paper), aiFilter (rule), discard (delete draft), attach (file, upload), send (deliver).

### 5. Pages: a value inside the palette

Three commands open a page instead of a second dialog:

- **Move to…** (`V`) → the categories, then the action. Moves the targets like the picker's move (`moveToCategory`, same snack and Undo).
- **Add to category…** → the categories; adds like today's "Add to" rows. The always-on "Add to" group goes away (it listed every category on every open).
- **Remind me…** (`H`) → two groups, "Remind me" and "If they don't answer", with `remindPresets(now, kind)` and each moment on the right ("Tue 9:00 AM"), then **Pick date & time…** (opens the plan 87 picker in its custom form), and **Clear reminder** when the one target has one.

A page shows its name as a chip before the input, and the placeholder changes ("Move to…"). **Backspace** in an empty input, or **Esc**, goes back to the root page (Esc at the root closes, as today). Usage counts the final command (`move:12`, `remind:tomorrow`).

At the root, typing reaches those values directly: "Move to Work", "Add to Work" and "Remind me tomorrow" are `searchOnly` records, shown only once the query is not empty. So `v` → Work → Enter and ⌘K "move wo" ↵ both work. The existing "add to viajes" flow keeps working this way.

The picker dialogs stay for `v`, `l` and `h` from the list; the palette pages are for the palette.

### 6. Later: snippets

Snippets aren't built yet. When they are, the palette takes them like this, on the same records:

- **In a focused draft:** a draft-group command **Insert snippet…** (`⌘;`) opens a `snippets` page listing snippets by name, with a preview of the first line on the right. Enter inserts at the caret through the composer controller (a new `insertSnippet(snippet)` method, which also fills subject and recipients when the snippet has them and the draft's are empty). `⌘;` while writing opens the palette directly on that page.
- **Search-only records** `snippet:<id>` ("Snippet: Intro call") appear at the root while typing in a draft, so ⌘K "intro" ↵ inserts it.
- **Outside a draft:** "New message from snippet…" opens the same page; Enter opens a new message with it.
- **Management:** "Snippets" in the Settings group (a Settings tab) and "New snippet…" there.
- Snippets rank by use through the same `palette-usage` ids (`snippet:<id>`), and their names are mail-adjacent text: they stay local like everything else.
- `PalettePage` gets `"snippets"`; `paletteCommands` gets the snippet list in its context. No other palette change.

### 7. Look

Unchanged otherwise: same dialog, hairlines, icons and shortcut column. The page chip uses the muted badge style and the existing radius ladder. No new motion.

## Tests

- **Unit** (`lib/palette-usage.test.ts`): record and read, the 50 cap drops the oldest, the decay, the boost cap; a strong label match beats a weak frequent one; a corrupt or missing store reads as empty.
- **Unit** (`lib/palette-commands.test.ts`): Reply/Forward only with one target; the draft group only with a draft and without Send while sending; Add Cc only when hidden; recent ids left out of their home groups only with an empty query; page records; searchOnly records; the alias that matched (`matchedAlias`).
- **Unit** (`lib/draft-commands.test.ts`): register, latest handler wins, unregister only its own.
- **E2E** (`apps/web/e2e/palette.spec.ts`):
  - Recent: run Star, reopen, Star is first under Recent and not twice.
  - Alias: type "done", the Archive item shows "(done)"; Enter archives.
  - Reply from the palette opens a reply to the selected conversation.
  - Move page: ⌘K, "Move to…", pick a category, the thread moves (snack); Backspace on an empty input goes back to the root.
  - Remind page: sets "Tomorrow" with the snack; the bell shows.
  - Composer: reply, focus the body, ⌘K opens the link popover, ⌘K again opens the palette with the draft group; Add Cc shows and focuses Cc; ⌘K → Send sends (focus lands on the reply bar, as with ⌘↵).
  - Spanish: the alias shows in Spanish, English aliases still match.
- The existing palette specs above, `designs.spec`'s palette axe run in light and dark, and screenshots of the root, a page and the draft group in light and dark.

## Performance and resources

- No new work while the palette is closed: the usage store is read on open, written on run, and capped at 50 ids (a few KB).
- The records are rebuilt only while open (the hooks already return idle values when closed). Item count grows by the search-only records (categories × 2 + presets), rendered only while typing; still well under a hundred items, no virtualization needed.
- The palette stays in the entry chunk (it opens instantly with ⌘K); the new code is small.

## Out of scope

- Snippets themselves (§6 is the contract), Send later, Mute, Unsubscribe.
- Act on similar from the palette (it needs the sender and scope choice of plan 63's menu).
- Superhuman's cut-off last row (our heights vary with group headings).
- Contact search ("go to person").

## Revisions after the Codex review

1. **Search text is its own field.** Records carry `search` (what is matched: "category Viajes", an account's email, "add to Viajes" without the display quotes, which break command-score's word starts) apart from `label`. The cmdk item value is `id + "\0" + label`: unique, and it changes when the label does, because cmdk refreshes an item's keywords only when its value changes. The "Search for …" fallback stays a forced item outside the records.
2. **Scoring is the max over texts, not one concatenation.** The palette's own `filter` scores `search`, each alias and each English keyword separately with cmdk's `defaultFilter` and takes the best (Superhuman's rule). The alias shown is the one that produced that best score, so display and ranking agree. Use multiplies the score by at most 1.5, and the result is capped below an exact match: `min(score · boost, score === 1 ? 1 : 0.995)`.
3. **Ctrl+K off the Mac.** cmdk's vim bindings take Ctrl+K (previous item), so Ctrl+K couldn't close the palette on Windows and Linux. The palette sets `vimBindings` only on the Mac, where ⌘K is the chord and Ctrl+J/K/N/P stay.
4. **Reply targets.** Reply, Reply all and Forward show only when the selected conversation is the one target: no scope, and nothing checked but it. They run the keyboard's reply path on the selected conversation.
5. **The new message's draft key.** The new message's form gets `data-draft-key`, so a focused body, toolbar or field in it finds its draft. The e2e covers the new message too.
6. **The draft seam presses the composer's own controls.** `DraftCommandsHost`, rendered inside each composer form, registers send and discard (the form's own handlers, the latest render's) and presses the form's own Cc, Bcc and attach controls, so reveal, focus and the file picker are a click's. Availability is read from those controls: Send and Discard are offered when their buttons are enabled (sending, recovery), Attach when its input is (uploads), Add Cc and Add Bcc while their toggles are there.
7. **A delayed draft command is checked before it runs.** It waits for focus to come back into that composer (or 150 ms), then runs only if the palette is still closed, no other dialog opened, the same draft commands are registered (not unmounted or replaced) and the selection and the new message are the ones the palette was opened on. Otherwise it is dropped.
8. **Escape on a page.** The palette's root handles Escape in a capture-phase key handler: on a page it goes back to the root and stops the event before the dialog's dismissal; at the root the dialog closes as today. The e2e covers both, and Backspace.
9. **The Move page keeps the picker's rules.** With a "select all N" scope, "Move to…" keeps opening the picker (which explains that moves need selected conversations); a category the targets are already only in is disabled; and a query that names no category offers "Create “…” and move" (and "Create “…”" on the Add page), through the picker's `createCategory`.
10. **Reminder ids keep their kind.** Ids are `remind:always:tomorrow` and `remind:noReply:in3d`, and each kind's group ends with its own "Pick date & time…", which opens the plan 87 picker with that kind and the custom form.
11. **A bare category name still navigates.** Value records ("Move to Viajes", "Add to Viajes") only match through their verb: their search text is "move to Viajes", so "viajes" scores them about 0.17 against 0.9 for the category itself, and even the 1.5 boost can't flip it. The e2e checks that "viajes" ↵ still goes to the category after moving to it several times from the palette.
12. **Many categories, and closed means idle.** Value records are built only for a non-empty query and only when their own text matches it, so a search renders the matching ones, not three rows per category. The palette's subscriptions to categories and accounts return a shared empty value while it is closed. A jsdom test renders the closed palette with 500 categories and checks that nothing renders, and that a search renders only the matches.

## Implementation notes

- **The palette filters and orders itself** (`shouldFilter={false}`, `arrange` in `lib/palette-commands.ts`). cmdk 1.1.1 can't reorder groups: it looks each one up by `data-value="encodeURIComponent(group id)"`, which no group carries, so a strong match in a later group ("listo" → Archive) stayed under a weak one in Go to. cmdk now only keeps the selection and the keys. The records are built in the component (they close over the app's actions); scoring, recent, pages and ordering are the pure, unit-tested part.
- **A floor of 0.05.** command-score gives letters scattered through a long label 0.003 to 0.03 ("done" in "Show unread only"), a typo ("arhcive") about 0.1, and a word start about 0.9. Below 0.05 a command doesn't show.
- **Scale 0.5 for a page's values at the root** (revision 11's reasoning was wrong: without the display quotes, "move to Viajes" scores 0.9 for "viajes"). Halved, then boosted at most 1.5×, it stays under the category's own 0.9.
- **Draft commands wait up to 300 ms** for focus to come back (the dialog's return focus runs after its exit), then check as revision 7 says.
- **Items with a hint on the right** hide cmdk's check icon (it also took `ml-auto`, which centered the moments), and a page starts scrolled to its top.
