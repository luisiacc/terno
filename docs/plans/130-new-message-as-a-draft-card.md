# 130 · A new message is a draft card, not the full pane

## Request (verbatim)

> lets make the new draft from scratch ui be more like its is in a draft instead of the full page, the full page is just too much mouse movement to go to the bottom and do formatting.

(With a screenshot of today's new message: the text at the top of the pane, the format bar at the pane's foot, Send in the toolbar at the top right.)

## What exists

- `NewMessage` (`apps/web/src/components/new-message.tsx`) takes the whole reader pane (or List's page). Its parts are spread over the pane: Discard, the "New message" label, Pin and Send in a 52 px toolbar on top; the title and the hairline fields below; the body filling what's left; the format bar, Aa, Attach, Link and the save state at the pane's foot. On a tall window the text and the format bar are a long way apart, and Send is at the opposite corner.
- A reply, reply-all or forward is `DraftSlot`'s open form (`inline-draft.tsx`): one `--draft-bg` card with the fields (Pin in the first row's corner), a 132 px body that grows, then the format bar and a footer: Send, Aa, Attach, Link, save state, and Discard and Collapse at the right. `PinnedDraft` has the same parts, and caps its height: the fields and body scroll inside, the footer stays.
- The new message's foot stays clear of a pinned card and of List's snack dock because its host pads itself: `composeInset` on `main` (Split), `PageLayer`'s `paddingBottom` (List).
- "New message" shows twice when the subject is empty: the toolbar's label and the title (`compose.untitled`).

## Design

The new message becomes the same card, in the reading column, where a conversation's draft would be. Nothing about the draft itself changes (its store, focus, autosave, leaving, pinning): this is layout.

```
┌ pane ─────────────────────────────────┐
│ (52 px: the window's drag strip)      │
│    New message            ← the title │
│    ┌ --draft-bg card ───────────────┐ │
│    │ From / To / Subject        📌  │ │
│    │ body, at least the min height  │ │
│    │ format bar                     │ │
│    │ Send  Aa 📎 🔗  Saved      🗑 ⌄ │ │
│    └────────────────────────────────┘ │
│                                       │
└───────────────────────────────────────┘
```

- **The card hugs its content.** A short message leaves the rest of the pane empty, and the format bar is right under the text. That is the request.
- **A long message keeps its bar at hand.** The card grows to the pane's height and no further; the fields and text then scroll inside it and the format bar and footer stay put (`PinnedDraft`'s shape: a `min-h-0` scroller over a `shrink-0` footer). An inner scroller rather than a sticky footer, so the caret is never typed under the footer: ProseMirror scrolls its nearest scroller, whose bottom is the footer's top.
- **The same controls in the same places as a reply:** Pin in the fields' corner; Send first in the footer; Discard and Collapse at the footer's right. Send and Discard leave the toolbar, so what's left of it is an empty 52 px drag strip (needed by the desktop window, and it keeps the title on the same line as a conversation's subject). Its "New message" label goes: the title says it (never the same info twice).
- **Collapse** (new here for a new message, same label and Esc hint): does what Esc does, `leave(key)`: kept in the strip, focus on its strip item. A new message had no visible way to step away without discarding.
- **The title** stays and still mirrors the subject (`compose-title`), clamped to two lines so a very long subject can't squeeze the card; the Subject row holds the whole text.
- **The surface** is shared: `DRAFT_SURFACE` exported from `inline-draft.tsx`, so `--draft-bg`, `--draft-ring` and `--draft-shadow` hold in all four designs without a second copy. `DraftFieldsForm`'s `flat` prop existed only for the old layout and goes.
- **Dropping files:** the form still fills the pane, so its handlers still take a drop anywhere in the pane. The drop layer moves into the card (`relative`, `rounded-[inherit]`) and rings the card, as a reply's does.
- **Body height:** a new message has nothing above it to read, so it starts a little taller than a reply's 132 px, enough for a few lines without the card jumping: 220 px, picked by eye in the screenshots.
- **The From row, found in the screenshots:** at the narrowest pane a long address pushed the Pin out of the card, so the value now truncates. The Pin also sat 2.5 px under the row's line with several accounts (both fixed in the shared `DraftFieldsForm`, so a reply gets them too).
- The form's `aria-label`, `data-testid="composer"`, `data-mode="new"` and all control test ids stay the same; only `flex`/position changes, plus `composer-card` for tests.

## Tests

- e2e, `apps/web/e2e/composer.spec.ts` → "the new message" (`@design`, so all four designs):
  - the format bar is right under the body on a tall pane, and the card ends well above the pane's foot;
  - Send, Discard, Collapse and Pin are inside the card, and the toolbar has no controls;
  - a message longer than the pane: the card stays inside the pane, the bar and Send remain in view, and the line being typed is visible above the bar;
  - Collapse leaves the new message: kept in the strip, focus on its item;
  - the title still mirrors the subject, a very long one is clamped and the card keeps its footer in view.
- `pinned-draft.spec.ts`: with another draft pinned, a long new message's footer ends above the pinned card.
- Existing specs that use the new message by test id (`compose.spec.ts`, `composer-drop.spec.ts`, `composer-send.spec.ts`, `controls.spec.ts`, `designs.spec.ts`, `attachments.spec.ts`, `snippets.spec.ts`) must pass unchanged. One exception, `recipients.spec.ts`: Pin now sits between From and To in the tab order (its visual place, as in a reply), so its "Tab into the collapsed field" step starts from Pin.
- Screenshots in light and dark, in the designs, looked at.

## Perf and resources

No new work: the same lazy editor chunk, no new effects or observers, one less flex level of chrome. Not a hot path; `test:ui-perf` covers the composer's open if the bundle moves (it shouldn't).

## Out of scope

- A floating Gmail-style compose window (the pinned card is that, on request).
- Changing the reply draft or the pinned card.
- Merging the three hosts' JSX into one component (a separate refactor).

## Revisions after the Codex review

The plan critique raised 8 points. What changed:

1. **Collapse on an untouched message** does what Esc does: the empty draft goes (`leaveNewDraft`), so no strip item takes focus and the keyboard goes on from the list. Kept on purpose (an empty draft is nothing to keep); tested both ways through the button.
2. **The hugging layout, exactly:** the column has the pane's height; the title is `shrink-0`; the card and its scroller are `flex: 0 1 auto` with `min-h-0` and no `flex-1` anywhere, so they size to their content and shrink only when the pane runs out. Checked with the lazy editor loaded and on a short body.
3. **Short panes** (600 px window, a tall pinned card over the foot): the card has a minimum height and the area under the drag strip scrolls past it, so the footer is always reachable. Tested at 980×600 with a tall pinned draft in Split and List.
4. **Narrow panes:** the footer gets `flex-wrap`, so the status (which can hold a recovery action) moves to its own line rather than pushing Discard and Collapse out. Tested at the narrowest pane with Spanish copy.
5. **The link bubble** sits inside the editor and, under an inner scroller, would be cut off below the last visible line. It now flips above the link when there's no room below. The scroller is marked `data-draft-scroll`; the pinned card gets the same mark, since it has the same defect.
6. **Focus rings:** a text field's ring reaches 3 px outside it, and the first row only has 1 px, so the scroller has `pt-0.5`.
7. **Drops:** `composer-drop.spec.ts` only drives replies, so it gets new-message cases: blank pane space, the fields, the text, and the overlay ringing the card.
8. **Perf:** a shrink-to-fit card may lay a huge body out differently, so `perf.spec.ts` gets the huge-draft gate through a new message too, with the reply's budgets.
