# 205 · App-wide fixes from Relief's UI rating

## Request (verbatim)

> do the 2 siggestions to go higher.
>
> For the app-wide issues I want you to fix them so the rate of the UI increases. When you're done with them, also as part of these fixes, do a side-by-side comparison of the old UI, the current UI, and the UI after you do the app-wide fixes (so I can see what exactly changed, with arrows pointed at them). After you've done that run another round of rating

The two suggestions are Relief's own (plan 204: a light dark-mode Send, firm selections). This plan is the app-wide part: what the raters of rounds `relief-r01` and `relief-r02` marked down in every style, not only Relief.

## What's chosen, and what isn't

Picked by how many low cells each costs, in both raters, and left out where an owner decision already says otherwise.

| # | Finding (both rounds) | Cells |
|---|---|---|
| 1 | At 1100×700 the reply's opening scroll leaves the message header above it half under the context line (the sender's name cut) | reply_draft placement 5.5–6, accessibility, typography |
| 2 | "“isa” isn't an email address" in red while a contact's name is still being typed, beside valid suggestions | new_message clarity 5.5–6.5, feedback 5.5–6, hierarchy |
| 3 | A reply open in the conversation, yet the toolbar's Reply · Forward stays at full weight, and the drafts strip lists the draft that's open on screen | reply_draft hierarchy 5.5–7, clarity 6.5 |
| 4 | The toolbar's Reply opens a Reply / Reply all choice on group mail, with nothing saying it will | split_inbox / conversation controls 7.5 |
| 5 | The row menu's Move to has no key, where the bulk panel and the palette show V | row_menu consistency 6–6.5, efficiency |
| 6 | Search's count chip starts left of the rows' text column and touches the first result | search placement 6.5 |
| 7 | A collapsed message in a conversation says nothing of being unread or carrying an attachment | conversation feedback 7 |

**Not changed, by owner decisions:** the rows' height (airy rows, plan 169/174), a focus line under the composer's fields (removed by the owner), category dots rather than chips (plan 194), the soft light selection in the other styles (plan 173). **Not in this series:** a missing-subject check, list layout's column structure, multi-select's checkbox column, the toolbar's icon grouping: each is a feature or a redesign of its own.

## Design

