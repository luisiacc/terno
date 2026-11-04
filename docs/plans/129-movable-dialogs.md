# 129 · Config dialogs move out of the way

## Request (verbatim)

> lets make the dialogs that we show for config, like the settings dialog, so the user can move them around, so fr example, when changing appearances, they can move it and see other places behind it.

## What exists

- `DialogContent` (`packages/ui/src/components/dialog.tsx`) is a Base UI popup centred by `left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2`, over a `DialogOverlay` in `--overlay` (black at 10 % in light themes, 45 % in dark).
- Its zoom-in and fade use tw-animate's keyframes, which animate `transform`, never the separate `translate` property.
- The dialog already takes its own clicks in Electron (`no-drag` on `[data-slot=dialog-content]`), so a dialog over a title-bar strip doesn't hand a press to the window drag.
- Changing the language remounts the whole app under a new key (`LocaleRoot`), Settings included: state held in a component dies, a module's survives.
- The React Compiler memoizes on inputs, so reading a module store during render can go stale. A `useState` initializer is safe.
- BoardUI's modal does not move (`/r/modal.json` has no drag), so this is Terno's own and goes in `BOARDUI.md` as a deviation.

## Design

**Which dialogs:** the four that configure something: Settings, Filters, Add account, Category forwarding. Opt-in with `movable="<id>"` on `DialogContent`. Confirmations, the palette, the category picker, remind, print, shortcuts, the report preview and first-run stay put.

**Where you grab it, as with a macOS window:**

- the dialog's own margin (a press whose target is the popup itself, not on its scrollbar);
- any `DialogHeader`;
- anything marked `data-dialog-handle`: in Settings the sidebar and the section's title row, in Filters the sidebar's title row and a 48 px strip on top of the form (which replaces the scroller's `pt-12`, so the form also stops scrolling under the close).

Inside those, a control keeps its press: `button, a, input, textarea, select, label, [role=button], [role=tab], [contenteditable], [tabindex]` (the popup's own `tabindex` doesn't count). The cursor is `grab` on a handle, `grabbing` during the drag.

**The gesture.** Primary button, no ctrl (a macOS right click), and only inside this popup's own DOM: React bubbles presses from portalled children (a nested dialog, a select) through the tree, so `currentTarget.contains(target)` is checked. `mousedown` on a handle is prevented, so a focused field keeps its focus and caret and no selection starts. The pointer is captured on press, so a release over the backdrop isn't an outside press and mail iframes don't take the pointer. Movement under 3 px is a click, not a move.

**Position.** `translate: calc(-50% + Xpx) calc(-50% + Ypx)`, written straight to the element during the drag, so no React render per move and no layout (only a compositor property). Tw-animate's `transform` keyframes don't touch it, so the close fades in place instead of jumping back to the middle.

**Bounds.** A pure `clampSpot(spot, size, viewport)`. Partly off-screen is allowed, because the point is to see past it and a 900 px window can't otherwise move an 820 px sheet: at least 120 px stays in view sideways, the top edge never goes above the window, and at least 48 px stays above the bottom. Re-applied on window resize and when the dialog's own size changes (`ResizeObserver`), only while open and moved. No polling.

**Remembered for the session, per dialog:** a module `Map` keyed on the `movable` id, read in a `useState` initializer. It survives the language remount and reopening, as a Mac window keeps its place. A new launch opens centred. **Double-click a handle** to put it back in the middle.

**The dim clears while moved.** A moved dialog's backdrop goes transparent (within `--motion`), because the reason to move it is to see the app's real colors, and a 45 % black wash in dark themes would falsify them. It still catches clicks: the dialog stays modal, the app behind stays inert, and a click outside still closes it, as it always has. Back in the middle, the dim returns.

**A11y.** A pointer convenience on non-control surfaces: no new focus stop, role or name, and every control is unchanged. No i18n strings.

## Tests

- Unit (`packages/ui`): `clampSpot` at each edge, in a window narrower than the dialog.
- Unit (`apps/web`, next to `modal-host.test.tsx`): a press inside a nested portalled dialog doesn't move the parent.
- E2E `apps/web/e2e/dialog-move.spec.ts`, tagged `@design`:
  - dragging Settings by its title row moves it by the pointer's delta; dragging by the sidebar works too; a tab press in the sidebar selects without moving; the close still closes
  - a release over the backdrop leaves it open
  - the dim clears when moved and returns on double-click
  - changing theme while moved leaves it in place; switching language leaves it in place; closing and reopening leaves it in place
  - it can't leave the window; shrinking the window pulls it back
  - a focused field keeps focus through a drag
  - Add account's margin and header drag; Filters' strip drags; a dialog not opted in (Shortcuts) doesn't
  - axe clean while moved
  - the close doesn't jump: mid-close, the popup is still at its spot
- Existing `settings-pass`, `controls`, `designs` and `visual` specs: nothing changes at rest.
- Screenshots in light and dark, moved over the app.

## Perf and resources

No work until a press on a handle. During a drag: one style write per pointer event, no React renders except the first move's and the release's. One `ResizeObserver` and one resize listener, only while a moved dialog is open. The map holds at most four entries. No heavy code; `lib/dialog-move.ts` is small and has no dependencies.

## Out of scope

- A keyboard way to move: Mac windows have none, and the free chords collide with text editing or VoiceOver. Every control stays reachable; moving only changes what can be seen. Say so if it is wanted.
- Persisting across launches.
- Non-modal (working in the app with Settings open).
- Resizing.
- An education tip for the gesture (plan 113 would be the way).

## Revisions after the Codex review

- **Focus can land off-screen.** Bounds that allow a mostly hidden sheet let Tab focus a control the user can't see. A keyboard focus (`:focus-visible`) landing outside the window now shifts the dialog just enough to show it.
- **State mounts with the popup.** `CategoryMenu` keeps each forwarding dialog mounted after its first opening, so a `useState` in `DialogContent` would go stale across openings. The state lives in a surface component inside `DialogPortal`, which mounts at each opening and reads the remembered spot then.
- **Mouse and pen only.** Touch keeps scrolling the sheet; no `touch-action` games.
- **One way to finish.** `lostpointercapture` fires on release, cancel and capture loss, so it is the only end path. Listeners live on the popup and die with it, there are no document-level flags to get stuck, and the spot is written on every move, so Escape mid-drag keeps it.
- **Layout sizes.** `offsetWidth`/`offsetHeight`, unaffected by the 0.98 entrance scale, and the clamp also runs before the first paint of every opening, for a window resized while the dialog was closed.
- **The close animation test.** Settings, Filters and Add account unmount at once on close (`app.tsx`), so only Category forwarding fades. The test uses that one with motion on.
- **Dismissal coverage.** After a drag released over the backdrop, a plain backdrop click still closes.
- **Not taken:** `no-drag` on the backdrop. Today a press on a title strip with a dialog open moves the window; making it dismiss the dialog instead would take that away, and it is unrelated to this feature.

## What the Codex code review changed

No runtime defects. One test gap: the e2e test named for the scrollbar never touched one (headless Chromium hides them), so the guard could have been removed unnoticed. It is now a unit test on the popup's real layout numbers, confirmed to fail without the guard, and the e2e test is named for what it checks.

**Native window drag not exercised.** The e2e runs in Chromium, so Electron's own hit testing of `-webkit-app-region` while a moved dialog sits over a title-bar strip rests on the existing `no-drag` rule, not on a test here.
