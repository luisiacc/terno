# Plan 161: rate and polish the AI surfaces

- **Status:** planned.
- **Builds on:** plan 158 (the UI rating), plans 131 to 157 (the AI features), 146, 147 and 150 (Dev mode and the one gate), plan 160 (runs after it lands).

## The request

> Next, after the precision work: rate and polish the AI surfaces, which no round has seen so far. The harness removes the API keys (harness.mjs:46), nothing turns on Dev mode's Pro AI, and capture.mjs shoots no AI state, so every score so far covers the app with AI off.
>
> Scope, from the owner: run only the AI screens in these rounds, not the nine everyday screens again, and have the raters judge only the AI parts of each screen. Do at least 2 to 3 rounds of rate → fix.
>
> 1. AI on in the rating, without real keys. Real calls cost money each round and give different output, so rounds wouldn't compare. Use the local model stub the e2e suite already has (apps/web/e2e/ollama-stub.ts; see summaries, ai-draft, ask, today, followups and replies-ready specs): the harness starts it and sets the demo profile's provider to it, and turns on whatever the gate needs on this build (Dev mode's Pro AI on a local build, plans 147 and 150). Output is the same every round, costs nothing and stays on the machine. The raters' hands-on harness gets the same setup so they can use the features, not only look at shots.
>
> 2. An AI screen set, selectable on its own (e.g. `pnpm ui:rate --screens ai`), shot in light and dark in every design and at the small window size, like the others. Cover what /Users/Luis/projects/emailclient/how-to-test-ai-features.md and plans 131 to 157 list:
>    - a conversation with its summary card (plans 132, 148)
>    - ⌘J drafting: the prompt, then the draft it wrote (133)
>    - Ask your mail (⇧⌘K) with an answer and its sources (141)
>    - actions in plain English: the preview before Apply, and Undo after (143)
>    - Today, with the newsletter digest (145)
>    - a follow-up line with Nudge, and Reply ready's Use
>    - Create a filter with AI, and the Writing style page, if they fit
>    Don't change the demo data to flatter a screen; add only what an AI screen needs to have something to show.
>
> 3. The brief for this set tells raters to score only the AI parts of each screen (the summary, the ⌘J bar, the Ask panel and so on) with the same facets and scale. Everything else about independence stays: a clean room, no bar, no earlier scores, no word about what changed between rounds. Write the AI screens and their scope into docs/ui-rating.md and the plan.
>
> 4. Between rounds, fix what the raters found, with the usual process (tests, light and dark screenshots, Codex review). A finding that goes against a product rule or an AI rule (privacy, the one gate, spam triggers nothing, no lazy loading) goes to the owner, not into the code. Log every round's numbers as they are in the plan.
>
> When done, report the per-round numbers by screen and facet, what each pass changed, and before/after figures with arrows and numbered notes on the AI surfaces (shoot.mjs and make.mjs), light and dark.

## What exists

- **The rating tool** (`scripts/ui-rating/`). `rate.mjs` freezes a runtime: the build, Electron, playwright-core, `harness.mjs`, `capture.mjs` and `brief.md`. It captures each design's shots, then runs each rater in a clean room under an allow-listed env. `gate.mjs` checks reports. `harness.mjs` `launch()` deletes the three API keys, fences the renderer to loopback, and starts a throwaway demo profile (`TERNO_DEMO=1`).
- **The model stand-ins.** `apps/web/e2e/ollama-stub.ts` is an Ollama look-alike on 127.0.0.1 (`/api/tags`, `/api/ps`, `/api/show`, `/v1/chat/completions`). It answers only `probe`, `thread_summary` and a filter rule; every other task gets the filter JSON. The AI specs mostly use the in-process `fake` provider (`packages/ai/src/providers.ts`, `AI_PROVIDER_IDS`) through `settingUp(...{ ai: { provider: "fake" } })`, and some seed rows directly in the store (followups).
- **The gate.** On a local build, AI features show when Dev mode's Pro AI is on (plans 146, 147, 150). Elsewhere they need a provider or Pro.
- **AI features and their screens:** `how-to-test-ai-features.md` and plans 131 to 157.

## Design

### 1. A model for the rating: the stub, taught every task

- **One stub, in the frozen runtime.** `scripts/ui-rating/model-stub.mjs` is plain JS, since the frozen runtime has no TypeScript. It speaks the same Ollama API as `ollama-stub.ts`. To keep a single source, the e2e stub imports its answers from a shared module, or `ollama-stub.ts` becomes a thin wrapper over the `.mjs`.
- **Every task answered.** The chat endpoint answers by the request's `json_schema` name (or the task's marker for free-text tasks): summary, draft, Ask (answer plus sources taken from the ids the request carried), plain-English actions (a plan over ids from the request), follow-up extraction, reply ready, digest, filter, writing style, and categorize if Today needs it.
  - Answers are built from the request: a summary names the conversation's real people and the subject, and Ask cites the messages it was given.
  - The output reads like a capable model's. It is fixed and the same each round.
  - **Frozen with the round's evidence.** Like the demo mailbox, the answers are fixed before the first round and never edited between rounds. A rater's finding about an answer's words is about the model, not the UI, and is out of scope (the brief says so).
