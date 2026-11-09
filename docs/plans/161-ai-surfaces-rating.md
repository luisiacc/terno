# Plan 161: rate and polish the AI surfaces

- **Status:** tooling built (stub, harness, AI capture, brief, round.json and gate); the rounds `ai-r00` onward are still to run.
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

## Rounds

### ai-r00 (main at `04d0d2515a`, 2026-11-08)

Before any AI fix: plans 159, 160 and 144's card in, the AI set on the stub. All eight reports valid; 695 cells under 9 as the gate counts them (every cell but one: macOS codex had one 9), 114 issues (17 high). The numbers as `gate.mjs` wrote them:

| Style | Rater | Overall | UI | UX | Lowest | Cells below |
|---|---|---:|---:|---:|---:|---:|
| atelier | claude | 6 | 6.5 | 5.5 | 4 | 84/84 |
| atelier | codex | 7 | 7 | 6.5 | 5 | 84/84 |
| graphite | claude | 6.5 | 6.5 | 6.5 | 4.5 | 84/84 |
| graphite | codex | 6.5 | 7.5 | 6.5 | 4.5 | 84/84 |
| lumen | claude | 6.5 | 7 | 6 | 4.5 | 84/84 |
| lumen | codex | 7 | 7 | 7 | 5 | 84/84 |
| macos | claude | 6 | 6.5 | 6 | 4 | 84/84 |
| macos | codex | 7 | 7.5 | 6.5 | 4.5 | 83/84 |

#### Screens, each rater's overall

| Screen | atelier claude | atelier codex | graphite claude | graphite codex | lumen claude | lumen codex | macos claude | macos codex |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| summary | 7 | 7.5 | 6.5 | 7.5 | 7 | 7.5 | 6.5 | 7.5 |
| ai_draft | 6 | 7 | 6 | 6.5 | 7 | 7 | 6.5 | 7 |
| ask | 7 | 6.5 | 6.5 | 7 | 7 | 7 | 6.5 | 7 |
| actions | 5 | 7 | 5.5 | 7 | 5.5 | 7 | 5 | 7 |
| today | 6 | 6.5 | 6 | 5.5 | 6.5 | 6 | 6 | 5.5 |
| followups_replies | 5.5 | 7.5 | 6 | 7 | 6 | 7.5 | 6 | 7.5 |
| ai_settings | 6 | 6 | 6.5 | 6.5 | 6 | 6 | 6 | 6.5 |

#### Facets, mean across screens

| Facet | atelier claude | atelier codex | graphite claude | graphite codex | lumen claude | lumen codex | macos claude | macos codex |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| typography | 6.71 | 7.00 | 6.57 | 7.50 | 6.79 | 7.50 | 6.64 | 7.36 |
| contrast | 7.21 | 8.36 | 6.64 | 8.00 | 7.50 | 7.71 | 7.00 | 8.43 |
| placement | 6.00 | 6.71 | 6.00 | 7.21 | 6.57 | 6.93 | 6.14 | 7.07 |
| hierarchy | 6.29 | 6.50 | 6.00 | 6.86 | 6.43 | 6.79 | 6.07 | 7.00 |
| controls | 6.00 | 7.00 | 6.07 | 6.93 | 6.29 | 7.14 | 6.14 | 6.93 |
| density | 6.71 | 6.43 | 6.79 | 7.07 | 7.00 | 7.07 | 7.07 | 7.14 |
| efficiency | 6.57 | 7.14 | 7.29 | 7.07 | 6.93 | 7.29 | 6.93 | 7.07 |
| clarity | 5.50 | 6.21 | 5.57 | 6.43 | 6.07 | 6.21 | 5.64 | 6.64 |
| feedback | 6.21 | 7.71 | 6.86 | 7.43 | 6.64 | 7.71 | 6.79 | 7.21 |
| consistency | 6.64 | 7.21 | 6.43 | 7.29 | 6.43 | 7.21 | 6.57 | 7.00 |
| accessibility | 6.07 | 6.79 | 6.29 | 6.64 | 6.36 | 7.00 | 6.50 | 7.07 |

**The themes** (all 114 issues are in `/tmp/terno-scratch/ui9/rounds/ai-r00`):
- **Actions** (7 high): the rule is shown as a raw regex, not in words; the user's request isn't echoed; while finding, the preview shows the wrong rows and count (once the whole Inbox, ticked); scope and count disagree with "Edit as a rule" and the sidebar (All Mail); the preview is squeezed into the list column beside an empty reader; focus drops to `<body>` at the preview and after Apply; the Undo toast reads as a command.
- **⌘J drafting:** status and commands in the strip look the same; one typed character removes the strip and its Undo; at 1100x700 the instruction is cut mid-word, "Written with AI" drops out and the draft runs below the window.
- **Follow-ups and Reply ready** (3 high): "hasn't replied in 1 day" on mail sent minutes ago; "Comes back Wed 9:00 AM" says nothing of what comes back; the first-run tip teaches promises on an awaiting line; Nudge, Dismiss and Later are 16 to 20 px text links, Use is 39x24; bracketed gaps the model left ("[What you think.]") aren't marked and can be sent; three AI suggestion surfaces, three control patterns.
- **Today** (2 high): opening a digest source and coming back silently re-checks excluded newsletters; the digest row is below the fold at 1440x900; nothing says why a row "needs you", or how 41 relates to "153 more waiting"; "Archive all 15" after an untick; the "Back to the digest" link stays after you leave.
- **Ask:** citations are 16 px targets that break sentences and strand punctuation; opening a source drops focus with no way back; the model id ("qwen3:8b") as provenance, worded differently on every surface.
- **Summary:** the Action row looks like it does the task but only opens the message.
- **AI settings:** Writing style is a long dump of ten expanded profiles with its status and controls at the bottom, Save falls off a small window, Reset has no undo; the AI filter's explanation echoes the request instead of describing the rule it built, accepts nonsense silently, and shows an unexplained "yes"; Esc discards an unsaved AI-built rule.
- **Contrast:** Graphite's hover and selection on AI surfaces near 1.2:1; dark AI surfaces losing their edges in macOS's settings.

No finding goes against a product or AI rule; none goes to the owner this round.

## Pass 1: Today, Writing style, the AI filter and contrast

One of three parallel passes on `ai-r00`'s findings. This one takes `today` and `ai_settings`, and the contrast findings on any AI screen that the other two passes don't own (Graphite's states on AI surfaces, and dark cards in settings). ⌘J, the summary card, follow-ups, Reply ready, plain-English actions and Ask belong to the other two.

### Today

- **Exclusions survive a source.** The digest page's unticked set and its scroll position move from the page's own state to `useToday` (`digestPick: { day, toggled, scroll }`), so opening a newsletter and coming back with "Back to the digest" (or j/k back onto the row) finds the page as it was left. A new day's digest starts afresh. Opening a newsletter reads it, so it leaves the live set as before (plan 145: "what's read elsewhere stays listed, muted"); that's the existing rule, unchanged.
- **The button says what it does.** "Archive 16" with everything ticked, "Archive selected (15)" once something is unticked; the count line says "15 of 16 selected" then, and a one-line hint under the title says what a tick means ("Ticked newsletters are archived; untick one to keep it.").
- **A visible entry near the heading.** Today's header gets a line of its own under the title, in every header kind: "41 need you · Digest · 16 newsletters · All 165 waiting". The digest part is a link button that selects the digest row (as j/k would), so it's reachable at 1440x900 and 1100x700 without scrolling, while "Needs you" stays the list's first section. The old "Show 153 more waiting" header action becomes this line's last part.
- **The counts explain themselves.** The sidebar's Today count gets plan 159's `countHelp` ("41 need you: conversations waiting for your reply, and promises that are due"). The header line repeats the 41 with "need you", and the Waiting link says "All 165 waiting", with a tooltip saying that Waiting holds every conversation in the Inbox that waits for a reply, services included, so it's larger.
- **Why a row needs you, from signals Terno has.** A waiting row's second line starts with its reason, then the summary or snippet as now. `needsYou` (plan 145's rule) admits a row for one of two reasons, which `waitingPage` now returns with each id (`hasSent`, already read; no new query): "You're in this conversation" ("Your turn") for a conversation you've written in, and "New from someone you write to" for the single new conversation from a known correspondent. Promises, nudges and reminders already lead with theirs. No model call. "Asked you a question" isn't a signal Terno has without a model, so it isn't offered.
- **The stale link.** "Back to the digest" holds the id it was opened for (`fromDigest: number | null`) and shows only on that conversation while Today is in view; leaving Today or opening another conversation clears it.
- **Repeated issues told apart.** Each digest row shows the issue's subject under the sender, with the sender wrapping to two lines instead of truncating, and the row's date on the right.
- **Reading as evident as archiving.** Each digest row is one button with a hover fill (`row-hover`) and an "Open" arrow at its end, focus-reveal on keyboard; the tick sits in its own 24 px target beside it.

### Writing style

- **A title.** On the Writing style page the settings header reads "Writing style", with a back button (chevron, named "Back to Drafting") on its line; the page no longer stacks AI, ‹ Drafting and a small grey label.
- **Status and scope first.** Under the title: the status ("Learned from 181 messages, updated today."), then one line on precedence: "AI drafts start from You; an account's style, then a company's, then a person's take over where they say something different." (from `WritingService.voiceChain`: you → account → domain → person, the more specific last).
- **One profile at a time.** Your own and your accounts' profiles are chosen in a `Select` (BoardUI's, "You · English", "Acme Studio · Spanish" with each one's message count); the chosen one shows its lines. Its phrases and notes are behind a disclosure ("Phrases you use (5)"), revealed second. Domains and People stay collapsed sections as now.
- **The editor.** Greetings and sign-offs are edited as items: each a small textarea (a sign-off keeps its line break: "Cheers," and "Luis" are one), with remove and "Add". Phrases and notes stay one per line. Save and Cancel sit in a sticky footer at the scroller's bottom, as Rules has. Edit focuses the first field; Save and Cancel return focus to that profile's Edit button and scroll it into view.
- **Reset is undoable.** `writing.profiles.reset` returns an undo token; the backend keeps the removed rows (a bounded few, in memory) and `writing.profiles.restore` puts them back exactly (both stores get `profiles.restore(rows)`). The page shows "Reset “You · English”" on the ordinary snack with Undo (and `z`). Its button's name says whose it is.

### Create a filter with AI

- **The explanation is the rule.** The AI box's line is built from the rule's fields, not the model's sentence: "Archives and marks as read mail whose domain is uber.com and that's older than 7 days." (`describeRule`, en and es through the catalog). The model's own explanation is no longer shown.
- **Nonsense, said calmly.** A local check (`ruleGaps`, no model call) compares the request with the rule: an action the request names that the rule lacks (archive, delete, spam, read, star), an age the request gives that no condition holds, a sender the request names ("from my bank", an address or domain) with no sender condition, or a rule that acts when the request named no action. Any of these shows "I couldn't turn this into a clear rule — check it below." in place of the review line, in the destructive ink's quiet tone.
- **Negation is an operator.** The "yes/not" button between the field and the operator goes. The operator `Select` holds both senses ("contains", "doesn't contain", "is", "isn't"…), as Gmail and Apple Mail do; Attachments gets "has attachments / has no attachments", Account "is / isn't". Fields that only ever turn true (Anywhere, Start of mail) keep their one operator.
- **Esc asks first.** Closing the dialog (Esc, the ×, a click outside) with an unsaved rule that AI built asks "Discard this rule?" (Discard / Keep editing), on the existing `ConfirmDialog`.
- **The preview in view.** Once a rule is built, the AI box folds to one line (its explanation and an "Edit request" link), so at 1100x700 the match count is visible without scrolling.
- **The chosen action.** Each chosen "Then" chip shows a check in place of its glyph, a cue that doesn't depend on a fill (Graphite's fills sat at 1.2:1).

### Contrast

- **Graphite's keyboard place.** The palette's, Ask's and every menu's highlighted row is `menu-highlight`. Graphite light's moves to its selection grey, `#DCDCDC` (1.37:1 on white, the tint floor). Graphite dark's goes as far as `#9E9E9E` still reads at 4.5:1 on it: that's about 1.27:1, under the 1.35 floor, written into `BOUNDARY_STEPS` as a named exception beside `GRAPHITE_FIELD`, for the same reason (the blueprint fixes that ink). A new step holds every palette's highlight at the hover floor (1.15) at least, and Graphite's at the tint floor or its exception.
- **Cards in dialogs keep their edges.** A tint card (`card-group`) sits on the popover in Settings and Rules, where the tint is 1.01 to 1.05:1 in dark. A derived token, `card-edge` (the ink from 11 % up, until 1.5:1 on the popover and the background), rings tint cards in dark dialogs; Graphite keeps its border. New `BOUNDARY_STEPS` entry: the ring on the popover, dark, 1.5.

### Tests

- Unit: `today.ts` (the pick survives the page unmounting, a new day resets it, `fromDigest` clears on leaving Today), `describeRule` and `ruleGaps` (en and es; uber.com passes, "make my inbox nicer" and the bank request are flagged), the operator's mapping to and from `negate`, the restore in both stores (conformance), `contrast.test.ts`'s new steps.
- e2e: `today.spec.ts` (untick, open, Back: still unticked and "Archive selected (15)"; the header's digest link opens the digest without scrolling; the back link is gone after the Inbox; a waiting row's reason), `ai-draft.spec.ts`'s Writing style part (one profile in view, status first, the sticky footer at 1100x700, focus back on Edit, sign-off as one item, Reset with Undo), `filters.spec.ts` (the explanation from fields, the flag, the operator select, Esc asks).
- Screenshots, light and dark, every design, 1440x900 and 1100x700, under `/tmp/terno-scratch/ai-pass1/today-settings/`.

### Out of scope here

The summary card's hover (another pass), the digest's Esc going back (the reader has no back stack; the link and j/k do it), the match preview's "2 ms" timing, and anything about the model's words.

### Pass 1 as built

