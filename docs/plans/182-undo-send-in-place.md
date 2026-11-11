# Plan 182: the sent message shows at once, with Undo on it

## Request (verbatim)

> When sending an email we have a countdown that they can undo as a chip below, a little thing on the bottom, and then it gets sent. I find this a bad UI.
>
> When it's sent I need to see the email I just sent immediately. I want to see it right away. I think the message should be displayed right away. Scroll to it if it's at the very end, and then the counter to undo it would be there somewhere.
>
> We need a good simple design that is clean and professional in there to undo that send and indicate that it hasn't been sent yet: some kind of subtle counter and a nice button to cancel the send. Canceling the send would just not send it but bring the draft back and show the draft again.
>
> Let's do this and account for any edge case that you might think of

## What exists

- **Undo send is plan 158's hold.** `send()` (`apps/web/src/lib/compose.ts`) calls `compose.hold`: the backend keeps the message as a scheduled row due in `UNDO_SEND_MS` (5 s), on its own clock (`ScheduledSends`, `packages/backend/src/scheduled.ts`). Undo is `scheduled.cancel`; the row's delete and the send's queueing serialize, so exactly one wins. The stored draft stays until the send goes; Undo reopens it (`openDraftById`). Unchanged by this plan.
- **The UI of the window is a snack** (`heldSendSnack`, `apps/web/src/lib/scheduled.ts`): "Sending…" with a spinner and Undo in the dock, then "Sending…" until the op's "Message sent". `z` runs the same Undo (`registerUndo`).
- **Nothing of the message shows during the hold.** The composer closes and the conversation looks as it did before the reply; the sent copy only appears when the backend queues the send (`queueSend` writes the local copy with it), about 5 s later. The reader then reveals it by guessing: the newest sent message arriving in that thread (`revealHeldSend`/`takeHeldSent`, `sent-reveal.ts`). The client never learns which message, or which thread a new message started.
- **A new message** is written in the reader pane (`NewMessage`); after Send the pane goes back to whatever was selected.

## Design

### What the user sees

**A reply or a forward, from a conversation.** On Send the composer closes and, in the same frame, the message appears at the end of the conversation as an open message: the same header family as every message (avatar, the user's name, "To …"), and the body exactly as it will be sent (the same HTML, signature and quote, through `HtmlBody`/`TextBody`, so it renders as the real copy will). The reader scrolls to it. Where a message's date sits, it says that it hasn't gone:

```
 (A)  Ana Pérez  ana@…                                    Sending in 4s
      To Bea Bustos                                              [ Undo ]
      Thanks, Bea. Thursday works for me.
```

- **The counter**: "Sending in 4s" in the date's muted xs type, tabular, turning each second on the window's own end. Words, not a drawn ring: a countdown ring would be a hand-built control (BoardUI has none), and words need no motion rule.
- **Undo**: BoardUI's outline button, `xs`, worded "Undo", named "Undo send", its tooltip with the `Z` key while `z` would run it. It sits under the status on the column's edge, where a message's actions sit. While the cancel is out it's busy (its own spinner). The card is otherwise quiet: no hover, no ⋯ menu, no toggle (it can't fold, it isn't a message yet).
- **When the time is up** the ring becomes the spinner and the words "Sending…". When the sent copy arrives in the conversation (by its id, see below), it takes the card's place in the same position, open: the date replaces the status. The card is never removed before the copy is there, so nothing jumps.
- **Undo** cancels the hold. If it wins, the card goes and the draft comes back where it was written (the reply's composer at the end of the conversation, focus in its text, as plan 158's Undo already does via `openDraftById`). If the message had already gone, the dock says so (`compose.undoSendTooLate`, as today) and the card carries on to "Sending…" and the copy.
- Screen readers: a polite status outside the counter says once that it hasn't gone and can be undone, then "Sending…"; the ticking figure is `aria-hidden`. The card is an `article` named "Your message, not sent yet".

**A new message.** On Send the pane shows the message the same way, under the new message's title (its subject, on the pane title's line, as `NewMessage` puts it): the card with its counter and Undo. When the send goes and the backend says which conversation it started, the reader opens that conversation, on the copy, in the card's place. If the user has moved on by then (opened something, started another message), it isn't opened over them.

**Where the card can't be seen.** The user may leave during the 5 s (open another conversation, close the page in List, send from the pinned draft card while reading something else, a forward whose conversation is closed). The window must stay reachable, so the dock's snack comes back for exactly that case: while a hold has no card on screen, the snack shows Undo for the time that's left (as today); when its card shows again, the snack goes. After the window, as today, "Sending…" in the dock until "Message sent" if no card shows it. `z` undoes the newest hold wherever the user is.

**Two holds at once** (Send, then another reply within 5 s): two cards, in the order sent, each with its own counter. **Undo send off**, a hold refused for room (`held: false`) or Send later: unchanged.

### How

