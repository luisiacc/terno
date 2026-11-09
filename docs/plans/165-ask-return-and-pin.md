# Plan 165: back to the answer, and a pinned answer

- **Status:** being built on its own branch (`t3/ask-return-pin`), on the redesign branch (plan 162); never merged by the builder.
- **Builds on:** plan 141 (Ask), 161 (Back to the answer, the source shown in Ask), 162 (Ask's look), 115 (the pinned draft), 145 (Back to the digest).

## The request

The owner, 2026-11-09, verbatim:

> "for the 'ask ai' thing, i like it a lot, i wonder if its easy to go back to that search because the user will click one one then go to another source most likely, so it should be easy to come back, also maybe we should have a way to pin it? it would be pinned on the bottom right, and it needs to play along when pinning a draft message at the same time, the ai box should move to the left so the draft occupies its space."

With a screenshot of Ask's answer: numbered citations, ten sources, "Ask a follow-up…", New question and Previous AI questions.

The brief adds: coming back is one obvious step, to the same answer, its scroll kept, the source opened marked as visited; no new keyboard shortcut; an icon-only pin in Ask's header makes the answer a compact floating card at the reading pane's bottom right (collapsible; question, scrollable answer, sources; a source opens in the reader while the card stays; unpin back to the dialog; close dismisses); a pinned draft keeps the corner and the card moves to its left, without overlap at 1100x700 and up, with a written rule for narrow panes; motion within the cap; keyboard and screen readers; axe-clean.

## What exists

- **Ask** (`components/ask-page.tsx`, state in `lib/ask.ts`) is a page of the palette dialog. Its conversation lives in a store outside the dialog (`useAsk`), so closing Ask stops nothing, and **⌘⇧K comes back to the last conversation for 30 minutes** (`returning()`, `ASK_RETURN_MS`).
- **A citation or a source row shows the message inside Ask** (`lib/ask-peek.ts`, `PeekView`): Back to the answer (Esc) returns to the answer with its scroll and the chosen row kept (the conversation stays mounted under the peek). **Open message** (Enter) opens it in the reader (`openSource`): the dialog closes, the conversation opens at that message, focus goes to it.
- **In the reader, "Back to the answer ⇧⌘K"** (`components/ask-return.tsx`) sits above the conversation a source opened, as "Back to the digest Esc" does for a newsletter the digest opened (plan 145; `state/today.ts`). It reopens Ask on that conversation however long ago (`backToAnswer`). Leaving that conversation takes the link away.
- **What's lost on the way back:** the dialog unmounts when it closes, so reopening it puts the answer region at the last turn's top, not where it was read to; and nothing says which sources were already read. With ten sources, the user going through them one by one has to remember which.
- **The pinned draft** (`components/pinned-draft.tsx`, `lib/pinned-draft.ts`, `lib/pinned-draft-state.ts`): a card at the reading pane's bottom right (12 px from its edges, `w-[min(32rem,100%-1.5rem)]`, `max-h-[min(70%,40rem)]`), in Split's reader pane and in List's one pane. It publishes `inset` (its height plus margins) so the reader, the list and a new message pad their scroll end by it; where the pane can't hold it beside the snack dock (bottom left, 30 rem) it stands on the dock. Session state only.

## The design

### 1. Coming back

The way back is already one step (Back to the answer in the reader, ⇧⌘K anywhere, Esc from a source shown in Ask). What's missing is coming back to **the same place**:

- **The scroll is kept.** The answer region's scroll is remembered per conversation (`askScroll`, a module object: the React Compiler note) as the user scrolls, and restored when the conversation mounts again, unless a new answer has arrived since (then its top, as now).
- **Visited sources are marked.** A source shown in Ask or opened in the reader is *visited* for that conversation (`useAskVisited`, session only, the last 20 conversations). Its row shows a quiet check after its date, and its sender and subject go to the secondary ink, as a visited link does; its citation's number is unchanged (the number's job is to match its row). Screen readers hear it: the row and the citation's names end with ", opened". The pinned card's rows are the same.
- **No Esc in the reader for it.** The digest's Esc goes back to a page in the same pane; Ask is a dialog, and Esc never opens anything in Terno. The link keeps ⇧⌘K, Ask's own key (no new shortcut). In List layout, Esc still closes the page.

### 2. Pin

