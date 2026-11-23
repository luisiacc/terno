# 246. Settings opens where it was left

## Request

> when opening 'settings' lets always remember the section and scroll position that it had, so when the user comes to settings again, we can remember the section and position. lets keep in mind performance and resource usage here.
>
> the 'remembering' stops if they fully close the app, its only available while the app is open or minimized.

## What exists

- `SettingsDialog` (`apps/web/src/components/settings-dialog.tsx`) shows one section at a time (`settingsTab` in the app store). Its `SettingsPane` holds one scroller (`settings-scroller`) for every section; the dialog's content unmounts when it closes.
- `settingsTab` stays in the app store after a close, but every way in names a section: the sidebar's gear, ⌘, (`settings.open`) and the palette's "Settings → General" (which shows ⌘,) all set `general`; the rest name theirs (AI's error links, the account menu with `settingsAccount`, What matters' options, snippets, the Filters builder's return). So Settings always opens on General, at the top.
- Pages inside a section close with Settings: Writing style (`stylePage`, reset as the AI section unmounts) and a snippet's editor (`closeSnippetEditor()` on close).
- Rows that open: accounts (an `Accordion`, opened by `settingsAccount` only) and categories (a `Collapsible` each). Both are scopes (`data-setting-scope`) with a `data-setting-open` trigger, which Find (plan 203) already uses. Filters' "Created for you" fold already keeps its state for the session in a module (`autoFold`, plan 219).
- Closing the window on macOS destroys it (the app stays in the Dock), and quitting ends everything.

## Design

**What is remembered.** The last section shown, how far its pane was scrolled, and which of its rows were open (accounts, categories). In the window's memory only: never written to storage, so quitting the app, closing the window or reloading it forgets it, as asked. It's three fields; nothing else is kept.

**Which opens return.** One way to open Settings, `openSettings(tab?, account?)` in `apps/web/src/lib/settings-place.ts`, replaces every `setApp({ dialog: "settings", … })`:
- `openSettings()` returns to the place: the sidebar's gear, ⌘, (also the macOS menu's, which sends it), the palette's new plain "Settings" command, and the Filters builder going back to Settings (it came from there).
- `openSettings(tab)` is a link to a section (an error's "AI settings", "Settings → Storage" in the palette, the account menu, What matters' options, snippets): that section from its top, as today. It is then the place a later plain open returns to.
- The first open in a window is General at the top, as now.

