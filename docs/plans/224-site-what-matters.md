# Plan 224: “What matters” on the site, as Terno Pro's lead

- **Status:** built. The owner's second round (below) overrides the placement in “Design”: it's Pro's lead, not a section after the hero.
- **Builds on:** plan 97 (terno.app), plan 210 (the feed), 211 (AI on by default, per account), 222 (the clear horizon), 207 (Open at launch).

## The request (verbatim)

> we need to redo the app marketing site at [site](apps/site) , the part that talks about the old 'today', now its the feed 'what matters' and thats one of the main things so should be more towards the top and needs to be very clearly explained so usersget the bnefit

## What exists

- `apps/site`: three home designs share one copy (`src/copy/en.ts`, `es.ts`) and the pictures (`public/shots`, `src/shots.json`). Midnight is `/` and `/es/` (`SITE_DESIGN`); Lumen and Letter are noindexed previews at `/designs/<id>/`.
- “Today” is one of four small tiles inside Terno Pro, far down the page (`PRO_MORE` in `parts/pro.tsx`, `copy.pro.today`): “What needs you today… Twelve at most, so it stays short”. Every line of that is out of date: the view is now “What matters”, a live feed with its history (plan 210), with no cap (owner, 2026-11-13).
- Its picture `ai-today` (Nov 11) is the old list: a “Today” title, inbox rows, “4 need you”. `shots/ai-shots.ts` already waits for the feed's headings (`wm-heading`), but crops to the list's rows (`thread-row`), which the feed doesn't draw.
- The app explains the view itself in plan 207's question (`firstScreen.ask.*`): “It reads your email and shows only what you need to do. Your Inbox keeps everything.” The site should say the same thing the same way.

## What the view does (the claims the copy may make, each checked in the code)

- Reads mail as it arrives (plan 210 §2), every account, and lists only what needs you: tasks with a day (bills, renewals, expiries, requests with a deadline), your own promises from sent mail, conversations waiting on your answer, reminders.
- One plain sentence per line, with when in a column (“Was due Sat”, “Today”, “since 2:45 PM”).
- Order by urgency: Missed, Today (with Waiting on you), the days ahead, Coming up last. A missed date stays at the top.
- Never newsletters or notifications (the digest/automated row); no line for an invoice already paid or a plan that renews itself (owner 2026-11-16).
- **D** marks Done and moves it under Earlier, Undo restores it; **B** Later; **Shift-D** Remove (`keybindings/resolve.ts`).
- When nothing needs you: the horizon and “You're free until 3:00 PM.” (plan 222).
- Can be the first screen (Open at launch, plan 207); an account can be left out (“Show in What matters”, plan 211); a sender-and-kind can be muted.
- It runs on AI: Terno Pro (coming soon), the user's own key or a model on the Mac (`todayOffered` = `aiFeaturesOffered`).

## Design

### Placement

Its own section, the first after the hero, before the stats strip and the feature grid; `id="what-matters"`, in the header's nav. The hero's subtitle names it in one sentence, so the promise is above the fold.

### The section (Midnight; Lumen and Letter get the same content in their own idiom)

1. Eyebrow “What matters”, a headline that states the benefit (“Hundreds of emails. A handful need you.”), a lead that says what the view is in plain words, with examples.
2. The picture: the feed as it looks now (sidebar and the feed column), large, in the app window frame.
3. Four short benefits, each a title and a line: say what to do, not what arrived; the urgent stays on top; your own promises are kept; noise stays out. Then one line on Done/Earlier/the horizon.
4. A quiet foot line: Open at launch, per-account, and how it runs (Pro, own key or local model), linking to the privacy page's AI section.

Shared, like `parts/pro.tsx`: `parts/what-matters.tsx` holds the picture name and the list of benefit ids, so the three designs can't drift.

### Pro

The “Today” tile leaves Pro (it has its own section). Its place goes to Follow-ups, which the site doesn't show yet and has a picture (`ai-followups`): “When a question you asked goes unanswered, it comes back on the day you need it.” Pro's body sentence stops promising “finds what needs you today” and points at the view instead.

### Copy

en and es together (`es` keeps the app's «Lo importante»), quoted mid-sentence and bare as a title (owner's rule, 2026-11-19). Meta description and alt text updated.

### Picture

`shots/ai-shots.ts`: the What matters state becomes `ai-what-matters`, cropped to the sidebar and the feed column down to the last drawn line; the wait looks for a dated line and a promise (“You said…”) in the feed. Taken on real models as every AI picture is (`pnpm --filter @terno/site shots:ai -- --only=ai-what-matters,ai-followups`); `ai-today` and its files are deleted.

## Tests

- `src/render.test.ts`: every home route has `#what-matters` before `#features` and before `#pro`, its title, the four benefits and the picture (both modes); Pro no longer holds `ai-today` and does hold `ai-followups`; the nav links to `#what-matters`.
- `e2e/site.spec.ts`: axe in light and dark already covers the page; run it.
- Typecheck (the es shape check).

## Perf

