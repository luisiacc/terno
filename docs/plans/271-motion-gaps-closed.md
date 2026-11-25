# Plan 271: the motion gaps closed (What matters' rows, Undo, the first send's handoff, Undo send)

## Request (verbatim)

> we need to do some work on small smooth animations to make the app feel nicer.
>
> use /emil-design-eng /animation-performance /find-animation-opportunities
>
> i think actions in the 'what matters',in the inbox, and when sending a message in a thread, or sending a message for the first time(when it waits for 5 seconds then it becomes the messag with the normal ui) and possibly other,s are re really good opportunities.

The sweep (find-animation-opportunities) came back with five places, and the owner: "ok lets do an implementation of those 5 opportunities you found and the things in the verdict" (the verdict: #1 first, #2 and #4 complete the Undo stories, #3 only after recording its handoff).

## What exists

- **One motion vocabulary** (plans 01, 195–198): every duration through the user's `--motion` (0/50/75/100 ms), nothing over 100 ms, nothing at all with motion off or reduced. `lib/flash.ts` holds the effects: `reflowRemoval` (rows leaving the listbox fade out as detached copies while the rest slide up: `[data-reflow] [data-thread-id] { transition: transform }` for one window), `armReflow`, and `arrive()` (4 px and a fade; `inPlace` without the fade where it replaces what was just on screen: the owner's rule after plans 196/199 flashed). `lib/morph.ts` (plan 251) runs a change as a view transition of `--motion`, gliding elements marked `data-morph` and cross-fading the rest.
- **What matters' rows** leave by `dropFeedRows` (`lib/feed-leave.ts`): Done, Remove, Later, and Archive/Trash/Spam in What matters (`leaveFeed`, `lib/actions.ts`). The feed (`components/what-matters/feed.tsx`) is virtualized: each drawn row is a slot `div[data-index]` placed by `transform: translateY(start)`, inside a `role="group"` div. `reflowRemoval` looks only for `[role=listbox]`, so the feed's rows vanished and every row below jumped up in one frame. Coming up's disclosure (`setComingUpOpen`, `state/today.ts`) reloads the list, and its rows appeared (or went) in one frame too.
- **Undo** brings rows back by reading the list again: `act`'s undo (`undoActions`), `leaveRows`' undo (`lib/actions.ts`), and What matters' `leaveFeedRows` undo (`lib/today-task.ts`). Plan 195's arrival leaves an Undo out on purpose (it only follows live mail), so the restored rows appeared and the rows below jumped down.
- **A new message's first send** (plan 182): `HeldNewMessage` shows it in the pane under its subject; when the backend reports the copy (`heldWent`), `openThread` swapped `HeldNewMessage` for `Reader` (`app.tsx`).
- **Undo send** (plan 182): `cancelHeldSend` (`lib/scheduled.ts`) cancels the hold, calls `cancelled` (which settled the card: plan 182's critique #7, "settle before reopening") and then reopens the draft (`openDraftById` → `openStoredDraft`, async).

### Recorded first (a throwaway e2e probe sampling the reader every painted frame)

- **The first send's handoff**: one painted frame with an empty reader (`selectedId` set, the conversation not loaded yet), then the conversation with its toolbar, an account line under the title and the reply bar all at once; the message itself landed **22 px lower** than the held one was (the title unmoved).
- **Undo send of a reply**: the card went; for about 4 frames the slot was the bare 40 px reply bar (the draft's `returning` wait); then the composer opened with its own designed growth (`Expand`, 0fr → 1fr on the drawer curve: a plain `r` grows the same way, 40 → 209 px over ~95 ms, so that growth is not the defect).
- **Undo send of a new message**: one painted frame of an empty pane between the held view and the composer.

## Design (as built)

One motion vocabulary, nothing new: the existing slide, fade-out copy and arrival, at `--motion-slow` (≤ 100 ms) on `--motion-ease`; the view transition at `--motion` on the drawer curve. Motion off or reduced: none of it runs (every helper returns on `motionNow() === 0`; the view transition isn't started).

### 1. What matters' rows move as the Inbox's do

- `flash.ts`: `armReflow(at: "list" | "feed")`, `stopReflow`, `reflowing(rows)`, and `leaveCopy(row)`, the fading copy `reflowRemoval` made, now shared: it starts where the row is **painted** (its computed transform, translate and opacity: a row still sliding from the last act doesn't jump), and nothing finds it as the row (every `data-thread-id`, `data-row-id`, `data-index`, `data-testid` and `id` stripped, `inert`, `aria-hidden`). The feed's group is `data-feed-rows`; `globals.css` adds `[data-feed-rows][data-reflow] > [data-index]` to the slide.
- `lib/feed-moves.ts` decides **by the feed's drawn keys** (rows and headings: `drawn()`'s), as the change is published (a store listener runs inside the change, before React draws it): what came, what went, what moved. It moves the feed only for a change an act made (`movingFeed(change)`, which `dropFeedRows` wraps its change in) or one motion is owed to (§2). Then it arms the feed's reflow and names the slots.
- `FeedSlot` (feed.tsx): a slot that stays slides; one drawn anew for a row that came (or moved: it wasn't drawn where it was) arrives (`arrive()`, with the fade: empty space); one whose row went leaves its copy from its layout cleanup (React runs it before taking the node off the page, as `HeldMessage`'s does). Anything else that mounts or unmounts a slot (a scroll, a measurement) is simply there or gone.
- More than 50 slots changing at once: no motion (a big change isn't a moment to watch).

### 2. Undo's rows come back as they left (Inbox and What matters)

- `state/list.ts`: `moveNextRows(ids)` owes motion to **the next answer that changes this list's rows by bringing back one of `ids`' conversations**, within 2 s, in the same list (`movesOwed`, `movesPaid`). Owed to an answer, not to one read: the backend's own news of the change can refresh the list before the Undo's read does.
- The Inbox pays it in `reloadList`'s commit (`rowsChange`: the conversations it brings, how many go): it arms the list's reflow before the commit and, after it, the rows that came arrive (`listArrival.play`). If the scroll anchor corrected the scroll (`restore()` now says whether it scrolled), the slide stops before it shows (`listArrival.stop`): the rows on screen didn't move.
- What matters pays it as its rows are published (§1): a Done row doesn't leave the feed's list of conversations, it goes to Earlier as the same row, so the Undo is owed by the rows of its conversations that came **or moved**.
- Callers: `act`'s undo and `leaveRows`' undo (their target conversations), `leaveFeedRows`' undo (its rows' conversations).

### 5. Coming up opens and closes the same way

`setComingUpOpen` owes motion to any change (`moveNextRows()` with no ids) before its reload: opening, its rows arrive while Earlier slides down; closing, they leave while Earlier slides up.

### 3. The first send becomes its conversation without an empty frame, and morphs

- `heldWent`, for a new message still in its pane (`openSentView`): the pane (`page.ts`, through `setHeldThreadOpener({ open, ready, letGo, morph })`, so the send path keeps its light imports) reads the conversation and **keeps it** (`keepOpening`, `state/threads.ts`: kept through a change as the open one is, marked stale) until it has opened; the held view stays ("Sending…") until the conversation holds the copy, 1.5 s at most (then it opens as before). The open runs inside `morph()`, and checks again there that the pane is still the held view (moved on meanwhile, the hold only settles).
- `morph(update, pairs)`: a pair is one thing on both sides of one change (the held message and its copy's `article`, `sent-message`). It glides and never resizes: named before only if wholly in view of its scroller, after only if there, wholly in view and the same size; its new picture shows at once (`morph-swap`: no blend of two pictures of one message). Unmatched (Lumen, whose one-message header is a card above the article), the whole change is still (`data-morph-still`: the new state at once), since a cross-fade doubled the message's words in a slowed recording.
- So, in the classic designs: the title holds, the message glides its 22 px with its date in place of "Sending…", and the reader's toolbar, account line and reply bar fade in.

### 4. Undo send: the card gives way to the draft in one change

`cancelHeldSend`'s `cancelled` now takes the hold back (`takenBack`, `held-sends.ts`): nothing can take it back again (plan 182's critique #7 stands), its send's own deadlines are retired, the reconnect catch-up skips it, and its card stays, busy, until a store change shows its draft (the composer's `compose`, its conversation's `draftShown`, or the pinned card's key naming a draft with its id): the card settles inside that change, so one frame has the card and the next the draft. Whatever the reopen does (kept in Drafts, failed), the Undo's end settles it.

## Tests

- `flash.test.ts`: the feed's window and `stopReflow`; the leaving copy painted where the row is, stripped of ids, inert, gone when faded.
- `state/list-moves.test.ts`: `rowsChange`; an Undo's motion owed only to the answer bringing one of its rows back, in its list, within its moment; Coming up's owed to any change, never to none.
- `feed-moves.test.ts`: an act's change moves; an unasked refresh doesn't; an Undo's only for its rows, once; more than 50 just appears; a Done row moved back from Earlier moves, and a slot drawn anew for it arrives.
- `threads.test.ts`: the opening conversation kept through a change, until let go.
- `held-sends.test.ts`: Undo won keeps the card busy and not retryable, its deadlines retired, until its draft shows, then gives way in the same change (reply's slot, new message's composer); never shown, the Undo's end settles it; the new message's pane waits for `ready`, then one morphing change opens it and settles; not ready, it opens as before; moved on during the wait or by the change's frame, it only settles.
- `motion.spec.ts` (motion on, recorded each painted frame): an Inbox Undo (the row arrives with its fade, the row below slides down); the first send (no frame without the message, `sent-message`'s group ran, nothing over 100 ms), and in Lumen (no frame without it, no transition: still); Undo send of a reply and of a new message (no frame of neither); What matters' Done (the row below slides up, the copy fades and goes) and its Undo (the row below slides down, the row arrives). The sweep's cap tests are unchanged and pass.
- Coming up has no e2e of its own: it is the feed's path with no ids (`feed-moves` and `list-moves` cover its decision).

## Perf

Nothing on a hot path. The feed's listener returns at once unless an act or an owed motion is on (one comparison per change); only then does it compute the drawn keys twice. Copies are made only inside an act's window (one per leaving drawn slot). The slide is a compositor transform; the arrival and the copies' fade are WAAPI on transform and opacity. j/k, scrolling and navigation never arm anything. The handoff waits for the conversation it would have fetched anyway.

## Out of scope

- The Undo send pill → "Sending…" → date swap in its own box (withdrawn twice by the owner: plans 196, 199).
- Plan 195's live-mail arrival in What matters.
- Other undo paths (categories, folders, rules' previews, the digest): `moveNextRows` is there for them when wanted.
- The last row leaving (and the first coming back) swaps the feed's group for its empty state: the copy goes with the group, as in the Inbox (plan 198's arrival covers the empty state).

## Revisions after the Codex review

1. **A slot's lifetime isn't a row change** (a scroll mounts and unmounts slots too). Taken: `feed-moves` decides by the drawn keys, per change, and only an act's change or an owed one moves.
2. **The last row**: the empty state replaces the group, and the copy goes with it. Left as the Inbox has it (plan 198 arrives the empty state). The disclosure's focus when the feed empties is older than this plan (out of scope).
3. **What matters needs its own diff** (`scope` is null there; a feed row isn't a listed conversation). Taken: the feed diffs its drawn keys; the Inbox's path is gated off in What matters.
4. **A scroll anchor's correction** would make the slide a movement that never happened. Taken: `restore()` reports whether it scrolled, and the slide stops. A feed hidden under the digest's column moving its rows is harmless (nothing shows).
5. **A Boolean on one read can miss the restoration or animate another change.** Taken: owed motion is keyed to the Undo's conversations and its list, for 2 s, and paid by the answer that brings one of them back.
6. **A second removal's copy jumps** (cloned at the target transform). Taken: the copy starts at the row's painted transform, translate and opacity.
7. **`loadThread` doesn't prove the copy is drawable** (null, superseded, or dropped by a change event while unopened). Taken: `ready` checks the cache holds the message, `keepOpening` keeps it through the backend's news (the recording caught exactly that: half the runs opened onto an empty reader), and 1.5 s bounds the wait.
8. **The morph's update runs a frame later.** Taken: the pane is checked again inside it.
9. **The pair's boundaries differ across designs.** Taken: a pair glides only if wholly in view and the same size on both sides, otherwise the change is still.
10. **A cross-fade can still double the message's words.** Taken, and confirmed by a slowed recording in Lumen: the pair shows its new picture at once (`morph-swap`), and an unmatched pair makes the change still.
11. **A subscriber settling on `uiState` isn't proof the draft shows.** Taken: it settles on the publication itself (`draftShown`'s key, `compose`'s key, the pinned key) naming a draft with the hold's id. A reopen that first moves to another conversation (the draft's source moved) still loses the card a beat early: rare, noted.
12. **The kept card's lifetime and focus.** Taken: its deadlines are retired, the reconnect catch-up skips it, and the Undo's end settles it whatever happened; focus goes into the composer as the reopen puts it there (as before).

## Also fixed on the way

`state/list.test.ts` and `state/threads.test.ts` had not loaded since plan 251 (7b19b9620: `state/today.ts` reaches `lib/appearance`, which reads the document at import). They run in jsdom with the `matchMedia` stub now, and pass.
