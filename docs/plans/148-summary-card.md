# Plan 148: The summary is a card

- **Status:** built and on `main`, code-reviewed (see "What the code review changed"). See "The full run" for what `pnpm test:all` showed.
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

## What the code review changed

Codex raised 2 points on `f5158c85`, both fixed with a regression test.

- **Focus can't jump after a click away.** With the new fallback, a click on the mail's text followed by an incoming reply moved focus to the toolbar: a click away blurs with no `relatedTarget`, just as a removed control does, so the block still thought it held focus. A click outside now ends that. The fallback stays for any way the card goes while it really holds focus, not only Stop, since the page is never the right place.
- **A short status stays on one row.** The text's `16rem` basis was wider than the row at the minimum window, so "Summarizing…" and Stop split in two and the card lost its header's height. The text now takes its own width: a short status keeps its action beside it, and a long one sends it below.

## The full run

`pnpm test:all` did not pass, and none of what failed comes from this plan. The run took 2345 s, at a load average near 100, while plans 144 and 145 landed on `main` in the same checkout.

- **`unit`, 10 files:** `TypeError: client.on is not a function`. `lib/replies.ts` (`e402954a`, plan 144) and the Today code (`ac82d66f`, plan 145) call `client.on` when the module loads, and these tests' mock of the client has no `on`. It fails the same way when rerun on `d534c01d`, and the error doesn't depend on load, so it's a real break on `main` that someone needs to fix.
- **`startup`:** the packaged build held schema 53 and the source 54: a migration arrived during the run.
- **`perf`:** wall-clock limits on SQLite and IndexedDB reads at that load. This plan changes no query.
- **`e2e`:** 29 tests failed on the first pass, and 28 of them passed when run again alone; the other was `unsubscribe.spec.ts`' Spanish flow. That flow and every summary flow passed on `d534c01d` at a load near 40: `summaries.spec.ts` and `unsubscribe.spec.ts` in all five designs, 20 of 20.

Not run again: a clean `pnpm test:all`, which can't pass until the `unit` break is fixed.
