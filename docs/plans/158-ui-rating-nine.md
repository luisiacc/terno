# Plan 158: A rated UI, and every style at nine

- **Status:** in progress on `ui-9-hill-climb`.
- **Builds on:** plan 15 (designs), plans 118 to 122 and 125 (base controls), plan 139 (what runs where). The rule itself is `docs/ui-rating.md`.

## The request

> Okay, I want you to open up a work tree. In that work tree. You're gonna make a new assessment of each of the designs, meaning each of the styles, lumen, atlier, macOS, and graphite. And you're gonna, there are things that are going to be similar, that are going to be repeated in most of them, but I mean, what changes the most is basically the contrast of things, and some buttons that are to a bit differently, and in the thread leaf. There is the buttons are different, but I think that's pretty much it. There is not a lot of change. So when changing the palette, just judge the contrast. And those new buttons that show, the other things are probably gonna be used the same across everything. And once you do the adjustments and this numeric assessment that we did, let's keep this numeric assessment that we did, and that as a rule here. When we make that as a rule, let's differentiate what can they improve on actually, like, typography contrast placing, things like that, UI ux, and then you're going to make a score, again, from one to 10. And the goal here is to get it to be at least a 9 out of 10 on everything, and every screen needs to be at least 9 out of 10 in both codex and cloth. When you run those analysis. Make sure those analysis run independently. So they don't get history or get corrupted. And your goal will be to improve the UI, like hill climbing it, improving the UI until it gets to at least 9 out of 10 for the screens that you tested and in the style, in all of the styles. Okay. That is the goal. And in both UI and UX. Do that, take as long as you need, get the style and design, on that, on minimum 9 out of 10 evaluation, to make this app, a really great app.

## What exists

An ad hoc rating of Lumen on `ce79d18f` gave 7 (Claude) and 7.5 (Codex), with no screen above 8.5. Its scripts lived in `/tmp`, and its raters ran inside the repo, so they could see `AGENTS.md`.

The styles differ more than palette and a few buttons: plan 15's variants also change the row, compose's place, the list header, search, the quick filters, the reader's header and the type scale. So the shortcut in the request holds for flows, and not for how a style's own screens look.

## Design

### The rule, as tooling

- `docs/ui-rating.md`: the rule, the facets (UI: typography, contrast, placement, hierarchy, controls, density; UX: efficiency, clarity, feedback, consistency, accessibility), how to run a round, and how to keep raters independent. `AGENTS.md` points at it.
- `scripts/ui-rating/`: `harness.mjs` (the real Electron build on a throwaway demo profile), `capture.mjs` (the fixed evidence), `brief.md` (what a rater reads), `rate.mjs` (a round), `gate.mjs` (the bar), `gate.test.ts`.

The scale's words are the ones the first rating used, so its numbers stay comparable.

### Independence

Subagents load `AGENTS.md` and the owner's memory, so raters don't run as subagents. `rate.mjs` starts each as a new CLI process, `claude -p` or `codex exec`, in an empty random folder under `/tmp`, with sessions not kept, no MCP servers and no project docs. The folder holds the brief, one round's shots and a one-line re-export of the harness. A rater isn't told the bar, the round, an earlier score or what changed. Checked by asking both in a clean room what they had loaded: neither had any project context.

A round freezes one commit's build, so an edit mid-round can't reach a rater.

### The climb

1. **Baseline:** a full round on this commit (tooling only).
2. Read every `improve` and issue, sort by how many cells it would lift, and fix in atomic commits. Findings both raters make come first; a finding only one makes is judged on its evidence.
3. Re-rate in a fresh round. Narrow rounds while working, and one whole round on one commit to finish.
4. Stop at a pass, or when rounds stop moving: report honestly what's under the bar and why rather than wearing the raters down.

### Guardrails

- The product rules in `AGENTS.md` hold: inline compose, drag is a move, no lazy loading, motion within `--motion`, BoardUI controls, AA contrast in every palette, i18n in `en` and `es`, no new icons outside the catalog.
- Only `e2e` flows and baselines that a change really moves are updated, and looked at.
- A finding that contradicts a product decision goes to the owner, not into the code.

## Revisions after the Codex review

The plan's critique found twelve holes, all taken:

- **Raters could still inherit context:** user config, hooks and MCP servers are now off, and the environment is an allowlist.
- **Raters could find the repo and other ratings by path:** a round runs from a frozen copy in a random folder (build, Electron, Playwright, harness, brief). Raters still have a shell, so staying out is an instruction, not a wall.
- **A reused folder could pass falsely:** every round gets a new folder, and the runner refuses one that's in use. Untracked files count as dirty.
- **A report could pass without the evaluation:** no hands-on list, no reasons or no issues list makes it incomplete. A narrowed round can't pass.
- **Modes could hide each other:** a cell's score is its weakest case, across light and dark, layouts and window sizes.
- **Non-Lumen raters were told flows were "rated elsewhere":** gone. They try what the style changes, and whatever else a score needs.
- **The brief pushed raters to invent findings:** fewer issues are allowed, "nothing I can support" is a valid `improve`, and equal scores are fine.
- **Native appearance:** the harness sets `nativeTheme` too. macOS's translucent sidebar can't be captured behind other windows without Screen Recording permission, so it stays flattened, and that rater is told.
- **A lucky pass:** the rule needs two whole rounds in a row on one commit, every round is kept, and an unchanged commit doesn't get re-rolled.

