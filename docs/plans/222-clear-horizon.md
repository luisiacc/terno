# Plan 222: a clear day, on the horizon

- **Status:** built
- **Builds on:** `0329258` (main).

## The request (verbatim)

> i think we need something more identifiable for us when there is nothing coming up, something that will brand us and something people talk online about getting to, give me 5 recommendations

Five were mocked in light and dark (free until, your horizon, sealed, the ticket, one line a day). Then:

> lets do your pick, but lets not do the darl mode at night, dark mode would be qhem they have their dark mode set, not time dependent

The pick: the free-until line under a horizon, with the clear-day number from the ticket. Asked then (the owner's answers):

- **When it shows:** whenever nothing needs you, meaning nothing missed, due today or waiting on you (the sidebar's number is 0). It heads the feed, and what's ahead and Earlier stay below it. It doesn't wait for a feed with no rows at all.
- **Before 6:00 and after 18:00:** the sun rests half-risen at the left end of the horizon, or half-set at the right end. There is no night scene: dark mode is the user's theme, never the clock.

## What exists

- `components/what-matters/feed.tsx`: `WhatMattersFeed` draws the feed (`drawn()`: headings, items, the digest, Coming up's disclosure, the history under Earlier) in a virtualizer on `COLUMN`. Only when `useToday.rows` is empty does it draw `EmptyState` with the Sun glyph, "Nothing needs you today." (`today.empty`) and Coming up's disclosure under it (`ComingUpHeading empty`).
- **The history is part of `rows`.** With Show finished items on (the default, plan 210), any Done line under Earlier keeps the empty state from ever showing. Reaching zero today mostly looks like a feed that starts with Earlier.
- `state/today.ts`: `todayAnswer` publishes `rows`, `counts` (`TodayCounts`: missed, today, waiting) and the Coming up count. The sections it reads (`TodayList.sections`) carry each item's `why` (`dueAt`, `item.timed`/`item.dated`/`item.dueDay`, `promise.timed`/`promise.dated`) and Coming up's items, which aren't drawn while Coming up is closed. `todayBadge(counts)` is the sidebar's number.
- `EmptyState` (plan 198): an emptied list's empty state arrives with `arrive(…, { spring, inPlace })`, within `--motion` (≤ 100 ms) and none with motion off.
- `lib/when.ts`: the app's words for moments (`fmt()`: time, weekday, day; `daysAway`, `dayOf`; `dayHeading`).
- The palettes' `star` token (a warm yellow in every palette, AA-checked as a glyph colour); `text-star` is already used.
- Small per-machine memory goes in `localStorage` with a try/catch (`lib/tips.ts`, Coming up's open state `terno.today.comingUp`).

## Design

### When: "clear"

What matters is **clear** when an answer from the backend has arrived and `todayBadge(counts) === 0`. Before the first answer, the skeleton shows as now, so nothing flashes "clear" while loading. `useToday` gains `answered: boolean`, set by `publish`.

### Where

- **Rows below (Earlier, days ahead, the digest):** the feed's first drawn row is a new `{ type: "clear" }` (`drawn(rows, comingUp, clear)`), on `COLUMN` like every row, fixed in height (estimated 210 px, then measured). It isn't an item: j/k, D and the keyboard's row skip it (`placeOf` maps only items and the digest, as now), and it has no `data-thread-id`.
- **No rows at all:** `EmptyState` keeps its place and plan 198's arrival, and draws the same `ClearSky` instead of the Sun glyph and `today.empty`, with Coming up's disclosure under it as now.
- One component, `components/what-matters/clear-sky.tsx` (`ClearSky`), centred on the column: the horizon, the sentence (`<p>`, `text-lg font-semibold tracking-tight`, the empty state's), and "Clear day No. 47" under it (`text-xs text-muted-foreground tabular`).
- With rows below, it arrives (plan 198's `arrive`, spring, in place) when the feed turns clear while What matters is on screen (the last item done), and is simply there when you navigate to it.

### The sentence: free until …

`nextUp(list, now)` (pure, `lib/clear.ts`) reads the backend's sections, Coming up's included, and finds the soonest moment ahead:

- a dated item: `item.dated`, its `dueAt` when `item.timed`, else the start of its `dueDay`. An ask's `dueAt` is its arrival, and it isn't dated, so it never counts.
- a promise: `promise.dated` with `dueAt` (`promise.timed`).
- a reminder: its `dueAt`, timed.
- Waiting rows have no moment.

A timed moment counts if it's still ahead (`dueAt > now`); an untimed one if its day is after today. An untimed item for today (an all-day plan, which isn't counted) stops the search, and the sentence stays "Nothing needs you today."

`freeUntil(next, now)` in `lib/when.ts` turns it into words, using the app's own formats:

| next | en | es |
|---|---|---|
| later today, timed | You're free until 3:00 PM. | Estás libre hasta las 15:00. |
| tomorrow | Nothing needs you until tomorrow. | Nada te necesita hasta mañana. |
| in 2–6 days | Nothing needs you until Thursday. | Nada te necesita hasta el jueves. |
| further | Nothing needs you until Dec 3. | Nada te necesita hasta el 3 dic. |
| an untimed item today | Nothing needs you today. (`today.empty`) | Hoy no hay nada que te necesite. |
| nothing ahead | Nothing on the horizon. | Nada en el horizonte. |

`todayAnswer` publishes `next` with the rows. The words are made at render time with `Date.now()`, so a reload (the backend's `todayChanged`, and its midnight wake) brings them up to date.

### The horizon

An inline SVG (`aria-hidden`, decorative: the sentence says it all), 440 × 110 in its viewBox, `width: 100%` and `max-width: 440px`, so it scales with the column:

- a hairline horizon (`currentColor` at the hairline's 18 %, the muted ink), and the sun's track above it, a dotted quadratic arc (14 %).
- the sun: an 8.5-unit disc in `text-star` with a soft radial glow of the same colour (22 % fading to 0), on the arc at `(hour − 6) / 12`. Before 6:00 it rests half-risen at the arc's left foot, after 18:00 half-set at its right foot (clipped at the line). Same scene in light and dark: the colours are the palette's. (The mock's three reflection strokes under the line went: at the app's size they read as a filter icon.)
- **The hour** is read on mount, on window `focus`, on `visibilitychange` to visible, and at the one moment the words change by the clock alone (`nextChange`, below). Nothing polls.
- Opacities are SVG attributes, as the mark's are (plan 19), never opacity utilities. No literal colours, so it follows every palette and design.

### The clear-day number

- `localStorage["terno.whatMatters.clearDays"] = {"n": 47, "day": "2026-11-19"}`. When `ClearSky` is shown and the document is visible on a local day after `day`, `n` goes up by one and `day` becomes today. Once a day at most, whichever window or reload sees it first; the read-modify-write sits in one synchronous block. It starts at 1 on the first clear day.
- If storage is refused, the number isn't shown (there's nothing to count from) and nothing breaks.
- Never sent anywhere. This machine only, like tips. It counts days rather than streaks, so missing a day costs nothing.
- Copy: "Clear day No. {n}" / "Día despejado n.º {n}".

### What doesn't change

- The header line (`TodayLine`) already says nothing when the counts are zero.
- Coming up's disclosure, the digest, the days ahead and Earlier keep their places and behaviour.
- The other lists' empty states (Inbox, Review) are unchanged.

## Tests

- **Unit, `lib/clear.test.ts`:** `nextUp`: a timed plan later today, past ones skipped, an untimed day ahead, Coming up's items when it's closed, an ask's arrival ignored, an untimed item today giving `today`, nothing at all; `sunPlace(hour)`: the feet before 6:00 and after 18:00, noon at the top; `countClearDay`: the first day is 1, the same day twice is still 1, the next day is 2, refused storage gives null.
- **Unit, `lib/when` (existing test file):** `freeUntil` in en and es for each row of the table.
- **E2E (`what-matters-feed.spec.ts`, one new test sharing a page through `scenario()`):** the demo's own items done, so nothing needs you, with history below: the clear row heads the feed, says "Nothing needs you until …" for a seeded item two days ahead, shows "Clear day No. 1", and Earlier stays below it; j moves to the first item, never the clear row; the sentence after reloading on the same day keeps No. 1; axe in light and dark.
- Screenshots in light and dark, in Lumen and Graphite, looked at.

## Performance and resources

- One extra row in the virtualizer at most. `nextUp` is one pass over the answer's items (bounded by the answer), run when it's published, never per frame.
- No timers, no network, no new storage beyond one small `localStorage` key.
- No lazy loading. `ClearSky` is a plain import.

## Out of scope

- The other mocks (Sealed, the ticket and its Copy, one line a day). The number from the ticket is here; the stub isn't.
- "See you Monday" and other words that would need to know the user's working week.
- Syncing the clear-day number across machines.
- The UI rating: none of the rated shots reaches a clear What matters (the demo mailbox always has items waiting), so `ui:rate` sees no change.

## Revisions after the Codex review of the plan

1. **Later's return time.** A row put off with Later keeps its old `dueAt` and says when it's back in `why.back`, waiting rows too. A moment is `back` when there is one. Unit test.
2. **Reminders after today aren't in the answer.** Declined: the sentence speaks for What matters' items, and a reminder isn't one until its day (the backend leaves it out). It would take a new backend fact for one sentence. Said in `nextUp`'s comment.
3. **A reply's other promises (`also`).** The row leads with the first promise in reply order, not the soonest, so `also` entries with a day count too. Unit test with the lead later than its `also`.
4. **"Free until 3:00 PM" after 3:00 PM.** The answer now publishes the items' moments (`moments`, `momentsOfList`), and `nextUp(moments, now)` runs when drawn. `ClearSky` arms one timer to `nextChange` (the next timed moment, a plan's end, else midnight), and to nothing else. It's a single wake at a known moment, not polling. Unit test for `nextChange`.
5. **A plan underway.** A plan is open until `planEnd`. While it's underway the sentence is "Nothing needs you today.", never "free until" a later one or "Nothing on the horizon". Unit test.
6. **`answered` across mailboxes.** Declined: coming back to What matters shows the previous answer's rows until the new one lands, and the clear row is drawn from that same answer, so it's never staler than the rows beside it.
7. **The arrival.** It's keyed on the feed's own transition from an answer with something counted to one with nothing (`busy` → `clear`), run before paint and once, never when a scrolled row is drawn again. The first answer after navigating doesn't count. The row case only: the empty state keeps plan 198's own, so it never moves twice.
8. **`EmptyState`'s title.** `title` is optional now, and `className` puts it on the feed's column. `ClearSky` goes in as children, with no empty paragraph above it (component test).
9. **Counting a day.** It counts only when the horizon is in view (an `IntersectionObserver`; a virtualized row can be drawn out of view) in a visible window, and again at midnight's wake. The number stays hidden until counted. Component test: never while loading.
10. **The UI rating.** The What matters set's frozen shots (`w01`–`w06`) all have items, and the capture's states may not change (plan 158), so a round can't see this. Not run. The owner can ask for a round.

Also from building it:

- **Earlier.** The demo mailbox always has an automated row, so e2e can't reach a feed with no rows. The empty branch is a component test (`feed.test.tsx`), and the e2e covers the clear row with Earlier shown and hidden.
- **j from a fresh load** lands on the first item, never the horizon (e2e). After a Done, the keys go on from the item put away, as before.

## Codex code review

1. **[P2] A failed first request showed the horizon and counted a day.** With no answer, the empty feed keeps its old words ("Nothing needs you today." under the Sun), and no horizon or count until an answer says it's clear (`feed.test.tsx`).
2. **[P2] A reply put off with Later still had its other promises' old days.** A row with `why.back` has that one moment, its `also` left out (`clear.test.ts`).
3. **[P2] Midnight counted a day on yesterday's answer.** The answer carries its day (`answeredDay`, from its `now`). A day is counted only on an answer for today, so a bill due tomorrow that's due today after midnight doesn't add a clear day (`feed.test.tsx`).
4. **[P2] A promise to attend the row's event read as an all-day item.** `also` entries with `attends` have no moment, so the event's own time shows ("You're free until 6:00 PM.") (`clear.test.ts`).

One review round. Each test fails without its fix.
