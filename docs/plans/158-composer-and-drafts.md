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

**Found on the way, fixed in the second pass:** `r`, typing and ⌘J, then Enter, with no pause between them: the AI draft ignores the typed words and the text is gone from the body. See below.

## Second pass (the owner's decisions)

> 1. A data-loss bug comes first: pressing `r`, typing, ⌘J and Enter with no pause makes the AI draft ignore the typed words, and they're gone from the body. Never lose the user's words.
> 2. Small windows: at 1100x700 a reply gets too little writing space and is cut off. When a reply opens at a short height, the composer gets at least about 40% of the pane for writing, with its action row visible, by scrolling or folding what's above rather than clipping the card.
> 3. Sending: a spinner until sent, then a check. Undo send, if it can be done safely on what exists, on by default at about 5 seconds, with a setting. The rule that matters most is that mail is never lost or sent twice.
> 4. Which account is sending: show it quietly in the existing rows, with the full From row one click away.
> 5. Keyboard: Tab goes To → Subject → body, with Cc and Bcc on ⌘⇧C and ⌘⇧B and their visible buttons, named and with tooltips. Targets on frequent controls at least 24 px.
> 6. States: a disabled Send still reads clearly, a saved state is quietly visible ("Saved" near the action row, not a toast), an invalid recipient says in words what's wrong. Pin, collapse and discard have names you can see, and a clearer meaning at rest if the icon alone doesn't say it.
> 7. Type: composer text uses the same size, width and leading as the message above it. Field edges and focus are visible, and the formatting bar's well is visible in dark.

**The words.** An open waiting for its source holds what's typed in a hidden field (`prepareEarlyComposeInput`), and the lease owns that field. ⌘J began a second open, which released the first lease, and that removed the field with the words in it; the second open then found an empty body, and the AI wrote from nothing. Anything else that ended the open lost them too: a click away, Esc. Now `stop()` hands what's still there to `strand`: into the draft if it's known, else `strandedWords`, by conversation, for the next draft landing there (the open that's still going, when the click only took its focus). They always go to the body, whatever the next open's focus is for, and only a reply takes them. With no open left they become that conversation's draft, put away, as a moment later they would have been (`keepStrandedWords`), so they're saved like typing. `place()` gives back what it couldn't insert. ⌘J also goes along with an open on its way (`composeOpening`), which had silently turned a Reply all into a Reply. Only a window closed in those milliseconds loses them.

**Undo send.** Plan 94's scheduled sends already had what this needs, so it's built on them: a durable row, one timer, and a fence in `queueSend`'s transaction, which also deletes the row with the draft. `compose.hold` is a schedule of `UNDO_SEND_MS` on the backend's clock. Undo is `scheduled.cancel`, deleting that row: the send and the Undo serialize on it, so exactly one wins and the mail can't go twice or be lost. The stored draft stays until the send goes, so Undo reopens exactly what was saved (`openDraftById`); after it's gone Undo finds no row and says so. What makes it a hold rather than a schedule is only in memory (`holds`): it isn't in the snapshot (nothing "scheduled" flashes up), and holds have room beyond the scheduled cap; past that it goes as a plain send, with no Undo. One that couldn't go (`store.scheduled.fail`) stops being a hold: it's listed, saying why, and is a scheduled send from then on. After a restart a hold is just a row that's due, and goes first. A quit sends it now, through `quiesce`, within the send deadline: otherwise a message sent a moment before ⌘Q would wait for the next launch. The setting is `undoSend`, Settings → General. The client's copy of the moment is only for the snack: its timer drops the Undo and the spinner goes on until `actions.send.sent` replaces it, or takes the dock at once if that result is already waiting. The spinner gives up after a send's own 30 s deadline (offline, a long retry); the result still comes when it comes. Undo from the pinned card puts the draft back on the card, with the reader where it is. Reveal: the send's message doesn't exist yet, so the reader goes to the next sent copy arriving in that conversation (`revealHeldSend`). e2e runs with it off, except where it's the point.

**Short windows.** Below 820 px of window height the body's minimum is 40vh. `composerWanted` asks for the whole card when the pane can hold it, else down to 40% of the pane's worth of text with its foot. The body's bottom padding is now what the foot's fade covers, so at rest nothing is faded.

**Which account.** `from Personal` in the To row, with several accounts. It's the From toggle: a click opens the row. Subject comes up with the row and takes no room at rest, or a chip would wrap for it.

