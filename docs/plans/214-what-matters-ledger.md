# Plan 214: What matters, Ledger

## The request

> we need to do some polish on the 'what matters' ui for the list, you can see it using the demoai command. for example here see how when i hover there is no separation between rows, thre should be at least a 1px separation. also i think this lacks a lot of contrast and hierarchy, i don't know where things stand or mean or where to look, lets improve this, create 5 designs on another worktree and show them to me, they must work on light and dark mode well and be clear and polished.

Then, after five looks (Ledger, Cards, Rail, People, Tags) were shown on the demo-ai mailbox in light and dark:

> ok lets use ledger then, us the ui rating workflow to polish it even further do at least 2 rounds of polish and rating

## What exists

Plan 210's feed (`apps/web/src/components/what-matters/feed.tsx`): headings over a hairline in the ink at text-sm medium; "Waiting on you" and Coming up's buckets as quiet sub-headings; each item a rounded fill on hover with its sentence (text-base, medium only for Missed and today's dated items), who under it, and a when column on the right (under the sentence in a narrow feed). Rows sit flush, so a hovered fill touches the open one. Everything else is one grey weight: nothing says where to look first.

## Design (Ledger)

Apple Mail's list, said in the feed's words:

- **Headings** are small-caps labels (caption size, semibold, spaced capitals, the quiet ink) with the count of their items beside them, on the rows' text line. No hairline under them: the rows carry the structure. The count sits outside the heading element, so the heading's name is what a screen reader's heading list (and the tests) read.
- **A mark in the gutter** for what's pressing, the way Mail marks unread: red (`destructive`) for Missed, the design's unread color for what's due today. Nothing else is marked, so 48 people waiting don't all shout. The mark sits left of the text line, so text stays aligned with the headings.
- **Hairlines between rows** (inset to the text line), gone under the hovered, open and cursor rows. The rows sit a pixel apart, so two fills never touch.
- **Two lines:** the sentence; then who, with when at the line's end in the preview ink, Missed's in the destructive ink and today's in the ink at medium weight. The when column of plan 210 goes: one layout at every width, so the narrow feed beside the reader reads like the wide one. The second line is always one line (who truncates; when never wraps), so a row's height never changes.
- **Done and Later** appear in place of when (hover, focus, the open row, their menu open); the second line ends before them (`--wm-controls`, measured as before).
- Coming up's sentences keep the ink (plan 210, iteration 3: no fade); the history stays muted.

No new strings, no new tokens. `CONTRAST_PAIRS` gains the destructive ink on the pane and a hovered row (Missed's when) and the two marks there (3:1, as a dot).

## Rating (plan 158's workflow)

The AI set's `a07-today` and `a08-today-digest` still waited for plan 145's Today (`today-heading`, `digest-row`), which plan 210 replaced: an AI round couldn't reach them. They now open the feed and its automated mail row.

What matters gets a set of its own, `--screens whatmatters`: one screen, `what_matters`, five states (`w01` at rest, `w02` hovered, `w03` open beside the reader with the next row hovered, `w04` further down with Coming up open, `w05` in 1100x700), on Pro's real models since the feed is what the app's readers find (plan 211: on by default). Every launch of this set, the capture's and a rater's, starts from a seed (`--seed`, default `/tmp/terno-scratch/rating/wm-seed`; harness `seedProfile`, `UI_RATING_SEED`): the demo mailbox's database after `pnpm dev:demo-ai` prepared it, its readers' queues emptied, frozen with the round and hashed into round.json. A fresh profile can't be rated: its readers check 14 days of mail and 30 of sent mail, and What matters' daily background budget (600k input tokens, `DAILY_INPUT_TOKENS.dated`) runs out after about 55 reads, so on the rating's fixed day only "Waiting on you" ever shows. (The same budget means a real first launch fills What matters over several days: worth the owner's look, outside this plan.) The capture waits until both readers have checked every account and emptied their queues and the header's numbers hold for 20 s, and fails after 25 minutes.

## Tests

- `today.spec.ts` and `what-matters-feed.spec.ts`: the headings' text, the heading on the rows' text line, the meta's text, axe in light and dark (they read `wm-heading`, `wm-sentence`, `wm-meta`, `wm-when` as before).
- The designs' source scan and the contrast tests (no new color or size outside the scale).
- `scripts/ui-rating` unit tests (sets, gate).

## Perf

One more element per row (the hairline span; the mark on pressing rows only). The heading counts are one pass over what's drawn, in the memo that builds it. The UI perf gate's feed render counts are unchanged.

## Out of scope

The header's numbers line, the reader's line, the digest page, and other styles' structural variants.

## Revisions after the Codex review

Codex's critique of the plan (eleven points, all taken):

1. A long when wrapped, and hiding it on hover changed the row's height under the virtualizer. The second line is one line: when never wraps, who truncates. The e2e checks the row's height at rest, hovered and focused.
2. A row's keyboard focus hid its when while Done and Later stayed hidden. They now show on the row's own focus too, as on hover.
3. `foreground-soft` isn't held on the pane or a row's hover. Coming up's sentences keep the ink, as plan 210 decided. The destructive ink and the marks on the pane and a hovered row are new `CONTRAST_PAIRS`, and every theme passes them.
4. Waiting on you and Coming up's buckets are `h3` again under their group's `h2`.
5. Done and Later, their room and the mark use logical sides (`end`, `pe`, `start`).
6. `brief-wm.md` carries the AI brief's model paragraph word for word, so a stub round's brief is made (tested).
7. The gate checks a What matters round's model record as it does the AI set's (`usesAi`; tested, failing without the fix).
8. The capture fails if the feed doesn't settle in 25 minutes.
9. The hovered and opened rows are the first two with Done and Later, by their row ids, checked before each shot.
10. `w04` puts the automated mail's row at the top with Coming up open under it; Earlier has its own shot (`w06`), each checked in view.
11. The AI set's search for the automated mail's row goes a step at a time and starts over from the top until it comes.

## Codex code review

Three findings, all fixed:

1. Done and Later took when's place with `display: none`, so a row with keyboard focus lost its deadline from the accessibility tree too. When is now visually hidden (`sr-only`) in their place, still read.
2. A seed carries its own look. `seedProfile` refuses a seed that isn't Lumen in its own colors with light and dark following the system (a fresh profile's), so a style's capture can't be another's.
3. A seeded round's captures may ask the models nothing (its feed is what they already found). The gate allows a seeded run with no requests, and still requires every run's record and only providers in use (tested both ways).

