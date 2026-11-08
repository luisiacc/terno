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
| r03 | `e48f0f30` | 7.5 (7) / 7.5 (7) | 7 (7) / 7.5 (7) | 7 (6.5) / 7.5 (7) | 7 (7) / 7.5 (7.5) | 825 |

Claude / Codex in each cell. r00's brief didn't yet score a cell's weakest case, so later rounds are slightly stricter.

What changed between them: r01 had the first pass (search, the row menu and selection, the composer and drafts, the list and sidebar, the reader, the palettes); r02 the second (Undo send, a shorter menu, the reader's per-message actions, one filter control, and an AI-draft data-loss fix). Round 2's Claude found regressions from the second pass, which pass three takes first. r03 had pass three (the regressions, a full-page new message, a labeled toolbar Reply, one shortcut notation, a rail on the open row, All | Unread). Issues by severity, r00 to r03: high 26, 12, 5, 4; medium 72, 67, 53, 49. What's left is consistency and state.

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


## The inbox list, its header and the sidebar (third pass)

- **A read row has a hierarchy:** sender at 500 in the row's ink, subject regular in the same ink, preview and meta quiet. Unread stays a step above: 600 (Lumen 700); Graphite's unread sender takes 600, its one weight outside 400 and 500, so read and unread don't meet.
- **Four states, four looks:** checked and open share the selection's fill; the open row alone has a 2 px rail in `--row-rail` at its leading edge, straight inside the rounded shape (`row-rail`), none while several are checked. A cursor that isn't either (List's, or outside several) is the hover's fill inside a 1.5 px outline in the quiet ink. While the row menu is on another row, the open row gives up its fill and keeps its rail, so one row looks chosen.
- **The rule offer is the list's first item:** 32 px, one line (truncating, said whole in its button's name and on hover), quiet. It lies over the room the virtualizer leaves above the first row (`paddingStart`), outside the listbox, which holds only options, and follows `scrollTop` with a transform from a passive scroll listener: a scroll-driven animation would stop with motion off and leave it over the rows. A wheel over it scrolls the list. The scroll anchors (a design switch, a mailbox's return) measure rows past it. It's fetched by `LearnedSource`, a null component, so a count change renders the list only when the offer changes.
- **Suggestions in words:** one line under the Categories heading, "Review 79 suggestions", opens the category with the most; each category's own is first in its menu, and its row's tooltip counts them. The per-row sparkles went (five Tab stops, five unexplained icons).
- **Unread in one click:** where filters were a menu, a segmented All | Unread with the rest (People, Waiting, With attachments, Starred) in a More filters icon menu, filled while one is on and named for it. All clears any; the × went. Lumen keeps its chips. Nothing in the header changes shape with a filter.
- **List:** the selection toolbar has the pane's labeled buttons in their tones and order; a narrow bar lets words go by priority (Archive and Delete never). A wide row reads subject then preview as one line, so the meta columns follow the text. The category tabs are a step under the mail (small, regular, the chosen one medium).
- **Header:** Lumen's counts are one quiet ink; "N waiting for your reply" is BoardUI's secondary link button and stays underlined while on. On a window under 760 px tall, a display title's subtitle gives its room to the rows; 1100x700 holds 9 whole rows in macOS and Graphite, 8 in Lumen and Atelier (their 68 px rows), held by `inbox-scan.spec`.
- **Keyboard:** the pane handles are drawn from the end of the page (placed from the grid's `--pane-*-eff`), so Tab goes sidebar, list header, list, reader and then the handles; the first Tab offers "Skip to conversations". Not taken: the search field's help rows are Tab stops while it's focused (search's area).
- **What the Codex review changed:** the offer's room took clicks over rows scrolled under it (now only its visible part does); an offer that came or went while the list was scrolled moved the mail on screen by its height (now compensated); the skip link pointed at a list under List's page (now only shown while the list is) and waited on an empty one (now it lands in the list's header). The second round: at the list's end the offset is already clamped when the offer goes, so the compensation reads the last scrolled offset; Tab onto a partly scrolled offer brings the list back to its top; with no rows the skip link takes an action preview's header too. Found on the way, not from this series: a refresh (`changed`) at the end of a long, fully loaded list moves it up about 90 rows.


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

## The reader, fourth pass

On round 3's ratings (`e48f0f309`), with the owner's decisions:

- **Two ways to reply, one family.** The toolbar's group and the bar at the end say the same words in the same order: Reply, Reply all, Forward. Reply all keeps its slot in the toolbar, dimmed when it reaches nobody Reply doesn't, so nothing moves between conversations. A message's header has no Reply of its own: its ⋯ menu (and the right-click) leads with "Reply to this message". The bar says "Reply to Arjun", without the ellipsis raters read as a cut.
- **A toolbar you can read.** Words show beside the icons by priority, as many tiers as the column holds in the language at hand, measured (`fitWords`, re-run when the width or the set of buttons changes): Reply; Back's mailbox; Archive and Delete; Reply all and Forward. A word that doesn't show keeps its name in the tooltip and for screen readers. Mark as unread moved into More. In the narrowest reader with a search's steps, Category and Remind me give their place.
- **List's page:** Back and the steps on the column, Back named at every width; the column is 12rem wider there (the body keeps its 35 em measure).
- **HTML mail in "Match theme":** designed means a surface or a hue (a background that isn't a white page, a picture behind, hued text, drawn art, a color set `!important`); greys on white take the theme's ink, quiet ink and page, links its link. Always paper is untouched.
- **The subject is never half cut:** the context line shows as soon as the subject's top edge goes under the toolbar, with a fade beneath it. A narrow reader's subject is 20 px.
- **Search:** "Match 1 of 3" and its steps sit in the toolbar, so the conversation doesn't move down for them.
- **Also:** a conversation's only message never folds and has a plain header; reader avatars follow the list's person rule (your own messages and people's are initials, never a company logo); Expand all carries the "N more messages" glyph.

Not taken: dimming the toolbar's Reply while a draft is open (it goes to the draft), a darker paper for designed mail in dark (a palette token, the lead's).

**What the two Codex reviews changed:** `!important` inline colors stay on paper; the full-message view's sections are themed too; a thread reduced to one folded message opens it; sub-pixel and taller-than-the-view subjects show the context line; the narrowest reader with a search keeps Forward on the column; SVG mail stays on paper; the lone message's header isn't a button. Found while testing: `background:#fff` (a shorthand) reported its image as `initial` and counted as designed; aspect-square items in a stretched group were measured at their icon's width.

## Second pass: the row menu, the palette, selection and undo, search

Decisions of the second pass in this area, and why:

- **Row menu:** Reply, Reply all, Forward; Archive, Delete, Mark unread, Star; Remind me, Move to, Category; More. More is flat under small labels (Similar mail, From *name*). A row with several answers unfolds them in place (`Unfolding`), so nothing is three levels deep. It also keeps the panel short, and offers are only read once asked for. Menu rows are 28 px. A row that isn't the open one is outlined and says itself in a caption (and in the menu's accessible name).
- **Palette:** aliases hold the app's own words (compose, search, preferences…); an alias shows only when it's why the row matched. The panel hugs its results with the field in place. With nothing named outright, "Search mail for …" leads, then real conversations from `threads.search`, asked once typing rests (120 ms) and held at 57k threads in both stores (`search-everywhere.perf.test.ts`, `idb/workloads.perf.test.ts`). Spam and Trash aren't offered there; a search asked for by hand still looks in them.
- **Offers:** a sentence that says what it does ("Archive 5 more from Xataka"), with the mail's own subject rather than a rule's `#`, and a list by name rather than its id. The digit is the line's shortcut, at its end.
- **Selection:** every checked row has the open row's fill and ink, the check in the unread dot's slot. Among several, a cursor outside them only shows where it is, and an outline marks it only after j/k (`data-keyed`). The pane holds Remind me, the menu's order, and lists what's selected. List's toolbar lies over the title line, which goes inert, so no row moves under a ⌘-click.
- **Search:** focused and empty, it says what it understands and what it looks through. An operator waiting for its value asks for nothing. A result opens at its match: marks in plain text through React, in a frame through its DOM (bounded, removed exactly, nothing past the frame's clip counted), the reader scrolled to it (the frame never scrolls), with a count and ⌘G / ⇧⌘G. A folded message or quote holding the only match opens. The base catalog's Pagination is page-based and wordy, so the steps are the reader's own icon buttons, as StepButtons are.

**The undo toast stays over the list:** the list already keeps room under its last row and brings the open row clear of the dock (`thread-list.tsx`), which is what was asked; docking it in the layout would resize the list on every action.

**What the two Codex reviews changed:** a palette row opens among its own results, with nothing left selected, the composer stepping aside, Review left and the list's filter applied to what's offered; marks hold their bound inside one long text node and go with a folded message; ⌘G works with focus in the mail; nothing is counted past a frame's clip; the one in hand survives folding what's before it; entities and block boundaries are read as they're drawn; a link's text is marked; what's under List's toolbar can't take focus; Esc works from the help rows.

## Third pass: shortcuts, the palette, search, the row menu and undo

- **One notation.** `Shortcut` is the only drawing of a key: one keycap per press, modifiers in Apple's order (⇧⌘U, never ⌘⇧U or three caps), `Ctrl+Shift+U` off the Mac, "then" between two presses. Menus, the palette, tooltips, the selection pane, the reader's menus and the sheet all use it; the palette's keys come from the bindings table (`shortcutsFor`), not hand-written strings. BOARDUI.md records the deviation (menu shortcuts as keycaps, not plain text).
- **Palette.** One conversation in hand heads its actions by subject and sender (sticky, so it stays while scrolling); Archive is "Archive" as everywhere; Delete is red as in the menus; Star and read marks from the palette say so in the dock; a family of presets a query only brushes ("reply" and the four "if no reply" times) shows its best one. In dark the panel has an edge (a scrim can't darken a near-black window).
- **Search.** No results answer in the list, under the field: for what, the operators (a row puts the failed words to use: `from:pago`, `pago has:attachment`, `"pago"`), and what's looked through. The reader no longer floats a help sheet. New message keeps its words in a search; in the compact title row the count goes under the field at 12 px. The list counts conversations; the reader says "Match 1 of 3".
- **No search on the server.** Plan 69 ruled provider-side search out, and it stays out. What the help says stays honest: only mail saved in Terno is searched, and the provider's website has the rest.
- **Row menu.** A row the reader isn't on is named in two lines (sender, the whole subject up to two lines) under which a hairline starts the actions; what's done to that row is said in the dock.
- **Undo.** It says it worked: "Restored 3 conversations" for what took mail out of a place, "Undone · 3 conversations" for a mark, 2.5 s. In List the dock's fade spans the list, the card where Split's column has it.

### What the two Codex reviews changed (third pass)

- A "Restored" that came late pushed a newer action's Undo out of the dock: it now waits behind anything said since Undo was asked for (read when it's asked, before the action's own answer).
- A search with no results lost its spoken count: the count stays a status, hidden on screen where the list says it.
- A place or date row typed the failed words after its colon (`in:pago`); several words, operators and quotes were dropped or doubled. Words a row can't hold go beside it, and a query with operators or quotes of its own is kept.
- A filtered search with no results had lost the help: it shows under the Clear filter button.
- The palette named a checked row over the open one's Print and Copy: it names only a conversation every action there acts on.
- The last hand-drawn keys (Enter in the AI row, R, C, /, the dock's Z) go through `Shortcut` and its formatter.


## The list, the sidebar, row states and toasts (fourth pass)

On round 3's ratings (`e48f0f309`), with the owner's decisions:

- **Toasts never cover the work.** Split's dock is in the reader pane, on the reader's column, at its foot; the reader's end scrolls clear of it, and the rows keep their room. List's stays over its one pane (on the column while a page shows), standing on the drafts strip, and the list keeps scroll room under its rows. A plain confirmation (no action, no body of its own) goes as soon as the list's identity (`listKey`) changes; one with Undo keeps its time. A hover holds only the snack it was over: Undo's "Restored" under a resting pointer runs out, and moving over it holds it again. This reverses the third pass's "the undo toast stays over the list".
- **One selection language.** One fill for open, checked and List's cursor (List's cursor was an outline). The fill starts 4 px in (wider than the search field's, as AGENTS allows), leaving a column 12 px in for the marks: the open row's rail, the unread dot, the check (12 px). One mark at a time: a checked row shows its check, the open row its rail. The focus ring outlines what keys or a menu act on (j/k among several, the menu's row); the open row keeps its fill and rail while a menu is up (the third pass emptied it). A new message in the reader leaves no half-open row (fill and rail go).
- **Where you are.** No sidebar row is current during a search. The Review line is a 24 px place with its own highlight. A search typed in Review (or picked from the field's help) is a search of everything; Esc or an emptied field comes back to that Review, and Esc there leaves it for its category. Under 25rem macOS's New message is its icon, so the title is never cut ("In…").
- **Chrome.** Lumen's line under the title says only what acts: each count is its filter (Unread, Waiting); the greeting went. The rule offer's × hushes offers for the session (sessionStorage), and a made rule does too (Undo brings it back); "never" stays in Rules. A parked draft in the strip carries the rows' Draft tag and ink.
- **Unread.** Two weight steps in sender and subject in macOS, Atelier and Luma (as Lumen), an 8 px dot, and an unread row's date medium in the ink. Graphite keeps its ladder (one weight above), with the dot and the date.
- **The same in both layouts.** A filter behind More filters is named where the place is (the title's suffix; beside its control under List's tabs). A narrow List row keeps its category's name; the account column goes first. Not taken: dropping List's category tabs, which plan 24's request asks for verbatim (Split's column can't hold them); multi-select stays a panel in Split and a toolbar in List (List has no pane for it).
- **What the Codex reviews changed:** the field's help rows and Lumen's close-search bypassed the Review-aware query; a checked open row drew its rail through its check; the pinned card didn't re-measure when List's page moved the dock, and didn't stand on the strip the dock stands on; a confirmation survived a change of search scope or a preview.
