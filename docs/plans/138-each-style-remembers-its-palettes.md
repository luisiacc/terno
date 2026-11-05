# Plan 138: each style remembers its palettes

## The request

> when he user picks a style, lets have a remember logic there, so if htey pick a style, we pick the palette for light/dark that was used with that style, Example: if I have Lumen with GitHub Light and then I switch to Graphite, with Graphite I have it with the style colors in the palette for light and dark. Right now if I have GitHub Light as the palette and I switch from Lumen to Graphite, it stays in GitHub Light. What I want is that when I switch from Lumen to Graphite, Graphite has the palette I selected while using Graphite, not the same palette. Let's do that logic with with every style

## What exists

- `design` picks the style; `lightTheme` and `darkTheme` are one pair of slots, each `"design"` ("Style colors"), a built-in id or `custom:<id>` (plan 15). Nothing ties a slot to a style, so a switch keeps them.
- Every appearance change goes through `updateAppearance` (`apps/web/src/lib/appearance.ts`): it waits for the new style's faces, then applies an optimistic patch and persists it in a serial queue. Answers are reconciled by laying the pending patches over them. `reconcileSettings` and the failure path restore only `APPEARANCE_FIELDS`.
- Settings → Appearance and first run both pick a style with `updateAppearance({ design })`. Choosing the current style again goes through the same call and must stay a no-op: it only cancels a switch still waiting for its faces.
- The backend validates a slot on write (`fitsMode`, it must exist and match its mode) and sanitizes on read (`resolveThemes`). An export carries `GENERAL_KEYS`, each validated alone.
- `previousLightTheme` / `previousDarkTheme` are the palettes from before designs (plan 15). They are a different thing and stay as they are.

## Design

**A new setting, `designPalettes`:** `Partial<Record<DesignId, { light: string; dark: string }>>`, default `{}`. It holds what a style was left with. The style in use always reads from the slots, so everything that paints (`resolveTheme`, `theme.js`'s cache) doesn't change.

**The switch is one pure function in `@terno/core`:**

```ts
switchDesign(settings, design) => { design, lightTheme, darkTheme, designPalettes }
```

- The slots in use are saved under the style being left.
- The new style takes back what it was left with.
- A style with nothing saved gets "Style colors" in both modes. That is the request's example: Lumen with GitHub Light goes to Graphite in Graphite's own colors, and back to Lumen in GitHub Light.
- A remembered custom palette deleted since, or one of the wrong mode, is "Style colors" (the slot's write validation would otherwise refuse the switch).

**Where it runs: `commitAppearance`, at commit time.** Not before the font wait: a palette picked during the wait belongs to the style still in use, and it has been committed by then. The patch is expanded when `patch.design` differs from the current style, and a palette named in the same patch wins. The expanded patch is what's pending, sent and reconciled, so an older snapshot can't paint the old palette over the new style, and style and colors land in one frame through the existing `applyAppearance`. The backend stores the whole map, like `customThemes`: it has no logic of its own for this, and nothing but the renderer changes `design` except an import, which names the palettes itself.

**Backend.** `designPalettes` joins the patch schema (design ids only, ids capped like the slots), `DEFAULT_SETTINGS`, `resolveThemes` (legacy ids mapped, unknown or wrong-mode ids become "Style colors", designs that no longer exist dropped) and `GENERAL_KEYS`, so a backup brings them back. `fitsMode` moves to core so both sides use the same rule. An entry isn't refused on write: it is a memory, and a backup naming a custom theme it doesn't carry must not fail the import. No migration: a profile without the setting reads `{}`, and its first switch saves what it has under the style it's on.

**Copy.** The Style hint said the colors follow the style unless you choose your own. Now: "Type, shapes and layout. Each style remembers the colors you choose for it below." (`en` and `es`.)

**First run** uses the same call, so it gets the same rule: a new install on Lumen with the GitHub palettes (plan 98) that tries Atelier sees Atelier's own colors, and GitHub's again on returning to Lumen.

## Tests

- `packages/core`: `switchDesign` saves the outgoing pair, restores the incoming pair, defaults to "Style colors", and drops a deleted custom palette.
- `apps/web/src/lib/appearance.test.ts`: the optimistic paint, a round trip across every design, an explicit palette in the patch wins, reselecting changes nothing, a palette picked during the font wait stays with the old style, an older answer doesn't paint over a pending switch, a refused switch restores the map.
- `packages/backend/src/settings.test.ts`: default, persistence, read sanitizing (legacy id, wrong mode, deleted custom, unknown design). `settings-edits.test.ts`: export and import carry it.
- `apps/web/e2e/designs.spec.ts`: the request's example through Settings, the painted `data-theme` and the selected cards after every switch, in both modes, surviving a reload.
- `apps/web/e2e/first-run.spec.ts`: updated to the rule, and Back to Lumen returns GitHub.

## Performance and resources

A switch adds one small object spread to a path that already repaints the app. The setting is bounded by the number of designs. No new timers, listeners or network. The perf gate's `setDesign` skips `updateAppearance` and is unaffected.

## Out of scope

- The light / dark / system mode stays global; only palettes are per style.
- The Style tiles keep drawing each style in its own colors, as they do for the style in use today.
- `previousLightTheme` / `previousDarkTheme` are untouched.

## Revisions after the Codex review of the plan

- **An import keeps what the file doesn't name** (#2). `settingsFrom` merges the file's `designPalettes` over this install's, and the style a file replaces saves its slots first, also from a file older than this plan, which has no map. Test in `settings-edits.test.ts`.
- **First run shows the palette a style brings back** (#4). The palette list scrolls on its own, so a restored selection could sit out of view: the effect that reveals the chosen card also runs when the style changes. Asserted in `first-run.spec.ts`.

Known edges, left as they are (both need rare timing or a rare file):

- A palette save refused by the backend while a style switch is queued behind it: the switch still saves the refused palette under the style it left. Saves only fail on an id the UI doesn't offer.
- A backup from a newer release with a style this build doesn't know fails the map's validation, so the import drops the whole map, as it drops its `design`. Those styles start from their own colors.