- **Started by the harness.** `launch({ ai: true })` starts the stub on a free loopback port and stops it on `close()`. Before the first window it writes the demo profile's settings:
  - provider `ollama` at the stub's URL, with the stub's model
  - Dev mode on with Pro AI
  - Summarize new mail, Keep track of what I promise, Prepare a reply and Prepare a digest each day
  - whatever else a screen needs

  It does this through the same settings path the app uses, never by patching the build. API keys stay deleted. The renderer's fence is unchanged: the backend talks to the stub on loopback.
- **Settled before shooting.** After launch, the harness waits for the AI jobs the screens need (summaries, follow-ups, reply ready, the digest) to finish against the stub. It waits on their state in the page or through the backend, never on a fixed sleep. A job that can't finish fails the capture loudly.

### 2. The AI screen set

`capture.mjs --screens ai` (and `rate.mjs --screens ai`) shoots only these, in light and dark, at 1440x900. A `-small` copy at 1100x700 is shot for the five marked ◆.

| Files | Screen | Rated under |
|---|---|---|
| `a01-summary` ◆ | A conversation with its summary card open | `summary` |
| `a02-draft-prompt` ◆, `a03-draft-written` ◆ | ⌘J: the prompt bar with an instruction typed, then the draft it wrote | `ai_draft` |
| `a04-ask-answer` ◆ | Ask your mail (⇧⌘K) with an answer and its sources | `ask` |
| `a05-actions-preview` ◆, `a06-actions-undo` | Plain-English actions: the preview before Apply, then the Undo offered after | `actions` |
| `a07-today`, `a08-today-digest` | Today, and its newsletter digest | `today` |
| `a09-followup`, `a10-reply-ready` | A conversation with a follow-up line and Nudge; one with a reply ready and Use | `followups_replies` |
| `a11-filter-ai`, `a12-writing-style` | Create a filter with AI (the generated rule, before saving); the Writing style page | `ai_settings` |

`a11` and `a12` are in the set if they render with the stub. If one can't, it's left out and the plan says why.

- **Demo data.** The demo mailbox gets only what a screen needs and lacks today. Each addition is listed here with its reason and kept to the minimum, for example a sent message with a promise for the follow-up, and unread newsletters for the digest. Every addition goes behind the AI set, so the everyday screens' evidence (the nine screens and their shots) doesn't change. The everyday capture is re-run once to prove it: same counts, same rows.
- **The everyday set is untouched.** `--screens` defaults to the everyday set. `gate.mjs` reads each report's screen list from the set it was rated against.

### 3. The AI brief

- **A brief of its own.** `brief-ai.md` uses the same scale, facets, rules and report format as `brief.md`. Its table lists the AI screens, and its scope paragraph says:
  - Score only the AI parts of each screen: the summary card, the ⌘J bar and its draft, the Ask panel, the actions preview and its undo, Today and the digest, the follow-up line, reply ready, the AI filter and the Writing style page.
  - The rest of the window is context, not rated.
  - The model's words are a fixed local stand-in, the same in every run. Rate how the app presents them, not the words themselves.
- **Hands on.** The room's harness launches with `ai: true`, so the rater can use the features (⌘J, ⇧⌘K, Apply and Undo, Nudge, Use). The capture example shows how each AI screen was reached.
- **Independence.** Unchanged: a clean room, no bar, no earlier scores, no word about changes.
- **Facets.** The same UI and UX facets, so numbers compare across sets.