**Recording, with no work while Settings is closed and none per frame.**
- `SettingsPane` listens to its scroller's `scroll` (passive) and writes `{ tab, top }` into the module: two assignments, no state, no render. A section switch without a scroll event (the next section is tall enough) is written by an effect on the section.
- On a page inside a section (Writing style, a snippet's editor) nothing is written: the place stays where the section was when the page opened, which is where its button is. Those pages close with Settings, so the return is the section with that button in view.
- While the dialog closes (its `open` false) nothing is written: closing a snippet's editor shows the list under the closing sheet, and its clamped scroll isn't the place.
- The open rows are read once, as the pane unmounts (a layout effect's cleanup, while its DOM is still there): each `[data-setting-open][aria-expanded=true]`'s scope.

**Returning.** The pane's first layout effect (before paint, so it never shows the top first):
- sets the scroller's `scrollTop` to the remembered top;
- a section whose rows come from the backend (Storage, Filters, Agents…) may be shorter for a moment, so a clamped scroll waits for its content to grow: a `ResizeObserver` on a wrapper of the pane's content puts it back each time it grows, and stops once there, on the user's own wheel, pointer, touch or key in the pane, on a section switch, on close, or after a second. No polling; nothing is left running.
- the rows open by default during that mount (`reopened(scope)`): accounts' `defaultValue` and each category's `defaultOpen`. A later visit to the section within the same open starts closed, as now.
- A targeted open, `settingsAccount` (its row scrolled to the top, plan 106) and Find (plan 203) are untouched.

**Palette.** A plain "Settings" command (`settings:open`, `common.settings`, ⌘,, and the "preferences" words that found General) returns to the place; "Settings → General" loses ⌘, and those words and opens General. No new strings.

## Tests

- `apps/web/src/lib/settings-place.test.ts` (new): a plain open after a link returns to the link's section; a link starts at its top and with nothing reopened; the first open is General; `reopened` only during the returning mount; nothing written while closing or on a page inside a section.
- `apps/web/e2e/settings.spec.ts`, merged into the existing scenario: AI scrolled down, Esc, the gear: AI at the same scroll; ⌘, too; "Settings → Storage" from the palette: Storage at the top, then ⌘, returns to Storage; an expanded account comes back expanded at its scroll; a reload opens General at the top. The existing "⌘, opens General" line becomes "⌘, opens the last section".
- `palette.spec.ts` and `palette-commands.test.ts`: "preferences" finds `settings:open`.
- The e2e specs that open Settings through the gear or ⌘, are run, since each now returns to what the test left.

## Perf

- Recording is one passive listener while Settings is open, writing two numbers; the open rows are one `querySelectorAll` at close. Returning is one `scrollTop` set, and at most a second of a `ResizeObserver`.
- Nothing runs while Settings is closed, nothing is stored, and the memory is three fields.

## Out of scope

- Remembering a page inside a section (Writing style, a snippet's editor) or the place of every section separately: the request is the last section and its place.
- Keeping the place across a reload or a new launch (asked against).
- Folds kept by their own sections (Filters' "Created for you", plan 219) stay as they are.

## Revisions after the Codex review

1. **A window, not the process.** Closing the window on macOS ends this window's renderer, and with it the place, as a reload does; the next window starts at General like the rest of what a window keeps in memory (Filters' fold, the list's scroll). This is a decision, said to the owner, not an accident.
2. **No Settings menu item exists.** ⌘, reaches the window's own handler (`settings.open`); the plan no longer claims a macOS menu path.
3. **Closing unmounts at once.** `app.tsx` mounts `SettingsDialog` only while `dialog === "settings"`, so a close has no closing render. The rows are read in the pane's unmount cleanup (its DOM is still there), using the latest committed section from a ref; the "nothing written while closing" guard is for the fatal modal's hide (the dialog's `open` false while it stays mounted).
4. **Pages inside a section.** Writing style and a snippet's editor are tab-scoped (`stylePage && tab === "ai"`, `editing && tab === "snippets"`). On one, scrolls aren't written, so the section's place stays where its button was; Back already focuses that button (it scrolls into view and is written). A section first shown on a page (New snippet, Save as snippet) is written at its top.
5. **Callers keep their intent.** Save as snippet and New snippet open the editor and then `openSettings("snippets")`; What matters opens `openSettings("general")` and then reveals its row; the account menu passes the account.
6. **Find and the account row own the scroll.** `openFound` ends a return in progress (`endReturn()`), so a late `ResizeObserver` can't pull the pane away from what Find shows. A targeted open never starts one.
7. **Already open.** `openSettings()` while Settings is open changes nothing (its section is the place); `openSettings(tab)` switches section, as a link inside Settings does.
8. **The return keeps its target.** While returning, scroll events aren't written (a clamped scroll isn't the place); it ends at the target, on the person's wheel, pointer, touch or key in the pane, or after a second, and then writes where the pane is. Ended by a section switch, Find or a close, it writes nothing (closing before the rows came keeps the target). Content arriving after the second doesn't move the pane.
9. **One disposer.** The return is one function that disconnects the observer, clears its timer and removes its listeners; the pane's cleanup calls it and removes its scroll listener. The tracking lives in `settings-place.ts` and is unit-tested with a scripted pane (scroll clamping, growing content, input, the timer, nothing left after).
10. **React Compiler.** Nothing is read and cleared during render: sections take the rows to reopen with a lazy `useState` initializer (as Filters' fold does), and the pane's layout effect ends the returning mount.
11. **No wrapper.** The observer watches the scroller's element children, so the pane's DOM doesn't change and tests that read a panel's parent as the scroller still hold.
12. **Tests that assumed General.** `settings.spec.ts` (⌘, after Storage), `settings-pass.spec.ts` (the keyboard's arrows from General; toggling an account) and `palette.spec.ts` (preferences) are updated; the rest of the specs that open Settings are run.
