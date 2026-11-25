# Plan 274: What matters' headings in two levels, Coming up a section title

## The request

> we need to improve a bit design here with a bit of differentiation […] for example look how the 'commig up' which is a
> clickable item to expand/collapse, it almost the same as the titles of the dates, its confusing and makes me don't know
> where to click, we need to differentiation, come up with some designs these and give me pictures so i can choose

(The screenshot: a clear What matters, "COMING UP · 4 ⌃" open over "SUN, DEC 6 1", "WEEK OF JAN 11, 2027 1" and "WEEK OF
JAN 25, 2027 2", then "EARLIER 76": one look for all of them.)

Four mockups were shown (A disclosure row, B section title with quiet dates, C pill button, D divider with a control).
The owner picked B:

> lets do B yes, although i do se that in the picture 'Coming up' has some kind of padding left that makes it look not
> aligend to the first item below's date , lets make it so they look aligned vertically from the left

## What exists

`apps/web/src/components/what-matters/feed.tsx`. Plan 214 (Ledger) made every heading the same small-caps label (`LABEL`:
caption size, semibold, spaced capitals, the quiet ink) with its count beside it; a part of a group (`part`: Today's
"Waiting on you", Coming up's day and week buckets) is the same label, only closer to what's above. `ComingUpHeading` is
plan 210's disclosure (`Collapsible` + `CollapsibleTrigger`, BoardUI's) dressed in that same label, its words the catalog's
"Coming up · #". So the one control among the headings looks exactly like the dates it opens.

## Design

Two levels, two looks, by what already decides the level (`part`):

- **A group's heading is a section title**: the type scale's `text-lg`, semibold, tight tracking, the ink (not the quiet
  ink), sentence case as the catalog writes it. Its count is BoardUI's neutral `Badge` beside it. Missed, Today, Waiting on
  you on its own, a day or week ahead, Ahead, Coming up and Earlier.
- **A part of a group is a quiet subheading**: `text-sm`, medium, the quiet ink, sentence case (no capitals), its count in
  the same ink at the regular weight. Today's Waiting on you and Coming up's buckets ("Sun, Dec 6", "Week of Jan 11, 2027").
- **Coming up is a section title that is a button**: its title and badge inside `CollapsibleTrigger`, the chevron after
  them (turning, its hover ink the catalog's). Its title is a new catalog key, `whatMatters.comingUpTitle` ("Coming up",
  es "Más adelante"); the button's name is its title and count ("Coming up 4"). The empty feed's quiet line under the
  horizon keeps "Coming up · #".
- **Alignment**: every heading, title or part, starts on the rows' text line (`ms-4`, plan 214), and the trigger has no
  padding of its own, so the title's ink starts where the dates and sentences under it start. Checked by box in e2e (≤ 1 px,
  as today) and by ink in the screenshots. Measured: the "C" of Coming up, the "S" of Saturday and the sentences' first
  letters all start on the same pixel column in Lumen, Graphite and macOS, so no optical correction. (The mockup's offset
  was the mockup's: a round capital at a larger size than the real scale's.)
- Spacing: a section title gets more room above (`pt-7`) than a part (`pt-4`), so groups read as groups.

Nothing else changes: the rows, the virtualizer, j/k (headings were never stops), the moves of plan 271 (keys unchanged).

## Tests

- `today.spec.ts` (plan 210's Coming up scenario) and `what-matters-feed.spec.ts` (iterations 3–5, plan 215): the toggle's
  text is "Coming up" with its count badge, its name "Coming up 2"; a part's heading is in the quiet ink and a section
  title in the ink (computed colors differ); the Coming up title on its buckets' text line (box, ≤ 1 px) as the buckets on
  their items'.
- axe in light and dark in the specs that already run it (badge and subheading contrast on the pane).
- Screenshots in light and dark (Lumen), looked at.

## Perf and resources

The same rows and elements (a badge replaces a span). No new state, no measuring. The virtualizer's estimates follow the
two heights (a section title 60 px, Coming up's 58, a part's 42), so an unmeasured stretch lands closer to where it will.

## Out of scope

The automated messages row, the horizon, the rows themselves. Other designs keep their type scale (Graphite's `text-lg`
is its base size: there the title differs by weight and ink).

## Revisions after the Codex review

1. **One name for the button.** An `aria-label` of "Coming up · 2" failed axe's `label-content-name-mismatch` against the
   visible "Coming up 2"; the name is now the visible title and badge ("Coming up 2"), asserted in both specs. The empty
   feed's quiet line keeps "Coming up · #".
2. **Heading levels asserted**: Coming up an `h2`, its buckets `h3` (today.spec).
3. **Counts in the locale's digits**: `formatNumber` for the badge and the parts' counts, as the catalog's `#` was.
4. **The empty feed's line** is unit-tested (`feed.test.tsx`): "Coming up · 1", no badge.
5. Alignment is checked on the title's own span against the first bucket (the feed holds only two buckets there).
6. **The inks by the theme's own**: the title's computed color equals `text-foreground`'s, a bucket's `text-muted-foreground`'s
   (a probe in the feed), not merely different. The badge's and the subheading's pairs are in `CONTRAST_PAIRS`; axe runs at
   the feed's end with both on screen, in light and dark.
7. The chevron stays the shared trigger's 16 px (BoardUI's accordion chevron, muted until hover or open), beside the title
   rather than pushed to the row's end; the trigger's ring is the shared `focus-visible:` one.
8. No optical correction was needed (measured, above).
9. **Screenshots in every design**, Relief added to the loop, and Coming up open at 1100 px in each, light and dark.
10. **Virtualizer estimates** per level (above).
11. `ui:rate` / `ui:gate` (plan 158): see the end of this plan.
