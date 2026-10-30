# 70 · The chosen option is plain to see

## Request

> thsese buttons in settings need to be fixed , the ui needs to be more clear which one is selected, right now its not clear, make sure all themes colors have a good contrast for those, it can still be a light color change, but it must be noticeable
>
> also lets make 75ms of animation the default, instead of 'no animation'

## What existed

The settings' option buttons (Appearance's mode, animations and HTML mail; General's layout) are outline toggles. The chosen one was only `bg-muted`, which on the settings' tint groups is nearly the group's own color. 75 ms was already the default everywhere (backend `settings.ts`, `appearance.ts`, `theme.js`); a profile showing "No animation" has it saved.

## Design

- The outline variant's chosen state: a `primary` border and a 15% `primary` wash (`toggle.tsx`), on its hover too. The default variant keeps `bg-muted` (the print sheet styles its own).
- Contrast: `primary` on tint is already a 3:1 UI pair. New pair: `foreground` on the 15% `primary` wash over `tint`, 4.5:1, checked in every palette (`contrast.ts`).
- Default: unchanged at 75 ms; a saved choice isn't overridden.

## Tests

`settings-toggles.spec.ts` (`@design`, light and dark): a fresh profile has 75 ms chosen; the chosen button's border and fill differ from the others and the fill isn't transparent; axe passes on the mode and animation groups. Contrast suite: the new pair in every palette.

The suite's "tokens only" scan also caught `0s` literals in `code-chip.css` (plan 69), now `step-end`, `initial` and a visibility transition over the settle's own duration.
