# Plan 158, the composer and drafts

Part of [plan 158](158-ui-rating-nine.md): the screens `reply_draft` and `new_message`.

## The request

> 1. Send is always reachable. In a reply (`13-list-draft-open` has Send's bottom edge at 963 px in a 900 px window when typing starts right after `r`), the composer's action row stays visible at the bottom of the reader pane while the draft is taller than the view, and the opening scroll finishes even if typing has started. In every layout and at 1100x700. Keep enough conversation context in view: don't scroll the subject away if it can be avoided.
> 2. The composer starts quiet. The formatting bar is collapsed by default behind the existing Aa control, in replies and new messages, and remembers the user's choice. Everything stays reachable. Fewer controls at rest in the From, To and action rows where you can.
> 3. One truthful draft state. A saved reply stays attached to its own thread: coming back to the thread shows the same Draft bar and the row keeps its Draft mark, rather than a plain Reply control with the draft elsewhere. Draft and strip stop disagreeing, and the list doesn't jump when the strip changes (j/k must never move the row being aimed at). Read the draft plans first (`docs/plans/`, search for drafts-strip and the pinned draft): undo, recovery and the never-lose-work rules are hard requirements.
> 4. The drafts strip takes less of the inbox: with several drafts, at most one line plus a count that expands. Keep what the strip can do. It must also look deliberate and aligned with the rows.
> 5. Errors go where the problem is: "Add a recipient" appears at the To field and clears when the composer closes. A failed send doesn't leave an empty draft behind. Send reads as unavailable when it can't send yet, while still explaining why on click.
> 6. Details: all field values on one line (From, To, Subject values share an x position, and a chip doesn't double the To row's height until it really wraps). New message doesn't show its subject twice: a compact label, with the subject in its field. The reader column doesn't jump when a scrollbar appears.

## What exists, and why a reply left its thread

Plan 44 retires a draft's place when the reader leaves its conversation: a cached association must not show authored text on a thread that may since have been merged or reused, so only an explicit open (which checks the source) brought it back. That safety was right, but it also took the row's mark and put the draft in the strip, which is the disagreement the raters saw. The strip sat above the rows, so its arrival on `j` moved them.

## Design

**A draft's home.** `draftHomeThread(d)` is where a draft shows or, once it has left, the conversation it left. It feeds only the row's mark and the strip's decision, never the display of text. `shownDraftKey` is unchanged, so plan 44 holds: text appears after a check.

**The check on arriving.** `returnDraftsTo(threadId)` runs when the reader arrives (a layout effect, before the slot paints): for each written draft whose home is here, one `drafts.sourceContext` point read, then `returnDraftToThread`, as the one line it was put away as, in one store write with no save and no focus. A draft the check turns away gets `homeLost`: the row loses its mark and the strip has it, words intact. While the check runs the slot is empty (`returning`), neither a blank Reply nor the draft. It stands aside for an explicit open (`openingStored`, `intent`), which does its own check, and a change under an open would call that open off. A pinned draft and one with AI work are left alone (the AI one has its own return, §10.4). No draft here costs one map read, which matters on `j`.

**The strip** moves to the list's foot, level with the sidebar's foot: one line (the draft Esc just came back from, else the newest) and a `+N` count that opens the rest upward. Under the rows, nothing it does moves one: the list only gets shorter at its end. The message being written isn't in it: it's on screen. The snack dock stands on it (`useSnack.lift`), in Split.

**Send reachable.** The foot (format bar and action row) is `sticky` in the reader's scroller, with what's written fading under it. `Expand` clips with `overflow: clip`, since `hidden` makes a scroller of its own, and takes `min-w-0` for it. ProseMirror's `scrollThreshold` and `scrollMargin` read the foot's height, so the caret stays above it. `keepInView` takes `wanted`: only the fields and first lines have to come into view, so the subject stays when it can, and a key typed into a field no longer stops the opening scroll.

**Quiet.** The format bar is closed unless opened (`terno:format-bar`). A reply's From row steps aside while it goes from its conversation's account (a `From` toggle; it shows by itself otherwise). Cc, Bcc, Subject and From toggles come up with the row, hovered, written in or under Tab. Pin joins Discard and Collapse in the action row. Send loses its keycaps and chevron: the shortcut is in its tooltip.

**Errors.** A refused send is said by `FieldProblem` at the field (`role=alert`, `aria-describedby`), gone when the field changes or the form closes. It's refused before anything is saved, so it leaves no draft. Closing a draft with nothing of the user's in it (`nothingWritten`) leaves nothing behind, including a saved copy; an editor that can't be read counts as written. Send is `aria-disabled` when it can't send yet, and a click still says why.

**Details.** Chips' text sits on the value line (the field reaches 6 px left for the pill), and an empty input takes only 24 px beside a chip. New message has a compact, constant label; the subject is in its field. The reader's scroller reserves its scrollbar's gutter.

## Deliberately not done

- **Forward over a put-away reply still converts it** (with Undo). A rater wanted a separate draft; a conversation showing one draft is plan 07's model, and it's not one of the decisions here.
- **The new message's card still hugs its text,** rather than filling the pane as raters asked: that's plan 130's request from the owner.
- **Cc and Bcc stay in the Tab order:** every control is keyboard-reachable, and removing them from it would need a shortcut nobody asked for.
- **A forward holding its source's files isn't discarded on Esc:** an attachment can't be told from one the user added.
- **After a reload** a reply stored as open opens as it was: nothing has been left, and position survives.

## Revisions after the Codex review

Round 1 raised eight points. All were real, and all are fixed with a regression test:

1. **Words typed while a save was out could be deleted without Undo.** Emptiness was read before the discard waited for that save. `discardIfEmpty` asks again after it, and keeps the draft, autosaving, if anything came meanwhile (`leaveNewDraft` also if it was opened again).
2. **Esc cancelled a file on its way.** Nothing referred to it yet, so the draft looked empty. `closesEmpty` counts an upload as written, and an untouched new message's plain forget does too.
3. **An old answer could reattach a draft a save had since changed.** The answer now holds only for the draft as it was asked about (identity, generation, revision, account, mode, source). Otherwise it's asked again.
4. **An answer could close the editor in Review drafts.** Arrival returns a cancel, called when the reader leaves or the question changes.
5. **A draft hydrated late was in neither place:** Reply in the reader, not in the strip since its home is listed. The reader's effect also follows `comingHomeKey`, so it finds what arrives.
6. **The caret could fall behind a pinned card.** The caret's clearance adds the scroller's padding for what covers its end. This test also showed the first version counted the dock twice: sticky already stops at a scroller's padding, so the foot needs `bottom-0`.
7. **The link bubble could cover Send.** `bubbleBounds` flips it above the composer's foot in the reader, as under a draft's own scroller.
8. **Send looked ready during an upload.** It reads as unavailable, and its tooltip says why.

Removing each fix in turn (points 1 to 5 and 8, at unit level) found two weak tests and one the reader's cancel was hiding, all tightened, and one dead check, a recovery test the reader's cancel already covered, removed.

Round 2 raised seven points, all fixed:

1. **A discard read the draft a few ticks before deleting it.** It reads again in the tick that deletes.
2. **A shared lookup could answer for a source that had since moved.** Each arrival asks for itself; a draft on a conversation is rare enough that the extra read costs nothing.
3. **Two opens of one strip item:** the first's end cleared the second's protection. `openingStored` counts. No test of its own: it takes a re-render landing inside that gap, which the harness can't arrange without changing the code.
4. **A draft with AI work had no way out if its source moved:** its own return now loses the home too.
5. **Esc on a new message with a file on its way** kept the draft but gave focus no item to land on. The strip counts it as written.
6. **Aa under an open link bubble** raised the foot over it, and over the caret's line, which the test for this found. The bubble follows the foot's size, and the caret scrolls clear when the bar opens.
7. **Send looked ready while files were being prepared,** before staging. `useFilesOnTheirWay` covers preparing, queued and staging.

Stopped after two rounds, per the review cap: what's left is the same kind of narrow timing these rounds were finding. Each fix's test was checked by removing the fix, except point 3's and the e2e-level ones (round 1's 6 and 7, round 2's 6), which were seen failing before their fix.

**Found on the way, not touched:** `r`, typing and ⌘J, then Enter, with no pause between them: the AI draft ignores the typed words and the text is gone from the body. It fails the same way on the base commit (`ai-draft.spec.ts`, "the choice at the send") when the machine is idle. It's plan 133's code, so it's reported rather than fixed here.
