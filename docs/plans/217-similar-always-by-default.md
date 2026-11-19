# 217: "Always" is the default when acting on similar mail

## Request

> we have a flow when archiving or doing more actions for the same family of emails, we have a 'similar' and then after they do we have an 'always', and 'always' should be the default when they click the option to do action to similar.

(With a screenshot of the "Archived · Archive similar… · Undo" snack, its line "Archive 4 more from GlobaLex".)

## What exists

- Archive or Delete one conversation: the snack (plan 63, 91, 158) offers "Archive similar…", whose lines ("Archive 4 more from GlobaLex [1]") run `applySimilar` (`apps/web/src/lib/similar.ts`). The thread menu's "Archive similar mail" submenu runs the same through `actSimilar`.
- `similar.apply` sweeps the scope; for **spam only** it also ensures a filter for future mail (`similarFilters.ensure`) and returns its `filterUndo`.
- After an archive or delete sweep, the result snack ("Archived 4 · Everything from GlobaLex") offers **Always** as its secondary, which calls `similar.always` to make the filter then. Spam has no Always: its filter is already made.

## Design

Acting on similar mail means "this kind of mail": the sweep makes the filter for new mail too, for every action, the way spam already does. The follow-up flips from opting in to opting out.

- **Contract.** `similar.apply` takes `always?: boolean`. A filter is ensured when `action === "spam" || always`. Spam stays as it is (always makes its filter). Explicit, like `categorize.apply`'s `always`.
- **`applySimilar`** passes `always: true` and a `filterName` for every action. Both entry points (the snack's lines and the thread menu's submenu) go through it, so both get the default.
- **Saying so before the click.** The snack's offer lines show "+ new mail" for archive and delete too (as spam's already do), and their help says "…, and their new mail from now on." The thread menu's note under "Only this email" is shown for every action ("Their future mail is archived too." / "…goes to Trash too.").
- **The result snack** says it: "Future mail like this is archived too." (or goes to Trash), or that the rule couldn't be made (today's `similar.filterFailed`).
- **The way back.** Its secondary becomes **Just these**, taking back only the filter. (Replaced by Edit after the review, below.)
- `similar.always` stays: Settings and tests use it; the snack no longer calls it.

## Tests

- Backend (`similar.test.ts`): archive with `always: true` makes the archive filter and Undo deletes it first; archive without it makes none (today's).
- e2e (`similar.spec.ts`): the archive scenario now sees "+ new mail" on the line, the rule made with the sweep, the note, and **Just these** taking back only the rule (mail stays archived); z then brings the mail back.
- Unit: none of the changed logic lives in a pure module beyond `applySimilar`, which the e2e covers.

## Perf

One `similarFilters.ensure` after the sweep, as spam already pays. No hot path changes.

## Out of scope

- Spam's flow (its default and "No, only …") is unchanged; Just these is for archive and delete.
- Category and folder offers (they already default to always where plan 91 says).

## Revisions after the Codex review

The critique's points, and what changed:

1. **"Just these" is dropped** (points 1–5, 9). An opt-out that takes back only the filter needs a second undo path that shares state with Undo and z, races them, and can't promise new mail stops: an edited filter is skipped and a broader rule may still catch it. Instead, the result's secondary is **Edit** ("Edit the rule for future mail"), which opens Rules, as "Rule created · Edit" already does for categories. Undo still takes back everything, the rule first. Edit is shown whenever a rule covers the scope (made now or reused); none when it couldn't be saved (the note says where to add it).
2. **The filter is made before the sweep** (point 6), as category and folder filing do, so mail arriving mid-sweep is caught. This applies to spam too. A failure after it carries `{ undoId, filterUndo }` (one helper, `withFilterUndo`, now shared with folder moves), and the renderer (`applySimilar`, the spam default) reads both, so Undo takes back the rule as well. A sweep refused before any slice committed (past the cap) takes its own filter back: nothing is left half done.
3. **Offer visibility is unchanged** (point 7). Showing zero-count or same-as-sender scopes would make every archive show "Archive similar…". The offer still appears only when there's more to do now; a rule for a scope with nothing to sweep is Settings → Rules' job.
4. **The menu note is on every action and describes each offer** (point 8): `aria-describedby` on each scope item points to it, so a screen reader hears "their future mail is archived too" before choosing.
5. **`similar.always` is removed**: nothing calls it now. Its backend tests use `similar.apply` instead.
6. **Tests** (point 10): web unit tests for what `applySimilar` sends and says, and for Undo taking back a rule named by a failed sweep. Backend tests for the filter existing before the first slice, the failure details, and the refused sweep leaving no filter. IndexedDB parity (point 11): the handler and `SimilarFilters` are store-agnostic and the filters store is covered by the conformance suite; nothing store-specific changed.
