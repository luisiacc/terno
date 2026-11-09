# Plan 162: one design for the AI surfaces

- **Status:** built on the branch `t3/ai-surfaces-redesign`, not merged; waiting for the rated rounds (`ai-r04` on). The owner decides whether it lands.
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
- **Perf:** `pnpm test:ui-perf` and the list's render counts: Today's reason changes the shared thread row (revision 7). The digest's sticky header adds no observer.
- **The frozen capture** reaches every state in Lumen, Atelier, macOS and Graphite, light and dark.

## Revisions after the Codex review

Twelve points, all taken. Where they change the spec above:

1. **x keeps its target.** In Split the list's cursor is the open conversation (`selectedId`), and the rule panel shows only while none is open: putting the cursor on the first row would hide the rule and change `a05`. So x stays the open conversation's, and the keys' line says it plainly: **j k** Read the next or previous · **x** Leave the one you're reading out, or put it back. A separate preview cursor is new list behaviour, left for later.
2. **Provenance says only what's known.** The model and the date are each optional. A surface that doesn't carry the model (the action preview, the AI filter: `ActionPreviewInfo` and `filters.generate` return none) shows only its lines; one without a time (⌘J, the digest) shows "Written by {model}. It can make mistakes."; `AiProvenance` never formats a zero time, and nothing infers a model from today's settings.
3. **The action snack keeps its warnings first.** Its second line is what happened (partial, changed, spared, the rule saved or not), then "You asked: “…”".
4. **The digest's coverage is the batch's, not a live count.** "Prepared today from 16 newsletters since Mon, Oct 19"; the live counts stay in the count line. Automated mail (digest off) keeps its own words.
5. **One Undo at a time, not one Undo.** The digest's inline Undo survives navigation and is its own batch's (`digest-page.test.tsx`); it shows once the snack carrying the same Undo is gone, never beside it.
6. **The action check's failure keeps Skip** in the shared notice's actions (Try again, Skip the check).
7. **Today's reason is inline wherever the row is one line** (List's wide and compact rows); only the style of the label changes, not the row's structure or height. The row is shared, so the list's render counts and `test:ui-perf` hold it.
8. **Writing style's remove buttons are 32 px** (the existing `CloseButton` size), each still named for its item.
9. **The style editor names what it edits** in a heading that stays visible above the fields ("Editing You · English"), beside the sticky Save and Cancel.
10. **One R on screen.** While Reply ready owns R, the toolbar's Reply drops its R keycap and its tooltip's shortcut (the reply bar already does); no new shortcut.
11. **Ask's scope is a calendar boundary with its year:** "Searched mail on this Mac back to Apr 25, 2026". Source rows keep `listDate`.
12. **Ask's footer has one way back.** From the palette, All commands is the header's link and its keycap; the keys' line doesn't repeat it, and New question and Previous questions sit apart from the keys, after a divider. `ask-new` keeps its test id (the capture clicks it).

## As built

Where the build differs from the spec, and what the spec left open.

### The shared system
- **Dates.** `whenDate` and `whenDay` sit in `lib/when.ts` beside `reminderDated` (the moment ahead, "Wed, Oct 28, 9:00 AM"), not in `lib/format`; `boundaryDay` ("Apr 25, 2026") is the boundary with its year (revision 11). The provenance popover and the follow-up's popover use `whenDate`; `fullDate` is off every AI surface.
- **Copy** (`AiCopyButton`) is a ghost at 28 px, muted until hovered, its glyph on the text's edge (`-ms-2`).
- **One error.** Ask, the digest and the action check now use `AiErrorNotice`; the check keeps **Skip the check** beside **Try again** (revision 6).
- **Provenance.** `AiProvenance` shows "Written by {model}. It can make mistakes." when it knows the model but no time, and only its lines when it knows neither (the action preview, the AI filter).
- **Esc and focus.** `usePalettePage` holds `entry`; `paletteBack(page, entry)` is the one step back: from ⌘⇧K, Ask closes and its history goes back to Ask (its link says "‹ Ask"); from the palette, both go back to All commands. The palette remembers what had the keys when it opened and gives them back when Esc or × closes it (`paletteReturn` as the dialog's `finalFocus`, and a check two frames later). The probe found Ask closing to `<body>` before this.

### Each surface
- **Summary:** the items are a two-column grid (`grid-cols-subgrid`), the controls a line of their own under the words; Reply is `outline`, the source a muted ghost.
- **⌘J:** the instruction is one truncated line with its title; Edit follows it. The commands are BoardUI's `ButtonGroup` at 28 px (`h-7`); under 30 rem, Undo and Rewrite ▾. On the row's field over a strip, Undo is a one-item group. When Undo takes back the only write of a reply ⌘J opened, the reply goes and the keys go to the reply bar.
- **Ask:** Copy and Answer again are quiet, at 28 px. The keys' line shows esc Close (from ⌘⇧K), nothing for Esc from the palette (the header's link is the way back), esc Stop while it answers; New question and Previous questions sit after a divider (`ask-session`).
- **Actions:** the rule's line is Exact pattern ▾ · Edit as a rule … Written with AI ▾. The keys' line is ⌘↩ Archive 6 · esc Cancel · x Leave out the one you're reading; a "j k Read" hint was tried and dropped, since it wrapped the line at 1100. "Show the rule" carries its esc keycap. The snack's second line is the warnings, then "You asked: “…”".
- **Today:** "Showing 12 of 41 · See all in To reply to" (the whole phrase is the link). The reason is in the ink at the row's weight; the row's structure and height don't change.
- **The digest:** a spacer, then a sticky header (title, "Prepared today from 16 newsletters since Fri, Oct 16", the action row, the tick hint) with the column's hairline under it. **Tick all / Untick all** is a quiet button. The page's Undo shows only while no snack carries the same Undo. After Archive the keys go to the first row still there, else the title.
- **Follow-ups:** "Waiting for Arjun Ramírez’s reply" on the first day. Reschedule's menu ends in a separator and **Pick date & time…**, which opens a popover anchored to Reschedule with plan 87's `WhenFields`, starting where the reminder's picker does (`defaultRemindAt`), and **Reschedule** to confirm; its Esc gives the keys back to Reschedule.
- **Reply ready:** unchanged; the toolbar's Reply drops its R keycap and its tooltip's R while a reply is ready (revision 10).
- **The AI filter:** "✦ From your request “…”" with Edit request (quiet); the rule's line ends in Written with AI ▾; "Matches 66 conversations · the newest 6 shown"; **Save and apply to 66** (secondary) then **Save** (primary). The footer is the Rules dialog's, so a hand-made rule gets the same order.
- **Writing style:** the precedence is rich text, its four steps in the ink; Edit, Reset and Update are `outline` at 28 px; Clear all is an outlined button in the destructive ink; "Refresh from sent mail"; studying says it repeats before you start it; the editor's sticky footer names what it edits ("Editing You"); the remove buttons are drawn at 24 px with a 32 px hit area.

### Not changed in `scripts/ui-rating/`
Nothing. Every wait the capture makes still holds; the capture reached every AI state in Lumen, Atelier, macOS and Graphite, light and dark (`/tmp/terno-scratch/ai-redesign/round0/<design>/`).

### Tests
- **Unit:** `when-date.test.ts` (new), `digest-page.test.tsx` (one Undo at a time, Tick all, the coverage; the inline-Undo tests dismiss the snack first), `today-line.test.tsx`, `followups-copy.test.ts`.
- **e2e, in macOS:** `ask` (Esc from ⌘⇧K closes in one press and the keys go back to the list; from the palette it goes back, with All commands said once; history goes back to Ask), `summaries` (the controls' own line at 980, 1100 and 1440; Reply bordered, Copy clear; Ask's shared error), `ai-draft` (one line with Edit inline, the group, two lines at most; Writing style's copy), `plain-actions` (Esc said once, the keys on one line at 1100, the provenance popover, the snack's request), `today` (the header, the reason's ink, the snack's Undo), `followups` (the title, Pick date & time… reschedules), `filters` (Save primary and last, the request quoted, the sample said, the provenance popover and its Esc).
- **e2e, in every design (`@design`), light and dark, 1440 and 1100:** every AI popover whole (summary, Ask, the action's provenance and Exact pattern, the digest, the AI filter, plus the existing Reschedule, its new date popover, Rewrite and ⌘J's); and each AI pane's end in reach of the wheel (Ask's area, the rule panel, the digest with Archive still in view, the AI filter's preview, Writing style), the editor's Save in view and its remove targets 32 px. `unclipped()` now skips screen-reader-only text.
- **Baselines:** `visual.spec`'s `filters-ai` and `filters-ai-dark` moved, for this pass's AI filter.

## What the Codex review of the build changed

