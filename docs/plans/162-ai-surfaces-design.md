# Plan 162: one design for the AI surfaces

- **Status:** spec; built on the branch `t3/ai-surfaces-redesign`, not merged. The owner decides whether it lands.
- **Builds on:** plan 161 (the AI rating, its four rounds and three passes), plans 131 to 157 (the AI features), 147 and 150 (the one gate), 158 (the rating), 159 and 160 (header copy, precision tokens and the contrast suite).

## The request

> start in a new worktree a redesign pass to reach a 9 score. Do that design pass across all the AI surfaces, and then rerate it until you get to 9. Do it in a worktree and do not merge it into main unless I tell you to. You can iterate maximum 3 rounds on that; get to 9 or more.

One designer, one spec, written before any code, then built against it. The lead runs the rated rounds on this branch; this plan never sees a score before it's written down.

## Where things stand

Four rounds (`ai-r00` to `ai-r03`), three fix passes, each split across three engineers. Every rater ended at 7 to 7.5 overall; no screen reached 9 from both raters. Ask and actions are closest (7.5 to 8.5); Today and AI settings are lowest (6.5 to 7). The one high issue of ai-r03 (the digest didn't scroll) is fixed on main.

### What holds every screen below 9

Read across all eight ai-r03 reports and every below-9 reason, with ai-r00 to ai-r02 for what kept coming back:

1. **Control weight doesn't follow importance.** The same kind of control is drawn three ways, and the heaviest one is often the least important:
   - the summary's **Copy** is the only bordered button on the card, so it outranks **Reply**, the step the summary recommends (six of eight reports);
   - ⌘J's **Undo** is a pill, and Regenerate, Shorter and Warmer are bare text until hovered (five reports);
   - Writing style's **Edit** and **Reset** are bare text beside outlined **Count again** and **Study my style…**, and **Clear all** is a red link: three idioms on one page (four reports);
   - the AI filter makes **Save and apply to 66 conversations**, the step that changes old mail, the primary (three reports).
2. **Layouts break at 1100x700.** ⌘J's **Edit** wraps alone under the instruction and the strip takes about 100 px (all eight reports). The summary item's Reply and source wrap under the text with nothing to align to (four reports).
3. **The same thing is said differently.** Provenance is a control on six surfaces but a static title on the AI filter and absent on the action preview. AI errors are three patterns (the shared notice in the summary and ⌘J; Ask's red sentence; the digest's own block). Dates come in four shapes, sometimes in one panel (Ask: "3:27 PM", "Jul 14", "back to Apr 25", "Thu, Oct 22, 2026, 4:00 PM"). The digest offers two undos for one archive.
4. **Esc and focus.** Esc on Ask opened with ⇧⌘K goes to All commands, so closing takes two presses. The action preview's hints say Esc two ways. Focus drops after the digest's Archive, after the action's Cancel, and after ⌘J's Undo.
5. **Today doesn't say why.** The reason a row needs you is a grey prefix of the snippet; "The newest 12 of 41 that need you · More in To reply to" reads as a folder called "More in"; the digest page leads with Archive, its date says nothing of what it covers, and it can't clear or restore the ticks at once.
6. **Settings explain machinery.** Writing style's precedence sentence, "Count again", and how studying continues after it starts. The filter hides the user's request, and the preview shows 6 of 66 without saying so.
7. **Smaller, recurring:** "hasn't replied yet" the minute a mail is sent; Reschedule has only four presets; the digest header's stray "·"; the Undo snack after an action is generic.

### What the raters already like (keep it)

Every report's strengths, and the facets at 8 or more:

- **Inspectable before acting:** the action preview's quoted request, "Terno read it as", rows with ticks, the live count, Apply disabled while finding, and Undo after (praised in all eight).
- **Evidence:** Ask's numbered citations, the passage with its match highlighted, Back to the answer, the scope line (all eight).
- **Gaps handed to the user:** Reply ready's "1 gap to fill", the gap marked, and selected after Use (seven).
- **Inline, stoppable work:** "Writing… Esc to stop", the rewrite dimming the old draft, Stop on the summary (six).
- **Honest copy and restraint:** no gradients or AI colour, "It can make mistakes", "From the conversation alone…" (five).
- **Contrast:** 8 to 8.8 from Codex in every style; grey meta at 5.3 to 8:1.

This plan changes presentation and flow. It doesn't touch what those strengths rest on.

## The shared system

Every AI surface is built from these parts, and a surface that needs something else says why below.

### 1. Where AI text lives

- **On the AI card** (`AI_CARD`) when AI text sits among the user's mail in the reader: the summary, Reply ready, the follow-up. The card is what says "a model wrote this, not the sender" (owner's rule).
- **On its own surface** when the whole surface is the AI's: Ask (the palette), the action preview (the list header and the reader's rule panel), the digest page, the AI box in Rules, Writing style. A card inside these would be a box in a box.
- **In the user's draft** for ⌘J: the strip sits in the composer's form as one of its rows (To, Subject, AI), never a card, since the draft is the user's.

