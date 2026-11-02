# Plan 115: pin a draft so it stays while you read other mail

## Request (verbatim)

> I'm thinking of wanting the ability to make the current draft composer that we have. I'm thinking we could make it
> Sticky
>
> Optionally we would have a pin or something that would make it sticky on that right part and then it would stay there even if I change from one thread to another, looking for stuff. It is very possible that they're looking for stuff while reading the email.
>
> We do need to be careful when doing that because it would kind of put itself on the bottom right but not super small. It doesn't have to be tiny there. It can kind of go by with a normal space. We do need to be careful then for the other threads when they're large threads that reach to the bottom. That sticky thing could cover the last part of the messages so we would need a buffer on the bottom of that thread list so they can see the very bottom part of a thread's messages.
>
> If there is something written on that draft and the user tries to unpin it, it would basically just save the draft, import it, and just have the draft there. I'm thinking we could do that. Develop a plan, see how hard it is to implement this, and then do it.

## What exists

- A reply, reply-all or forward is written inline at the foot of its conversation (`DraftSlot`, `inline-draft.tsx`): the reply bar, the open form, or a one-line collapsed draft. Switching conversations unmounts it; the draft stays in its conversation (and in the strip when that conversation isn't in the list).
- A new message takes the reader pane (`NewMessage`); opening a conversation leaves it (`installComposeFollowsSelection` → `leaveNewDraft`: kept if written, dropped if untouched).
- The form parts are shared: `DraftFieldsForm`, `ComposerBody`/`ComposerFormatBar` (lazy editor), `DraftAttachments`, `Quote`, `SignaturePreview`, `SaveState`, `SendButton`, `DraftCommandsHost` (palette commands for the focused draft).
- Focus requests for a draft go through `useApp.draftFocus` (`focusDraft`, `finishComposeFocus` for leased opens); the slot that shows the key consumes them.
- The snack dock publishes its height (`useSnack.inset`); the reader (List's page) and the list pad their scroll end by it, so their last line scrolls clear of the dock. That is exactly the buffer this feature needs.

## Design

### Behaviour

- **Pin.** An open draft (inline reply/forward, or a new message in the reader pane) has a Pin button (and "Pin draft" in the palette). Pinning lifts the very same draft (same key, same editor state through the kept editor body) into a card docked at the bottom right of the reading area. Focus goes to its body.
- **It stays.** The card is outside the reader: j/k, clicks, searches, other views, a bulk selection, a new message, all leave it where it is. One draft is pinned at a time; pinning another puts the first one away (below).
- **Its conversation.** While pinned, the draft's own conversation shows a quiet line in place of the composer: "Draft pinned · Unpin". r / a / f / the reply bar there resume the pinned draft (focus goes to the card) instead of opening a second editor for the same key.
- **The buffer.** The card publishes its height; the reader's scroll end (and in List, the list's and the new message's) is padded by it, like the snack dock's inset, so the last message of a long conversation scrolls fully clear of the card. Keep-in-view logic uses the same inset.
- **Unpin** (the card's Unpin button, the palette, or the conversation's "Unpin" line):
  - its conversation is on screen → the draft drops back inline, open, focused (it never left);
  - elsewhere, and something is written → saved, collapsed into its conversation (the strip shows it when that conversation isn't in the list); a snack says "Draft saved" with Open (openStoredDraft / showNewDraft);
  - elsewhere and untouched: a reply goes back to its conversation as it was; an untouched new message just goes (as Esc on a new message does).
- **Esc** in the card leaves the card but keeps it pinned: focus goes back to the list (or List's page), so j/k work again. That is the reading-while-writing loop.
- **Send / Discard** close the card (the draft is gone); Discard's undo restores it inline as today.
- A pinned draft that disappears another way (sent, scheduled, forgotten) unpins silently. r / a / f on its conversation never convert it (see the revisions).
- The pin is session state (not persisted): after a reload the draft is where it lives, as today.

### Shape

- `apps/web/src/lib/pinned-draft.ts`: a tiny store `usePinned { key, inset, focus }`, `pinDraft(key)`, `unpinDraft(key, { focus })`, `pinnedKey()`. While a key is pinned it watches `useDrafts` for the key's disappearance (subscribed only while pinned: idle stays idle).
- `apps/web/src/components/pinned-draft.tsx`: the card. Positioned `absolute right-3 bottom-3` in the reading area (Split: `main`; List: the list section, above its page layer), `w-[min(32rem,calc(100%-1.5rem))]`, `max-h-[min(70%,40rem)]`; header (what it is · subject, Unpin), a scrolling middle (fields, body, attachments, signature, quote) and a fixed foot (format bar; Send, format, attach, link, save state, Discard) mirroring the inline form. `bg-popover shadow-popover rounded-xl` with the hairline ring (it floats, so it needs the opaque surface every design gives popovers). A ResizeObserver publishes `inset = height + 2 × gap`.
- `DraftSlot` gets a fourth state, `pinned`, and skips its focus effect for a pinned key; `NewMessage` and the inline form get the Pin button; `DraftsStrip` omits the pinned key; the reader, list and new-message page take `max(snack inset, pinned inset)`.
- `DraftCommands` gains `pin()` / `unpin()` with `state().pin` / `state().unpin`; the palette offers them in the draft group.
- Icons `Pin` (PinIcon) and `PinOff` (PinOffIcon) join the catalog.
- Copy (en/es): `compose.pin` "Pin draft" / "Fijar borrador", `compose.unpin` "Unpin" / "Desfijar", `compose.pinned` "Draft pinned" / "Borrador fijado", `compose.pinnedLabel` (card's accessible name), `compose.savedAway` "Draft saved" / "Borrador guardado", `compose.open` "Open" / "Abrir".

### Why this is not hard

The form, the editor's state hand-off across unmounts (kept editor body), autosave and focus requests already exist; the card is a fourth host for the same parts. The only new cross-cutting thing is the inset, which already exists for the snack dock.

## Tests

- Unit (`pinned-draft.test.ts`): pin/unpin state transitions; untouched new message forgotten on unpin; written draft collapsed and flushed; key disappearing unpins; pinning a second draft puts the first away; strip omission.
- e2e (`apps/web/e2e/pinned-draft.spec.ts`, `@design` for the core flow):
  - pin a reply, type, j to other conversations: the card and its text stay; the other conversation's last message scrolls clear of the card (its bottom above the card's top at max scroll);
  - its own conversation shows "Draft pinned"; r there focuses the card;
  - Esc returns focus to the list, card stays;
  - unpin elsewhere with text: the snack, the draft in its conversation collapsed with the text; unpin on its conversation: inline, open, focused;
  - pin a new message, open conversations, send from the card;
  - axe on the card in light and dark.
- Screenshots in light and dark (Split and List).

## Perf

Nothing on a hot path: the card mounts only while pinned; the inset is one number in a store read by the reader and the list (as the snack's). No polling, no timers.

## Out of scope

- Several pinned drafts, dragging or resizing the card, minimizing it to a header.
- Remembering the pin across reloads.

## Revisions after the Codex review (plan)

Codex (read-only, against the code) raised 11 points. What changed:

1. **Two editors for one key during the close animation.** `Expand` keeps closing children for up to 150 ms. The slot now drops its form the moment the draft is pinned (`d` is undefined for a pinned key), so the old editor unmounts in the same commit the card's mounts.
2. **A pinned new message and `leaveNewDraft`.** Pinning clears `compose` directly (never `leaveNewDraft`), and `leaveNewDraft` never forgets the pinned key.
3. **Leased focus from r/a/f.** `openCompose` checks for a pinned draft on the conversation *before* it takes a reader lease and sends focus to the card; the later check (expired placements found by source) releases the lease the normal way. The card also answers a `draftFocus` for its key (leased or not) as the slot would.
4. **Placement expiring while pinned.** The pin remembers the conversation it came from (`usePinned.threadId`), so that conversation keeps showing "Draft pinned" after its placement expired; unpinning there with an expired placement goes through `openStoredDraft`, which validates the source again.
5. **Conversion keeps the key.** r / a / f on the pinned draft's conversation only focus the card; they never convert it.
6. **Other open paths.** `openStoredDraft` and `showNewDraft` focus the card for a pinned key instead of mounting it elsewhere.
7. **"On screen" checks.** Not in a bulk selection, not under a new message, and in List only on its page; `draftShown` names the key explicitly.
8. **"Draft saved" only when it is.** The snack waits for the flush and reads the result: saved → "Draft saved"; anything else → "Draft kept, but not saved yet" (its Retry is in the draft). Both offer Open.
9. **Snack and card in List.** Where the pane is too narrow for the dock (30 rem, bottom left) and the card side by side, the card stands on the dock (lifted by its inset), and the buffer includes the lift.
10. **One inset everywhere.** The reader, List's list (anchoring too) and List's new-message page take `max(snack, pinned)`; Split's new message is padded by the card; Split's list is not (the card isn't over it). `keepInView` now clears the scroller's `scroll-padding-bottom`.
11. **Account removal.** Dropped from the plan: a draft whose account is gone is kept (as `openStoredDraft` allows), and the card shows it like the standalone composer does.

## Codex code review

Three findings, all fixed with a regression test that fails without the fix:

1. **The card's form leaked state between pinned drafts** (revealed Cc/Bcc rows, recipient undo history). The card is keyed by draft. e2e: "another draft pinned starts with its own form".
2. **Review drafts showed "Draft pinned" instead of the editor.** Opening Review drafts lets go of the pin (the draft stays where it lives); nothing can be pinned while it is open, and its slot has no Pin button. Unit: "Review drafts".
3. **Esc in the card over List's new-message page** aimed at the hidden (inert) list and left focus in the card. It now goes to the page's new message; the list only when it can take focus. e2e: "Esc in the card over a new message".

## Results

- `pinned-draft.spec.ts` (10 flows, the `@design` ones in all three designs), `pinned-draft.test.ts` (8), the palette spec (its draft group lists Pin draft now).
- Screenshots in light and dark, Split and List, looked at.
- Rebased onto `main` and renumbered from 103 (taken by the sync progress card) to 115: typecheck, lint, the unit file and the pinned-draft, palette and compose specs in all three designs (105) pass.