Static HTML; one more picture, lazy like the rest (only the shown mode loads). No script.

## Out of scope

- A picture of the clear horizon (it needs a mailbox with nothing left; words only for now).
- Retaking the other AI pictures.

## Revisions after the Codex review

1. **Missed doesn't stay forever.** A missed date shows for a week, then retires (`dated.ts`). The urgent benefit now says the most pressing thing is always the first line, not that late things stay until dealt with.
2. **Automated mail is in the view, as one row.** Alerts (a failed payment) do get lines. The "quiet" benefit says newsletters and automated mail fold into one row at the end, and a paid or self-paying bill gets no line.
3. **Waiting rows aren't tasks.** The lines' benefit is "One plain line each", with the app's three real kinds of sentence (a task, your promise, someone who wrote to you); the lead says "what needs you", not "what you have to do".
4. **Follow-ups come back after a set number of days** (`nudgeAfterDays`, next morning), not "on the day you need it". Reworded.
5. **The privacy page's AI section is stale** (its "What each feature sends" lists only filters and sorting; it says requests go straight to the provider while Pro uses the relay). Pre-existing and legal text: left for the owner, not rewritten here. The new section links there as Pro's notes already do.
6. **The picture's bar** now needs, among open lines (not Earlier's, not the digest's), a promise of yours and a line that isn't a waiting conversation, with their "when".
7. **The feed picture has its own bar**, no longer the digest's.
8. **The crop is the whole window** at 1200×860 (sidebar and feed), taken after the resize with the lines rechecked; the section's "down to the last line" wording is dropped.
9. **Follow-ups' picture** is the reading pane's head (subject, the unanswered question's card, the message's first lines) in a 1180-wide window, so it peeks at Pro's common scale (`.site-peek-ai-followups`).
10. **Phones** crop the picture to the feed's column (`.site-wm-shot`, like the Pro lead's), and hide the window bar.
11. **Order test** finds Letter's features by `#f-unified`, and also checks the section comes before the first stat.
12. **e2e:** `/es/` axe-clean in light and dark at 1440, 390 and 320 px with no sideways scroll; the "What matters" link lands clear of a sticky header in every design.

## What the Codex code review changed

1. **A dated line is known by its when** (a day, “Today”, “Was due …”), not by its sentence: a waiting conversation with a summary has no “wrote to you”, and passed the old check.
2. **The promise and the task must be inside the captured window** after the resize (the virtualizer mounts lines below it); short of that, the picture falls below its bar.
3. **No “nothing slips” guarantee:** a dated promise retires a week after its day. The benefit now says it's on the list for its day, so it doesn't slip your mind.
4. **The hero names the view** (“What matters”: one view of only what needs you), and the test asserts the name, not just the phrase.
5. **The benefits' bodies are tested**, each right under its title, in every design.

## Taking the picture

The first runs found the feed with only waiting conversations. The diagnosis (the failure now prints it): the showcase mailbox has 332 messages in its last 14 days; plan 211's check of mail already here queues 300 of them, and the dated reader reads them **oldest first** (plan 204, revision 5), one at a time, at roughly one request every 25–40 s. After 20 minutes it was still on mail two weeks old, with the newest (a roadmap due Friday, a flight on Tuesday, a promise to call) still queued. The capture now waits up to 10 minutes by default and longer with `WM_WAIT_MS`.

