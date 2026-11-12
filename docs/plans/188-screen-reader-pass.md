# Plan 188: a screen-reader pass

## Request (verbatim)

> lets do an accesibility pass on the app here, what can be improved so blind people can use the app nicely.

and, after the audit below was reported:

> proceed to fix these

The owner took the two recommendations the report asked about: Undo send's window becomes a choice (Off, 5, 10, 20, 30 s), and single-key shortcuts get a switch in Settings → General, on by default.

## What exists

The audit read the code in three parts (list and sidebar, reader, composer and dialogs) and dumped the live accessibility tree of a running build (inbox, reader, composer, Settings, palette). Much is already right: the list is a `listbox` with `aria-activedescendant`, the reader has an `h2` subject and an `article` + `h3` per message with `aria-expanded` headers, the composer's fields are labelled (a real `<label>` each, a `textbox` body with `aria-multiline`), recipients are a combobox and a listbox of chips with announcements, Settings rows wire label, hint and error through ids, dialogs are titled, the snack dock has polite and assertive regions and pauses on hover and focus, axe runs in both modes over the main surfaces.

What a VoiceOver user still meets:

1. **Shortcuts act on the wrong thing.** The document's one keydown handler (`apps/web/src/lib/keyboard.ts`) only stands aside for editable fields and for Enter/Space on a button. With a sidebar row focused, ↓ moves the list's cursor and Delete or Backspace trashes the open conversation. Single-character keys (e, #, s, !, …) can't be turned off (WCAG 2.1.4).
2. **Focus doesn't follow the action.** j/k move the list's cursor (and in Split open the conversation) with focus left on the sidebar or a toolbar: nothing is said. In Split, Enter on a row only sets `readerOpen`; the reader `section` is focusable and named only on List's page (`reader.tsx`), so reaching the mail is a dozen Tabs.
3. **F6 doesn't move between panes.** It only reaches the snack dock, and it's `preventDefault`ed even when there's no snack (the web build loses the browser's F6).
4. **Undo send**: a fixed 5 s (`UNDO_SEND_MS`), not adjustable (WCAG 2.2.1); its status doesn't say how to undo; the dock's pill pauses its ring on hover and focus while the backend's hold doesn't pause.
5. **Snacks never say they have an action** (`spokenOf` reads the message and description only).
6. **A row reads in a noisy order**: section, sender, a bare count ("3"), date, subject, Draft, the whole preview, then categories, then ", unread", ", starred", ", has attachments" (the name is the option's content in DOM order).
7. **The draft's "Saved" is spoken at every pause** in typing (the polite span in `inline-draft.tsx` flips empty ↔ "Saved"); **"Couldn't save · Retry" is never spoken**.
8. **The category picker (`l`) hides what's applied**: the check is a decorative icon, so picking an applied category removes it without the user knowing it was there.
9. **A finished summary is never announced** (only the running line is a status).
10. **Sidebar counts are bare numbers** ("Inbox 100", "Reminders 3"), meaning unread in some rows and due in others; only Today and categories have `countHelp`.
11. **The list's position is wrong under virtualization** (no `aria-setsize`/`aria-posinset`: row 300 reads "3 of 22"); loading is silent (no `aria-busy`); the `x` selection count isn't said.
12. **Smaller things**: every mail frame is titled "Message content"; every message's ⋯ is "More for this message"; message dates in the header lose their full form (only in `title`); icon buttons' shortcuts live only in tooltips; Reply ready's header spinner reads "Loading"; the palette's input has no name and its options read their key glyphs ("Undo Z"); the open filter in Filters is marked only by colour and its value field only by a placeholder; "Categories" and "Accounts" in the sidebar aren't headings; the search field's "/" hint is read as "slash"; Send's "why not" is only in its tooltip; the attachments live region mounts with its first message.

## Design

The rule throughout: say what changed once, at the moment it changed, in the words the screen shows; never move focus the user didn't ask to move; nothing new for sighted users except the two settings.

### Series A: getting around

**A1. Keys that belong to a focused control stay with it.** A binding gets `native?: true`: arrows (and their Shift forms), Delete and Backspace, the keys a focused control can have its own meaning for. `KeyContext` gets `onControl`: focus is on an interactive control (a button, link, tab, menu item, switch, checkbox, radio, slider, separator, treeitem, `summary`) that is outside the conversation list and isn't a message header in the reader. `resolveKey` skips `native` bindings while `onControl`. So ↓ on a sidebar row does nothing (the sidebar's own Alt+↑/↓ stays), Delete on a toolbar button does nothing, and in the list, on the page body, on the reader's section or a message header they act as today.

