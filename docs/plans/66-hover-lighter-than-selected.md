# 63 · Hover is a step lighter than selected

## Request

> make the hover color of items in the sidebar, and other with this kinds of items, the hover must be slightly lighter than the selected state background, just slightly

(The screenshot showed "Personal" hovered in the sidebar with the same fill as the selected "All accounts".)

## What exists

- Sidebar rows (`NavItem`, the "More" row, the per-category "Review" row, "Add account", the sign-in rows) all use `hover:bg-sidebar-accent`, and the selected row uses `data-active:bg-sidebar-accent`. So hover and selected look the same, and you can't tell which row is open while the pointer rests on another.
- The settings dialog's tab list (a sidebar too) marks the active tab with `bg-sidebar-accent` and gives other tabs no hover fill at all.
- The thread list already separates them: `row-hover` is a palette token lighter than `row-selected`. Collapsed reader messages and the snack dock use `hover:bg-tint` and have no selected state, so they're fine.

## Design

- A new derived palette token, `sidebar-hover`, is `sidebar-accent` at 60% of its opacity (`registry.ts`). Because it comes from the palette's own accent, every palette, custom theme and design gets a hover of the same hue, just softer, in light and dark. It stays translucent, like the fill it echoes, so it works over vibrancy too.
- Every sidebar-style row hovers with `not-data-active:hover:bg-sidebar-hover`, so a selected row keeps its full fill while hovered. An e2e test checks this.
- The settings tabs get the same hover, so the two sidebars behave alike.
- Pills, badges and icon buttons (update pill, local pill, review badge, the sign-in marker and its dismiss button) keep their hover. They aren't rows. The review badge does have an active state, but it rests on a tinted fill in Atelier and Lumen, so a softer hover could read fainter than its resting state.

## Contrast

`contrast.ts` checks the hovered row's inks on `sidebar-hover` painted over the sidebar in every palette: `sidebar-foreground`, `sidebar-accent-foreground`, `muted-foreground` and `unread-ink` at 4.5:1, and `sidebar-glyph` at 3:1. The derivations of `unread-ink` and `sidebar-glyph` include that surface.

## Tests

- Unit (`registry.test.ts`): in every built-in palette the hover is filled and sits at 60% of the selected fill's distance from the sidebar; a custom theme's hover follows its own accent. `contrast.test.ts` covers the five new pairs.
- e2e (`sidebar-hover.spec.ts`, `@design`): in every design and in light and dark, a hovered sidebar row is filled, its fill is lighter than (closer to the sidebar than) the selected row's, and the selected row keeps its fill when hovered. The settings tabs get the same check.
- Visual: screenshots in light and dark, in macOS and Lumen.

## Perf

CSS only.

## Out of scope

Thread-list rows (already distinct), menus and pills.

## Revisions after the Codex review

The plan review made eight points:

1. The review badge does have an active state, so its exclusion is now justified: it rests on a tinted fill.
2. Codex expected Tailwind to emit `hover:` before `data-active:`, but in the built app the hover won on the selected row. The e2e test caught it, and rows now use `not-data-active:hover:`.
3. and 4. "60%" means different things for translucent and opaque accents, and in dark mode "lighter" means weaker emphasis. Tests therefore compare fills as composited over the sidebar, never raw values. The unit test checks the composited ratio in every palette.
5. and 6. The contrast pairs now cover the inks a hovered row actually uses, painted over the sidebar rather than the background. This caught `unread-ink` at 4.28:1 in Apple Light, so its derivation now includes the hover surface (it moved from `0.523` to `0.503` lightness).
7. Every palette is covered by the unit and contrast suites; the e2e covers each design in light and dark.
8. The review row and "Add account" share the same token. A drop target is hovered during a drag (the drag is pointer-driven), and its drop fill still wins; the e2e test checks this.