### 4. The rounds

- **Order.** Round `ai-r00` runs on main after plan 160 (and 159) land, in all four rated designs, with both raters.
- **Between rounds.** Fixes go in with the usual process: a plan addendum, tests, light and dark screenshots in every design, and a Codex review.
- **Owner decisions.** A finding that conflicts with a product or AI rule goes to the owner, not into the code: privacy, the one gate, spam triggers nothing, no lazy loading, inline compose, and no undocumented provider behaviour.
- **How many.** At least two fix passes and three rated rounds (`ai-r00`, `ai-r01`, `ai-r02`). The bar is the standing one (every cell ≥ 9 from both raters, two passing rounds in a row). If the rounds stop short of it, the plan says where it stands.
- **The log.** Each round's numbers go in this plan exactly as they came: per screen and facet, per rater, per design. That is the means, the cells at 9 or above, the lowest cells, and the high issues.
- **The report.** Before/after figures on the AI surfaces with `/tmp/terno-scratch/ui9/report/shoot.mjs` and `make.mjs`, extended to the AI screens, in light and dark, with at least one figure per design that changed.

## Tests

- **The stub.** It answers every task with output that passes that task's schema. The answers are deterministic: two runs give byte-identical answers. Ask's sources and the actions' targets refer only to ids from the request.
- **The harness.** `launch({ ai: true })` shows the AI entry points: ⌘J opens the bar, ⇧⌘K opens Ask, the Today row is present. `launch()` without it shows none. No request leaves loopback, which is asserted from the route log.
- **The capture.** `--screens ai` writes every file in the table, in both modes and the small sizes. `--screens` left out writes exactly the everyday set.
- **The gate.** `gate.test.ts` covers an AI report checked against the AI screens, and an everyday report checked against the everyday screens.
- **The everyday evidence.** The demo additions leave the everyday shots' row counts and visible rows unchanged.

## Out of scope

- The everyday screens: no re-rating in these rounds.
- The model's quality: there are evals for that (plans 154, `ai-eval-corpus`).
- Real providers, real keys, and Pro's allowance.

## Revisions after the Codex review

All twelve points taken. Where they change the design:

1. **The gate on the rating build is a saved provider, not Dev mode.** The harness runs the frozen build without `TERNO_DEV_URL`, so it is not a dev build: Dev mode is off and `settings.update` refuses `devAi`. On that build the one gate opens with a saved provider (plans 147, 150). That is "whatever the gate needs on this build". On a dev server, `withDevAi()` would swap Ollama for a cloud provider, which is exactly what the rating must avoid. The rating uses the saved Ollama provider on the frozen build. Dev mode's own gate stays covered by `dev-mode.spec.ts`.
2. **Settings go in after the seed, through the backend's own update path.** A fresh demo profile seeds, then writes `settings["app"] = { ai: { provider: "none" } }` (`backend-entry.ts` `initialize()`). The harness's first launch (the one that already sets the design) applies the AI settings through `settings.update`, using the same shapes the Settings UI sends (`ai.profiles.ollama`, model, baseURL, and the feature switches). The rated launch is the second one. A test proves the settings survive the relaunch.
3. **Streaming.** Drafting (`runCompose`) and Ask's answer (`runAnswerFromMail`) stream (`openaiChatTransport().stream()`, `stream: true`). The stub serves SSE `choices[].delta.content` chunks, a `[DONE]` terminator, and handles cancellation. Drafts come back in `<email>…</email>`, with `<subject>` where the task asks for one.
4. **The task inventory, written down before the stub.** Every call `createAi()` makes is listed in this plan with its schema or stream format and what its answer must contain to render a screen:
   - `thread_summary`
   - compose (streamed)
   - `ask_plan` (searches), then the answer (streamed, citing the labels it was given as `[m1]`)
   - `action_plan` (conditions over accounts, categories and folders, not thread ids), then `action_check` (`{ drop: [] }`)
   - `sent_mail` (follow-ups)
   - `needs_reply`, then the reply draft (streamed)
   - the digest
   - the filter rule
   - `parse_intent`, `voice_judgment` and `classification` where a screen reaches them

   The stub's tests run each answer through the task's own validator and render path, not only its schema.