**Keyboard.** Cc and Bcc have `tabIndex=-1` and `compose.cc`, `compose.bcc`. Subject's and From's toggles stay on the Tab path (they have no shortcut). Quoted text uses the reader's `QuoteToggle`, words and all. This supersedes "Cc and Bcc stay in the Tab order" above.

**States.** Unavailable Send is an outline in the muted ink: a faded primary read as nearly active. `FieldProblem` shows for an invalid chip as soon as it's a chip (`onInvalid`), never for what's being typed. "Saved" is said aloud, "Saving…" only shown. Collapse is the word Close, named Save and close.

**Type and edges.** `text-base` on the body overrode each design's leading: it's gone. `.rt-measure` holds the children to the reader's 35em in a full-width box, so a click beside a short line lands in the text. A focused text field marks its row with a line in `--ring`; the label no longer changes. `--draft-ring` is `--border` for tinted cards too, and `--format-bg` a mix of the ink, since `--tint` equals the card in dark.

**Deliberately not done.** A warning on an empty subject (a rater's; not among the decisions). The row's Draft label (the list engineer's), the new message's card height (plan 130).

### Revisions after the Codex review (second pass)

Round 1 raised six points, all real, all fixed with a regression test:

1. **Words stranded by Esc lived only in memory,** so a reload lost them. They become a collapsed, saved draft on that conversation.
2. **A new message over the conversation took a reply's words,** since it carries the selected thread. Only a reply takes them.
3. **A failed hold, rescheduled to tomorrow, was still a hold,** so a quit sent it today. A failure or a new time ends the hold.
4. **Undo from the pinned card lost the card and moved the reader.** It goes back on the card.
5. **A result arriving before the client's hold timer waited eight seconds behind a stale spinner;** a slower send lost its spinner early. The timer drains a waiting result, and the spinner lasts as long as a send's deadline.
6. **Holds had no budget.** Twice the scheduled cap; past it a plain send, never a refusal.

Round 2 raised five. Four are fixed:

1. **A quit could overwrite a hold another window had just moved to tomorrow.** `releaseHolds` asks again before each write.
2. **Words from conversation A stayed in memory if an open of B outlasted A's.** When the last open settles, every conversation's stranded words are saved.
3. **A look already reading could retire a hold made meanwhile,** which then showed as scheduled and waited out a quit. A look only judges the holds there when it began.
4. **`awaitingIn` kept expired entries.** Pruned on insert, as `revealSent` does.

Not fixed, per the review cap: two sends within five seconds, with the first's result arriving behind the second's Undo. At the second's expiry the first's check shows, then the second's own result follows. It's brief, never wrong about what was sent, and correcting it needs send-level correlation the op events don't carry for a hold. Stopped after two rounds.

## Third pass (ratings on `90d8de33`)

**Regressions.**

- *Send with nobody to send to "did nothing".* It did, but only with focus in the form: `compose.send` (⌘↵) had a binding and no handler, so after a click on the pane's blank space the key was dropped. It's now `sendShownDraft`: the focused draft, or with focus nowhere (no dialog or menu) the new message on screen. Each refusal is a new alert (`SendProblem.seq` keys it), so a second Send is said again.
- *An invalid address accepted silently.* The field said so; the strip didn't, so a draft put away like that read "To bad-address". It now says "— “bad-address” isn't an email address", in the destructive ink.
- *Reply focus went back to the response menu's trigger.* Base UI keeps focus the user moved elsewhere for `finalFocus` `true`, but a function's answer counts as explicit and is applied after the exit animation, whatever has focus by then. Dismissing the menu just before Reply took the composer's focus, and "Pr" of "Probe" went to the trigger and to `r`. `menuFinalFocus` (the shared dropdown and context menus) lets a function decide only while focus is the menu's, a trigger's, or nowhere. The thread menu and Review's menu did this by hand already.

**A new message is a page.** The card fills the pane (List: the page), fields at the top, Send at the foot; the empty page under the text writes at its end on a click. Its title is the pane's heading (`type-reader-subject`), as a conversation's subject is. While it's open the list's last open row has no fill (it still answers the pointer). macOS's drafts use the window's surface (`surfaces.draft: "outline"`), not a gray card that read as disabled. In dark the card's edge is a whole point of `--border` (a device pixel vanished); the token itself is the lead's.

**Save and close.** The visible label is the accessible one: "Save and close", "Guardar y cerrar". Its tooltip says the draft is kept as you write, with Esc.

**Pin.** One control (`DraftPin`) for the reply, the new message and the pinned card: its tooltip says "Pin draft" and what it does; on the pinned card the same pin shows pressed, in the accent, and unpins.

**Short windows.** A reply's text starts four lines tall and grows with what's written: the 40vh minimum below 820 px left a short reply a blank page and pushed the message it answers away. `keepInView` and `composerWanted` treat the reader scroller's `scroll-padding-top` as covered, so the sticky context line the reader adds when its header scrolls away (its height as that padding) never sits on the composer's top.

**Codex review (third pass).** Round 1 found two, both fixed with a test that fails without the fix: a second click on the empty page, with words selected, typed over them (`focus("end")` moves the caret only the first time; the page asks for `"last"`); and `menuFinalFocus` skipped a callback whose state it also clears (the thread menu's hand-off), so the next menu's Esc didn't return focus. The callback is now always asked; only its answer is overridden. Round 2 found nothing.

## Fourth pass (ratings on `e48f0f309`), with the palette and search

On round 3's ratings; the owner's decisions: take every real finding, ranked by the cells it lifts, regressions and lost words or position first; make two similar things one rather than adding; the search field's help is one Tab stop.

- **A new message holds its text.** Round 2 found the card half the pane, round 3 found Send 750 px under a short message once it filled the pane. Both are answered by a card whose text starts a third of the window tall (`max(132px, 34vh)`) and grows with what's written up to the pane, then scrolls under its fixed foot: Send sits just under a short message, and an empty one isn't a strip at the top.
- **Opened again, it resumes in its text.** From the strip, a new message with a valid recipient focuses its body at the caret the editor kept; To only while a recipient is missing or wrong (`resumeTarget`, for both the lease's published target and the pane's fallback).
- **Saved doesn't flicker.** "Saving…" at every pause in typing read as stuck in every shot. Within a second a draft saved before keeps "Saved" on screen (not said aloud: the live region speaks only an acknowledged save); a first save shows nothing yet; "Saving…" is for a save that takes longer. Tests wait on `data-status`, which is the save itself.
- **A short window never cuts the subject.** At 1100x700 the reply's opening scroll stopped 19 px down, a sliver of the subject under the toolbar and too little for the context line. `keepInView` stops with the subject whole when some of it would stay (less than its height held back; the foot sticks, so Send stays); the context line comes as soon as any of the subject has gone, with a short fade under it rather than a cut.
- **Details.** Send picks the first wrong address, which took the primary's fill and read as fine: it's ringed in the destructive ink, its fill kept. Cc and Bcc are 28 px on the same centre, the focused row's line 2 px.
- **Palette.** The open conversation's actions lead and Recent comes after them and doesn't take them, so Enter on opening is Archive whatever ran before. Reply all sits beside Reply where it reaches several people, as in the row menu. Two results alike (the demo's two "¿Vamos al concierto?") show what tells them apart, as their rows do: Draft and the account. The list may grow to 30rem where the window has room, so the places under the actions show.
- **Search.** The help's seven rows were seven Tab stops: a listbox with one stop, the arrows, Home and End, Enter types the row (the no-results help is the same component). Typing in Review changed nothing at all: a query now leaves Review, as the palette's search does. The count says "in all your accounts" (or the account searched), the field's own words, not "in saved mail"; the few-results note still says only saved mail is searched. "Match 1 of 3" is "1 of 3 in this conversation", its steps 28 px.

**Not taken, and why.** Another area's: the toolbar's Reply while a draft is open (the reader's), the sidebar's highlight during search and compose (the sidebar's), Esc out of Review, the row's Draft tag, the pinned draft's look, the row density in results (the list's). A different parking place for new messages and replies, and a sheet for compose: plan 130's and the inline-compose rule. The new message's title size: round 2 asked for a real heading. An exact count past 100 (the cap is the list's page). Operator autocomplete and scope chips: new features. The palette's selected-row fill in dark: a palette token (the lead's).

**Codex review (fourth pass).** Round 1 found two, both fixed: keeping the subject whole held back as much as a subject's height, and a subject of several lines in a short reader left the composer's fields out of view (now it holds back at most 40 px, else the scroll goes past all of the subject; a unit test fails without it); a long account name in a palette result took the subject's room and clipped the date (the account is bounded and truncates, the dates line up). Round 2 found two: the hold-back also applied to a message opening, which has no foot that sticks and lost its last lines (now only a composer's scroll, one with `wanted`, holds back; a test fails without it). Not fixed, per the review cap: a subject taller than the whole reader keeps the context line away until all of it has gone (the thresholds see no change while it fills the view). Stopped after two rounds.
