# 122 · BoardUI's Time Field

## Request (verbatim)

> why are we not using the https://www.boardui.com/components/time-field that i asked?

(After plan 121, which took the time *picker* look from BoardUI's scheduler because the GitHub export, last updated October 2, has no time field. The component is newer: it is on the site and in BoardUI's registry, `https://www.boardui.com/r/time-field.json`, free, MIT.)

## What exists

- `WhenFields` (plans 87, 94, 121), shared by the remind popover and Send later: a date button with a calendar popover, and a time **select** of 15-minute steps.
- BoardUI's `TimeField` (`components/base/time-field/time-field.tsx`): a time typed segment by segment, in Input's field with a clock icon, on React Aria's `TimeField`:
  - the hour, minute and AM/PM segments follow the locale's format and hour cycle
  - typing fills a segment and moves on; Up and Down change the focused segment; Left and Right move; Backspace clears; A and P set the period
  - each segment is announced with its name and value, and the focused segment fills with the accent
  - `minValue` and `maxValue` mark a value outside them invalid

## Design

- **`packages/ui/src/components/time-field.tsx`**, BoardUI's component translated to our tokens:
  - the shell is our Input's filled field (`bg-field`, the border on hover, focus and error, `h-8`)
  - the clock icon sits where Input's text would start
  - segments are `tabular-nums`; placeholders and literals are `muted-foreground`
  - the focused segment is `bg-primary text-primary-foreground`, a checked pair
  - `aria-invalid` and disabled follow Input
