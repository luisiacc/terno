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