5. **The summary is asked for.** Old seeded mail isn't summarized automatically (`SummaryWorker.consider()` needs live new-mail marks, and `summaries.spec.ts` holds that). `a01` uses the supported manual Summarize on a designated conversation of 60 or more authored words, then waits for the card's ready state.
6. **Nudge needs an awaiting follow-up.** Nudge shows only for `kind === "awaiting"`. The harness makes a live send through the app (a question to a person, so the stub's `sent_mail` answer says `expectsReply: true`, with its recipients' labels in `awaiting`), or runs the supported `followups.scan`. It never writes rows directly. Promise quotes, if any, occur in the authored text, or `checkSentMail()` drops them. The capture waits for the follow-up line.
7. **Reply ready on its own conversation.** Preparation starts when a conversation is opened and settles, and it needs a recent `waitingSince`, membership of the Inbox or a category, no draft, and writing preferences on. The demo gets one designated conversation that qualifies. It is not the one used for ⌘J, whose draft would disqualify it. The capture opens it and waits for `reply-ready[data-phase="ready"]`.
8. **The clock.** The demo's mail is dated around 22 October; the digest window is three days and the backend uses `Date.now`. For comparable rounds, the rating runs at one fixed instant. The engineer first looks for a supported clock override that the demo and e2e already use. If none exists, the AI-only fixtures (newsletters for the digest, the reply-ready conversation, the follow-up send) are dated relative to the demo's own "now", and the plan records how. Nothing is added that a normal launch could reach. The digest's `prepareAt` and its completion are waited for explicitly.
9. **Writing style and the AI filter.** Writing style renders profiles learned locally from sent mail (`VoiceLearner`), with no model call. `a12` shows that page in its learned state. The "Let AI study my style" flow is out unless the page needs it. The filter rule is already in the stub. Both screens are in the set: "leave it out" is no longer an option, and a broken fixture is a failure.
10. **Nothing leaves loopback, enforced in every process.** The rating profile turns off sender icons and updates. The backend's requests are observed and asserted, not only the renderer's: each resolved AI task destination must be the stub's port, and any other host fails the capture. This uses the existing net policy, plus a log the harness reads, for example an env-gated record of `net-policy.ts` decisions in the profile's logs. The fence in the renderer stays.
11. **The round's set is frozen, not taken from reports.** `rate.mjs` writes `round.json` with the screen set, the required capture states, and hashes of the brief, the stub's answers and the demo additions. `gate.mjs` validates every report against `round.json`, never against the report's own list. Inclusions are frozen before `ai-r00`. **Rounds:** at least `ai-r00` to `ai-r03`, since the bar needs two passing rounds in a row on one commit.
12. **A brief of its own, through and through.** `brief-ai.md` replaces every whole-app instruction:
    - overall scores describe the AI surfaces
    - the hands-on list is the AI flows
    - consistency is judged among the AI surfaces and against the screen they sit on
    - each screen names its rated region (for example `ai_draft` rates the ⌘J bar, its states and the draft it produces, not the ordinary composer around it)

    `rate.mjs`'s `brief()` takes the set and injects only that set's hands-on text. AI scores are compared only with AI scores, at the same scope and evidence.

## The task inventory

Written before the stub (revision 4), from `createAi()` in `packages/ai/src/tasks.ts` and each backend caller. On Ollama every task goes through `openaiChatTransport` to `POST /v1/chat/completions`. A structured task carries `response_format.json_schema.name` (the probe walks the ladder from `json_schema`, and the stub supports it, so that is the saved capability). The two free-text tasks have no schema: they're told apart by their system prompt's first words (`isComposeRequest`, `isAnswerRequest`). Discovery is `GET /api/tags`, `GET /api/ps` and `POST /api/show`.