*For the owner:* the same is true of a new install. A first account's “What matters” fills from its oldest mail forward, so for the first hour or two it shows two-week-old asks and none of today's. Reading the check newest first (or today's first) would make the first screen right sooner; that's an app change for its own plan, not this one. The same runs also showed a parcel-tracking service's notices as “Answer Parcelpoint about the package” (an ask from an automated sender), and the automated row labelled “0 archived”.

**Then a three-hour run settled it: it isn't slow, it stops.** Every run made exactly 46 dated requests and then none. The dated reader's daily ceiling is 300 requests *or* 600,000 input tokens (`DAILY_INPUT_TOKENS` in `ai-limiter.ts`), each request reserves its worst case before it leaves (about 13k input tokens here), and on `DailyLimitError` the reader stops until the next local day (`failed()` in `dated.ts`). So on a first day the check of mail already here spends the day's budget on the oldest ~46 messages, and nothing newer, including mail arriving live, is read until tomorrow. The picture can't show today's tasks until this changes, or the showcase's 14 days hold fewer messages.

## The owner's second round (2026-11-20)

> also for the pictures on the site it needs to respect the dark/light mode toggles.
>
> for pictures of the feed, use the app using the `run.sh demoai` cmmand
>
> move the feed picture and explanation to where the 'pro' section is since that's only available there.

- **Placement:** “What matters” is Terno Pro's lead, between Pro's header and the drafted reply, in all three designs (`#what-matters` inside `#pro`; its title an h3 under Pro's h2, its benefits h4). The hero is back to its words before this plan, the header has no “What matters” link, and its foot line drops “It runs on AI…”, which Pro's own notes say. Pro's body now opens with it: “Pro shows you what matters, drafts your replies and sums up long threads.”
- **Light and dark:** the first picture was a stand-in with the light capture in both modes; both pictures now have a real light and a real dark capture, and the picture's switch flips between them (Midnight opens on dark).
- **The pictures come from the AI demo** (`./run.sh demoai`, plan 167), not `shots:ai`: `shots/demo-shots.ts` (`pnpm --filter @terno/site shots:demo`) connects to a running demo over its DevTools port (`TERNO_REMOTE_DEBUGGING_PORT`), sets the pictures' appearance (Lumen, GitHub palettes, as `pictureSettings`), and takes `ai-what-matters` (the window at 1200×860) and `ai-followups` (the reading pane's head: subject and the unanswered question's card, at 1180×900). It runs on a copy of the demo's profile (without Chromium's `Singleton*` files) so the appearance doesn't stay in the owner's. The window's 120 % zoom is undone in the capture (`Page.captureScreenshot` with a clip in window pixels and a scale of 1/zoom), so each picture is its CSS size at 2×. The follow-up picture stops at the card: the messages under it carry the demo account's own name and address.
- **`shots:ai`** no longer takes these two (nor the old `ai-today`, deleted with its files); it only answers plan 207's first-screen question, which now appears once AI is on, and reaches the digest through the feed. The diagnostics added while chasing the dated reader are gone; the finding stays above, for its own plan.
- **What the demo's feed shows:** two missed promises (“You said you'd call to discuss the details.”, “Was due Sat”) and 38 conversations waiting on you; no dated task (its mailbox's dated reading is capped the same way, “Taking the picture”).

### What the second Codex code review changed

1. **No identity in the follow-up picture:** `demo-shots.ts` takes the first unanswered question whose head is only its subject, the line under it and the card (nothing between them, where a one-message conversation shows its sender) and has no painted address in the box (a screen reader's 1 px line doesn't count); otherwise it takes nothing.
2. **The raw folder is made** before the first capture (it's gitignored, so a clean checkout has none).
3. **No retired picture comes back:** `encode` skips `ai-today` from an old capture, and `demo-shots` encodes only its two.
4. **Letter's feed figure spans the wide column:** “What matters”' wrapper is a `letter-sub` subgrid, as the figure's grid needs.
5. **“routine automated mail”**: an alert that needs you (a failed payment) does get its own line.
6. **`shots:ai` doesn't switch Follow-ups on** or look for plan 204's offer (gone since plan 211): none of its pictures uses them.
7. **e2e checks both new pictures' modes**: in Lumen (light) and Midnight (dark), each shows its own mode, the switch shows the other, and the two files differ (the stand-in had one capture under both names).
8. **The outline is tested:** Pro's h2 comes before “What matters”, whose title is an h3 and its benefits h4s, in all three designs.

Also found while re-running the demo capture: a second click on the open conversation closes it, and a promise follow-up shows What matters' card, not the follow-up line; the script skips both.

## The owner's third round (2026-11-23): the first lines name it

> i want to let the user know those things that are in the subtitle, i want to also let them know of the what matters section which is pretty revolutionary and potent their usage with ai(summaries,draft, followup detection), but thats on the ai plan, its still the best email client without ai, how do we convery all of these on the first lines too so they know to keep reading below and find out more

> pro plan is not active but they can use AI already, the pricing is what's not built

This reverses the second round's "the hero is back to its words": the section stays in Pro, but the hero points at it.

- **A link above the title** (`WhatMattersNews` in `parts/what-matters.tsx`, styled by each design): a "New" tag and "“What matters”: only the email that needs you", down to `#what-matters` (`WM_ANCHOR`). The header still has no link to it.
- **The subtitle in the owner's words:** "Unified inbox. Instant search. Archive one email, and every one like it goes too. Fully local, no sign-up." ("no sign-up", since "no account" reads as no email account.)
- **The AI as the subtitle's last sentence:** "Turn on AI for summaries, drafted replies, and reminders when someone doesn’t reply." It names no plan or price: the features work today on the user's own key or a model on their Mac. (First a paragraph of its own; two grey blocks of the same weight looked heavy, and of four mock-ups the owner chose one paragraph.)
- **Pro's chip** says "AI available today · Plan coming soon" instead of "Coming soon": the features work, the plan and its price aren't sold yet ("Planned: …" stays).
- Tests: `render.test.ts` (the hero's one link, before the h1, the AI line under the subtitle, no plan or price in the hero) and an e2e that the link lands on the section clear of a sticky header in every design and width; axe stays clean in all three designs, light and dark, 1440 and 390 px.

### What the Codex review changed

1. **Pro's chip** first read "Use it today with your own key", which beside "Terno Pro" says Pro runs on your key; it now says the AI is available and the plan is coming.
2. **The e2e finds the hero's link by its accessible name**, not its href.

Not taken: rewording the subtitle's archive sentence, "Fully local" and "reminders" (the owner's chosen words), the Spanish teaser (it matches the section's own "te necesitan"), and an instant jump instead of the site's smooth scroll (every anchor on the site already scrolls that way).