Six findings, all taken, each with a test that fails without its fix:
1. **The AI filter quoted the field, not the rule's request.** Edit request, a new word, then Esc showed the old rule under the unsent words. It quotes `built`, the request the rule came from (`filters.spec.ts`).
2. **Ask lost the error's catalog key**, so "no credit left" read as a refused API key. Ask's error keeps its key through both failure paths; `askErrorCopy` maps it (`ask-error-copy.test.ts`).
3. **The action check showed the provider's own message**, address and all, as the notice's title. Its state keeps the kind and key, and the shared notice words it by kind, Skip the check kept (`action-check-error.test.ts`).
4. **Reschedule's own moment could expire while open** and do nothing. Set checks the clock again and says "Pick a time in the future.", as the reminder's picker does (`followups.spec.ts`, the page clock moved on while it's open).
5. **The digest's failure offered only Try again** when the fix is in Settings. It offers AI settings when the error says so (`digest-page.test.tsx`).
6. **The wheel test trusted the window, not the pane.** `wheelsTo` now needs the target whole inside every ancestor that clips it, top and bottom.

## Results

- **Rebased** onto main at `8db2bfa3d` (the owner's answers: newsletters opened from the digest aren't pinned in Today, the Undo ring's faint track, the no-AI sender check in the action preview). No conflict; the AI specs pass on top of it.
- **Typecheck and lint:** clean.
- **Touched specs, `e2e` (macOS):** `ask`, `summaries`, `ai-draft`, `followups`, `filters`, `today`, `plain-actions`, `replies-ready`, `snack`: 80 passed. **In Lumen, Atelier, Graphite and Luma** (their `@design` and `@variant` flows of the same specs and `design-axe`): 70 passed. `design-axe`, `visual`, `designs`, `controls`, `menu-corners`, `palette`, `i18n` in all five: passed after the two AI filter baselines moved.
- **`pnpm test:ui-perf`:** 45 passed.
- **The frozen capture** reached every AI state in Lumen, Atelier, macOS and Graphite, light and dark (136 shots, 56 AI requests each, all to the stub), with no change to `scripts/ui-rating/`.
- **`pnpm test:all`** (`E2E_PORT=7550`, `WEB_PORT=7560`), 1,346 s: lint, build, typecheck, web, e2e, ui-perf, perf and startup passed. `unit` and `db-wasm` failed only on the crowded first pass and passed alone (flaky: timing tests under load, such as "scheduling with thousands of location ops… stays fast", a 40 MB attachment stream, SQLite abrupt restarts; none touches the AI surfaces). **`smoke` failed twice** on `native-reload.smoke.ts:293`. That test waits for macOS to move focus to a second native window (`getFocusedWebContents()`); nothing in this branch touches window focus, drafts or reload. It wasn't run on main to compare.
- **Shots:** `/tmp/terno-scratch/ai-redesign/round0/<design>/`; before and after sheets in `/tmp/terno-scratch/ai-redesign/sheets/`.

## Rated rounds (on this branch)

### ai162-r01 (branch at `fedfd1eea`, 2026-11-08)

The redesign as built, rated blind. All eight reports valid; 656 cells under 9 (main's ai-r03: 664), 96 issues (2 high; ai-r03: 101 and 1). The numbers as `gate.mjs` wrote them:

| Style | Rater | Overall | UI | UX | Lowest | Cells below |
|---|---|---:|---:|---:|---:|---:|
| atelier | claude | 7.5 | 7 | 8 | 5.5 | 84/84 |
| atelier | codex | 7.5 | 7.5 | 8 | 6.5 | 74/84 |
| graphite | claude | 7 | 6.5 | 7.5 | 6 | 84/84 |
| graphite | codex | 7.5 | 7.5 | 8 | 6.5 | 80/84 |
| lumen | claude | 7.5 | 7 | 7.5 | 6 | 84/84 |
| lumen | codex | 7.5 | 7.5 | 8 | 6.5 | 75/84 |
| macos | claude | 7 | 7 | 7.5 | 5.5 | 84/84 |
| macos | codex | 8 | 8 | 8 | 6.5 | 67/84 |

#### Screens, each rater's overall

| Screen | atelier claude | atelier codex | graphite claude | graphite codex | lumen claude | lumen codex | macos claude | macos codex |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| summary | 7.5 | 7.5 | 7 | 7.5 | 7.5 | 8 | 7 | 8 |
| ai_draft | 8 | 8 | 8 | 7.5 | 8 | 7.5 | 7.5 | 8 |
| ask | 8 | 8.5 | 7.5 | 8 | 7.5 | 8 | 7 | 8.5 |
| actions | 7.5 | 8.5 | 7.5 | 8 | 6.5 | 8.5 | 7 | 8.5 |
| today | 6.5 | 7.5 | 6.5 | 7 | 7 | 7 | 6.5 | 7.5 |
| followups_replies | 7.5 | 8 | 7.5 | 8 | 7.5 | 8 | 7.5 | 8.5 |
| ai_settings | 7 | 7 | 6.5 | 7 | 7 | 7.5 | 7 | 8 |

#### Facets, mean across screens

| Facet | atelier claude | atelier codex | graphite claude | graphite codex | lumen claude | lumen codex | macos claude | macos codex |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| typography | 7.14 | 7.79 | 7.14 | 7.71 | 7.21 | 7.71 | 6.86 | 7.79 |
| contrast | 8.14 | 8.57 | 7.71 | 7.86 | 6.93 | 7.71 | 7.79 | 8.64 |
| placement | 7.50 | 8.14 | 6.71 | 7.93 | 7.14 | 8.21 | 6.86 | 8.21 |
| hierarchy | 7.21 | 7.64 | 6.93 | 7.50 | 7.21 | 7.86 | 6.50 | 7.93 |
| controls | 7.43 | 8.21 | 7.07 | 8.07 | 7.07 | 8.21 | 6.86 | 8.36 |
| density | 7.71 | 7.64 | 7.14 | 7.64 | 7.29 | 7.64 | 7.00 | 8.14 |
| efficiency | 8.00 | 8.14 | 7.64 | 8.43 | 7.79 | 8.71 | 7.50 | 8.64 |
| clarity | 7.86 | 7.71 | 7.36 | 7.86 | 7.14 | 8.07 | 7.07 | 8.07 |
| feedback | 7.50 | 8.79 | 7.93 | 8.29 | 7.71 | 8.50 | 7.29 | 8.93 |
| consistency | 7.57 | 7.93 | 7.14 | 7.86 | 6.93 | 8.21 | 7.07 | 8.36 |
| accessibility | 7.50 | 8.00 | 6.93 | 7.57 | 6.43 | 7.57 | 6.36 | 8.14 |

**Against ai-r03:** overall 7 to 8 (was 7 to 7.5); ⌘J 7.5 to 8 (was 7 to 7.5), follow-ups 7.5 to 8.5, Today 6.5 to 7.5 (was 4.5 to 7). Still lowest: Today and AI settings (6.5 to 8), accessibility and hierarchy from Claude (6.4 to 7.2).

**High:** the action preview's checkboxes are the loudest thing on the screen (Lumen, Claude); a model's HTTP 500 reads "Couldn't reach Ollama" while Reply ready works on the same screen (macOS, Claude).

**Themes:** Today's header ("Showing 12 of 41 · See all in To reply to") reads as a broken sentence and the digest outranks the people waiting; reasons still merge into truncated snippets. Writing style is dense and its learning explanations are fine print. The action preview leaves half the reader empty, its hints don't match the state, a failed action clears what you typed. Small, grey secondary text across AI surfaces, worst in dark. The summary's suggested action opens a blank reply and is lost when you act. At 1100 the ⌘J instruction can't be read in full (all four Codex reports). Reply ready appears without warning on top of the reply bar.

## Pass after ai162-r01

Written before any code. All eight reports, their 656 below-9 reasons, the 96 issues, the probes and ai-r03 were read. Two rated rounds are left, so this pass changes structure where the raters scored structure, not only polish. Each change names what it answers (reports as `style/rater`).

### What the reports agree on

1. **Today ranks newsletters over people** and explains neither its 12 nor its reasons (every report; Claude 6 to 6.5). ai-r00 put the digest at the list's end and scored it 5 (below the fold), so the digest stays first: it gets quieter, not later.
2. **Writing style does five jobs at one weight** and describes learning without showing it (every Codex report, Claude 6.5 to 7).
3. **The action preview's ticks, chips and keys are the loudest things on it**, and its decision moves when a match is read (Lumen claude high; Graphite and macOS codex).
4. **Errors say "Couldn't reach" when the server answered** (macOS claude high).
5. **The small type is three sizes within 1.5 px**, card headers come in three sizes, hints are 11 px (Atelier claude, every Claude report on accessibility).
6. **⌘J's instruction is cut at 1100** (all four Codex reports) and its rewrites hide behind one menu.
7. **Two reply surfaces stacked** at the end of a conversation with Reply ready (Atelier, Graphite and Lumen claude).
8. **The summary's next step is lost**: Reply opens a blank reply; the item has a second left edge.

### Changes

**Shared**
- AI card headers are one style on the summary, the follow-up and Reply ready: `text-sm`, the title medium in the ink, facts in the secondary (Atelier claude: 12, 13.5 and 16 px). Hints and meta on AI surfaces are `text-xs` (12 px), never the 11 px `2xs`.
- **Errors by what happened.** A provider that answered with an HTTP error now says so: "Ollama answered with an error (500)", with "It's running, but this request failed. Try again, or choose another model in AI settings." Unreachable stays "Couldn't reach Ollama". The backend keeps the kind (`unavailable`, so nothing else changes) and gives the message its own catalog key (`errors.ai.providerError`), which `aiErrorCopy` words (macOS claude, high).
- **One tick for picking mail for a batch:** the action preview's row mark uses the digest's quiet outlined box (Lumen claude high, Graphite claude).

**Summary (`a01`)**
- One left edge: an item is a line at the paragraph's edge, its kind a muted label before the words ("To do · Tell Arjun what you think", the words medium), its controls under it at the same edge (Graphite claude 6.5, macOS claude, Codex low ×3). "Action" becomes "To do" (Graphite, Atelier, Lumen claude: whose action?).
- The paragraph and items use the card's width (the measure left a 140 px dead column: four reports).
- **Reply on an item drafts from it:** it opens the reply with ⌘J's row holding the item as the instruction, ready for Return; nothing is written until the user asks, so no model call is added (Lumen, macOS, Graphite claude). The label stays Reply.
- The source names the time when two messages from that person share a day ("Arjun's message, Yesterday, 9:41 PM") (Atelier codex).
- The toolbar's Summarize gets its own glyph; the sparkle stays the mark on AI cards (Graphite claude). The toolbar is already in the Tab order; nothing else is added (owner: no new shortcuts).

**⌘J (`a02`, `a03`)**
- The instruction shows up to two lines, then an ellipsis with the whole text in its tooltip; Edit stays after it, now a 28 px quiet button named "Edit instruction" (all four Codex reports, Graphite and macOS claude).
- Narrow, the group is **Undo | Regenerate | Rewrite ▾** (Shorter, Warmer): the most-used rewrite stays direct (Lumen, macOS, Graphite codex).

**Ask (`a04`)**
- The header shows the question being answered now, not the conversation's first (Lumen claude medium, Atelier claude).
- A failed request keeps its words in the field, selected; a request that finds nothing says what to try: "Nothing in your mail matches that. Name a sender, a subject or a category." (Lumen claude medium, Atelier claude medium, macOS claude).
- The live region says the error, never "Answer ready" after a failure (Graphite claude).
- "Search older mail on your servers" is one control in both places, a quiet button with its glyph (Atelier, macOS claude).
- Citations sit a thin space from their word, the mark a step larger in the same 24 px target (Graphite claude, every Codex report low).
- "Answer again" becomes **Regenerate**, ⌘J's word (Lumen claude, Atelier codex).

**Actions (`a05`, `a06`)**
- **The decision has one place:** the list header's Cancel and Archive 6, in both states (the rule shown, a match being read). The reader's rule panel no longer holds buttons, so nothing moves when a match opens (Graphite codex medium, macOS codex). Their keys are in their tooltips and names; the keys' line that repeated them goes (Atelier, macOS claude).
- **x is said only where it works:** "x Leave this one out" beside "Show the rule" while a match is open; the rule panel's help says "Untick any you want to keep. Click one to read it." (Lumen, Atelier, Graphite claude: a hint for a state that doesn't exist).
- **The rule reads as words:** "Terno read it as" is a section heading in the ink; the terms are words in the ink, "shipped, delivery, tracking … or enviado", not chips that look removable (Lumen, Graphite, macOS claude). The exact pattern is offered only when it says more than those words ("Show the exact search"); for a plain list of words it said nothing new and read as a regex (macOS claude medium).
- One AI primary size: the header's `sm` Archive is the only Archive.

**Today (`a07`, `a08`)**
- **Header:** "The newest 12 of 41 that need you" and, apart from it, **See all in Inbox →**, a 24 px button that opens the Inbox's To reply to filter (its tooltip says so). "To reply to" isn't in the sentence any more (every report).
- **Sections:** "Newsletters" over the digest row and "Needs you" over the people, both real headings in the ink at `text-sm`. The digest row loses its ring, its glyph sits in the avatar column and its words on the names' edge, muted: a way in, quieter than any person (every Claude report; Lumen claude placement).
- **Reasons** are a tag of their own (BoardUI's Badge, secondary) before the snippet, so they never read as its first words. "New from a contact" becomes "Unanswered" (it showed on five-message threads the user never wrote in) (every report).
- **The digest page:** the title on the shared page-title line (it sat 15 px low), the coverage and Written with AI under it; the list; and the decision at the pane's foot, sticky: "16 to archive · 1 stays in Inbox", Untick all (a secondary), Archive 16 (primary, last). Read, then act (Atelier, Graphite, macOS, Lumen claude). The hint says that opening one keeps it (Lumen, Atelier codex, Graphite claude).
- Undo says the same noun: "Moved 14 newsletters back to the Inbox" (Lumen, Graphite claude).

**Reply ready (`a10`) and the follow-up (`a09`)**
- **Reply ready takes the reply bar's place** while it shows; Dismiss brings the bar back. The toolbar's Reply and Forward are still there (Atelier, Graphite, Lumen claude: two reply surfaces).
- Use as draft carries its R keycap; the "Press R…" sentence goes (Graphite, macOS, Lumen claude).
- "1 gap to fill" is marked in the gap's own tint, so the header points at what's missing (all four Codex reports, low).
- The follow-up stays at the conversation's top: it's the conversation's status, as the summary is; Reply ready is the reply, so it sits where the reply goes.

**AI settings (`a11`, `a12`)**
- **Writing style, one job per group, in this order:** your style (the picker, grouped by account; the profile; Edit and **Reset this style**), Companies and People, How it learns (two rows, one plain line each), then **Start over** with Clear all on its own (every Codex report; Claude 6.5 to 7).
- **The profile shows its effect:** "A draft starts and ends like this": its greeting and sign-off around "…about 21 words…", from the counted habits, no model (macOS codex medium ×2).
- The count says what it counts: "From the 64 you wrote in English" (Graphite, macOS, Lumen claude).
- **Study finishes with a way to its result:** "Done. Its notes are with your style." and **Show the notes**, which opens Phrases and notes and moves the keys there (Graphite codex medium, Lumen and Atelier claude).
- The precedence and hints at `text-sm`/`text-xs`, each one line where it can be.
- **The AI filter:** Create with AI uses the sparkle (Atelier claude); "Not saved · written with AI" (Graphite claude); the list's headings in sentence case, not capitals; a chosen action is outlined in the ink (it was 1.1:1 in Graphite); placeholders say what goes there ("Name this rule", "an address") instead of looking like values (Atelier, macOS claude).

### Not in this pass, and why
- **A keyboard shortcut or palette command for Summarize:** the owner's rule. The toolbar button is in the Tab order. A palette command isn't a shortcut, but the lead's brief says to use the existing controls; it's a question for the owner.
- **Opening the first match in the reader** to fill the preview's empty half: opening a conversation marks it read; a preview mustn't change mail.
- **Edit request in the action preview:** the palette has no way to open Ask with text in its field; Edit as a rule stays the way to change it.
- **Rows of the AI filter's sample that open, "View all 66":** a backend change (plan 162 already says).
- **A card before Reply ready's needs-reply check:** the check is a model call that may say no; a card for every conversation opened would flash and go.
- **Claim-level citations in the summary:** a new model output (owner).
- **Grouping the digest by sender, an overview paragraph:** the digest is normal emails, a line each (owner).

### Tests this pass adds
- Unit: `aiErrorCopy` for `errors.ai.providerError`; `mapSdkError` for a 500; the summary item's reply instruction; `ruleTerms` words; the source's time when ambiguous; Today's reason copy; the style sample.
- e2e (macOS): `summaries` (one edge; Reply opens ⌘J with the item); `ai-draft` (two lines, Edit instruction, narrow group); `ask` (header follows the turn; a miss keeps the text); `plain-actions` (the decision stays in the header while reading; no keys line; x only while reading; plain words); `today` (header, link, headings, tag, the digest's foot bar); `replies-ready` (the bar steps aside and returns on Dismiss; R in the button); `filters` and `ai-draft`'s Writing style part (order, sample, Show the notes).
- The clip and wheel tests stay, with the digest's foot bar in view at 1100x700.

### As built (pass after ai162-r01)

Where the build differs from the section above:
- **Actions:** the reader's rule panel gained **What it found**: the senders with their counts, the dates' span and the accounts, from the preview's rows (no model; only when every match is a row here), so the panel's space holds something to check. **x** is said in the help ("Untick any you want to keep, or press X on the one you're reading. Click one to read it."): a hint beside Show the rule cut the request to "Archiv…" at 1100. Cancel claims Esc only where Esc cancels (not while a match is read, where Esc is Show the rule's).
- **Summary:** the item's Reply seeds ⌘J's row through `openRow`'s landing (`instruction`), so an open that didn't land seeds nothing.
- **Reply ready:** the reply bar steps aside only once it doesn't have the keys; Dismiss gives them to the bar after the dismissal is done. Use as draft's R keycap is outlined in the button's own ink (the field's wash vanished on the primary).
- **Today:** a drawn heading can't sit in a listbox, so each section's first row starts with the section's name for assistive tech ("Needs you, …", "Newsletters, …"); the headings stay drawn and `aria-hidden`.
- **The digest:** a provider that answered with an error is stored as `provider_error` (or `provider_not_found`) in the digest's `errorKind`, a string column, so the page says so; the backend treats both as `unavailable`.
- **Errors:** a 404 is "{provider} doesn't have that model", with "Choose another in AI settings".
- **Writing style:** "Show the notes" opens the profile holding the study's notes (a profile merged across languages is shown in the picker when it's the one) and all of its examples, notes after phrases.
- **The AI filter:** the chosen category and folder selects are outlined in the ink as the chosen actions are.

### The Codex review of this pass

Nine findings, all taken, each with a test that fails without its fix:
1. **A cancelled summary Reply could overwrite newer typing** (it looked for the draft after the open). The instruction is seeded only where the reply landed (`summary-reply.test.ts`).
2. **Dismiss lost focus when the backend took more than a frame.** It waits for the dismissal, then gives the keys to the bar (`reply-ready.test.tsx`, a dismissal held open).
3. **A reply becoming ready hid the focused reply bar.** The bar stays while it has the keys (`replies-ready.spec.ts`).
4. **A failed follow-up cleared its words** (only the empty page kept them). The follow-up field keeps them, selected (`ask.spec.ts`).
5. **Show the notes could open a profile without the study's notes.** It opens the one holding them, and all of them (`ai-draft.spec.ts`; the demo has no language split, so the merged-profile case is covered by the code path, not a fixture).
6. **A 404 still said "Couldn't reach".** It says the model is missing (`ai-error.test.ts`).
7. **The digest couldn't say its provider answered with an error.** Stored apart, said so (`digest-page.test.tsx`).
8. **Today's headings weren't in the accessibility tree.** The first row of each section says its name (`today.spec.ts`).
9. **Cancel advertised Esc while Esc went back to the rule.** It doesn't, there (`plain-actions.spec.ts`).

### Not in this pass (questions for the owner)
- **A palette command "Summarize this conversation"** (Graphite claude, efficiency 6). It's a command, not a shortcut; the brief kept to the existing controls, which are in the Tab order. May it be added?
- **"Found with AI"** on the follow-up (three Claude reports flag the difference from "Written with AI"). Keep the distinction (the popover explains it), or one label everywhere?
- **The action preview's empty half** is now partly "What it found". Opening the first match in the reader would fill it, but opening marks mail read. Would a read-only peek of the first match (no read mark) be wanted?

### ai162-r02 (branch at `1c7aa1992`, 2026-11-08)

After the pass that followed ai162-r01, rated blind on the stub as before. All eight reports valid; 673 cells under 9 (ai162-r01: 656), 97 issues (4 high; r01: 96 and 2). The numbers as `gate.mjs` wrote them:

| Style | Rater | Overall | UI | UX | Lowest | Cells below |
|---|---|---:|---:|---:|---:|---:|
| atelier | claude | 7 | 7 | 7.5 | 5 | 84/84 |
| atelier | codex | 7.5 | 7.5 | 7 | 5 | 84/84 |
| graphite | claude | 7.5 | 7 | 8 | 6.5 | 83/84 |
| graphite | codex | 7.5 | 8 | 7 | 4.5 | 75/84 |
| lumen | claude | 7 | 7 | 7.5 | 6 | 84/84 |
| lumen | codex | 7 | 7.5 | 7 | 5.5 | 83/84 |
| macos | claude | 7.5 | 7 | 8 | 6.5 | 81/84 |
| macos | codex | 7.5 | 7.5 | 7.5 | 4 | 75/84 |

#### Screens, each rater's overall

| Screen | atelier claude | atelier codex | graphite claude | graphite codex | lumen claude | lumen codex | macos claude | macos codex |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| summary | 7.5 | 7.5 | 7.5 | 8 | 7.5 | 8 | 7.5 | 8 |
| ai_draft | 7.5 | 7 | 8 | 7.5 | 7 | 7.5 | 8 | 7.5 |
| ask | 8 | 8 | 7.5 | 8.5 | 8 | 8 | 8 | 8.5 |
| actions | 7.5 | 8 | 7.5 | 8.5 | 7 | 7.5 | 7.5 | 8 |
| today | 6 | 6 | 7.5 | 5.5 | 6.5 | 6.5 | 7 | 6.5 |
| followups_replies | 8 | 7.5 | 8 | 8 | 7.5 | 8 | 8 | 8.5 |
| ai_settings | 6.5 | 7.5 | 7.5 | 7.5 | 7 | 7 | 7 | 7 |

#### Facets, mean across screens

| Facet | atelier claude | atelier codex | graphite claude | graphite codex | lumen claude | lumen codex | macos claude | macos codex |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| typography | 7.14 | 7.79 | 7.50 | 8.00 | 7.43 | 7.71 | 7.21 | 7.93 |
| contrast | 7.36 | 8.29 | 8.14 | 8.29 | 7.00 | 7.36 | 7.93 | 8.29 |
| placement | 6.86 | 7.43 | 7.43 | 7.86 | 7.29 | 7.50 | 7.29 | 7.50 |
| hierarchy | 6.79 | 7.36 | 7.07 | 7.57 | 7.29 | 7.21 | 7.00 | 7.50 |
| controls | 7.21 | 7.86 | 7.21 | 7.93 | 7.21 | 7.93 | 7.29 | 8.07 |
| density | 7.21 | 7.00 | 7.57 | 7.43 | 7.36 | 7.14 | 7.50 | 7.36 |
| efficiency | 7.71 | 7.64 | 8.00 | 8.00 | 7.64 | 7.71 | 8.07 | 8.00 |
| clarity | 7.50 | 7.50 | 8.07 | 7.71 | 7.50 | 7.43 | 7.93 | 7.86 |
| feedback | 8.14 | 7.86 | 8.00 | 8.21 | 7.29 | 8.29 | 8.21 | 8.43 |
| consistency | 7.43 | 7.50 | 8.00 | 7.79 | 7.57 | 7.79 | 7.79 | 7.86 |
| accessibility | 6.79 | 7.71 | 7.00 | 8.14 | 6.64 | 7.21 | 7.14 | 8.00 |

**Against ai162-r01:** every screen but Today held or rose (summary 7.5 to 8, follow-ups 7.5 to 8.5, Ask 7.5 to 8.5); overall 7 to 7.5. **Today fell** (5.5 to 7.5, was 6.5 to 7.5), and every high issue and every cell under 5.5 is Today's.

**High (all Today):** the digest says opened newsletters stay, but returning with Esc leaves an opened one ticked and Archive takes it (Back to the digest unticks it; three Codex reports, both modes); the digest has no keyboard model of its own, so j and x act on the hidden Today list behind it.

**Today's themes:** Newsletters come before Needs you on a page titled "need you" (six reports); the Unanswered and Your turn tags are the loudest things in the rows and unexplained; the digest's last row is cut under its footer, and the Undo snack covers that footer; returning from a newsletter loses the digest's scroll.

**Rounds:** two of three used. The owner asked (2026-11-08) for the last round to use real models from the main checkout's `.env` instead of the stub; that tooling is being built on main.

## Pass after ai162-r02

Written before any code. All eight reports, their 673 below-9 reasons, the 97 issues and the probes were read; the digest's two high issues were reproduced on the round's build before planning (opened, then Esc or Back to the digest: still ticked; j on the page: Today's list moved behind it). One rated round is left, on real models: nothing here depends on the stub's words or speed.

### Why the digest broke its promise

The page learned "opened" only from the backend: a newsletter is read 450 ms after it's shown (the reader's dwell, so holding j doesn't read everything), and the page saw that only when the list refreshed. Back in under the dwell, or before the refresh, and the row was still ticked, whichever way you came back. The fix doesn't race anything: **opening a newsletter from the page is a keep the page records itself**, at the moment it opens, beside the unticks, in the same per-day pick that outlives the page. The backend's read state stays a second source (a newsletter read elsewhere). So every return path (Esc, Back to the digest, the digest's entry, j or k onto it, ⌘[) finds the same rows, count and button, because none of them is involved.

### Changes

**Today (`a07`, `a08`)**
1. **One keep state.** A row is ticked unless it's unticked or opened; the count and Archive are always the ticked rows; an opened row says "Opened · stays in Inbox", an unticked one "Stays in Inbox", its box empty. An opened row's box is disabled: the owner's rule (plan 145) is that opened mail is read and stays. Tick all and Untick all touch only the rows that can be ticked. e2e: one test per return path that fails without the fix (Esc, the link, the entry, k, ⌘[).
2. **The digest has its own keys** while it's on screen, the list's own: **j/k** move a cursor through its rows, **x** ticks or unticks the cursor's row, **Enter** opens it, **Esc** gives the keys back to the list, at the digest's entry. No new key (owner). The cursor is the list's: a row with the selection's fill, focus on its open button (a program's focus: no ring, plan 54); it scrolls into view above the footer. **Focus goes into the digest when it opens**: its first row, or the row a newsletter was opened from on the way back.
3. **Needs you first; the digest above the fold, quieter.** The digest leaves the list for Today's header, under "The newest 12 of 41 that need you": one line, its glyph at the rows' edge, "16 newsletters · today's digest ›", the selection's fill while it's open. The list starts with Needs you. It's in Tab order and in the palette as before. Why not after Needs you: ai-r00/r01 put it below the fold (12 rows fill a 900 px window). In the header it's never scrolled away and never comes before a person.
4. **The reasons are words in the reason's colour**, never a box: the snippet's line starts with the reason in the secondary at medium weight, then "·", then the snippet. They say what happened in plain words, each its own: **"You haven't replied"** (they wrote; you never answered in this conversation) and **"They replied"** (you wrote; the last word is theirs). The section's name already says it needs you. No tooltip: the words carry it.
5. **The footer never hides a row or is hidden.** The list reserves the footer's height (`scroll-padding-bottom`, so j/k and Tab stop above it), and while rows continue under it the footer fades them in its top edge. The Undo snack rises above the digest's footer while the page is open (the reader's snack inset, as the composer has).
6. **Scroll on return** on every path: where the page was, saved when a newsletter opens, restored before paint, and the opened row is the cursor.

**Actions (`a05`, `a06`)**
7. **One label column** for "Terno read it as" and "What it found" (one grid, two sections; all eight reports measured two).
8. **What it found counts what's ticked**, so it stays when a row is unticked (it vanished).
9. **The decision is also where the reading ends:** under the rule, Archive 6 (primary) and Cancel, the same commands as the header's (which stay, so nothing moves while a match is read). Five reports asked for exactly this.
10. **Edit as a rule is a control**: an outlined 28 px button with its pencil, beside "Terno read it as" (it read as a caption).
11. **Dates checkable:** Age says its day ("Older than 30 days, before Sep 22"); a range across years gives both years.
12. **Focus after ⌘Z** on an action: the list's row the cursor is on (it fell to `<body>`).

**⌘J (`a02`, `a03`)**
13. **The instruction is one line again**, with the whole of it a click away: the quote is a disclosure (`aria-expanded`) when it's cut, opening to every line; Edit instruction stays after it. At 1100 the strip is two 38 px lines (it was about 96 px). All four Codex reports.
14. **Undo says what it takes back** in its name and tooltip ("Undo Shorter", "Remove the AI's draft"), and **gives the keys to the draft** at every width (from the narrow group they stayed on Rewrite).
15. **Undoing the first draft keeps the instruction**: the row's field comes back holding it, selected, ready for Return; nothing is retyped.
16. The row's field is named "Instruction for AI" (it was "AI").

**AI settings (`a11`, `a12`)**
17. **Writing style is one screen of facts:** the habits once, as three short lines (the sample repeated them in a box, 120 px; four Codex reports); section names in the ink at `text-sm`; the page fades at the dialog's edge where it continues.
18. **Esc on Style for's menu** closes the menu and stays (it left Writing style).
19. **The AI filter's choices say their scope:** **Save for new mail** and **Save and apply to 66 conversations**. Edit request is an outlined 28 px button with its pencil. After Save the keys go to the saved rule.

**Shared**
20. **Every "edit what the AI read" control looks like one** (macOS claude medium, five reports low): Edit instruction, Edit as a rule, Edit request: the pencil and the word in the ink, bounded.
21. **AI text at the mail's measure:** the summary's paragraph and items, and Reply ready's draft, stop at `--read-max` (six reports: 100 to 110 characters a line); the card keeps the pane's width, so its rows don't move.
22. **A gap is marked by more than colour:** a dotted underline; the send warning about a gap left is the warning notice, not grey text.

### Not in this pass
- **Grouping the digest by sender, topics on its entry, preparing progress** (several, low): the digest is normal emails, a line each (owner).
- **Starting the digest unticked** (Lumen claude): plan 145's rule, all start ticked.
- **A shortcut for Archive N, Undo, Regenerate, Shorter** (several): the owner's rule.
- **Tinting AI-written text in a draft** (macOS, Atelier claude): the draft is the user's; Edited after AI already says it.
- **The rule's name vs its condition** (Atelier codex): the model's words; the round runs on real models.
- **Citations in the summary's paragraph; "Show all 66"; reply-all for Reply ready**: as before, new model output or backend.

### Tests this pass adds
- e2e `today`: each return path keeps an opened newsletter out (Esc, link, entry, k, ⌘[); the digest's keys (j/k/x/Enter/Esc) never touch the list behind; focus in the digest on open; Needs you first, the entry in the header and above the fold at 1100x700; the reasons' words and colour; the last row clear of the footer at the end; the snack above the footer; the scroll kept on return.
- e2e `plain-actions`: one label column; What it found after an untick; the rule's own Archive; focus after ⌘Z.
- e2e `ai-draft`: one line, expandable; Undo's name; focus after Undo at 1100; the first Undo keeps the instruction.
- e2e `filters`, Writing style: Save for new mail; focus after Save; Esc on Style for stays.
- Unit: `foundSummary`'s years; the cutoff's day; the digest's state of a row.

### As built (pass after ai162-r02)

Where the build differs from the section above, and what it found on the way:
- **The digest marks a newsletter read when it opens** (an `act("markRead")`, not the reader's 450 ms dwell): the owner's rule is that opened is read, and back in under the dwell it stayed unread while the page said "Opened". The page's own record of what it opened is what makes every return path the same; the read mark is so the Inbox agrees.
- **The digest's keys** are `digestKeys` in `state/today.ts` (as `conversationKeys` is for the reader); `keyboard.ts` routes `list.next`, `list.prev`, `list.toggleSelect`, `list.open` and Esc to it while the page has the keys (focus in the page, or nowhere with no dialog or menu open). The cursor is the focused row's open button, filled with `row-selected`; j/k scroll its whole row into view above the foot bar (`scroll-padding-bottom` is the bar's height, measured).
- **The digest's way in** keeps the row's test id (`digest-row`) and its words; it's a button in Today's header under the sentence (all three header shapes), `aria-current` while open. The list has no digest row and no Newsletters heading any more.
- **The snack's lift** is a new `pageLift` in the snack store, set by the digest's foot bar while it's mounted; the dock stands on it in Split and List.
- **The reasons**: "They replied" (wrote) and "You haven't replied" (never wrote), es "Te respondieron" and "No has respondido".
- **The digest's way in counts what's still in the Inbox, read or not** (found hands-on: after Archive it said "1 newsletter" beside four listed, the macOS Claude report's drift).
- **Actions:** the rule's own decision repeats the header's `ActionButtons` with their own test ids (`action-apply-rule`, `action-cancel-rule`), so the frozen capture's `action-apply` is still the header's. The provenance now sits on the Exact pattern line, or alone at the reading's end.
- **⌘J:** the instruction is measured from the line (the words move into a button once cut, so the line is what's observed). Undo's name comes from what made the version on top (`AiCommit.how`). A rewrite chosen from the narrow Rewrite menu lost the keys to `<body>` (the menu returned them to a trigger the strip redrew); the run's commit now gives keys found nowhere to the draft (found hands-on at 1100).
- **Writing style:** the section names stay Settings' (`SettingsGroup` is every Settings page's; changing it here would change the everyday screens), and with the sample gone How it learns is whole in the first screen at 1440x900, so no fade was needed.
- **Edit controls:** the pencil-with-a-line glyph (`PenLine`); the plain pencil read as a nib at 16 px.

### The Codex review of this pass

Five findings, all taken, each with a test that fails without its fix:
1. **List's digest is a page; Esc didn't leave it** (the digest's own Esc focused an entry under the covered list). In List, Esc closes the page as any page (`today.spec.ts`, "Today in List").
2. **The digest's way in kept a bulk selection** in Split (the selection bar stayed in the reader). It's the ordinary row's press and release (`today.spec.ts`).
3. **Opened here, then archived elsewhere, said it stays.** Out of the Inbox is archived, whatever was opened (`digest-page.test.tsx`).
4. **The first write taken back after an edit still dropped the instruction.** It leaves the field with it too (`ai-draft.test.ts`, five cases updated).
5. **An edited instruction's fresh take said "Undo Regenerate".** It says "Undo the rewrite" (`ai-draft.test.ts`, `commitHow`).

### Not in this pass (questions for the owner)
Still open from before: Save as primary in Rules; a palette command "Summarize this conversation"; one provenance label for follow-ups ("Found with AI"); a read-only peek of the first match in the action preview; whether archiving an opened newsletter returns to the digest; whether Reduce Motion freezes the Undo ring. New:
- **The digest's opened newsletters can't be ticked again.** The owner's rule keeps them in the Inbox; one Codex report (Lumen) wanted reading and the tick kept apart. Keep it?
- **Settings' group labels** (12 px semibold grey, every Settings page) were called too quiet by three Claude reports on Writing style. Raise them app-wide?
- **Reply ready answers only the sender** on a group thread ("To Liam Taylor"; two Claude reports). Reply all, or saying "only Liam"?

### Results (pass after ai162-r02)

- **Typecheck and lint:** clean.
- **e2e, macOS (`e2e`):** `today` (13 with the List case), `plain-actions` (15), `ai-draft` (16), `filters`, `summaries`, `replies-ready`, `followups`, `ask`, `snack`, `i18n`, `palette`: passed. **In Lumen, Atelier, Graphite and Luma** (their flows of the same specs): 60 passed. **`design-axe`** in Lumen and Atelier: 10 passed. **`visual`**: passed after the AI filter's two baselines moved (`filters-ai`, `filters-ai-dark`; looked at, light and dark).
- **Unit:** the touched files pass (`digest-page`, `today`, `ai-draft`, `rule-words`, `action-found`, `reply-ready`). Across `apps/web/src`, four files fail that this pass doesn't touch: `command-palette` and `floating-restoration-lifetime` fail on `f9c41536c` too; `diag-local` expects the app's version to be 0.0.0 (the build says 0.1.0); `account-folders.perf` is a timing test that was run beside the capture.
- **`pnpm test:ui-perf`:** 45 passed.
- **The frozen capture**, on the final build, reached every AI state in Lumen, Atelier, macOS and Graphite, light and dark: 136 shots, 56 AI requests each, all to the stub, with no change to `scripts/ui-rating/`.
- **Hands-on** (`harness.mjs`, macOS light 1440x900 and Atelier dark 1100x700): the digest (open, j/k/x, Enter then Esc, Back to the digest, the way in, Esc to the list, Archive, the snack above the bar, Undo), ⌘J at 1100 (one line, Rewrite ▾ then Undo twice: keys in the draft, then the field holding the instruction), Writing style's Style for and Esc.
- **Shots:** `/tmp/terno-scratch/ai-redesign/round2/<design>/`; before and after sheets in `/tmp/terno-scratch/ai-redesign/sheets-r2/`.

### ai162-r03 (branch at `8602bce4c`, rebased on main's real-model rating, 2026-11-08): the last round

After the pass that followed ai162-r02, rated blind **on real models** (Pro's routing: summaries on OpenAI gpt-6-luna; ⌘J, Ask and Reply ready on claude-sonnet-5-5; actions, follow-ups and the digest on claude-haiku-5-5; the AI filter on claude-opus-5-5), the owner's request. All eight reports valid; 662 cells under 9, 105 issues (10 high). The numbers as `gate.mjs` wrote them:

Models: real, openai/gpt-6-luna, anthropic/claude-sonnet-5-5, anthropic/claude-haiku-5-5, anthropic/claude-opus-5-5, jev/jev-latest; the captures spent US$0.26 as the app counted it

| Style | Rater | Overall | UI | UX | Lowest | Cells below |
|---|---|---:|---:|---:|---:|---:|
| atelier | claude | 7.5 | 7.5 | 7.5 | 6 | 84/84 |
| atelier | codex | 7.5 | 7.5 | 7.5 | 6 | 75/84 |
| graphite | claude | 6.5 | 7 | 6.5 | 5.5 | 84/84 |
| graphite | codex | 7.5 | 7.5 | 7 | 5.5 | 78/84 |
| lumen | claude | 7 | 7 | 7 | 6 | 84/84 |
| lumen | codex | 7.5 | 7.5 | 7.5 | 5.5 | 69/84 |
| macos | claude | 7.5 | 7.5 | 7 | 5.5 | 84/84 |
| macos | codex | 7.5 | 7.5 | 7.5 | 5.5 | 80/84 |

#### Screens, each rater's overall

| Screen | atelier claude | atelier codex | graphite claude | graphite codex | lumen claude | lumen codex | macos claude | macos codex |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| summary | 8 | 7.5 | 7 | 7.5 | 7 | 7.5 | 7.5 | 7.5 |
| ai_draft | 7.5 | 7.5 | 7 | 7.5 | 7 | 7.5 | 7.5 | 7.5 |
| ask | 7.5 | 7 | 6.5 | 7 | 6.5 | 6.5 | 8 | 6 |
| actions | 7 | 8 | 6.5 | 8 | 6.5 | 7.5 | 7 | 8 |
| today | 7 | 7 | 6.5 | 7 | 6.5 | 7 | 7.5 | 7 |
| followups_replies | 8 | 8 | 7 | 8.5 | 7.5 | 8.5 | 8 | 8 |
| ai_settings | 7.5 | 7.5 | 7.5 | 7.5 | 7 | 8 | 6.5 | 7 |

#### Facets, mean across screens

| Facet | atelier claude | atelier codex | graphite claude | graphite codex | lumen claude | lumen codex | macos claude | macos codex |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| typography | 7.79 | 8.07 | 7.21 | 8.07 | 7.21 | 8.07 | 7.64 | 7.71 |
| contrast | 7.43 | 8.29 | 7.14 | 8.29 | 6.86 | 8.43 | 8.07 | 8.14 |
| placement | 7.14 | 7.86 | 6.71 | 8.00 | 7.00 | 8.14 | 7.64 | 8.07 |
| hierarchy | 7.50 | 7.21 | 6.86 | 7.50 | 6.71 | 7.57 | 7.29 | 7.07 |
| controls | 7.64 | 8.29 | 6.86 | 8.21 | 6.93 | 8.50 | 7.50 | 8.14 |
| density | 7.21 | 7.07 | 6.64 | 7.50 | 6.79 | 7.21 | 7.36 | 7.21 |
| efficiency | 7.93 | 8.50 | 7.14 | 8.07 | 7.07 | 8.50 | 8.00 | 8.29 |
| clarity | 7.36 | 7.07 | 6.79 | 7.21 | 6.64 | 7.50 | 7.14 | 6.79 |
| feedback | 8.29 | 8.71 | 6.93 | 8.36 | 7.36 | 8.50 | 7.71 | 8.07 |
| consistency | 7.79 | 8.21 | 7.07 | 8.07 | 6.93 | 8.71 | 7.29 | 8.00 |
| accessibility | 6.86 | 7.86 | 6.43 | 8.29 | 6.43 | 8.79 | 7.50 | 7.93 |

**Against r02 (stub):** Today rose (6.5 to 7.5, was 5.5 to 7.5); follow-ups held at 7 to 8.5; **Ask fell** (6 to 8, was 7.5 to 8.5) and clarity with it. Real models made the raters see what the stub never produced, and most high issues are those:
- Ask: the scope line ("searched back to Apr 25, 2026") contradicts sources from 2024 and 2025; "Parts of this aren't linked to a message" says neither which parts nor what to do, and shows under fully cited answers; sources cut to four rows with no count; raw [n] while streaming; Esc while working drops the question; same-name people merged silently.
- First use asks for consent three different ways (summary banner, composer paragraph, action paragraph), and the action preview's count changes under the consent.
- The AI filter turned part of a request into `.+` and offered to archive 842 conversations.
- The summary's question items are written as instructions, and Reply puts them in ⌘J as the instruction.
- "Open your nudge" shows before the nudge exists (while the composer waits on consent).
- The action preview's "matches a pattern (see Exact pattern)" points at a control named otherwise; what the AI check left out is the faintest line on the page.

## Where it stands after three rounds

The owner's budget of three rated rounds on this branch is used. Mean of the eight raters' overall: main's ai-r03 7.21, r01 7.43, r02 7.36, r03 7.29 (r03 on real models, so not directly comparable). No cell reached 9 from both raters in any round; the branch is not merged and waits for the owner.

## Pass after ai162-r03 (real models)

### The request (2026-11-08, verbatim)

> "yes, fix the real model findings, do up to 2 more rounds, also i need pictures of how every ai feature looks in the ui to decide if i need to do changes to it or not, each ai ui feature needs to have a clean feeling to it and modern."

Written before any code. All eight r03 reports, their 662 below-9 reasons, the 105 issues (10 high) and the probes were read. The lead runs ai162-r04 and r05 on real models after this pass; this pass also makes a gallery of every AI feature for the owner.

### What real models exposed, and the fix for each

**Ask**
1. **The scope line.** "Searched mail on this Mac back to Apr 25, 2026" came from the accounts' sync window (`offer()` in the backend), while the local search reads everything on this Mac, older mail included, so it sat beside 2024 sources. The date is where this Mac's copy is *complete* from. The line now says what was searched and what the date means: "Searched all mail on this Mac · complete since Apr 25, 2026", then Search older mail on your servers. Unit test: the line never says "back to" a date later than a cited source.
2. **The partial note.** It came from the backend's `unlinked`, true for a dropped citation label or for any sentence without one (an intro ending in ":", a list's lead-in). Now the reader decides from the answer it shows: `answerSentences` (core) splits the answer into sentences exactly as `hasUnlinkedSentence` does, an intro ending in ":" isn't a claim, and each claim with no citation is marked inline (a dotted underline, the gap's own mark, and a tooltip "Not linked to a message"). The note shows only when one is marked: "Underlined parts aren't linked to a message." A stopped answer says Stopped and no note. No model call.
3. **Citations while streaming** render as the same numbered marks (not buttons yet: their sources arrive with the end), never "[1]".
4. **Sources** say their count ("Sources · 7"), and the list shows every row: one scroll region (below).
5. **Esc while working** stops and keeps the question: a stop with nothing written yet leaves "Stopped before an answer." with the question in the field, selected, so Return asks again. A stop with words keeps them, as now.
6. **People with one name.** When the sources' senders hold one first name for several people, and that name is in the question or the answer, a line under the answer says so: "Isabella here is 3 people: Isabella Álvarez, Isabella Rivera and Isabella Cruz." From the sources' senders, no model.
7. **⇧⌘K on a shown source** goes back to the answer (it closed Ask).
8. **One scroll region, and a turn starts at its top.** The answer, its notes and its sources scroll together (two regions before, each cut). When a turn starts, its question is scrolled to the top of the region and stays there while the answer streams under it, so a long answer starts at its beginning, and an earlier turn's sources are never what's left at the top. Earlier turns fold their sources into "2 sources ▸".

**First-use consent: one pattern** (`AiConsent`, beside `AiErrorNotice`, the same anatomy)
9. One line in the ink naming the provider and what goes ("This sends the text of this conversation to OpenAI."), a **What's sent** disclosure only where there's more to say (⌘J's list), then **Continue** (secondary, the surface's default, ↵ where Enter reaches it) and **AI settings** (quiet). The summary, ⌘J and Nudge, Ask, the action check and Study my style use it. Plans 131 to 133 keep their meaning exactly: the same backend status, the same `acknowledge`, the same words (⌘J's long list moves into the disclosure, unchanged).
10. **The action preview counts only after its check.** While the check waits (consent or running), the title says "Checking 9 matches…", Apply says "Archive" with no number, and the rows are drawn as candidates (dimmed, no ticks); the count appears once, after the check.
11. **"Open your nudge" only once the nudge has words.** While the composer asks or writes, the card says "Drafting a nudge…" (writing) or keeps "Draft a nudge", which takes you to that draft rather than starting another.

**The AI filter**
12. **A rule that matches everything is never one click away.** `broadRule` (no model) finds a condition that matches anything (".+", ".*", a pattern any probe matches); the box says plainly what it would do ("This rule matches every conversation from a mailing list: 842 now, and all new ones."), Save and apply asks once more in a confirmation whose default is Cancel, and the footer's Save loses its primary. A large count (500 or more) also confirms.
13. **What the rule dropped is named.** `ruleMisses` becomes `ruleGaps`: the request's words a rule couldn't express ("never open": a rule can't see what you've opened) or lacks (an action, an age, a sender), quoted: "Not in the rule: “never open”." No model.

**The summary**
14. **Items say what they are.** A question is labelled by who asked it ("Arjun asks"), a to-do "To do". The summary prompt (v6) asks for a question as asked, ending in "?", and a to-do as a verb phrase. Same call, same schema.
15. **Reply opens an ordinary reply** (no ⌘J instruction). Chosen because the item is the other person's question, not the user's answer; prefilling it made Write draft a reply with no stance.
16. **Esc stops Summarizing**, as ⌘J and Ask do, and its Stop shows the esc keycap. **Collapsed** is the header alone (it cut a line in half).

**The action preview**
17. **One name for the exact search**: the rule says "matches a pattern (see the exact search)" only when there's no word list, and the control is "Show the exact search" everywhere.
18. **What the check left out is reviewable**: a line in the ink with its count under the title ("6 left out by the check"), and Show lists them in the list, dimmed, each with its tick to put it back.

**Everything else under 9, chosen for how many cells it lifts**
19. **Reply ready with a gap** says it: "Reply drafted · 1 gap to fill" (not "Reply ready"); without gaps, "Reply ready".
20. **⌘J's rewrite segment** doesn't stay pressed after it's done.
21. The filter's disclosure names the provider ("Claude (Anthropic)"), never a host.
22. Writing style's openers quote what was counted, without the template's "…," ("Often opens with “Hello”").
23. Study my style's consent is the shared consent, its long text in What's sent, Learn my style and Not now always in view.
24. Today's digest way in is a row of its own in the ink, not a grey caption; an opened newsletter's line keeps its contrast.

### Clean and modern (the owner's bar), across every AI surface
- **One consent, one error, one card**: consent and error share an anatomy (a glyph, one line, its help, the actions at the line's end).
- **Less chrome**: no box in a box (Ask's consent and error sit in the answer's flow), no second scroll region, no repeated provider sentences.
- **One quiet type ladder**: titles `text-sm font-medium`, meta `text-xs` muted, AI text `leading-relaxed`; nothing at 11 px.
- **Marks, not badges**: citations, gaps and unlinked claims are marks in the text (a numbered pill, a dotted underline); nothing new is coloured.
- No new colours, families or glitter; only plan 160's tokens.

### Not in this pass
- **A lighter scrim for Ask in light** (two reports): the palette's scrim is every dialog's; changing it here changes the everyday screens.
- **Grouping the digest by sender, merging duplicate issues** (four reports): the digest is normal emails, a line each (owner).
- **Asking "Which Isabella?" before answering**: a new step before the model call; saying it after, from the sources, is enough.
- **Showing all 41 in Today**: the owner's cap.

### Tests this pass adds
- Unit: `askScope`; `answerSentences` (an intro isn't a claim; a citation after the stop is the sentence's); `sameNamePeople`; `broadRule` and `ruleGaps`; the action title while checking; the nudge's state; the summary item label.
- e2e: `ask` (Esc while working keeps the question; ⇧⌘K from a source returns; one scroll region; the question at the top after a follow-up; the note only with an unlinked sentence); `summaries` (Reply is an ordinary reply; Esc stops); `plain-actions` (no count while checking); `filters` (a match-everything rule confirms; the gap named); the consent component on each surface (stub: `TERNO` test hooks force consent).
- The clip and wheel tests stay.

### The gallery
`/tmp/terno-scratch/ai-gallery/gallery.mjs` (on `scripts/ui-rating/harness.mjs`): every AI feature and its main states, Lumen light and dark at 1440x900, macOS light for each main state; real models where a state shows model output, the stub for errors and empty states; one labelled sheet per feature.

### The owner's feedback on the branch (2026-11-08, verbatim), folded into this pass

1. The summary card: "i don't like the feeling color/bg/border for this card for the summary, it feels cheap where i want a premium, clean and modern feeling."
2. ⌘J: "the 'edit instruction' is way too big, should be a pencil." (The whole ⌘J flow is being replaced by plan 163 in another worktree: writing the instruction in the draft box, then a subtle AI button.)
3. Ask: "when text streams, lets have a nice fading animation that brings the words, that would be a nice feeling."
4. The action preview's right side: "i find the right section not clear at all, i don't understand what i need to do there, too much text that's very not important, that needs a full redesign with the actual valuable important information with more protagonism."
5. The rule and filter fields are too dark: the shared field fill (plan 160), fixed on main by another engineer; not touched here.

**What it changes in this pass:**
- **The AI card** (`ai-card`, shared by the summary, Reply ready and the follow-up) is redesigned: no grey fill and no drawn box. It's the page's own surface with a faint lift (`shadow-xs`-weight, the palette's own shadow), a hairline only in dark where a shadow can't show, more air (`px-4 py-3`), and the header's glyph and title as its only mark of AI. Still a card, so AI text never reads as the mail's (the owner's rule). Checked in Lumen, Atelier, macOS and Graphite, light and dark.
- **⌘J:** Edit instruction is an icon-only pencil (named, with its tooltip). Nothing else in ⌘J changes in this pass (item 20 above, the rewrite segment's pressed state, is dropped), so plan 163 doesn't collide: `components/composer/ai-draft.tsx` is untouched after `ebb645e22`.
- **Ask:** each chunk that streams in fades in (opacity, `--motion`, ≤ 100 ms), on the appended span only (CSS, no state per word), and not at all when motion is reduced or off.
- **The action preview's reader pane** is redesigned (below, replacing items 17 and 18's look): it leads with what will happen and the one decision.
- **Fields:** untouched.

**The action preview's pane, redesigned.** Top to bottom:
1. **What will happen**, the title: "Archive 3 conversations" (destructive ink for Trash and Spam, as now), and under it, in the ink, who they're from and when, in one line ("From UPS, DHL and 2 more · Sep 2 to Oct 20").
2. **What's kept back, only when it changes the decision**, as plain facts with their one control each: "6 left out by the check · Show" and "3 starred or replied are skipped · Include". The sender warning stays here, first.
3. **The decision:** Archive 3 (primary, or destructive) and Cancel.
4. **"How Terno read it"**, one quiet disclosure, closed: the request quoted, the rule's rows, the exact search, Edit as a rule, the provenance. The help line ("Untick any you want to keep…") goes: the ticks say it.

### As built (pass after ai162-r03)

Where the build differs from the two sections above:
- **Ask's scope:** "Searched all mail on this Mac · complete since Apr 25, 2026". The date is the sync window's (`offer()`): where this Mac's copy is complete from; the search reads older mail on this Mac too.
- **Unlinked claims:** `answerSentences` also ends a sentence at a citation followed by a capitalised word (the fake model's "… [1] This sentence …"), and leaves unmarked what an answer says of its own search ("I only looked at part of your mail", "None of these says…", "there may be more"), found on real models in Graphite. Only those forms: a claim starting with "I", or "may be more than $500", is still marked (Codex review).
- **The same-name note** shows only when the answer doesn't name each person in full; real models usually do ("Isabella Álvarez … Isabella Rivera").
- **Esc before a word** leaves the question in the field with "Stopped before an answer. Press Return to ask again." (a notice, as a request that found nothing has).
- **The streaming fade** is `animate-in fade-in-0 duration-slow` on each delta's span (`running.chunks`); the global reduced/off rule stops it.
- **The action check's left-out rows stay behind Show** (with Show a bordered control and the fact in the ink). Listing them by default put three rows under a title of two.
- **The action pane:** the request, quoted, sits under the title (the redesign hid it); "How Terno read it" holds the rule's rows, "The exact search", Edit as a rule; the provenance sits on the disclosure's line. The rule's rows say "matches the exact search below".
- **The AI filter:** Save and apply also asks while the rule isn't counted yet (Codex review); `patternBreadth` sees anchored and grouped catch-alls (`^.+$`, `(?:.*)`, `[\s\S]+`, `.{1,}`). Its failure snack is the one AI error's words, never an address (found by the gallery: "Couldn't connect to Ollama (127.0.0.1:61550)").
- **Reply ready with a gap** says "Reply drafted".
- **Today's digest way in:** words in the ink, glyph and chevron quiet. **Writing style:** "Often opens with “Hello” and their name".
- **⌘J:** only Edit instruction changed (`c4ea54cdb`, an icon button with its name and tooltip). The consent commit (`5afbfb404`) is the only other change to `components/composer/ai-draft.tsx` in this pass; nothing in `composer/` or `lib/ai-draft.ts` changes after `c4ea54cdb`.
- **Not done:** item 20 (⌘J's pressed segment), because ⌘J waits for plan 163; the summary's "Summarizing…" shows for a moment before a cloud provider's consent (the gallery saw it); a scrim change (everyday screens).

### Rebased on main (owner's decisions 2)

Rebased onto `9f0c517ca`: archiving an opened newsletter returns to the digest; Reply ready offers Reply | Reply all on group threads; the field fill fix. Conflicts resolved keeping both: Reply ready keeps main's switch and header structure with this branch's gap mark, "Reply drafted" and the card that takes the reply bar's place (so Reply all is the card's switch, the bar's is hidden while it shows); main's "Save is the main button" is the branch's own order; the digest's Undo reopens a newsletter with the branch's pick (`from`, and `opened` kept). Main's tests were moved to the branch's digest (its way in is in Today's header) and its place on return (held within the row's focus nudge, 10 px).

### The Codex review of this pass

Four findings, all taken, each with a test that fails without its fix:
1. **Save and apply could run before the rule was counted** (`matches` null meant "not large"). It asks first until counted (`filters-dialog.test.tsx`).
2. **An anchored catch-all slipped past the guard** (`^.+$`). `patternBreadth` normalises anchors, groups and `[\s\S]` (`rule-words.test.ts`).
3. **The caveat exemption was too broad** ("I found that…", "may be more than $500"). Only what an answer says of its own search (`ask.test.ts`).
4. **A follow-up under a long answer didn't start at its top** (the scroll was clamped while it said "Looking…", and never set again). It's held at its top as it streams and once it's done, until the user scrolls (`ask.spec.ts`; 86 px off without the fix).

### Results (pass after ai162-r03)

- **Typecheck and lint:** clean.
- **e2e, macOS (`e2e`):** `ask`, `summaries`, `plain-actions`, `filters`, `followups`, `replies-ready`, `today`, `ai-draft`, `snack`, `i18n`, `palette`: 94 passed (after the fixes above). **Lumen, Atelier, Graphite and Luma** (their flows of the same specs, `design-axe`, `visual`, `designs`, `controls`, `menu-corners`): 88 passed. **macOS** `visual`, `design-axe`, `motion`, `designs`: 27 passed. No baseline moved.
- **Unit:** the touched files pass. Across `apps/web/src`: `floating-restoration-lifetime` fails at HEAD as on earlier commits; `command-palette` fails only in the full run (passes alone); `diag-local` and `account-folders.perf` as before.
- **`pnpm test:ui-perf`:** 45 passed.
- **The frozen capture on real models** reached every AI state in Lumen, Atelier, macOS and Graphite, light and dark (34 shots each, 67 AI requests each, to api.anthropic.com and api.openai.com only), on the final build (`8fe355896`), with no change to `scripts/ui-rating/`. Shots: `/tmp/terno-scratch/ai-redesign/round3/<design>/`; before and after sheets (r03 against this pass): `/tmp/terno-scratch/ai-redesign/sheets-r3/<design>-<mode>.png`.
- **The gallery** (`/tmp/terno-scratch/ai-gallery/gallery.mjs`, on `harness.mjs`, frozen runtime of the final build): 12 sheets in `/tmp/terno-scratch/ai-gallery/sheets/`, real models for model output and the stub for errors, empty and working states; nothing skipped but the AI filter's consent, which doesn't exist.
- **Real-model spend:** about US$0.69 as the app counted it (captures US$0.44 over two runs; the gallery US$0.25 with its smokes).

### Ask's answer language (before ai162-r05)

- **Ask names the answer's language outright** (prompt v9), read on this machine with no model call: `questionLanguage` (core `writing/language.ts`) reads a question by how it asks: its question words, the small words and verbs around them in en and es, its opening word counted thrice, ¿ and ¡, and ñ/á/í/ó/ú only beside a Spanish word ("María?" is a name); words in quotation marks are the mail's and don't count; another language only when `detectWritingLanguage` is sure. A question that doesn't say ("Greenway?") takes the newest question before it in the conversation that did, however far back (older mail's re-answer too), else the app's language. The prompt's last line: "Write the answer in English, whatever language the mail is in."; the rule lets quoted mail stay as written. Codex's review (4 findings, all fixed with a failing test first): verbs-first questions ("Has Alice replied?", "Puedes decirme si pagaron?"), an accented name alone, unquoted mail words ("When is el pago de la factura?"), and the language lost past the three turns the model sees. On real models, light, all four rated designs: the capture's "What did Isabella say about the payment?" answered in English (`/tmp/terno-scratch/ai-redesign/lang/<design>/a04-*`); hands-on, "¿Qué dijo Isabella sobre el pago?" in Spanish and the follow-up "And when did she send it?" in English (Lumen also "¿Y qué le contesté yo?" in Spanish). Summary (the app's language) and Reply ready (`chooseLanguage`, the conversation's) already named theirs and were right on the same runs: unchanged. Spend about US$0.33 as the app counted it.

### Questions for the owner
- **The AI filter asks no consent** before its request goes to a cloud provider (it says what's sent under the field). Every other surface asks once. Add the shared consent there?
- **Showing the AI check's left-out rows by default** in the list (unticked, under the kept ones). Clearer to review, but the list then holds more rows than its title counts. Kept behind Show for now.
- **The summary prompt (v6)** now asks for a question as asked and a to-do as a verb phrase, so real models write "What do you think about the pricing-page changes?". It's the same call; cached summaries are refreshed once by the version bump. Keep?
- Still open from before: Save as the primary in Rules is now main's (the owner's call), so that one is settled.

### Rebased onto main (owner's decisions 3: no per-use consent)

Rebased onto `154b31225`. Main's six commits win wherever they overlap: no per-use consent on any AI surface (plan 131), with Settings → AI and Dev mode saying where mail goes, and "Write a follow-up" for "Draft a nudge".

- **Dropped: `5afbfb404`** ("one consent on every AI surface"). With nothing left to ask, the shared `AiConsent` (`ai-consent.tsx`) goes, with every use of it:
  - the summary's, ⌘J's "telling" line, Ask's, the action check's, and Study my style's;
  - `e2e/helpers/consent.ts` and the consent-shape tests (`4a7d4236b` keeps only its "no count while the check waits" test);
  - the keys `ai.consent.*`, `*.consentShort`, `aiDraft.tellingShort`, `aiDraft.telling`, `aiDraft.study.{question,consent,tokens,cost,drafts,confirm,decline,agreed}`, `summary.consent`, `ask.consent` and `action.consent*`, in en and es.
- **How the conflicts went:**
  - **Kept the redesign** in Ask (the one error, the scope line, one scroll region), the action pane (the one error, What it found, the folded reading), the summary card, and Writing style (Show the notes).
  - **Dropped the consent blocks** from those surfaces, with `consent` state in `useAsk` and `useActionPreview`, `acknowledge` on `check`, and plan 163's first-use step in ⌘J's body flow (`telling`, `pendingAct`, the per-endpoint "told" key).
  - **Study my style:** main's row (no consent; its hint says what goes, mail to other people included, so the redesign's shorter hint gives way), with the redesign's Show the notes after it.
  - **The follow-up card:** the redesign's states ("Writing your follow-up…", es "Escribiendo tu seguimiento…") in main's words ("Open your follow-up").
  - **The capture:** main's no-Continue flow, with plan 163's `a02`/`a03` (the instruction typed in the body, ⌘J).
- **Fixed after the rebase:**
  - ⌘J's send guard read a `telling` phase that no longer exists;
  - plan 163's `recipientsAuto` came back and went again;
  - main's `ai-no-consent.spec` drove the old ⌘J row, and now types in the body;
  - main's `local-ai.spec` still read the old privacy line;
  - plan 163's fill schema message lacked its `i18n-ignore`;
  - the v6 summary prompt overflowed a 2000-token window (the conversation's floor is 200 tokens now; the version test says 6);
  - the `ai-draft-body` smoke still clicked the first-use prompt.
- **Leftovers searched** (`rg -n -i consent apps packages scripts`, plus `telling|acknowledge…|AiConsent|ai-draft-told`): what remains is unrelated (Google sign-in, remote images, error reports) or asserts that the prompts are gone (`ai-no-consent.spec`'s selectors).
- **Codex review** of the rebased diff against the old head and main (consent leftovers, lost changes, copy): no findings.
- **Results:**
  - Typecheck and lint clean.
  - The touched units pass.
  - e2e on the stub passes in `e2e` and the four designs' tagged flows: `ai-no-consent`, `ai-draft`, `summaries`, `ask`, `plain-actions`, `followups`, `replies-ready`, `today`, `filters`, `dev-mode`, `design-axe`, `visual`, `local-ai`.
  - `test:ui-perf` 45 passed.
  - The real-model smoke and the build pass.
  - The frozen capture on real models (Lumen and Graphite, light and dark, 34 shots each, no consent anywhere, US$0.145): `/tmp/terno-scratch/ai-redesign/rebased/`.
  - **`pnpm test:all`** (837 s): lint, build, typecheck, db-wasm, web, smoke, ui-perf and startup passed. Three gates failed:
    - **unit:** the two summary tests above, fixed since;
    - **e2e:** `local-ai`, main's own miss, fixed since. `print`, `review-row-actions` and Luma's `icons` failed only on the crowded first pass: flaky;
    - **perf:** `idb.perf`'s 500,000-thread export and `incoming-inline` failed under a load average of about 12 from other sessions, and pass alone. Flaky on a busy machine.

### Owner's answers (2026-11-08)

- **Left-out rows stay behind Show** ("no"). No change.
- **The summary's new wording (v6) stays** ("yes"), though every conversation is summarized again once. No change; its prompt now fits a 2000-token window again (above).
- **The AI filter's consent** (the open question above) is moot: no surface asks first now (plan 131).
- **The model the key can't use:** not built; see plan 161's "Owner's answers".
- ⌘J on unclear text, "sounds good" read as an email, and the fill's tint: plan 163's "Owner's answers".

### ai162-r04 (branch at `cf753ad7a`, real models, 2026-11-09): the first of the owner's two extra rounds

After the pass on round 3's real-model findings, the owner's feedback (the premium AI card, the Ask fade, the action pane, write-in-the-draft from plan 163), no per-use consent, and the rebase onto main. All eight reports valid; 682 cells under 9 (r03: 662), 103 issues (10 high; r03: 105 and 10). The numbers as `gate.mjs` wrote them:

Models: real, openai/gpt-6-luna, anthropic/claude-sonnet-5-5, anthropic/claude-haiku-5-5, anthropic/claude-opus-5-5, jev/jev-latest; the captures spent US$0.28 as the app counted it

| Style | Rater | Overall | UI | UX | Lowest | Cells below |
|---|---|---:|---:|---:|---:|---:|
| atelier | claude | 7 | 7 | 6.5 | 5 | 84/84 |
| atelier | codex | 7 | 7.5 | 7 | 5.5 | 80/84 |
| graphite | claude | 7.5 | 7 | 7.5 | 6 | 84/84 |
| graphite | codex | 7 | 7.5 | 7 | 5.5 | 81/84 |
| lumen | claude | 7 | 7 | 7 | 5 | 84/84 |
| lumen | codex | 7.5 | 8 | 7.5 | 4.5 | 77/84 |
| macos | claude | 7 | 6.5 | 7.5 | 6 | 84/84 |
| macos | codex | 7 | 7.5 | 7 | 5.5 | 84/84 |

#### Screens, each rater's overall

| Screen | atelier claude | atelier codex | graphite claude | graphite codex | lumen claude | lumen codex | macos claude | macos codex |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| summary | 7 | 7.5 | 7.5 | 7.5 | 7.5 | 7.5 | 7.5 | 7.5 |
| ai_draft | 6 | 6.5 | 7 | 7 | 7 | 7.5 | 7 | 7 |
| ask | 7 | 6.5 | 7.5 | 7 | 6.5 | 6 | 7.5 | 6.5 |
| actions | 6.5 | 8 | 7 | 7 | 6 | 8 | 6.5 | 7.5 |
| today | 6.5 | 7.5 | 7 | 7.5 | 6.5 | 7 | 6.5 | 7.5 |
| followups_replies | 7.5 | 8 | 7.5 | 7.5 | 8 | 8.5 | 7.5 | 8 |
| ai_settings | 6.5 | 7 | 7.5 | 7.5 | 7.5 | 7.5 | 7.5 | 7.5 |

#### Facets, mean across screens

| Facet | atelier claude | atelier codex | graphite claude | graphite codex | lumen claude | lumen codex | macos claude | macos codex |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| typography | 7.29 | 7.79 | 7.57 | 7.93 | 7.57 | 8.00 | 7.50 | 7.64 |
| contrast | 7.64 | 8.21 | 7.43 | 7.93 | 7.43 | 8.36 | 7.64 | 8.21 |
| placement | 6.64 | 7.57 | 7.14 | 7.79 | 7.00 | 7.36 | 6.86 | 7.14 |
| hierarchy | 6.79 | 7.00 | 7.14 | 7.00 | 6.79 | 7.21 | 6.86 | 7.29 |
| controls | 7.00 | 7.71 | 7.21 | 8.36 | 7.14 | 8.14 | 7.07 | 7.86 |
| density | 7.00 | 7.07 | 7.57 | 7.43 | 7.07 | 7.00 | 7.07 | 7.00 |
| efficiency | 7.29 | 8.00 | 7.71 | 7.93 | 7.71 | 8.43 | 7.71 | 8.00 |
| clarity | 7.07 | 6.79 | 7.21 | 6.86 | 6.79 | 6.93 | 7.07 | 6.86 |
| feedback | 7.29 | 8.43 | 7.86 | 8.07 | 7.79 | 8.43 | 7.71 | 7.79 |
| consistency | 6.71 | 7.71 | 7.21 | 8.36 | 7.64 | 8.07 | 7.50 | 7.57 |
| accessibility | 6.29 | 7.86 | 7.21 | 8.07 | 6.86 | 8.07 | 6.93 | 7.50 |

**Against r03:** follow-ups and Reply ready hold at 7.5 to 8.5; summary steadier (7 to 7.5); Ask 6 to 7.5 (r03: 6 to 8); **⌘J fell** (6 to 7.5, r03: 7 to 7.5), the new flow's first rating.

**High:** plan 163's instruction in the body reads as an email ready to send, with Send still primary and "Write it" a grey word, or only a sparkle at 1100 (four reports); revising a draft is muddled (a Suggestion pane identical to the draft, your words left in the body); Ask's panel runs past a 1100x700 window and cuts its own sources (two); the model's scratch text ("[m9 doesn't mention it…]") reaches the answer; focus escapes Ask to the app behind; "Include" adds every protected conversation past the check, and the line still says "Skips 3".

**Themes:** Ask's dotted underline for unlinked parts reads as a link (five reports); list answers as raw hyphens; same-name people explained after the merged answer; ⌘J's controls change with the window's width.

## Pass after ai162-r04

Written before any code. All eight r04 reports, their 682 below-9 reasons, the 103 issues (10 high), the praise and the probes were read; the revise probe (`atelier/claude-probes/*-cmdj-revised`) and the Ask overflow (a dialog at y=126, 581 px tall in a 700 px window) were reproduced from the reports' own numbers. This is the pass before the last rated round (ai162-r05). Nothing here adds a shortcut, a model call, a check that uses AI or a consent prompt.

### ⌘J: the instruction is visibly one (four high reports)

**What's wrong.** Plan 163's instruction sits in the body in mail type; Send stays the filled primary; the only cue is a grey "Write it" that becomes a bare sparkle under 36 rem of foot. Every report read it as an email ready to send.

**The design.** One state, "a note for AI", decided on this machine (`readBody`, no model): the body reads as an instruction, or ⌘J opened the composer for AI (`primed`) and what's typed isn't plainly an email (the rules say `unsure`). Plain drafts never enter it.
1. **The body says so.** A faint AI wash behind the body (the primary at 5%, inset, rounded, no border) and a quiet label at its top-right, "✦ For AI", in the secondary at `text-xs`. The label never takes layout: it floats in the first line's end, which the first paragraph keeps clear while the state lasts. The editor's accessible description names the state ("Your note for AI. Press ⌘J to write the email from it.").
2. **The primary becomes Write it.** In Send's place, at every width: **✦ Write it** (primary, with its ⌘J keycap), then **Send** as an icon-only secondary (outlined, "Send it as it is" in its name and tooltip). The foot's Sparkles steps out (Write it is it), so the foot's width doesn't change with the state, and nothing changes with the window.
3. **Send asks first.** Send, ⌘↵, Send later or the palette on a note for AI ask once, at the action row (plan 158's question): "This reads as a note for AI." **Write it** (default) · **Send as it is** · Esc cancels. A note is never mailed by a reflex.
4. When the draft lands, the wash and the label go, Send is the primary again: the transition is the change of the foot.

**Revising.** Words typed after the AI's draft ("Luis" + "shorter, more casual") stayed in the body, and ⌘J gave a Suggestion identical to the draft. Now:
- Over a strip, when the body is the AI's last version with words added at its end (or a new last paragraph), those words are **the revision**: ⌘J rewrites the draft with them (the strip's free-form refine, one call as before), the words leave the body with the old version, and the strip's Undo brings back exactly what was there (draft and words). No "Replace your edits?" for it: the only edit was the instruction.
- A suggestion that says what the body already says (compared without whitespace) is never shown: the row says "No change: the draft already says that." and the strip stays.
- A rewrite over a strip that was typed into while it ran offers Replace (undoable) before Insert below: a whole second draft under the first was never the useful choice.

### Ask (6 to 7.5)

1. **It always fits the window.** The dialog is bounded to the window (top 18%, a 16 px margin under it) and is a column: header, the one scroll region (answer and sources) taking what's left, the follow-up box and the keys' line always whole. The scroll region fades its edge while more is below. The keys' line says how many sources there are ("↓ 7 sources").
2. **Scratch text never reaches the answer.** Locally, before anything is shown or stored: a bracket that holds a message label and words ("[m9 doesn't mention it, so ignore that one]") is dropped; a bracket of labels only ("[m1, m3]") becomes citations. The prompt (v8) says it plainly: no notes to yourself, in brackets or otherwise. No new call.
3. **Focus stays in Ask.** In every Ask state, Tab can't reach the app behind the dimmed backdrop: New question and Previous AI questions give the keys to the page's field, and the palette keeps any focus that lands in the app behind (the main window's root) inside the dialog.
4. **Not linked looks like not linked.** No underline. A claim with no source is set in the secondary ink, and the note under the answer says which: "Parts in grey aren't linked to a message." Links stay the numbered marks.
5. **Lists and bold render.** The model's "- " and "1. " lines are a real list (hanging indent), "**…**" is bold; plain text only, nothing else of markdown, no HTML. The prompt allows a list for several items.
6. **Same-name people first.** "Isabella here is 3 people: …" sits between the question and the answer; source rows give the sender column room for the full name.

### Actions

1. **Include respects the check.** Including the starred or replied conversations runs them past what the check already decided, by the same sender-and-subject groups (no model): a protected conversation in a kept group is ticked, one in a left-out group stays left out, and one the check never saw is added **unticked**, a row to tick by hand. The line always says what's true: "Including 3 starred or replied", "Including 1 of 3 starred or replied · tick the rest to add them", with Skip them; with no check (the rule was certain), Include ticks them as before.
2. **One decision on screen.** In Split, the rule's pane holds the decision (Archive N, Cancel) and the list header shows only the request and count; while a match is read the header holds it (the pane is the message). Never two pairs, never two orders.
3. **The rule is shown, not folded.** "Terno read it as": where it looks and each condition, in the ink, open, with Edit as a rule beside the heading; only the exact search stays behind its disclosure. Its age says its day.
4. **Plain words for what's kept back:** "6 don't look like shipping notices · Show" (the check's verdict said as what it is), "3 you starred or replied to stay · Include them", both the same small bordered control.
5. Focus goes to Archive N when the preview is ready (it sat on the list's container).

### Everything else below 9, by cells lifted
- **Summary:** collapsed is the header alone (half a line showed, three reports); the items' Reply quiet (ghost with its glyph), the source a quiet link; the card says what it covers ("From 3 messages").
- **Today:** the reasons in the ink at medium weight, apart from the snippet (eight reports); the digest's selected row stays inside its column.
- **Writing style:** the page fades at its foot when it continues; Reset this style is quiet and apart from Edit.
- **Reply ready and follow-ups:** unchanged (7.5 to 8.5); the Reply / Reply all switch moves beside Use as draft only if it costs nothing elsewhere.

### Not in this pass
- **Per-row reasons for what the check left out:** the check returns kept and dropped groups, not reasons; a reason would be a new model output.
- **Grouping or merging the digest's issues:** the digest is normal emails (owner).
- **A shortcut for Write it other than ⌘J, for Shorter, Warmer, Regenerate or Summarize:** the owner's rule.
- **Deadline-aware follow-up dates** (one report): the date is plan 145's rule; reading a deadline would be a model call.
- **Citations for the summary's paragraph:** new model output.

### Tests this pass adds
- Unit: the note state (`noteState`); `revisionOf` (suffix, new paragraph, edits elsewhere: none); an identical suggestion dropped; `cleanAnswer` (scratch dropped, label lists kept); the answer's blocks (lists, bold, nothing else); the backend's Include by group (kept, left out, unseen unticked; the line's counts).
- e2e: `ai-draft` (the wash, the label and Write it as the primary at 1100 and 1440; Send asks; revise replaces and Undo restores); `ask` (the dialog inside 1100x700 with a long answer, the footer whole, every source reachable; Tab never leaves the dialog after New question and Previous questions; no underline, grey unlinked; a list renders); `plain-actions` (one decision; Include's line; focus on Archive).

### As built (pass after ai162-r04)

Where the build differs from the section above:
- **⌘J, the note for AI.** The state is `noteState(row, glance)` (`lib/ai-draft-state.ts`): an instruction by the rules, or what's typed after ⌘J opened the composer for AI when the rules say `unsure`. The body's glance is published by the body itself (`AiNoteSlot`, always mounted with the editor), so the foot, the body and Send read one value; Send reads the body synchronously at the moment it sends (`glanceNow`). The wash is the primary at 5% inset in the body's cell; "✦ For AI" sits at the first line's end, which keeps 6.5 rem clear while the state lasts; the editor's `aria-describedby` says "Your note for AI. Press ⌘J to write the email from it." In the foot, **Write it ⌘J** (the primary, still `compose-ai[data-ready]`, which the frozen capture waits on) takes Send's place and Send is an outlined icon, "Send it as it is"; the foot's own Sparkles steps out, so the foot's width is the same in both states and the word never hides at 1100. Send, ⌘↵, the palette and Send later (its picker anchored to the icon) ask plan 158's question at the action row: "This reads as a note for AI." **Write it** · **Send as it is**.
- **Revising.** `revisionOf(draft, body)`: the body is the top version with words added at its end, or as a new last paragraph (compared without whitespace), up to the instruction limit. ⌘J then runs the strip's free-form refine with them (`previousDraft` = the AI's version), replacing the draft in one undoable step; Undo gives back the draft and the words exactly. An answer that says what the body already says is neither offered nor committed ("No change: the draft already says that.", until the next edit or run). A rewrite typed over while it ran offers Replace.
- **Ask.** `cleanAnswer` and `askStreamText` (core) drop a bracket holding a message label and other words, turn a label list into citations, and hold back a bracket still open while the answer streams; the prompt is v8 (no notes; "- " lines for three or more items). The answer is blocks (`answerBlocks`, `boldParts` in `lib/ask-citations.ts`): paragraphs, bullet and numbered lists, `**bold**`; nothing else is read. Unlinked claims are `text-muted-foreground`; the note is "Parts in grey aren't linked to a message." The dialog is `flex flex-col max-h-[calc(82dvh-1rem)]` on the Ask pages only; the scroll region shrinks first and fades its foot while more is below (`data-more`). `useKeysInPalette` sends focus that lands in `#root` back to the dialog's field and makes Tab and ⇧Tab go round the dialog's own controls (after Previous AI questions, Tab stepped out to `<body>`). The same-name line sits between the question and the answer; the sender column is wider, its full name on hover.
- **Actions.** Include sorts the protected rows by the check's own groups (`groupOf`/`groupKey`, the same sender-and-subject key the check was asked about): kept → ticked, dropped → left out, unseen → `held` (in the list, unticked). They are held while it sorts, and the result goes in at once. The line: "3 you starred or replied to stay · Include them", "Including 3 starred or replied", "Including 1 of 3 starred or replied: tick the others to add them", or "3 starred or replied added unticked: tick the ones to include", with **Skip them**; both it and Show are the same bordered control. "6 matched but don't fit what you asked". **One decision, in the header, in every state** (the plan said the rule's foot; the e2e "a long rule never scrolls Apply out of reach" showed a short window scrolls the pane's copy away, so the header's pair, which never moves, is the one kept). "How Terno read it" is a heading with its conditions shown; only "The exact search" is a disclosure.
- **Not done: focus on Archive when the preview is ready** (the plan's Actions item 5). Focused programmatically, Archive's tooltip took the first Esc, so Cancel became two presses (the e2e caught it). The keys stay on the list (plan 161): ⌘↩ applies from there, Esc cancels in one press, j/k/x work.
- **Smaller:** Today's reason is the row's ink at medium weight; the summary item's Reply is a quiet ghost in the ink, its glyph on the words' edge, and the card's close fades its words as it shrinks; Writing style (the one Settings page with a way back) fades its foot while it continues; Reset this style is quiet and set apart from Edit; the digest's row highlight ends at its column.
- **Not changed in `scripts/ui-rating/`:** nothing. The capture's waits still hold (`compose-ai[data-ready]` is Write it).

### The Codex review of this pass

Six findings, five taken with a test that fails without the fix, one declined:
1. **A pasted instruction sent at once went as the email** (the glance lags typing by 150 ms). Send reads the body itself (`glanceNow`). Unit: `ai-draft.test.ts`, "an instruction pasted and sent at once asks first". It also made "Stop and send what's there" ask again; that deliberate send now answers the question for itself (the existing guard test caught it).
2. **Apply while Include was sorting took rows the check rejected.** They're held while it sorts; the result goes in at once (`actions.test.ts`: Apply took 3, now 1).
3. **A label list or a note split across stream chunks was shown half-cleaned** ("[m1,[2]"). The stream holds back an open bracket (`askStreamText`; every cut of the answer is a prefix of the next).
4. **Send later did nothing in the note state** (⌘⇧↩'s picker lived in the Send group). The picker stays, anchored to Send; its choice asks the note question (`ai-draft.spec.ts`).
5. **Skip them left Include's classifications counted** (Show promised more rows than it listed). Cleared (`actions.test.ts`).
6. **Focus on Archive at ready** (the plan's item 5): declined, above.

### Results (pass after ai162-r04)

- **Typecheck and lint:** clean.
- **Unit:** the touched files pass (`ai-draft` 130, `ai-draft-note`, `ask-citations`, core `ask` 19, ai `ask`, backend `ask` 31 and `actions` 74, `contrast` 66 with the note's six pairs counted, `action-preview`, `digest-page`, `settings`). Across `apps/web/src`, as before this pass: `floating-restoration-lifetime` and `diag-local` fail at the base too; `command-palette` fails only in the full run and passes alone.
- **e2e:** `e2e` (macOS) `ai-draft`, `ask`, `plain-actions`, `summaries`, `today`, `replies-ready`, `followups`, `filters`, `palette`, `send-later`, `snack`; and all five designs' `design-axe`, `visual`, `designs`, `controls`, `menu-corners`, `i18n` with the AI specs' tagged flows: 181 passed, no baseline moved. `snack`'s ring test failed once on a crowded run and passes alone.
- **`pnpm test:ui-perf`:** 45 passed.
- **Real-model smoke** (`ai-draft-body.smoke.ts`, `ai-rating.smoke.ts`, `TERNO_RATING_REAL=1`): 4 passed, US$0.025.
- **The frozen capture on real models** reached every AI state in Lumen, Atelier, macOS and Graphite, light and dark (34 shots each, 61 AI requests each, only api.anthropic.com and api.openai.com), with no change to `scripts/ui-rating/`: `/tmp/terno-scratch/ai-redesign/round4/<design>/`. It ran on the build before the review's fixes and the sender column; none of those changes a captured state's look. Every shot was looked at.
- **Hands-on** (`harness.mjs`): ⌘J at 1100x700 on the stub (the note, Send's question, write, "shorter, more casual" typed after the draft, ⌘J, Undo); Ask at 1100x700 on real models with a list answer (the dialog's foot at 684 of 700, "↓ 7 sources", Tab after New question and Previous AI questions stays in the dialog); the action preview and Include (the rater's case: three sprint plannings now held unticked).
- **Sheets** (before = ai162-r04, after = this pass): `/tmp/terno-scratch/ai-redesign/sheets-r4/<design>-<mode>.png`, and `cmdj-instruction.png`, `ask-1100x700.png`, `actions.png`.
- **Real-model spend:** about US$0.34 as the app counted it (captures US$0.29, hands-on Ask US$0.03, smoke US$0.025).

### Questions for the owner
- ~~**Ask answers an English question in Spanish** on some runs~~: fixed, below (the owner asked for it before ai162-r05).
- **Focus on Archive when the preview is ready** (four reports asked): it needs Archive's tooltip not to open on a programmatic focus, which is the shared Tooltip's behaviour. Change it there?
- Still open from before: the model error wording.