### 2. One anatomy

Every surface reads top to bottom in the same order:

1. **Header:** a glyph (Sparkles; the spinner while it works; Clock for a follow-up), a title in the ink, then its facts in the secondary, split by "·" with no leading or trailing "·".
2. **Body:** `text-sm` at the mail's measure (`--read-max`). AI text is plain text, never HTML.
3. **Action row** (`AI_ACTIONS`): commands at 28 px (`size="sm"`), in tier order (below), and **the provenance control always at the row's end**. Nothing else sits right of it.

A surface whose header is a button (the summary's disclosure) has nothing else in its header.

### 3. Three tiers of controls

One ladder on every AI surface. A surface uses each tier at most once per row, in this order:

| Tier | Look | Where it's used |
|---|---|---|
| **Primary** | BoardUI primary (filled) | Only where the AI prepared something for the user to commit: **Use as draft**, **Draft a nudge** (or **Done**), the action's **Archive 6**, the digest's **Archive 16**, the filter's **Save**. Reading surfaces (the summary, an Ask answer, ⌘J's strip) have none: the text, and the draft's Send, lead. |
| **Secondary** | BoardUI secondary (`outline`) | The next step a reading surface recommends (the summary item's **Reply**), the alternatives beside a primary (**Dismiss**, **Reschedule ▾**, **Save and apply to 66**), and a settings row's own commands (**Edit**, **Reset**, **Refresh from sent mail**, **Study my style…**). |
| **Quiet** | `ghost`, its glyph and word, muted until hovered | Utilities that don't change mail: **Copy**, **Answer again**, sources ("Arjun's message, Yesterday →"), **Edit** (an instruction or a request), and the provenance control. |

⌘J's commands (Undo, Regenerate, Shorter, Warmer) are one control: a **button group** (BoardUI's, as the reader's Reply and Forward are), at 28 px. One chrome for all four, so none outranks another and none is bare text.

### 4. One provenance control

`AiProvenance` ("Written with AI ▾"), at the end of the action row, on every surface where a model wrote or chose something:

| Surface | Label | What it opens |
|---|---|---|
| Summary, Ask's answer, Reply ready, ⌘J's strip, the digest | Written with AI | what it used (voice, what it read), then "Written by {model}, {date}. It can make mistakes." |
| ⌘J after an edit or a stop | Edited after AI, Stopped part-way | the same |
| Follow-up | Found with AI | "Found by {model} in mail you sent, {date}." |
| **Action preview** (new) | Written with AI | "It read your request as the rule above. Check it before you apply." and the model |
| **AI filter** (now a title) | Written with AI | the same as the action preview |

Nothing the AI didn't do carries it: Today's "Needs you" is chosen by rules (plan 145), so it has no AI mark, and its reasons say why in plain words.

### 5. One Copy, one error, one date

- **Copy** (`AiCopyButton`) is quiet: `ghost`, Copy's glyph and word, "Copied" with a check for 1.5 s, announced. Everywhere (summary, Ask).
- **Errors** are `AiErrorNotice` everywhere: what happened in the ink, one line of what to do, then **Try again** (secondary) and **AI settings** (quiet) when the fix is there. Never an address. Ask's red sentence and the digest's own block move to it; so do the action check's and the AI filter's.
- **Dates:** two shapes only.
  - In a row or a list: `listDate` ("3:27 PM", "Yesterday", "Oct 20", "Jul 14, 2025").
  - In a sentence: `whenDate` (new, in `lib/format`): "Wed, Oct 28, 9:00 AM", with the year only when it isn't this one. The provenance popover, the follow-up's "Comes back…", the digest's coverage line and Ask's scope use it. `fullDate` is no longer used on AI surfaces.

### 6. Esc and focus: one rule

**Esc steps back one level, and focus returns to where it came from.** Never two levels, never to `<body>`.

| Where | Esc | Focus after |
|---|---|---|
| Any AI popover or menu (provenance, Reschedule, Rewrite) | closes it | its trigger |
| Ask, opened with ⇧⌘K | while it answers: stops. Then: closes Ask | where it was before ⇧⌘K |
| Ask, opened from the palette's row | while it answers: stops. Then: back to All commands | the palette's input |
| Ask, a source shown | back to the answer | the source's row |
| ⌘J while writing | stops, keeping what came (pass 3) | the AI row |
| ⌘J's field | closes the row | the draft's body |
| ⌘J's **Undo** (strip or snack) | n/a | the draft's body, at the end of what came back |
| The action preview, a conversation open | back to the preview | that conversation's row |
| The action preview | cancels it | the list row the cursor was on before |
| After Apply, Cancel or the digest's Archive | n/a | the list (the next row), or the digest's next row |

Only Ask's entry changes behaviour here: it remembers how it was opened (`usePalettePage`'s `entry`). Everything else is focus that was dropped.

