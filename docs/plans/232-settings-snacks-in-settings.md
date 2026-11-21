# Plan 232: what Settings says, it says in Settings

- **Status:** in progress.
- **Builds on:** plan 13 (the docked snackbar), plan 158 (where it sits), plan 188 (its keyboard and screen reader).
- **Request (verbatim):** "when doing stuff in the settings tab, like importing / exporting, the confirmation shows as a snackbar behind it and at the bottom, lets make the confirmations for settings show inside the settings dialog."

## 1. What exists

- One snack at a time, in one store (`lib/snack.ts`); every caller says `snack.success(…)` etc. without React. About 40 calls sit in `components/settings/*` (import, an update check, a category created, a key saved, an error saving a setting…).
- One `SnackDock` mounted in the app (`app.tsx`: over List's pane or Split's reader). It holds module-level state of its own: the card for F6, where focus came from, the live regions.
- Settings is a Base UI modal. Everything outside it is marked `aria-hidden`; the dock sees that (or `dialog !== null`) and **pauses** its countdown ("blocked"). So a confirmation said in Settings sits behind the dialog, dimmed and out of reach, and waits there until Settings closes. That's the bug: the user does something and hears back only after leaving.
- Plan 161 already worked around this once: Writing style's reset is undone in place because "a snack would sit behind Settings, out of reach".

## 2. Design

**A snack belongs to the room it was said in.** A modal surface can open a *room* for the dock: while it's open, a snack the user's own action causes is said there, inside the surface, and runs its countdown there.

- `lib/snack.ts` (no React): `openRoom(name)` / `closeRoom(name)`; the state gets `room: string | null`. `show()` stamps a new snack with the open room, unless it's background news (`background`, or a displaced loading snack's late result): news about mail stays the app's, held behind the dialog as today. An update in place keeps the snack's room.
  - **Closing a room:** its snack, if still showing, is what the room said. One that only confirms (`staleOnMove`: no action, nothing wrong, nothing in progress) is done and goes. Any other (an error, an Undo) moves to the app's dock with its remaining time, so nothing the user still needs is lost.
  - z doesn't reach a dialog, so a room's snack shows no z keycap and its spoken hint doesn't say "press Z".
- `components/snack-dock.tsx`: `<SnackRoom name open>` is the room's place: a `display: contents` element that registers itself (and opens the room) while the surface is open. The **one** `SnackDock` keeps its section, its live regions and its card where they are, always mounted; while the snack showing was said in an open room, the card there is closed and a second card, portalled into the room, shows it. One controller, so F6's card, returning focus, the live regions and the queue stay one.
  - Portalled into the dialog's DOM, the room's card is inside the modal: Base UI's focus trap includes it, a click in it isn't outside, and nothing marks it hidden, so the countdown runs (the "blocked" pause is for a dialog the card isn't in).
  - Placement in the room: centred on the Settings pane's foot at `--float-inset`, as over List's pane; no fade band (plan 162: no fade at Settings' foot), no page lift.
  - The dock writes its reserve to `inset` only when it's in the app (the reader, list and pinned drafts read that) and to `roomInset` when it's in a room; Settings' scroller pads its end by `roomInset`, so the last row scrolls clear of the card.
  - Esc in the card (focused by Tab) closes the snack, not Settings: Base UI's Esc listener is on the document, so in a room the dock's handler stops the key.
  - The live regions never move (Base UI spares `[aria-live]` behind a modal), so nothing said is lost to a region inserted with its text.
  - The watchers that decide "covered": instead of watching only the card and its parent for `aria-hidden` (fixed at mount), they watch `aria-hidden` anywhere under `body` and read again when the card changes place; a modal over Settings (a report preview, a confirm) marks the Settings portal, not the card's parent. Attribute changes of one name are rare; nothing on a hot path.
  - A card taken out of its room (Settings closed under the pointer) gets no `pointerleave`: the hover pause is released when the card changes place.
- `components/settings-dialog.tsx`: `SettingsPane` becomes `relative` and holds `<SnackRoom name="settings" open={open && !fatalModal} />`; its scroller pads by `roomInset`.

A snack showing when Settings opens (Archived, with Undo) stays where it was, held as today, and is there when Settings closes: it wasn't said in Settings. A Settings snack replaces it, as any new snack does.

## 3. Tests

- `lib/snack.test.ts` (unit): a snack said while a room is open has the room; background news doesn't; an update in place keeps it; a job begun in the room and displaced by news (or queued) keeps its room while it's open; closing the room drops a plain confirmation and moves an error (and one with an action) to the app with its time and the app's hint; the spoken hint in a room names neither Z nor F6.
- `apps/web/e2e/settings-pass.spec.ts` (the existing Data scenario): Import shows "Imported…" inside the Settings dialog, on the pane's foot and centred on it; axe in light and dark; Esc on the focused close closes the card and leaves Settings open; it runs out on the controlled clock; closed with focus in its card, Settings takes the confirmation with it and the next app snack still runs out. An Archived snack from before stays behind, held (the existing `snack.spec.ts` scenario, unchanged).
- axe on the dialog with the snack in it, light and dark.
- Screenshots: Settings → Data with the confirmation, light and dark.

## 4. Perf and resources

Nothing on a hot path: one string stamped per snack, one portal, one `MutationObserver` filtered to `aria-hidden` and `inert`. No timers.

## 5. Revisions after the Codex review of the plan

Ten points; what changed:

1. **Moving the whole section would break modal isolation** (point 3): Base UI hides what's outside a modal once, as it opens. A section moved into Settings and back would come back new and unhidden. So the section, its live regions and its card never move; the room gets a second card of its own.
2. **A job begun in Settings and displaced by news** (point 2: Check for Updates' loading snack, replaced by a background notice): its late result keeps the room it began in, if that room is still open. Queued results keep theirs too.
3. **The room follows the dialog's open state, not its mount** (point 9): a closing dialog stays mounted for its exit, and a fatal modal closes Settings while `dialog` stays `"settings"`.
4. **A moved snack's spoken hint** (point 7) is recomputed: in a room it names neither z nor F6 (neither reaches into a dialog) but says where it is; back in the app, the usual hint.
5. **Focus and hover when the card leaves its room** (point 4): Chromium fires a blur when the focused card is removed (tested: Settings closed with focus in the card, the next snack still runs out), but no `pointerleave`, so hover is released on a move.
6. Not taken: room by operation rather than by the moment it's said (point 1). An archive's result that lands in the milliseconds after Settings opens is said in Settings, where the user is looking; a per-operation origin would touch every caller. ⌘F from the card (point 5): the card is the dialog's last stop, and ⌘F from it is a rare path. Announcements under a modal over Settings (point 6): the same as any snack under a modal today. Layout changes remounting the dock (point 8): as today.
7. The e2e checks the import's lifetime with the controlled clock (point 10), not a ring it doesn't have.

## 6. Out of scope

- Other dialogs (the category picker, reminders): none says anything of its own today. They can mount a `SnackRoom` when one does.
- Writing style's in-place undo (plan 161) stays: it's undone where it happened, better than a toast.
