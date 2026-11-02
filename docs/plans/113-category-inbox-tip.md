# 113: A first-use tip for a new category

## Request (verbatim)

> when the user creates a cateogory for the first time, lets have an educational tooltip showon to the right, indicating that categories are hidden from the inbox by default,if they want to show in the inbox as well they can do so by right clicking the category, lets have something that's intuitive and very easy to understand, maybe a graphic or some kind of icons, figure out an intuitive way

## What exists

- New categories start hidden from the Inbox (plan 83, addendum): their mail leaves the Inbox and its unread count; the sidebar row gets a muted eye-off glyph; right-click → **Show in Inbox** (`category-menu.tsx`) or Settings → Categories' switch shows it.
- Creation paths in the renderer: the sidebar's + and a tab's + (`lib/tabs` `createCategory`), the category picker and the command palette (`category-picker` `createCategory`), Settings → Categories (`categories-tab`), and MCP (no UI).
- One-time UI state lives in `localStorage` (`terno:first-run`, the web nudge, the More fold).

## Design

A coach mark: a popover to the right of the new category's sidebar row, pointing at it, shown once per install.

**When.** The first time a category is created in the UI (the sidebar, a tab's +, the picker, the palette, Settings → Categories) and it was created hidden. `localStorage["terno:category-inbox-tip"] = "shown"` is written when the tip opens, so it never comes back (not after a reload, not in another window). A user who already had categories sees it on their next one: hidden-by-default is new to them too.

It waits for a clear stage: no dialog, menu or modal open (the picker and palette close as they create; from Settings it shows once Settings closes) and the row in the sidebar (a creation may land you on the category before its `categories` event). The row scrolls into view (`block: "nearest"`) first.

**What it shows** (`w-72`, side right, an arrow at the row):

1. A picture of the gesture (aria-hidden), drawn with the app's own pieces, not an image: a mini sidebar (Inbox, then the new category with its eye-off glyph), a "Right-click" chip with the mouse icon, and the category's menu as it will open, **Show in Inbox** highlighted under a pointer. It teaches the glyph and the exact item to look for.
2. Title: "{category} is kept out of the Inbox".
3. Body: "Its mail won't show in the Inbox or count as unread there. To see it in both, right-click {category} and choose Show in Inbox."
4. **Got it**.

**Dismissal.** Got it, Escape, a click anywhere else (a right-click on the row included, which opens the real menu), a dialog, menu or modal opening, the category shown in the Inbox by any path (another window included: it reads the category from the store), or its row gone. It never takes focus, on open or close (`initialFocus` / `finalFocus` false): opening it doesn't interrupt typing or list navigation. Its text is announced through a polite live region. Nothing in it needs doing, so the keyboard closes it with Escape, which is the tip's alone while it's up (a capture listener that prevents the app's own Escape: no selection cleared, no reader closed). If its row scrolls out of the sidebar, it hides with it (`data-anchor-hidden`).

**Motion.** The popover's own fade/zoom (`duration-base`, within `--motion`; none when motion is off).

**Cost.** A tiny store (`lib/category-tip`) holds the pending id; the tip component is lazy-loaded and mounts only while a tip is pending, so the entry chunk gains a few lines and idle does nothing. Two new icons (`MouseRightClick`: Hugeicons' MouseRightClick03, the right button shaded; `MousePointer`: Cursor01) are their own modules inside the lazy chunk.

Strings in `en` and `es`.

## Tests

- Unit (`lib/category-tip.test.ts`): offered only for a hidden category and only once (localStorage), cleared by dismiss.
- e2e (`apps/web/e2e/category-inbox-tip.spec.ts`, every design): creating the first category from the sidebar shows the tip to the right of its row with the picture and copy, without taking focus; Got it closes it; a second category doesn't show it again, nor does one after a reload; right-clicking the row closes it and opens the menu; Escape closes it and stays where you are; from the picker it shows once the picker closes, and ⌘K ends it; from Settings it shows once Settings closes; axe-clean in light and dark. Every other spec starts with the tip seen (a fixture option), so it never sits over their list.
- Screenshots in light and dark.

## Perf

Nothing on a hot path: the sidebar subscribes to one number; the tip's code loads once, the first time.

## Out of scope

- Tips for other features (no general tip framework).
- Two windows creating their first category in the same instant could each show it once.
- The List layout's tab strip: the sidebar is there in both layouts, so the tip anchors to its row in either.

## Revisions after the Codex review

### Plan critique (12 points)

1, 2, 8. *Focus and keys were unspecified.* It never takes focus (open or close); Escape is its own while up (capture, prevented, so the app's Escape doesn't also act); e2e checks focus stays out and the category stays open after Escape.
3. *Settings' editor starts closed, so its hint isn't on screen.* Settings creations offer the tip too; it shows once Settings closes (e2e).
4, 5, 10. *The row may not exist yet; the category may change meanwhile.* The tip reads the category from the store, waits for its row, and only then marks itself shown; the newest creation wins; shown in the Inbox elsewhere or gone, it closes.
6, 7. *Dialogs, menus and modals.* It waits for none open (`dialog`, `menuOpen`, the modal host) and ends when one opens (e2e: ⌘K).
9. *Right-click must still open the menu.* The popover's outside press closes it without stopping the event (e2e: the menu opens on the same click).
11. *Two windows.* It rechecks storage just before showing; two windows racing in the same instant is out of scope.
12. *Arrow and scrolling.* A `PopoverArrow` part (hairline on its two outer sides); hidden while its row is scrolled away; screenshots in all three designs, light and dark.

### Code review

1. *Escape closed the tip and still reached the focused control:* typing a search, Escape closed the tip and also cleared the query and left the field. The tip's Escape now stops there too (e2e: the query and focus survive; fails without it). No other findings.
