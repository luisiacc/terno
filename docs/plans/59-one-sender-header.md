# 59 · One sender header

## Request

> Here these things are duplicated, like we're showing it twice, and they're always going to be used the same every time. Let's use the one on the very top and let's add the "to," like who it is, and the date at the right, kind of similar to what we do here. We don't need to do the thing where, if I hover over the stripe... because the email is already there. we don't want duplicate date, lets have it nicely in according to our premium feeling

(Screenshot: Lumen reader on a one-message Stripe receipt. The sender card at the top shows the avatar, "Stripe", `receipts@stripe.com` and the category chip; under the subject, the message header shows the avatar and "Stripe" again, "To: Luis Cordero" and "Oct 22".)

## What exists

- `ReaderHeader` (`apps/web/src/components/reader.tsx`) arranges the subject and chips per design (`readerHeader` variant). Lumen, the default design, uses `sender-card`: a 64 px avatar, the conversation partner's name and address (`senderOf`), and the chips.
- `Conversation` renders every message with a header button (`message-toggle`): avatar, name, the address revealed on hover or focus, the date on the right, and a To/Cc line. Clicking it folds the message.
- Classic (macOS) and Atelier don't show a sender above the subject, so their message headers duplicate nothing.

## Design

In the sender-card design, a conversation of **one message** shows that message's header once, in the card:

```
(avatar)  Stripe                                        Oct 22
          receipts@stripe.com
          To: Luis Cordero · Cc: …
          (chips)
```

- **The card takes the message's details.** The name and address come from the message itself, so the To line, the date and the sender always agree. The date is the reader's `listDate`, muted and tabular, top-right on the name's line, with the full date as its tooltip (a `<time>` element). The To/Cc line is the message header's: the label in the foreground, the names muted, truncated on one line.
- **The message renders without a header.** Its body follows the subject's hairline directly, and it can't be folded: with nothing else in the conversation, folding would only hide the mail. The `<article data-message-id>` stays, so the message menu (right-click, Print this message) still finds it.
- **Two or more messages:** the card stays the conversation partner without a date (the dates belong to each message), and each message keeps its header and fold button. The address revealed on hover is dropped when it's the card's address, since it's already on screen. Other senders keep it.
- **When a second message arrives** (a reply is sent), the card drops To and the date, and both messages show headers. The first message stays open, because `Conversation` remembers how each message first showed.
- Classic and Atelier don't change.

## Tests

- e2e (default design, Lumen):
  - A one-message thread's card shows To and the date, with the full date as the date's tooltip.
  - The reader shows that date exactly once and has no `message-toggle`.
  - The body is visible, and the address appears once.
- e2e: in a multi-message thread in Lumen, the card has no date or To line and every message keeps its toggle. The hover address isn't rendered for the card's sender but is for others.
- e2e `@design`: Classic and Atelier keep the message header on a one-message thread.
- Visual: re-record the Lumen baselines that show a one-message reader, and look at them in light and dark.

## Perf

Render only: one fewer button per one-message thread. There's no new state, and `Conversation`'s render counts don't change.

## Out of scope

- Merging headers in Classic or Atelier.
- Changing how multi-message conversations fold.