| Task | Wire | Caller | Screen | What the answer must hold to render |
|---|---|---|---|---|
| `probe` | json `{ ok }` | Settings → AI → Test (`ai.test`) | setup | `{ "ok": true }` |
| `thread_summary` | json `{ summary, items[] }` | `SummaryWorker` (Summarize, `summaries.request`) | `a01` | a summary of 1 to 3 sentences that names the sender and states where things stand; items whose `message` is a label from the request, under 15 words, not repeating the summary. No word that fades ("tomorrow", "this week") and no weekday without its date, or the validator asks again; no amount or currency the mail lacks. |
| compose | streamed text, `<subject>` then `<email>…</email>` | `WritingService.compose` (`ai.compose`): ⌘J | `a02`, `a03` | the body inside `<email>`, a greeting by first name, the instruction said in the author's words, the author's sign-off; `<subject>` only when the task says "Write a subject too." |
| `needs_reply` | json `{ needsReply }` | `ReplyService.prepare` on opening a waiting conversation | `a10` | `true` for mail that asks something |
| compose (prepared) | streamed text, as above | `ReplyService.run`, with `PREPARED_INSTRUCTION` | `a10` | an answer to what the last message asks, with a `[placeholder]` for any decision the author hasn't made |
| `ask_plan` | json `{ kind, queries[] }` | `AskService` (⇧⌘K) | `a04`, `a05` | `kind: "question"` with queries the search can match (a named person in `from`, words in `anyOf` with their Spanish forms); `kind: "command"` for an imperative |
| answer | streamed text, `[mN]` citations, `<status>` | `AskService` → `runAnswerFromMail` | `a04` | one or two sentences, each claim cited with a label from the request, a date where the fact could age, and `<status>answered</status>` on its own line; `not_found` when nothing fits |
| `action_plan` | json, conditions over fields (not thread ids) | `ActionsService` (an Ask command) | `a05`, `a06` | `actionType` from the list, conditions `convertWireFilter` accepts (one `matches` pattern per field, an age only beside a meaning), `lookIn`, `future`, `meaning` |
| `action_check` | json `{ drop[] }` | `ActionsService` when `meaning` is true | `a05` | group labels from the request only; drops only groups that don't fit |
| `sent_mail` | json `{ promises[], expectsReply, awaiting[], kept[] }` | `FollowupWorker` after a send | `a09` | `expectsReply: true` and `awaiting` with recipient labels from the request when the mail asks a question; each promise's `quote` copied exactly from `<own_text>` (else `checkSentMail` drops it) |
| `newsletter_digest` | json `{ items[] }` | `TodayService` digest | `a07`, `a08` | one item per label given; `newsletter` with one sentence of at most 14 words for issues people subscribe to, `other` with an empty line for the rest |
| `filter` | json, the wire filter | `AiService.generateFilter` (Filters → Create with AI) | `a11` | conditions and actions `convertWireFilter` accepts; a name and one-sentence explanation in the prompt's language |
| `parse_intent` | json `{ recipient }` | ⌘J on a new message whose instruction names someone | not on a rated screen | a candidate id or null |
| `voice_judgment` | json `{ traits, notes[] }` | `VoiceLearner.judge`, only after "Let AI study my style" | not on a rated screen (`a12` is the learned state, no model call) | integer traits in range; notes about manner only, no digits |
| `classification` | json `{ results[] }` | smart categories (`aiCategorize`, off by default) | not on a rated screen | one result per item id |

The stub answers all fourteen; an unknown task is a 500 that names it, so a new task can't pass silently.

## How the tooling was built

The tooling only; the rounds run after other work lands.

### The stub

`scripts/ui-rating/model-stub.mjs` is the one source: the rating's harness starts it, and `apps/web/e2e/ollama-stub.ts` is now a wrapper over it (its hooks for holding, delaying and failing requests moved with it). It answers the fourteen tasks above from the request, and it streams compose, Ask's answer and Reply ready's draft as SSE pieces of a dozen characters (20 ms apart for the rating, at once for e2e), stopping when the client goes.

