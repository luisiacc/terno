# Plan 167: `pnpm dev:demo-ai`, every AI feature with something in it

- **Status:** built.
- **Builds on:** plan 146 (Dev mode), plan 161 (the AI rating: `TERNO_TEST_NOW`, Pro's routing on the owner's keys), plans 141 to 145 and 162 to 163 (the AI surfaces), `dev.mjs --demo`.

## The request

> i need a dev:demo-ai mode that opens with ai turned on on dev mode, with the top message having drafts ready, and summaries, and a "today" with stuff in it and newsletters digest inside, basically so i can see all features of ai being there so i can quickly test it, also with previous conversations on ai ask inbox box, and other ai features, lay out in an md file how to use this ai-demo mode and where to look for stuff.

## What exists

- `pnpm dev:desktop:demo` (`dev.mjs --demo`): its own profile, `Terno-dev-demo`, seeded once with the demo mailbox (`seedDemo`: 3000 threads, 4 accounts, newest mail 22 October 2026 15:30 UTC). AI is off there, as on a real install. Every dev demo launch adds a sign-in code dated the real clock (`seedDemoCode`).
- Dev mode (plan 146): a local dev build (`TERNO_DEV_URL`) runs Pro's routing on `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `JEV_API_KEY`, which `dev.mjs` copies from the repo's `.env` into Electron's environment only. Settings → Dev mode → Pro AI (`dev-ai-switch`) turns it on.
- The AI rating (plan 161, `scripts/ui-rating/harness.mjs`): the demo mailbox, `TERNO_TEST_NOW` = `AI_NOW` (22 October 16:00 UTC, half an hour after the newest mail), `TZ=UTC`, Pro AI and the four background switches turned on through Settings, as a person would. The backend's clock is shifted; the window's is pinned by Playwright's `page.clock`.
- How each AI surface gets its content (the gallery's drivers, `/tmp/terno-scratch/ai-gallery/gallery.mjs`):
  - **Summaries:** on request (`action-summarize`), stored per thread; the background summarizer only reads mail that arrives after it was turned on.
  - **Reply ready:** prepared when a conversation that waits for a reply is opened, stored (`store.replies`), shown again on the next open.
  - **Today and the digest:** Today is live and local; the digest is prepared at `today.prepareAt` (08:00 by default) or at the first start after it, so at 16:00 turning it on runs it at once.
  - **Follow-ups:** a sent message read by the model; Settings offers to read the last 30 days of sent mail (up to 300 messages, one call each).
  - **Ask:** conversations kept in history (`ai.askHistory`).
  - **Create with AI:** Filters → the request → a rule, saved like any other (`source: "ai"`).
  - **Writing style:** learned on the machine, no model, whenever AI is available.
  - **⌘J drafting and the action preview** are made on the spot by what the person types.

## Design

### 1. The command

`pnpm dev:demo-ai` is `dev.mjs --demo-ai`; `pnpm dev:demo-ai --fresh` rebuilds the profile first (to the Trash, like `--cleandb`, never while an app holds it).

- **Profile:** `~/Library/Application Support/Terno-dev-demo-ai`, beside the other dev profiles (`TERNO_USER_DATA` wins, as in every dev mode). Never the real one.
- **Environment:** what `--demo` sets, plus `TERNO_TEST_NOW` = 22 October 2026 16:00 UTC (the rating's `AI_NOW`) and `TZ=UTC`.
- **Keys:** the three Dev mode names: the shell first, then the checkout's `.env`, then the main checkout's (found with `git rev-parse --git-common-dir`, so a worktree works), per name. Only those three names are read; no value is printed. Without Anthropic and OpenAI keys it stops before building and says which are missing and where it looked.

### 2. The fixed clock: the demo mailbox's day, in the window too

The demo mailbox is dated around 22 October 2026, so with today's clock Today has nothing in it and the digest has no newsletters from today. The demo runs at the rating's instant, 22 October 16:00 UTC, on every launch: what the first launch prepared is still today's on the tenth launch, and what you see is what the rating's screenshots show.

- **The backend:** `TERNO_TEST_NOW`, as the rating has it.
- **The window:** today the rating pins it with Playwright; a person's window has no Playwright, so the list would say 22 Oct where it means 15:30, a follow-up would say 18 days, and Later would pick a date the backend thinks is weeks away. Main computes the shift once (`TERNO_TEST_NOW` minus its clock at launch), hands the backend its start from it, and passes it to each window (`additionalArguments`). The preload runs one function in the page's world before any of the page's scripts (`contextBridge.executeInMainWorld`): `Date` and `Date.now()` read the shifted clock and run on. Only with the demo mailbox and `TERNO_TEST_NOW` (`test-hooks.ts`); never in a packaged app's normal launch. The rating keeps its `page.clock`, which sets an absolute time over it.
- **The sign-in code** of every dev demo launch is dated the real clock; under the fixed one it would be a future message at the top of the Inbox, so it isn't added when the clock is fixed.
- **UTC:** the window's zone is UTC, as the rating's: a day is the same day on any Mac.

### 3. The preparation: the app's own jobs, driven like a person

On the profile's first launch (no `demo-ai.json` marker in it, or `--fresh`), before the window opens, `dev.mjs` starts the app once more behind your windows (`TERNO_TEST_BACKGROUND=1`, Playwright's Electron launch, the same build, the Vite dev server and environment) and drives it through the UI, as the rating does. Every word comes from the real models through the same code a user's click runs. Each step prints a line (`[demo-ai] 3/7 summaries and Reply ready: 2 of 6 …`) and records itself in the marker, so a step that fails is retried on the next launch and the rest are kept.

1. **AI on:** Settings → Dev mode → Pro AI; Settings → AI → Summarize new mail, Follow-ups, Prepare a reply, the digest. The follow-up offer to read the last 30 days of sent mail is taken (the app's bound is 300 messages; the demo has 195, about $0.03 by the app's own estimate).
2. **The digest:** Today, until its row says how many newsletters it read.
3. **Summaries and Reply ready:** the top conversations of the Inbox (6) and the rows Today says need you (up to 4, the ones that wait for a reply), each opened: Reply ready prepares where it applies (waited for), and Summarize is asked for (waited for). The top message has both when it waits for a reply; the doc names which do.
4. **Follow-ups:** the Follow-ups list, until what the scan found shows (older follow-ups are already due, so Today lists them). Only if the month had nothing, one message is sent so the follow-up line still shows.
5. **Ask:** four questions about the demo mail, one with a follow-up question, so the history has four conversations.
6. **A rule made with AI:** Filters → "archive receipts from uber.com" → saved (future mail only; the Inbox is left as it is).
7. **Writing style:** waited for until it says what it learned (local, nothing spent); skipped with a note if it takes over a minute.

Then the app's own usage book (Settings → AI → usage, `ai:usage`) is read and printed: requests and US dollars. The preparation quits the background app, and the normal window opens on the same profile. Later launches find the marker and open at once.

Not prepared, since they're made by what you type: ⌘J drafting, the action preview, Rewrite. The doc says where to try them and with what words.

### 4. `docs/AI-DEMO.md`

How to run it, what the first launch costs (requests by feature and a dollar range, measured on the run), a tour (which conversation, which shortcut or button, what to expect) for every AI surface, how to reset (`--fresh`, or the folder), and what it never touches. Linked from `docs/DEVELOPMENT.md` beside `dev:desktop:demo`.

## Tests

- **Unit, `apps/desktop/src/demo-ai.test.ts`:** the arguments (`--fresh`, unknown ones refused); the profile path (and `TERNO_USER_DATA`); the keys file order (checkout, main checkout, none) and that only the three names come out; the missing-keys message names variables, never values; the environment (`TERNO_DEMO`, the clock, `TZ`, no `TERNO_TEST_BACKGROUND` for the window, set for the preparation); the marker: which steps run on a first launch, after a failed step, with `--fresh`, and a marker from another version starts over.
- **Unit, `test-hooks.test.ts`:** the window's shift only with the demo mailbox and a valid `TERNO_TEST_NOW`; the argument parsed back in the preload; the shifted `Date` (now, `new Date()`, a date given stays that date, `instanceof`, runs on).
- **Unit, backend-entry's rule:** no sign-in code under a fixed clock (a pure function).
- No suite needs real keys. The preparation itself is a dev script driving the real app on real models; it is verified by running it (screenshots below), not in `test:all`.

## Perf and resources

Nothing changes for a user: the clock hook needs the demo mailbox and a test variable. The preparation runs once per profile.

## Out of scope

- Hosted AI, canned or stubbed text (the owner asked for the real models).
- Pre-filling ⌘J or the action preview: they exist only for what a person types.
- The web build (`pnpm dev`): Dev mode there has no window clock hook; the desktop is what's asked.

## Revisions after the Codex review

1. **`TERNO_USER_DATA` could land the preparation on another mailbox.** `demoAiProfileProblem` refuses a folder named like a real profile (`Terno`, `Terno-beta`, without `-dev`) and a folder with a database but no `demo-ai.json`; the marker is written before the preparation starts, so a profile stopped early is still recognised as this demo's.
2. **Every relaunch rewound to 16:00,** under what the preparation made (the follow-up switch's `enabledAt` sits after it, so a send in the first minutes would be skipped). The marker records the demo's clock when the preparation ended (`clock`); later launches start there (`demoAiClock`), never before 16:00.
3. **New sends aren't due in Today for days.** The follow-up step no longer sends: the app's own offer to read the last 30 days of sent mail is taken (195 messages, the app quotes about $0.03), so older follow-ups are already due and Today lists them. One send stays as a fallback for a month with nothing.
4. **A failed step isn't always retried by opening it again.** The digest's failure is retried once with its own Try again; a Reply ready the model decided against (`skipped`) is reported as such, not as a failure: the step needs summaries, and the log names which conversations got a reply.
5. **Step checkpoints could repeat durable work.** Items are recorded one at a time (`progress`: each Ask question, the rule, the fallback send), so a step run again skips what it already made.
6. **The top row must have Reply ready.** Verified on both runs: the top Inbox conversation (¿Vamos al concierto?) gets both. The check waits for the card after the summary (a first run gave up after 4 s, before the model's decision); the doc names every conversation that has one, and why one doesn't.
7. **Key precedence:** the shell wins, then this checkout's `.env`, then the main checkout's, per name (`resolveKeys`), as `withDotEnv` does. The plan's wording said otherwise; the code was already this way.
8. **The preparing Electron had no owner in dev.mjs.** Its PID is handed back (`onPid`); Ctrl-C stops it by that PID with Vite, and `prepare` always closes it (SIGKILL by PID after 20 s) before the window opens.
9. **An Electron check for the clock.** `e2e/window-clock.smoke.ts` launches the dev build with no Playwright clock: the window reads the demo's instant from its first script, still after a reload, a date given stays that date, the list shows the newest mail as today's time, and a launch without `TERNO_TEST_NOW` reads the real clock. The rating's stub smoke still passes beside it (its `page.clock` sets an absolute time over the shift). The preparation itself stays a dev script on real models, verified by running it.

## Verification

Two runs on temp profiles (`/tmp/terno-scratch/p164/demo-ai/run1`, `run2`), screenshots in `/tmp/terno-scratch/p164/demo-ai/shots` (Lumen, light and dark):

- run 1: 98 s, 65 requests, US$0.14. Its Reply ready check gave up too early (Playwright's `isVisible` doesn't wait: fixed, `shows()`), the writing style likewise, and one Ask question wasn't in the mail.
- run 2: 216 s, 82 requests, US$0.12: 7 summaries, 4 prepared replies (the top conversation among them), 7 follow-ups, 4 Ask conversations, the rule, the writing style learned. The relaunch opened with no preparation, the clock at 16:04, the top conversation's summary and reply there within a second.
