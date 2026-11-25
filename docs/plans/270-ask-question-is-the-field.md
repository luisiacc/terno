# Plan 270: Ask's question is where a new one is typed

- **Status:** being built on main.
- **Builds on:** plan 141 (Ask), 161 (its keys' line), 162 (Ask's look), 165 (Pin, a place kept per conversation).

## The request

The owner, 2026-11-24, verbatim, with a screenshot of an answer in Ask (the question in the header, Copy, Regenerate,
the scope line, one source, "Ask a follow-up…", and the keys' line ending in New question and Previous AI questions):

> "i think this ui can be improved to be more intuitive, i was about to try to do a new question and didn't know how, had
> to search for the 'new question', i kind of expected it close to the actual question, give me 5 variations to improve
> this ui here"

Five mockups were shown: (1) the question is the field, Spotlight's model; (2) New question and the history as icons
beside Pin; (3) the follow-up box with a Follow-up / New question switch; (4) a back chevron to an empty Ask; (5) a rail
of questions. The owner chose:

> "lets do your suggestion of 1 with the 2's plus button"

## What exists

- `Conversation` (`components/ask-page.tsx`) heads the page with a 44 px header: Sparkles, the question being answered
  (`ask-title`, a truncated `span`: `running?.question ?? turns.at(-1)?.question`), then `AskNav` (Pin while a finished
  answer shows, the way back when Ask was opened from the palette, ×).
- **New question** (`ask-new`) and **Previous AI questions** (`ask-history-row`) are quiet text buttons at the end of the
  keys' line, after a divider (`ask-session`, plan 161 pass 3 and plan 162), hidden while a source is shown. New question
  calls `newQuestion()` (`lib/ask.ts`): it stops an answer still coming and empties the store, so `AskQuestionPage` shows
  `Empty`, the palette's own field, focused.
- The follow-up box (`FollowUp`) keeps its words per conversation (`keepAskPlace`) and is focused on mount.
- Esc on the page is the palette's, in its capture phase (`command-palette.tsx`): `paletteKeys.escape` runs first
  (`closePeek() || stopAsking()`), then the palette steps back or closes.
- No new AI shortcut may be added (the owner's rule).

## Design

### 1. The question is the field

The header's question becomes a text field (`AskTitle`, `ask-title`), with the same words, size and place as now.

- **At rest** it reads as the title it was: no box, no ring, the text in the ink, truncated with an ellipsis, in the same
  place. Hover shows only the text cursor. No wash at all, focused or changed (the owner, 2026-11-24, twice: first on
  hover, then on focus): the caret, the selection and the hint show it has the keys.
- **Focused** (a click or Tab), the whole question is selected, so typing replaces it. Like a
  browser's address bar, a second click places the caret. At the end of the header, before the buttons, a quiet hint says
  what the field does: "Type a new question" while it holds the question, and "↵ New question" once it's changed. The
  hint is `aria-hidden`; the field's accessible name is "Question" and its description is "Change it and press Return to
  ask a new question."
- **Return** with changed, non-empty words starts over with them: `startOver(text)` in `lib/ask.ts` (`newQuestion()`
  then `askQuestion(text)`). It's the same as New question followed by asking, so an answer still coming stops first and
  the earlier conversation stays in Previous AI questions. Return on the unchanged question does nothing (Regenerate asks
  it again).
- **Esc** with changed words puts the question back and moves focus to the follow-up box. With the question unchanged,
  Esc does what it does today (stop, back, close). `paletteKeys.escape` asks the title first, only while it has focus.
- **Leaving it** (a click elsewhere, Tab) keeps changed words, with "↵ New question" after them, so nothing typed is
  lost. An emptied field gets the question back.
- **While a source is shown** (the peek), the field is read-only and keeps any changed words. **While Ask is off**, it's
  read-only. **While an answer comes**, it can be edited, and Return stops that answer and asks the new question.
- A follow-up asked from the bottom box changes the title, unless the field holds changed words.

**A new question starts clean.** Today New question always goes through `Empty`, which unmounts the conversation. Return
in the title keeps `Conversation` mounted, so its follow-up box would keep the old conversation's words, then save them
to the new one. `newQuestion()` therefore bumps a `started` counter in the store (outside `EMPTY`, like `gone`), and
`AskQuestionPage` keys `Conversation` on it. The new conversation mounts fresh: an empty follow-up box with focus (as
after asking from `Empty`), its scroll at the question.

### 2. New question beside the question

`ask-new` becomes an icon-only button in the header (`Plus`, `size="icon-xs"`, the Pin button's look), with a tooltip,
"New question". It comes first in `AskNav`, before Pin. It does what it does today (`newQuestion()`, the empty field
focused), and it's hidden while a source is shown, as now.

### 3. The keys' line

`ask-session` keeps only Previous AI questions, after its divider.

## Tests

- **Unit** (`lib/ask.test.ts`): `newQuestion` bumps `started`. `startOver` stops an answer still coming, asks the new
  question on no conversation, and does nothing for empty words.
- **e2e** (`e2e/ask.spec.ts`, in the ⌘⇧K test's existing page, one new `scenario`):
  - A click on the title selects it all, and the hint reads "Type a new question".
  - Typing shows "↵ New question".
  - Esc puts the question back, focus goes to the follow-up box, and the dialog stays open.
  - With words half typed in the follow-up box, typing in the title and pressing Return gives a new conversation: one
    turn, the new question in the title, the follow-up box empty and focused, and Previous AI questions holds both.
  - The header's + has the name "New question" and opens the empty field, focused.
  - The plan 161 assertions about the keys' line move: Previous AI questions is on the keys' line, and New question is in
    the header.
- `ask-title` assertions that read text move to its value (`ask.spec.ts`, `ask-pin.spec.ts`).
- axe: the existing Ask axe test covers the new field and button in light and dark.

## Perf and resources

None on a hot path: one input in place of a span, and one counter.

## UI rating

Ask is a rated screen (`a04-ask-answer`), so after the series, `pnpm ui:rate` and `pnpm ui:gate`.

## Out of scope

- The other clutter seen in the screenshot (the dashed "no source" mark, the scope line, two groups on the keys' line).
- A key that selects the title (no new AI shortcuts).
- The pinned card's title (plan 165) stays plain text.

## Revisions after the Codex review

Codex's critique of this plan (12 points) changed it as follows:

1. **The list's keys stay out of the title.** ↑↓, Home, End, Page Up/Down, Return and Ctrl+N/P/J/K typed in the title
   stop there, as in the shown source. Otherwise Return on the unchanged question opened the source chosen with ↓. The e2e
   test chooses a source with ↓ first, then presses Return in the title.
2. **IME:** the title's Return also checks `keyCode === 229` (cmdk's fallback). The palette's Esc capture already skips
   `isComposing`. Electron's Chromium sets it reliably, so the capture is unchanged.
3. **Esc's focus target:** at the turn limit the follow-up box is disabled, so Esc leaves the keys in the title (with the
   question back) rather than focusing nothing.
4. **While a source is shown, the title is plain text** (`ask-title-text`), not a read-only field. The field sat outside
   the peek's key guard and was still tabbable. `AskTitle` stays mounted, so its words come back with the answer, and its
   Esc never runs (it isn't focused).
5. **Typed words survive a close.** They're the conversation's `title` in its kept place (`AskPlace.title`), as the
   follow-up box's words are. They're read when the page mounts, so ⌘⇧K, Back to the answer and Unpin bring them back.
   Sending them clears them from the old conversation first, so it reopens on its own question. Words typed before the
   first answer has a conversation id aren't kept (the follow-up box behaves the same).
6. **The old conversation's place:** e2e reopens the first conversation from the history after a title Return and checks
   its own question and its half-written follow-up. cmdk's chosen row is saved only under a conversation id, and the new
   page mounts with none, so an old source value is never saved under the new id.
7. **The answer's own question shows** while the header holds other words: the first turn's heading (and a running
   answer's) stops being `sr-only` once the title has changed (`titleChanged`), so the answer is never read as an answer to
   the unsent words.
8. **The keys' line follows focus.** While the title has the keys, it says "↵ New question · esc Cancel" when the words
   have changed, and only the page's Esc otherwise. It never promises ↓ or a source's Return. The inline hint is
   therefore only "Type a new question" (focused, unchanged), plus "↵ New question" for changed words left there
   unfocused. The axe test types over the title and checks light and dark. e2e checks the field's name and description
   and the + button's name.
9. **Replacement during a stream:** a unit test resolves the stopped request after its replacement started, and sends it
   a late chunk. The new conversation is unchanged. The e2e Return path checks one turn and both conversations in the
   history (the first had finished, so it's saved).
10. **Real pointer:** e2e clicks the title once (all selected), then again (caret, no selection).
11. **Length:** the title has `maxLength = ASK_QUESTION_MAX`, and `startOver` refuses empty or overlong words before it
    stops or clears anything (unit test). Words are compared trimmed.
12. **Capture scripts:** `ask-new` stays the + button's test id, so `scripts/ui-rating/capture.mjs`, `apps/site/shots`
    and the demo script keep working. A click on it lands in the empty field, focused, as before.

## Codex code review

One round, 12 findings. Changes:

1. **A late history read** could replace the conversation the user had stepped back to, while its fields kept the other
   one's words. Opening from the history now reads only while the history is still showing, and `openConversation` ups
   `started` (another conversation is another page, so its fields mount fresh). Unit test.
2. **Ask turned off under changed words:** Return checks `readOnly` before clearing or sending, and the keys' line doesn't
   say Return. No test: the window hears its settings only through its own Settings, which closes the palette (the
   spec's "this window hasn't heard yet"), so the state can't be reached in e2e.
3. **Words typed before the first answer's id** are now kept once the id arrives, as the follow-up box's are. The Esc
   callback depends on `setDraft` too, so it writes to the current id.
4. **Ctrl+K and Ctrl+Shift+K off the Mac** go on to the app: the title stops Ctrl+N/P/J/K only on the Mac (cmdk's
   `vimBindings={isMac}`), and never with Shift.
5. **A source shown while the title had the keys** clears its focus state, so the keys' line doesn't stay in title mode.
6. **Narrow windows:** the field keeps at least 6 rem (`min-w-24`), and the hint truncates rather than taking it.
7. **Tab:** Chromium selects a text field's whole value when Tab or Shift+Tab reaches it. e2e checks Shift+Tab from +. No
   ring: like the follow-up box and the palette's field, the caret shows focus (the wash it had then is gone too).
8. **Esc on words that are no change** (the question again, or with a trailing space) is the page's, as the keys' line
   says. Such words also aren't restored on mount. e2e.
9. **The history's filter** went into the empty field that + opened. Opening a conversation from the history clears it.
   e2e.
10. **BoardUI's Input:** not used, on purpose. The title is an inline field in the palette's own idiom, like the
    follow-up box beside it and cmdk's input: no box, no label. The catalog's Input is a boxed form field.
11. **The unchanged-Return test** now checks a source row is chosen first, and that no source opened, after the later
    steps too.
12. **Spanish:** the axe test asks a question in Spanish and checks the field's name, description and hint, and the +
    button's name.