The brief changed after the baseline, so round 0 is slightly less strict than later rounds on the weakest-case rule.

## Rounds

Each round is a whole rating on one commit, all four styles, Claude and Codex, in `/tmp/terno-scratch/ui9/rounds/rNN`. Shown: each rater's overall for the style, and its lowest screen.

| Round | Commit | Lumen | Atelier | macOS | Graphite | Cells under 9 |
|---|---|---|---|---|---|---:|
| r00 (baseline) | `91dcc803` | 6.5 (5) / 7 (5.5) | 7 (5.5) / 7 (6) | 7 (5.5) / 7 (6) | 6.5 (5.5) / 7 (6) | 883 of 888 |
| r01 | `19a089d8` | 7 (6.5) / 7.5 (7) | 7.5 (7) / 7 (6) | 7 (6) / 7 (6.5) | 7 (6.5) / 7.5 (7) | 876 |
| r02 | `90d8de33` | 7 (6) / 7.5 (7) | 7 (6.5) / 7.5 (7) | 7.5 (7.5) / 7.5 (6.5) | 6.5 (5.5) / 7.5 (7) | 858 |

Claude / Codex in each cell. r00's brief didn't yet score a cell's weakest case, so later rounds are slightly stricter.

What changed between them: r01 had the first pass (search, the row menu and selection, the composer and drafts, the list and sidebar, the reader, the palettes); r02 the second (Undo send, a shorter menu, the reader's per-message actions, one filter control, and an AI-draft data-loss fix). Round 2's Claude found regressions from the second pass, which pass three takes first.

## Tests

- `gate.test.ts`: the bar, and a report can't pass by omission.
- Each behavior fix gets a regression test at the lowest level that catches it. Look-only changes are held by the designs' baselines and `contrast.test.ts`.
- `pnpm test:all` before calling it done, and the Codex code review of the series.

## Perf

Nothing here may cost a perf gate. Compact rows and header changes go through the virtualizer's existing row heights. A round costs tokens and about 30 minutes, not runtime.

## Out of scope

- **Luma:** not one of the four named, and not rated. Shared changes reach it, and its baselines and contrast tests keep passing.
- Settings and onboarding: not rated.
- New features: a fix may rearrange what exists, not add a product area.

## The inbox list, its header and the sidebar (second pass)

- **One filter control:** `filter-menu` says Filter or the filter that's on, a × clears it. The `unread-filter` button and `filter-criterion` are gone; ⇧U and ⇧A stay.
- **List return:** a rater's row "moved" from y=485 to 811 because Playwright's click retries with `scrollIntoView({block:'end'})` while the header gives way. Traced: nothing in the app writes the scroll. The position holds, and `list-layout.spec` keeps it so.
- **Codex review, two rounds:** the header under the selection toolbar stayed reachable (now inert, and `/` ends the selection); long titles pushed controls off; touch icons replaced people's initials and filled the disc (only a photo does now); Similar… was hand-built; a search from a category hid that category's dot; a third dot overflowed the narrow slot.


## The reader, second pass

What the ratings on `19a089d8` asked of the reader, and what was decided:

- **A message's own actions.** Reply and a ⋯ menu sit under the date of every open message: always on the newest, on hover and focus elsewhere, in a place kept for them, so nothing moves. The right-click offers the same. `composeLanding` takes the chosen message (`sourceId`); a draft on another message turns to it and keeps what's written, with Undo. A chosen message that's gone answers nothing else, and says so.
- **One family of headers.** Folded rows and open headers share the avatar and name columns, and dates sit on the column's edge. The chevrons went: an open message says so by its weight, recipients and body, and "3 messages · Expand all" says the rows open. A tight row gives up the time first. The address shows at rest. Lumen's sender card shows only on a one-message conversation: on more it said one of them twice.
- **Keys.** ⇧N and ⇧P go message by message, `o` and Enter open, ⇧E opens or folds them all. On letters, since `[` and `]` need Option on a Spanish keyboard and `n` is a suggestion's.
- **Toolbar.** Print, Export and Copy moved to a More menu; their keys and the palette still reach them. Reply all is direct beside Reply when it reaches someone else. On a wide List page Back (with its name) and the steps sit at the pane's edges, so the toolbar on the column is Split's. Toolbar and conversation share a scrollbar gutter: that was the 4 px their edges disagreed by.
- **Reply bar.** A full line around it in every style, its words on the names' column, your initials quiet on a tint, the R key, an answer to the pointer.
- **Narrow reader.** A smaller subject and less around it, so the mail's first line stays high at 1100x700.

Not taken: steps in Split (j and k and the list beside it already do this; two more icons take away nothing), "after archive, open next" in List (a setting, a product choice), and moving the pane handles in the tab order (the sidebar's and list's area).

### What the Codex review changed

- N and P lost their mark on the second step: the header left cleared the next one's.
- A chosen message that vanished fell back to answering another; now it's refused, with a message.
- A retarget was refused or turned standalone when the message the draft left had gone, or the draft's placement had expired.
- A direct Reply left a focus handoff set, so its menu didn't give focus back later; a refusal while a menu closed lost focus.
- Collapse all could drop focus to nothing, from a header it folded or a body closing under it.
- The keys kept working behind the full-message view, and could close it.


## The reader, third pass

On round 2's ratings (`90d8de335`), with the owner's decisions:

- **One clear way to reply.** The toolbar has Reply in words, Reply all in words when it reaches someone else, and Forward as its glyph, with no menu. Reply all comes in on Reply's far side, so Reply and Forward never move between conversations. It shows its words only on a full-width column, where every language fits (Split ≥ 720 px, List ≥ 1080 px), and not when the toolbar also holds Move to Inbox and Summarize. A message's own Reply and ⋯ show on hover and focus only, the newest's too (the reply bar is just below it), at 28 px.
- **The reply bar names the account in words:** the reply glyph sits in the avatars' column, and "from Acme Studio" shows only with more than one account. Initials read as a person.
- **Headers show that they open.** Every message header and "N more messages" carries the quoted text's chevron on the dates' edge: right when folded, down when open. This reverses the second pass's "the chevrons went": raters still couldn't tell the rows open.
- **Context in a short window.** Once the whole header is above the reader, one line under the toolbar keeps the subject and, while a draft is open, its title ("Reply to Isabella Álvarez"). It takes over the toolbar's hairline. The scroller's `scroll-padding-top` is that line's height, and every reveal (`keepInView`, `revealMessage`, `revealMark`, the composer's caret margins) clears it.
- **List's page:** Back and the steps hang just outside the column's edges, not out at the pane's.

