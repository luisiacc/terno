# Plan 134: smart categorization

- **Status:** built, parts A and B (see "What building it changed"). The Codex code review and the real-model eval haven't run.
- **Builds on:** plan 131 (base), plan 02 (the engine), plan 05's W10 follow-ups (`AiAssist`'s lifecycle), plan 85 decisions 8, 9 and 10, plan 83 (hidden categories), plan 116 (forwarding).

## The requests

> for the ai pro plan, for categorization that doesn't fall into filters, we can use 'jev'

> categorization we could have for thins don't have a rule yet, but are new and we can categorize it with confidence

> for the smart categorization, it would be only under the paid plan, the one that uses AI, the one with our current filters is free

> the local engine stays free, also if they use a local ai provider or their own api key they canuse ai features as well

> ok yes for users own model will be suggestions, not filed automatically.

> for ai categorization, we need to see existing categories.

## What exists

- **Ingest order** (`sql-store.ts:625-650`, one commit): messages, filters, then `classifyNewThreads` (`packages/db/src/categorize.ts:984`, `packages/idb/src/categorize.ts:770`). Only undecided threads are evaluated: no category, example or decision. Mail older than 14 days is backfill.
- **The result** carries `uncertain`: threads in the 0.5 ≤ p < 0.97 band (`packages/store/src/types.ts:213`). `ingestSliced` hands it to `AiAssist.enqueue` (`core.ts:1177`) on **every** ingest, including a first sync.
- **`AiAssist`** (`packages/backend/src/ai-assist.ts`): off by default (`aiCategorize`). It offers only the band's categories with enough examples (`:143-149`), so mail from an unknown sender usually never reaches it. It sends sender, subject and 600 characters of body (`:166`), and writes a suggestion through `recordAiSuggestion`, re-checking `aiCandidate` and vetoes in the transaction (`sql-store.ts:1280`).
- **The reader already shows suggestions:** `suggestion-chip` with y / n and reasons (`reader.tsx:359-380`). `reason.aiCloud` and `reason.aiLocal` name the source.
- **Categories:** `id, name, color, position, autoApply, showInInbox, forward?` (`packages/core/src/types.ts:234`). Evidence per category: `cls_examples`, `thread_categories`.
- **Safety in the engine:** hard and sender vetoes, look-alike, the per-category safety valve, `added_by = 'auto'` never trains.
- **`jev`** isn't reachable yet: hosted, early access, API docs and data retention unread, and there's no relay (plan 85).

## Who gets what

| | Places a thread | Runs on | Needs |
|---|---|---|---|
| Filters | files | local | nothing |
| Local engine | files or suggests | local | nothing |
| Own-provider AI | **suggests only** | user's key or local model | a provider, the existing switch |
| Hosted `jev` | **files** when confident, suggests below the bar | Terno's relay | Pro (plan 85), so part B waits for the server |

## Design

### 1. Which mail reaches the AI

All of:

1. **Live sync only,** plan 116's `live` flag, no older than 3 days at ingest. Today's `uncertain` path also runs on a first sync; that changes, because the wider path below would otherwise send 14 days of mail to the provider on connecting an account. The 20-a-minute limit made that slow, not absent.
2. **Inbound, in the Inbox, not spam, trash or draft.**
3. **Undecided after filters and the engine:** no category, no suggestion, no example, no decision. Filters and the engine's own filing always win; nothing is sent for what they settled.

Both stores gain `ClassifyResult.undecided: number[]`, every candidate left with no decision, replacing `uncertain` as `AiAssist`'s input. This is what moves the AI from "the engine has a hunch" to "the engine has nothing", which is the case the user described.

### 2. It sees the existing categories

The AI chooses only from the user's existing categories, or none. It never proposes a new one. It's told what each category holds, because a name alone often says little:

```ts
store.categorize.categoryEvidence({ perCategory: 3 }): Promise<{
  id: number; name: string; positives: number;
  samples: { fromName: string; fromDomain: string; subject: string }[];
}[]>;
```