1. **Never half a header (reader-scroll.ts).** `keepSubjectWhole` already carries a composer's opening scroll past the subject when it would cut it. It becomes `keepHeadsWhole`: the subject and every message's header (`message-header` / `message-toggle`) are kept whole against the line the scroll lands on (the scroller's top plus its scroll-padding-top, the context line). A head the scroll would cut is scrolled past entirely when the room allows, as the subject is; never short of what the composer needs.
2. **An entry still being typed isn't wrong yet.** The recipient field's text holds what's being typed as its last entry. Validation (`firstInvalid`) runs on committed entries only while that field has focus and the entry is the one under the caret; Send itself, a blur, or a comma still validate everything (Send's `recipientProblem` is unchanged). The drafts strip and Send's tooltip read the same function.
3. **One active reply surface.** While an inline reply or forward is open in the conversation shown, the toolbar's Reply · Forward group draws quiet (the ghost look, no fill or border; still there and still R / F), and the drafts strip leaves out the draft that is open on screen (its count and names; with no other draft, the strip hides).
4. **Reply that asks says so.** When the toolbar's Reply opens a choice (more than one recipient), it carries a chevron, as menu buttons do.
5. **Move to's key in the row menu**: V, as in the bulk panel and the palette (the same command's shortcut).
6. **The count on the rows' line**: search's count chip starts at the rows' text column (their inset), with 8 px below it.
7. **A collapsed message shows its marks**: the unread dot (the list row's) before the sender, and a paperclip by the date when it has attachments.

## Tests

Each fix with a test that fails without it, at the lowest level that can catch it: `reader-scroll.test.ts` for 1 (a head straddling the line after the opening scroll); a unit test for 2 on the validation function and an e2e that types a name with suggestions open and sees no error until commit; e2e for 3 (toolbar group quiet while a reply is open, strip without the open draft), 4 (chevron only on group mail), 5 (the menu's keycap), 6 (the chip's left edge on the rows' text column, the gap) and 7 (dot and clip on a collapsed message). Baselines that show these surfaces update, in every design, and are looked at.

## Perf

No new work on a hot path: the head check reads a few rects once per opening scroll; the strip filters a handful of drafts; validation does what it did, on fewer entries.

## Out of scope

The items under "Not changed" and "Not in this series".

## Revisions after the Codex review of the plan

Eleven points; all taken. What changed:

1. **Fix 5 is dropped.** The row menu's Move to and V are different commands by the owner's decision (plan 127: V opens the category picker in move mode; the submenu holds folders and Gmail tabs). Showing V there would advertise what the submenu doesn't do.
2. **The drafts strip keeps the open draft.** Plan 175 counts every draft so the strip's height never changes with navigation; leaving out the open one would hide and show the strip and move the inbox. Fix 3 is the toolbar alone.
3. **Fix 2 separates showing from sending.** `firstInvalid` stays strict: Send's readiness and `recipientProblem` refuse an invalid entry as before. What changes is only what's *said* before Send: the drafts strip's line and Send's tooltip don't name the entry the person is still typing. The field publishes that entry (its text under the caret, uncommitted, in a small non-persisted store keyed by draft and field); a comma, Enter, Tab, blur or Send commits it and the message comes back if it's wrong. Middle-chip edits count as typing too.
4. **Fix 3 keys on the editor that's actually on screen** (the inline composer rendered and open, not just a draft key), and quiets the toolbar's group by its own classes at that call site (the ghost look: no fill, sheen, shadow, border or dividers), never by changing `ButtonGroup`'s defaults.
5. **Fix 4:** the chevron goes inside Reply when `everyone !== null` (the condition that already opens the choice), its width reserved so Reply's place doesn't move (reader.spec's position check, plan 173), and the toolbar's fit re-runs when it changes (`toolbarSet`). With the words hidden at narrow widths, the chevron stays beside the glyph.
6. **Fix 1 covers Lumen's single-message sender card** as well as `message-header` and `message-toggle`, and only for scrolls that pass `wanted` (composers, the AI strip), as `keepSubjectWhole` does now. Tests: nonzero top coverage, too little room, both motion paths.
7. **Fix 6** names its branch once measured: the compact header's count line under the field (Relief, Graphite, macOS) vs the rows' text column; if they already share the inset, only the gap below changes.
8. **Fix 7** reads the message's own `isRead` and `hasAttachments`, says both to screen readers (localized, as the list row does), and its test collapses the unread message before dwell marks it read.
9. **Perf:** the head check runs inside the opening scroll's frames (at most a few, ≤ 134 ms) over the conversation's message heads; the recipient store updates only from the field's own input events and is read by the strip line and Send's tooltip alone. The draft-typing and navigation perf gates run.
10. **The comparison and the rating** are deliverables: the same capture harness (`scripts/ui-rating/capture.mjs`) at three commits (round 1's `002cdccdf`, round 2's `4655c1034`, and the commit after these fixes), the same screens, viewports and modes, side by side with arrows on what changed; then round 3 with the gate.

## As built

- **1** `keepHeadsWhole` (reader-scroll.ts) over every `data-reader-head`: the subject (wholly past the pane's top, as plan 158 had it, and only if it was whole before), each message's header and Lumen's sender card (past the context line). A first version carried the subject only past the line, leaving a sliver; `compose.spec`'s Lumen check ("a subject not whole is wholly gone") caught it, and the unit test now says the same.
- **2** `recipient-typing.ts`: a non-persisted store of the entry under edit per draft and field, published by the recipient field from its own changes only, cleared on blur, unmount and a refused Send. `shownInvalid()` is what the strip and Send's tooltip say; `firstInvalid()`, Send's readiness and `recipientProblem` are unchanged. One new string (en, es): "Finish the recipient you’re typing to send", when the typed entry is all that stands in Send's way. The field finds its draft from `[data-draft-key]`, as compose.ts already does.
- **3** `useInlineComposerOpen` (inline-draft.tsx): true only while the slot's editor is open; the toolbar's Reply · Forward group goes to the ghost look by its own classes then.
- **4** The chevron inside Reply on group mail, its room kept as padding on a one-to-one so Reply stands where it does; `toolbarSet` re-fits when it changes.
- **6** Measured: the count's text already started on the senders' line. The "chip" the raters saw was plan 203's Settings-search mark (`[data-found]`, a global rule) painted behind the count, which has carried `data-found` since plan 158. The mark is scoped to Settings rows (`[data-setting][data-found]`), and the compact header's count line has 8 px below it.
- **7** A collapsed message's unread dot (in the column's margin, so every name stays on its line) and paperclip, said to screen readers with the list row's own strings.

## Revisions after the Codex code review

One finding, fixed with a test that fails without the fix: at the tightest toolbar (no words, a ~421 px reader with a Gmail tab's conversation and Summarize), the chevron's kept room pushed Reply · Forward past the reading column. With no words, Reply is the plain 32 px square and the chevron goes (the menu it opens still names itself); `reader.spec` narrows the reader for real until no word fits and checks the row ends on the column's edge.

## The comparison and round 3

`/tmp/terno-scratch/compare/out/`: six cards, each one region of the same capture at round 1 (`002cdccdf`), round 2 (`4655c1034`) and now (`023f5f908`), arrows on what changed. Built by `cards.py` from the rounds' own shots, so screens, sizes and modes match.

What the "now" capture doesn't show: at 1100×700 with a long draft open, the sender's header above it is still under the context line. The opening scroll can't clear it without pushing the composer's Send row out of the window, and the scroll keeps Send. Fix 1 holds where the room allows (the unit tests); this capture is the case where it doesn't.

Round 3 (`relief-r03`): Claude 6.5 (UI 6.5, UX 7, lowest 5.5), Codex 7.5 (UI 7.5, UX 8, lowest 6; 9 cells at 9 or more). Still below the bar. What's left is mostly the rows' density (an owner decision), unread rows' weight, the sidebar's step off the list (1.13:1 light, 1.04:1 dark), and collapsed messages and the reply bar sharing the reader's surface.

Perf, on a quiet machine: inline reply's first frame 36.5 ms max (≤ 50), its expansion 115.9 ms (≤ 133); typing beside 2,000 drafts 8.3 ms p95 (16).