### 7. What a screen reader hears

One polite status region per surface. It says when work starts ("Writing…", "Summarizing…", "Preparing a reply…") and when it ends ("Draft written", "Summary ready", "Reply ready"), never the words as they stream. Errors are `role="alert"` (the shared notice already is). Unchanged where it already holds this; the digest's Archive and the action's Apply add "Archived 16 newsletters" to their region (they relied on the snack's).

### 8. The small window

At 1100x700 nothing wraps alone and nothing is cut mid-word:
- a one-line field of AI or user text truncates with an ellipsis, its full text in its accessible name and tooltip, and its command stays inline after it (⌘J's instruction and Edit);
- a row of controls under text sits on its own line starting at the text's left edge, at every width, so it's the same shape at 1440 and 1100 (summary items);
- ⌘J's four commands fold into **Undo** and **Rewrite ▾** in one group under 30 rem.

### 9. Type, spacing and size

No new tokens. Every surface uses:
- titles `text-sm font-medium` in the ink (a page's title is its page's: `PANE_TITLE`, the dialog's);
- body `text-sm`, AI text `leading-relaxed` where it's read (summary, answer, reply);
- meta and hints `text-xs` in `muted-foreground`, never smaller, never lighter;
- 28 px controls in rows, 24 px hit areas at least for marks (citations, ticks);
- card padding `px-3.5`, row gap `gap-2`, the action row `mt-3` under a body, `mt-2` under items.

## Copy

**Voice:** plain, short, about the user's mail, never about the machinery. Present tense for state ("Waiting for Arjun's reply"), past for results ("Archived 6 conversations"). No "AI" in a sentence where the provenance control already says it.

**One set of verbs:**

| Means | Word | Not |
|---|---|---|
| ask the model again for the same thing | **Regenerate** (⌘J), **Answer again** (Ask) | Try again (that's for errors only) |
| after an error | **Try again** | Retry |
| take back the AI's change | **Undo** | Revert, Restore |
| put AI text into the draft | **Use as draft** | Insert |
| change what you asked | **Edit** (named "Edit instruction", "Edit request") | Change |
| stop a model while it works | **Stop** | Cancel |
| leave without changing mail | **Cancel** (a preview), **Dismiss** (a suggestion) | Close, Skip |

**Changed strings** (en and es together):

| Where | Was | Now |
|---|---|---|
| Today's header | The newest 12 of 41 that need you · More in To reply to | Showing 12 of 41 · See all in **To reply to** |
| Today, reason | New from a contact | (the same words, as a label of their own, below) |
| Follow-up, under a day | Arjun Ramírez hasn't replied yet | Waiting for Arjun's reply |
| Digest, under the title | Thursday, October 22 (beside the provenance) | 16 unread newsletters since Mon, Oct 19 |
| Action preview help | Click a conversation to read it. Esc brings you back here. | Click a conversation to read it. |
| Action, after Apply | Archived 6 conversations | Archived 6 conversations, with the request under it: “Archive shipping notices older than a month” |
| AI filter, its box title | Written with AI (a title) | From your request: “archive receipts from uber.com” |
| AI filter, the preview | Matches 66 conversations | Matches 66 conversations · the newest 6 shown |
| Writing style, precedence | Drafts follow your style with that person, else with their company, else in that account, else your usual one. | A draft uses the closest style it has: **the person**, then **their company**, then **the account**, then **yours**. |
| Writing style, maintenance | Count again | Refresh from sent mail |
| Writing style, studying | Notes on your tone, by AI … | adds before the button: "It looks again, a few at a time, as you send more. Clear all stops it." |

## Each surface

Each part says the container, header, provenance, body, actions, states, the small window and the modes. "As now" means kept on purpose.

### Summary (`a01`, `a01-small`)

- **Container:** the AI card, between the conversation's header and its first message. As now.
- **Header:** the disclosure, "✦ Summary", nothing else (it's a button).
- **Body:** the paragraph at the measure; then the items as a two-column grid: the kind ("Action", "Question", "Date", "Decision") in `text-xs` muted in a column as wide as its longest word, the text in the ink. **Under each item's text, on its own line starting at the text's edge:** **Reply** (secondary, Reply's glyph; only on an action or a question) and the source (quiet: "Arjun's message, Yesterday →"). Same shape at 1440 and 1100.
- **Action row:** **Copy** (quiet) … **Written with AI ▾**.
- **States:** working: "✦ Summarizing…" with Stop (quiet) on the card's header line, as now; waiting for the body; consent (Continue secondary, Settings quiet); no provider; error (the shared notice); stopped: the card goes, the toolbar's Summarize is back. As now apart from the tiers.
- **Light and dark:** the card's fill and ring (pass 3); Reply's border is the secondary's.
- **Answers:** Copy outranks Reply (Lumen, macOS, Graphite claude; codex low ×4), the item row breaking at 1100 (macOS claude 6, Graphite claude 6.5, Lumen claude medium, Graphite codex low), three control styles in one card (Graphite claude 6.5).

### ⌘J: the prompt, writing, written (`a02`, `a03`, both `-small`)

- **Container:** the AI row in the draft's form, labelled "AI" like To and Subject. As now.
- **Prompt (`a02`):** the field, its placeholder, and **Write** (secondary) at its end. As now.
- **Writing:** the instruction line (below), then "Writing… Esc to stop" with Stop (quiet). As now.
- **Written (`a03`):**
  - Line 1, the **instruction**: “friday works for me, ask him to send the address of the flat” on **one line**, truncated with an ellipsis when it doesn't fit, its whole text in its tooltip; **Edit** (quiet, named "Edit instruction") right after it, never on a line of its own.
  - Line 2, the **commands**: one button group, **↶ Undo | Regenerate | Shorter | Warmer**, at 28 px; under 30 rem, **↶ Undo | Rewrite ▾**. Then **Written with AI ▾** at the end.
  - The draft: as the AI left it, with gaps marked.
- **Undo:** after it, focus is in the body at the end of the text that came back (it went to `<body>`).
- **Stopped, error, guards:** as pass 3 built them; the error is the shared notice.
- **Small:** two lines of 38 px (it was about 100 px with Edit wrapping).
- **Answers:** the strip at 1100 (all eight reports: Edit orphaned, three lines, too tall), Undo heavier than its siblings and bare-text rewrites (five), focus lost after Undo (macOS codex medium).

### Ask (`a04`, `a04-small`)

- **Container:** the palette's Ask page. As now.
- **Header:** ✦ and the question; at its end **‹ All commands** only when Ask was opened from the palette, and ×. Opened with ⇧⌘K, the header has the question and × only, and Esc closes.
- **Body:** the answer at `text-sm leading-relaxed`, citations as numbered marks with 24 px targets (pass 1); the scope line, "Searched mail on this Mac back to Apr 25 · Search older mail on your servers", its date as `listDate`.
- **Action row:** **Copy** (quiet) and **Answer again** (quiet, its glyph) … **Written with AI ▾**. Both were outlined at 24 px; now the same 28 px quiet as the summary's Copy.
- **Sources:** the palette's rows: the number's mark, sender, subject, `listDate`. As now.
- **Evidence:** the passage, highlighted, with Back to the answer and Open message. As now.
- **History:** New question and Previous questions, quiet, at the end of the keys' line. As now.
- **Keys' line:** ↵ Ask, ↓ Sources, esc Close (from ⇧⌘K) or esc All commands (from the palette); while answering, esc Stop.
- **Error:** the shared notice, with Try again and AI settings.
- **Answers:** two presses to close (Graphite claude low), the footer's repeated destination (four reports, low), one error style (Atelier claude medium), dates in several shapes (Lumen claude medium), Ask's buttons a different idiom from the summary's.

### Actions: the preview and its undo (`a05`, `a05-small`, `a06`)

- **Container:** the list header (title, request, Cancel and Apply) and, in Split, the reader's rule panel. As now (praised in all eight).
- **Rule panel:** title "Archive 6 conversations", the request quoted, "Terno read it as", the rows, Exact pattern; then an **action row**: **Edit as a rule** (quiet) … **Written with AI ▾** (new: "It read your request as the rule above…" and the model, when the plan carries one).
- **Keys:** one line, ⌘↩ Archive 6 · esc Cancel · x Leave out. The help line keeps only "Click a conversation to read it." Reading a conversation, the list header's Cancel becomes "Back to the preview" with its esc keycap, so Esc is said once where it applies.
- **x:** acts on the list's cursor row whenever the preview has the keys; when the preview is ready, the cursor is on the first row (it had none, so x did nothing).
- **After Apply (`a06`):** the snack says the result and, under it, the request in quotes; Undo with ⌘Z. Focus goes to the list.
- **After Cancel:** focus on the row the cursor was on before the preview.
- **Answers:** no provenance on the one AI feature that changes many messages (Lumen claude medium), Esc said two ways (Atelier claude medium, Graphite claude medium), X needing a focused row (Atelier claude medium, macOS claude low, Lumen claude medium), the generic snack (macOS claude medium, Lumen claude), focus lost after Cancel (Atelier claude low).

### Today and the digest (`a07`, `a08`)

- **Today's header:** "Showing 12 of 41 · See all in **To reply to**" (the filter's name is the link). The 12-row cap stays (owner).
- **A row's reason:** its own label at the start of the second line, `text-xs font-medium` in the ink ("Your turn", "New from a contact", "No reply from Arjun in 2 days"), then the snippet in the secondary. It was a grey prefix of the grey snippet.
- **The digest row:** as now.
- **Digest page header** (sticky at the top of its pane, on the page's background, with a hairline once the list has scrolled under it):
  - title "Today's digest"; under it, the coverage: "16 unread newsletters since Mon, Oct 19" (from the items' dates; the digest's window is plan 145's);
  - the action row: **Archive 16** (primary), **Untick all** / **Tick all** (quiet; whichever applies), the count ("16 to archive · 1 stays in Inbox") … **Written with AI ▾**;
  - the tick hint under it, as now.
  The day and its stray "·" leave the title's line.
- **After Archive:** the page says "Archived 16 newsletters." as now; the **snack** holds the Undo (as every other archive in the app); the page's own Undo button goes. Focus goes to the first row still there, else the page's heading.
- **Error:** the shared notice, Try again.
- **Answers:** reasons buried in the snippet (Atelier claude 6.5, Lumen claude 6, Graphite claude 6, macOS claude medium), the header's copy (Atelier claude 6.5), Archive scrolling away (Graphite codex 6, Lumen claude), no reset of the ticks (Atelier codex medium), the coverage (Lumen codex low, macOS codex medium), the stray separator (Atelier, Graphite claude low), two undos (macOS claude low), focus after Archive (Graphite claude 6).

### Follow-ups (`a09`) and Reply ready (`a10`)

Both on the AI card, one anatomy (pass 3), kept:

- **Follow-up header:** Clock, then the fact in the ink at `text-sm`: "Waiting for Arjun's reply" on its first day, "Arjun hasn't replied in 2 days" after. A promise: "You told Arjun you'd send the contract".
- **Body:** "Comes back to your Inbox Wed, Oct 28, 9:00 AM if there's no reply" (`whenDate`).
- **Action row:** **Draft a nudge** (primary), **Reschedule ▾** (secondary), **Dismiss** (secondary), the source (quiet) … **Found with AI ▾**.
- **Reschedule ▾:** the four presets with their times, a separator, then **Pick date & time…**, which opens the reminder's own date and time fields (`WhenFields`, plan 87) in the menu's place, with **Reschedule** to confirm. No new picker.
- **Reply ready header:** "✦ Reply ready · 1 gap to fill · To Liam Taylor". Body: the draft with gaps marked. Row: **Use as draft** (primary), **Dismiss** (secondary), "Press R to reply with this draft" … **Written with AI ▾**. As now.
- **Writing a reply:** the card holds its place with skeleton lines under "Writing a reply…" and Stop (secondary), as now.
- **Answers:** "hasn't replied" the minute you send (Lumen claude low), Reschedule's four presets (every codex report, medium), and both surfaces keep the anatomy all raters praised.

### Create a filter with AI (`a11`)

- **Container:** the Rules dialog. Its AI box stays a tint card on the dialog's surface (it's the AI's part of a form the user owns).
- **Header:** "✦ From your request: “archive receipts from uber.com”" (the request, quoted, so it's checkable), **Edit request** (quiet) at its end.
- **Body:** the rule in words ("Domain is “uber.com” → archive"), or the gap warning (pass 1). The model's words aren't shown (pass 1).
- **Action row of the box:** … **Written with AI ▾** at its end.
- **Preview:** "Matches 66 conversations · the newest 6 shown".
- **Footer:** **Save** (primary), **Save and apply to 66 conversations** (secondary). It was the reverse.
- **Error:** the shared notice.
- **Answers:** the static provenance (Graphite claude 6, macOS claude low), the hidden request (Lumen claude low), apply as primary (macOS codex medium, Graphite claude medium), 6 of 66 unexplained (macOS claude 6 and medium).

### Writing style (`a12`)

- **Container:** Settings → AI → Writing style. As now (title, back button, status first, one profile at a time, sticky Save in the editor).
- **Status:** "Learned from 181 messages you sent, on this Mac. Updated today."
- **Precedence:** "A draft uses the closest style it has: **the person**, then **their company**, then **the account**, then **yours**." The four words in the ink.
- **The profile card:** its lines as now; its row: **Edit** and **Reset** as secondaries (Reset keeps its in-page Undo).
- **How it learns:** "Habits from your sent mail" with **Refresh from sent mail** (secondary); "Notes on your tone" with its continuing behaviour said before **Study my style…** (secondary); **Clear all** as a secondary with the destructive ink (a button, not a link).
- **Answers:** three button idioms (Atelier claude 6.5, macOS claude 6 and low, Graphite claude 6), the copy (every report: medium or low), studying explained after the fact (Atelier codex 6.5 and medium).

## What I deliberately won't do

- **Citations in the summary's paragraph** (Lumen and Atelier codex, medium). The summary task returns a paragraph and items; only the items cite a message. Marking sentences would mean a new output from the model, which the owner's rule rules out. The items' sources are the evidence.
- **A key for Use as draft, Summarize, Shorter, or Nudge** (several reports). The owner's rule: no new AI shortcuts.
- **Show all 41 in Today** (three codex reports). Today shows 12 (owner); the link goes to all of them.
- **Grouping the digest by topic, or leading with summaries over the batch** (Lumen claude). The digest is a list of normal emails with a line each (owner); its action is archiving them.
- **Highlighting the matched words in the action preview's rows** (two codex reports, low). The plan's conditions are matched in the backend; the preview row doesn't know which word matched. It would need a new query result in both stores. Out of scope for a presentation pass; listed for later.
- **"Show all 66" in the AI filter's preview** (two reports). `filters.preview` returns six; the line now says so. Paging it is a backend change for later.
- **A "Preparing a reply…" placeholder before the backend starts** (two reports). Reply ready shows from the moment the backend starts writing (pass 2); before that the app doesn't know a reply will come.
- **Moving the follow-up's first tip** (Lumen claude, Graphite claude, low). Tips are the plan 113 base, shared by every tip; out of scope here.
- **Stronger focus rings** (Graphite claude). The ring is app-wide (plan 54) and rated with the everyday set; changing it here would change every everyday screen.
- **New behaviour of any AI task, a new model call, or anything under `scripts/ui-rating/` or `packages/mock-data`.**

## Tests

- **Unit:** `whenDate`; the summary item's layout data; the strip's instruction truncation; the palette's entry (Esc closes from ⇧⌘K, goes back from the palette); the digest's coverage line and Tick all / Untick all; the follow-up's title by age; the filter's request quoted; the action snack's description.
- **e2e:**
  - `summaries` (Reply is the secondary, Copy quiet; the item's controls on their own line at 1440 and 1100, starting at the text's edge);
  - `ai-draft` (the instruction on one line with Edit inline at 1100 and 1440; the group's four commands and Rewrite ▾; focus in the body after Undo; Writing style's buttons are secondaries; the copy);
  - `ask` (Esc from ⇧⌘K closes in one press; from the palette, goes back; the shared error);
  - `plain-actions` (x on the first row without a click; one Esc hint; the snack's request; focus after Cancel; the provenance);
  - `today` (the header's copy and link; the reason's label; the sticky Archive at the bottom of a long digest at 1100x700; Tick all / Untick all; one undo; focus after Archive);
  - `followups` (the title by age; Pick date & time… reschedules; its menu unclipped);
  - `replies-ready` (unchanged anatomy);
  - `filters` (Save primary; the request quoted; the provenance popover; "the newest 6 shown").
- **Every AI menu and popover unclipped,** in every design, light and dark, 1440 and 1100: Reschedule, Rewrite, every provenance popover, the action's Exact pattern (`scrollWidth <= clientWidth` for each item's text, the panel inside the window).
- **Every AI pane reachable by the wheel at 1100x700:** the digest, Ask's area, the rule panel, Writing style, the Rules dialog.
- **`design-axe`:** the summary, the strip, Ask, the preview, the digest, the follow-up, Reply ready, the AI filter and Writing style, in Lumen and Atelier, light and dark.
- **`contrast.test.ts`:** unchanged pairs; any new text sits on an existing pair.
- **Perf:** `pnpm test:ui-perf`; nothing here is on a list's hot path, and the digest's sticky header adds no observer.
- **The frozen capture** reaches every state in Lumen, Atelier, macOS and Graphite, light and dark.