Where it differs from the design above:
- **The filter's line** reads in the builder's own order, its rows then its Then: "Domain is “uber.com” → archive and file in Facturas." The first wording ("Archives and files in Facturas mail that matches: …") read badly in the screenshots.
- **The Today header** says "12 of 41 need you · Digest (16) · 165 waiting". The longer "16 newsletters · today's digest" wrapped to a second line at 1440. A digest that's preparing, failed or automated keeps the row's own words there.
- **The "new" reason** is "New from a contact" ("Nuevo de un contacto"). "New from someone you write to" left no room for the snippet in a two-line row.
- **Esc keeps the rule.** The frozen capture presses Escape on Rules and waits for the AI box to go (`capture.mjs`, which a round can't change), so a confirmation would break every later round's evidence. "Keep it" was the other choice the findings offered: closing keeps an unsaved rule AI built, in memory, and Rules opens on it again with its request until it's saved or New starts another.
- **The match preview's "2 ms"** stays: the frozen capture waits on it (`preview-ms`).
- **The digest ticks** already had a 40 by 32 px hit area (the checkbox's `after:` inset). The raters measured the 16 px box.

### What the Codex review changed

Round 1 made seven findings; all seven are fixed, each with a regression test.
1. **Clear all left a reset's copy recoverable.** Clear now drops every held reset (`writing.test.ts` "Clear all takes a reset's copy with it"; it fails without the fix).
2. **The attachment operator could reverse a rule.** A condition with `value: false` read as "has attachments", and choosing "has no attachments" kept the false and added `negate`, so it matched mail with attachments. The operator now reads both, and a choice writes `value: true` with one sense (`rule-words.test.ts`, all four combinations).
3. **Reset's Undo was out of reach.** The snack sits behind Settings' modal, and `z` doesn't run in a dialog. The Undo is now in the page, under the status ("Reset “You · English” to what your mail shows. Undo"), as Snippets does (`ai-draft.spec.ts`).
4. **The rebuild could land after an Undo.** Restore now waits for the learner (`learner.idle()`) and checks the copy is still held. The test holds the rebuild's commit until after the Undo. On the demo fixture the rebuild re-derives the same rows, so this test also passes without the fix: it holds the order, not a visible loss.
5. **Switching profiles lost an edit in progress.** The picker is disabled while a profile is being edited (`ai-draft.spec.ts`).
6. **Automated mail's picks would turn into the digest's.** A set means ticked in one and unticked in the other. The pick is now kept by day and kind (`digest-page.test.tsx`; it fails without the fix).
7. **A new day kept the old scroll.** Scroll is now restored once per digest, and saved only after it has been restored (same test).

Round 2 found nothing: the seven fixes are complete, and the capture still reaches every state.

### Results

- **Unit:** the whole `unit` project, 671 files and 11,818 tests, passed before the review fixes. After them: the touched files (rule words, Today's state, the digest page, the settings components, `contrast.test.ts`), the store conformance tests for `waitingPage`'s reason and the exact restore in both stores, and `writing.test.ts`'s reset tests.
- **e2e** (`E2E_PORT=5391`): `today.spec`, `filters.spec`, `ai-draft.spec`, `local-ai.spec` and `visual.spec` in `e2e`, plus `today.spec`, `design-axe.spec`, `designs.spec`, `controls.spec` and `menu-corners.spec` in all five designs: all pass. Three `visual.spec` baselines moved, each for a reason in this pass: `filters-ai` and `filters-ai-dark` (the folded AI box and its line), and `settings-ai-local-dark` (the cards' new edges in dark).
- **Perf:** `workloads.perf` "Today's waiting walk and the digest's walk hold" passes in both stores; the walk only returns a field it already read.
- **Typecheck and lint:** clean.
- **Screenshots:** `/tmp/terno-scratch/ai-pass1/today-settings/<design>/`, every design, light and dark. The AI set is at 1440x900, and `-small` shots of Today, the digest (unticked, a source, back), the AI filter (and a request it can't turn into a rule) and Writing style (and its editor) are at 1100x700. The frozen capture reached every AI state in all five designs, both modes.


## Pass 1: actions and Ask

What ai-r00 said about `actions` (plan 143) and `ask` (plan 141), and what this pass does about it. ⌘J, the summary card, follow-ups and Reply ready are another engineer's pass; Today, the digest, Writing style, the AI filter and AI contrast are a third's. No new model call: everything shown comes from what the plan, the preview and the turn already return.

### Actions

- **The rule in words** (`lib/rule-words.ts`). The preview no longer prints `Start of mail matches pattern "shipped|delivery|…"`. Each condition becomes a labelled row: where it looks (Inbox, or all mail but Spam and Trash), then one row per condition, labelled by its field ("Start of mail", "Sender", "Age"). A pattern that is only a list of plain words (`a|b|c`, no other regex syntax) is shown as those words, as chips: "mentions any of" `shipped` `delivery` …. A generated pattern with a template reads as the template (plan 89, unchanged). Any other pattern says "matches a pattern", and the exact text is in **Details**, a disclosure (`Collapsible`) that lists every condition as the rule builder writes it, the pattern verbatim in code type. No "·" separators: rows, not a run-on line.
- **The request echoed.** The sentence the user typed is kept with the preview (`useActionPreview.sentence`) and shown in quotes: as the rule panel's title, and under the list header's title when the panel isn't on screen.
- **No wrong rows while finding.** Entering the preview empties the list's rows at once (the skeleton shows), so the mailbox you were in is never drawn with ticks. While the search runs, the title is "Finding… N so far", where N is the number of rows on screen, and the button carries no count and is disabled. The count appears once the search is done, and then the title, the button ("Archive 6") and the undo snack all read the same number.
- **One scope.** The sidebar shows the scope the rule looks in: Inbox for an Inbox rule, All Mail for "everywhere" (the preview's `view` follows `lookIn`; any other place still ends the preview). "Edit as a rule" can't carry the scope, since a rule has no folder condition and the builder counts all mail. So the builder, opened from a preview, says so under its count: "The preview found 6 in the Inbox. This counts every conversation the rule matches, wherever it is." A scoped count in the builder needs `filters.preview` changed in both stores. That belongs to the AI-filter pass or a later plan, so it's in the report, not built here.
- **Placement: the reader holds the rule.** In Split, while nothing is open, the reader pane shows the rule panel on the reading column (`READING_COLUMN`, `PANE_TITLE_TOP`, like the selection panel): the request as its title, the rule's rows, Details and Edit as a rule, the notes (skipped, left out, the check, the consent, "+ new mail too"), and one line of keys. The list column keeps a short header: the title, Cancel and Apply, and the request under them, with a "Show the rule" link once a row is open. In List layout the list has the window's width, so the panel sits under the header, as before. Clicking a row's body opens that mail in the reader, as anywhere else.
- **Rows: the check column toggles.** The row's leading column (the check, and the avatar beside it) is the toggle, at the row's full height, as List's pick column is (plan 158). The body opens the mail. The brief asked for both "a click on the row's body toggles it" and "clicking a row shows that mail". A pointer can't do both on one target, so the body opens the mail and the column, with its 24 px or larger target, toggles. `x` and Space toggle the row the cursor is on.
- **Keys.** When the preview opens, focus moves to the list (rows, `x`, j/k), with no ring (programmatic, plan 54). ⌘↩ applies and Esc cancels, both shown as keycaps on their buttons. After Apply, or Cancel, focus returns to the list you came back to.
- **The undo reads as a result:** "Moved 6 conversations back to the Inbox", and for each verb its own ("back out of Trash", "unread again", "Unstarred…"). The snack's keycap stays `z`, which is what it shows for every undo in the app: bare `z` undoes, and so does ⌘Z. Both are tested.

### Ask

- **Citations** are inline markers: the number alone on a small field-wash pill, raised a little, in the answer's face, with no brackets. The marker is bound to the word before it, and to the punctuation after it, by a no-wrap span, so a line never starts with "." and the model's space before it is dropped. A 24 × 24 px hit area is drawn around it (`after:`), so no layout moves. The accessible name stays "Source 1: subject".
- **Opening a source** moves focus to the message it opened (the article, `tabIndex=-1`, no ring), and the reader shows a "Back to the answer" link with its ⇧⌘K keycap above the conversation. It opens Ask on the same answer. Leaving that conversation takes the link away, as Today's does.
- **One provenance phrase** (`lib/provenance.ts`). It shows "Written with AI", the same words as the ⌘J strip's `aiDraft.written`. The model and the time are in its tooltip: "Written by qwen3:8b, 8 Nov, 3:27 PM. It can make mistakes.", the wording the summary card's tooltip already uses. Ask uses it now. The summary card and the digest belong to the other passes, and the helper is there for them to switch to.
- **The search boundary.** Under the answer's buttons, on one line: "Searched mail on this Mac back to Apr 25", then "Search older mail on your servers". With nothing found it's the main action, as before.
- **The answer's buttons** (Copy, Ask again) are ghost buttons with 24 px targets in place of 16 px text links, their words on the answer's left edge.

### Tests

- Unit: `rule-words.test.ts` covers words, templates, other patterns, negation, age and the details. `ask-citations.test.ts` covers the marker's binding: punctuation, the leading space, adjacent markers, and a marker with no source. `provenance.test.ts`. `action-preview.test.ts` covers rows emptied on entry, the view following `lookIn`, focus after leaving, and the sentence kept.
- e2e `plain-actions.spec.ts`: no mailbox row is ever drawn in the preview; the title, button and snack counts agree; the sidebar is on Inbox; the rule panel is in the reader and Details holds the pattern; a click on the body opens the mail, and a click on the check column toggles; focus is on the list at the preview and after Apply; ⌘↩ and Esc; the undo's result text; `z` and ⌘Z.
- e2e `ask.spec.ts`: no line starts with punctuation at 1100 × 700; the citation's hit area is 24 px or more; opening a source focuses its message, and Back to the answer restores it; provenance reads "Written with AI" with the model in the tooltip; the boundary line.
- `design-axe.spec.ts`: the rule panel in the reader.

### What building it changed

- **The list reads as loading while a preview finds its first rows.** With none found yet, the empty list handed its focus to the sidebar's Inbox (plan 158's empty-list rule), so the keys were never the list's. While a preview is scanning with no row, the list shows its skeleton, never an empty state.
- **A source row's number is the inline marker's pill**, so a citation and its row read as one number. On the chosen row it takes full ink.
- **The keycaps are in the rule's key line** (⌘↩ Archive 6, esc Cancel), not on the header's buttons. With them, the header's title wrapped at 1100 px.

### What the Codex review changed

Nine points, all taken, each with a regression test that fails without its fix:

1. **List layout: the rule could take the rows' room.** The panel under the header is now bounded (`min(40vh, 18rem)`) and scrolls in place, and it no longer repeats the request the header already shows (`plain-actions.spec.ts`, List layout at 1100 × 700 with Details open).
2. **Entering a preview lost the mailbox's remembered place.** The rows were emptied before `setApp` let the list remember where it was. The place is now remembered first and the rows go after (`action-preview.test.ts`).
3. **The ready handoff could take focus from the user.** A Tab to Cancel while the check ran was undone when the check finished. `lib/focus-intent.ts` counts the user's keys and presses (capture phase), and the handoff yields if any came after the preview opened (`action-preview.test.ts`).
4. **A one-message source in Lumen got no focus.** Its sender card has no header button or heading. The message itself now takes focus, out of the Tab order (`ask-return.test.tsx`).
5. **Source focus waited 30 frames and ignored newer intent.** It now waits on the page changing (a `MutationObserver`, 10 s at most). It gives way to a key or a press, another conversation, or the end of the wait (`ask-return.test.tsx`: a message drawn 700 ms later, and a user move while waiting).
6. **An answer while mail downloads lost the "still downloading" line.** The scope line shows that line in place of the boundary (`ask-return.test.tsx`).
7. **Back to the answer could open an empty Ask after 30 minutes.** The link is an explicit return. It brings that conversation back however long the source was read, and reopens it if the palette had let it go (`ask-return.test.tsx`, fake clock).
8. **List layout kept the link after its page closed.** Closing List's conversation page now ends it, as opening another conversation does (`ask-return.test.tsx`).
9. **The reader's subtitle said a running count as final.** The header and the reader now share `previewTitle`, so no count shows until the search is done (`action-preview-title.test.ts`).

A second, narrower Codex pass on those fixes found one more, also taken. **The ready handoff gave up on a palette still closing.** A preview that's ready at once (a rule for new mail, with nothing here yet) could run its handoff while the palette's input still held focus. The handoff was used up, so focus stayed outside the list. It now waits for the palette to go, by watching the page change rather than a timer, and a key, a press or another list still ends the wait (`action-preview.test.ts`).

### Where pass 1 stands

- **Run:** typecheck and lint; the unit files touched (`rule-words`, `ask-citations`, `provenance`, `action-preview`, `action-preview-title`, `ask-return`, and the reader, list and compose component tests); `plain-actions.spec.ts` and `ask.spec.ts` in macOS; their `@design` flows in all five designs; `design-axe.spec.ts`'s list-and-reader sweep, now including the preview and its rule, in macOS, Lumen and Atelier; `pnpm test:ui-perf` (45 passed). `pnpm test:all` is left for the landing batch.
- **Shots:** `/tmp/terno-scratch/ai-pass1/actions-ask/<design>/`, the AI set in light and dark at both sizes, from `capture.mjs --screens ai` on this branch's desktop build. The "before" shots are ai-r00's.
- **Left for later:**
  - The builder's count opened from "Edit as a rule" is a note beside its own count, not a scoped count. A rule has no folder condition, and `filters.preview` counts everywhere in both stores.
  - At 1100 px the list header's title still wraps ("Archive 6 / conversations"), because the list column is that narrow.
  - "Ask again" isn't renamed, and the "Ask ×" chip still sits in two places. Both are in the palette's shared header, outside this pass.


## Pass 1: drafting, summary, follow-ups and Reply ready

From `ai-r00`'s `ai_draft`, `summary` and `followups_replies` (every issue and every reason below 9, in the four designs, from both raters). Actions, Ask, Today, the digest, Writing style, the AI filter and AI contrast are other passes.

### One anatomy for an AI suggestion

`ai-card.ts` grows from the card's class into its parts, and the summary, Reply ready, the follow-up line and ⌘J's strip use them:

- **Header:** the glyph, a **title in the ink** (`font-medium text-foreground`, so a card's title is no longer its quietest word), then `·` and what it's about in the muted secondary type. Sparkles where a model wrote the words (summary, Reply ready); the follow-up line, which plan 148 kept off the card because it's the user's own to act on, uses `Clock` and the same grammar.
- **Body:** the text, inset.
- **Button row:** BoardUI buttons at `size="sm"` (28 px), the main action the primary, the others the secondary (`outline`), and a way to the source message as a named ghost button with its arrow, never a bare arrow. Same gaps everywhere (`AI_ACTIONS`).

### ⌘J drafting (plan 133)

- **Status and commands.** The strip's left is a status: "Written with AI" in the secondary type, not a control, and no glyph (the row's label already says AI); the voice stays a ghost button but gets a chevron, since it opens a popover. Regenerate, Shorter and Warmer are secondary (`outline`) buttons at 28 px; **Undo** is the same with `Undo2` before it and a gap of its own, so it's found first.
- **The strip stays after an edit.** Plan 133 §10.5 ended the strip at the next keystroke; now an edit relabels it "Edited after AI" and everything stays until the draft is sent, discarded or undone. The status phrase is one helper (`aiWritten(edited)` in `ai-card.ts`), the only place that wording lives.
- **What Undo restores, exactly.** Undo always takes back the AI's last write. Unedited, it's the editor's own undo step, as before (one version back under a refinement). **Edited after AI, it restores the document exactly as it was just before that write** (before ⌘J for a first draft, before Shorter, Warmer or Regenerate for a later version), as one editor step: the edits made since go with it, and "Back to before the AI draft" offers Undo (the same as ⌘Z), which brings the edited text back exactly, with its strip, its generated subject and its gaps' guard. The document before each write is kept with the commit (`AiCommit.beforeDoc`); nothing is re-parsed. "Edited" is the document, not its words: bold or an image counts. ⌘Z that takes a write back whole is not an edit: the strip goes with it, as its own Undo would (`controller.sameDoc`). The draft stays even when the restore leaves it blank, so the edit is one Undo away (plan 133's unedited Undo still forgets a blank draft it made).
- **1100x700.** The strip wraps: the status line never truncates or hides (the pinned card's `@max-[28rem]:hidden` goes), and the commands go to a second line, still ending on the Cc/Bcc line. The instruction is a one-line field that grows to show all it holds (`field-sizing: content`, Return still drafts). When a draft goes in, the composer is brought into view whole (`keepInView`), so the draft and Send are on screen without a scroll; while the strip is up, a window that shrinks under it keeps it there, if its top is on screen. Where the row fits (1440 wide) the strip stays one line, so plan 133's "the commit moves nothing" holds; it wraps only where it must.
- **The prompt.** "What should it say? Enter drafts from the conversation." read as "enter drafts": it becomes "Describe the reply, or press Return to draft from the conversation." The notes placeholder says nothing is replaced without asking. The bare ↵ glyph becomes a named button, "Write" with its keycap.

### Placeholders

The model's `[gaps]` are already found on the text (`findPlaceholders`, no model call) and come with every draft and prepared reply as `checks.placeholders`. Only those strings are marked, never a bracket the user typed:

- **In Reply ready's card** each one is a `mark` on the search match's wash (the star's gold at 25 % under the ink, a pair added to `CONTRAST_PAIRS` over the card's surfaces).
- **In the composer,** after Use or ⌘J, a decoration plugin marks them the same way while they're in the text. The first one is selected on Use (already true; now it can be seen).
- **On Send,** if any of them is still in the text, the AI row turns into an inline confirm, like plan 133's send guard: "A gap the AI left is still in the draft: [What you think.]" with **Fill it in** (selects the first gap; the default) and **Send anyway**. No modal; Esc is Fill it in. The guard knows every version's gaps, so an undo to an earlier version is still guarded. It lasts as long as the AI session: a draft reopened after a restart has no record of which brackets were the model's, so it isn't asked about.

### Summary (plans 132, 148)

The item row reads as going to a message: its kind label sits tight to the text (no fixed column), and the row ends in "Open message" with the arrow. The row's accessible name is its visible words in order ("Action Tell Arjun what you think Open message"): a separate label failed axe's label-content-name-mismatch. Hovering it says whose message and when ("Arjun Ramírez · Yesterday, 9:41 PM"), from the thread already in the reader. The card's own state buttons (Stop, Settings, Continue, Try again) are 28 px too.

### Follow-ups (plan 142)

- **Time.** "hasn't replied in 1 day" was `Math.max(1, round(days))`. Days are now whole days passed (`floor`): under one, the line says "Arjun Ramírez hasn't replied yet". The header says when it was sent and what comes back: "Follow-up · Sent today · back on top of your Inbox Wed 9:00 AM if Arjun doesn't reply" (a promise: "back on top of your Inbox Wed 9:00 AM"; due: "Due Wed 9:00 AM").
- **Buttons.** Nudge becomes **Draft a nudge** (primary for a wait, since it's what the line offers), Done the primary for a promise, then Later with a chevron (it's a menu), then Dismiss or Not a promise, all 28 px; **Open message →** ends the row and keeps the quote's tooltip. The section's own bottom hairline goes: the message's divider under it made two.
- **The tip** (plan 113) teaches the line's kind and points at the line from below: a wait shows "Arjun hasn't replied yet" with the pointer on "Draft a nudge" ("Terno watches for replies: the conversation comes back if nobody answers. Draft a nudge writes a reminder you can edit; nothing is sent"); a promise keeps today's picture and words.

### Reply ready (plan 144)

- Header: "Reply ready · to Liam Taylor · in your voice"; it names who Use will write to (all of them, when it's more than one).
- Use becomes **Use as draft** (primary) and Dismiss the secondary, both 28 px; the hint is "Press R to reply with this draft", the keycap in the sentence.
- Placeholders as above.

### Not taken, and why

- **A Reply button on the summary's item, Copy and Regenerate on the card, a provenance footer.** New controls on the summary beyond what it does today; the lead reconciles provenance across surfaces (the Actions/Ask pass), and the card's tooltip keeps the model and date.
- **Shortcuts for Shorter and Warmer, a "Version 2 of 3" line, keeping the instruction visible after writing.** New behaviour no finding marked high, out of this pass.
- **The dark card's edge** and Graphite's hovers: AI contrast is another pass.
- **Merging Reply ready into the reply bar,** a "Preparing a reply…" line before the card: plan 144 decided the card shows only when ready, so the reader never shifts for something that may not come.

### Tests

Unit: `followupLine` (minutes, a day, five days, es), the follow-up header copy, `aiWritten`, the gaps plugin (marks only the given strings, follows edits, none when empty), the edited strip's Undo (restores the before-document exactly; the snack's Undo brings the edit back), the send guard on gaps, Reply ready's header and marks. e2e: `ai-draft.spec.ts` (an edit keeps the strip relabelled; Undo after an edit; Write button; the strip wraps at 1100x700 with its status), `replies-ready.spec.ts` (marks, Use as draft, the gap guard on Send), `followups.spec.ts` (fresh wait copy, buttons at 28 px, the awaiting tip), `summaries.spec.ts` (Open message). Design-axe for these surfaces.

### What building it changed

- **The strip's status first squeezed instead of wrapping:** with a 0 flex basis it fit beside the commands at 1100x700 by cutting itself to "Writte". It takes its own width now, so the commands wrap under it (`ai-draft.spec.ts`, 1100x700).
- **At 1440 the new strip took two lines,** which moved the body at commit and broke plan 133's "the commit moves nothing" (its e2e caught it). The status lost its glyph and the commands their extra padding, and it holds one line again.
- **⌘Z past a write left "Edited after AI" over text the AI no longer wrote** (the notes flow's e2e). The strip now ends when the document is back to what the write found.
- **The rating's small shot is taken after a resize** (`capture.mjs` shoots 1440, then shrinks the window), so a scroll at commit alone left the draft's end under the composer's foot at 1100x700. The composer is kept in view on a resize while the strip is up.
- **The follow-up's e2e asserted "hasn't replied in"** on a message sent moments before: it said "in 1 day", the bug the raters found. It now asserts "yet".
- **A test of plan 133 changed meaning:** "6: if the words aren't what it wrote, nothing is overwritten and the strip just goes" is now an edit like any other: Undo restores the document as the write found it, and the snack brings the edit back.
- **Provenance copy** ("Written with AI", "Edited after AI") is one helper, `aiWritten()` in `components/ai-card.ts`; nothing else in this pass words provenance.

### What the Codex review of pass 1 changed

Seven points, all taken, each with a regression test that fails without the fix:

1. **⌘Z after an edited Undo** brought the text back without its strip, subject or gaps' guard (only the snack's Undo did). Both now run one `reinstate()` (`ai-draft.test.ts`).
2. **Going back to an earlier version kept the newer one's checks,** so its gaps were neither marked nor guarded. Each commit keeps its checks, the guard reads every version's gaps, and the editor marks every write's gaps (`ai-draft.test.ts`, `gaps.test.ts`).
3. **A refinement stopped or discarded over an edited strip dropped the strip,** since the text no longer matched the version it wrote. The strip stays when nothing changed since the refinement began (`ai-draft.test.ts`).
4. **An old snack's Undo could put an old strip into a newer session** mid-stream. It does nothing once newer work has begun (`ai-draft.test.ts`).
5. **A resize pulled back a reader who had scrolled the composer below the window.** Only a composer whose top is on screen is followed (`ai-draft.spec.ts`).
6. **A formatting-only or image-only edit got no snack** to bring it back (the check compared words). It compares the document (`ai-draft.test.ts`).
7. **The ⌘J field is a textarea outside BoardUI's Textarea.** Like To and Subject, it's a bare field on the composer's row; that's now written down in `BOARDUI.md`'s deviations.

Also from the review: the summary card's state buttons were still 24 px; they're 28 px with the rest.

A second, narrower pass on those fixes found two more, both taken with a test each: ⌘⇧Z then ⌘Z after an edited Undo lost the strip and the gaps' guard the second time (the way back is now kept, and ⌘⇧Z puts the draft back as the Undo left it); and an old snack's Undo came alive again after a newer ⌘J was stopped with nothing written (any new run now retires it). Review rounds stop here.

### ai-r01 (main at `31052e83f`, 2026-11-08)

After pass 1 (the three areas above, landed together, full suite green). All eight reports valid; 683 cells under 9 as the gate counts them (ai-r00: 695), 112 issues (6 high; ai-r00: 114, 17 high). The numbers as `gate.mjs` wrote them:

| Style | Rater | Overall | UI | UX | Lowest | Cells below |
|---|---|---:|---:|---:|---:|---:|
| atelier | claude | 6.5 | 6.5 | 7 | 5 | 84/84 |
| atelier | codex | 7.5 | 7.5 | 8 | 6.5 | 83/84 |
| graphite | claude | 7 | 7 | 7 | 5.5 | 84/84 |
| graphite | codex | 7 | 7.5 | 7 | 5.5 | 84/84 |
| lumen | claude | 7 | 7 | 7 | 5.5 | 84/84 |
| lumen | codex | 7.5 | 7.5 | 7.5 | 5.5 | 80/84 |
| macos | claude | 6.5 | 6 | 7 | 5.5 | 84/84 |
| macos | codex | 7.5 | 7.5 | 7.5 | 5.5 | 76/84 |

#### Screens, each rater's overall

| Screen | atelier claude | atelier codex | graphite claude | graphite codex | lumen claude | lumen codex | macos claude | macos codex |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| summary | 6.5 | 7.5 | 7 | 7.5 | 7 | 7.5 | 6.5 | 7.5 |
| ai_draft | 7 | 7.5 | 7.5 | 7.5 | 7.5 | 7 | 7 | 7.5 |
| ask | 7 | 7.5 | 7 | 7 | 7 | 8 | 6.5 | 8 |
| actions | 7 | 8 | 7 | 8 | 7.5 | 8 | 7 | 8 |
| today | 5.5 | 7 | 6.5 | 6.5 | 6.5 | 6.5 | 6 | 7 |
| followups_replies | 6.5 | 7.5 | 7 | 7.5 | 7 | 8 | 7 | 8 |
| ai_settings | 6 | 7.5 | 6.5 | 6.5 | 6 | 7 | 6 | 6.5 |

#### Facets, mean across screens

| Facet | atelier claude | atelier codex | graphite claude | graphite codex | lumen claude | lumen codex | macos claude | macos codex |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| typography | 6.93 | 7.86 | 7.21 | 7.64 | 7.29 | 7.79 | 6.86 | 7.86 |
| contrast | 6.71 | 8.00 | 6.93 | 7.57 | 6.93 | 7.71 | 6.79 | 8.07 |
| placement | 6.36 | 7.50 | 7.00 | 7.36 | 6.79 | 7.79 | 6.43 | 7.64 |
| hierarchy | 6.36 | 7.36 | 6.50 | 6.86 | 7.07 | 7.43 | 6.64 | 7.57 |
| controls | 6.43 | 7.71 | 6.71 | 7.43 | 7.00 | 7.79 | 6.50 | 7.64 |
| density | 6.57 | 7.50 | 6.93 | 7.29 | 7.21 | 7.29 | 7.07 | 7.57 |
| efficiency | 7.07 | 8.07 | 7.29 | 7.93 | 7.29 | 8.07 | 7.36 | 8.43 |
| clarity | 6.50 | 7.29 | 7.29 | 6.86 | 7.00 | 7.07 | 6.64 | 7.14 |
| feedback | 6.64 | 8.29 | 6.79 | 8.00 | 7.00 | 8.36 | 6.64 | 8.71 |
| consistency | 6.07 | 7.79 | 7.14 | 7.43 | 7.00 | 7.86 | 6.50 | 7.86 |
| accessibility | 6.43 | 7.71 | 6.71 | 7.71 | 6.86 | 7.79 | 6.43 | 7.64 |

**Moved most:** actions (Claude 5 to 5.5 → 7 to 7.5; Codex 7 → 8), follow-ups and Reply ready (+0.5 to +1), ⌘J (+0.5 to +1). **Still lowest:** Today (5.5 to 7) and AI settings (6 to 7.5).

**The themes** (all 112 issues in `/tmp/terno-scratch/ui9/rounds/ai-r01`):
- **Losing work** (3 high): Esc while reading a matched conversation throws away the whole action preview; Regenerate replaces hand edits without asking; Esc in the ⌘J row discards the whole reply; Esc in Rules drops an unsaved AI rule; a prepared reply is gone after Use and a discarded draft.
- **Today** (3 high): after archiving, the digest still lists all rows under "0 newsletters"; the button said 15 and the snack 14 (the opened one quietly kept); every newsletter starts ticked and the hint "Ticked newsletters are archived" reads as done; the reason ("Your turn", "New from a contact") is the weakest text in the row; the digest is still below the fold, reached only by a 12 px "Digest (16)"; three scopes (12 of 41, Digest, 165 waiting) unexplained; 16 px checkboxes.
- **AI cards:** the summary and Reply ready cards measure 1.08 to 1.13:1 against the page; every AI surface has its own container and attribution (the summary has no "Written with AI", the filter's box has its own cream gradient).
- **⌘J:** the instruction disappears once written; a second ⌘J hides Undo; the strip takes two rows for four buttons; enabled commands look like metadata in dark; a rewrite blanks the draft while streaming; three error designs, one showing an internal address.
- **Ask:** the first answer's sources vanish after a follow-up; citation buttons measure 14 px; New question and Previous AI questions compete with the answer; "Ask again" vs "New question" vs "Ask a follow-up"; "Search older mail" has two looks; the history chip wraps over its field.
- **Actions:** the quoted request is the title and the outcome a grey subtitle; Details is a monospace regex; "Start of mail" unclear; rows are options, not checkboxes, to a screen reader; Undo's key cap says Z; disabled Archive at 1.7:1.
- **Follow-ups and Reply ready:** a bare weekday with no date, Later's choices without their times; the line repeats itself and offers "Open message" for the open message; "Draft a nudge" while a nudge is drafted; "Reply ready" over a gap still to fill; nothing shows while it's being prepared, then the card pushes the page.
- **AI settings:** the AI filter's preview shows "2 ms" and monospace dates (four styles, both raters); Writing style's copy contradicts itself (181 messages over a card saying 64; "Yours and your accounts'"), learned versus "Let AI study my style" unclear, the editor opens with focus above the view, learned phrases can't be removed; Save and apply doesn't repeat its count.

No finding goes against a product or AI rule. Two touch the owner's open questions (an opened newsletter left out of the archive; every newsletter ticked by default, plan 145).

## Pass 2: actions and Ask

From `ai-r01`'s `actions` and `ask` (every issue and every reason below 9, four designs, both raters; collected in `/tmp/terno-scratch/ai-pass2/actions-ask/findings.md`). ⌘J, the summary, follow-ups, Reply ready and the shared AI card are one engineer's pass 2; Today, the digest, Writing style and the AI filter another's. No new model call, and no change to the rating's evidence.

### Actions

- **Esc never loses the action (high).** In Split, with a matched conversation open in the reader (a click on its body, or j/k), Esc closes that conversation and brings the rule back, with the ticks, the request and the count as they were, the keys on the list. Only an Esc with nothing open cancels. List layout already closes its conversation page first; that's now tested too. The rule's help line says so: "Click a conversation to read it. Esc brings you back here."
- **The outcome is the title.** The reader's rule panel leads with what Apply does ("Archive 6 conversations", the same `previewTitle` the button and the snack count from), and the request is the quieter line under it, in quotes. In Split the list header, which is too narrow at 1100 px for the outcome beside Cancel and Archive, says only the count ("6 conversations"; "Finding… 4 so far" while finding), on one line: the verb is its button's, the outcome the reader's title. List layout, the window's width and no reader, keeps the whole outcome in its header.
- **Details is the exact pattern, in words' type.** The disclosure is named "Exact pattern" and lists only the conditions that have one: the field ("Subject and first lines"), then the pattern in the UI font, broken only after a `|`, never inside a word. Its trigger is a 24 px target.
- **"Start of mail" says what it covers:** the field (`opening`, `evaluate.ts`: the subject and the stored first lines) is "Subject and first lines" ("Asunto y primeras líneas") everywhere it's named, the rule builder included, so the preview and Edit as a rule use the same words.
- **The checks are checkboxes to assistive tech.** A preview row stays the listbox's option (j/k, x), its `aria-selected` the cursor as in any list, and says whether it's included with `aria-checked`. The check column is `role=checkbox` named "Include {subject}", for the pointer (not in the Tab order: the row and x are the keyboard's way).
- **Waiting reads as waiting.** While finding or checking, Apply is a quiet button with a spinner and its verb ("Archive"), not a faded primary; the count comes with the result. (The 1.7:1 the rater measured was the palette's scrim still fading over a disabled button whose own pair is 5.4:1; the spinner is what says "waiting".)
- **The keys line** is keycaps only (⌘↩ Archive 6, esc Cancel, X Leave out), and the help is a line of its own, short enough not to leave an orphan at 1100 px (`text-pretty`).
- **The Undo snack shows ⌘Z** (Ctrl+Z elsewhere), the platform's undo, in the shared snack, since every undo snack's key works the same way. Bare z still undoes, and `aria-keyshortcuts` names both. The snack already names what it did and, after Undo, what came back ("Moved 6 conversations back to the Inbox"). The countdown ring is the shared snack's designed drain from the top centre, not a fault, so it's left as it is (in the report).

### Ask

- **Every turn keeps its sources.** The last turn's sources stay the palette's rows (↑↓, Enter). An earlier turn shows its own under its answer, the same row anatomy (number, sender, subject, date) as buttons, so nothing a turn cited goes away when you ask more. Only the last turn has "Answer again".
- **Citations are 20 px boxes.** The marker is a 20 px tall button (its own box, so a measurement of the element finds 20 px) holding the small number pill; the line's height doesn't change. Its number is full ink on the field wash (a pair the contrast suite holds at 4.5:1). Hover or focus shows the source (sender, subject, date) in a tooltip. ↑↓ walk the source rows, and the citation of the chosen row lights up with it, so the keyboard reaches what each number points at.
- **Names say what they do.** "Ask again" is "Answer again" (it asks the same question once more and adds the new answer below). Copy and Answer again are secondary buttons with their icons, not grey text. New question and Previous AI questions are one quiet line of small text under the sources, below the answer in weight and place; "Ask a follow-up…" stays the box to continue.
- **Follow-up questions read as questions:** in the answer's size and medium weight, like the header's question, not a grey caption.
- **One "Search older mail on your servers"**: the same quiet secondary button after the scope line and after "Nothing in your mail on this Mac answers this", one label.
- **The history chip stays on one line:** a chip never wraps (`whitespace-nowrap` in the shared Chip, BoardUI's chip is one line), so its × no longer sits over the placeholder.

### Tests

- e2e `plain-actions.spec.ts`: Esc with a conversation open keeps the preview, its ticks and its request, and a second Esc cancels (Split and List layout); the outcome is the reader's title and the request its subtitle; the header holds one line at 1100 × 700 in Split; Details in the UI font, broken only at `|`; the checks are `role=checkbox` with `aria-checked`, and rows carry `aria-checked`; Apply while waiting shows a spinner; the snack's keycap is ⌘Z (or Ctrl+Z) and both keys undo.
- e2e `ask.spec.ts`: after a follow-up the first turn's sources are still there and open their mail; the citation's box is at least 20 px high and its line's height is unchanged; its tooltip names the source; ↑ to a row lights its citation; Answer again's name; New question and Previous AI questions are below the sources and smaller than them; one Search older mail look in both states; the history chip is one line.
- Unit: `rule-words.test.ts` (Details only for patterns, the field's new name), `snack` keycap.
- `design-axe.spec.ts`: the preview with the reader's rule and the Ask answer, as before.

### What building it changed

- **A citation's box is as wide as its number,** not 20 × 20: at 20 px wide the number stood apart from its word and from the "." after it ("it 1 ."). It is 20 px tall, its target 24 px, and it sits on its word.
- **Answer again's icon** is the refresh arrows, not the open circle, which read as a spinner beside the word.
- **The rule builder's field** grows to fit "Subject and first lines" (`w-auto min-w-36`), so only that row is wider and every other keeps its width.
- The waiting Apply is covered by a component test (`action-preview-title.test.ts`): the fake model finds too fast for e2e to see it.

### What the Codex review changed

Five points (`/tmp/terno-scratch/ai-pass2/actions-ask/codex-review-1.md`), all taken, each with a regression test that fails without its fix:

1. **Esc inside an HTML mail didn't reach the preview.** A mail's frame keeps its keys, and `forwardNavKey` only knew List's page. In Split it now closes the preview's open conversation first, as the window's Esc does (`plain-actions.spec.ts`, focus in the frame).
2. **A long chip could paint past its box** once a chip no longer wraps. The Chip's label is its own span that ends in "…" inside the box, before the ×; a rule's term keeps its whole text in a tooltip (`plain-actions.spec.ts`, List layout, a long term).
3. **The exact pattern could still break inside a word** (`break-words` splits a word wider than the column). It's `break-normal` now: it breaks after a "|" or at a space, and a word wider than the column scrolls rather than splits (`plain-actions.spec.ts`, narrowed to 40 px, checking each break's character).
4. **"Subject and first lines" was clipped** in the rule builder's 144 px field. See above (`filters.spec.ts`: the closed field shows the whole name).
5. **The history chip's test passed without its fix** (the chip's box is a fixed 24 px however its text wraps). It measures the label's lines and the ×'s place now (`ask.spec.ts`).

Review rounds stop here.

### Where pass 2 stands

- **Run:** typecheck and lint; the unit suites of `apps/web`, `packages/ui` and `packages/i18n` (2601 passed); `plain-actions.spec.ts`, `ask.spec.ts`, `filters.spec.ts`, `snack.spec.ts`, `selection.spec.ts`, `visual.spec.ts`, `designs.spec.ts`, `palette.spec.ts`, the attachment and controls specs in macOS; the `@design` flows of the first two and `designs.spec.ts` in Lumen, Atelier, Luma and Graphite; `design-axe.spec.ts`'s list-and-reader sweep in Lumen and Atelier; `pnpm test:ui-perf` (45 passed). The snack's keycap changed two baselines (`category-snackbar*.png`, Z → ⌘Z); nothing else moved. `pnpm test:all` is left for the landing batch.
- **Shots:** `/tmp/terno-scratch/ai-pass2/actions-ask/after/<design>/`, the AI set in all five designs, light and dark, both sizes, from `capture.mjs --screens ai` on this branch's desktop build. `capture.mjs` needed no change: its waits (`action-finding`, `action-apply` enabled, `ask-source`, `ask-new`) all still exist. The "before" shots are ai-r01's.
- **For the owner, not built:**
  - The countdown ring on the shared snack drains from the top centre, so a moment after it appears it shows a small notch that two raters read as a fault. It's the design (plan 158), not a bug, so it stays. A visible track for the drained part would read as a countdown, if wanted.
  - Raters asked for "Archived 6 shipping notices" (the request's own noun) in the snack. That needs the model's words for the noun, which this pass doesn't add (no new model call); the snack says the count and the verb as the title does.
  - "Reopen preview" after a cancel, or after Undo, would need the plan again: a new model call, so not built.


## Pass 2: drafting, summary, follow-ups, Reply ready and the AI card

From `ai-r01`'s `ai_draft`, `summary` and `followups_replies` (every issue and every reason below 9, four designs, both raters), and the lead's list. Actions and Ask are one parallel pass; Today, the digest, Writing style and the AI filter another. No new model call anywhere: everything shown comes from what a run, a summary, a follow-up row or a prepared reply already returns.

### Losing work

- **Replacing an edited draft asks first.** Regenerate, Shorter, Warmer, a free-form ⌘J refinement and a rewritten instruction all replace the text. Over a strip that says "Edited after AI", the strip itself turns into the question: "Replace your edits?" with **Replace** (the default, so Return answers it) and **Keep editing** (Esc). No modal. Replace runs what was asked, and the strip's Undo still restores the edited text exactly (pass 1's `beforeDoc`). An unedited strip runs at once, as now. State: `AiSession.confirm: { run: RunSpec } | null`.
- **Esc in the ⌘J row closes only the row.** The row opened with an empty reply (⌘J on a conversation) used to take the reply with it on Esc ("Draft discarded"). Now Esc closes the row and leaves the empty reply open with the caret in it; a second Esc is the composer's own, as without AI. ⌘J pressed again in an empty field still closes both, since it opened both.
- **Use, then discard, gives the card back.** Discarding a draft made from a prepared reply (its Discard, or anything that removes it unsent) gives the row back through the existing `ai.replyAct restore`, so Reply ready shows again, exactly as Undo after Use does. A sent draft gives nothing back. The card never shows beside a draft open on the same conversation (the discard snack's Undo brings the draft back, and the card steps aside).

### ⌘J

- **One row.** The strip is status on the left and commands on the right:
  - the status is one ghost button, "Written with AI ▾" ("Edited after AI ▾" after an edit). It opens what was the voice popover, which now leads with the voice ("In your voice with Arjun"), then what was read, the model, and the instruction. The separate "In your voice with Arjun ▾" trigger goes; its words are the popover's first line.
  - beside it, the instruction, quiet and truncated in quotes: “friday works for me, ask him…”. It is a button ("Edit instruction: …"): it opens the row's field holding that instruction, and Return writes a fresh draft from it (a regenerate with the new words, through the edited-text question above). When the row is too narrow for it (a container query on the row, about 34 rem), it hides and the popover's "Edit instruction" is the way.
  - the commands: Regenerate, Shorter, Warmer as BoardUI's secondary button, then Undo, a gap apart.
  The row wraps only when even that can't fit; at 1440x900 and 1100x700 it is one line in every design (asserted in `ai-draft.spec.ts`).
- **Commands look enabled.** The row's line is `text-muted-foreground`, and the secondary button has no text colour of its own, so its label inherited the status's grey. The commands take the ink (`text-foreground`, 4.5:1 and more on `card` in every palette, the secondary's own pair).
- **A second ⌘J keeps Undo.** ⌘J over the strip opens "What should change?" as before, and the strip's Undo stays at the row's end while the field is open.
- **Rewrites keep the text.** While a refinement or regenerate streams, the old text stays where it is, dimmed (the editor at 55 % through `data-ai-overlay="rewriting"`), under a "Rewriting…" status with Stop; the new text replaces it in one step when it's done. The stream isn't drawn over it.
- **One AI error.** `ai-card.ts` gains the error pattern every AI surface uses: `aiErrorCopy(error, ai)` and `AI_ERROR*` classes, and an `AiErrorNotice` component (in `ai-error.tsx`, re-exported from `ai-card.ts`). It is a `role="alert"` block: `CircleAlert` in the destructive ink, a title in the ink ("Couldn't reach Ollama"), one line of help in the muted ink ("Open Ollama, then try again."), and **Try again** (secondary) and **AI settings** (ghost). The words come from the error's kind, never from the provider's message when that carries a host, a URL or a port (`errors.ai.notRunning`, `cannotConnect*`, `notFound`): a title per kind (`ai.error.*`), with the provider's name and no address. A message with no address (the app's own, "This conversation keeps changing…") is shown as it is. The summary's error and ⌘J's use it. **For the Ask engineer:** `import { AiErrorNotice, aiErrorCopy } from "./ai-card"`; pass the error (`{ message, kind, i18n }`) and `onRetry`.

### The AI card and provenance

- **A visible edge.** `AI_CARD` stays the export, and becomes the card ringed in `draft-edge` (`[--card-ring:var(--draft-edge)]` on `card-group`), in every design: plan 160's hairline floor against the page and against the card's own fill. New `BOUNDARY_STEPS`: the ring on the reader's background and on Lumen's card, and the ring against a tint card's fill, both at `HAIRLINE_FLOOR`, light and dark, every palette.
- **The summary says who wrote it.** Under the items, the row Ask has: **Copy** (a quiet button; "Copied" or the failure as a snack) and, at the row's end, "Written with AI" with the model and date in its tooltip (`provenanceLabel`, `provenanceDetail`). The toggle no longer carries the tooltip.
- **No Refresh.** A ready summary asked again returns the same one: the backend reuses it when the text, the model and the language are the same (`reusable()`), so a Refresh would need a new behaviour (a forced run). Not built; it comes back on its own when the conversation changes (stale → Summarize).
- **"Open message" says where.** An item, and the follow-up line, point at a message. On a conversation of one message, that message is the one on screen, so nothing is offered (the item is plain text). Otherwise it says whose and when, "Arjun · 21 Oct →" (the visible words are the name, so axe's label-content-name-mismatch holds).
- **For the AI filter's engineer:** the exports are unchanged: `AI_CARD` (now with its edge), `AI_HEADER`, `AI_GLYPH`, `AI_TITLE`, `AI_ACTIONS`, `AI_GAP`, `gapPieces`, `aiWritten`, plus `AiErrorNotice` and `aiErrorCopy`. Put the box on `AI_CARD` with an `AI_HEADER` row and `AI_ACTIONS`; say provenance with `provenanceLabel()`/`provenanceDetail()`.

### Follow-ups

- **Said once, with a date.** Header: "Follow-up · Back on top of your Inbox Wed, Oct 28, 9:00 AM" (due: "Due Today 9:00 AM"). The line under it stays "Arjun Ramírez hasn't replied yet", or "… in 5 days". The header no longer adds "if Arjun doesn't reply" or "Sent today": the condition is said once. Any day after tomorrow carries its date (`reminderDated`: "Today 5:00 PM", "Tomorrow 9:00 AM", "Wed, Oct 28, 9:00 AM").
- **Later shows its times.** Each choice in Later's menu carries the moment it resolves to at its end, muted and tabular, as Remind me's menu already does (`presetWhen`: "Tomorrow … 9:00 AM", "This weekend … Sat 9:00 AM").
- **A nudge already drafted.** Once Draft a nudge has made a draft on that conversation and it's still there, the primary reads **Open your nudge**: it brings that draft into view with the caret in it. Discarded or sent, it's Draft a nudge again.
- **Open message** follows the summary's rule above: gone on a one-message conversation (the sent mail on screen), "You · 22 Oct →" otherwise.

### Reply ready

- **Gaps counted.** "Reply ready · 1 gap to fill · To Liam Taylor · In your voice with Liam": the count of the model's gaps still in the text, in the ink, so the state is said before Use.
- **Preparing holds its place.** The card shows as soon as the backend starts writing (the `writing` event after `needs_reply` says yes, so never for something that won't come): "Writing a reply…" with Stop, and three skeleton lines until words arrive. While it writes and once ready, the text is clamped at six lines, so the card never grows more than that. It enters with a fade within `--motion` (none when motion is reduced).
- **One R.** The card keeps its "Press R to reply with this draft" (a caption), and the reply bar's own R keycap hides while a reply is ready: R uses the prepared draft then, so the bar's keycap said the wrong thing. (A keycap on Use as draft was tried: the key's muted caption on the primary's fill fails AA.)

### Not taken, and why

- **Reply on the summary's item, claim-level citations in the summary, a timeline.** New behaviour on the summary beyond Copy and provenance; the item's source now says whose message and when.
- **Shortcuts for Shorter and Warmer, renaming the AI label "Instruction".** Not in the lead's list; the field's placeholder says what it does.
- **A card for the follow-up line, or merging Reply ready into the reply bar.** Plan 148 keeps the follow-up off the card (it's the user's own to act on); the reply bar is the composer's.
- **A custom date in Later.** Remind me (plan 87) has it; the follow-up's menu keeps its presets, now with their times.

### Tests

- Unit: `aiErrorCopy` (no host, URL or port in any kind's words, en and es; a message without an address passes through), `reminderDated`, `followupWhen`/`followupLine`, the strip's confirm (a run over an edited strip waits for Replace; Keep runs nothing; unedited runs at once), Esc's close keeping the draft, the prepared reply given back on discard and not on send, the Reply ready header's gap count, the skeleton while writing, `contrast.test.ts`'s new steps.
- e2e: `ai-draft.spec.ts` (Regenerate over an edit asks, Keep leaves the text, Replace replaces and Undo brings the edit back; Esc in the row leaves the reply open; the instruction shows and its edit rewrites; a second ⌘J keeps Undo; the strip is one line at 1440x900 and 1100x700; the old text stays during Shorter; the error shows no host), `replies-ready.spec.ts` (Use, Discard: the card is back; the gap count; one R), `followups.spec.ts` (the dated header, Later's times, Open your nudge, no Open message on one message), `summaries.spec.ts` (provenance and Copy; the item names its source; the error pattern), `design-axe.spec.ts` for these surfaces.

### Pass 2 as built

Where it differs from the design above:
- **The strip at 1100x700.** Measured, the strip has 381 px there and the status plus the four commands need about 420. Below 30 rem of strip, Undo is its glyph (its name and a tooltip, "Undo the AI's last change", stay) and the commands' padding tightens; the instruction hides below 34 rem and is in the status's popover. One line at both sizes in all five designs (`ai-draft.spec.ts`, `@design`). In Spanish, whose words are longer, it may still wrap at 1100.
- **The follow-up's line** keeps "Arjun Ramírez hasn't replied yet"; the repetition was the header's "if Arjun doesn't reply", which goes, with "Sent today".
- **One R**: the card keeps its sentence, and the reply bar's keycap steps aside (see Reply ready above).
- **Each version keeps what it was asked.** Undo of a rewrite brought the newer instruction back with the older text, so Regenerate asked the wrong thing. A version now carries its instruction and notes, and going back to it brings them (`ai-draft.test.ts`).
- **Plan 133's Esc tests changed meaning.** "Esc closes and the empty reply goes" is now: Esc closes the row, the empty reply stays with the caret, and the composer's own Esc closes it.
- **Not an e2e:** "no Open message on a one-message conversation". The harness's one-message fixture never gets a follow-up row; the rule is `messageSource`'s unit test, and `a09` (a one-message sent conversation) shows it.

### What the Codex review of pass 2 changed

Eight points, all taken, each with a regression test that fails without the fix:

1. **Try again over an edit.** A rewrite failed, the user typed, and Try again replaced the text without asking. Retry of a rewrite goes through the same question (`ai-draft.test.ts`).
2. **A stale reply given back.** Discarding a draft made from a prepared reply, after a new message came, showed the old reply. The card is shown again only while it answers the conversation's newest message (any message since, the user's own too, makes it out of date, as while it's shown) (`replies-ready.spec.ts`).
3. **Discard, Undo, then Send** left the reply offered. A draft on that conversation that goes any way but Discard (sent, scheduled) takes the shown reply off screen (`replies-ready.spec.ts`).
4. **Open your nudge opened another draft** when the conversation showed a different one. It opens the nudge's own draft by its key (`openStoredDraft`, `followup-nudge.test.ts`).
5. **The wrong provider named.** With a task override (writing on Claude, Settings' first row Ollama) the error said "Couldn't reach Ollama". The error names the task's own provider: ⌘J's `writingTarget`, the summary's `summaryTarget` (`ai-error.test.ts`).
6. **No credit read as a bad key.** `errors.ai.noCredit` (and the daily and monthly limits, and a draft too large) are the app's own words with no address, shown as they are (`ai-error.test.ts`).
7. **Addresses still reachable.** A blocked redirect's bare host was shown, and the row's live region announced the raw message. `blocked` is said by its kind, a domain on a common TLD counts as an address, and the live region says the shown title (`ai-error.test.ts`, `ai-draft.test.ts`).
8. **The one-line check ran in one design.** It's its own `@design` test now.

A second, narrower Codex pass on those fixes found one more, taken with a test: **Try again after a rewrite that failed part-way** still replaced an edit, since that strip waits in the run (what came is offered with Insert), not on the session. Try again reads either, sets the partial text aside, and asks (`ai-draft.test.ts`, a delta before the failure). Review rounds stop here.

### Where pass 2 stands

- **Run:** typecheck and lint, clean. Unit: the touched files and the cross-cutting ones (`ai-draft`, `ai-error`, `reply-ready`, `followups-copy`, `followup-nudge`, `replies`, `provenance`, the composer's, `packages/i18n`, `packages/ui` with `contrast.test.ts`): 54 files, 572 tests. e2e in macOS: `ai-draft`, `summaries`, `followups`, `replies-ready`, `design-axe`: 43 passed (3 skipped: the frames that run only when looking). Their `@design` and `@variant` flows in Lumen, Atelier, Graphite and Luma, `design-axe` included: 28 passed. `visual`, `designs` and `controls` in all five designs: 46 passed, no baseline moved. `pnpm test:ui-perf`: 45 passed. `pnpm test:all` is left for the landing batch.
- **Each losing-work fix's e2e fails without it**, checked by reverting the fix: Regenerate over an edit (`ai-draft.spec`), Esc in the ⌘J row (`ai-draft.spec`, three scenarios), Use then Discard (`replies-ready.spec`); and the two Reply ready review fixes (`replies-ready.spec`).
- **The frozen capture** reaches every AI state in all five designs, light and dark, unchanged: nothing it waits on moved (`followup-nudge`, `reply-ready[data-phase=ready]`, `reply-ready-use`, `ai-strip`, `summary-item`). No change to `scripts/ui-rating/`.
- **Shots:** `/tmp/terno-scratch/ai-pass2/draft-followups/after/<design>/` (final build), at 1440x900 and the `-small` 1100x700 copies; before is ai-r01's `/tmp/terno-scratch/ui9/rounds/ai-r01/<design>/shots/`.
- **Left as it was:** at 1100x700 some designs' composer foot wraps "Save and close" under the toolbar (the composer's, outside this pass).


## Pass 2: Today, Writing style and the AI filter

One of three parallel passes on `ai-r01`'s findings. This one takes `today` and `ai_settings`. ⌘J, the summary, follow-ups, Reply ready and the shared AI card (`ai-card.ts`) belong to one other pass; actions and Ask to the third. Plan 145's two rules stand: the digest archives only unread mail, and every newsletter starts ticked. Both are the owner's open questions; this pass makes the state honest around them and doesn't change them.

### Today

- **The digest first, as a row.** The digest's row moves from the bottom of the list to the top, before "Needs you", at a compact height of its own (44 px, the row's own height if that's smaller), its "Newsletters" heading gone (the row says what it is: the newspaper glyph, "16 newsletters · today's digest", and an arrow). It keeps everything a row has: a pointer target the row's full width, `row-hover`, j/k, the cursor. Needs you's conversations stay the first conversations, and opening Today still opens on the first of them, never on the digest (`openedOn` skips the digest's row). Section headings are placed from each row's real offset, so a shorter row keeps them on their rows.
- **The header says what each number is.** The digest link leaves the header (the row is the way in). The line reads "41 need you · newest 12 below · All 165 waiting in Inbox" when the list is capped, "9 need you" when it isn't. The 41 is the sidebar's count (the same `counts.today`); "All 165 waiting in Inbox" goes to plan 17's Waiting and keeps its tooltip saying it holds services too. The needs-you count leads in the ink; the rest stays secondary.
- **The reason is a label.** A waiting row's reason ("Your turn", "New from a contact") leaves the snippet's text and becomes a label of its own at the start of the second line: medium weight, the foreground ink at the row's secondary size, so it reads apart from the mail's words at AA in every palette (no new colour). The snippet follows it. Promises, nudges and reminders keep their own lines. `ThreadSummary` carries it as `why` on Today's rows (a client-side field, set by `flattenToday`).
- **Each digest row says its state.** A row is one of: to archive (ticked), kept (unticked: "Stays in Inbox"), opened ("Opened · stays in Inbox": read, so plan 145's rule leaves it out; its box unticked and disabled), or archived (out of the Inbox: "Archived", muted). The page learns which from the backend: `DigestRow` gains `readIds`, those in the Inbox and read (`store.today.digestRead`, both stores, one indexed read of ≤ 40 ids). The count line says it in plain words, "15 to archive · 1 stays in Inbox", and the button repeats the first number: "Archive 15". So the button's count is always what goes: what was opened isn't counted, and says why on its row. The backend's `today.digestArchive` also checks unread at the moment it acts, so a newsletter read between render and click is left alone and said so ("1 was read since and stays") rather than archived against plan 145's rule.
- **The hint says what will happen.** "Archive moves the ticked newsletters out of your Inbox. Untick any you want to keep." (future tense, tied to the button), in place of "Ticked newsletters are archived".
- **After Archive, what's left.** The page holds what it archived (`DigestPick.archived`, by day, so a remount keeps it). Rows it archived leave the list; the header becomes the finished state: "Archived 14 newsletters." with an Undo in the page (the snack's Undo runs the same one, and either clears the state), and, if anything stayed, a line "Still in your Inbox" over those rows. With nothing left: "All done for today." under it. The digest's row reads "14 archived" as before. Rows archived elsewhere before the click stay listed, muted and labelled "Archived", so the page still doesn't reshuffle while it's read (plan 145).
- **A 24 px box.** The checkbox gets a 24 px hit area of its own, the element itself (a `size-6` wrapper label that is the control's target, with the 16 px box drawn inside), not a pseudo-element. The open button sits 8 px away.
- **Esc goes back to the digest.** In a conversation opened from the digest, Esc returns to the digest (as "Back to the digest" does) before anything else Esc does. The link shows its key (`Esc`) as Ask's "Back to the answer" shows ⇧⌘K, in the same ghost style. The page comes back at its scroll and the row it was opened from takes focus (programmatic: no ring).
- **Time order.** The page lists newest first by the message's date, in the backend (`digestRow` sorts its ≤ 40 items), not by the order the model's batches came back. The "duplicate" Substack issue is two different conversations: the demo generator picked the same subject twice for one sender, on different days with different bodies. Both stay, now apart in time order; nothing is collapsed, since two real mails with one subject can differ.

### Create a filter with AI

- **No timing, the UI font.** The preview's "2 ms" goes; its dates are in the UI font with tabular figures. The frozen capture waited on `preview-ms`; it now waits on `filter-preview[data-ready]`, which is set exactly when the timing used to show (a count in, nothing loading). That is the one line changed in `capture.mjs`; which screens and states it shoots is unchanged.
- **Esc keeps the rule visibly.** Pass 1 kept an unsaved AI rule in memory; the rater couldn't see it. It now shows as a draft row at the top of Rules' list ("Uber receipts", "Not saved · Made with AI", in the ink), selected when Rules opens on it, there while another rule is open, and with its own Discard (a close button) to drop it. Saving it turns it into the ordinary row. New starts a new rule beside it rather than throwing it away. Esc and the × still close at once, so the capture's Escape reaches its next state.
- **Edit request focuses the request.** The field takes focus with the caret at its end.
- **Save and apply says how much.** "Save and apply to 66 conversations" once the preview has counted (plural in en and es); "Save and apply to existing mail" before that, or with no matches.
- **The AI box is the shared AI card.** `AI_CARD`, `AI_HEADER`, `AI_TITLE` and `AI_GLYPH` from `ai-card.ts`, and the one attribution (`provenanceLabel`, "Written with AI") in place of the footer's "Created with AI" badge; the cream gradient and gold text go. The rule's line is the foreground ink.

### Writing style

- **One count story.** The status reads "Learned on this Mac from 181 sent messages, updated today." and each profile "From 64 of them" ("De 64 de ellos"), so the numbers nest instead of contradicting. The picker heading the own group is "Your style" ("Tu estilo"), and when the picker shows the profile's name the card doesn't repeat it.
- **Precedence in plain words.** "Each draft uses the closest style it has: a person's, then their company's, then the account's, then yours." The "Domains" section becomes "Companies", the word the sentence uses.
- **Two learnings told apart.** One group, "How it learns": "Habits from your sent mail" ("Counted on this Mac, nothing is sent. Count again starts from your mail as it is now; what you edited stays.", button "Count again", the old Rebuild), then "Notes on your tone, by AI" ("Optional. Sends samples of your sent mail to {provider}, which notes how formal, warm and direct you write. Drafts work without it.", button "Study my style…"), then Clear all.
- **The editor in view.** Opening Edit focuses the first field and scrolls the editor's top into view (`block: "nearest"` after layout), so the focused field is on screen.
- **Phrases can be removed.** Each phrase and note in the open list has a remove button (`CloseButton`, "Remove “…”"), which saves through `writing.profiles.edit`, the same call the editor uses (the store supports it; the profile shows as Edited, as any edit does). The list shows five and "Show all 17".
- **Compact Companies and People.** Each profile there is one line (name, language, "From N"), and opening one closes the one before, so the page holds at most one full profile from these sections at a time.

### Not taken

- **Select all / none on the digest** and **j/k on its rows**: not in the findings this pass was given as must-fix; the count line and the 24 px boxes cover the precision complaint.
- **Starting with nothing ticked**, and **keeping opened newsletters in the archive**: plan 145's rules, the owner's open questions.
- **A snack when Rules closes with a kept draft**: it would sit behind Settings in the capture's next step and risk the frozen capture's `noSnacks`; the draft row is the visible keep.

### Tests

- Unit: `flattenToday` puts the digest first and the reason on `why`; `openedOn` skips the digest; the digest page's states (to archive, kept, opened, archived), its counts and button, the finished state and its Undo, the pick's `archived` surviving a remount; the store's `digestRead` (conformance, both stores); `today.archive` leaves a read one alone; digest items in time order; Esc's way back; the Rules draft row; Writing style's phrase remove and its counts copy.
- e2e: `today.spec.ts`: archive with one unticked and one opened, then the page shows only those two with their labels and the finished line, and Undo brings the rest back (fails without the fix: all 16 stay listed); the button's count equals the snack's; the digest row first and Today opening on a conversation; Esc from an opened newsletter back to the digest. `filters.spec.ts`: Esc with an unsaved AI rule, then Rules shows the draft row and opens on it (fails without the fix: no draft row); Edit request focuses the request; the count on Save and apply; no timing shown. `ai-draft.spec.ts`'s Writing style part: the copy, a phrase removed, the editor in view, one Companies profile open at a time.
- `design-axe.spec.ts` for Today, the digest, Rules and Writing style; screenshots in every design, light and dark, 1440x900 and 1100x700, under `/tmp/terno-scratch/ai-pass2/today-settings/`.

### Pass 2 as built

Where it differs from the design above:
- **The header line** reads "41 need you · the newest 12 here · All 165 waiting in Inbox"; "41 need you" is in the ink, medium weight, and is the sidebar's number.
- **The reason label** is the row's own ink at medium weight, then a quiet " · " and the words; `row-why` in tests. It's a client-side map in `useToday` (`reasons`), read once per row, rather than a field on `ThreadSummary`.
- **The digest's open buttons** have no `aria-label` now: their content (sender, subject, state, date, line) names them. axe's `label-content-name-mismatch` (WCAG 2.5.3) caught the label leaving the state and date out.
- **Rules' three unnamed selects** (field, all/any, category) are named; the new axe line found them.
- **The checkbox target** is a `target` variant of the shared `Checkbox` (`BOARDUI.md` records the deviation): the 24 px control is the element a pointer hits and a screen reader names, its 16 px box drawn inside, with a hover fill the target's size.
- **The phrase removers** show on hover or Tab (`focus-reveal:`), not as a column of marks; a company's or person's profile names its account, since one company can have a profile per account.
- **The "duplicate" Substack issue** is two conversations: the demo's generator gave one sender the same subject twice (2:40 PM and 12:49 PM, different bodies). Both stay. In time order they're now adjacent, which may still read as a repeat; collapsing same-subject rows would hide a real second mail, so it's left for the owner.
- **The capture.** `capture.mjs`'s one changed line: `visible("preview-ms")` became `page.locator("[data-testid=filter-preview][data-ready]").first().waitFor({ timeout: 30_000 })`. `data-ready` is set when the preview has a count and nothing is loading, which is exactly when `preview-ms` rendered. The frozen capture reached every AI state in all five designs, light and dark.

### What the Codex review of pass 2 changed

Round 1 (`git diff fcc148651..HEAD`) made nine findings; all nine are fixed, each with a regression test.
1. **Generating a second AI rule after New replaced the first unsaved one.** Each unsaved rule is its own row (`kept` holds a list and the one the builder showed); Rules reopens on that one (`filters.spec`).
2. **Opening another company or person unmounted an editor in progress.** While a profile is edited the other rows, and their section's toggle, wait (`ai-draft.spec`).
3. **Two quick phrase removals sent arrays from the same profile,** so the second put the first back. Removals run one after another from what the last left (`ai-draft.spec`).
4. **The picker remounted a profile from the page's stale list.** A removal refreshes the lists (`ai-draft.spec`; it fails without the fix).
5. **Undoing a second Archive cleared the first's finished state.** The page holds an entry per Archive; an Undo takes out only its own (`digest-page.test`).
6. **The page recorded what it asked to archive, not what was archived.** `today.digestArchive` returns `archivedIds`; only those leave the page, and one archived elsewhere meanwhile stays listed as Archived (`digest-page.test`, backend `today.test`).
7. **Esc from inside a newsletter's HTML body** (its own document) went past the digest: `forwardNavKey` goes back to it too (`today.test`).
8. **The page's Undo swallowed failures.** It uses `undoNow`, which says so with a retry (`digest-page.test`).
9. **Companies and People could each hold an open profile.** One across both (`ai-draft.spec`).

Round 2 (the fix commit) found four gaps in those fixes; all four are fixed, each with a test that fails without it.
10. **Asking again from Edit request cleared the rule before the answer,** so a failure, or Rules closing meanwhile, lost it. The rule stays until the new one is in (`filters-dialog.test`, new: jsdom with the backend's answers held).
11. **A Save answered after another unsaved rule was opened** cleared that one's key and loaded the saved rule over it. Save finishes against the rule it started with and leaves the builder alone if it moved on (`filters-dialog.test`).
12. **Edit opened during a phrase's removal** started from the old phrases and could save the removed one back. Edit and switching wait for removals (`writing-style.test`, new).
13. **An earlier day's Undo wrote its day's pick over the page now shown.** Archive and Undo touch the pick only on their own day (`digest-page.test`).

Review rounds stop here.

### Pass 2 results

- **Unit:** `digest-page.test` (8), `today.test` (state, 9), `filters-dialog.test` (2), `writing-style.test` (1), the web neighbours of what moved (rows, list, keyboard, selection, reader: 18 files, 122 tests), backend `today.test` (23), the store conformance for `digestLive`/`digestRead` in both stores.
- **e2e** (`E2E_PORT=7341`): `today.spec`, `filters.spec`, `ai-draft.spec`'s Writing style test and `visual.spec` in `e2e`; `today.spec` in all five designs; `design-axe.spec` (with its new line for Today, the digest before and after Archive, a rule AI built, and Writing style with a company open) in `e2e`, Lumen and Atelier; `controls.spec`. All pass. Two `visual.spec` baselines moved, both looked at: `filters-ai` and `filters-ai-dark` (the shared AI card, no timing, the unsaved row, Save and apply's count).
- **Perf:** `workloads.perf` "Today's waiting walk and the digest's walk hold" in both stores, now with the page's two state reads: p95 0.07 ms (SQLite) and 0.02 ms (IndexedDB) at 50k. The first SQLite invocation failed before running a test while five captures were loading the machine; two reruns passed.
- **Typecheck and lint:** clean.
- **Screenshots:** `/tmp/terno-scratch/ai-pass2/today-settings/<design>/`, every design, light and dark: the frozen AI set (`a01`–`a12`, with `-small` for the five it shoots small), and pass 2's states at 1440x900 and 1100x700 (`b07` Today, `b08` the digest, `b08b` a newsletter opened from it, `b08c` kept and opened rows, `b08d`/`b08e` after Archive, `b11` the AI rule, `b11b` its unsaved row after Esc and New, `b11c` Edit request, `b12` Writing style, `b12b` phrases, `b12c` a company open, `b12d` the editor at 1100x700). The frozen capture reached every AI state in all five designs, both modes, and again on the final build (`final/`).

### For the owner

- **Plan 145's two rules stand:** every newsletter starts ticked, and an opened newsletter is read, so it stays (now said on its row: "Opened · stays in Inbox"). Both raters' "start with nothing ticked" and "keep opened ones in the batch" are still the owner's call.
- **Same-subject issues** in the digest are separate conversations and both stay; collapsing them would hide a real second mail.
- **Today's list is capped at 12** (plan 145), so the header says "41 need you · the newest 12 here". Showing all of them would be a change to plan 145.

### ai-r02 (main at `008d91a5a`, 2026-11-08)

After pass 2 (the three areas, landed together; full suite green once its flaky first-pass failures were run again alone). All eight reports valid; 670 cells under 9 as the gate counts them (ai-r01: 683, ai-r00: 695), 104 issues (7 high; ai-r01: 112 and 6, ai-r00: 114 and 17). The numbers as `gate.mjs` wrote them:

| Style | Rater | Overall | UI | UX | Lowest | Cells below |
|---|---|---:|---:|---:|---:|---:|
| atelier | claude | 7 | 7 | 7.5 | 3.5 | 84/84 |
| atelier | codex | 7 | 7 | 7.5 | 4.5 | 81/84 |
| graphite | claude | 7 | 7 | 7 | 4.5 | 84/84 |
| graphite | codex | 7.5 | 7.5 | 8 | 6 | 78/84 |
| lumen | claude | 7 | 6.5 | 7.5 | 4 | 84/84 |
| lumen | codex | 7.5 | 7.5 | 8 | 6.5 | 75/84 |
| macos | claude | 7 | 7 | 7.5 | 4.5 | 84/84 |
| macos | codex | 7.5 | 7.5 | 8 | 6.5 | 76/84 |

#### Screens, each rater's overall

| Screen | atelier claude | atelier codex | graphite claude | graphite codex | lumen claude | lumen codex | macos claude | macos codex |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| summary | 7 | 7.5 | 7 | 7.5 | 7 | 7.5 | 7.5 | 7.5 |
| ai_draft | 7 | 7 | 7.5 | 7.5 | 7.5 | 7.5 | 7.5 | 7.5 |
| ask | 7.5 | 7.5 | 7 | 8 | 7.5 | 8 | 8 | 7.5 |
| actions | 7.5 | 8.5 | 7.5 | 8.5 | 8 | 8.5 | 6.5 | 8.5 |
| today | 6.5 | 6.5 | 6.5 | 7 | 6.5 | 7 | 7 | 7 |
| followups_replies | 6 | 6.5 | 6.5 | 8 | 6 | 8 | 6.5 | 8 |
| ai_settings | 7 | 7.5 | 6.5 | 7.5 | 7 | 7.5 | 7 | 7.5 |

#### Facets, mean across screens

| Facet | atelier claude | atelier codex | graphite claude | graphite codex | lumen claude | lumen codex | macos claude | macos codex |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| typography | 7.43 | 7.43 | 7.21 | 7.64 | 7.36 | 7.86 | 7.29 | 8.00 |
| contrast | 7.21 | 8.07 | 7.86 | 8.50 | 6.93 | 8.50 | 7.93 | 8.21 |
| placement | 6.71 | 7.14 | 7.14 | 7.79 | 7.14 | 7.64 | 6.93 | 7.86 |
| hierarchy | 6.79 | 7.36 | 6.57 | 7.29 | 6.93 | 7.50 | 6.86 | 7.71 |
| controls | 6.21 | 6.86 | 6.36 | 7.93 | 6.71 | 7.79 | 6.43 | 7.64 |
| density | 7.00 | 6.79 | 6.86 | 7.57 | 7.57 | 7.29 | 7.50 | 7.57 |
| efficiency | 7.79 | 7.14 | 7.43 | 8.29 | 7.93 | 8.29 | 7.50 | 8.00 |
| clarity | 7.21 | 7.14 | 7.29 | 7.57 | 7.57 | 7.71 | 7.07 | 7.50 |
| feedback | 6.93 | 8.57 | 7.86 | 8.64 | 7.36 | 8.93 | 7.86 | 8.79 |
| consistency | 6.93 | 7.57 | 6.64 | 7.57 | 7.14 | 8.00 | 6.93 | 7.79 |
| accessibility | 6.36 | 7.43 | 6.71 | 7.57 | 6.50 | 7.43 | 6.86 | 7.43 |

**Overall:** 7 to 7.5 from every rater in every style (ai-r00: 6 to 7). Actions reach 8.5 from Codex in all four styles. **The lowest cells (3.5 to 4.5) are one regression pass 2 made:** the follow-up's Later menu, given its times, stayed 128 px wide and clips its labels ("Lat…", "To…", "T") in every style (five of the seven high issues).

**The themes** (all 104 issues in `/tmp/terno-scratch/ui9/rounds/ai-r02`):
- **Regressions and lost work:** the Later menu (above); Esc while ⌘J is writing throws away the instruction and the partial draft without a word.
- **Actions:** a bulk "Move 838 to Trash" wears the same primary as "Archive 6"; Apply sits in the list header, far from the rule it applies, with the rule pane half empty; a sentence typed in ⌘K runs Search, with "Ask AI" second.
- **⌘J:** the instruction is cut to about 20 characters and gone at 1100, where Undo becomes an unlabelled icon while Regenerate, Shorter and Warmer keep their words.
- **Ask:** citations still about 15x20 px; a click on one closes Ask; the ↑↓ legend promises what the follow-up field doesn't do; the × in the Ask chip returns to Commands; the panel is mostly chrome for a two-line answer.
- **Summary and one AI language:** the Action row opens the source, not a reply, and doesn't say so; "Copy" and "Written with AI" look different on every surface; one sparkle means three things.
- **Today:** "41 need you · the newest 12 here · All 165 waiting in Inbox" beside Inbox 100 reads as three contradicting counts; the reasons are now bold and louder than the subject; the digest row is too quiet in Lumen; the digest's AI attribution is at the bottom.
- **Follow-ups and Reply ready:** the line leads with the date, not the fact, and looks unlike Reply ready; "In your voice" vs "Written from the conversation alone" unexplained.
- **AI settings:** Esc in a sub-edit closes the whole dialog; the precedence sentence reads as adopting the recipient's voice; the generated rule leaves focus on the dialog; the compact form crowds out its matches.

No finding goes against a product or AI rule. One may touch the palette's default (a sentence in ⌘K): if a fix changes what Enter does for non-AI input, it goes to the owner.

## Pass 3: Today, Writing style and the AI filter

One of three parallel passes on `ai-r02`'s findings. This one takes `today` and `ai_settings`. ⌘J, the summary, follow-ups, Reply ready and the shared AI language (one `AiProvenance`, one Copy button in `ai-card.ts`) belong to one other pass; actions and Ask to the third. Plan 145's rules stand: only unread newsletters are archived, every one starts ticked, and Needs you shows the newest 12.

### Today

- **One sentence for the counts.** Seven raters in all four styles read "41 need you · the newest 12 here · All 165 waiting in Inbox" against the sidebar's Inbox 100 and the Inbox's "100 unread · 165 to reply to". The line now says what the list is, and one way to the rest, with no second total: "The newest 12 of 41 that need you · More in To reply to" when the list is capped, "9 need you" when it isn't. The 41 is the sidebar's Today count, in the ink at medium weight; the link uses the Inbox filter's own name ("To reply to", `list.filter.waiting`), not a count, so nothing on the line can be read against Inbox's 100. Its tooltip says why it holds more: it lists every Inbox conversation waiting for a reply, services' too. A real "Show all 41" isn't possible without lifting plan 145's 12-row cap; that goes to the owner.
- **The reason, quiet.** "Your turn" and "New from a contact" go from the foreground ink to the row's secondary ink (`quiet`, the snippet's, AA on every row fill), keeping the medium weight and the " · " after it: a label apart from the mail's words by weight, and under the subject (the ink) in strength. No new colour.
- **The digest row has a resting shape.** In Lumen it read as a section label until selected. At rest it is ringed inside its row shape in `card-edge` (the AI card's edge, a whole pixel), so it reads as a row you can open in every design; hover and selection fill it as before. A new `BOUNDARY_STEPS` entry holds the ring on the list (`pane`) at the hairline floor.
- **Quieter ticks.** The digest's 24 px targets stay; the box inside is outlined at rest in both states, its tick drawn in the ink on the card, not a solid primary square (a `quiet` look of the shared `Checkbox`'s `target`, recorded in `BOARDUI.md`). The unticked box's edge is the hover edge, so it doesn't vanish beside a ticked one.
- **Provenance in the header.** The digest's "Written by qwen3:8b. It can make mistakes." leaves the list's foot: the header's date line says "Written with AI" (the one label, `provenanceLabel`) with the sparkle, and the model and caution are its tooltip. When `AiProvenance` lands in `ai-card.ts` (the other pass), this span is the one place in the digest to swap for it: `digest-page.tsx`, the `digest-provenance` trigger in the header.
- **The open arrow at rest.** Each digest row's arrow shows at rest, in the secondary ink, so opening one is visible (three raters), and its right edge is the Archive button's (the dates no longer stop 24 to 45 px short of it).

### Create a filter with AI

- **Esc steps back one level.** In Rules, Esc in a sub-edit goes up one level before anything closes: with the request open again over a built rule (Edit request), Esc folds the box back to the rule, focus on Edit request; with the caret in one of the rule's text fields (its name, a value, Forward to, the request), Esc leaves the field for the rule's row in the list (New, for a rule not in the list yet). Esc anywhere else (the list, a heading, a button) closes, keeping an unsaved AI rule as before. A field's own Esc (a suggestion list) goes first.
- **Focus after the AI fills a rule.** The folded box's line ("Domain is “uber.com” → archive.") is a heading, and takes focus when the rule arrives (programmatic: no ring), so a screen reader hears what was built and Tab goes on into the rule. It isn't a field, so the capture's one Esc after `a11` still closes Rules.
- **The matches in view at 1100x700.** The folded box's review hint ("Review and adjust it below before saving.") runs on after the rule on its line instead of a line of its own; the form's section gaps go from 20 to 16 px; the Name label sits beside its field; and the dialog may take 92 % of the window's height (it was 88 %). At 1100x700 that leaves the match count and at least three matches above the footer.

### Writing style

- **Esc steps back one level.** In the style editor, Esc is Cancel when nothing changed (focus back on that profile's Edit); with a change it asks "Discard your changes?" (Discard / Keep editing, the page's `ConfirmDialog`), so Esc never loses typing. On the Writing style page, Esc goes back to Drafting (as the back button does) with focus on "Writing style…"; Esc there closes Settings. The capture's last Esc (after `a12`) now goes back to Drafting instead of closing; nothing is shot after it, so no capture change.
- **Precedence as your writing.** "Drafts follow your style with that person, else with their company, else in that account, else your usual one." (es: "Los borradores siguen tu estilo con esa persona; si no, con su empresa; si no, en esa cuenta; si no, el habitual."): whose style it is, yours, is the sentence's subject.
- **Tighter, with How it learns in the first view.** How it learns moves up, under Your style; Companies and People, the optional overrides, follow it as two compact rows. The overview's and the groups' gaps tighten. At 1440x900 the whole How it learns group, Clear all included, is in view without scrolling.

### Not taken, and why

- **Show all 41 in Today:** plan 145 caps Needs you at 12. The owner's call.
- **Select all / none on the digest** (Codex, four styles, low): not in this pass's must-fix list; the count line says what goes.
- **Quoting the request in the filter's folded box**, **bordered Edit / Reset**, **renaming Count again**, **people by name**: low findings outside this pass's list.
- **One Undo after the digest's Archive** (the page's and the snack's): the snack is the app's one Undo surface; the page's is what a keyboard user reaches without the snack (pass 2). Left for the shared AI language pass.

### Tests

- Unit: `TodayLine` capped and not (no second total, the link's name), the reason's ink, the digest page's provenance in the header (and none at the foot), the quiet checkbox's look, `contrast.test.ts`'s new step.
- e2e: `filters.spec.ts`: Edit request then Esc folds and Rules stays open; Esc in the name field moves focus to the list and Rules stays; Esc again closes; focus on the rule's line after the AI fills it; the match count and three matches in view at 1100x700. `ai-draft.spec.ts`'s Writing style part: Esc in the unchanged editor cancels with focus on Edit and Settings open; Esc with a change asks, Keep editing keeps the text; Esc on the page goes back to Drafting, a second closes Settings; How it learns in view at 1440x900. `today.spec.ts`: the header line. Each Esc test fails without the fix.
- `design-axe.spec.ts` for Today, the digest, Rules and Writing style; screenshots in every design, light and dark, 1440x900 and 1100x700, under `/tmp/terno-scratch/ai-pass3/today-settings/`.

### Pass 3 as built

Where it differs from the design above:
- **Rules' Esc** needed `preventBaseUIHandler()`: Base UI's dismissal is merged into the popup's own `onKeyDown` after ours, so stopping propagation alone still closed it. The rule's row is marked `data-current` (the popup itself carries `data-open`, which a `[data-open] button` selector matched first). The built rule's heading names only the rule; the review hint sits beside it, outside the heading.
- **The digest's provenance** is a focusable span with a tooltip, `provenanceLabel()` and the sparkle (`AI_GLYPH`), on the date's line: `digest-page.tsx`, `data-testid="digest-provenance"`. That's where `AiProvenance` goes when it lands in `ai-card.ts`.
- **The capture.** `capture.mjs` is unchanged. After `a11`, focus is on the built rule's heading, which isn't a field, so its one Esc still closes Rules; after `a12`, its one Esc now goes back to Drafting, and nothing is shot after it.

### What the Codex review of pass 3 changed

Round 1 (`git diff 668fc97ab..2bae63c19`) made two findings; both are fixed, each with a test that fails without it.
1. **A changed style editor was dropped by Esc from elsewhere on the page, or by the back button.** Esc anywhere on Writing style steps out of an open editor first (asking when it changed), and the back button asks before a change goes (`ai-draft.spec`).
2. **An input method's Esc stepped back.** Safari sends `compositionend` before the Esc that dismissed its candidates, so `isComposing` is false on it. The new handlers use `imeKey` (`lib/ime-escape.ts`), which holds a composition until 5 ms after it ends, as Base UI's own dismissal does (`filters-dialog.test`).

Round 2 (the fix commit) found one gap, fixed with a test that fails without it.
3. **Two editors open at once** (Your style and a company): closing one cleared the single registration, so the other, changed, could still be dropped. The page keeps a list; Esc steps out of the last opened, and leaving asks each changed one in turn (`ai-draft.spec`).

Review rounds stop here.

### Pass 3 results

- **Unit:** `filters-dialog.test` (7, four new: focus on the built rule, Esc folds the request, Esc from a field to the list then closes, Esc in a new rule to New, and the IME Esc), `digest-page.test` (9, one new: provenance in the header, quiet ticks), `today-line.test` (new, 2), the settings components, Today's state, the rows and list, `packages/ui`'s themes (with the new step) and components, i18n: 36 files, 333 tests.
- **e2e** (`E2E_PORT=7300`): `today.spec`, `design-axe.spec`, `filters.spec`, `visual.spec`, `ai-draft.spec`, `controls.spec`, `menu-corners.spec` and `local-ai.spec`, in every project that runs them: 78 passed, 3 skipped (the specs' own skips). The Esc tests for Rules and Writing style fail without the fix (checked with the handlers off). Two `visual.spec` baselines moved, both looked at: `filters-ai` and `filters-ai-dark` (the compact form).
- **Perf:** not run. No query changed.
- **Typecheck and lint:** clean.
- **Screenshots:** `/tmp/terno-scratch/ai-pass3/today-settings/v3/<design>/`, every design, light and dark: the frozen AI set (`a01` to `a12`) and pass 3's states at 1440x900 and 1100x700 (`c07` Today, `c08` the digest, `c08b` one unticked with the provenance tooltip, `c11` the AI rule, `c11b` Edit request, `c12` Writing style, `c12b` the editor, `c12c` asking before a discard, `c12d` back on Drafting). At 1100x700 Rules shows the match count and four matches above the footer in every design. The frozen capture reached every AI state in all five designs, both modes, and again on the final build (`final/`, Lumen light and Graphite dark).

### For the owner

- **Show all 41 in Today.** Seven raters asked for a way to see every conversation that needs you. Needs you holds the newest 12 (plan 145), and no list holds exactly the 41: the header's link goes to the Inbox's To reply to, which holds them and services' mail too. A real "Show all 41" means lifting the 12-row cap, on demand or always. That's your call.
- **Plan 145's other rules stand:** only unread newsletters are archived, and every one starts ticked. Codex asked for Select all / Select none on the digest in all four styles; it's a small addition if you want it.


## Pass 3: actions and Ask

From `ai-r02`'s `actions` and `ask` (every issue and every reason below 9, four designs, both raters). ⌘J, the summary, follow-ups, Reply ready and the shared AI language are one engineer's pass 3; Today, Writing style and the AI filter another's. No new model call, and no change to the rating's evidence.

### Actions

- **What 838 was.** The macOS rater's "Delete all newsletters from Netflix" became the stub's frozen plan: `listId matches "."` over all mail but Spam and Trash, with no sender (the stub reads a sender only from a domain, `model-stub.mjs` `actionPlan`), and its check drops nothing for a list rule. The app ran that rule exactly: every mailing-list conversation, 838. The matching is sound for the rule it was given; the rule is the stand-in model's. So nothing changes in the matching, and no model call is added. What the app can do is say the rule plainly, so a rule that doesn't match the request shows it:
  - a pattern that matches anything (`.`, `.*`, `.+`, `^`, empty) reads as what it means, not "matches a pattern": the List row says "Any mailing list" ("Not from a mailing list" negated), any other field "Anything". Exact pattern no longer lists it: the row says it all (`rule-words.ts`).
- **Destructive actions look destructive.** Trash and Spam (the two of the set that take mail out of view and that a later look can't easily find again) apply with BoardUI's destructive button (`variant="destructive"`), in the reader's rule and in the header alike. Every other verb keeps the primary. ⌘↵ and Esc stay.
- **Large or destructive batches say what they'll do.** Under the request, one plain line, for Trash and Spam at any count and for any verb at 100 or more: "838 conversations go to Trash, from all your mail except Spam and Trash." / "… go to Spam, from the Inbox." / "This archives 120 conversations, from the Inbox." (`action.consequence.*`, `where` from the preview's `lookIn`). Destructive lines are in the destructive ink. A second confirmation above a count, asked for by one rater, isn't added: Undo is exact (plan 143), and a type-to-confirm would be a second key path for the same Apply.
- **Apply sits with the rule.** In Split, while the rule is in the reader, its last block is the decision: Apply (the outcome's verb and count, destructive when it is) and Cancel, then the keys line (⌘↩, esc, x) and the help. The list header holds only the count. When the rule isn't on screen (a matched row open, or a reply), the header shows Cancel and Apply again, so Apply is always on screen exactly once. List layout, where the rule is under the header in the same column, keeps them in the header. The waiting spinner and Stop while applying go with the buttons wherever they are.
- **Edit as a rule** moves onto Exact pattern's line as a quiet link (`link-secondary`), so the only button pair near the rule is the decision.
- **⌘K and a sentence.** The palette's root ranks the search row first whenever what's typed isn't a command's name (plan 158), and "Ask AI: …" last. A sentence that is plainly an instruction now ranks Ask AI first, labelled for what it does: "Do with AI: “Archive shipping notices older than a month”". Plainly an instruction (`lib/imperative.ts`): it starts with a verb of the action set (archive, delete, trash, move … to, mark … as, file … to/under/in; Spanish archiva, borra, elimina, mueve … a, marca … como), has at least four words, and holds no search operator (`:`) or quotes. "archive", "delete account", "mark twain letters", "from:ana archive", "invoice March" keep the search first, exactly as now; a command's name still wins. Enter on an ordinary search does what it did. Only where AI can run (plan 147's gate, the row's own condition).

### Ask

- **Citations are 24 × 24 boxes.** The marker's own box (the button, measured by `getBoundingClientRect`) is 24 px wide and high, its number pill drawn inside, a `-my-1` block margin and negative inline margins taking back what it would add, so the line's height and the gap to its word and the "." after it don't change.
- **A citation shows its evidence in the panel.** A click on a citation, Enter (or a click) on a source row, and an earlier turn's source open a preview of that message inside Ask, in place of the answer: "‹ Back to the answer", the number, sender, date and subject, the passage, and the message's text below it. The passage is the first sentence that holds a word the turn's own searches looked for (`turn.queries`, `matchExcerpt`, the search's excerpt), marked; when none holds one, there is no passage and the text starts the preview. The text is the message's own, read from this Mac (`threads.get`, no model call, nothing marked read). "Open message" (↵) opens it in the reader as before, with Back to the answer. Esc, or the back control, returns to the answer with the follow-up box focused. A source in Spam or Trash asks for the second press first, as opening one does.
- **The legend says what the keys do here.** In Ask, the palette's generic legend is replaced by Ask's own: in the follow-up box with no row chosen, "↵ Ask · ↓ Sources · esc All commands" (↓ only with sources); with a source chosen, "↑↓ Sources · ↵ Show · esc All commands"; in a preview, "↵ Open message · esc Back to the answer". Arrows already move from the follow-up box into the sources (cmdk's active row), so the legend now names that.
- **Back and close.** The Ask chip's × goes. The header ends in a quiet "‹ All commands" button (its visible words are its name) and BoardUI's Close Button, which closes the palette. The empty Ask page and Previous AI questions have the same pair in place of the chip.
- **The dialog is named Ask.** In Ask the palette dialog's title is "Ask your mail", its description "Ask a question about your mail. Answers cite the messages they come from."; Previous AI questions is "Previous AI questions".
- **Chrome.** Under a two-line answer, three bands where there were six: the answer's line (Copy, Answer again, and Written with AI at its end, as now), the scope as one quiet line with "Search older mail on your servers" a link in it (the not-found state keeps its button, the main action there), then Sources. New question and Previous AI questions leave the list for the legend's line, at its end, as quiet buttons. Sources keep their rows and their place right after the answer.
- **The other engineer's `AiProvenance` and Copy** (`components/ai-card.ts`) haven't landed. When they do, Ask's `ask-copy` button and its `ask-provenance` tooltip in `Turn` (`ask-page.tsx`, the `ask-turn-actions` line) are what they replace, one for one; the line's layout stays.

### Not taken, and why

- A second confirmation for large trash (above): Undo is exact.
- A warning when the matches lack a sender the request named: it needs the sentence read, which is the model's job (no new call). "Any mailing list" makes the gap visible instead.
- Raters' other points outside the brief (a per-sender breakdown, a denser candidate row, the snack's noun, Stop as a button, dates in one format in AI text) are left for a later pass or the other engineers' areas.

### Tests

- Unit: `imperative.test.ts` (instructions and searches, both languages); `rule-words.test.ts` (a pattern for anything); `action-preview-title.test.ts` (the consequence line: destructive, large, neither); `ask-citations.test.ts` stays; `ask-peek.test.ts` (the passage from the turn's queries, none without a hit).
- e2e `plain-actions.spec.ts`: Apply and Cancel are in the reader's rule and not in the header while the rule shows, and back in the header when a row is open; List layout keeps them in the header; a trash preview's Apply is the destructive button with its consequence line, **in every design** (`@design`), and an archive's is the primary with none.
- e2e `ask.spec.ts`: the citation's box is at least 24 × 24 and the answer's lines keep their height, **in every design** (`@design`); a citation click and Enter on a source show the preview in the panel with the dialog still open and the answer back on Esc and on "Back to the answer"; Open message opens the reader; the legend in each state; "All commands" goes back and Close closes; the dialog is named "Ask your mail"; New question and Previous AI questions in the legend's line.
- e2e `palette.spec.ts` / `ask.spec.ts`: an instruction ranks "Do with AI" first and Enter opens Ask with it; a search, a single verb and a command's name keep their order.
- `design-axe.spec.ts`: the Ask preview, and the trash preview.

### What building it changed

- **A citation's 24 px box needs a layer for the pointer.** The button is 24 × 24 with `-my-1` and negative inline margins, but Chromium hit-tests an inline box only inside its line, so the corners that reach past the line weren't the citation's. An `after:` layer over the same box, with the button `relative z-[1]`, takes them. The size is the element's own (`getBoundingClientRect`), not the layer's.
- **The line-height check compares the answer with itself.** Counting line boxes missed an answer's blank line; the test now sets the answer beside a copy with its markers as plain text, the same width, and the two heights must agree within 1 px (it fails by 2 px without `-my-1`).
- **Ask's back and close are at the end of the field** on the empty Ask page and Previous AI questions (`CommandInput` gets an `end` slot), where the conversation's header has them; the page chip was at the start.
- **The keys' line in the rule stays** under Apply and Cancel ("⌘↩ Archive 6 · esc Cancel · x Leave out or put back"): it's the keyboard's legend, as the raters asked for in pass 2.
- **Esc in Ask goes back to all commands** (as before); ⌘K's test steps back once rather than reopening.

### What the Codex review changed

Round 1 (`git diff 668fc97ab..ba6d45a1e`, `/tmp/terno-scratch/ai-pass3/actions-ask/codex-review-1.md`): nine points, all taken, each with a regression test that fails without its fix.

1. **A shown source threw away a follow-up being typed.** The preview replaced the conversation, unmounting the follow-up box. The conversation now stays mounted under the preview (`inert`, collapsed, out of the accessibility tree), and focus goes back to the box on return (`ask.spec`: typed text survives).
2. **A source still loading could appear in the next conversation.** `showSource` checks the conversation it began in, and a change of conversation closes a shown source (`ask-peek.test`).
3. **Open message skipped the Spam/Trash check.** It asks the backend again; the second press it was let through with counts only while the message hasn't moved (`ask-peek.test`: moved to Trash since, it arms first).
4. **A long rule scrolled Apply, Cancel and Stop out of reach.** The decision is `sticky` at the reader pane's foot (`plain-actions.spec`, 1100 × 320 with Exact pattern open; it fails without `sticky`).
5. **Back from a source jumped to the newest turn.** Kept mounted, the answer keeps its scroll (`ask.spec`).
6. **Back from a row's source, "↵ Show" was a false promise.** The arrow state lives with the box, which now survives (`ask.spec`: Enter shows it again).
7. **A rule that will trash new mail saved with the primary.** It's the destructive button too (`action-preview-title.test`).
8. **".*" and "^" still read "matches a pattern".** A pattern any value matches, an empty one too, reads "Anything, even empty" ("Any mail, on a list or not" for List: a message with no List-Id is an empty value), negated "Nothing"; a negated "." is "Empty" (`rule-words.test`).
9. **A single-quoted search ranked AI first.** Quotes in single marks keep the search first (`imperative.test`).

Round 2 (`git show 1438f0226`, `codex-review-2.md`): five points on those fixes, all taken, each with a test.

10. **A late Open message could take the reader from the next conversation**, and **a late lookup armed a source in another one.** `sourceThread` and `openSource` take a "still current" check and change nothing, record nothing and open nothing once it fails (`ask-peek.test`).
11. **The second press was asked for invisibly** (its line was in the hidden conversation). The preview says it, as a status: "In Trash. Press again to open" (`ask.spec`: a source trashed elsewhere while shown).
12. **The preview's keys moved the hidden rows** (Ctrl+N/P/J/K, the arrows from its buttons). The whole preview keeps cmdk's navigation keys and Enter from the list under it (`ask.spec`: the chosen row is the same after Esc).
13. **"archive 'weekly report', from bob" still ranked AI first.** Any single quote opening a word keeps the search first; an apostrophe inside a word ("O'Brien's") doesn't (`imperative.test`).

Review rounds stop here.

### Pass 3 results

- **Run:** typecheck and lint, clean. Unit: `apps/web`, `packages/ui` and `packages/i18n` (2649 passed, 1 skipped; one unhandled `scrollIntoView` error in jsdom from `settings/writing-style.test.tsx`, another pass's file, untouched here), then the touched files again after the reviews. e2e (`E2E_PORT=7141`): `ask.spec`, `plain-actions.spec`, `design-axe.spec` and `palette.spec` in macOS, Lumen, Atelier, Graphite and Luma (52 passed); `snippets.spec` and `dev-mode.spec` in macOS. `pnpm test:ui-perf`: 44 passed and one failure on the loaded first pass ("a 250 KB paragraph with a mark on every other word…", a `TypeError` in the composer test's own evaluate while Codex ran beside it), which passed run alone.
- **Shots:** `/tmp/terno-scratch/ai-pass3/actions-ask/after/<design>/`, the frozen AI set in all five designs, light and dark, both sizes, from `capture.mjs --screens ai` on this branch's desktop build (at `1438f0226`; round 2 changes nothing those states show). `capture.mjs` needed no change: its waits (`ask-source`, `ask-new`, `action-preview`, `action-apply` enabled, `action-finding`) all still exist, `ask-new` now a button on the keys' line. States the frozen set doesn't hold: `extra/ask/<project>-peek-{light,dark}.png` (a source shown in Ask) and `extra/actions/<project>-trash-{light,dark}.png` (a Trash preview), every design. The "before" shots are ai-r02's (`/tmp/terno-scratch/ui9/rounds/ai-r02/<design>/shots/`).

### For the owner

- **The 838.** The plan's matching is sound: the rule the stand-in model wrote ("any mailing list", no sender) matched every list conversation, as written. The stub only reads a sender from a domain. A real model given "from Netflix" should add a sender condition; whether to check a rule against the sender a request names, without a model, is the owner's call (it would read the sentence, as `ruleMisses` does for the AI filter).
- **A second confirmation above a count** (one rater) isn't built: Undo is exact, and the destructive button and its line now say what happens.
- **⌘K's default for ordinary input is unchanged.** Only a sentence that is plainly an instruction (a mail verb first, four words or more, no operator or quotes) ranks "Do with AI" first. No change to the default for non-AI input was needed.
- **The AiProvenance and Copy adoption** waits for the other engineer's `ai-card.ts`: Ask's `ask-copy` and `ask-provenance` in `Turn`'s `ask-turn-actions` line are the two to swap, one for one.



## Pass 3: drafting, summary, follow-ups and one AI language

From `ai-r02`'s `ai_draft`, `summary` and `followups_replies` (every issue and every reason below 9, four designs, both raters) and the lead's list. Actions and Ask are one parallel pass; Today, the digest, Writing style and the AI filter another. No new model call: everything shown comes from what a run, a summary, a follow-up row or a prepared reply already returns.

### The regression: Later's menu

- **Why it clipped.** `DropdownMenuContent` is `w-(--anchor-width) min-w-32`: the trigger's width, at least 128 px. Pass 2 put a time at each row's end and left the label `truncate` in `flex-1`, so the label gave way to the time ("Lat…", "To…", "T", nothing for Next week).
- **Fix.** The menu sizes to what it holds (`w-max`, still at least the trigger), and each row is BoardUI's label-and-shortcut row: the label `whitespace-nowrap`, the time in `DropdownMenuShortcut`'s place (`ms-auto ps-3`, muted, tabular). Nothing in it can shrink.
- **Its name.** Later offers Later today and Tomorrow, which can be earlier than the date the line shows, so it is **Reschedule ▾** (two raters).
- **The other menus and popovers of passes 1 and 2:** ⌘J's status popover (fixed `w-80`, its lines wrap) and the new Rewrite menu (below) are held by the same test.
- **Test (`followups.spec.ts`, `@design`):** in every design, light and dark, at 1440x900 and 1100x700, Reschedule's menu and every menu or popover of these surfaces is opened and no text in it is clipped: each item's text element has `scrollWidth <= clientWidth`, and the panel is inside the window.

### Esc while ⌘J is writing

Esc (and the row's Stop) used to end the run and `remove()` the session: the instruction and the words that had come were gone, without a word. Now Stop keeps what's there:
- **Words came:** they go into the draft as a write of their own (below the user's notes if there were any, as Insert does after a failure), and the strip says **Stopped part-way ▾**. Its Undo takes them back exactly; Regenerate writes the whole draft again from the same instruction; the instruction is on the strip (below). The live region says "Stopped. What it wrote so far is in the draft."
- **Nothing came yet:** the row goes back to its field, holding the instruction, so Return asks again. A second Esc closes the row, as before.
- **A rewrite** (Shorter, Warmer, Regenerate) already keeps the old text in place while it streams; Stop leaves it and its strip, as now.
- **Undo of a stopped write** gives the field back with its instruction, rather than closing the row (the instruction is the user's work too).
- State: `AiStrip.stopped`; the write's `used` is unknown (the backend never finished), so its popover says the model and that it stopped, not a voice.

### ⌘J's strip

- **The instruction has its own line.** Under the commands, the instruction in the user's words, whole (it wraps), in the ink at the text's size, with **Edit** after it (a quiet button; its name "Edit instruction"). While it writes, the same line is under "Writing…", so the instruction stays where it was typed from Enter to the draft, and the commit still moves nothing: two lines become two lines. With no instruction (a draft from the conversation alone), the strip is one line, as now.
- **Recovery leads, rewrites are quieter.** The command line reads **↶ Undo** (BoardUI's secondary, with its glyph and its word at every width), then Regenerate, Shorter and Warmer as ghost buttons in the ink (enabled-looking, hover-filled, lighter than Undo), and at the line's end the status, the one provenance control: **Written with AI ▾** (or Edited after AI ▾, Stopped part-way ▾).
- **Narrow.** Where the three rewrites don't fit beside Undo and the status (a container query on the strip, below about 30 rem), they fold into one ghost **Rewrite ▾** menu (Regenerate, Shorter, Warmer). Undo keeps its word; nothing drops.
- **The status popover** (the provenance popover, below) leads with the voice and what was read, then the model; its "Edit instruction" link goes, since the instruction is on the strip.

### One AI language: `AiProvenance` and `AiCopyButton`

`components/ai-provenance.tsx`, re-exported from `ai-card.ts`:
- **`AiProvenance`**: a real button, ghost, `text-xs`, muted until hovered, with a chevron: **Written with AI ▾** (`provenanceLabel()`), or a surface's own words from the same set (Edited after AI, Stopped part-way, Found with AI). It opens a popover (`w-72`, BoardUI's popover) whose lines say what the AI used, if the surface knows, then `provenanceDetail(model, at)`: "Written by qwen3:8b, Nov 8, 2026, 9:41 AM. It can make mistakes." Props: `model`, `at`, `lines?: string[]`, `label?`, `children?` (more content, like ⌘J's Writing style link), `testId`. It replaces the focusable `<span>` with a tooltip, which raters found took focus and did nothing.
- **Where it goes:** at the **end of the surface's button row**, on every AI surface (the summary, Reply ready, the follow-up line, ⌘J's strip, Ask's turn). The header says what the card is; the row ends in who wrote it.
- **`AiCopyButton`**: BoardUI's secondary button at `size="sm"` (28 px) with `Copy` before "Copy". On success its label is **Copied** with `Check` for 1.5 s, in place (and announced through its own status region); a failure is a snack with what to do. Props: `text: () => string`, `testId`, `failed` (the snack's words).
- **For the Ask engineer:** replace `ask-copy` and the `ask-provenance` span with `<AiCopyButton text={() => answerWithoutCitations(turn.answer ?? "")} failed={t("ask.copyFailed")} testId="ask-copy" />` and, at the row's end, `<AiProvenance model={turn.model ?? ""} at={turn.createdAt} testId="ask-provenance" />`. Answer again stays beside Copy, at the same size (`size="sm"`).
- **For the Today/digest/filter engineer:** the digest's "Written by qwen3:8b. It can make mistakes." line becomes `<AiProvenance model={row.model} at={row.preparedAt ?? row.createdAt} testId="digest-provenance" />` at the end of the digest's header or action row, near its heading; the AI filter's header keeps its title and puts `<AiProvenance … />` at the end of its button row (or header, if it has none), with the model and time the rule was written, if the dialog has them, else `lines` alone.
- `provenanceLabel()` and `provenanceDetail()` stay exported; nothing else changes for anyone already using them.

### Summary

- **The item says what it does.** The row is no longer one button that "opens" an action. An item is its kind and its text, then, beside the text (wrapping under it when it can't fit), its controls at 28 px:
  - on an **Action** or a **Question**, a quiet **Reply** (ghost, with `Reply`'s glyph): it opens the conversation's ordinary inline reply, exactly as R does there (`reply("reply")` in `keyboard.ts`, so a Reply ready is used when there is one, as R does). Nothing new happens; it's the existing composer.
  - the source, named for where it goes: **Arjun's message, Yesterday →** ("Your message, Oct 22 →"), as a link-style button, its hover still "Arjun Ramírez · Yesterday, 9:41 PM". It is gone on a one-message conversation, as before.
- **A reading measure.** The summary's text and items stop at the mail body's measure (`rt-measure`), so the paragraph wraps as the message under it does (five raters measured 105 to 120 characters a line at 1440).
- **The footer** is the button row every AI surface has: **Copy** (`AiCopyButton`) and, at its end, `AiProvenance`. Nothing in it is a bare text target any more.

### Reply ready and the follow-up: one anatomy

Both are now the AI card (plan 148 left a card for follow-ups out of its scope, saying the line is the user's own to act on; its header still says so, but it reads as an AI note and both raters asked for one system):
- **Header** (`AI_HEADER`): glyph, the title in the ink, then what it's about.
  - Reply ready: "✦ **Reply ready** · **1 gap to fill** · To Liam Taylor". The voice leaves the header for the provenance popover, which explains it.
  - Follow-up: the fact is the title, "⏱ **Arjun Ramírez hasn't replied yet**" ("You told Arjun you'd send the contract").
- **Body** (text-sm): Reply ready's draft; the follow-up's schedule in words, muted: "Comes back to your Inbox Wed, Oct 28, 9:00 AM if there's no reply" (a promise: "Comes back to your Inbox Wed, Oct 28, 9:00 AM"; due: "Due today 5:00 PM").
- **Button row** (`AI_ACTIONS`): the primary, the secondaries, the source if any, and at the end `AiProvenance`. Reply ready: Use as draft, Dismiss, "Press R…", … Written with AI ▾. Follow-up: Draft a nudge (or Done), Reschedule ▾, Dismiss, "Your message, Oct 22 →", … Found with AI ▾ (the follow-up's own model and when it was found; only when the row has a model).

### Voice, said one way

What a draft's provenance says is two facts, kept apart and said the same way on the card and in the composer:
- **Style:** "In your voice with Liam: it learned from how you write to Liam." / "In your general voice: you haven't written to them before." / "Still learning your voice."
- **Content:** with no instruction, "What it says comes from this conversation alone: you gave no instruction." (on the card's popover and the strip's), and under the text after Use, the check line says the same thing short: "From the conversation alone, with no instruction from you: check it says what you mean."

### The three sparkles

Each says what it does in its tooltip and accessible name, and its key: the toolbar's **Summarize this conversation** (no key exists; adding one is the owner's), the reply bar's **Reply with AI ⌘J**, the composer's **Write with AI ⌘J**. The icon stays Sparkles everywhere (it's the AI's mark; no catalog icon is clearly better for Summarize). Their names are asserted distinct.

### The AI card's fill in dark

The ring holds its 1.5:1 floor, but raters still read the dark card as a hairline (its fill 1.11 to 1.15:1 off the reader). In dark, a tint card gets a wash of the ink at 4 % (`--ai-card-wash`, generated per design: tint designs only; Graphite outlines its cards). New `BOUNDARY_STEPS`: the AI card's fill on the reader, dark, at 1.2:1, and on Lumen's reader card at 1.1:1. The ring against the washed fill stays at 1.5:1, except Monokai (1.49, its fill now stands off the reader by itself at 1.33:1).

### Not taken, and why

- **A shortcut for Summarize, Shorter, Warmer or Nudge.** New bindings, which the shortcut list and the owner decide; the tooltips say there is none.
- **Regenerate on the summary.** A ready summary asked again returns the same one (pass 2): it would need a forced run.
- **Folding the summary's footer into its header.** The header is the disclosure's trigger, a button: nothing can sit in it.
- **Marking which sentences changed after Shorter or Warmer, a "Restored previous draft" line after Undo, a key for the follow-up.** New behaviour beyond these findings' fixes.
- **Merging the reply bar into Reply ready.** Plan 144 keeps them apart.

### Tests

- e2e: `followups.spec.ts` (`@design`: Reschedule's menu and the other menus and popovers unclipped, every design, light and dark, 1440 and 1100; the fact first; the card's anatomy; provenance), `ai-draft.spec.ts` (**Esc while writing keeps the instruction and the partial text, Stopped part-way, and Undo**; Stop with nothing yet keeps the instruction; the instruction line whole at 1440 and wrapped at 1100; Undo labelled at 1100; Rewrite ▾ at 1100; the commit moves nothing), `summaries.spec.ts` (Reply opens the reply; the source named; Copy's Copied; provenance popover), `replies-ready.spec.ts` (the header without the voice; provenance popover with the voice), the sparkles' names, `design-axe.spec.ts` for these surfaces.
- Unit: `stop()` (partial kept as a stopped write, nothing yet back to the field, a rewrite's strip kept), Undo of a stopped write, `messageSource`'s new words (en, es), `followupWhen`'s sentence, `AiProvenance` and `AiCopyButton`, `contrast.test.ts`'s new steps.

### Pass 3 as built

Where it differs from the design above:
- **The follow-up's title is at the text's size** (`text-sm`, medium, in the ink), not the header's `text-xs`: it's the news the card exists to say. Its glyph follows. Everything else is the shared anatomy.
- **The summary item's controls follow its words**, with the buttons' padding reached back (`-ms-2.5`, `gap-x-5`), so wrapped under the words at 1100 the Reply glyph is on the words' line, and beside them the visible gap is the row's (`summaries.spec.ts`, `@design`).
- **The instruction line's Edit holds its place while it writes** (the same button, invisible and out of the tab order and the accessibility tree), so "writing" and "written" are the same height and the commit still moves nothing (plan 133's e2e caught a 1 px step).
- **A stopped write with nothing yet** says "Stopped. Your instruction is still here." only when there was an instruction; a one-tap draft stopped early is just its field again.
- **Lumen's reader card** holds the washed fill at 1.1:1, except Nord (1.05), whose tint sits a step under its card; its 1.5:1 ring bounds the card there.
- **No change to `scripts/ui-rating/`.** Every capture wait still holds (`summary-block[data-state=ready]`, `summary-item`, `ai-row-input`, `ai-strip`, `reply-ready[data-phase=ready]`, `reply-ready-use`, `followup-line`, `followup-nudge`); all ten captures (five designs, light and dark) ran unchanged.
- **For the other two engineers:** `AiCopyButton` is `size="sm"` (28 px); Ask's Answer again should move to `size="sm"` with it. `AiProvenance` takes `model=""` when the surface doesn't know it, and then shows only its `lines`.

### What the Codex review of pass 3 changed

Four points, all taken, each with a regression test that fails without the fix (`ai-draft.test.ts`, `contrast.test.ts`):
1. **An edited stopped write's Undo couldn't be brought back.** Its Undo gives the field back, and the snack's Undo (and ⌘Z) only knew a session on a strip or none. The way back now knows the field it left (`stillOurs`), and ⌘⇧Z leaves the field again (`retake`).
2. **A stopped version forgot it was stopped** after a rewrite and its Undo, so the strip claimed a finished write and a second Undo closed the row. Each version keeps `stopped` (`AiCommit.stopped`, `versionOf`).
3. **A stopped write named Settings' first model**, not the writing task's. It names the model drafts run on, through one helper the backend's choice mirrors (`writingModel` in `lib/ai.ts`, now also Settings → Drafting's).
4. **Lumen's floor was 1.05, not the plan's 1.1.** It's 1.1, with Nord written down as the exception.

A second, narrower pass on those fixes found two more, both taken with a test: an old snack's Undo after a new instruction was typed in the field replaced the new instruction (the way back now needs the field to hold what the Undo left there); and on Claude with no task choice, a stopped write named Opus while drafts run on Sonnet (point 3's helper). Review rounds stop here.

### Where pass 3 stands

- **Run:** typecheck and lint, clean. Unit (`vitest --project unit` over `apps/web`, `packages/ui`, `packages/i18n`): 253 files, 2651 passed. e2e, `ai-draft`, `summaries`, `replies-ready`, `followups` and `design-axe` in all five projects (macOS, Lumen, Atelier, Luma, Graphite; their `@design` and `@variant` flows): 74 passed (3 skipped: the frames that run only when looking). `visual`, `designs`, `controls`, `menu-corners`, `palette`, `i18n` in all five: 58 passed, no baseline moved. `pnpm test:ui-perf`: 44 of 45 on the first pass, under a load average of 11 from other sessions; the one that failed (Lumen's sustained `j`) passed alone, 16.7 ms frames. `pnpm test:all` is left for the landing batch.
- **The required tests fail without their fixes**, checked by putting the old code back: Reschedule's clipping (`followups.spec`, `@design`: "Later today (70 > 27)", "This weekend (85 > 4)", "Next week (64 > 0)") and Esc while ⌘J writes (`ai-draft.spec`, both scenarios), and each Codex finding's unit test.
- **The frozen capture** reaches every AI state in all five designs, light and dark, with no change to `scripts/ui-rating/`.
- **Shots:** `/tmp/terno-scratch/ai-pass3/draft-followups/after/<design>/` (1440x900 and the `-small` 1100x700 copies), and Reschedule's menu open in every design, light and dark, at both sizes, in `/tmp/terno-scratch/ai-pass3/draft-followups/later/`. Before is ai-r02's `/tmp/terno-scratch/ui9/rounds/ai-r02/<design>/shots/`.

### For the owner

- **A key for Summarize** (and for Shorter, Warmer, Draft a nudge): raters asked in every round; each is a new binding in the shortcut list, so it's yours. The tooltips now name each sparkle, with ⌘J where it applies.
- **The follow-up is now on the AI card.** Plan 148 left that out of its scope (the line is the user's own to act on); both raters and the lead asked for one system with Reply ready. If plan 148's reason should stand, the anatomy works without the card (drop `AI_CARD` from the line).

### Pass 3: the shared AI language, adopted (lead, on main)

The pass 3 engineers left Ask and the digest for the shared components once they landed. Ask's Copy and "Written with AI", and the digest's attribution, now use `AiCopyButton` and `AiProvenance` (`components/ai-provenance.tsx`), so every AI surface says who wrote it and copies it one way. The AI filter keeps "Written with AI" as its card's title, as the summary's card says "Summary". The old `ask.copy` and `ask.copied` strings went with Ask's own button.

The adoption's e2e step (Esc in the provenance popover closes only it) caught a bug: the palette catches Esc in the capture phase, before a portalled popup sees it, and went back to all commands. The palette now leaves keys from a popup portalled out of it to that popup (`command-palette.tsx`), and the popover also stops its Esc from bubbling to whatever holds it. The step fails without the fix.

Codex reviewed the adoption: two points, both fixed. Keys inside the open popover (Enter, the arrows) reached the palette's list behind it; the popover now keeps all its keys. While the popover is open, Esc on its trigger is the popover's, not the page's. The e2e step opens it from the keyboard and checks that Enter chose no source and Esc left Ask open.

### After ai-r03: the digest's scroll (lead, on main)

ai-r03's one high issue, and every low cell (3.5 to 5, Lumen, Codex): the digest page didn't scroll. It was its own scroller with no height to scroll in, so it grew past the reader pane (about 1,200 px in a 700 px window) and the pane clipped its last rows and their boxes, which Archive still counted. Measured in all four rated styles, since plan 145. The pane now scrolls (`digest-scroller`, full height) with the page as a column in it, so the wheel works anywhere over the pane. An e2e test in a short window wheels over the pane's empty side to the last row and unticks it; it fails without the fix. Codex's review found the two scroll-memory unit tests still scrolling the inner page; they now use the scroller.

### ai-r03 (main at `2a875d900`, 2026-11-08)

After pass 3 (the three areas, the shared provenance and Copy adopted in Ask and the digest; full suite green once its flaky first-pass failures ran again alone, and the AI harness smoke updated for Ask's new dialog name). All eight reports valid; 664 cells under 9 as the gate counts them (ai-r02: 670), 101 issues (1 high; ai-r02: 104 and 7). The numbers as `gate.mjs` wrote them:

| Style | Rater | Overall | UI | UX | Lowest | Cells below |
|---|---|---:|---:|---:|---:|---:|
| atelier | claude | 7.5 | 7.5 | 8 | 6.5 | 84/84 |
| atelier | codex | 7.5 | 7.5 | 8 | 6.5 | 73/84 |
| graphite | claude | 7 | 6.5 | 7.5 | 6 | 84/84 |
| graphite | codex | 7.5 | 7.5 | 8 | 6 | 79/84 |
| lumen | claude | 7 | 7 | 7.5 | 6 | 84/84 |
| lumen | codex | 7 | 7.5 | 7 | 3.5 | 72/84 |
| macos | claude | 7 | 7 | 7.5 | 6 | 84/84 |
| macos | codex | 7.5 | 8 | 7.5 | 6.5 | 80/84 |

#### Screens, each rater's overall

| Screen | atelier claude | atelier codex | graphite claude | graphite codex | lumen claude | lumen codex | macos claude | macos codex |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| summary | 7.5 | 8 | 7 | 8 | 7 | 7.5 | 7 | 7.5 |
| ai_draft | 7.5 | 7.5 | 7 | 7 | 7.5 | 7.5 | 7 | 7 |
| ask | 8 | 8.5 | 7.5 | 8 | 7.5 | 8.5 | 7.5 | 8 |
| actions | 8 | 8.5 | 7.5 | 8.5 | 7 | 8.5 | 7 | 8.5 |
| today | 7 | 7 | 6.5 | 6.5 | 6.5 | 4.5 | 7 | 7 |
| followups_replies | 7.5 | 7.5 | 7.5 | 8 | 7.5 | 8 | 7 | 8 |
| ai_settings | 7 | 7.5 | 6.5 | 7.5 | 6.5 | 7.5 | 6.5 | 7 |

#### Facets, mean across screens

| Facet | atelier claude | atelier codex | graphite claude | graphite codex | lumen claude | lumen codex | macos claude | macos codex |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| typography | 7.93 | 7.93 | 6.93 | 8.21 | 7.43 | 8.07 | 7.29 | 7.86 |
| contrast | 8.07 | 8.79 | 7.21 | 8.29 | 7.29 | 8.71 | 7.43 | 8.21 |
| placement | 7.29 | 7.86 | 6.79 | 7.29 | 7.07 | 7.29 | 6.79 | 7.86 |
| hierarchy | 7.36 | 7.86 | 6.71 | 7.50 | 6.86 | 7.79 | 6.79 | 7.64 |
| controls | 7.36 | 7.93 | 6.57 | 7.50 | 6.93 | 7.57 | 6.79 | 7.64 |
| density | 7.71 | 7.36 | 7.21 | 7.50 | 7.36 | 7.14 | 7.14 | 7.36 |
| efficiency | 8.00 | 7.79 | 7.36 | 8.07 | 7.71 | 7.43 | 7.64 | 7.86 |
| clarity | 7.64 | 7.86 | 7.50 | 7.79 | 7.21 | 7.86 | 7.21 | 7.71 |
| feedback | 7.93 | 8.64 | 7.43 | 8.43 | 7.86 | 8.43 | 6.93 | 8.50 |
| consistency | 7.29 | 8.21 | 7.07 | 7.71 | 7.07 | 7.71 | 7.00 | 7.79 |
| accessibility | 7.36 | 8.21 | 6.43 | 8.14 | 6.57 | 7.79 | 6.86 | 7.71 |

**Overall:** 7 to 7.5 from every rater in every style; most raters' lowest cell is 6 to 6.5 (ai-r02: 3.5 to 4.5). Ask and actions reach 8.5 from Codex. **The one high issue and every cell under 6** (Lumen, Codex, Today, 3.5 to 5) is the digest not scrolling, fixed after the round (above); it was in every style since plan 145.

**What's left** (medium issues, by screen): Today 11 (reasons still read as part of the snippet, no bulk reset in the digest, focus after a bulk action), ⌘J 8 (the strip's height and its break at 1100), AI settings 8 (Writing style's copy still explains machinery; the filter's primary is the retroactive apply; the preview shows 6 of 66), summary 7 (its prose has no citations as Ask's has; Copy outweighs Reply), actions 6 (two ways of saying Esc; X needs a focused row; a generic snack after Apply), follow-ups 6 (Reschedule has only four presets, no exact date), Ask 3 (one AI error style; one date format).

## Where it stands

Four rated rounds, three fix passes. Every rater's overall went from 6 to 7 (ai-r00) to 7 to 7.5 (ai-r03); cells under 9 from 695 to 664; high issues from 17 to 1, fixed. No screen reaches the bar of 9 from both raters; the closest are Ask and actions (7.5 to 8.5). Owner decisions open: whether an opened newsletter stays in the digest's batch, whether all start ticked, whether an opened one stays pinned, Today's 12-row cap, the action preview's row-body versus check split, the Undo ring's track, a sender check on AI actions, new AI shortcuts, and the follow-up in a card (plan 148).

## Owner's answers (2026-11-08)

To the open decisions above:

- **Newsletters from the digest are normal emails, nothing more, nothing less.** Opening one from the digest opens it in the reader like any email; Today's list doesn't gain it or pin it. "Back to the digest" and Esc back to it stay. The rest of plan 145 stays: an opened newsletter is read, so it stays in the Inbox and out of the batch ("the first question is fine"); every newsletter starts ticked; Today keeps its 12-row cap.
- **The Undo ring's drained part is a faint track,** so it reads as a countdown and not a broken outline. An existing token at a faint step, inside the contrast suite; motion within `--motion`.
- **A sender check on plain-English actions, without AI.** "If it's using AI, no. Don't do that. But if we can do it without using AI, reliably, then yes." Reliable: an address or a domain in the sentence counts; a name after "from"/"de" counts only when it matches a sender name or domain in the mailbox, looked up locally; nothing else counts. Shown on the preview's rule, Split and List; Apply isn't blocked.
- **No new keyboard shortcuts** for AI.
- **Keep the split** in the action preview: the row's body opens the mail, the check column includes or leaves it out.
- **The follow-up stays on the AI card.**

## After the owner's answers

### 1. A newsletter opened from the digest isn't Today's

**What pins it.** The digest page sets `selectedId` to the newsletter. Today's list sends the open row as one of `today.list`'s `heldIds` (plan 145 revision 9, for a row replied to while open), and the backend gives back any held thread, so the next refresh (the read, after the reader's dwell) adds the newsletter at the list's end and keeps it there until the selection moves.

**Change.** `fetchPage` holds the open conversation only when it's one of the list's rows already (`useList`'s index). Revision 9 is about not losing a row you're on, never about adding one. A thread open from elsewhere (the digest, Ask's sources) shows in the reader, and the list is what Today holds. Nothing else in the reader changes: Back to the digest and Esc still come from `fromDigest`.

**Test.** `today.spec`: after opening Stratechery from the digest and the dwell's read, the digest's row says one fewer (the refresh is in) and no thread row in Today's list is Stratechery's. Fails without the change (the row arrives at the list's end).

### 2. The Undo ring's track

**What's there.** The track is `--snack-track: var(--border)`: 1.00 to 1.61:1 on the pill (Nord's border is invisible on its card; Lumen light 1.33), against a ring of 4.5 to 17.7:1. At a few percent drained the gap at the top reads as a fault.

**Change.** `--snack-track` is the secondary ink at 40 % (`color-mix(in oklab, var(--muted-foreground) 40%, transparent)`): 1.86 to 2.40:1 on the pill's card over the popover in every palette, so the whole outline is always there and the drained part reads as a quieter stretch of it. No new token, no new colour, no new motion: the drain is the same Web Animation (linear, or a step a second when motion is off, as plan 13 holds, since the lifetime is information).

**Tests.** `contrast.ts` gains `SNACK_TRACK` and a `BOUNDARY_STEPS` floor (1.8:1, "the Undo ring's drained track on its pill"), and a ceiling under the ring's own step so it stays a track; `contrast.test` checks `globals.css` says the same as `SNACK_TRACK`. e2e (`snack.spec`, `@design`, so every design): the track's colour composited on the pill in the page, light and dark, at the floor or above. Both fail with `--border`.

### 3. The sender check

**Where.** The preview's rule (`ActionRule`, Split's reader and List's header). A line beside the rule, in the rule's own type, not a warning colour: "Your sentence names Netflix, but this rule doesn't look at the sender. Check it below, or edit it as a rule." Apply stays as it is.

**What the sentence names** (`sendersNamed` in `lib/rule-words.ts`, pure, English and Spanish):

- an address, as written;
- a domain with a known top-level label (`uber.com`, `netflix.es`), not one inside an address;
- a phrase after "from", "de" or "del": up to three words, past an article or possessive ("the", "my", "los", "mi"…), stopping at a connective or a word of time or quantity ("older", "than", "hace", "más", a number). These are only candidates.

**Reliable.** Addresses and domains count as they are, unless one already appears in a condition (`recipients contains ana@x.com`). A candidate name counts only when the mailbox has it: a new `senders.named` RPC asks the autocomplete index (plan 18, in memory) by exact token, as plan 133's `resolveExact` does for names in a sentence, and keeps a sender only when their name and the phrase agree word for word until one ends ("Uber" and "Uber Receipts"), or the phrase's first word is their domain's own label ("uber" of uber.com), and only someone mail you received was from. A cold index is warmed and waited for, at most 2 s; still cold, names say nothing. No model, nothing leaves the machine. (As built after the Codex review, below.)

**When it shows.** Something is named, and the rule (what Apply runs: with or without new mail) has no sender condition, positive or negated (`from`, `fromDomain`, `listId`, or `text`, which reads the sender too). `ruleMisses`' sender test is the loose one (any "from"); the two share the sender-field test.

**Cost.** One RPC after the preview opens, with at most four phrases, each one in-memory range lookup. Nothing on the list's rows or their renders; the line subscribes only in `ActionRule`. `pnpm test:ui-perf` is run.

**Tests.** `rule-words.test`: addresses, domains, a domain in an address, the stub's "Archive shipping notices older than a month" (nothing), "except Amazon" (nothing), "from now on", "from last week", "de hace más de 30 días", "los recibos de Uber", "del banco", the rule's sender conditions with and without `negate`, `text`, an address a recipients condition already holds. `contacts.test`: `resolveExact`'s `received`. Backend: `senders.named` keeps a name's start and a domain label, drops a word inside a name, and a person only written to. e2e (`plain-actions.spec`): "Archive receipts from Uber" warns in Split and List and Apply still works; "Archive receipts from uber.com" (a sender condition) and "Archive shipping notices older than a month" don't.

### What the Codex review changed

Codex (read-only, `git diff 4c4537f81..HEAD`) raised 7 points, all taken, each with a test that fails without its fix:

1. **A shared first name named someone else.** "from John Smith" matched a mailbox with only "John Doe". Name and phrase now agree word for word until one of them ends (`namesSender`, `resolve-exact.test`).
2. **A co-recipient counted as a sender.** The index's received weight includes To and Cc of incoming mail. A new `SENDER` flag marks whoever incoming mail was from; the contact snapshot's format goes 4 → 5, so a stored index is rebuilt once, in the background, on its next warm (plan 18).
3. **A date read as a name.** "from May 2024", "de mayo": months and weekdays, English and Spanish, end a phrase (`rule-words.test`).
4. **A row opened while a Today refresh was on its way could leave and not come back,** since a row is now held only while the list shows it. A refresh whose answer drops the row opened meanwhile asks again, holding it (`today-held.test`).
5. **The lookup's work wasn't bounded by its answer:** each phrase sorted every contact with the token. `bestSender` reads senders as they come, unranked, at most 2,000 a phrase, and stops at a full match; a turn of the event loop between phrases.
6. **A nameless sender at a subdomain was unreachable** ("Netflix" and info@account.netflix.com): the index also holds a domain's own label as a token (tokenizer 1 → 2, with the rebuild above).
7. **A crowd of better-ranked contacts could hide the one named** (twenty "Morning Brew …" before "Brew Logistics"): every sender with the token is qualified, none cut by rank first.

### As built

- **Commits** on `t3/digest-newsletter-sender-warning`: the plan, then one per answer, then the review's fixes.
- **Shots,** every design, light and dark: `/tmp/terno-scratch/owner-answers/<design>/` (`today-after-open-*`, `action-sender-*`, `undo-*`, `undo-zoom-*`), and side by side in `/tmp/terno-scratch/owner-answers/sheet-*.png`. In each, the newsletter opened from the digest is in the reader with Back to the digest, and no row of Today's list is it; "Archive receipts from Uber" says the sender line above the rule (the stub's rule reads only subjects and openings, and finds Rappi's, Stripe's and Vercel's receipts too); "Archive shipping notices older than a month" says nothing; the ring's drained stretch reads as a quieter part of a whole outline.
- **Anything else that treats a newsletter from the digest differently** (the owner asked): only the way back, which stays (`fromDigest`: the reader's "Back to the digest", Esc from the reader and from inside the mail's document, and focus back on the row it was opened from), and the digest page's own "Opened · stays in Inbox" for a read one (plan 145). What follows from not being one of Today's rows is what any conversation open from elsewhere gets: the reader's newer and older buttons are off, j and k start from the list's top, and Archive in the reader goes on to Today's first conversation rather than its neighbour.

## Real models (owner, 2026-11-08)

### The request

> instead of ollama, use actual models from the .env keys on the main path of the app at `/Users/Luis/projects/emailclient/.env`

This reverses the request's point 1 ("AI on in the rating, without real keys") for the rating's default. The stub stays, for tests and the smoke, and by name (`--ai stub`, `ai: "stub"`).

### How the frozen build reaches the main path

The main path is Pro's: Dev mode's Pro AI (plans 146, 147, 150), Pro's routing on the developer's keys, as `pnpm dev:desktop` runs it. Dev mode exists only on a local build run from the dev server (`devModeOf({ devUrl, packaged })`), and the rating's frozen build has no dev server (revision 1 above: it isn't a dev build). No supported switch reaches it there, so this adds one, beside the rating's other test hooks:

- **`TERNO_TEST_DEV_AI=1`** (`apps/desktop/src/test-hooks.ts`, `testDevAi(env, packaged, demo)`): main sends `devMode: true` to the backend only for the demo mailbox on an unpackaged build. A normal launch is a real mailbox and an installed app is packaged, so neither reaches it, whatever its environment says (`test-hooks.test.ts`). From there everything is the app's own path: `backend-entry` reads `devAiKeys(process.env)`, Settings shows Dev mode, and the harness turns **Pro AI** on there with a click (`settings.update`, as a person does), then the four background switches, sender icons off and automatic updates off. The rated launch reads them back (`checkAi`).
- Nothing is patched: the build is the one the round froze, and the keys go through the overlay plan 146 built (`withDevAi`: an env key goes only to its provider's own endpoint, never saved).

### The providers and models

Pro's routing with all three keys (`AiService.targetFor` over `withDevAi`), recorded in `round.json` as `ai.routing` (`keys.mjs` `PRO_ROUTING`; `keys.test.ts` holds it to `@terno/core`'s and `@terno/ai`'s constants):

| Task | Screen | Provider / model |
|---|---|---|
| summary | `a01` | OpenAI `gpt-6-luna` |
| writing (⌘J), reply (Reply ready's draft), voice | `a02`, `a03`, `a10` | Anthropic `claude-sonnet-5-5` |
| reply check (`needs_reply`) | `a10` | Anthropic `claude-haiku-5-5` |
| ask (the answer) | `a04` | Anthropic `claude-sonnet-5-5` |
| ask plan, action plan and check | `a04`, `a05` | Anthropic `claude-haiku-5-5` |
| follow-ups (`sent_mail`), digest, intent | `a07`–`a09` | Anthropic `claude-haiku-5-5` |
| filter | `a11` | Anthropic `claude-opus-5-5` (the provider's default) |
| categorize | none (smart categories are off in the demo) | JEV `jev-latest` |

`GROQ_API_KEY` is in the owner's file but isn't Pro's (Dev mode reads only `DEV_AI_ENV`), so the harness doesn't read or pass it.

### The keys

- **One file.** `keys.mjs` reads `TERNO_RATING_ENV`, by default `/Users/Luis/projects/emailclient/.env`, so a worktree and the frozen runtime find the same file. It reads only `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (both required) and `JEV_API_KEY`; an error names the file and the variable, never a value.
- **Only to Electron.** `launch({ ai: true })` reads the file at launch and puts the keys in the env it hands `electron.launch`, and nowhere else: not this process's env, not a file. `electronEnv()` strips any key the caller's own env had first, so a stub or AI-off launch can't carry one (`keys.test.ts`).
- **Nothing written holds one.** Belt and braces, since nothing prints them:
  - once a launch has the keys, its process's stdout and stderr are redacted (`guardOutput`: every write, so `console.*` too), and `capture.mjs` prints its own failure redacted, since Node's report of an uncaught error bypasses the streams;
  - `rate.mjs` reads the same file only to redact: every child's log (`capture-<design>.log`, `<rater>.log`), `round.json`, the brief, and what leaves a rater's room (`report.json`, `report.md`, `probes/`, text files redacted, images copied) go through `writeRedacted`/`copyRedacted`, which replace the loaded keys and anything shaped like a provider key;
  - the throwaway profile: the backend's logs, the database and the net log don't hold keys (the keys travel in headers; the net log is URLs). The profile is deleted on close; before that, `close()` scans every file the run wrote there for the keys and fails the run if one holds any (the file is deleted either way). That's cheaper and stronger than redacting the app's own logs, which no key reaches;
  - `gate.mjs` fails a round whose `round.json` holds anything shaped like a key.
- **The proof.** `keys.test.ts` runs a child that loads a fake `.env` and then deliberately prints the keys every way a run can (console, raw writes, a buffer, a thrown error), writes them in a round's logs and `round.json`, and copies a room holding them out: stdout, stderr and every file written carry the redaction mark and no key. A second case runs `capture.mjs` itself on a fake `.env` missing a key: it fails naming the variable and prints none of the others.

### The raters' room

Raters launch the harness themselves for hands-on use, and it reaches the keys the same way: the room's `harness.mjs` reads the owner's `.env` at its default path (or the path `TERNO_RATING_ENV` names, which `rate.mjs` passes on when it's set: a path, never a key). No key is set on the rater's process, and the file is never copied into the room. **A rater can technically read that file**: it's on the same machine, and a rater runs with its tools unsandboxed. It is the owner's own file, the brief tells raters not to look outside their folder, and whatever leaves the room is redacted on the way.

### The network check

`netProblems` takes `aiHosts`, the hosts of the providers this launch has keys for (`api.anthropic.com`, `api.openai.com`, and `api.typesafe.ai` with JEV's key; `keys.test.ts` holds them to `@terno/ai`'s endpoints). An AI request may go only there, over https. Anything else fails the capture: another AI host, plain http, a provider's host for another purpose, an AI request on loopback, and anything off loopback that isn't AI (icons and updates are off). The window's fence is unchanged. On real models the setup launch's requests stay in the log and are judged too, since they carried the keys. Each capture prints the hosts it reached; `rate.mjs` keeps them in `round.json`'s `ai.runs[design]`, and the gate fails a run that reached a host no provider has, or a design without a run per mode.

### Real models are slower, and vary

- **Waits.** `capture.mjs`'s model waits are ceilings of 3 minutes for a state asked for and 5 for a background job (the digest, a follow-up), against 30 s and 60 s on the stub. Each still ends at its ready state; there is no sleep.
- **Consent, as a person gives it.** A cloud model asks once before a conversation goes to it (the summary's Continue, Ask's, the action check's). The capture says yes when it's asked, then waits for the state; the shot is the state after the yes, as on the stub.
- **Bounded retries** where the state is the model's call: Ask's answer with sources, the action's preview with matches (a plan that finds nothing is a notice, then asked again), the filter it writes, and the follow-up (the question is sent again when the model says it expects no reply). Three tries on real models, one on the stub; then the capture fails naming the state and the last reason. Two can't be asked again from the window and fail at once: Reply ready (`needs_reply` is decided once per conversation as it stands) and the digest (prepared once a day; a digest with no newsletter line fails rather than shooting an empty page).
- **No byte comparison.** Rounds on real models are not comparable byte for byte with stub rounds, nor with each other: the words differ each run. `round.json` records `ai.models` (`real` or `stub`; an AI round from before has none, and was the stub), `ai.routing` (the model ids), and each capture's run: the hosts reached, the models each surface's provenance says wrote it, and what the app counted it spent. The gate's summary says which models answered.
- **The demo mailbox is fictional**, so sending it to the providers sends no one's mail.
- **What a real model's answer can be.** Ask's screen is "an answer and its sources": the model may mark an answer `partial` (it saw only part of the demo's years of mail), which is that state too. The capture takes `answered` or `partial` with at least one source; `not_found`, `failed` and `stopped` are asked again.

### The brief

`brief-ai.md`'s scope paragraph said the model was a fixed local stand-in. It now says: "The app is running real AI models, so their words can differ from one run to the next: rate how the app presents, explains and lets you act on what the model wrote. The words themselves are in scope only where the app could have shown them better." The hands-on section also said `ai: true` ran "the local stand-in; nothing leaves the machine", which is now false, so that clause changed too: "with AI on the same real models as the screenshots (`ai: true`)". Nothing else in it changed; `brief.md` is unchanged.

### Tests

- Unit: `keys.test.ts` (the file and its three names, errors without values, providers and hosts against the app's, the routing, Electron's env, redaction, the leak proof above), `harness.test.ts` (the host allowlist), `test-hooks.test.ts` (the switch), `gate.test.ts` (a real round's record, the stub's, a key-shaped string in `round.json`).
- Smoke, `ai-rating.smoke.ts`: the stub's case as it was, launched with `ai: "stub"`; a real-model case, skipped unless `TERNO_RATING_REAL=1`, so CI and `pnpm test:all` never spend: the clock, Today's digest on a real model, Ask, the network check with hosts, usage counted, and `close()`'s scan of the profile.

### What the real capture found, and changed

The verification run (`node scripts/ui-rating/capture.mjs lumen /tmp/terno-scratch/real-models/shots light --screens ai`) failed four times before it passed, each on something the stub can't show:

1. **Three consents the stub never asked for.** A cloud model asks once before mail goes to it: ⌘J's first draft ("Each draft sends Claude (Anthropic)…", `ai-telling-continue`), the summary (`summary-continue`) and the action's check (`action-consent-continue`, which also keeps Apply's spinner turning). The capture gives the yes when asked, as a person would; the shot is the state after it.
2. **Ask's `partial`** (above).
3. **A bug in the app: follow-ups never noted a wait on Pro's model.** The probe (`scripts/ai-real`'s harness, the owner's own eval tooling, on the capture's exact message) showed Claude Haiku 5.5 answering `"awaiting": ["Arjun Ramírez"]`, the recipient's name, where the prompt asks for the label `r1`. `checkSentMail` looked labels up only, so the row was dropped and no "hasn't replied yet" line was ever written on Pro's routing; the stub always answered with labels, so no test saw it. **Fix** (`packages/backend/src/followups.ts`): a recipient may be named by its label or, failing that, by its exact name when exactly one recipient has it, so a name can't reach anyone the message wasn't sent to. Promises' `to` gets the same. `followups.test.ts` covers the label, the name, a name nobody was sent, and a name two recipients share; it fails without the fix.
4. **Sender icons on the setup launch.** The window's first paint asks for website icons before the setup turns them off, and the stricter check refused them. On real models the setup now turns icons and updates off first, the harness starts the net log afresh there, and only then turns Pro AI on, so every request that could carry a key is still judged.

### As built: the real capture

- **Every AI state reached**, light, Lumen: `/tmp/terno-scratch/real-models/shots/` (17 shots), all looked at, plus a contact sheet of the small sizes (`/tmp/terno-scratch/real-models/sheet.png`). Each shows its real state: the digest's lines and Archive, the summary with its items and source arrow, ⌘J's strip with Undo and the draft, Ask's answer with numbered citations and sources, the action's rule and its four matches, the Undo snack, the follow-up line with "Draft a nudge", Reply ready with its gap to fill, the filter Claude wrote (domain is uber.com, subject contains "receipt", 66 matches), and Writing style. The words are the models' own; one is worth a note for the raters' scope: ⌘J took "ask him to send the address of the flat" literally ("Could you ask him to send…").
- **The models each surface says wrote it** (its provenance): the digest `claude-haiku-5-5`, the summary GPT Luna, Ask and Reply ready Claude Sonnet 5.5, as the routing table says.
- **The network:** AI requests to `api.anthropic.com` and `api.openai.com` only (67 policy decisions for AI, model lists included), nothing else off loopback once icons were off, nothing refused at the window.
- **Cost, as the app counted it** (its usage book: the providers' reported tokens at `@terno/ai`'s prices): 13 model requests, 38,306 tokens in and 11,283 out, **US$0.047 for one mode of one design**. By task: Ask (plan, answer, action plan and check) $0.017, the filter on Opus $0.008, Reply ready $0.008, ⌘J $0.007, the digest $0.006 (marked an estimate: one price counted high), the summary $0.0006, the follow-up $0.0002. So a round's captures, four designs in light and dark, are about **US$0.40**, and every retry adds its step's share. The raters' hands-on use comes on top; at a similar rate for the flows the brief lists, a full round is roughly **US$1 to 3**. The digest is prepared again on each launch (each has a fresh profile), which is most of its share.
- **The redaction proof** (`/tmp/terno-scratch/real-probe/leak-check.mjs`, which prints only "found" or "not found"): over the real capture's shots and log, the probes, `scripts/`, `docs/`, the smoke and the branch's diff, no key whole, and no 28-character slice from inside any key, is found. Each key's first 8 characters are found only in `keys.test.ts` and `gate.test.ts`, whose invented keys start with the providers' common prefixes (`sk-ant-…`, `sk-proj-`) on purpose. Each launch's `close()` scanned its throwaway profile (logs, database, net log) and found none.
- **Smoke:** `ai-rating.smoke.ts`, all three cases, the real one with `TERNO_RATING_REAL=1` (it skips without it).