The demo's mail is made of a fixed bank of sentences (`packages/mock-data/src/banks.ts`), so the stub knows each one as a reader would put it: what the sender did, in the third person, what it asks of the reader, and how a reply answers it without deciding anything for them. Relative days are written as dates from the message's own date ("before Friday 23 October"), so the summary validator never sends an answer back. A sentence it doesn't know is quoted as written, its relative days anchored. Two limits are deliberate: the stub can't translate, so a draft is in the language the task names (or the instruction's), and its words are frozen with the round (the brief puts them out of scope).

`summaries.spec.ts` asserted the old stub's fixed sentence; it now asserts the shared stub's own answer to what was sent, and the arrow goes to the message the item cites (Yuki's question, m7).

### The clock

The backend reads time only through `BackendCore.now()`, and the e2e dev server already passes it a fixed `now`. The desktop had no such seam, so `apps/desktop/src/test-hooks.ts` adds one: `TERNO_TEST_NOW` (an epoch in ms) starts the backend's clock there and runs it on at the real pace. Main passes it to the backend only for the demo mailbox (`testClock(env, demo)`), as the IMAP and SMTP test seams are, so a normal launch never reads it (`test-hooks.test.ts`).

The AI set runs at `AI_NOW`, 22 October 2026 16:00 UTC: half an hour after the demo mailbox's newest mail (`seedDemo`'s fixed now). The window reads the same instant through Playwright's `clock.setFixedTime` (as e2e does), and the app runs with `TZ=UTC`. So the digest's three days, a reply's 30-day wait, Today, "hasn't replied in 1 day" and every date on the AI screens are the same in every round, on any Mac. The digest is prepared on its own at launch against the stub; the capture waits for the Today row to say "today's digest".

### Nothing leaves loopback

`createNetworkPolicy` takes an `observe` callback that hears every decision, allowed or refused, before any socket opens; `BackendCoreOptions.onNet` passes it in. `TERNO_TEST_NET_LOG` (demo mailbox only) writes those decisions as JSON lines, bounded at 10,000. The harness clears the log after the setup launch and, after the capture, fails on any allowed request off loopback, any AI request not to the stub's port, any request the window's fence refused, and any task the stub didn't know. Sender icons and automatic updates are off in the rating profile. A capture of Lumen made 52 AI requests, all to the stub (probe, digest, summary, compose, Ask's plan and answer, the action's plan and check, needs-reply, sent mail, filter), and nothing else.

One thing on the setup launch, outside what's rated: choosing Ollama in Settings fills in its default endpoint, `127.0.0.1:11434`, for a moment before the stub's URL is typed, so the AI tab may ask that loopback address for its model list. It's on this Mac and carries no mail.

### Settings, and the relaunch

`setUpAi` drives Settings exactly as a person does, so every switch goes through `settings.update`: AI → Ollama, the stub's endpoint, its model, Test (which saves the structured-output capability), Summarize new mail, Keep track of what I promise ("Not now" to reading old sent mail), Prepare a reply, Prepare a digest each day; Appearance → sender icons off; General → automatic updates off. The design's own launch does this too, so the rated launch is the second. `checkAi` reads them back after the relaunch and throws if any didn't survive. `apps/desktop/e2e/ai-rating.smoke.ts` holds it: with `ai`, the settings survive, the AI entry points show (Today, ⌘J's row, Ask) and the network check passes; without it, the same demo shows no Today and no Summarize.

### The screens, and why each conversation

| Shot | How it's reached | Its ready state |
|---|---|---|
| `a07-today` | Today in the sidebar | `today-heading`, and the digest row saying "today's digest" |
| `a08-today-digest` | the digest row | `digest-page` with its items |
| `a01-summary` | "Recomendaciones de libros" (Arjun, three messages), Summarize in its toolbar | `summary-block[data-state=ready]` with an item |
| `a02-draft-prompt` | "departamento en la Roma", ⌘J, the instruction typed | the AI row's input holds it |
| `a03-draft-written` | Enter | `ai-strip`, and the body holds the draft |
| `a04-ask-answer` | ⇧⌘K, "What did Isabella say about the payment?" | `ask-turn[data-status=answered]` and its sources |
| `a05-actions-preview` | New question, "Archive shipping notices older than a month" | `action-preview` with Apply |
| `a06-actions-undo` | Apply | the "Archived 6 conversations" snack with Undo (then undone, so nothing later moves) |
| `a10-reply-ready` | "Blockers for sistema de diseño" (Liam, waiting on the user) | `reply-ready[data-phase=ready]` with Use |
| `a09-followup` | a new message to Arjun Ramírez asking for the flat's address, sent, then opened in Sent | `followup-line` with Nudge |
| `a11-filter-ai` | Rules, "archive receipts from uber.com", Create with AI | `ai-explanation`, before Save |
| `a12-writing-style` | Settings → AI → Writing style | "Learned from …" |

Reply ready starts only on a conversation opened by the user that waits on them, so ⌘J and the follow-up use conversations the user wrote last, and the capture fails if a Reply ready shows on either (`noReplyReady`). The follow-up comes from a new message rather than a reply, so no Reply ready can start on its thread and `r` can't pick one up; its first-time tip (plan 113) is closed before the shot, since the screen is the line. The ⌘J draft is discarded after its shots, and snacks a step leaves behind ("Draft discarded", "Undone") are closed, so no screen carries another's state. Each shot waits for animations to end and the stub to be idle; there's no fixed sleep. A state the app can't reach throws, and the capture leaves `FAILED-<mode>.png` beside the shots.