- **Samples** are the newest threads the user placed by hand or accepted (`cls_examples`, label positive, `source` not `filter` or `auto`), so the AI learns from the user's choices and not its own. A category with none is offered by name.
- **Read once and held in memory** by the assist, invalidated on a category or example change, bounded by the category count. Both stores, with a gate at 50k threads.
- **At most 100 categories offered**, by recent use. `jev` takes up to 255 choices, and a prompt with more is expensive for no gain.
- **Label mapping:** the model sees stable labels `c1`, `c2` with the name beside them, so duplicate or odd names can't confuse the enum. An answer outside the set fails the existing structured validation.
- **Privacy:** this sends subjects and sender names from *other* threads to the provider, in addition to the new mail. The switch's hint says so. Sender addresses stay out; a domain is enough. For the user's own provider this is covered by their choice of provider; hosted `jev` gets its own disclosure (plan 85 revision 5).
- **Who's eligible:** own-provider suggestions may use any category, including one with no examples, since a wrong suggestion costs one keystroke. Filing has stricter rules (§4).

### 3. Part A: suggestions on the user's own provider

This ships first and needs no server. It's an extension of `AiAssist` and the existing switch, not a new path:

- Input moves to `undecided` (§1), candidates to all existing categories (§2). The band logic goes.
- `recordAiSuggestion` is unchanged, as are its re-checks, the chip, y / n and the training on acceptance.
- `AI_MIN_CONFIDENCE` stays at 0.7 for suggestions.
- Calls go through `AiLimiter` and `forTask("categorize")` (plan 131), with a soft cap of 200 a day. One thread per call, as today. Sender, subject and 600 characters of body, unchanged. Mail stays in a data block, with the instruction that it is material. The hard-coded `De:` and `Asunto:` become neutral.
- **The switch's copy changes,** because the feature now sends more mail: from "second opinion on uncertain threads" to "Suggest a category for new mail the filters and engine can't place. Sends each one to {provider}, with a few sender names and subjects from your categories." `en` and `es`.
- **Existing users with the switch on** get this widening at upgrade. Their consent was for the narrower thing, so the switch resets to off once, with a line in Settings → Categories explaining what changed. Never silently wider.
- **The band's old job is covered:** those threads are undecided too, so nothing is lost.

### 4. Part B: filing with hosted `jev`

Waits for plan 85's server and for TypeSafe AI's API and retention terms. Built against a fake until then.

- **`AiTasks.calibrated`** (plan 85 decision 10): true only for hosted `jev`. `AiAssist` files when `calibrated` and the confidence clears the bar, suggests in the band below it, and does nothing otherwise. No branch on the provider.
- **The bar** starts at `POLICY.autoP` (0.97) and is set by measurement on real mail, not by the vendor's claim. A per-category calibration check runs in the eval.
- **A category it may file into** must have `autoApply` on, at least `POLICY.autoMinPositives` (5) examples, no veto, and an open safety valve. A category with no examples can't receive a filing, however confident.
- **A new store write, `recordAiFiling`,** in the same transaction shape as `recordAiSuggestion`: re-check `aiCandidate` and vetoes, add with `added_by = 'auto'` so it never trains, record a `cls_decisions` row of kind `auto` with `reason.aiFiled`, and join the safety valve's counts. Removing the thread is a revert, like any auto filing.
- **Undo and visibility** are what the engine's filings already have: the auto mark on the chip, its reasons, removal in one click.
- **Two things an AI filing doesn't do by itself:**
  - **Forward.** Plan 116 forwards mail filed into a category. A filing by `jev` into a forwarding category becomes a suggestion instead, because sending mail to a third party on a model's judgment is a different decision from sorting it.
  - **Hide.** A category with `showInInbox` off (plan 83) takes its mail out of the Inbox and its counts. A filing there becomes a suggestion too, so a wrong call can't make mail disappear.
- **When Pro ends or the service is down:** no filings, no fallback to the user's provider (plan 85 decision 10), the local engine carries on, and threads already filed stay.
- **Plan 85 decision 6** says managed AI never runs categorization. Hosted `jev` is the named exception (decision 8), and plan 85 should say so when this part is built.

## Tests