**A2. Single-key shortcuts can be turned off.** `AppSettings.characterKeys: boolean`, default `true` (contract, defaults, `GENERAL_KEYS`). Off, `resolveKey` drops every binding whose chords are all single printable characters with no Command/Ctrl/Alt (e, #, s, j, k, `g i`, ?, /, z, y, n, the snack's digits…); named keys (arrows, Enter, Escape, Delete, F6) and chords stay. Settings → General → "Single-key shortcuts", hint "Letters and symbols like E and # act on mail. Turn off if they get in the way of a screen reader or dictation." The shortcuts dialog shows one line saying they're off, when they are. (`KeyContext.characterKeys`; the dispatcher passes the setting.)

**A3. Moving the cursor brings focus along, or says where it went.** In `move()` (keyboard.ts), after the cursor moves and the list is on screen:
- focus inside the reader (Split): it stays; the new conversation's subject is announced ("{subject}, from {sender}") through the app's announcer (A7);
- focus anywhere else outside the list (a sidebar row, a toolbar button, the body): the list takes focus (`focusRows()`), so the active row is read. No ring: j/k aren't Tab (plan 54).
On List's conversation page (the list is covered) focus stays and the subject is announced, as above.

**A4. Enter opens into the reader.** The reader `section` is `tabIndex={-1}` and `aria-labelledby="reader-subject"` in both layouts (today List's page only). In Split, Enter/o on the list (`openCurrent`) focuses it, as List's page already does. Focus on the section is not a control (A1), so j/k and arrows act there as on List's page.

**A5. F6 moves between panes.** `f6` → `pane.next`, `shift+f6` → `pane.prev` (replacing `snackbar.focus`), `inEditable`, not in dialogs or menus. The panes, in order: sidebar (its current row, else its first), list (`focusRows()`), main (the reader section, else the composer's first field, else the main region's heading), and the snack dock while a snack is up. A snack that is up stays F6's first stop from anywhere outside the dock (what it does today); from the dock, F6 goes on to the pane after the one focus came from. A hidden pane (List's covered list, a collapsed sidebar) is skipped. `preventDefault` only when focus moved. The shortcuts dialog's line becomes "Move between sidebar, list, conversation and notifications".

**A6. A row says what matters first.** The option is named by `aria-labelledby` over parts that already exist, in this order: a hidden lead (`{section}, ` then "Unread, starred, pinned, " as they apply), the sender, a hidden ", 3 messages" (plural key; the visible digit stays and isn't referenced), the subject, "Draft", the date, the preview (the row-snippet element: owed lines, reasons and search excerpts come with it), then one hidden tail (categories, attachments, Spam/Trash, account, code, reminder: the sr-only spans that are scattered today, gathered). Ids are `thread-{id}-…`; no new layout and one span fewer per row than today. Every option also gets `aria-posinset` (index + 1) and `aria-setsize` (the loaded count, or −1 while more pages exist).

**A7. One announcer.** `announce(text)` in `apps/web/src/lib/announce.ts`: one polite `sr-only` `role=status` mounted once in the app shell, cleared then written on the next frame (so the same words twice are said twice, and a region that appears with its text isn't relied on). The sidebar's own reorder region and the scattered "arrive with its text" status spans that the audit found unreliable (held message status, attachments) move to it. Used by A3, A8, B5, B6, B7.

**A8. The list says when it changes under you.** After a navigation from the sidebar (a mailbox, category, account or folder), once its first page is in: "{mailbox}, {n} conversations" (or "No conversations"). The list's scroller gets `aria-busy` while a first page loads. Selecting with `x`, ⇧J/K or `* a`: "{n} selected" (or "Selection cleared").

### Series B: timed actions and what's said

**B1. Undo send's window is a choice.** `AppSettings.undoSendSeconds: 5 | 10 | 20 | 30`, default 5, beside `undoSend` (unchanged: on/off). Settings → General: under the switch, a select "Time to undo" (disabled while Undo send is off, as plan 187's Preview row is under Compact). The backend's `compose.hold` schedules `now + undoSendSeconds × 1000` from its settings; the renderer's `goesAt` uses the same setting (plan 182's order kept: taken before the call). `UNDO_SEND_MS` goes; `UNDO_SEND_SECONDS = [5, 10, 20, 30]` replaces it. The held card's status, said once, becomes "Not sent yet. Press Z within {seconds} seconds to undo." The dock's pill for a hold doesn't pause its ring (the backend doesn't pause), so it never shows time that isn't there.

**B2. A snack with an action says so.** `spokenOf` adds the action's hint when there is one: "{message}. {action}: press Z, or F6 to reach it." for Undo, "{action}: F6 to reach it." for the others (`snack.action.sr.undo`, `snack.action.sr`). With A2 off (no `z`), the Undo hint drops "press Z" (⌘Z still undoes: "press ⌘Z").

**B3. Saving is quiet; failing isn't.** The draft's polite span says "Saved" only when a "Saving…" was shown (a slow save) or when the draft closes or collapses, never after each pause. "Couldn't save" goes into a `role=alert` with its Retry the next control.

**B4. The category picker says what's applied.** In toggle mode, an applied category's item carries a hidden ", applied" (`category.picker.applied.sr`), and its action reads "Remove {name}" in its name, so choosing it is never a surprise.

**B5. A summary that's ready says so.** One empty `sr-only role=status` inside the summary card's wrapper is filled when the state goes from running to ready ("Summary ready"), never while it streams; the wrapper becomes a `section` named "Summary" (as Reply ready and follow-ups are). Reply ready's header spinner gets `aria-hidden` (its own region says "Writing replies…" once).

**B6. Sidebar counts say what they count.** Every `NavItem` with a count gets `countHelp`: "unread" for mailboxes, accounts and folders, "due" for Reminders and Follow-ups. "Categories" and "Accounts" become `h2` headings (same look), and their groups are named.

### Series C: the rest of the polish

- **Reader:** each mail frame's `title` is "Message from {name}, {date}"; each message's ⋯ is "More for {name}'s message, {date}"; the open and folded headers use `MessageDate` (short text shown, full date for assistive tech); the full-message bar's label gets `role=group`; its Copy confirms through the announcer.
- **Icon buttons:** `IconButton` puts its `shortcut` in `aria-keyshortcuts` (it's in the tooltip only today).
- **Palette:** the input is named "Search commands and mail" (`aria-label`), and each option's key glyphs are `aria-hidden` (the shortcut goes in `aria-keyshortcuts`).
- **Search field:** the "/" hint is `aria-hidden` (the field carries `aria-keyshortcuts="/"`).
- **Filters:** the open filter's row has `aria-current="true"`; a condition's value field is named "Value" (numbered by row, as its Field and Operator are made to be: "Field, condition 2").
- **Send:** when it can't send, its reason is linked with `aria-describedby` (a hidden copy of the tooltip's words).
- **Attachments:** the region is always mounted (empty), and removing a file announces "Removed {name}".
- **Tips:** the spoken copy ends with "Press Escape to dismiss."

### i18n

Every new string in `en` and `es`: `settings.general.characterKeys`(+`.hint`), `shortcuts.characterKeysOff`, `shortcuts.panes`, `list.row.messages` (plural), `list.row.state.*` reuse, `list.announce.mailbox` (plural), `list.announce.empty`, `list.announce.selected` (plural), `list.announce.selectionCleared`, `reader.announce.opened`, `settings.general.undoSendTime`(+ options), `compose.held.status` (new text with `{seconds}`), `snack.action.sr`, `snack.action.sr.undo`, `snack.action.sr.undoMod`, `category.picker.applied.sr`, `category.picker.remove.sr`, `summary.label`, `summary.ready`, `sidebar.count.unread`, `sidebar.count.due`, `reader.mailFrame`, `reader.message.moreFrom`, `palette.input`, `filters.value.label`, `filters.field.label.n`, `filters.operator.label.n`, `attachments.removed`, `tip.dismissHint`.

## Tests

The lowest level that catches each:

- `packages/core/src/keybindings/resolve.test.ts`: `native` bindings skip `onControl`; `characterKeys: false` drops e, #, `g i`, j, ?, digits and keeps arrows, Escape, Delete, ⌘K, ⇧⌘K, F6; F6 and ⇧F6 resolve while editable.
- `keyboard` unit (jsdom): Delete with a sidebar button focused trashes nothing; ↓ there doesn't move the cursor; j from a sidebar button focuses the list; j from inside the reader keeps focus and announces; Enter in Split focuses the reader section.
- F6 unit: the cycle (sidebar → list → main → dock), the snack first, from the dock onward, skipping a covered list; no `preventDefault` when nothing moved.
- `thread-row` unit: the option's computed name (dom-accessibility-api, already a dependency of Testing Library) starts with the state, says "3 messages", ends with the tail; `aria-posinset`/`aria-setsize`.
- `announce` unit: the same text twice is written twice; cleared first.
- `snack` unit: `spokenOf` with an action, with and without single keys.
- Draft status unit: no "Saved" in the live span after a routine save; "Saved" after a slow one; "Couldn't save" in an alert.
- Category picker unit: an applied item's name includes "applied".
- Settings: contract accepts `characterKeys` and `undoSendSeconds` ∈ {5,10,20,30}, refuses 7; defaults; export carries both. Backend: `compose.hold` with 20 s holds until now + 20 s (fake clock, existing hold test).
- e2e, merged into one `scenario()` spec `a11y-screen-reader.spec.ts` on one page (macOS only: nothing here changes with a design): j from a sidebar row → the focused element is the list and the active option's accessible name starts with the state; Enter → focus in the reader section; F6 cycles; Delete on a sidebar row trashes nothing; turning single keys off makes `e` do nothing and ⌘⌃A still archive; Undo send at 10 s holds 10 s (fake clock).
- The existing axe sweep (`design-axe.spec.ts`) keeps passing; the palette gets its line there.

## Perf

- A row gains a few attributes and loses spans; no measurement, no extra render. `aria-setsize` reads the list's length, already a prop of the list: rows don't re-render when it changes unless they would anyway (it's passed with the props that already change per page). `pnpm test:ui-perf` (j-key, scroll) must hold.
- The announcer is one node and one `requestAnimationFrame` per message. F6 and A3 run on a key press only.
- No new timers at idle, no polling.

## Out of scope

- A screen-reader-only "reading mode" or audio cues.
- Rebinding individual shortcuts (WCAG 2.1.4 is met by turning them off).
- Changing how arrows scroll the reader (they step conversations on List's page today, unchanged).
- The mail frame's `lang` from the message (the sanitizer drops it; worth its own plan if VoiceOver users report wrong voices).
- Native (Electron) menus: already accessible through macOS.

## Revisions after the Codex review

1. **One window per send.** `compose.hold` takes `holdSeconds` (one of `UNDO_SEND_SECONDS`, optional): the renderer sends the value it read for its own countdown, so a settings change mid-request can't split the two; another origin (an agent) gets the setting. `HeldSend.windowMs` keeps it for the ring and the speech.
2. **Hints say what really works.** The Z hint is given only when Z holds this snack's Undo token (`zHolds`, as the dock's own pill decides) and single keys are on; otherwise the hint is "F6 to reach it". The held card's status follows the same rule.
3. **Focus that steps with the cursor.** `move()` takes whether a key moved it (the reader's own Older and Newer buttons keep their focus). From a key: focus outside the list and the reader goes to the list; focus inside the reader that the step removes (a message header of the conversation that left) goes to the reader section after the commit, which names the new conversation; focus that survives (the section itself) hears the new subject through the announcer.
4. **F6 focuses synchronously and stops at a modal.** Every pane's focus is immediate and reports success (`skipToList` when the list has no rows, never `focusRows`' later subscription); nothing moves while focus is in a dialog or a menu, or the dock is covered (`focusDock` returns false then).
5. **F6's order, written down.** Forward: sidebar → list → main → dock (when up) → sidebar. A snack that comes up is F6's first stop once (as today: tested in `snack.spec.ts`), from any pane; after that it is just a stop in the order. ⇧F6 is the plain reverse. Escape and a closing snack still give focus back to where it came from (unchanged).
6. **What's shown and what's said, apart.** The draft's visible status ("Saving…", "Saved") becomes `aria-hidden`; one sr-only polite span says only what needs hearing: a slow save that finished ("Saved"), and the restart, recovery and too-long messages it says today. "Couldn't save" moves into an alert. No "Saved" on collapse (it isn't awaited).
7. **The row's name keeps every fragment.** `aria-labelledby` references, in order: lead (section, unread, starred, pinned), sender, "Opened" (the kept tag), "3 messages", subject, Draft, the place and reminder tags, date, preview (whichever of the three snippet elements the row draws; a Review row has none, its answers are buttons outside the list), tail (categories, attachments, account, code). Tested per markup branch: three-line, no preview, compact, wide, Review.
8. **No re-render for the set size.** `aria-posinset` is a row prop (its index changes with its `top` anyway); `aria-setsize` is written onto the mounted options by the list's layout effect when the count or the rendered range changes: DOM writes, no row renders. ui-perf's render counts must hold.
9. **The list's news is exact.** After a sidebar navigation, once that list's first page is committed (its key, not just "loading ended"): "{mailbox}, {n} conversations" when the whole list is in, "{mailbox}, more than {n} conversations" when more pages exist, "No conversations in {mailbox}" when empty. Selection is said from the selection model (a subscription to `checked` and `scope`), whatever changed it: "{n} selected", or the scope's count.
10. **`aria-keyshortcuts` is dropped from Series C.** Internal chords ("mod+p", "g i") need a serialization and an availability rule (single keys off) that aren't worth their weight here: VoiceOver reads the attribute only with hints at full verbosity. The palette's input gets its name; its options keep their glyphs.
11. **Import restores the whole Undo setting.** `undoSend`, `undoSendSeconds` and `characterKeys` join `GENERAL_KEYS`; an old export without them leaves the defaults (tested).
12. **Tests updated, not only added.** `snack.spec.ts`'s exact spoken text and its F6 cases, `compose.spec.ts`'s Undo clock (now `UNDO_SEND_DEFAULT`), `scheduled.test.ts`; `search.spec.ts`'s ArrowDown into rows, `list-keyboard-entry.spec.ts` and `selection.spec.ts` run unchanged. A manual VoiceOver pass is listed in the report as the owner's to do: DOM assertions can't prove what's spoken.

## What changed while building

- **A row keeps its own words as its name** (not `aria-labelledby`): axe's label-content-name-mismatch (WCAG 2.5.3) failed a name that reordered what's shown, and a voice user says what's shown. The state ("unread, starred, pinned") is said right after the sender, never after the preview; the count has its word ("3 messages"); the rest (categories, Spam or Trash, attachments, account, code, reminder) is one sentence at the end. Section names stay first, as before.
- **Arrows, Delete and Backspace** stay with a focused element only in the sidebar or on a control with its own use for them (a tab, a switch, a slider, a pane's edge, a menu item, a combobox). An ordinary button elsewhere keeps them for the mail: `selection.spec` clicks Select all and presses Backspace, as people do.
- **j brings focus to the list only from a control**, never from the page body: with focus nowhere the list's keys already work, and moving focus there would start transitions while j is held (the perf gate counts animations).
- **Sidebar counts** say their meaning as the row's description (a hidden span), not in its name: the name stays the label and the count as shown (plan 159's rule), and tests that read the count's text read what's shown.
- **Reply ready's spinner** keeps its status and name ("Loading"): review 3 of plan 144 decided that on purpose.
- **Dropped**: `aria-keyshortcuts` in `IconButton` and the palette (revision 10).

## Test notes

- Unit: `resolve.test.ts`, `keyboard-focus.test.ts` (new), `list-speech.test.ts` (new), `thread-row-marks.test.tsx`, `save-state.test.tsx`, `scheduled.test.ts` (backend), `export.test.ts`.
- e2e: `screen-reader.spec.ts` (new); updated `snack.spec.ts`, `compose.spec.ts`, `sidebar-panels.spec.ts`; `designs.spec`, `design-axe`, `selection`, `list-keyboard-entry`, `focus-ring`, `search`, `categories`, `filters`, `palette`, `reader`, `settings*`, `sidebar*`, `today` pass.
- Failing before this plan, untouched by it: `visual.spec` (Settings → General and Agents baselines predate plan 187 and the agents settings), `settings-pass` Agents and Data (looks for a switch whose label no longer exists), `design-axe`'s ⌘J composer state now and then (the AI button's name vs its "Fill in" word, from 7aa0d0c67), `i18n scan` (`apps/site/src/parts/agents.tsx`), and the perf gate's "holding j" animation count (the learned-rule banner's scroll-follow: fails the same on 865185a25).

## What the Codex code review changed

1. **Undo send's dock pill never pauses** (`SnackInput.steady`): a held send goes at the backend's moment, so hover, focus, a hidden window or a modal no longer hold its ring (`snack.test.ts`).
2. **F6 over a full message** reaches what's on screen in the main pane (its Back), not the inert conversation under it (`pane-focus.test.ts`).
3. **⇧F6 from the dock** is the plain reverse (to the conversation); only F6 goes on from where focus came (`pane-focus.test.ts`).
4. **Clearing the selection is said** ("Selection cleared"): the cursor's row still reads as selected, so nothing else says it (`list-speech.test.ts`).
5. **F6 from inside a mail's frame** is forwarded to the app, as ⌘G and Esc are; the frame keeps the key when nothing moved (`screen-reader.spec.ts`).
6. **A held send says each phase once**, not again each time its conversation is come back to (`screen-reader.spec.ts`).

### Second round

1. **j from a full message** counts as the conversation (focus doesn't jump to the list) (`keyboard-focus.test.ts`).
2. **A conversation still loading is named by its row's subject**, so focus put on it says where it went.
3. **A held send says each phase once per hold** (keyed by the hold, not the draft): taken back and sent again, it's said again (`screen-reader.spec.ts`).
4. **The Undo pill names plain Z only while single keys are on**; its keycap stays ⌘Z, which always works (`screen-reader.spec.ts`).
5. **F6 reaches a pane whose only stop is its heading** (a digest being prepared). Rare; no test of its own.

Also: the list has `aria-busy` while a page loads (A8, missed in the first pass). `snack.spec`'s Undo scenario picked a row while Shift+A's list was still arriving (2 in 8 here); it now waits for the list to be in. One F6-to-the-dock miss in `snack.spec` was seen once in about 25 runs and not again.