- **React Aria, for this one component.** Base UI has no time or date-segment field, and writing one well (locale order, hour cycles, segment keyboard, screen reader values) is what React Aria's is for. AGENTS.md changes from "never React Aria" to:
  - Base UI for whatever it has
  - React Aria only for a part Base UI lacks, inside lazy chunks
  - `react-aria-components` and `@internationalized/date` become dependencies of `@terno/ui`
  - the field is used only by the lazy remind and send-later pickers, so it stays out of the entry chunk (`load.perf`'s chunk checks)
- **Locale:** an `I18nProvider` with the app's locale tag, so English shows `9:00 AM` and Spanish `09:00`.
- **`WhenFields`:** the time select becomes the `TimeField`, the same width (`w-30`) and test id (`remind-time`, `send-later-time`), labelled "Time". A time already past today is the existing `past` state (`isInvalid`, the "has passed" note). The date button stays BoardUI's date-picker trigger (plan 121).

## Tests

- e2e (`controls.spec.ts`, light and dark):
  - typing `2`, `3`, `0` and `P` into the remind time gives 2:30 PM
  - Up raises the focused segment
  - the focused segment is filled with `primary`
  - the field has the filled field's `bg-field`
- `reminders.spec.ts` and `send-later.spec.ts` set times by typing instead of choosing from the list; Spanish (`i18n.spec`) shows a 24-hour time.
- `composer.spec.ts`: the entry and its static imports carry no React Aria; the field is React Aria's once the picker opens.
- axe in light and dark on the open pickers.

## Perf

React Aria's TimeField and its date library load only with the pickers (both lazy). Measured on the e2e build:

- the startup `react` chunk went from 454 KB to 219 KB: the chunking rule (`vite.config.ts`) took every package whose name starts with `react`, so react-day-picker had been in it all along, and React Aria would have joined it; it now takes React, react-dom and scheduler only
- the pickers' lazy chunk (`when-fields`) carries the calendar and the Time Field: 236 KB, 73 KB gzipped, fetched the first time a date and time picker opens

## Out of scope

- BoardUI's Date Field and Date Picker: our calendar stays react-day-picker (plan 120).
- Seconds and the 24-hour switch: the locale decides.

## Revisions after the Codex review of the plan

Nine points:

1. **A cleared segment.** React Aria keeps the last whole time as the value while a segment is cleared, so Set stayed on with the old time. `TimeField` reports `onCompleteChange` from its segments, and `useWhen` is `ready` only when the time is whole; Set and Enter do nothing until then.
2. **Spanish.** The hour cycle is explicit (`hourCycle` 12 in English, 24 otherwise), not left to `es-MX`'s default; `i18n.spec` types 14:30 in Spanish and reads `14:30`.
3. **Enter** in the time sets the reminder (the form's submit) or schedules the send, as Enter on the list did. React Aria's segments stop the keys they handle, so `WhenFields` catches Enter on the way down (`onKeyDownCapture`).
4. **Escape** from a focused segment still closes the popover (`send-later.spec`'s past-time test does exactly that).
5. **Focus:** Send later still opens on Send now; the segments are reached with Tab or a click.
6. **The ring:** the shell shows focus with React Aria's `data-focus-within`, on every focus, as a text field keeps its ring (AGENTS.md); the segment's fill is `data-focused`.
7. **Invalid and disabled** use React Aria's `data-invalid` and `data-disabled` on the shell; `controls.spec` checks the error border on a past time.
8. **Past times are no longer dimmed in a list** (there is no list): a past time is flagged once typed, with the field's error border and the "Pick a time in the future." note. Intentional.
9. **The bundle check** is real now: `composer.spec` walks the entry's static imports for React Aria (none) and checks the field is React Aria's once the picker opens. It found React Aria in the startup chunk through the chunking rule, fixed above.


## Revisions after the Codex code review

One finding, fixed: a cleared segment with focus kept its placeholder's `muted-foreground` on the primary fill (1.23:1 in Terno light), since the placeholder rule came later in the CSS. The focused segment's text is `primary-foreground` whether or not it is cleared; `controls.spec` checks the cleared, focused hour's color and fails without the fix.

## Follow-up: no grey wash

Asked: "remove the gray color since we don't do that, lets keep the style according to the themes we have". The Time Field is drawn as the theme's secondary control, the same as the date button beside it (`bg-card`, a 1 px `border`, `shadow-xs`, `rounded-md`), instead of Input's grey `bg-field` wash; its clock sits where the date's calendar does. `controls.spec` checks it has the card, the date's own fill, a border and a shadow.

## The pickers open at once

Asked: "When I click either of those buttons for the first time, there is a very slight hiccup … it should just show instantly." (the reader's bell, the composer's Send later)

The first open took 306 ms every time, whatever the machine, and later opens 3 ms. The popover itself came in 7 ms, empty, and the choices followed 300 ms later: React holds a Suspense reveal until `FALLBACK_THROTTLE_MS` (300) after its fallback committed, however soon the code is in. So preloading alone couldn't fix it: anything behind `lazy` shows its fallback once.

- **The pickers aren't lazy any more.** They only needed to be because they imported this plan's calendar and Time Field. `when-lazy.tsx` holds what they use up front (`useWhen`, `dayText`) and the fields' loader; the 235 KB stays in `when-fields`, and the entry grows by 1.2 KB gzipped (the pickers) plus `toggle-group`'s 8 KB chunk, now preloaded.
- **The fields aren't `lazy` either,** or the 300 ms would only move to the click on Custom. A picker opening asks for the chunk (nothing before that), and `WhenFields` renders it in the same commit through `useSyncExternalStore`, as `composer/lazy.tsx` does. A click faster than the chunk gets a line of their height, swapped as soon as it's in.
- **`RemindDialog` is static too** (`h` on the list, the menu's Pick date & time…): the same picker, with the same wait through `app.tsx`'s Suspense.
- **Measured** on the e2e build, three runs of each: bell 306 → 8 ms, Send later 306 → 8 ms, both now in the popover's first frame; Custom with its time in the first frame. No long task.
- `watchWhole` (`e2e/fixtures.ts`) checks the first open holds the picker from its first mutation, with no clock in it; it fails without this change.

What the Codex review changed:

1. **Custom before its fields:** Set and Schedule were enabled beside the blank line, and would have used a moment nobody saw. `useWhen`'s `ready` now needs the fields in.
2. **A chunk that fails to load** left Custom silently empty. It now says "The date and time didn't load." with Retry, in the fields' place; the presets keep working (`when-lazy.test.tsx`).

Left as they are: the other lazy dialogs (Settings, Filters, Shortcuts, Add account and others) wait the same 300 ms on their first open.
