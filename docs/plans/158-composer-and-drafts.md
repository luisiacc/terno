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

Round 1 raised eight points. All were real, and all are fixed with a regression test, each checked by removing its fix:

1. **Words typed while a save was out could be deleted without Undo.** Emptiness was read before the discard waited for that save. `discardIfEmpty` asks again after it, and keeps the draft, autosaving, if anything came meanwhile (`leaveNewDraft` also if it was opened again).
2. **Esc cancelled a file on its way.** Nothing referred to it yet, so the draft looked empty. `closesEmpty` counts an upload as written, and an untouched new message's plain forget does too.
3. **An old answer could reattach a draft a save had since changed.** The answer now holds only for the draft as it was asked about (identity, generation, revision, account, mode, source). Otherwise it's asked again.
4. **An answer could close the editor in Review drafts.** Arrival returns a cancel, called when the reader leaves or the question changes. Lookups are shared per draft and source, so a cancelled arrival's question isn't asked twice.
5. **A draft hydrated late was in neither place:** Reply in the reader, not in the strip since its home is listed. The reader's effect also follows `comingHomeKey`, so it finds what arrives.
6. **The caret could fall behind a pinned card.** The caret's clearance adds the scroller's padding for what covers its end. This test also showed the first version counted the dock twice: sticky already stops at a scroller's padding, so the foot needs `bottom-0`.
7. **The link bubble could cover Send.** `bubbleBounds` flips it above the composer's foot in the reader, as under a draft's own scroller.
8. **Send looked ready during an upload.** It reads as unavailable, and its tooltip says why.

Removing each fix also caught two weak tests (fixed) and one dead check, a recovery test the reader's cancel already covered (removed).
