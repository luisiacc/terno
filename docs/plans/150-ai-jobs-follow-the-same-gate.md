# Plan 150: AI's background jobs follow the same gate as its UI

- **Status:** built. "Revisions after the Codex review" overrides the sections before it.
- **Builds on:** plan 147 (what shows), plan 146 (Dev mode), plan 85 decisions 9 and 10 (`forTask`, the one place that decides).

## The request

> Yeah, free users with uh, an AI provider, local or with their own kids come, of course, the AI features. And of course, a user with a pro plan also will be able to do that. For the background work that you're mentioning, I mean, if the switches are off, it shouldn't do the background jobs that does with AI either, of course. It shouldn't, it should not do them. If the switch is off or they don't have an AI provider. And they're not, if they're not on local mode and they have an AI provider, yes, they run. But yeah, let's link the showing of the UI of the features with the background workers that use AI as well.

(Dictated: "their own kids" is "their own keys". "Local mode" is a local dev build, as in plan 146.)

## The rule

The renderer's `aiAllowed` (plan 147), now in the backend too:

| | AI jobs |
| --- | --- |
| Local build, Dev mode's switch off | none, whatever is saved |
| Local build, switch on | run, on the environment's keys |
| Any other build, no provider | none |
| Any other build, own key or local model | run |
| Pro, once it exists | run, through `aiFeaturesAvailable`'s `entitlement` and plan 85's `forTask` step |

This also settles plan 147's open question: decision 9 stands.

## What exists

Every model call goes through `AiService.forTask`, except what a person asks of Settings (a model list, Test connection). The jobs: summaries, follow-ups, the digest, prepared replies, the voice learner's judgments, categorization. On `not_configured` all of them already stop and spend nothing, until settings change: no timer, no retry.

- **No provider already holds,** for all of them: `targetFor` gives `none` or a key is missing, and `config` throws. A test holds it from here on.
- **The switch off doesn't:** a saved key runs them. Plan 147 stopped only the brief's notice.
- **A toggle wakes** summaries, follow-ups, Ask and categorization. It doesn't reach Today or prepared replies, which plans 144 and 145 added after plan 146.
- **Today has its own rule** (`available`), and a daily timer that arms on it.

## Design

1. **`aiAllowed(store)` in `settings.ts`,** beside `activeDevAi`: true with no `devAi` registered, without a read (plan 146: nothing extra off a local build); else the stored flag.
2. **`forTask` refuses first,** for every task but `filter`: `AiError(L("errors.ai.devSwitchOff"), "not_configured")`. It comes after `epoch`, so a toggle during it starts over. Foreground tasks are refused too: the UI is hidden, and a window that hasn't heard gets the message it already has for this.
3. **`filter` is exempt.** AI filters are Free, foreground and asked for by a click, and have no mail in them (plan 85). They aren't a background job.
4. **Today's `available`** reads `aiAllowed` too, so with the switch off no timer arms, nothing is prepared, no notice goes, and `today.list` and the count are empty. Plan 147's check in `notify` goes: this covers it.
5. **A toggle reaches everything:** the `devAi` branch of `settings.update` also calls `b.today.settingsChanged()` and `b.replies.settingsChanged()`.
6. **Copy:** `errors.ai.devSwitchOff` in `en` and `es`: Settings' paused line reads it. "Dev mode's Pro AI is off. Turn it on in Settings → Dev mode."

What a job has queued stays, as with any pause: mail that came in while off may be summarized once it's on, within the existing window. Nothing leaves until then.

## Tests

(See the revisions for what was narrowed.) `dev-ai.test.ts`:

- **The one place:** with a provider saved and the switch off, every task but `filter` refuses and builds no client. On, they build. Off a local build, a saved provider builds as before, and no extra settings read.
- **Each job, end to end, with the model counting requests:** the switch off and summaries, follow-ups, the digest, categorization and a prepared reply on: mail arrives, wakes run, no request. Then the switch on: it runs, without a restart.
- **No provider, on any build:** the same jobs, no request.
- **Today:** the switch off arms no timer; on arms it (`today.test.ts`).

## Perf and resources

One stored read in `forTask` on a local build, none elsewhere. Better than before: a local build with the switch off has no digest timer and makes no requests.

## Out of scope

Entitlements (plan 85). AI filters. Settings' switches staying visible: they're the way in, and off they say why they're paused.

## Revisions after the Codex review

Codex (read-only, against `78bfd84c`) raised 6 points. Three change the design, and one is recorded as it stands:

1. **Prepared replies stored a refusal as a verdict.** Every error but a cancel or a limit wrote `failed`, and a thread with a `failed` row never tries again. `not_configured` now writes no row, so it can run once something is set up.
2. **The voice learner's judgments don't resume at once, and that stands.** They refresh only after a pass, and a pass needs enough new mail or a rebuild. One skipped while off waits for the next pass, as a refresh is rare by design. Waking the learner wouldn't change it (the code review's one point: `force` only skips its throttle, so that first fix was removed).
3. **`today.list` has its own check,** apart from `setting()`. Both go through `available()`.
4. **A late refusal could pause what the toggle just woke.** `forTask` checks the epoch before it throws, and starts over.

Not taken, both very rare and on a local build only:

- **Categorization's per-minute wait** can arm one timer after the switch goes off, past 20 requests in that minute. It fires once and stops at `forTask`.
- **`actions.ts` and `ask.ts` read the target again to record what already happened.** Flipping the switch during that, from a second window, loses a history line or a stopped answer. Mail isn't affected.

The tests are narrower than planned: `forTask` is held for every task, and summaries, the digest and prepared replies end to end. Follow-ups, categorization and the voice learner rest on that one place, and on their suites' own tests of `not_configured`.
