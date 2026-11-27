# Brief: the machine mail of the demo mailbox (plan 292, stage 3)

Most of a real inbox is mail no person typed: newsletters, receipts, shipping notices, bank alerts, code-host notifications, promos. You write the **templates** and **newsletter issues** for some of the brands in `packages/mock-data/demo-corpus/world.json`; code fills them in on each brand's schedule for two years (about 4,500 messages in all), so one template becomes hundreds of messages. They must look exactly like what such a company sends: the same layout every time, specific, a little dull, with the legal footer.

## Inputs

- `world.json`: `brands` (yours are listed in your task), `owner`, `accounts` (which address each brand writes to, and its language).
- `packages/mock-data/src/demo-corpus/types.ts`: `BulkSource`, `BulkTemplate`, `BulkSchedule`, `BulkSlot`, `SpamSource`.
- `packages/mock-data/src/demo-corpus/load.ts`: how templates are filled (`fill`, `slotValue`, the built-ins `{date} {time} {weekday} {month} {year} {first}`), how schedules expand (`schedule`), and how read/Inbox state follows each kind (`bulkState`).

## Output

One file per brand: `packages/mock-data/demo-corpus/bulk/<brand id>.json`, a JSON array of `BulkSource` (one per account the brand writes to; usually one). Then run `node scripts/demo-corpus/check.mjs bulk` until it prints `ok`. Don't edit any other file, don't run git, don't start subagents.

## Schedules: the volume

Pick a schedule that matches the brand's `cadence` and gives a believable volume over two years: a daily newsletter ~500 messages, a weekly one ~100, a monthly statement 24, a ride-share 2–4 a week only in the months he uses it (`from`/`to`), food delivery 1–2 a week, a code host's notifications 5–15 a week on work days (`random`, `perWeek`), a shop a few times a year (`random` with `perWeek: [0.05, 0.2]`). Times in the sender's zone, at the hour such mail goes out (newsletters early morning, receipts at all hours, statements at night). Together the brands should land near 4,500; say in your final message what yours add up to (count them with the loader if you like: `node -e` importing `load.ts` works under Node 24).

## Templates

- 2–5 templates per transactional brand (a receipt, a refund, a "rate your trip", a promo, an account notice), weighted by how often each happens. **The ride-share sends receipts and, from the same address, a promo and a "rate your driver" note**: the demo asks an AI to archive only receipts.
- `slots` give the variation: lists of real-looking values (pickup and drop-off streets in London, dish names, product names, driver first names, flight routes), `money` ranges, `int` ranges, `ref` patterns (`"HR-####-??"`). Use enough values that repeats are rare. Amounts in the account's currency (`currency`: "£" on English accounts, "MXN $" on Freelance).
- `text`: the plain-text part, as companies write it (short lines, the reference, the amount, "View your receipt: https://…", the footer: company address, "You're receiving this because…", unsubscribe on marketing only).
- `html`: the HTML part, a plain table layout with inline styles, the brand's colour, no external CSS. **Every link and image is on the brand's `.example` domain** (`https://hopperrides.example/r/{ref}`); no tracking pixels from anywhere else, no scripts.
- Transactional mail has no unsubscribe; newsletters and promos do (the loader adds a mailto List-Unsubscribe; put an unsubscribe link on the brand's domain in the footer too).

## Newsletters

`issues`, newest first: **at least 15 unique issues for a daily or weekday newsletter, 6 for a weekly, 3 for a monthly**; the loader gives the newest dates one each and reuses them further back. An issue is a real issue: 200–500 words in the text part, three to six items with specific (invented) news, links on the brand's domain, a sign-off from the editor, the footer. Today's (the anchor's) issues are what the digest summarises, so the newest issue of each must be dated content for that week (22 October 2026 is a Thursday). The `subject` can use `{date}`.

## Spam (only if your task says so)

`packages/mock-data/demo-corpus/bulk/spam.json`: a JSON array of about 30 `SpamSource`: phishing that imitates a bank or a parcel carrier (invented ones, on look-alike `.example` domains), crypto, fake invoices, "your mailbox is full", a prize, an SEO offer, two or three in Spanish to Freelance. `daysAgo` from 0 to 60.

## Quality bar

Read three filled messages of each brand (the loader can print them) and ask whether they could have come from a real company. No model tells, no exclamation marks in every line, no "We hope you enjoyed…" in every email.