**Part A**
- **Eligibility (conformance, both stores):** `undecided` excludes filter-placed, engine-filed, engine-suggested, spam, trash, draft, not-in-Inbox and old mail; live vs first sync, backfill and import.
- **Evidence:** samples come only from user-placed threads; a category with none is offered by name; deleted category and thread gone; capped; perf at 50k.
- **Assist:** an unknown sender now reaches the AI; labels are only existing categories; an invented label fails validation and writes nothing; below 0.7 writes nothing; settings off mid-call sends nothing further (the existing W10 regressions still pass); a provider switch sends nothing further.
- **Upgrade:** switch on before, off after, with the line shown once; no mail sent in between.
- **e2e:** new mail from an unknown sender shows a suggestion chip; y files and trains; n stays out; en and es.

**Part B (fake `calibrated` provider)**
- Files above the bar, suggests below, nothing at null; `autoApply` off, too few examples, veto and paused valve all block filing.
- Forwarding and hidden categories become suggestions, with no forward enqueued.
- Revert counts toward the valve; filings never train.
- A non-calibrated provider never files, whatever confidence it reports. This is the suggestions-only rule, and it has its own test.
- Pro ending mid-queue stops at the next item; service down makes no fallback request.

**Eval (real model, gated, synthetic mail):** extends `categorize.eval.test.ts`. Precision and recall per model with and without samples, which also answers whether samples earn their tokens. Calibration of `jev`'s confidence when it's reachable.

## Performance

`undecided` is computed inside the existing classification, with no new query per thread. Off: `AiAssist.enqueue` returns on the setting, as now. Ingest gates (`load.perf.test.ts`, `pnpm test:perf`) unchanged in both stores. No migration in part A, and none in part B unless `reason.aiFiled` needs one, which it shouldn't: reasons live in `explain_json`.

## Out of scope

Creating categories from AI. Re-categorizing old mail, or threads with a decision. Multi-category answers: one result per thread, and a move is exclusive by the product's rule. Embeddings.

## Order

1. `undecided` in both stores, `live` gate, conformance.
2. `categoryEvidence`, both stores, gate.
3. `AiAssist` widened, labels, prompt, limiter.
4. Switch copy and the one-time reset, `en` and `es`.
5. Eval with synthetic mail.
6. **Part B,** once plan 85's relay exists and TypeSafe AI's retention terms are read: `calibrated`, `recordAiFiling`, the exceptions, Pro gating.

## Revisions after the Codex review

Codex (`gpt-6.1-sol`, high, read-only, against `f787771c`) raised 5 points on this plan, all accepted. Each replaces what the sections above say.

1. **Eligibility doesn't depend on the classifier running.** Both stores return `NO_CLASSIFICATION` until a model is ready (`sql-store.ts:585`, `packages/idb/src/store.ts:1210`, `core.ts:1195`), so `ClassifyResult.undecided` alone would lose mail arriving during startup or a rebuild. Eligibility comes from plan 131's `ai_new_mail` marker. The assist consumes a marker only once the local engine has had its turn on that thread, then checks that it's still undecided. This means **part A has one migration,** the marker's, which overrides the Performance section's "no migration". `undecided` in the result becomes a wake-up, not the source of truth.
2. **New-mail status survives a late body.** Classification also runs from `setBody` (`core.ts:1804`), which never enqueues AI work today, while reusing that call's `live` flag would either lose real mail or admit first-sync mail completed later. The marker carries the original arrival through a late body, a restart and a merge, and `setBody` wakes the assist without deciding eligibility.
3. **Evidence uses a whitelist of sources.** "Not filter or auto" excludes nothing, because neither is an `ExampleSource` (`packages/core/src/categorize/model.ts:4`), and agent placements do create examples (`packages/db/src/categorize.ts:28`). Samples come only from `user`, `suggestion` and `bulk`. A test proves an agent's example never appears.
4. **Evidence is data in the user turn, with a budget.** `ClassifyInput.instructions` goes into the system prompt (`tasks.ts:107`), so sample subjects there would promote mail content to instructions. `ClassifyInput` gains `categories: { label; name; samples }[]`, rendered in the untrusted data block, with names and subjects capped and samples cut by the session's capacity before any category is dropped. Stable labels stay. The band-score plumbing goes. A suggestion records the AI's confidence, labeled as such, since the assist writes the local score today (`ai-assist.ts:177`) and the reader shows it as a percentage (`reader.tsx:380`).
5. **Every filing condition is re-read in the filing transaction.** `recordAiSuggestion`'s pattern only covers candidacy and vetoes (`sql-store.ts:1280`). `recordAiFiling` also re-reads `autoApply`, example count, the safety valve, `showInInbox` and `forward`, any of which can change while `jev` answers. A category that has become hidden or forwarding downgrades to a suggestion. Each condition is tested changing mid-request.

