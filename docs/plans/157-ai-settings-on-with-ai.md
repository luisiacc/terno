# Plan 157: Summaries and learning come on with AI

- **Status:** in progress.
- **Builds on:** plan 132 (summaries), plan 133 (the learner), plans 147 and 150 (one gate for AI), plan 85 (Pro).

## The request

> when pro plan is enabled, we need to , by default, enable learn from my sent email and summarize new email, they need to be ON by default, those settings should only be shown when the user has ai features(wether local with ai or production with pro plan) , and they have no effect if they don't have ai features, so when ai features are enabled, those are enabled too.
>
> also , is 'learn from my sent email' a continuos thing? or does it only learn once?

## What the words mean here

- **"Has AI features":** plan 147's rule. A local build: Dev mode's switch. Any other build: a provider that can run, or Pro once it exists. Someone's own key or local model has AI features by that rule, so they get these defaults too. The request names only the local build and Pro; this is the one reading to confirm, and it's one condition in `summaryCanRun`.
- **"ON by default":** a choice the user never made reads as on. Someone who turned one off keeps it off. A switch can't tell the difference once a value is stored, so a profile that already saved `summaries.enabled: false` stays off.
- **"No effect":** nothing is marked, queued, counted or sent while AI isn't there, whatever the switch says.
- **The answer to the question:** it's continuous. Once started, the learner keeps counting new sent mail, on this device, looking at most every 30 s when something changes, and rebuilds an account when about 5% of its window (at most 20 messages) has changed. Today it starts only with the first draft or the Writing style page; after this it starts when AI does.

## What exists

| | Default | Shown | Runs |
| --- | --- | --- | --- |
| Summarize new mail | off (plan 132: "it sends mail with no click") | always | the switch; no provider means paused with a note |
| Learn from my sent mail | on | while "Draft with AI" is on | once the feature has been used, even with AI gone |

`forTask` already refuses summaries without AI, but the worker still queues rows and pauses: a queue grows for nothing. The learner's counting asks for no model, so plan 150's gate never reached it.

## Design

### Summaries

- `DEFAULT_SETTINGS.summaries.enabled` becomes `true`.
- `summaryCanRun(ai)` in `@terno/core`, by `AiService.targetFor`'s rule: a task's own choice answers for itself; with none, an OpenAI key, else a local model as the main provider. A cloud provider the user hasn't picked for summaries stays "ask" (plan 132 §2): the default never moves mail there, and a row isn't queued for later either.
- `SummaryHost.runs(settings)`: `enabled && (not a local build || settings.devAi) && summaryCanRun(ai)`. `start`, `settingsChanged` and `consider` read it instead of `summaries.enabled`, so ingest's `isActive` answers false and nothing is marked or queued. Going from can to can't drops the queue, as the switch going off does.
- `enabledAt` stays null for someone who never touched the switch. Rows exist only from when the worker is active, so mail from before AI came on is never sent: no backfill.

### The learner

- `VoiceLearnerHost.available()`: Dev mode's switch and a provider that can draft (`writingCanRun`).
- `run()` and `activate()` ask it. Off, no pass runs and no checkpoint is created. What was learned stays and isn't read by anything, since drafting is off too.
- **It starts by itself:** at boot, when `available()` and the prefs want it, and when AI comes on (`aiChanged()`, from every place that can change it: the switch, `settings.update` with `ai`, `ai.setKey`, `ai.confirmKey`). Turning "Learn from my sent mail" on starts it too. This replaces plan 133's "only once the feature has been used".
- `aiChanged()` with AI gone withdraws what's running, as a permission going does.
- `status()` doesn't say "learning" while AI is off: nothing is.
- The model step (`Let AI study my style`) keeps its own consent: nothing here sends sent mail anywhere.
- **Clear AI data** still clears everything. With the setting on it learns again from the next launch, where before that waited for the next draft.

### Settings

- "Summarize new mail" shows on `summariesOffered`, with the note under it. The provider row stays: with nothing set up it's how someone adds the key that brings the switch.
- "Learn from my sent mail" shows on `draftingOffered`. Its parent "Draft with AI" still decides too.

## Tests

- **Unit, `summaries.test.ts`:** default on; with no provider, with only a cloud provider, and on a local build with the switch off, `isActive` is false and new mail queues nothing; turning AI on starts it with no backfill; going off drops the queue; a user's off survives AI coming and going.
- **Unit, `voice-learner.test.ts`:** starts by itself at boot with AI; no pass and no checkpoint without; AI coming on starts it; going off stops a pass in flight and keeps what's learned; off in prefs stays off.
- **Unit, `core`:** `summaryCanRun`'s table.
- **e2e, `dev-mode.spec.ts`:** both rows are absent with the switch off and with a saved key, and present and on with it on. No-provider install: neither row.

## Perf and resources

- Without AI: one more boolean on ingest's path, already read; the learner's wake-ups read settings at most every 30 s, only on changes.
- With AI: the learner reads up to 3000 sent messages per account in its existing 3 ms slices, now from the first launch, during a first sync too. This is the change plan 133 avoided on purpose and the owner has now asked for. `writing.perf.test.ts` holds the slices.
- Summaries now spend by default on a key someone added. The monthly limit (plan 131) and daily ceiling still bound them.

## Out of scope

Pro's entitlement (`aiFeaturesAvailable` is where it joins; `summaryCanRun` gets the same line). The other AI defaults: follow-ups, prepared replies and the digest stay opt-in. Migrating profiles that saved "off".

## Revisions after the Codex review

Codex (read-only, against `33d7829e`) raised 8 points. Five are accepted:

1. **A boot without AI clears the queue.** A profile can hold rows from before this, and `settingsChanged` only drops them on a change. `start()` drops them when the worker won't run, so AI coming on later sends nothing old.
2. **A task's own choice answers for itself.** `summaryCanRun` returns that target's readiness, with no fall through to an OpenAI key: `targetFor` never falls back from a choice.
3. **The learner reads the drafting rule, not Today's.** `aiFeaturesAvailable` checks no model or endpoint, so Ollama with no model chosen would start it while its row is hidden. `aiReady` and `chosenTargetReady` move to `@terno/core`, and `writingCanRun` uses them.
4. **Turning "Draft with AI" back on starts it too,** not only "Learn from my sent mail": `prefsChanged` activates whenever the prefs after it want learning.
5. **Importing settings is another way AI changes.** `import.ts` writes them without the handlers, so it tells both the worker and the learner.

Not taken:

- **Mail staging while AI goes off could still queue a row.** Rare, the same as the switch has always had, and that row was mail that arrived while AI was on.
- **Wake-ups dropped within 30 s can delay a first pass until the next change.** Any later change wakes it, and plan 133 §"no timer" holds that nothing depends on sooner. "At most every 30 s" is what's true, and this plan's wording is corrected. The first draft waits as it would have.
- **A key confirmed for another origin on a non-main provider.** Plan 147 didn't take this either. It runs, fails `auth`, and the note says what's wrong, which is the better failure.