`a11` and `a12` are both in the set (revision 9). Writing style's learned state needs no model call; the "Let AI study my style" flow isn't shot.

### Demo additions: none

Every AI screen reaches its state on the demo mailbox as the everyday set already rates it. With the clock at the demo's own instant, its newsletters are inside the digest's three days, Liam's conversation waits for a reply, "Recomendaciones de libros" has enough to summarize, and the follow-up comes from mail sent in the window. So the everyday evidence can't have changed. To prove it, Lumen's everyday set was captured on the base commit (`8afc2afac`) and on this branch, and image-diffed. Every shot has the same rows and counts; the pixels that differ are the same ones that differ between two captures of this branch's own build:

| Shot | base vs branch | branch vs a second branch capture | What it is |
|---|---:|---:|---|
| `03-split-draft-open` dark | 602 px | 602 px | the text caret's blink |
| `03-split-draft-open` light | 0 | 603 px | the caret |
| `06-new-message-filled` light, dark | 603, 602 px | 602, 602 px | the caret |
| `07-search-results` light | 4,163 px | 4,161 px | Platzi's website icon: fetched before the shot in one run, the letter in the other |
| `14-archive-undo` light, dark | 8, 8 px | 6, 6 px | the undo snack's countdown ring |
| `01`, `02`, `04`, `05`, `09`, `10` light | 0 to 2 px | 1 to 2 px | antialiasing |
| the other 21 | 0 | 0 | |

### `round.json` and the gate (revision 11)

`scripts/ui-rating/sets.mjs` defines both sets: their screens, their shots and their brief. `rate.mjs --screens ai` writes `round.json` with the set, its screens, every shot the capture must write, and the hashes of the brief, the capture (capture, harness, sets), the stub and the demo's generator and seed; it refuses a capture that's missing a shot. `gate.mjs` reads the screens from `round.json` (a round from before sets is everyday), refuses a `round.json` whose screens aren't its set's, fails a report that scores a screen the round doesn't have, and fails the round if any frozen shot is missing. The frozen runtime and each rater's room get the harness, the stub and `sets.mjs`; `brief()` picks the set's brief and only that set's hands-on text.

### What the Codex review of the tooling changed

Six points, all taken, each with a regression test or a check the capture makes on itself:

1. **The undo shot waited out its own undo.** The capture waited for every finite animation, and the snack's countdown is one, so `a06` could be shot after the snack expired. It now waits for transitions only (1 s at most; motion is capped at 100 ms), checks `a06`'s snack is still there before the shot, closes each snack a step leaves once it appears (Draft discarded, Put back), and refuses a stray snack before every other shot.
2. **A round could pass without its evidence.** `gate.mjs` trusted `round.json`'s shot list, so an empty or missing list skipped the check. A round with a set must now list exactly its set's shots; only a round from before sets (no set, screens or shots) is read as everyday (`gate.test.ts`).
3. **The digest could be shot while preparing.** The row's "Preparing today's digest…" matched the wait. The capture now waits for "N newsletters · today's digest", then for exactly N items on the page.
4. **The network check accepted no log, and a cut one.** A missing log is now a failure, and the recorder's last line at its bound marks the overflow, which fails the check (`harness.test.ts`, `test-hooks.test.ts`).
5. **A request cancelled while held was answered anyway** and stayed counted as running. The stub counts and watches each chat request from its arrival (`model-stub.test.ts`).
6. **Relative days the stub didn't know** ("next week", "tonight", "this weekend") made the summary validator ask again. `anchor()` now covers every phrase the validator rejects, in English and Spanish (`model-stub.test.ts`, asked once).

A second, narrower pass on those fixes found three more, also taken: a snack on its way out keeps a hidden close button for a moment, so clearing snacks now clicks only visible ones (no 30-second stall); a summary cancelled while held no longer uses up a failure the e2e meant for the next one; and `anchor()` reads a weekday the way the validator does ("next Monday 9am" is a weekday with an hour, not a date) and takes unaccented Spanish weekdays (`model-stub.test.ts`).