## What building it changed

- **A JEV key the user can set.** The body says JEV is hosted-only and part B waits for plan 85's relay. The user asked otherwise ("allow user to set a JEV api key for future categorization, even though only we'll use it for testing"), so Settings → Categories has a key row, and part B is built on `calibrated` with no relay. Pro gating isn't built, so nothing is gated; "Pro ends" is tested as removing the key. Plan 85 decision 6's exception still needs its line there when the relay lands. The web build's reach to TypeSafe AI (CORS) is unknown.
- **New categories are hidden by default, so most can't be filed into.** `categories.create` defaults `showInInbox` to false, and a hidden category only gets suggestions (§4). A user's new category gets AI filings only once it's shown in the Inbox. The rule is the plan's; the effect on how often JEV files is worth a decision, and the hint doesn't mention it.
- **A second migration.** v49 adds a partial index on `cls_examples(category_id, at)` for the whitelisted sources, so evidence reads a few rows per category instead of walking a 50k-example category. Shape only. IndexedDB needs none: it walks its in-memory rows.
- **`undecided` isn't in the result.** Revision 1 made it a wake-up, and every slice already wakes the assist, so the field would say nothing. `uncertain` is gone from `ClassifyResult`.
- **The engine's turn is `suggestBackfill` on the one thread,** right before asking, for mail that came before a model was ready. It can suggest but not file, as for any late mail; what it settles isn't sent.
- **A mark waits for the full body.** Up to its 3 days: a thread whose body never comes is never sent. `setBody` wakes the assist.
- **Failures,** like plan 132's: `rate_limited`, `unavailable` and `timeout` end the pass and hold for a minute with the marks kept; the day's or month's limit holds until the next day; `auth`, `not_configured` and `blocked` wait for a settings change or new mail; a bad answer loses that thread's mark and the rest go on. There's no timer on a failure: the next mail, the network or a settings change looks again.
- **A mode of "suggest" wins over `calibrated`:** a user who told the engine only to suggest doesn't get AI filings.
- **What blocks filing without a veto becomes a suggestion:** auto-apply off, too few examples and a paused valve, like hidden and forwarding. A veto writes nothing. §4 only said they block.
- **A provider or key change** drops the queue and what's in flight, and what's still marked goes to the new target. The hint names it, and a JEV key is a change like any other.
- **An import never turns the switch on,** as with summaries: `aiCategorize` left the import's keys.
- **Evidence budget:** 3 samples a category, cut to 2, 1, then 0 past 12,000 characters or the session's window, whichever is less. Every category stays.
- **The reset is written at boot,** not at read time, in `AiAssist.start`, since it must precede any sync and no read should have that side effect. The line shows once and hides as soon as the switch is on again, since it says "this is now off".
- **The reader says whose number it is:** "the AI's confidence: 90%", for AI suggestions.
- **The fake model** matches a label by the name beside it, since labels are now `c1`. e2e gives the engine an empty model, because the demo mailbox's has an opinion on nearly anything.
- **Not done:** `load.perf.test.ts` wasn't extended; `smart-categorization.perf.test.ts` measures evidence and filing at 50k threads in both stores (under 1 ms). The eval is `scripts/ai-real/categorize.real.ts`, written, not run. The `categorize.eval.test.ts` extension wasn't made.

## What the code review changed

- **A JEV request has one deadline.** It had none, so a stalled response could hold AiAssist's only drain forever. `config.timeoutMs` now covers the whole request through the last byte of the body, mapped to `timeout`, and a body read that doesn't notice the abort still gives up. A caller's cancel stays a cancel, and a body that isn't JSON says so rather than claiming it couldn't connect.