Also from the first rounds: the capture's search for a section of the feed waits at the end for Earlier's next page and asks again, and finds a row again when it leaves the virtualizer's window before the scroll to it.

**Tests run.** Typecheck (web), `oxlint --deny-warnings` on the changed files, the themes' contrast test and the designs' tests, `scripts/ui-rating` (36). E2E (`E2E_PORT=5631`): `today.spec.ts`, `what-matters-feed.spec.ts`, `what-matters-mute.spec.ts`, `what-matters-change.spec.ts`. `today.spec.ts:648` failed in two of three runs right after the last change (its Done, Remove and Later scenario, then the reader's line), then passed seven runs in a row; on main it passed four of four. Not explained: noted as flaky here, worth a look if it comes back.

## Rating, round 1 (`wm-r01`, all five styles, Claude and Codex)

Overall 6 to 7 (Lumen 6.5 and 6.5; Atelier 6 and 7; macOS 6 and 7; Graphite 6; Relief 6 and 7). Codex's Graphite report came in another shape (`scores`, not `screens`) and the gate's summary can't read it: its issues match the others'.

What every rater said that is this plan's:

- **The date and the mark went as you acted.** Done and Later took when's place, and the mark left the open row. Now when stays in sight, beside Done and Later (the line ends before them all), and the mark stays in every state. A first try kept when where it was and put Done and Later before it: beside the reader that put Done in the row's middle, where a click opens the row (an e2e caught it, clicking an item's centre). Done and Later stay at the row's end.
- **The mark hung over the fill's edge.** Rows' words start 1rem in (`ps-4`), the mark inside the fill at 4px, and the headings, the hairlines and the header's title move to the same line.
- **The header was half a scrollbar right of the list** in a wide feed (the list's column centred in the width the scrollbar leaves). The header keeps the same gutter (`scrollbar-gutter: stable`), as the reader's toolbar and body do.
- On the open row, Missed's when is the selection's ink: red there fails AA in every palette (the contrast suite), and its red mark stays. The marks on the selection are new pairs.

What they said that isn't this plan's, for the owner: Waiting on you holds 48 of 54 rows and nothing on it has Done or Later (plan 210: a waiting row has no task), so most raters wanted it collapsed after a few or given actions (the owner removed the feed's cap, plan 204); focus isn't moved to the next row after Done, and the next row slides under the pointer; the automated mail's row read "0 archived" and opened an empty page (the seed's digest had failed: a real state the row words poorly); Earlier's words ("Over today", "Settled") don't say completed or expired; the feed can't say why an item is there (the source sentence); the open row is only its fill, close to the hover in dark (the owner's call: no rail, `selection.spec`).

## Rating, round 2 (`wm-r02`, all five styles, Claude and Codex)

Overall 6 to 7 again (Lumen 6 and 7; Atelier 6 and 6.5; macOS 6 and 6.5; Graphite 6 and 6.5; Relief 6 and 6.5). Feedback rose (Codex 7.5 to 8 in every style); what holds the scores is what round 1 found outside this plan, now named by every rater: 48 Waiting on you rows with no Done or Later, burying Coming up and Earlier; why an item is there; Earlier's words; focus after Done; the "0 archived" row; the open row close to a hover in dark.

One finding was this round's own: beside the reader, the open row's Done and Later cut who to "To Em…" (raised in eight of ten reports). The open item at rest now shows no controls: the reader beside it has its line with Done, Later and the rest, and D and B act on it; hovering it brings them back. (Plan 210 had them on the open item too; changed here for the rating.)

The owner's next request, built next (plan 215), is the rating's most-named issue: Done and Later on Waiting on you rows.

**Tests run (after round 2).** Typecheck (web), `oxlint --deny-warnings` on the changed files, the themes' contrast tests (160), `scripts/ui-rating` (36). E2E (`E2E_PORT=5631`): `what-matters-feed`, `today`, `what-matters-mute`, `what-matters-change`, `hand-to`: 29 of 29, twice; the first run after the change failed `hand-to`'s palette scenario and `today.spec.ts:648` once each, as after the earlier changes (the first run after an edit, then passing). Not run: `pnpm test:all` (no store, schema or query changed), the UI perf gate.

**After rebasing onto main** (plan 213, the list's keys on the feed's rows, took number 213 meanwhile: this plan is 214, and Done and Later on Waiting on you is 215). The conflict was one line (the row's `onFocus={placeFeedKeys}`, kept). Typecheck, lint, unit (233: `scripts/ui-rating`, the themes' contrast, the designs, `feed-controls`, `feed-focus`). E2E, the same five specs: the first two runs after the rebase failed one test each (Earlier's Done and Undo; `today.spec.ts:648`), then 4 of 4 passed; main itself, the same specs in a clean worktree: 2 of 3 passed (its failure `hand-to`'s palette scenario). Flaky on both.