- **The backend says where a hold went.** `ScheduledHost.send` returns `{ threadId, messageId }` (it is `queueComposeSend`'s answer), and `ScheduledSends` emits a new server event `scheduledSent { draftId, threadId, messageId }` after it queues any scheduled send (renderers only). Windows ignore draft ids that aren't theirs. This replaces the guess in `sent-reveal.ts` (`revealHeldSend`, `takeHeldSent`, `forgetHeldSend` go): the copy is found by id, through the existing `revealSent(messageId)`.
- **`apps/web/src/lib/held-sends.ts`** (new): this window's holds, a small zustand store keyed by draft id: what to show (account, from, to, cc, subject, the sent `bodyHtml`/`bodyText`, attachment refs), where (`threadId`, or null for a new message), when it goes (`performance.now()` deadline from `UNDO_SEND_MS`), its phase (`holding` → `sending`, or `undoing`), the `Undo` handle, and once known the copy (`{ threadId, messageId }`). Its own module: compose.ts records one, scheduled.ts's Undo uses it, the reader and the new-message pane read it. It owns the fallback snack: cards register while mounted (`useHeldCard(draftId)`), and a hold with none for a frame gets the snack with the time left; a card mounting withdraws it. One timer per hold (the end of its window) and the card's per-second tick only while a card is on screen; nothing runs after the last hold settles.
- **A held copy is done** when its `scheduledSent` came and either the copy is in the shown conversation's detail or the window it was shown in no longer shows it; a copy that never arrives here (a forward starts another conversation) settles after the existing reveal wait (10 s) and the card goes, the dock's "Message sent" saying the rest. Undo that wins removes it at once. A failure to queue after the window (`scheduled.fail`) makes the row a listed scheduled send that says why (plan 158): the hold's entry goes on the snapshot that lists it.
- **The card**: `HeldMessage` in `components/held-message.tsx`. To keep one header family, the open header's markup in `reader.tsx`'s `Message` is lifted into `MessageHead` (avatar, name, email, recipients, and a trailing slot that is the date for a message, the status for a held one). `Message` keeps its toggle, actions and body as they are. `Thread` renders the thread's held cards after `Conversation`, inside its hairline family (`hairline-b` like a message).
- **The reveal**: the reader scrolls to a held card when it first shows (`revealMessage` generalized to a selector, `[data-held-send=…]`), once per hold. The copy replaces it at the same place; `revealSent(messageId)` opens it (it would otherwise open anyway, being the newest).
- **The new-message pane**: app state `heldView: number | null` (a draft id). Send sets it with `compose: null`; `app.tsx` and `PageLayer` render `HeldNewMessage` for it where `NewMessage` was, and `pageOf` keeps List's compose page for it. Anything that changes the selection, opens a composer, or checks rows clears it (the subscription `installComposeFollowsSelection` already watches those). On the copy: if `heldView` is still that draft, `openThread(threadId)` and `revealSent(messageId)`. Undo clears it and reopens the draft as a new message.
- **Undo** runs through `cancelHeldSend` as now (`ownership()` decides whether the draft may take the user's place). It sets the entry `undoing` first, so the card's button is busy and a second press is a no-op.
- **i18n** (`en`, `es`): `compose.held.sendingIn`, `compose.held.status`, `compose.held.label`, `compose.held.elsewhere`, `compose.held.view`; the button reuses `common.undo`, its name and tooltip `compose.undoSend`.

## Tests

- `held-sends.test.ts`: a hold counts down from its deadline; turns `sending` at the end; the fallback snack shows only while no card is mounted and is withdrawn when one mounts; `z` and the button share one Undo; Undo that wins removes the entry, one too late leaves it `sending`; a `scheduledSent` for an unknown draft is ignored; the entry settles when its copy is shown, or after the wait; the new-message view opens the copy's conversation only while it's still shown.
- `scheduled.test.ts` (backend): `scheduledSent` is emitted with the queued copy's ids, once, for a hold and for a scheduled send; not for a cancelled or failed one.
- `compose.test.ts`: a held send records the entry (thread, sent body) and sets `heldView` for a new message; Undo send off, `held: false` and Send later record none.
- `sent-reveal.test.ts`: the thread-guessing helpers are gone; `revealSent` unchanged.
- e2e `compose.spec.ts` (Undo send on, where it's the point, merged into one `scenario()`): reply → the card is in the conversation at once, scrolled to, says "Sending in", Undo brings the draft back with its text; a second reply left to go becomes the copy in place (one message, no card). A new message → the card in the pane, then its conversation opens on the copy. Leaving the conversation during the hold brings the dock's Undo.
- Visual: screenshots of the card (counting, hovered, sending) and the new message's pane, in light and dark, in macOS and Lumen, beside the messages above it.

## Perf

Nothing on a hot path: one entry per send, a 1 s tick only while a card shows, gone when the hold settles. The conversation renders no differently without holds (`Thread` reads one selector). Idle stays idle.

## Out of scope

- Other windows don't show another window's hold (they never had its draft open); they see the copy when it's queued, as today.
- A reload during the hold loses the card (the backend still sends at its time; the copy shows when it's queued).
- The backend's hold, its fence and its timing are unchanged.

## Revisions after the Codex review

Codex's critique of the plan (twelve points):

1. **The hold can end before the window records it** (a late answer to `compose.hold`). Taken: `scheduledSent` for an unknown draft is kept briefly (20 at most) and applied when the hold is recorded, and the window's end is taken before the RPC, so it never outlasts the backend's.
2. **Card order against copies.** Not changed: holds go in the order sent (each five seconds after its own Send), so a later one can't be queued first; `scheduledSent` is emitted before the `changed` flush, so the card knows its copy before the conversation shows it. Lumen's one-message header moving when a second message arrives is what any reply already does.
3. **`revealSent` doesn't open a known, folded copy.** Not changed: the copy is the conversation's newest message, which opens by default; an unseen one is opened by `takeSent` as before.
4. **Cards left "Sending…".** Taken: a hold listed again (it couldn't go) or given back (`snapshot.failed`) settles; a new connection settles what is past its window; every hold settles a send's deadline (30 s) after its window whatever happens.
5. **`heldView` ownership.** Already so: the pane is shown only if the composer still held this draft after the awaits, never from the pinned card.
6. **List's page lifecycle.** Taken: `pageOf`, `closePage`, the other-list rule and the history subscription all know `heldView`; `openThread` clears it.
7. **Settle before reopening.** Taken: `cancelHeldSend` calls back as soon as the cancel won, and a failure to reopen says the draft is in Drafts instead of making Undo retryable.
8. **`z` with several holds.** Policy stated, not changed: `z` is the newest action, as everywhere; the dock's fallback never takes `z` over.
9. **Mounted isn't visible.** Taken: a card under the full-message view doesn't count; the dock offers Undo.
10. **Body identity.** Taken: the held body uses the negative draft id (never a message's), and the draft's files as its attachments, so cid images resolve as the copy's will (behind the same "Load inline").
11. **Copy elsewhere** (a forward, a reply whose subject changed). Taken: the card settles and, if it was being looked at, a snack offers "View". Nothing claims delivery: "Message sent" stays the op's.
12. **Focus.** Taken: focus on Undo as the window ends moves to the card; focus on a card that gives way moves to its copy's header; the new message's pane takes focus the composer left on nothing; the announcement is outside the counter.

## Codex code review

Round 1 found six, all fixed, each with a test that fails without the fix:

1. **A send that went before `compose.hold` answered left the new message's pane empty.** The buffered `scheduledSent` was replayed before the pane was the hold's. The pane is set first now, and a pane whose hold is gone clears itself (`compose.test.ts`).
2. **A hold settled while the dock offered its Undo left the offer up** (a hover holds it). Its copy known, the offer becomes the spinner, and settling withdraws any offer still there (`held-sends.test.ts`).
3. **Focus on a card lost when its copy took its place.** The card left the page before the effect that moves focus ran. A layout cleanup, which runs before the card is removed, hands focus to the copy's header (e2e, `compose.spec.ts`).
4. **Undo out across the window's end dropped focus** when it came back too late or failed. Focus is parked on the card for those transitions too (`held-sends.test.ts`).
5. **"Show full message" did nothing in the new message's pane**, which had no reader view around it. It has one now.
6. **A card left after its window, before it was queued, showed nothing anywhere.** The dock says "Sending…" (no Undo), bounded by the hold's own deadline (`held-sends.test.ts`).

Stopped after one round. Perf gate (`test:ui-perf`, load average 3 to 5 from other sessions): "holding j" counts two animations, and it fails the same way on the commit before this series; the 250 KB paragraph's editor plugin (54 ms against 50) is the composer's, untouched here. Both are outside this change.

## The owner's change: Undo send with the border as the countdown

> lets have an 'undo sent' button with the border progress instead of a 'sending in xs' thing

The words "Sending in 4s" and the separate Undo button are gone. Where a message has its date, the held message has **Undo send**: the dock's own countdown pill, its border draining over the window, with the `⌘Z` keycap while `z` runs it, and its spinner while the cancel is out. After the window, "Sending…" with the spinner, as before. So the pill can serve both, it moved out of `snack-dock.tsx` into `components/countdown-pill.tsx`, timed by props (`duration`, `elapsed()`, `paused`, `sync`) instead of the snack store; `SnackPill` is a wrapper that passes the snack's lifetime. Its colours moved from `snack-surface` to the pill's own `countdown-pill` utility (`--countdown-track`, `--countdown-ring`), since their contrast is checked against the pill's card fill wherever it sits; the animation's id is `pill-countdown` and the ring's test id `countdown-ring` (the specs that skip or read it follow). With motion off the border steps once a second, as the dock's does. `compose.held.sendingIn` is gone from both locales.
