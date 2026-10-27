# 52 · No focus ring around lists

## Request

> remove this ugly focus we show, it shows after i deleted a thread, remove that ugly focus effect on the list container, remove it always, that should never exist, its awful, also remove other similar effects where that occurs on a list, its fine if its a field that happens like i think it does, but here it doesn't make sense

(A screenshot of the conversation list with a 2 px ring inset around the whole pane, right after Trash.)

## What exists

Plan 48 made the conversation listbox Tab-reachable (`tabIndex=0`) and gave it `focus-visible:ring-2 ring-inset` as its keyboard focus indicator. After a keyboard Trash (`#`, Delete, Backspace), focus lands on the listbox while keyboard modality is on, so the ring paints around the whole pane. The unused `ScrollArea` viewport in `packages/ui` carried the same kind of ring. The global `:focus-visible` outline would also hit any other list-like container that took focus.

## Design

- The listbox's ring is gone. Its focus is the highlighted cursor row, which is the listbox's `aria-activedescendant`: the Mail pattern, and how plan 48's composite already announces it. Fields and controls keep their rings.
- The `ScrollArea` viewport loses its ring.
- `globals.css` gains a guard so the global outline never applies to containers: `listbox`, `list`, `tree`, `grid`, `treegrid`, `menu`, `menubar`, `tablist`, `radiogroup` and scroll-area viewports. Their items (options, tabs, menu items, chips) keep the outline.
- Trade-off: a keyboard user who Tabs into the list sees the cursor row as the focus cue. When the selected row is virtualized out of view there is no cue until ArrowDown brings it back (plan 48's scrolled-entry case).

## Tests

- `e2e/list-focus.spec.ts` (`@design`):
  - a keyboard Trash leaves the list focused and `:focus-visible` with no outline or box-shadow;
  - a toolbar Trash leaves no ring either;
  - a sweep focuses every list-like container on the main screen and with the context menu open, under keyboard modality, and requires no outline and no ring-colored shadow.
- `e2e/list-keyboard-entry.spec.ts` (plan 48): the visible-indicator check now requires an unpainted container and a highlighted active-descendant row.
- These fail without the fix: the ring in the theme's ring color, on "listbox Conversations".

## Perf

CSS only.
