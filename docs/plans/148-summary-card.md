# Plan 148: The summary is a card

- **Status:** in progress.
- **Replaces:** plan 132 §6's "No card, box or color: type and a hairline". Everything else in that section stands.

## The request

> we need to improve this ai feature for summaries, the ui of it mostly, it looks like one part of th eemail, we need some kind of diferentiator like a card or something, that people can immediatly differentiate as the summary, it should look very clean and simple

## What exists

- `apps/web/src/components/thread-summary.tsx` draws the block in the conversation's column with no surface of its own: a muted "Summary" label, then `text-sm` text in the same ink and on the same line as a message body. Between the subject and the first hairline it reads as the start of the mail, which is what the report shows.
- Plan 132 chose that on purpose, to keep the reader quiet. Using it on real conversations shows the cost: words a model wrote look like words the sender wrote. That matters more than the quiet, because the summary can be wrong (its own tooltip says so).
- `card-group` (`globals.css`, plan 137) is already the design's card: `--card-radius`, on the tint in Lumen, Atelier, macOS and Luma, outlined on the surface in Graphite (`surfaces.card`). Foreground and muted text on the tint are in `CONTRAST_PAIRS`.
- `Sparkles` is the icon of the toolbar's Summarize button.
- The block has other states, all one `Line`: running, waiting for a body, consent, no provider, error.

## Design

```
┌─────────────────────────────────────────────────┐
│ ✦ Summary                                     ⌃ │
│ Ana can't make the 12th and proposes the 19th.  │
│ Action   Send the signed contract             → │
│ Date     Meeting moved to 19 March            → │
└─────────────────────────────────────────────────┘
```

1. **One surface, `card-group`.** No new token, color or palette pair, so each design keeps its own card and the contrast suite already holds it.
2. **The box sits on the column.** Its edges are on the subject's line and the hairlines' ends, and its text is inset. AGENTS.md's alignment rule: a filled box takes the column's margins, and only hover shapes may sit wider.
3. **`Sparkles` beside the label.** The same glyph as the toolbar's button, which ties the card to the action that makes it and marks it as the app's voice, not the sender's. It sizes with the label (`1.15em`) and stays muted, per the icon rules.
4. **Every state is the same card.** Running, waiting, consent, no provider and error draw the header row's box and height, with the spinner in the sparkle's place while it runs. The result replaces the running state in the same box, so nothing changes shape in front of the user. Actions sit at the row's end, under the chevron's line.
5. **Closed is one row.** The trigger fills the card's header, so the whole row toggles.
6. **Rows inside the card.** An item row's hover can't be `bg-tint` on the tint, so it uses `bg-field`, the ink's wash, whose foreground and muted text over the tint are already held pairs (`contrast.ts`, plan 118).
7. **The panel's padding sits inside it.** `CollapsiblePanel` eases its height to 0, and with `border-box` a padded panel can't get below its padding, so it would jump at the end.

No other behaviour changes: disclosure state, provenance tooltip, focus handling, arrows and scroll stay as they are. No new strings.

## Tests

- `e2e/summaries.spec.ts` (`@variant`): the card's left and right edges are on the column (the subject's left, the conversation's right); the summary text is inset from them and on one line with the label's row; the surface isn't transparent in macOS. A closed card still shows one row. The running state and the ready state share the box's left and width.
- The existing axe checks in `summaries.spec.ts` and `design-axe.spec.ts` read the new surface, in light and dark. The contrast suite holds the colors.
- Screenshots of the ready, closed, running, consent and error states, in all five designs, light and dark, by eye.

## Performance

CSS only, on a block that is already lazy. No new work, no new icon module in the entry chunk (the reader already imports `Sparkles`).

## Out of scope

Changing the summary's content or prompt. A visible provenance line. A card for follow-ups (plan 142), which are the user's own to act on, not something a model says about the mail.

## Revisions after the Codex review

Codex (read-only, against the prototype) raised 4 points on this plan, all accepted. Each replaces what the sections above say.

1. **Stop no longer drops focus on the page.** Stop can remove the whole block, so the block has no next control to give focus to. It goes to the toolbar's Summarize button that started it (`data-summarize`). This bug was already there; the card's states are where it shows.
2. **Long unbroken text wraps.** A link or an id in a summary, an item or a status line was cut off by the panel's `overflow-hidden` or ran past the card. All three are `wrap-anywhere` now.
3. **The surface check names each design's card.** "Differs from the page" would pass with no card at all. The test holds a fill in the tinted designs and an outline on no fill in Graphite.
4. **The card's checks are `@design`.** `@variant` doesn't run in Graphite or Luma, and Graphite's card is the one that differs, so the geometry and surface checks are a test of their own in all five.