- **Where:** an icon-only Pin button (`ask-pin`, the draft's Pin glyph, a tooltip "Pin answer" / "Keeps it open at the bottom right while you read the sources.") in Ask's header, before the ×, while a finished answer shows (not while one streams, not on a source shown, not on a command's outcome). Pinning closes the dialog and the card appears; focus goes to the card's answer (programmatic, no ring), as pinning a draft focuses the draft.
- **What it pins:** that answer, as it is: the conversation's id, its last turn and its sources' states (a copy; `usePinnedAsk`). A follow-up or a new question in Ask doesn't change the card; pinning again replaces it (one card, as one draft).
- **The card** (`components/pinned-ask.tsx`, `pinned-ask`): `bg-popover`, `rounded-xl`, `shadow-popover`, `w-[min(24rem,100%-1.5rem)]`, `max-h-[min(60%,30rem)]`, the draft's entrance (fade and 1 px rise at `duration-base`).
  - **Header (40 px, the draft's):** Sparkles, the question (one line, truncated; its title attribute holds it whole), then three icon-only buttons with tooltips: Collapse/Expand (`ChevronDown`/`ChevronUp`, `aria-expanded`), Unpin (`Pin`, pressed, as the draft's Unpin), Close (×).
  - **Body (scrolls; tabbable):** the answer with its citations (the same `AnswerText`), Copy and "Written with AI", then the sources under their count, as compact rows (number, sender, subject; the date in the tooltip), the visited mark as in Ask.
  - **A citation or a source row opens the message in the reader** (`openSource` without the reader's Back to the answer: the card is the way back), and the card stays. Focus stays in the card, so the next source is one Tab or click away. A source in Spam or Trash asks twice, as in Ask (said under the answer).
  - **Collapsed:** the header alone. The choice is the card's (session).
  - **Esc** in the card gives focus back to reading (the list, or List's page), as the draft's does; the card stays.
- **Unpin** brings the conversation back into Ask (`openConversation` if Ask holds another, which stops one still answering there, as opening one from the history does) and opens the dialog on it; the card goes. **Close** removes the card; the conversation is in Previous AI questions. Deleted (here or in another window), cleared (Clear AI data), or Ask turned off: the card goes.
- **Session only, per window.** The pinned draft doesn't survive a restart either, and a card that comes back on launch over mail the user isn't reading would be a surprise.
- **Scroll ends:** the card publishes its inset as the draft does; the reader, the list and a new message pad by the larger of the dock's, the draft's and the card's (`pinnedInsets`).

### 3. With a pinned draft

The draft keeps the bottom-right corner. The card goes:

- **Beside it, to its left**, when the pane holds both and 20 rem for the card: its right edge 12 px left of the draft's, its width what's left (up to 24 rem). At 1440 in List layout and on wide Split panes.
- **Above it** otherwise (a 1100x700 window's reader pane is ~530 px; the draft takes it all): the same right edge, its foot 12 px over the draft's top, its height what's left above the draft (down to its header). Where less than 140 px is left, it shows collapsed (its header), whatever its own choice; Expand there is disabled with the reason in its tooltip. The card never covers the draft.
- **The snack dock:** the card stands on the dock when they'd meet (the draft's rule), beside the draft or alone.
- **Moving:** `right`, `bottom` and `max-height` change with `transition-[right,bottom] duration-base ease-motion`; with motion reduced or off the durations are 0 (the `--motion` tokens).

## Tests

- **Unit** (`lib/pinned-ask.test.ts`): `pinnedAskPlace` (the layout rule: alone; beside at wide panes; above, with the room left; collapsed under 140 px; on the dock); pin copies the turn and closes the dialog; a follow-up doesn't change the card; unpin opens Ask on the pinned conversation (`openConversation` only when Ask holds another); close; the card goes when its conversation is deleted, AI data cleared, Ask turned off. `ask.test.ts`: visited marks (shown and opened; per conversation; bounded), the scroll kept per conversation.
- **e2e** (`e2e/ask-pin.spec.ts`, on the fake model, one page through `scenario()`): Back to the answer comes back at the scroll it left with the opened source marked; pin, a citation and a row open the reader while the card stays, the row marked; collapse and expand; Esc in the card; unpin back to the dialog on the same answer; close; with a pinned draft at 1440x900 (beside, no overlap) and 1100x700 (above, no overlap, collapsed where there's no room); axe on the card in light and dark.
- **Screenshots on real models** (harness `ai: true`), Lumen and macOS, light and dark: the answer, a source opened with the way back, the pinned card, the card with a pinned draft, the card collapsed, a small window. `/tmp/terno-scratch/p164/ask/shots/`.

## Perf

Nothing on a hot path: the card mounts only while pinned; its layout is measured by a ResizeObserver on it and its pane (no polling, no timers); scroll memory is one number per conversation written on scroll.

## Out of scope

- Following up from the card (Unpin, then ask: the dialog is where questions are asked).
- Keeping the card across restarts.
- More than one pinned answer.
- A new shortcut to pin, unpin or focus the card.