Not taken: the body measure (35 em, about 75 characters, already in every style); darker avatars (the initials hold 4.5:1 on their tint, and the avatar is shared with the list); a shorter tooltip delay (app-wide).

**What the two Codex reviews changed:** Reply all's words overflowed narrower readers and longer languages, so they now show only where they fit; the composer's own scroll (an undo above the view) put the caret under the line; a reduced-motion opening could land under it; switching style left the line watching a heading that was gone.

## Second pass: the row menu, the palette, selection and undo, search

Decisions of the second pass in this area, and why:

- **Row menu:** Reply, Reply all, Forward; Archive, Delete, Mark unread, Star; Remind me, Move to, Category; More. More is flat under small labels (Similar mail, From *name*). A row with several answers unfolds them in place (`Unfolding`), so nothing is three levels deep. It also keeps the panel short, and offers are only read once asked for. Menu rows are 28 px. A row that isn't the open one is outlined and says itself in a caption (and in the menu's accessible name).
- **Palette:** aliases hold the app's own words (compose, search, preferences…); an alias shows only when it's why the row matched. The panel hugs its results with the field in place. With nothing named outright, "Search mail for …" leads, then real conversations from `threads.search`, asked once typing rests (120 ms) and held at 57k threads in both stores (`search-everywhere.perf.test.ts`, `idb/workloads.perf.test.ts`). Spam and Trash aren't offered there; a search asked for by hand still looks in them.
- **Offers:** a sentence that says what it does ("Archive 5 more from Xataka"), with the mail's own subject rather than a rule's `#`, and a list by name rather than its id. The digit is the line's shortcut, at its end.
- **Selection:** every checked row has the open row's fill and ink, the check in the unread dot's slot. Among several, a cursor outside them only shows where it is, and an outline marks it only after j/k (`data-keyed`). The pane holds Remind me, the menu's order, and lists what's selected. List's toolbar lies over the title line, which goes inert, so no row moves under a ⌘-click.
- **Search:** focused and empty, it says what it understands and what it looks through. An operator waiting for its value asks for nothing. A result opens at its match: marks in plain text through React, in a frame through its DOM (bounded, removed exactly, nothing past the frame's clip counted), the reader scrolled to it (the frame never scrolls), with a count and ⌘G / ⇧⌘G. A folded message or quote holding the only match opens. The base catalog's Pagination is page-based and wordy, so the steps are the reader's own icon buttons, as StepButtons are.

**The undo toast stays over the list:** the list already keeps room under its last row and brings the open row clear of the dock (`thread-list.tsx`), which is what was asked; docking it in the layout would resize the list on every action.

**What the two Codex reviews changed:** a palette row opens among its own results, with nothing left selected, the composer stepping aside, Review left and the list's filter applied to what's offered; marks hold their bound inside one long text node and go with a folded message; ⌘G works with focus in the mail; nothing is counted past a frame's clip; the one in hand survives folding what's before it; entities and block boundaries are read as they're drawn; a link's text is marked; what's under List's toolbar can't take focus; Esc works from the help rows.
